/**
 * The licence line, as far as a test can hold it.
 *
 * Two halves, deliberately.
 *
 * The first half runs a real `createBillingService` over an in-memory store and
 * drives it with the real `applySubscription`, so every entitlement state under
 * test is one this repository's own billing code produced rather than a
 * hand-written `{ subscribed: true }`. It covers the four states a buyer can be
 * in: never subscribed, subscribed, lapsed, and subscribed again after lapsing.
 * The last one is the one that catches a gate implemented as a latch.
 *
 * The second half boots the real `cloud/server.mjs` and asks over HTTP, so the
 * wiring in that file is under test and not just the module it calls.
 *
 * Every test names the failure it is guarding against. None of them asserts
 * only that a call did not throw.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { createBillingService } from "./billing.mjs";
import {
  PAID_CAPABILITIES,
  createCapabilityGate,
  narrowCapabilities,
  openCapabilities,
} from "./capability-gate.mjs";
import { OPERATOR_OWNER } from "./owner.mjs";
import { capabilities } from "../packages/workbench/src/gui.ts";

const cloudDir = fileURLToPath(new URL(".", import.meta.url));
const readCloud = (name) => readFileSync(join(cloudDir, name), "utf8");

const OWNER = "account-one";
const CUSTOMER = "customer_1111";
const PRODUCT = "product_team";

/**
 * A store that holds documents in a Map, with a transaction that really does
 * serialise per owner. `cloud/billing.mjs` reads the subscription inside one, and
 * a stand-in that ran the callbacks concurrently would be testing a different
 * module from the one that ships.
 */
function memory() {
  const rows = new Map();
  const locks = new Map();
  const client = { rows };
  const broken = { now: false };
  const fail = () => {
    if (broken.now) throw new Error("Cloud database is not configured.");
  };
  return {
    rows,
    break: (yes) => {
      broken.now = yes;
    },
    dep: {
      read: async (owner, key, c) => {
        fail();
        return (c ?? client).rows.get(`${owner}|${key}`);
      },
      write: async (owner, key, value, c) => {
        fail();
        (c ?? client).rows.set(`${owner}|${key}`, structuredClone(value));
      },
      transaction: async (owner, _key, run) => {
        const previous = locks.get(owner) ?? Promise.resolve();
        let release;
        const held = new Promise((resolve) => {
          release = resolve;
        });
        locks.set(
          owner,
          previous.then(() => held),
        );
        await previous;
        try {
          return await run(client);
        } finally {
          release();
        }
      },
    },
  };
}

/** The subscription shape Polar's own `subscription.*` events carry. */
const event = (status, over = {}) => ({
  type: `subscription.${status}`,
  data: {
    id: "sub_3333",
    customer_id: CUSTOMER,
    product_id: PRODUCT,
    status,
    current_period_start: "2026-10-01T00:00:00Z",
    current_period_end: "2026-11-01T00:00:00Z",
    cancel_at_period_end: false,
    ...over,
  },
});

let webhookIds = 0;

/** A service and a gate over one store, which is what a deployment has. */
function wired() {
  const store = memory();
  const service = createBillingService(
    { env: {}, productId: PRODUCT },
    store.dep,
  );
  const gate = createCapabilityGate(service);
  return {
    store,
    service,
    gate,
    /** Put this owner into a subscription state, through the real code path. */
    subscribe: async (status, over) => {
      await service.linkCustomer(OWNER, CUSTOMER);
      const applied = await service.applySubscription(
        event(status, over),
        `msg_0000${++webhookIds}`,
      );
      assert.equal(applied.applied, true, "the subscription event was applied");
      return gate.capabilities(OWNER);
    },
  };
}

/**
 * The exact literal `cloud/server.mjs` answered with before this change, taken
 * from the commit this branch starts at. It is written out rather than read out
 * of the current file, so the assertion compares the new surface against the
 * old one and fails if a refactor quietly renames or drops an open capability.
 */
const PREVIOUS_OVERLAY = {
  ...capabilities("cloud"),
  projects: false,
  customAgents: false,
  hooks: false,
  contextCompaction: true,
  recoveryJobs: true,
  backgroundQueue: false,
};

// --- the invariant: the gate only narrows ---------------------------------

test("the overlay can only ever take a capability away", () => {
  // Broken by: any branch that assigns a truthy value, which is the difference
  // between a paywall and a second way for a paid capability to be granted.
  const open = openCapabilities();
  const entitled = narrowCapabilities(open, true);
  assert.deepEqual(
    entitled,
    open,
    "an entitled owner sees the open surface exactly as it is",
  );
  for (const value of [
    false,
    undefined,
    null,
    0,
    "",
    "yes",
    "true",
    1,
    {},
    [],
    new Date(0),
    Number.NaN,
  ]) {
    const narrowed = narrowCapabilities(open, value);
    for (const key of Object.keys(open))
      assert.ok(
        narrowed[key] === open[key] || narrowed[key] === false,
        `${key} was neither left alone nor turned off for ${String(value)}`,
      );
    for (const name of PAID_CAPABILITIES)
      assert.equal(narrowed[name], false, `${name} is paid and is off`);
  }
});

test("narrowing never invents a key and never drops one", () => {
  // A capability the client is told nothing about and a capability it is told
  // about are both silent failures: one hides the feature, the other lets the
  // client assume the default. The set of keys is part of the contract.
  const open = openCapabilities();
  assert.deepEqual(
    Object.keys(narrowCapabilities(open, false)).sort(),
    Object.keys(open).sort(),
  );
  // And a paid capability missing from the base is filled in as off rather than
  // left undefined, which a client would read as "not supported here".
  assert.equal(narrowCapabilities({}, false).taintGraph, false);
});

test("every paid capability named in the list is one the open surface actually serves", () => {
  // Broken by: a name that is spelled differently on the two sides, which gates
  // nothing while reading as though it does.
  const open = openCapabilities();
  assert.ok(PAID_CAPABILITIES.length > 0, "the paid line is empty, which is not this change");
  for (const name of PAID_CAPABILITIES) {
    assert.equal(open[name], true, `${name} is not an open capability to begin with`);
    assert.equal(narrowCapabilities(open, false)[name], false);
  }
});

// --- retention stays open ---------------------------------------------------

test("retention is not on the paid line, and the free tier already has it", () => {
  // Broken by: adding "retention" to PAID_CAPABILITIES, which is the move
  // section 5 forbids. This is not a preference; it is the hard rule "a feature
  // never moves from open to paid", read against a surface the free tier
  // already ships in full.
  assert.ok(
    !PAID_CAPABILITIES.some((name) => /retention|history|expiry|ttl/i.test(name)),
    "retention must stay on the open side of the licence line",
  );
});

test("open core already enforces an age, and leaves the bound to the operator", async () => {
  // The claim this pins is that retention is absent because there is nothing to
  // gate. That was wrong: the vault enforces a real TTL. The corrected reason is
  // that the bound is already the operator's to choose and unbounded above, so a
  // cap would remove a shipped capability rather than withhold an absent one.
  //
  // Broken by: any change that puts a ceiling on the operator-selected TTL, or
  // that starts collecting implicitly. Both would make free retention narrower
  // than it is today, which is the open-to-paid move.
  const { MANUAL_RETENTION_POLICY, validateRetentionPolicy } = await import(
    "../packages/runtime/src/retention.ts"
  );

  // The shipped default collects nothing: no TTL, and manual mode.
  assert.equal(MANUAL_RETENTION_POLICY.mode, "manual");
  assert.deepEqual(MANUAL_RETENTION_POLICY.ttlByKind, {
    unpinned: null,
    recovery: null,
    operator: null,
  });

  // And a policy far beyond seven days is accepted, with no ceiling. Seven days
  // is the number section 5 names, so a cap at it would be the paywall; proving
  // thirty and 365 days are already legal is what makes that a removal rather
  // than an absence.
  const DAY_MS = 24 * 60 * 60 * 1000;
  for (const days of [7, 30, 365]) {
    const policy = validateRetentionPolicy({
      version: 1,
      mode: "age",
      ttlByKind: { unpinned: days * DAY_MS, recovery: null, operator: null },
    });
    assert.equal(
      policy.ttlByKind.unpinned,
      days * DAY_MS,
      `a ${days} day retention is already available in open core`,
    );
  }
});

test("the two durable surfaces cannot expire, so they are not the retention surface", async () => {
  // Broken by: someone adding a delete or an expiry to either interface and
  // then pointing at it as the thing section 5 means. Age is not representable
  // on an append-only store, and making it so would start by dismantling the
  // guarantee that makes the record worth keeping.
  const ledger = readFileSync(
    join(cloudDir, "..", "packages", "ledger", "src", "index.ts"),
    "utf8",
  );
  // Only the interface body, not the rest of the file: `journal.ts` later calls
  // `queues.delete` to drop an in-memory promise, which is queue hygiene rather
  // than a way to expire a record, and reading that as a retention method would
  // make this test fail for an unrelated reason.
  const store = ledger.slice(
    ledger.indexOf("export interface LedgerStore"),
    ledger.indexOf("/** Version tag in the signed preimage"),
  );
  for (const method of ["delete", "prune", "expire", "purge", "truncate"]) {
    assert.doesNotMatch(
      store,
      new RegExp(`\\b${method}\\b`, "i"),
      `LedgerStore must not grow a ${method}, so it cannot be the retention surface`,
    );
  }

  const journal = readFileSync(
    join(cloudDir, "..", "packages", "runtime", "src", "journal.ts"),
    "utf8",
  );
  const tx = journal.slice(
    journal.indexOf("export interface JournalTransaction"),
    journal.indexOf("export interface OperationJournal"),
  );
  assert.match(tx, /append\(/, "the journal transaction still has its one write method");
  for (const method of ["delete", "prune", "expire", "purge"]) {
    assert.doesNotMatch(
      tx,
      new RegExp(`\\b${method}\\b`, "i"),
      `JournalTransaction must not grow a ${method}`,
    );
  }
});

// --- the four states a buyer can be in ------------------------------------

test("an owner who never subscribed is not inside the paid line", async () => {
  // Broken by: reading a missing subscription document as a live one, which is
  // how a gate turns out to be decorative.
  const { gate, service } = wired();
  const answer = await gate.capabilities(OWNER);
  assert.equal(answer.taintGraph, false);
  assert.equal((await service.entitlement(OWNER)).subscribed, false);
});

test("an active subscription turns the paid capability on", async () => {
  const { subscribe } = wired();
  const answer = await subscribe("active");
  assert.equal(answer.taintGraph, true);
});

test("a trialling subscription is a live payment too", async () => {
  const { subscribe } = wired();
  assert.equal((await subscribe("trialing")).taintGraph, true);
});

test("a cancelled subscription turns it off again, and a renewed one turns it back on", async () => {
  // The second half is the one that matters. A gate written as a latch, or one
  // that only ever looks at whether a document has ever existed, passes the
  // "never subscribed" and "subscribed" tests and fails here: somebody who paid,
  // cancelled and came back has paid again and is owed the capability again.
  const { subscribe, gate } = wired();
  assert.equal((await subscribe("active")).taintGraph, true);
  assert.equal(
    (await subscribe("canceled")).taintGraph,
    false,
    "a cancelled subscription is not a live payment",
  );
  assert.equal((await subscribe("active")).taintGraph, true, "and paying again restores it");
  // `past_due` is the status this repository's billing module deliberately keeps
  // out of the live set, so it is not paid.
  assert.equal((await subscribe("past_due")).taintGraph, false);
  // A subscription for another product is somebody else's receipt.
  const other = wired();
  await other.service.linkCustomer(OWNER, CUSTOMER);
  await other.service.applySubscription(
    event("active", { product_id: "product_other" }),
    "msg_other",
  );
  assert.equal((await other.gate.capabilities(OWNER)).taintGraph, false);
});

test("the gate fails closed when the entitlement read throws", async () => {
  // Broken by: letting the throw reach the route, which turns a billing outage
  // into a 500 on every screen in the product because they all read the
  // capability surface, and which would be the one place a failure could widen
  // rather than narrow.
  const { store, gate, subscribe } = wired();
  assert.equal((await subscribe("active")).taintGraph, true);
  store.break(true);
  const broken = await gate.capabilities(OWNER);
  store.break(false);
  assert.equal(broken.taintGraph, false, "a read that cannot be answered is not a paid entitlement");
  assert.equal(
    (await gate.capabilities(OWNER)).taintGraph,
    true,
    "and restoring the read restores the capability",
  );
});

test("a deployment with no billing configured is the free tier, not an error", async () => {
  // Broken by: answering 503, which would refuse chat, projects and the
  // permission mode along with the paid capability on every self-hosted install.
  const gate = createCapabilityGate(undefined);
  const answer = await gate.capabilities(OWNER);
  assert.equal(answer.taintGraph, false);
  assert.equal(answer.mode, "cloud");
  assert.equal(answer.recoveryJobs, true, "the open surface is untouched");
});

test("nobody who is not an owner is inside the paid line", async () => {
  const { subscribe, gate } = wired();
  await subscribe("active");
  for (const owner of [undefined, null, "", 7, {}, "has space"]) {
    assert.equal(await gate.entitled(owner), false, `${String(owner)} is not an owner`);
    assert.equal((await gate.capabilities(owner)).taintGraph, false);
  }
});

test("the operator's own control token is deployment authority, not a receipt", async () => {
  // The one place the answer does not come from a subscription. It is stated in
  // the module and it is here so that changing it is a deliberate act: the
  // control token already reaches every document this server holds, so
  // withholding a capability from the person running the instance would be
  // withholding it from the deployment, and a self-hosted install has nobody to
  // bill.
  const { subscribe, gate } = wired();
  await subscribe("active");
  assert.equal(await gate.entitled(OPERATOR_OWNER), true);
  // And it is not a way in for anyone else: an owner that merely resembles it
  // is not it.
  assert.equal(await gate.entitled("operator "), false);
  assert.equal(await gate.entitled("Operator"), false);
});

// --- the free surface, stated ---------------------------------------------

test("nothing else about the free cloud surface moved", async () => {
  // Broken by: a refactor that narrows a capability nobody agreed to pay for,
  // which is the failure this change could cause and did not intend. The only
  // difference from the overlay this server answered with before is the paid
  // keys, and for every owner who is not paying those keys are the only things
  // that are off. They are stripped through `PAID_CAPABILITIES` rather than
  // named one at a time, so adding a paid capability does not silently exempt
  // it here.
  const surface = openCapabilities();
  const open = { ...surface };
  for (const name of PAID_CAPABILITIES) {
    assert.equal(open[name], true, `the ungated surface has ${name} on`);
    delete open[name];
  }
  assert.deepEqual(open, PREVIOUS_OVERLAY, "the open overlay is the one that was there before");
  const free = await wired().gate.capabilities(OWNER);
  for (const key of Object.keys(PREVIOUS_OVERLAY))
    assert.deepEqual(free[key], PREVIOUS_OVERLAY[key], `${key} is the same for the free tier`);
});

// --- hosted recovery execution is the second paid capability ---------------

test("verifiedRecovery is paid: published off without a subscription, on with one, and never widened", async () => {
  // Broken by: naming the capability in `PAID_CAPABILITIES` while the base
  // surface does not serve it, which reports a flag the server never reads; by
  // deriving it anywhere but `openCapabilities`, which would put the paid
  // decision in the Apache 2.0 open core; or by a `narrowCapabilities` that can
  // widen, which is the difference between a gate and a second way to be
  // wrong. The narrow-only half is restated against the new key rather than
  // left to the loop above, and a truthy-but-not-true entitlement is the shape
  // a hand-edited subscription document has.
  assert.ok(
    PAID_CAPABILITIES.includes("verifiedRecovery"),
    "hosted recovery execution is on the paid side of the line",
  );
  const open = openCapabilities();
  assert.equal(open.verifiedRecovery, true, "the ungated surface does serve it");
  assert.equal(
    (await wired().gate.capabilities(OWNER)).verifiedRecovery,
    false,
    "an owner who never subscribed is outside the paid line",
  );
  assert.equal(
    (await wired().subscribe("active")).verifiedRecovery,
    true,
    "a live subscription is inside it",
  );
  // The split the decision makes: the capture and the receipt stay free so the
  // proof is inspectable and the open-core CLI keeps working, and only the
  // hosted execution is withheld.
  const free = await wired().gate.capabilities(OWNER);
  assert.equal(free.recoveryJobs, true, "recovery jobs remain a free capability");
  assert.equal(narrowCapabilities(open, true).verifiedRecovery, true);
  for (const value of [false, undefined, null, 1, "yes", {}, []])
    assert.equal(
      narrowCapabilities(open, value).verifiedRecovery,
      false,
      `${String(value)} is not a live payment`,
    );
  assert.equal(
    narrowCapabilities({ ...open, verifiedRecovery: false }, true).verifiedRecovery,
    false,
    "a base that already says false is never widened, by any argument",
  );
});



// --- the wiring in cloud/server.mjs ---------------------------------------

test("the capability route reads the gate and the paid route refuses on it", async () => {
  // The gate is only worth anything if the file that serves HTTP consults it,
  // and a capability flag the server ignores is a label rather than a gate.
  const source = readCloud("server.mjs");
  const route = source.indexOf('app.get("/api/capabilities"');
  assert.ok(route > 0, "the capability route is still there");
  const body = source.slice(route, source.indexOf("}));", route));
  assert.match(body, /licence\.capabilities\(req\.owner\)/);

  const taint = source.indexOf('app.get("/api/records/:seq/taint"');
  const check = source.indexOf("licence.entitled(req.owner)", taint);
  assert.ok(taint > 0, "the taint route is still there");
  assert.ok(check > taint, "the taint route checks the entitlement");
  // Before it reads a single ledger row, so a refused request costs nothing.
  assert.ok(
    check < source.indexOf("await selected(req)", taint),
    "the refusal happens before the ledger is read",
  );
  // And it is a refusal with a status, not a 200 with an empty body.
  assert.match(
    source.slice(check, source.indexOf("await selected(req)", taint)),
    /status\(402\)/,
  );
});

test("the paid decision never reaches the Apache 2.0 open core", async () => {
  // Broken by: a paid flag written into `packages/workbench/src/gui.ts`, which
  // is open core and would put a subscription decision under Apache 2.0.
  const open = readFileSync(
    join(cloudDir, "..", "packages", "workbench", "src", "gui.ts"),
    "utf8",
  );
  const surface = open.slice(
    open.indexOf("export const capabilities"),
    open.indexOf("export type ProviderStatus"),
  );
  assert.ok(surface.length > 0, "the open capability surface was found");
  for (const word of ["billing", "entitle", "subscrib", "polar", "taintGraph"])
    assert.doesNotMatch(surface, new RegExp(word, "i"), `the open surface must not name ${word}`);
  // And the open package does not import the paid module either.
  assert.doesNotMatch(open, /capability-gate/);
});

// --- over real HTTP -------------------------------------------------------

/**
 * Boot the real `cloud/server.mjs` and sign in as an account, with the identity
 * provider answered by a stubbed `fetch` rather than a socket. The account is
 * not the operator, because the operator is entitled without a subscription and
 * would make the free-tier cases untestable.
 */
async function server(t, { polar = false } = {}) {
  const user = { id: "3f2b1c4e-0000-4000-8000-000000000000", email: "person@example.com" };
  const nativeFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    if (String(url).startsWith("http://127.0.0.1")) return nativeFetch(url, init);
    if (/\/auth\/v1\/token/.test(String(url)))
      return Response.json({
        access_token: "provider-access-token",
        refresh_token: "provider-refresh-token",
        expires_in: 3600,
      });
    return Response.json(user);
  };
  const previous = { ...process.env };
  Object.assign(process.env, {
    SUPABASE_URL: "https://provider.invalid",
    SUPABASE_ANON_KEY: "anon",
    NOMO_ACCOUNT_SEAL_KEY: "a".repeat(64),
    NOMO_CONTROL_TOKEN: "operator-token-for-this-test-".padEnd(40, "x"),
  });
  // Billing configured but unreachable: the entitlement read cannot be
  // answered. That is the fail-closed case, exercised through the real route.
  if (polar)
    Object.assign(process.env, {
      NOMO_POLAR_ENVIRONMENT: "sandbox",
      NOMO_POLAR_ACCESS_TOKEN: "polar_oat_never_used",
      NOMO_POLAR_ORGANIZATION_ID: "org_2222",
      NOMO_POLAR_WEBHOOK_SECRET: "whsec_" + Buffer.from("nomo-capability-secret-32b").toString("base64"),
      NOMO_POLAR_PRODUCT_TEAM: PRODUCT,
    });
  t.after(() => {
    globalThis.fetch = nativeFetch;
    for (const key of Object.keys(process.env))
      if (!(key in previous)) delete process.env[key];
    Object.assign(process.env, previous);
  });

  const { default: app } = await import(
    `./server.mjs?capability-gate=${polar ? "polar" : "bare"}`
  );
  const listener = app.listen(0, "127.0.0.1");
  await new Promise((done) => listener.once("listening", done));
  t.after(() => {
    listener.closeAllConnections();
    listener.close();
  });
  const base = `http://127.0.0.1:${listener.address().port}`;
  const call = async (path, cookie, post) => {
    const headers = { ...(cookie ? { cookie } : {}), ...(post ? { "content-type": "application/json" } : {}) };
    const response = await fetch(base + path, { ...(post ? { method: "POST", body: JSON.stringify(post) } : {}), headers });
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : null };
  };
  const signedIn = await fetch(base + "/api/account/signin", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "person@example.com", password: "correct horse" }),
  });
  assert.equal(signedIn.status, 200, "the account signed in");
  const cookie = signedIn.headers.get("set-cookie").split(";")[0];
  return { call, cookie, operator: process.env.NOMO_CONTROL_TOKEN };
}

test("over HTTP: a free account is told the paid capability is off and cannot reach it", async (t) => {
  const s = await server(t);
  const capabilities = await s.call("/api/capabilities", s.cookie);
  assert.equal(capabilities.status, 200);
  assert.equal(capabilities.body.taintGraph, false);
  assert.equal(capabilities.body.recoveryJobs, true, "the open surface is untouched");
  // The route refuses with a status, and it says which capability and not which
  // caller, because nothing about the caller is wrong.
  const taint = await s.call("/api/records/1/taint", s.cookie);
  assert.equal(taint.status, 402);
  assert.equal(taint.body.error, "capability_not_included");
  // The routes around it are untouched, which is the difference between a
  // paywall and a product that stops working. They need a database this suite
  // does not provision, so what is asserted is that none of them answers with
  // the capability refusal: whatever else they say, they are not gated.
  for (const path of [
    "/api/ledger/export",
    "/api/ledger/verify",
    "/api/records/1/replay",
  ]) {
    const open = await s.call(path, s.cookie);
    assert.notEqual(open.body?.error, "capability_not_included", `${path} is not gated`);
  }
});

test("over HTTP: the hosted recovery apply is refused while the proof stays open", async (t) => {
  // The wiring in `cloud/server.mjs` under test, not just the module: the gate
  // is handed to `mountRecoveryRoutes`, and the free account is told the
  // capability is off and is refused the execution that spends it.
  const s = await server(t);
  const capabilities = await s.call("/api/capabilities", s.cookie);
  assert.equal(capabilities.status, 200);
  assert.equal(capabilities.body.verifiedRecovery, false);
  assert.equal(capabilities.body.recoveryJobs, true, "the capture and the receipt stay free");
  const applied = await s.call(
    "/api/sessions/session/recovery-jobs/apply",
    s.cookie,
    { method: "POST", body: { jobId: "job", planDigest: "a".repeat(64), approved: true } },
  );
  assert.equal(applied.status, 402);
  assert.equal(applied.body.error, "capability_not_included");
});

test("over HTTP: an unreadable entitlement fails the capability off, not the whole surface open", async (t) => {
  const s = await server(t, { polar: true });
  const capabilities = await s.call("/api/capabilities", s.cookie);
  assert.equal(capabilities.status, 200, "a failed read must not take the product down");
  assert.equal(capabilities.body.taintGraph, false);
  assert.equal((await s.call("/api/records/1/taint", s.cookie)).status, 402);
  // The failure is visible where somebody can act on it: the billing read
  // answers 503 rather than the empty answer that reads as "you are free".
  const billing = await s.call("/api/billing", s.cookie);
  assert.equal(billing.status, 503);
  assert.equal(billing.body.error, "billing_unavailable");
});

test("over HTTP: the operator's own control token reaches the paid capability", async (t) => {
  const s = await server(t);
  const capabilities = await s.call("/api/capabilities", `__Host-void-session=${s.operator}`);
  assert.equal(capabilities.status, 200);
  assert.equal(capabilities.body.taintGraph, true);
});
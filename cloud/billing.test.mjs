/**
 * Billing: the tests that make a forged, replayed or duplicated Polar delivery
 * impossible to accept by accident.
 *
 * The signature checks are not asserted against a stand-in verifier that
 * agrees with whatever the module believes. Every refusal test signs a real
 * Standard Webhooks request with the algorithm Polar documents and hands it to
 * `webhooks.validateEvent` from `@polar-sh/sdk`, the same function production
 * calls, so a refusal here is a refusal the SDK made and not one this
 * repository decided. The secret is a literal in this file and has never been
 * near a Polar account: no test here opens a socket to Polar, and no
 * credential for one exists in this environment.
 *
 * Each test names the property it guards and fails when that property is
 * broken. None of them asserts only that a call did not throw.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import express from "express";
import {
  classifyWebhookError,
  billingFromEnv,
  billingRoutes,
  mountBillingWebhook,
} from "./billing.mjs";
import { webhooks } from "@polar-sh/sdk/2026-10";
import { OPERATOR_OWNER } from "./owner.mjs";

const SECRET = "whsec_" + Buffer.from("nomo-billing-test-secret-32b").toString("base64");
const OTHER_SECRET = "whsec_" + Buffer.from("another-billing-secret-32b").toString("base64");
const ACCESS_TOKEN = "polar_oat_a_token_that_must_never_be_answered";
const PRODUCT = "product_team";
const CUSTOMER = "customer_1111";

const ENV = {
  NOMO_POLAR_ACCESS_TOKEN: ACCESS_TOKEN,
  NOMO_POLAR_ORGANIZATION_ID: "org_2222",
  NOMO_POLAR_WEBHOOK_SECRET: SECRET,
  NOMO_POLAR_PRODUCT_TEAM: PRODUCT,
  NOMO_POLAR_ENVIRONMENT: "sandbox",
};

const cloudDir = fileURLToPath(new URL(".", import.meta.url));
const readCloud = (name) => readFileSync(join(cloudDir, name), "utf8");
const now = () => Math.floor(Date.now() / 1000);

/**
 * Sign a body the way Polar signs one: HMAC-SHA256 over
 * `${id}.${timestamp}.${body}` with the decoded `whsec_` key, base64, in a
 * `v1,` header. This is the sender's half of the contract, written here so the
 * tests can produce deliveries; the receiver's half is the SDK's.
 */
function signed(body, { id = "msg_0001", timestamp = now(), secret = SECRET } = {}) {
  const key = Buffer.from(secret.replace(/^whsec_/, ""), "base64");
  return {
    "webhook-id": id,
    "webhook-timestamp": String(timestamp),
    "webhook-signature": `v1,${createHmac("sha256", key)
      .update(`${id}.${timestamp}.${body}`)
      .digest("base64")}`,
  };
}

/**
 * The three SDK failures, rebuilt with the same inheritance so the classifier
 * can be exercised without the package present. `PolarWebhookVerificationError`
 * and `PolarWebhookUnknownTypeError` both extend `PolarWebhookError` in the SDK,
 * and that is the fact the classifier's ordering depends on.
 */
function fakeSdk() {
  class PolarWebhookError extends Error {}
  class PolarWebhookVerificationError extends PolarWebhookError {}
  class PolarWebhookUnknownTypeError extends PolarWebhookError {
    constructor(eventType) {
      super(`Unknown webhook event type: ${eventType}`);
      this.eventType = eventType;
    }
  }
  return { PolarWebhookError, PolarWebhookVerificationError, PolarWebhookUnknownTypeError };
}

/** A service whose verifier always fails in the named way, for the route tests. */
const failingService = (errors, validateEvent) =>
  billingFromEnv(ENV, {
    ...memory().dep,
    loadWebhooks: async () => ({ ...errors, validateEvent }),
  });

const subscription = (over = {}) =>
  JSON.stringify({
    type: "subscription.active",
    timestamp: new Date().toISOString(),
    api_version: "2026-10-01",
    data: {
      id: "sub_3333",
      customer_id: CUSTOMER,
      product_id: PRODUCT,
      status: "active",
      current_period_start: "2026-10-01T00:00:00Z",
      current_period_end: "2026-11-01T00:00:00Z",
      cancel_at_period_end: false,
      ...over,
    },
  });

/**
 * The event types the installed SDK recognises, read out of its own build
 * rather than assumed, so a test that depends on a type being unknown fails
 * loudly the day the SDK learns it instead of quietly testing nothing.
 */
const knownEventTypes = () => {
  const source = readFileSync(fileURLToPath(import.meta.resolve("@polar-sh/sdk/2026-10")), "utf8");
  const start = source.indexOf("const knownEventTypes");
  const open = source.indexOf("[", start);
  const close = source.indexOf("]", open);
  return [...source.slice(open, close).matchAll(/"([^"]+)"/g)].map((match) => match[1]);
};

/**
 * An in-memory stand-in for `void_cloud_state`, with a transaction that really
 * does serialise per owner, because the advisory lock in `cloud/store.mjs` is
 * load bearing for the idempotence guarantee and a fake that ran callbacks
 * concurrently would test nothing about it.
 */
function memory() {
  const rows = new Map();
  const locks = new Map();
  const client = { rows };
  return {
    rows,
    at: (owner, key) => `${owner}|${key}`,
    has: (owner, key) => rows.has(`${owner}|${key}`),
    dep: {
      read: async (owner, key) => rows.get(`${owner}|${key}`),
      write: async (owner, key, value) => {
        rows.set(`${owner}|${key}`, structuredClone(value));
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

/**
 * An app shaped like `cloud/server.mjs`: the webhook above the JSON parser,
 * the owner middleware below it, the billing routes behind that. One store, so
 * a second caller in a test reads the same rows the first caller's delivery
 * wrote rather than a fresh empty database that could not have leaked anyway.
 */
async function fixture(t, { env = ENV, owner = "account-one", configured = true } = {}) {
  const store = memory();
  const verified = [];
  const service = configured
    ? billingFromEnv(env, {
        ...store.dep,
        loadWebhooks: async () => ({
          ...webhooks,
          validateEvent: (...args) => {
            verified.push(args[0]?.toString());
            return webhooks.validateEvent(...args);
          },
        }),
      })
    : undefined;
  const app = express();
  app.disable("x-powered-by");
  mountBillingWebhook(app, service);
  // Deliberately in this order: a webhook mounted below this would see a parsed
  // object instead of the signed bytes, which is the property the ordering in
  // cloud/server.mjs exists to protect.
  app.use(express.json({ limit: "64kb" }));
  const caller = { owner };
  app.use((req, _res, next) => {
    if (caller.owner) req.owner = caller.owner;
    next();
  });
  billingRoutes(app, service);
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const url = (path) => `http://127.0.0.1:${server.address().port}${path}`;
  const deliver = async (body, headers = signed(body)) => {
    const response = await fetch(url("/api/billing/webhook"), {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body,
    });
    return { status: response.status, body: await response.json() };
  };
  const get = async (path) => {
    const response = await fetch(url(path));
    const text = await response.text();
    return { status: response.status, body: JSON.parse(text), text };
  };
  const post = async (path, payload) => {
    const response = await fetch(url(path), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    const text = await response.text();
    return { status: response.status, body: JSON.parse(text) };
  };
  return { ...store, app, service, verified, deliver, get, post, url, as: (who) => (caller.owner = who) };
}

test("a signature over the exact bytes Polar sent is accepted and applied", async (t) => {
  const f = await fixture(t);
  await f.service.linkCustomer("account-one", CUSTOMER);
  const body = subscription();

  const delivered = await f.deliver(body);

  assert.equal(delivered.status, 200, "a valid delivery is accepted");
  assert.equal(delivered.body.applied, true);
  // The bytes that arrived are the bytes that were verified, which is only true
  // while the route is mounted above the JSON parser.
  assert.deepEqual(f.verified, [body]);

  const read = await f.get("/api/billing");
  assert.equal(read.status, 200);
  assert.deepEqual(read.body, {
    configured: true,
    subscribed: true,
    status: "active",
    currentPeriodEnd: "2026-11-01T00:00:00Z",
    cancelAtPeriodEnd: false,
    product: PRODUCT,
  });
});

test("one altered byte is refused, and nothing is written", async (t) => {
  const f = await fixture(t);
  await f.service.linkCustomer("account-one", CUSTOMER);
  const body = subscription();
  // Flip exactly one byte, in place, so the length is unchanged and the only
  // difference is a byte inside what Polar signed.
  const offset = body.indexOf("active");
  const altered = body.slice(0, offset) + "b" + body.slice(offset + 1);
  assert.equal(altered.length, body.length);

  const delivered = await f.deliver(altered, signed(body));

  assert.equal(delivered.status, 400);
  assert.equal(delivered.body.error, "signature_rejected");
  assert.equal(
    f.rows.size,
    2,
    "a forged delivery writes nothing beyond the two link documents already there",
  );
  const read = await f.get("/api/billing");
  assert.equal(read.body.subscribed, false);
  assert.equal(read.body.status, null);
});

test("each of the three signed headers is required", async (t) => {
  const f = await fixture(t);
  const body = subscription();
  for (const missing of ["webhook-signature", "webhook-id", "webhook-timestamp"]) {
    const headers = signed(body);
    delete headers[missing];
    const delivered = await f.deliver(body, headers);
    assert.equal(delivered.status, 400, `${missing} must be required`);
    assert.equal(delivered.body.error, "webhook_headers_missing");
    assert.deepEqual(delivered.body.missing, [missing]);
  }
  // The refusal happens before the verifier is reached: nothing was signed, so
  // there is nothing to ask the SDK about.
  assert.deepEqual(f.verified, []);
});

test("the replay window is 300 seconds, and it is enforced both ways", async (t) => {
  const f = await fixture(t);
  await f.service.linkCustomer("account-one", CUSTOMER);
  const start = now();

  const inside = subscription({ id: "sub_inside" });
  const accepted = await f.deliver(
    inside,
    signed(inside, { id: "msg_inside", timestamp: start - 299 }),
  );
  assert.equal(accepted.status, 200, "299 seconds old is inside the window");
  assert.equal(accepted.body.applied, true);

  const stale = subscription({ id: "sub_stale" });
  const tooOld = await f.deliver(
    stale,
    signed(stale, { id: "msg_stale", timestamp: start - 301 }),
  );
  assert.equal(tooOld.status, 400, "301 seconds old is outside the window");
  assert.equal(tooOld.body.error, "signature_rejected");

  // The SDK refuses `timestamp < now - 300` and `timestamp > now + 300`, where
  // `now` is the clock at the moment it verifies. The old edge is asserted at
  // the boundary because that is the edge a replay crosses, and a request that
  // takes a second to arrive makes such a delivery older, never fresher. The
  // future edge is asserted well outside the window rather than at 301: a
  // delivery stamped exactly 300 seconds ahead is accepted by design, so
  // asserting 301 would be asserting that the clock did not tick between
  // building the request and verifying it.
  const early = subscription({ id: "sub_early" });
  const tooNew = await f.deliver(
    early,
    signed(early, { id: "msg_early", timestamp: start + 3600 }),
  );
  assert.equal(tooNew.status, 400, "a timestamp an hour ahead is refused too");
  assert.equal(tooNew.body.error, "signature_rejected");

  // The refused deliveries changed nothing: the stored subscription is still
  // the one the accepted delivery wrote.
  const read = await f.get("/api/billing");
  assert.equal(read.body.subscribed, true);
  const stored = f.rows.get(f.at("account-one", "billing:subscription"));
  assert.equal(stored.subscriptionId, "sub_inside");
});

test("a signed event type outside the SDK's known set is answered, not refused", async (t) => {
  const f = await fixture(t);
  await f.service.linkCustomer("account-one", CUSTOMER);
  // `subscription.upgraded` is the kind of type Polar would add for a plan
  // change. It is outside the 42 types @polar-sh/sdk 1.0.1 knows, so
  // `validateEvent` throws `PolarWebhookUnknownTypeError` for it, which is
  // what this test exists to exercise.
  assert.equal(knownEventTypes().includes("subscription.upgraded"), false);
  assert.equal(knownEventTypes().includes("subscription.created"), true);
  const body = subscription().replace("subscription.active", "subscription.upgraded");
  assert.notEqual(body.includes("subscription.upgraded"), false);

  const delivered = await f.deliver(body);

  // Polar ships new event types. A 4xx here would make it redeliver a valid
  // event forever against an endpoint that will never accept it.
  assert.ok(
    delivered.status >= 200 && delivered.status < 300,
    `an unknown event type must not be a 4xx, got ${delivered.status}`,
  );
  assert.equal(delivered.status, 200);
  assert.equal(delivered.body.ok, true);
  assert.equal(delivered.body.applied, false);
  assert.equal(delivered.body.ignored, "unknown_event_type");
  assert.equal(
    delivered.body.unhandled,
    "subscription.upgraded",
    "the type is recorded so an operator reading Polar's delivery log can see it",
  );
  const read = await f.get("/api/billing");
  assert.equal(read.body.subscribed, false, "an unknown type applies nothing");
  assert.equal(f.has("account-one", "billing:subscription"), false);
});

test("the same event type is answered 2xx or 400 by the signature alone", async (t) => {
  const f = await fixture(t);
  await f.service.linkCustomer("account-one", CUSTOMER);
  const known = subscription().replace("subscription.active", "subscription.created");
  const applied = await f.deliver(known, signed(known, { id: "msg_pair_a" }));
  assert.equal(applied.status, 200);
  assert.equal(applied.body.applied, true, "a known type is applied, not ignored");

  // The identical type and the identical headers, with one byte of the body
  // changed after signing. Nothing about the request says "unknown type" now;
  // only the signature does, and that is what decides it.
  const offset = known.indexOf("active");
  const altered = known.slice(0, offset) + "b" + known.slice(offset + 1);
  const forged = await f.deliver(altered, signed(known, { id: "msg_pair_b" }));
  assert.equal(forged.status, 400, "one altered byte is a refusal");
  assert.equal(forged.body.error, "signature_rejected");
  assert.equal(forged.body.ignored, undefined);

  // An unknown type that is also forged is refused too: a type nobody knows
  // is not a pass, and the two answers stay decided by the signature.
  const future = subscription().replace("subscription.active", "subscription.upgraded");
  const forgedFuture = await f.deliver(future, signed(subscription(), { id: "msg_pair_c" }));
  assert.equal(forgedFuture.status, 400);
  assert.equal(forgedFuture.body.error, "signature_rejected");
});

test("a signed body that is not JSON is a bad request, not an unknown type", async (t) => {
  const f = await fixture(t);
  const body = "{not json at all";

  const delivered = await f.deliver(body);

  // `validateEvent` verifies first and parses second, so this signature is
  // good and the body is what is wrong. `PolarWebhookError` is the parent of
  // both other classes, so a classifier that checked it first would report
  // this as an unhandled type and answer 2xx.
  assert.equal(delivered.status, 400);
  assert.equal(delivered.body.error, "payload_malformed");
  assert.equal(f.rows.size, 0);
});

test("a known event that is not a subscription changes nothing", async (t) => {
  const f = await fixture(t);
  await f.service.linkCustomer("account-one", CUSTOMER);
  const body = JSON.stringify({
    type: "order.paid",
    timestamp: new Date().toISOString(),
    api_version: "2026-10-01",
    data: { id: "order_4444", customer_id: CUSTOMER, status: "paid" },
  });

  const delivered = await f.deliver(body);

  assert.equal(delivered.status, 200);
  assert.equal(delivered.body.applied, false);
  assert.equal(delivered.body.ignored, "not_a_subscription_event");
  const read = await f.get("/api/billing");
  assert.equal(read.body.subscribed, false);
});

test("a signed delivery for a customer nobody linked is answered and applied nowhere", async (t) => {
  const f = await fixture(t);
  const body = subscription();

  const delivered = await f.deliver(body);

  assert.equal(delivered.status, 200);
  assert.equal(delivered.body.ignored, "customer_not_linked");
  assert.equal(f.rows.size, 0, "an unlinked customer writes no document anywhere");
});

test("the same webhook id applies once, even delivered twice at once", async (t) => {
  const f = await fixture(t);
  await f.service.linkCustomer("account-one", CUSTOMER);
  const active = subscription();
  // The second delivery carries a later state. If idempotence were checked
  // after the write, or outside the transaction, this would end as canceled.
  const cancelled = subscription({ status: "canceled" });

  const first = await f.deliver(active, signed(active, { id: "msg_same" }));
  const second = await f.deliver(cancelled, signed(cancelled, { id: "msg_same" }));

  assert.equal(first.body.applied, true);
  assert.equal(second.body.applied, false);
  assert.equal(second.body.duplicate, true);
  const read = await f.get("/api/billing");
  assert.equal(read.body.status, "active", "the replay must not win");

  // Two deliveries of one id in flight together, raced against the module
  // rather than through HTTP: two requests to a listening server are far enough
  // apart that the first finishes before the second is read, which would make
  // this assertion pass even with the duplicate check moved out of the
  // transaction. These two calls both enter before either writes, which is the
  // case the advisory lock exists for. Which one wins is not decided, so the
  // assertion is that the survivor is the one that reported applying.
  const race = (id, status) => ({
    type: "subscription.active",
    data: { ...JSON.parse(subscription({ id, status })).data },
  });
  const [one, two] = await Promise.all([
    f.service.applySubscription(race("sub_a", "trialing"), "msg_race"),
    f.service.applySubscription(race("sub_b", "past_due"), "msg_race"),
  ]);
  assert.equal(
    [one.applied, two.applied].filter(Boolean).length,
    1,
    "exactly one concurrent delivery of one id may apply",
  );
  assert.equal([one.duplicate, two.duplicate].filter(Boolean).length, 1);
  const survivor = f.rows.get(f.at("account-one", "billing:subscription"));
  assert.equal(
    survivor.subscriptionId,
    one.applied ? "sub_a" : "sub_b",
    "the stored document is the one that reported applying",
  );
  const after = await f.get("/api/billing");
  assert.ok(
    ["trialing", "past_due"].includes(after.body.status),
    `the stored status is one of the two delivered, got ${after.body.status}`,
  );
  assert.equal(
    after.body.subscribed,
    after.body.status === "trialing",
    "a state that is not a live payment is reported as not subscribed",
  );
  assert.deepEqual(
    f.rows.get(f.at("account-one", "billing:webhooks")).ids,
    ["msg_same", "msg_race"],
    "each event id is remembered once",
  );
});

test("a delivery carries no owner: the request cannot choose one", async (t) => {
  const f = await fixture(t);
  await f.service.linkCustomer("account-one", CUSTOMER);
  const body = subscription();

  const delivered = await f.deliver(body, {
    ...signed(body, { id: "msg_owner" }),
    "x-nomo-owner": "account-two",
    "x-nomo-control-token": "not-a-control-token",
  });

  assert.equal(delivered.status, 200);
  assert.equal((await f.get("/api/billing")).body.subscribed, true);
  assert.ok(
    f.has("account-one", "billing:subscription"),
    "the entitlement is written under the linked owner",
  );
  assert.equal(
    f.has("account-two", "billing:subscription"),
    false,
    "no document may be written under an owner the request named",
  );
  assert.equal(
    f.has(OPERATOR_OWNER, "billing:subscription"),
    false,
    "the operator namespace holds the index, never somebody's entitlement",
  );
  assert.ok(f.has(OPERATOR_OWNER, `billing:index:${CUSTOMER}`));
});

test("an unconfigured server answers honestly and never 500s", async (t) => {
  const f = await fixture(t, { configured: false });
  const body = subscription();

  const delivered = await f.deliver(body);
  assert.equal(delivered.status, 503);
  assert.equal(delivered.body.error, "billing_not_configured");

  // A request that is nonsense in every other way is still not a crash.
  const rubbish = await fetch(`${f.url("/api/billing/webhook")}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{",
  });
  assert.equal(rubbish.status, 503);

  const read = await f.get("/api/billing");
  assert.equal(read.status, 200);
  assert.deepEqual(read.body, {
    configured: false,
    subscribed: false,
    status: null,
    currentPeriodEnd: null,
    cancelAtPeriodEnd: false,
    product: null,
  });

  const link = await f.post("/api/billing/customer", { customerId: CUSTOMER });
  assert.equal(link.status, 503);
  assert.equal(link.body.error, "billing_not_configured");
  assert.equal(f.rows.size, 0, "an unconfigured server writes nothing");

  assert.equal(billingFromEnv({}), undefined);
});

test("GET /api/billing answers for the caller and for nobody else", async (t) => {
  const f = await fixture(t);
  await f.service.linkCustomer("account-one", CUSTOMER);
  const body = subscription();
  await f.deliver(body);

  const mine = await f.get("/api/billing");
  assert.equal(mine.body.subscribed, true);
  // Nothing a credential is made of, and nothing belonging to somebody else,
  // is in the answer. The Polar customer id is in the stored document and is
  // not published.
  assert.doesNotMatch(mine.text, new RegExp(ACCESS_TOKEN));
  assert.doesNotMatch(mine.text, /whsec_/);
  assert.doesNotMatch(mine.text, /customer_1111/);
  assert.doesNotMatch(mine.text, /account-one/);
  assert.deepEqual(Object.keys(mine.body).sort(), [
    "cancelAtPeriodEnd",
    "configured",
    "currentPeriodEnd",
    "product",
    "status",
    "subscribed",
  ]);

  // Same deployment, same store, a different owner.
  f.as("account-two");
  const theirs = await f.get("/api/billing");
  assert.equal(theirs.status, 200);
  assert.equal(theirs.body.subscribed, false, "another owner's subscription is not readable");
  assert.equal(theirs.body.status, null);
  assert.equal(theirs.body.product, null);
  assert.doesNotMatch(theirs.text, /sub_3333/);

  // And the operator's namespace is not a way around it.
  f.as(OPERATOR_OWNER);
  const operator = await f.get("/api/billing");
  assert.equal(operator.body.subscribed, false, "the operator namespace reads its own rows only");
});

test("the billing routes refuse a request with no resolved owner", async (t) => {
  const f = await fixture(t, { owner: null });
  const read = await f.get("/api/billing");
  assert.equal(read.status, 401);
  assert.equal(read.body.error, "authentication_required");
  const link = await f.post("/api/billing/customer", { customerId: CUSTOMER });
  assert.equal(link.status, 401);
  assert.equal(f.rows.size, 0);
});

test("billingFromEnv reads the environment when it is called", async () => {
  const env = {};
  assert.equal(billingFromEnv(env), undefined, "an empty environment configures nothing");

  env.NOMO_POLAR_WEBHOOK_SECRET = SECRET;
  assert.equal(
    billingFromEnv(env),
    undefined,
    "a webhook secret without an account is half a configuration",
  );

  env.NOMO_POLAR_ACCESS_TOKEN = ACCESS_TOKEN;
  assert.equal(billingFromEnv(env), undefined, "no organization is still half");

  env.NOMO_POLAR_ORGANIZATION_ID = "org_2222";
  assert.ok(billingFromEnv(env), "the four required variables configure the service");

  // An environment name that is not one of Polar's two is a deployment that
  // does not know which account it is billing, so it is refused rather than
  // assumed.
  assert.equal(billingFromEnv({ ...env, NOMO_POLAR_ENVIRONMENT: "staging" }), undefined);
  assert.ok(billingFromEnv({ ...env, NOMO_POLAR_ENVIRONMENT: "production" }));
  assert.ok(billingFromEnv({ ...env, NOMO_POLAR_ENVIRONMENT: undefined }));

  // The secret is read through the environment on every verification, so
  // rotating it takes effect without restarting the process. The environment
  // object is held on to and changed underneath the service, which is the only
  // way to tell reading it per call apart from copying it once.
  const rotating = { ...env, NOMO_POLAR_WEBHOOK_SECRET: SECRET };
  const service = billingFromEnv(rotating);
  const body = subscription();
  const refused = await service.verify(
    Buffer.from(body),
    signed(body, { id: "msg_rotate", secret: OTHER_SECRET }),
  );
  assert.equal(refused.ok, false, "a signature made with another secret is refused");
  assert.equal(refused.failure, "signature_rejected");

  rotating.NOMO_POLAR_WEBHOOK_SECRET = OTHER_SECRET;
  const accepted = await service.verify(
    Buffer.from(body),
    signed(body, { id: "msg_rotate", secret: OTHER_SECRET }),
  );
  assert.equal(
    accepted.ok,
    true,
    "the environment, not a copy of it taken at startup, decides the secret",
  );
  const stale = await service.verify(
    Buffer.from(body),
    signed(body, { id: "msg_rotate_2", secret: SECRET }),
  );
  assert.equal(stale.ok, false, "the old secret stops working the moment it is rotated");

  // A verifier that cannot be loaded is this deployment's problem, and is
  // answered as retryable rather than as a forged request.
  const broken = billingFromEnv(env, {
    loadWebhooks: async () => {
      throw new Error("@polar-sh/sdk is not installed");
    },
  });
  const unavailable = await broken.verify(Buffer.from(body), signed(body));
  assert.deepEqual(unavailable, { ok: false, failure: "verifier_unavailable" });
});

test("two accounts cannot claim the same Polar customer", async (t) => {
  const f = await fixture(t);
  await f.service.linkCustomer("account-one", CUSTOMER);

  const steal = await f.service.linkCustomer("account-two", CUSTOMER).then(
    () => null,
    (error) => error,
  );
  assert.ok(steal, "the second claim is refused");
  assert.equal(steal.status, 409);

  // The same refusal through the authenticated route, as the second account.
  f.as("account-two");
  const viaRoute = await f.post("/api/billing/customer", { customerId: CUSTOMER });
  assert.equal(viaRoute.status, 409);
  assert.equal(viaRoute.body.error, "customer_already_linked");

  // An owner claiming the same customer again is not a conflict: it is the
  // same binding, and refusing it would make a retry look like an attack.
  f.as("account-one");
  const again = await f.post("/api/billing/customer", { customerId: CUSTOMER });
  assert.equal(again.status, 200);
  assert.deepEqual(again.body, { linked: true });

  // And the refusal held: the delivery still lands on the first owner.
  const body = subscription();
  await f.deliver(body);
  assert.ok(f.has("account-one", "billing:subscription"));
  assert.equal(f.has("account-two", "billing:subscription"), false);
  assert.equal(f.has("account-two", "billing:customer"), false);

  const invalid = await f.post("/api/billing/customer", { customerId: "not an id" });
  assert.equal(invalid.status, 400);
  assert.equal(invalid.body.error, "invalid_customer_id");
});

test("an owner who moves to another Polar customer releases the old index entry", async (t) => {
  const f = await fixture(t);
  await f.service.linkCustomer("account-one", CUSTOMER);
  await f.service.linkCustomer("account-one", "customer_2222");

  const index = f.rows.get(f.at(OPERATOR_OWNER, `billing:index:${CUSTOMER}`));
  assert.equal(index.owner, null, "the released entry resolves to no owner");
  const released = subscription();
  const delivered = await f.deliver(released, signed(released));
  assert.equal(delivered.body.ignored, "customer_not_linked");
  assert.equal(f.has("account-one", "billing:subscription"), false);
});

test("the webhook is mounted above the JSON parser and above the owner middleware", async (t) => {
  // The real application, not a reconstruction of it. The Polar variables are
  // set before the import so the module configures a real service, and the
  // store driver is stubbed so no database is dialled: this delivery is
  // answered before any query is built, because the customer is not linked.
  const { Pool } = await import("pg");
  const driver = Pool.prototype.query;
  const restore = { ...process.env };
  const previousUrl = process.env.DATABASE_URL;
  // The operator control token is set so the owner middleware is configured:
  // with neither it nor an account provider it answers `setup_required`, which
  // would prove nothing about which side of it the webhook sits on.
  Object.assign(process.env, ENV, { NOMO_CONTROL_TOKEN: "control-token-for-the-mount-test-1" });
  process.env.DATABASE_URL = "postgresql://void:void@127.0.0.1:1/void";
  Pool.prototype.query = () => Promise.resolve({ rows: [], rowCount: 0 });
  const store = await import("./store.mjs");
  const { default: app } = await import("./server.mjs");
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  t.after(async () => {
    server.closeAllConnections();
    server.close();
    Pool.prototype.query = driver;
    await store.database().end();
    if (previousUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previousUrl;
    for (const key of Object.keys(process.env)) if (!(key in restore)) delete process.env[key];
    Object.assign(process.env, restore);
  });

  const body = subscription();
  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/billing/webhook`, {
    method: "POST",
    headers: { "content-type": "application/json", ...signed(body) },
    body,
  });

  // 401 would mean the owner middleware reached it first, a 400 naming the body
  // would mean the JSON parser did, and a 5xx would mean it answered something
  // other than what it decided.
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    ok: true,
    applied: false,
    ignored: "customer_not_linked",
  });

  // The read route is on the other side of the owner gate, where it belongs.
  const signedOut = await fetch(`http://127.0.0.1:${server.address().port}/api/billing`);
  assert.equal(
    signedOut.status,
    401,
    "the read route sits behind the owner gate, not in front of it",
  );

  // And the order in the source is the order these two answers came from.
  const source = readCloud("server.mjs");
  const webhook = source.indexOf("mountBillingWebhook(app, billing)");
  const json = source.indexOf("app.use(express.json(");
  const routes = source.indexOf("billingRoutes(app, billing)");
  const owner = source.indexOf("app.use(async (req, res, next) =>");
  assert.ok(webhook < json, "the webhook is mounted above the JSON parser");
  assert.ok(webhook < owner, "the webhook is mounted above the owner middleware");
  assert.ok(routes > owner, "the billing routes are mounted behind the owner middleware");
});

test("the paid decision lives in the closed tier, never in the open capability surface", async (t) => {
  // The invariant here is a LICENCE one, not an entitlement one: the paid
  // decision may be taken in `cloud/`, which is not Apache 2.0 open core, but
  // it must never reach `packages/workbench/src/gui.ts`, because that package
  // is open and `scripts/src/licence-line.test.mjs` enforces the line.
  //
  // This used to assert the stronger, and now false, claim that no capability
  // is gated at all. Issue #55 settled that argument and the taint graph is now
  // gated on an entitlement, so the claim described the past rather than the
  // rule.
  //
  // It also found the `cloud/` overlay by slicing from the route to the next
  // `"}));"`, which worked only because the overlay happened to be a single
  // expression. Changing the route's punctuation moves that marker far away and
  // the assertion silently starts scanning an unrelated part of the file — a
  // tripwire defanged by a reformat, which is worse than no tripwire. The
  // `cloud/` half is now asserted positively by `cloud/capability-gate.test.mjs`,
  // which checks the route reads the gate and the paid route refuses on it.
  // What is left here, and what neither file can check from the other side, is
  // the open package.
  const open = readFileSync(
    join(cloudDir, "..", "packages", "workbench", "src", "gui.ts"),
    "utf8",
  );
  const capabilities = open.slice(
    open.indexOf("export const capabilities"),
    open.indexOf("export type ProviderStatus"),
  );
  assert.ok(capabilities.length > 0, "the open capability surface was found");
  assert.doesNotMatch(capabilities, /billing|entitle|subscrib|polar|taintGraph/i);
  assert.doesNotMatch(open, /PAID_CAPABILITIES|capability-gate/i);

  // The entitlement is readable and correct on its own terms, which is all this
  // test claims for the billing layer.
  const f = await fixture(t);
  await f.service.linkCustomer("account-one", CUSTOMER);
  await f.deliver(subscription());
  assert.equal((await f.get("/api/billing")).body.subscribed, true);
});

test("the module never puts an owner on a request or reads one from one", () => {
  const source = readCloud("billing.mjs");
  assert.deepEqual(
    [...source.matchAll(/(\w+)\.owner\s*=[^=]/g)].map((match) => match[0]),
    [],
    "only the middleware in cloud/server.mjs may put an owner on a request",
  );
  for (const forbidden of [
    "req.query.owner",
    "req.body.owner",
    "req.headers.owner",
    'req.headers["x-nomo-owner"]',
  ])
    assert.equal(
      source.includes(forbidden),
      false,
      `${forbidden} must not be read by this module`,
    );
  // The store is reached only through the owner-first helpers and never with a
  // statement of its own, so the account-ownership scan in cloud/owner.test.mjs
  // has nothing new to check here.
  assert.doesNotMatch(source, /\.query\(/);
  assert.equal(source.includes("assertOwner"), true);
});

test("the classifier tells the three SDK failures apart, narrowest class first", () => {
  const errors = fakeSdk();
  const names = {
    Base: errors.PolarWebhookError,
    Verification: errors.PolarWebhookVerificationError,
    UnknownType: errors.PolarWebhookUnknownTypeError,
  };

  assert.equal(
    classifyWebhookError(new errors.PolarWebhookVerificationError("Message timestamp too old"), names),
    "signature_rejected",
  );
  assert.equal(
    classifyWebhookError(new errors.PolarWebhookUnknownTypeError("subscription.upgraded"), names),
    "unknown_event_type",
  );
  assert.equal(
    classifyWebhookError(new errors.PolarWebhookError("Failed to parse webhook payload"), names),
    "payload_malformed",
  );
  // The parent class is checked last on purpose. `PolarWebhookUnknownTypeError`
  // is a `PolarWebhookError`, so a classifier that checked the parent first
  // would report a valid, correctly signed event as a malformed body and
  // answer it 400, which is the redelivery loop this ordering prevents.
  assert.ok(
    new errors.PolarWebhookUnknownTypeError("x") instanceof errors.PolarWebhookError,
    "the unknown-type error really does extend the parent",
  );
  // Anything the SDK does not name is treated as a failed verification, which
  // is the only reading of it that does not let a request through.
  assert.equal(classifyWebhookError(new Error("boom"), names), "signature_rejected");
});

test("the seam reaches the same three outcomes without the SDK present", async () => {
  const errors = fakeSdk();
  const store = memory();
  const build = (validateEvent) =>
    billingFromEnv(ENV, { ...store.dep, loadWebhooks: async () => ({ ...errors, validateEvent }) });
  const body = subscription();
  const headers = signed(body);

  const forged = await build(async () => {
    throw new errors.PolarWebhookVerificationError("No matching signature found");
  }).verify(Buffer.from(body), headers);
  assert.deepEqual(forged, { ok: false, failure: "signature_rejected" });

  const future = await build(async () => {
    throw new errors.PolarWebhookUnknownTypeError("subscription.upgraded");
  }).verify(Buffer.from(body), headers);
  assert.deepEqual(future, {
    ok: false,
    failure: "unknown_event_type",
    eventType: "subscription.upgraded",
  });

  const malformed = await build(async () => {
    throw new errors.PolarWebhookError("Failed to parse webhook payload");
  }).verify(Buffer.from(body), headers);
  assert.deepEqual(malformed, { ok: false, failure: "payload_malformed" });
});

test("the route answers an unknown type with 2xx and every other refusal with 4xx", async (t) => {
  // The routing half, separated from the verifying half, because a classifier
  // that computes the right answer and a route that ignores it is a defect
  // that survives review: each half looks correct on its own.
  const errors = fakeSdk();
  const cases = [
    {
      name: "unknown type",
      throws: () => new errors.PolarWebhookUnknownTypeError("subscription.upgraded"),
      status: 200,
      body: {
        ok: true,
        applied: false,
        ignored: "unknown_event_type",
        unhandled: "subscription.upgraded",
      },
    },
    {
      name: "bad signature",
      throws: () => new errors.PolarWebhookVerificationError("No matching signature found"),
      status: 400,
      body: { error: "signature_rejected" },
    },
    {
      name: "body that is not JSON",
      throws: () => new errors.PolarWebhookError("Failed to parse webhook payload"),
      status: 400,
      body: { error: "payload_malformed" },
    },
  ];

  for (const testCase of cases) {
    const app = express();
    mountBillingWebhook(
      app,
      failingService(errors, async () => {
        throw testCase.throws();
      }),
    );
    const server = app.listen(0, "127.0.0.1");
    await new Promise((resolve) => server.once("listening", resolve));
    t.after(() => {
      server.closeAllConnections();
      server.close();
    });
    const body = subscription();
    const response = await fetch(
      `http://127.0.0.1:${server.address().port}/api/billing/webhook`,
      {
        method: "POST",
        headers: { "content-type": "application/json", ...signed(body) },
        body,
      },
    );
    assert.equal(response.status, testCase.status, `${testCase.name} status`);
    assert.deepEqual(await response.json(), testCase.body, `${testCase.name} body`);
  }
});


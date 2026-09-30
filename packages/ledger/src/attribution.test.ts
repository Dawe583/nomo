import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { entryHash } from "./canonical.ts";
import {
  buildAttribution,
  readLedgerReason,
  type LedgerAttribution,
} from "./attribution.ts";
import { devKeyProvider, sha256Hex } from "./sign.ts";
import { signingPreimage, type KeyProvider } from "./index.ts";
import { jsonlStore, type JsonlEntry } from "./store.ts";
import { readLedgerFeed } from "./feed.ts";
import { verifyChain } from "./verify.ts";

const workspace = "attribution-ws";
const POLICY = "a".repeat(64);
const OTHER_POLICY = "b".repeat(64);

const body = (extra: Record<string, unknown> = {}) => ({
  workspace,
  at: "2026-01-01T00:00:00.000Z",
  tool: "postgres.row.delete",
  klass: "r2",
  decision: "deny",
  argsDigest: "c".repeat(64),
  ...extra,
});

const rationaleAttribution: LedgerAttribution = {
  policyDigest: POLICY,
  rule: { index: 3, rationale: "production deletes need a human" },
};

async function fixture(t: TestContext) {
  const dir = await mkdtemp(join(tmpdir(), "void-attribution-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const key = await devKeyProvider({ dir: join(dir, "keys"), env: {} });
  const attacker = await devKeyProvider({ dir: join(dir, "attacker"), env: {} });
  return { dir, key, attacker, store: jsonlStore(key, { dir }) };
}

async function collect(store: ReturnType<typeof jsonlStore>): Promise<JsonlEntry[]> {
  const entries: JsonlEntry[] = [];
  for await (const entry of store.read(workspace)) entries.push(entry);
  return entries;
}

/**
 * Rewrites the file the way an attacker holding its own key would: every body
 * is changed, every hash is recomputed over the new body, every link is
 * re-pointed at its new predecessor, and every entry is re-signed. Nothing
 * here is a shortcut, so a check that survives this is a real check.
 */
async function rewriteChain(
  entries: readonly JsonlEntry[],
  attacker: KeyProvider,
  mutate: (entry: JsonlEntry) => JsonlEntry,
): Promise<JsonlEntry[]> {
  const keyId = await attacker.currentKeyId();
  let prev = "0".repeat(64);
  const out: JsonlEntry[] = [];
  for (const entry of entries) {
    const changed = mutate(entry);
    const hash = await entryHash(changed.body, prev, sha256Hex);
    const signature = await attacker.sign(
      signingPreimage(attacker.alg, keyId, hash),
    );
    out.push({
      ...changed,
      prev_hash: prev,
      hash,
      key_id: keyId,
      alg: attacker.alg,
      signature: `${attacker.alg}:${Buffer.from(signature).toString("base64")}`,
    });
    prev = hash;
  }
  return out;
}

const file = (dir: string, entries: readonly JsonlEntry[]): string =>
  join(dir, `${workspace}.jsonl`);

const asFile = (entries: readonly JsonlEntry[]): string =>
  `${entries.map((entry) => `${JSON.stringify(entry)}\n`).join("")}`;

test("an entry written before records carried a reason still verifies", async (t) => {
  const { dir, key, store } = await fixture(t);
  // The body a writer produced before attribution existed. The field is
  // optional in the body, so there is nothing to migrate and no reader has to
  // invent a reason for a record that never made the claim.
  await store.append(body());
  await store.append(body({ decision: "allow:resolved" }));
  assert.deepEqual(await store.verify(workspace), { ok: true, checked: 2 });

  const chain = await verifyChain(await collect(store), {
    publicKey: (id) => key.publicKey(id),
  });
  assert.equal(chain.ok, true);
  assert.equal(chain.checked, 2);

  const page = await readLedgerFeed(file(dir, []), {
    publicKey: (id) => key.publicKey(id),
  });
  assert.equal(page.records.length, 2);
  for (const record of page.records)
    assert.ok(!("attribution" in record), "an old record claims nothing");
});

test("a rewritten rationale fails, re-chained and re-signed with a real key", async (t) => {
  const { dir, key, attacker, store } = await fixture(t);
  await store.append(body({ attribution: rationaleAttribution }));
  await store.append(body({ decision: "deny:resolved", attribution: rationaleAttribution }));
  const honest = await collect(store);
  assert.equal(
    (await verifyChain(honest, { publicKey: (id) => key.publicKey(id) })).ok,
    true,
  );

  const forged = await rewriteChain(honest, attacker, (entry) => ({
    ...entry,
    body: {
      ...(entry.body as Record<string, unknown>),
      attribution: {
        policyDigest: POLICY,
        rule: { index: 3, rationale: "routine maintenance" },
      },
    },
  }));
  // The rewrite is a valid chain under the attacker's own key and invalid
  // under the operator's. That gap is the whole of the binding claim.
  assert.equal(
    (await verifyChain(forged, { publicKey: (id) => attacker.publicKey(id) })).ok,
    true,
  );
  assert.equal(
    (await verifyChain(forged, { publicKey: (id) => key.publicKey(id) })).ok,
    false,
  );

  await writeFile(file(dir, forged), asFile(forged));
  assert.equal((await store.verify(workspace)).ok, false);
});

test("a rewritten policy digest fails, re-chained and re-signed with a real key", async (t) => {
  const { dir, key, attacker, store } = await fixture(t);
  await store.append(body({ attribution: rationaleAttribution }));
  const forged = await rewriteChain(
    await collect(store),
    attacker,
    (entry) => ({
      ...entry,
      body: {
        ...(entry.body as Record<string, unknown>),
        attribution: { ...rationaleAttribution, policyDigest: OTHER_POLICY },
      },
    }),
  );
  assert.equal(
    (await verifyChain(forged, { publicKey: (id) => key.publicKey(id) })).ok,
    false,
  );
  await writeFile(file(dir, forged), asFile(forged));
  assert.equal((await store.verify(workspace)).ok, false);
});

test("a rewritten rule index fails", async (t) => {
  const { key, attacker, store } = await fixture(t);
  await store.append(body({ attribution: rationaleAttribution }));
  const forged = await rewriteChain(
    await collect(store),
    attacker,
    (entry) => ({
      ...entry,
      body: {
        ...(entry.body as Record<string, unknown>),
        attribution: { ...rationaleAttribution, rule: { index: 4, rationale: "production deletes need a human" } },
      },
    }),
  );
  assert.equal(
    (await verifyChain(forged, { publicKey: (id) => key.publicKey(id) })).ok,
    false,
  );
});

test("stripping the reason off a record fails under the operator's key", async (t) => {
  const { key, attacker, store } = await fixture(t);
  await store.append(body({ attribution: rationaleAttribution }));
  const forged = await rewriteChain(await collect(store), attacker, (entry) => {
    const stripped = { ...(entry.body as Record<string, unknown>) };
    delete stripped.attribution;
    return { ...entry, body: stripped };
  });
  assert.equal(
    (await verifyChain(forged, { publicKey: (id) => key.publicKey(id) })).ok,
    false,
  );
  // The forged chain verifies under the attacker's key because nothing in the
  // chain ever asserted a reason. The reason is bound by the operator's
  // signature, not by the shape of the file, and a test that read otherwise
  // would be asserting a protection the format does not provide.
  assert.equal(
    (await verifyChain(forged, { publicKey: (id) => attacker.publicKey(id) })).ok,
    true,
  );
});

test("an in place edit of a rationale is caught before any signature is consulted", async (t) => {
  const { store } = await fixture(t);
  await store.append(body({ attribution: rationaleAttribution }));
  const [entry] = await collect(store);
  const edited: JsonlEntry = {
    ...entry!,
    body: {
      ...(entry!.body as Record<string, unknown>),
      attribution: { ...rationaleAttribution, rule: { index: 3, rationale: "edited" } },
    },
  };
  const checked = await verifyChain([edited]);
  assert.equal(checked.ok, false);
  assert.match(checked.reason ?? "", /body does not match digest/);
});

test("no reason recorded, no rule fired and no rationale are three different facts", () => {
  assert.deepEqual(readLedgerReason({ workspace }, 1), { kind: "unattributed" });
  assert.deepEqual(readLedgerReason(body(), 1), { kind: "unattributed" });

  const noRule = readLedgerReason({ attribution: { policyDigest: POLICY } }, 1);
  assert.deepEqual(
    noRule.kind === "attributed" ? noRule.attribution : null,
    { policyDigest: POLICY },
  );

  const noRationale = readLedgerReason(
    { attribution: { policyDigest: POLICY, rule: { index: 0 } } },
    1,
  );
  assert.deepEqual(
    noRationale.kind === "attributed" ? noRationale.attribution : null,
    { policyDigest: POLICY, rule: { index: 0 } },
  );

  // An empty rationale is a stated one and must not read as a missing field
  // the way an absent one does.
  const empty = readLedgerReason(
    { attribution: { policyDigest: POLICY, rule: { index: 0, rationale: "" } } },
    1,
  );
  assert.equal(
    empty.kind === "attributed" ? empty.attribution.rule?.rationale : null,
    "",
  );

  assert.notDeepEqual(
    readLedgerReason({ attribution: { policyDigest: POLICY } }, 1),
    readLedgerReason({ attribution: { policyDigest: POLICY, rule: { index: 0 } } }, 1),
  );
  assert.notDeepEqual(
    readLedgerReason({ attribution: { policyDigest: POLICY, rule: { index: 0 } } }, 1),
    readLedgerReason(
      { attribution: { policyDigest: POLICY, rule: { index: 0, rationale: "" } } },
      1,
    ),
  );
});

test("an attribution a reader cannot vouch for is a named finding, not a crash", () => {
  const cases: readonly (readonly [unknown, RegExp])[] = [
    ["nope", /attribution is not an object/],
    [{ rule: { index: 0 } }, /policyDigest is not 64 lowercase hex characters/],
    [{ policyDigest: POLICY, extra: 1 }, /unknown key extra/],
    [{ policyDigest: POLICY.toUpperCase() }, /policyDigest is not 64 lowercase hex/],
    [{ policyDigest: POLICY, rule: 3 }, /rule is not an object/],
    [{ policyDigest: POLICY, rule: { index: -1 } }, /index is not a whole number/],
    [{ policyDigest: POLICY, rule: { index: 0.5 } }, /index is not a whole number/],
    [{ policyDigest: POLICY, rule: { index: 0, rationale: 7 } }, /rationale is not a string/],
    [{ policyDigest: POLICY, rule: { index: 0, seconds: 30 } }, /unknown key seconds/],
  ];
  for (const [attribution, expected] of cases) {
    const reason = readLedgerReason({ attribution }, 4);
    assert.equal(reason.kind, "malformed", JSON.stringify(attribution));
    assert.match(reason.kind === "malformed" ? reason.detail : "", expected);
    assert.match(reason.kind === "malformed" ? reason.detail : "", /entry 4 /);
  }
});

test("a malformed attribution fails the chain, while a missing one does not", async (t) => {
  const { dir, attacker, store } = await fixture(t);
  await store.append(body({ attribution: rationaleAttribution }));
  const forged = await rewriteChain(
    await collect(store),
    attacker,
    (entry) => ({
      ...entry,
      body: { ...(entry.body as Record<string, unknown>), attribution: { policyDigest: 7 } },
    }),
  );
  const checked = await verifyChain(forged);
  assert.equal(checked.ok, false);
  assert.match(checked.reason ?? "", /attribution: entry 1 attribution policyDigest/);
  await writeFile(file(dir, forged), asFile(forged));
  assert.equal((await store.verify(workspace)).ok, false);
});

test("the feed carries the reason, and says nothing on an entry that has none", async (t) => {
  const { dir, store } = await fixture(t);
  await store.append(body({ attribution: rationaleAttribution }));
  await store.append(body({ decision: "allow:resolved" }));
  const page = await readLedgerFeed(file(dir, []));
  assert.deepEqual(page.records[0]?.attribution, rationaleAttribution);
  assert.ok(!("attribution" in (page.records[1] ?? {})));
});

test("the writer shapes a rule with no rationale apart from one with an empty one", () => {
  assert.deepEqual(buildAttribution(POLICY, {}), { policyDigest: POLICY });
  assert.deepEqual(buildAttribution(POLICY, { ruleIndex: 2 }), {
    policyDigest: POLICY,
    rule: { index: 2 },
  });
  assert.deepEqual(buildAttribution(POLICY, { ruleIndex: 2, rationale: "" }), {
    policyDigest: POLICY,
    rule: { index: 2, rationale: "" },
  });
});

/**
 * The compatibility rule, as bytes rather than as a claim about bytes. The
 * first record carries the attribution exactly as it was written before
 * `modelId` and `requestDigest` existed, is read back off disk, and has its
 * keys counted. The second carries all four fields, so the two sit in one
 * chain and the verifier has to accept both.
 */
test("a record written before the widening still verifies beside a widened one", async (t) => {
  const { dir, key, store } = await fixture(t);
  await store.append(
    body({
      attribution: {
        policyDigest: POLICY,
        rule: { index: 2, rationale: "production deletes need a human" },
      },
    }),
  );
  await store.append(
    body({
      decision: "allow:resolved",
      attribution: buildAttribution(
        OTHER_POLICY,
        { ruleIndex: 1 },
        { modelId: "vendor/model-1", requestDigest: "d".repeat(64) },
      ),
    }),
  );

  const lines = (await readFile(file(dir, []), "utf8")).trim().split("\n");
  const stored = JSON.parse(lines[0]!) as JsonlEntry;
  // Narrowed rather than asserted through: the point of the test is that the
  // bytes on disk are the old shape, so the read of those bytes is the
  // assertion and a cast would let a malformed body satisfy it.
  const onDisk = stored.body as { readonly attribution?: unknown };
  assert.ok(
    typeof onDisk.attribution === "object" &&
      onDisk.attribution !== null &&
      !Array.isArray(onDisk.attribution),
    "the pre-widening record carries an attribution object on disk",
  );
  assert.deepEqual(
    Object.keys(onDisk.attribution).sort(),
    ["policyDigest", "rule"],
    "the pre-widening record must carry the old shape on disk",
  );
  assert.equal(readLedgerReason(stored.body, 1).kind, "attributed");

  assert.deepEqual(await store.verify(workspace), { ok: true, checked: 2 });
  const chain = await verifyChain(await collect(store), {
    publicKey: (id) => key.publicKey(id),
  });
  assert.equal(chain.ok, true);

  const page = await readLedgerFeed(file(dir, []), {
    publicKey: (id) => key.publicKey(id),
  });
  const old = page.records[0]?.attribution;
  assert.ok(old && !("modelId" in old) && !("requestDigest" in old));
  assert.deepEqual(page.records[1]?.attribution, {
    policyDigest: OTHER_POLICY,
    modelId: "vendor/model-1",
    requestDigest: "d".repeat(64),
    rule: { index: 1 },
  });
});

test("a widened attribution this reader cannot vouch for is a named finding", () => {
  // `null` rather than `undefined` is the "this one is well-formed" sentinel:
  // a `RegExp | undefined` element type would let a mistyped case silently stop
  // asserting anything, which is the failure this file exists to prevent.
  const cases: readonly (readonly [unknown, RegExp | null])[] = [
    [{ policyDigest: POLICY, modelId: 7 }, /modelId is not a bounded string/],
    [{ policyDigest: POLICY, modelId: "" }, /modelId is not a bounded string/],
    [
      { policyDigest: POLICY, modelId: "model\nforged" },
      /modelId is not a bounded string/,
    ],
    [
      { policyDigest: POLICY, requestDigest: "d".repeat(63) },
      /requestDigest is not 64 lowercase hex characters/,
    ],
    [
      { policyDigest: POLICY, requestDigest: `sha256:${"d".repeat(64)}` },
      null,
    ],
  ];
  for (const [attribution, expected] of cases) {
    const reason = readLedgerReason({ attribution }, 2);
    if (expected === null) {
      assert.equal(reason.kind, "attributed");
      continue;
    }
    assert.equal(reason.kind, "malformed", JSON.stringify(attribution));
    assert.ok(reason.kind === "malformed", "a malformed finding must carry a detail");
    assert.match(reason.detail, expected);
  }
});

test("the writer names a model and a request only when it has both", () => {
  assert.deepEqual(
    buildAttribution(POLICY, { ruleIndex: 0, rationale: "r" }, {
      modelId: "vendor/model-1",
      requestDigest: "d".repeat(64),
    }),
    {
      policyDigest: POLICY,
      modelId: "vendor/model-1",
      requestDigest: "d".repeat(64),
      rule: { index: 0, rationale: "r" },
    },
  );
  assert.deepEqual(
    buildAttribution(POLICY, {}, { modelId: "vendor/model-1" }),
    { policyDigest: POLICY, modelId: "vendor/model-1" },
  );
  assert.deepEqual(
    buildAttribution(POLICY, { ruleIndex: 0 }, { requestDigest: undefined }),
    { policyDigest: POLICY, rule: { index: 0 } },
    "an absent request is not written as an empty one",
  );
});

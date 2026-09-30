import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  buildReversal,
  readLedgerReversal,
  reversalFinding,
} from "./reversal.ts";
import { devKeyProvider, sha256Hex } from "./sign.ts";
import { entryHash } from "./canonical.ts";
import { signingPreimage, type KeyProvider } from "./index.ts";
import { jsonlStore, type JsonlEntry } from "./store.ts";
import { readLedgerFeed } from "./feed.ts";
import { verifyChain } from "./verify.ts";

const workspace = "reversal-ws";

const body = (extra: Record<string, unknown> = {}) => ({
  workspace,
  at: "2026-01-01T00:00:00.000Z",
  tool: "postgres.row.delete",
  klass: "r2",
  decision: "execute:completed",
  argsDigest: "c".repeat(64),
  ...extra,
});

async function fixture(t: TestContext) {
  const dir = await mkdtemp(join(tmpdir(), "void-reversal-"));
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

const file = (dir: string): string => join(dir, `${workspace}.jsonl`);

const asFile = (entries: readonly JsonlEntry[]): string =>
  `${entries.map((entry) => `${JSON.stringify(entry)}\n`).join("")}`;

/**
 * The attack a reversal claim has to survive: every body is changed, every
 * hash is recomputed, every link is re-pointed and every entry is re-signed
 * with a real key. Nothing here is caught by a hash mismatch, so the only
 * thing left to catch a false reversal is the rule about what it may name.
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

test("a reversal that names an earlier record in the same chain verifies", async (t) => {
  const { dir, key, store } = await fixture(t);
  const forward = await store.append(body());
  await store.append(body({ decision: "execute:failed" }));
  const reversing = await store.append(
    body({
      tool: "void_workspace_undo",
      decision: "execute:reversal",
      reversal: buildReversal(forward.seq, forward.hash),
    }),
  );
  assert.equal(reversing.seq, 3);

  assert.deepEqual(await store.verify(workspace), { ok: true, checked: 3 });
  const chain = await verifyChain(await collect(store), {
    publicKey: (id) => key.publicKey(id),
  });
  assert.equal(chain.ok, true);
  assert.equal(chain.checked, 3);

  const page = await readLedgerFeed(file(dir), {
    publicKey: (id) => key.publicKey(id),
  });
  assert.deepEqual(page.records[2]?.reversal, { seq: 1, digest: forward.hash });
  assert.ok(!("reversal" in (page.records[0] ?? {})));
  assert.ok(!("reversal" in (page.records[1] ?? {})));
});

test("a reversal naming a sequence this chain does not hold fails the chain", async (t) => {
  const { store } = await fixture(t);
  await store.append(body());
  await store.append(body({ reversal: buildReversal(9, "d".repeat(64)) }));

  assert.equal(
    (await store.verify(workspace)).reason,
    "reversal: entry 2 reversal names seq 9, which this chain does not hold earlier than the record carrying it at seq 2",
  );
  const chain = await verifyChain(await collect(store));
  assert.equal(chain.ok, false);
  assert.match(chain.reason ?? "", /names seq 9, which this chain does not hold earlier/);
});

test("a reversal naming the right sequence with the wrong digest fails", async (t) => {
  const { store } = await fixture(t);
  const first = await store.append(body());
  await store.append(body({ reversal: buildReversal(first.seq, "e".repeat(64)) }));

  assert.equal(
    (await store.verify(workspace)).reason,
    `reversal: entry 2 reversal names seq 1 as ${"e".repeat(64).slice(0, 8)} but the chain holds ${first.hash.slice(0, 8)}`,
  );
});

test("a chain of forward records only, written before any reversal existed, still verifies", async (t) => {
  const { dir, key, store } = await fixture(t);
  await store.append(body());
  await store.append(body({ decision: "execute:failed" }));

  assert.deepEqual(await store.verify(workspace), { ok: true, checked: 2 });
  const page = await readLedgerFeed(file(dir), {
    publicKey: (id) => key.publicKey(id),
  });
  assert.equal(page.records.length, 2);
  assert.equal(readLedgerReversal({}, 1).kind, "none");
  assert.equal(readLedgerReversal(null, 1).kind, "none");
});

test("a malformed reversal is a named finding, not a crash", () => {
  const cases: readonly (readonly [unknown, RegExp])[] = [
    ["nope", /reversal is not an object/],
    [{ seq: 1 }, /digest is not 64 lowercase hex characters/],
    [{ seq: 0, digest: "a".repeat(64) }, /seq is not a whole number of at least one/],
    [{ seq: 1.5, digest: "a".repeat(64) }, /seq is not a whole number/],
    [{ seq: 1, digest: "A".repeat(64) }, /digest is not 64 lowercase hex/],
    [{ seq: 1, digest: "a".repeat(64), why: "because" }, /unknown key why/],
  ];
  for (const [reversal, expected] of cases) {
    const read = readLedgerReversal({ reversal }, 3);
    assert.equal(read.kind, "malformed", JSON.stringify(reversal));
    assert.match(read.kind === "malformed" ? read.detail : "", expected);
    assert.match(read.kind === "malformed" ? read.detail : "", /entry 3 /);
  }
});

test("a rewritten reversal fails even when the whole chain is re-chained and re-signed", async (t) => {
  const { dir, attacker, store } = await fixture(t);
  const first = await store.append(body());
  await store.append(body({ reversal: buildReversal(first.seq, first.hash) }));
  const forged = await rewriteChain(
    await collect(store),
    attacker,
    (entry) => ({
      ...entry,
      body: {
        ...(entry.body as Record<string, unknown>),
        reversal: buildReversal(3, "f".repeat(64)),
      },
    }),
  );
  const checked = await verifyChain(forged, {
    publicKey: (id) => attacker.publicKey(id),
  });
  assert.equal(checked.ok, false);
  assert.match(
    checked.reason ?? "",
    /reversal names seq 3, which this chain does not hold earlier than the record carrying it at seq 1/,
  );
  await writeFile(file(dir), asFile(forged));
  assert.equal((await store.verify(workspace)).ok, false);
});

test("the chain rule reads the chain, never the record that carries it", () => {
  const chain = new Map([[1, "a".repeat(64)]]);
  const hashOf = (seq: number): string | undefined => chain.get(seq);
  assert.equal(
    reversalFinding({ seq: 1, digest: "a".repeat(64) }, 2, hashOf),
    undefined,
  );
  // A claim that points at its own record and a claim that points past the
  // end of the chain are the same failure, and say so the same way.
  assert.equal(
    reversalFinding({ seq: 2, digest: "a".repeat(64) }, 2, hashOf),
    "reversal names seq 2, which this chain does not hold earlier than the record carrying it at seq 2",
  );
  assert.match(
    reversalFinding({ seq: 4, digest: "a".repeat(64) }, 2, () => undefined) ?? "",
    /this chain does not hold earlier than the record carrying it at seq 2/,
  );
});

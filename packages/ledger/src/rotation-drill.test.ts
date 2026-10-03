/**
 * S09 key rotation: the drill, and nothing beyond it.
 *
 * The write side can already produce a chain signed by two keys, because
 * `key_id` is inside the signed preimage. What did not exist was any way to
 * *read* such a chain: every surface resolves one verification key and refuses
 * the other key's entries. This file proves the write side and pins the
 * refusal, so the follow-up work that changes the trust decision cannot move
 * the boundary silently.
 *
 * It deliberately does not resolve the refusal. The trust set in the pin, the
 * rotation entry record and the re-signing decision are OPERATIONS.md's open
 * items, and each one changes a persisted artifact.
 */

import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { devKeyProvider, devKeyRing, rotateDevKey, sha256Hex } from "./sign.ts";
import { PINNED_KEY_ENV, resolveVerificationKey } from "./verify-key.ts";
import { entryHash } from "./canonical.ts";
import { signingPreimage, type LedgerStore } from "./index.ts";
import { jsonlStore, type JsonlEntry } from "./store.ts";
import { verifyChain } from "./verify.ts";

const workspace = "rotation-ws";

type Ledger = LedgerStore<unknown, JsonlEntry, JsonlEntry>;

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
  const dir = await mkdtemp(join(tmpdir(), "void-rotation-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return { dir, keyDir: join(dir, "keys"), ledgerDir: join(dir, "ledger") };
}

async function collect(store: Ledger): Promise<JsonlEntry[]> {
  const entries: JsonlEntry[] = [];
  for await (const entry of store.read(workspace)) entries.push(entry);
  return entries;
}

/**
 * Two entries under key A, a rotation, two more under key B: the chain a real
 * rotation leaves on disk. The ledger directory is shared, so B's entries chain
 * onto A's with no store change at all.
 */
async function rotatedChain(t: TestContext) {
  const { keyDir, ledgerDir } = await fixture(t);
  const a = await devKeyProvider({ dir: keyDir, env: {} });
  const aId = await a.currentKeyId();
  const before = jsonlStore(a, { dir: ledgerDir });
  await before.append(body());
  await before.append(body({ tool: "postgres.row.update" }));

  await rotateDevKey(keyDir);

  const b = await devKeyProvider({ dir: keyDir, env: {} });
  const bId = await b.currentKeyId();
  assert.notEqual(aId, bId, "rotation must install a different key");
  const after = jsonlStore(b, { dir: ledgerDir });
  await after.append(body({ tool: "postgres.row.insert" }));
  await after.append(body({ tool: "postgres.row.update" }));
  return { keyDir, ledgerDir, a, aId, bId, store: after };
}

test("a chain signed by two keys verifies through the ring", async (t) => {
  const { keyDir, store, aId, bId } = await rotatedChain(t);
  const entries = await collect(store);
  assert.deepEqual(entries.map((entry) => entry.key_id), [aId, aId, bId, bId]);

  const ring = await devKeyRing(keyDir);
  assert.equal(await ring.currentKeyId(), bId);
  const chain = await verifyChain(entries, { publicKey: (id) => ring.publicKey(id) });
  assert.equal(chain.ok, true, chain.reason);
  assert.equal(chain.checked, 4);
  assert.equal(await ring.publicKey("unknown"), null);
});

test("the same two key chain verifies through the store", async (t) => {
  const { keyDir, ledgerDir } = await rotatedChain(t);
  // The store asks its signer for a public key per entry, so the ring is the
  // store's signer here: the store itself needs no change for two keys.
  const ringStore = jsonlStore(await devKeyRing(keyDir), { dir: ledgerDir });
  assert.deepEqual(await ringStore.verify(workspace), { ok: true, checked: 4 });
});

test("the shipped trust decision still refuses the same chain", async (t) => {
  // This case passed before any of the code above existed, and that is its
  // whole job: it pins the exact boundary OPERATIONS.md describes, so the
  // follow-up cannot widen what a verifier trusts without failing here first.
  const { keyDir, store, bId } = await rotatedChain(t);
  const entries = await collect(store);
  // The pin an operator holds after the rotation: the new key, out of band.
  const ring = await devKeyRing(keyDir);
  const pinned = await ring.publicKey(bId);
  assert.ok(pinned instanceof Uint8Array);
  const key = await resolveVerificationKey({
    env: { [PINNED_KEY_ENV]: Buffer.from(pinned).toString("base64") },
  });
  assert.ok(key !== undefined);
  assert.equal(key.keyId, bId);
  const chain = await verifyChain(entries, { publicKey: key.publicKey });
  assert.equal(chain.ok, false);
  assert.match(chain.reason ?? "", /entry 1 has no public key for dev-/);
});

test("the ring checks a retired key id and refuses to sign for it", async (t) => {
  const { keyDir, a, aId } = await rotatedChain(t);
  const ring = await devKeyRing(keyDir);

  // A retired entry, signed while A was still the current key and carried
  // forward unchanged: the ring has to verify it from the retired public key
  // alone. Note what it cannot do: `rotateDevKey` does not keep the retired
  // private key, so the ring answers `publicKey(aId)` and refuses
  // `sign(_, aId)`. Re-signing an old entry is the follow-up decision, and it
  // is not one this drill makes.
  const entryBody = body({ tool: "postgres.row.delete" });
  const hash = await entryHash(entryBody, "0".repeat(64), sha256Hex);
  const signature = await a.sign(signingPreimage(a.alg, aId, hash), aId);
  const entry: JsonlEntry = {
    workspace,
    seq: 1,
    body: entryBody,
    prev_hash: "0".repeat(64),
    hash,
    key_id: aId,
    alg: a.alg,
    signature: `${a.alg}:${Buffer.from(signature).toString("base64")}`,
  };
  assert.ok((await ring.publicKey(aId)) instanceof Uint8Array);
  const chain = await verifyChain([entry], { publicKey: (id) => ring.publicKey(id) });
  assert.equal(chain.ok, true, chain.reason);
  assert.equal(chain.checked, 1);

  await assert.rejects(
    () => ring.sign(signingPreimage(ring.alg, aId, hash), aId),
    /holds no private key for/,
  );
  await assert.rejects(
    () => ring.sign(signingPreimage(ring.alg, "dev-unknown", hash), "dev-unknown"),
    /dev-unknown/,
  );
});
/**
 * The three ways a reversal claim can be false, checked as bytes on disk.
 *
 * `reversalFinding` takes a `hashOf` callback and a reader could pass anything
 * into it, so this asserts on what the two real verifiers do with a real file
 * rather than on the function in isolation:
 *
 *   1. a reversal as the first entry in a chain — there is nothing earlier to
 *      name, so the claim cannot be checked and must not be accepted;
 *   2. a reversal that names itself;
 *   3. a reversal that names a record later in the same file.
 *
 * A fourth case is the attack that matters most: a whole file rewritten and
 * re-signed by an attacker holding their own key, so every hash in the chain is
 * correct and the only thing left to catch a false reversal is the rule about
 * what it may name. If that case passed, the claim would be unfalsifiable.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { devKeyProvider, sha256Hex } from "./sign.ts";
import { entryHash, GENESIS_PREV } from "./canonical.ts";
import { signingPreimage, type KeyProvider } from "./index.ts";
import { jsonlStore, type JsonlEntry } from "./store.ts";
import { verifyChain } from "./verify.ts";
import { buildReversal } from "./reversal.ts";
import { readLedgerFeed } from "./feed.ts";
import { sanitizeWorkspace } from "./hardening.ts";

const workspace = "reversal-first-entry";

const body = (extra: Record<string, unknown> = {}) => ({
  workspace,
  at: "2026-01-01T00:00:00.000Z",
  tool: "postgres.row.delete",
  klass: "r2",
  decision: "execute:completed",
  argsDigest: "c".repeat(64),
  ...extra,
});

/** A chain assembled by hand, so a record can be written in any order. */
async function writeChain(dir: string, key: KeyProvider, bodies: readonly unknown[]) {
  let prev = GENESIS_PREV;
  const entries: JsonlEntry[] = [];
  const keyId = await key.currentKeyId();
  for (const [index, entryBody] of bodies.entries()) {
    const hash = await entryHash(entryBody, prev, sha256Hex);
    const signature = await key.sign(signingPreimage(key.alg, keyId, hash));
    entries.push({
      workspace,
      seq: index + 1,
      body: entryBody,
      prev_hash: prev,
      hash,
      key_id: keyId,
      alg: key.alg,
      signature: `${key.alg}:${Buffer.from(signature).toString("base64")}`,
    });
    prev = hash;
  }
  const store = jsonlStore(key, { dir: join(dir, "chain") });
  const directory = join(dir, "chain");
  const { writeFile, mkdir, chmod } = await import("node:fs/promises");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await writeFile(
    join(directory, `${sanitizeWorkspace(workspace)}.jsonl`),
    entries.map((entry) => `${JSON.stringify(entry)}\n`).join(""),
    { mode: 0o600 },
  );
  await chmod(join(directory, `${sanitizeWorkspace(workspace)}.jsonl`), 0o600);
  return { entries, store, directory };
}

/** Re-chain and re-sign every entry with a key the reader does not trust. */
async function rewriteAs(attacker: KeyProvider, entries: readonly JsonlEntry[]) {
  const keyId = await attacker.currentKeyId();
  let prev = GENESIS_PREV;
  const out: JsonlEntry[] = [];
  for (const entry of entries) {
    const hash = await entryHash(entry.body, prev, sha256Hex);
    const signature = await attacker.sign(signingPreimage(attacker.alg, keyId, hash));
    out.push({
      ...entry,
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

async function fixture(t: { after: (fn: () => unknown) => void }) {
  const dir = await mkdtemp(join(tmpdir(), "nomo-reversal-first-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const key = await devKeyProvider({ dir: join(dir, "keys"), env: {} });
  const attacker = await devKeyProvider({ dir: join(dir, "attacker"), env: {} });
  return { dir, key, attacker };
}

test("a reversal as the first entry in a chain fails verification", async (t) => {
  const { dir, key } = await fixture(t);
  // There is no earlier record, so any claim is uncheckable. Accepting it
  // would let a signed record assert the inversion of something the file does
  // not contain, and the chain would still be internally consistent.
  const fake = buildReversal(7, "d".repeat(64));
  const { entries, store } = await writeChain(dir, key, [
    body({ decision: "execute:reversal", reversal: fake }),
  ]);

  const verified = await store.verify(workspace);
  assert.equal(verified.ok, false);
  assert.match(verified.reason ?? "", /reversal names seq 7/);
  assert.match(verified.reason ?? "", /does not hold earlier than the record carrying it at seq 1/);

  const chain = await verifyChain(entries, { publicKey: (id) => key.publicKey(id) });
  assert.equal(chain.ok, false);
  assert.match(chain.reason ?? "", /reversal names seq 7/);
});

test("a reversal that names itself fails verification", async (t) => {
  const { dir, key } = await fixture(t);
  const first = body();
  // A self-referential claim needs the digest of a record that does not exist
  // until this one is written, so the chain cannot satisfy it either way.
  const self = buildReversal(2, "e".repeat(64));
  const { entries, store } = await writeChain(dir, key, [
    first,
    body({ decision: "execute:reversal", reversal: self }),
  ]);

  const verified = await store.verify(workspace);
  assert.equal(verified.ok, false);
  assert.match(verified.reason ?? "", /reversal names seq 2/);

  // And the first entry's own digest is not what the reversal claims, so even a
  // correct seq with a wrong digest is caught.
  const wrong = buildReversal(1, "0".repeat(64));
  const second = await writeChain(dir, key, [
    first,
    body({ decision: "execute:reversal", reversal: wrong }),
  ]);
  const secondVerified = await second.store.verify(workspace);
  assert.equal(secondVerified.ok, false);
  assert.match(secondVerified.reason ?? "", /but the chain holds/);
  assert.equal(entries.length, 2);
});

test("a reversal that names a later record fails verification", async (t) => {
  const { dir, key } = await fixture(t);
  const forward = buildReversal(3, "f".repeat(64));
  const { entries, store } = await writeChain(dir, key, [
    body(),
    body({ decision: "execute:reversal", reversal: forward }),
    body(),
  ]);

  // Seq 3 is in the file, and the chain verifies every hash, so the only thing
  // that can catch this is the rule that a reversal names an *earlier* record.
  const verified = await store.verify(workspace);
  assert.equal(verified.ok, false);
  assert.match(verified.reason ?? "", /reversal names seq 3/);
  assert.match(verified.reason ?? "", /at seq 2/);

  const chain = await verifyChain(entries, { publicKey: (id) => key.publicKey(id) });
  assert.equal(chain.ok, false);
});

test("a whole file re-signed by an attacker still cannot assert a false reversal", async (t) => {
  const { dir, key, attacker } = await fixture(t);
  // Every hash is recomputed and every signature is valid for the attacker's
  // key, so a client that trusts the attacker's key sees a perfect chain. The
  // reversal is the one claim that has no witness, and it has to fail on the
  // rule rather than on any hash.
  const { entries } = await writeChain(dir, key, [
    body(),
    body({ decision: "execute:reversal", reversal: buildReversal(9, "a".repeat(64)) }),
  ]);
  const rewritten = await rewriteAs(attacker, entries);

  const chain = await verifyChain(rewritten, { publicKey: (id) => attacker.publicKey(id) });
  assert.equal(chain.ok, false, "a re-chained and re-signed false reversal verified");
  assert.match(chain.reason ?? "", /reversal names seq 9/);

  // And the feed refuses it, so a consumer cannot read a record the verifier
  // rejected.
  const file = join(dir, "chain", `${sanitizeWorkspace(workspace)}.jsonl`);
  const { writeFile } = await import("node:fs/promises");
  await writeFile(file, rewritten.map((entry) => `${JSON.stringify(entry)}\n`).join(""));
  await assert.rejects(
    readLedgerFeed(file, { publicKey: (id) => attacker.publicKey(id) }),
    /ledger chain invalid.*reversal/s,
  );
});

test("a reversal that names a real earlier record survives a full rewrite", async (t) => {
  // The other half of the same property: the rule has to reject false claims
  // without rejecting true ones. A rewrite that keeps the reversal honest has
  // to verify, or the check is a blanket refusal rather than a rule.
  const { dir, key, attacker } = await fixture(t);
  const { entries } = await writeChain(dir, key, [
    body(),
    body({ decision: "execute:completed" }),
  ]);
  const honest = buildReversal(1, entries[0]!.hash);
  const withReversal = await writeChain(dir, key, [
    entries[0]!.body,
    entries[1]!.body,
    body({ decision: "execute:reversal", reversal: honest }),
  ]);
  const rewritten = await rewriteAs(attacker, withReversal.entries);

  const chain = await verifyChain(rewritten, { publicKey: (id) => attacker.publicKey(id) });
  assert.equal(chain.ok, true, `an honest reversal failed after a rewrite: ${chain.reason ?? ""}`);
  assert.equal(chain.checked, 3);
});

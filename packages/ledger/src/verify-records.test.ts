import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { devKeyProvider } from "./sign.ts";
import { jsonlStore, type JsonlEntry } from "./store.ts";
import { verifyChain, verifyChainRecords } from "./verify.ts";

const workspace = "records-ws";

/**
 * Four signed records, read back from a real store.
 *
 * The store is the fixture rather than hand written entries because the
 * question here is what the verifier says about records a signer actually
 * produced. A hand built entry could pass the per record path while being
 * something the store would never write.
 */
async function seededEntries(count = 4): Promise<{
  readonly entries: readonly JsonlEntry[];
  readonly keyId: string;
  readonly spki: Uint8Array;
}> {
  const dir = await mkdtemp(join(tmpdir(), "nomo-verify-records-"));
  const key = await devKeyProvider({ dir: join(dir, "keys"), env: {} });
  const store = jsonlStore(key, { dir });
  for (let index = 1; index <= count; index += 1) {
    await store.append({
      workspace,
      at: `2026-09-0${index}T00:00:00.000Z`,
      tool: `postgres.row.update.${index}`,
      klass: "r1",
      decision: "allow:resolved",
      argsDigest: `${index}`.repeat(64),
    });
  }
  const entries: JsonlEntry[] = [];
  for await (const entry of store.read(workspace)) entries.push(entry);
  const keyId = await key.currentKeyId();
  const spki = await key.publicKey(keyId);
  assert.ok(spki !== null);
  return { entries, keyId, spki };
}

/** A lookup that answers only for the key the fixture signed with. */
function knownKeyOnly(keyId: string, spki: Uint8Array) {
  return (asked: string): Uint8Array | null =>
    asked === keyId ? spki : null;
}

function bodyOf(entry: JsonlEntry): Record<string, unknown> {
  assert.ok(typeof entry.body === "object" && entry.body !== null);
  return entry.body as Record<string, unknown>;
}

describe("verifyChainRecords", () => {
  test("one corrupt record does not hide the records around it", async () => {
    const { entries, keyId, spki } = await seededEntries();
    const [, second, , fourth] = entries as [
      JsonlEntry,
      JsonlEntry,
      JsonlEntry,
      JsonlEntry,
    ];
    // Entry 2's body no longer hashes to the digest the file stores for it.
    // Entry 3 and 4 keep their own links and digests, so they must still
    // verify: a reader that reported the tail as unverified would be hiding
    // three good records behind one bad one.
    const mixed: JsonlEntry[] = [
      entries[0]!,
      { ...second, body: { ...bodyOf(second), decision: "allow:tampered" } },
      entries[2]!,
      // Entry 4 was signed under a key this verifier does not hold, which is
      // unverified rather than corrupt: nothing about it is proven wrong.
      { ...fourth, key_id: "rotated-key-absent-here" },
    ];

    const result = await verifyChainRecords(mixed, {
      publicKey: knownKeyOnly(keyId, spki),
    });

    assert.equal(result.ok, false);
    assert.equal(result.checked, 4);
    assert.deepEqual(
      result.records.map((record) => record.status),
      ["verified", "corrupt", "verified", "unverified"],
    );
    assert.deepEqual(
      result.records.map((record) => record.id),
      [1, 2, 3, 4].map((seq) => `${workspace}:${seq}`),
    );
    assert.match(
      result.records[1]!.reason!,
      /does not hash to its stored digest/,
    );
    assert.match(result.records[3]!.reason!, /has no public key/);
    assert.equal(result.records[0]!.reason, undefined);
    assert.equal(result.records[2]!.reason, undefined);
    // The head is the last stored digest, which is what a caller cites.
    assert.equal(result.head, entries[3]!.hash);

    // The strict read is unchanged and still stops at the first finding, so a
    // caller that must not act on unverified evidence keeps that guarantee.
    const strict = await verifyChain(mixed, {
      publicKey: knownKeyOnly(keyId, spki),
    });
    assert.equal(strict.ok, false);
    assert.equal(strict.checked, 2);
    assert.match(strict.reason!, /entry 2/);
  });

  test("a broken link is one corrupt record, not a corrupt tail", async () => {
    const { entries, keyId, spki } = await seededEntries();
    const third = entries[2]!;
    const broken: JsonlEntry[] = [
      entries[0]!,
      entries[1]!,
      { ...third, prev_hash: "f".repeat(64) },
      entries[3]!,
    ];

    const result = await verifyChainRecords(broken, {
      publicKey: knownKeyOnly(keyId, spki),
    });

    assert.deepEqual(
      result.records.map((record) => record.status),
      ["verified", "verified", "corrupt", "verified"],
    );
    assert.match(result.records[2]!.reason!, /^link: entry 3/);
  });

  test("a body that is not an object is named and the walk continues", async () => {
    const { entries, keyId, spki } = await seededEntries(3);
    const second = entries[1]!;
    const mixed: JsonlEntry[] = [
      entries[0]!,
      { ...second, body: "not an object" },
      entries[2]!,
    ];

    const result = await verifyChainRecords(mixed, {
      publicKey: knownKeyOnly(keyId, spki),
    });

    assert.equal(result.records.length, 3);
    assert.equal(result.records[1]!.status, "corrupt");
    assert.match(result.records[1]!.reason!, /does not match its signed body/);
    assert.equal(result.records[2]!.status, "verified");
  });

  test("a digest that cannot be hashed against does not end the walk", async () => {
    const { entries, keyId, spki } = await seededEntries(3);
    const unusable = "z".repeat(64);
    // Record 1 stores a digest that is not hex at all. Record 2 points at it,
    // which is the one shape that reaches the hasher with an invalid
    // predecessor digest: the link check passes because both sides agree.
    // The walk must name both records and still reach record 3.
    const mixed: JsonlEntry[] = [
      { ...entries[0]!, hash: unusable },
      { ...entries[1]!, prev_hash: unusable },
      entries[2]!,
    ];

    const result = await verifyChainRecords(mixed, {
      publicKey: knownKeyOnly(keyId, spki),
    });

    assert.equal(result.records.length, 3);
    assert.equal(result.records[0]!.status, "corrupt");
    assert.equal(result.records[1]!.status, "corrupt");
    assert.match(result.records[1]!.reason!, /could not be hashed/);
    assert.equal(result.records[2]!.status, "verified");
  });

  test("without a public key every record is unverified, never verified", async () => {
    const { entries } = await seededEntries(2);

    const result = await verifyChainRecords(entries);

    assert.equal(result.ok, false);
    assert.deepEqual(
      result.records.map((record) => record.status),
      ["unverified", "unverified"],
    );
    for (const record of result.records)
      assert.match(record.reason!, /no public key was supplied/);
  });

  test("an empty chain is ok and holds no records", async () => {
    const result = await verifyChainRecords([]);

    assert.equal(result.ok, true);
    assert.equal(result.checked, 0);
    assert.deepEqual(result.records, []);
    assert.equal(result.head, "0".repeat(64));
  });
});

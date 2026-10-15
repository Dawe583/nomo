import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdtemp, mkdir, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { devKeyProvider } from "./sign.ts";
import { jsonlStore } from "./store.ts";
import { attestLedger, merkleDigest } from "./attest.ts";
import { readLedgerEntries, verifyChain } from "./verify.ts";

test("unreadable ledger is not verified as an empty chain", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "nomo-security-ledger-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const key = await devKeyProvider({ dir: join(dir, "keys"), env: {} });
  const store = jsonlStore(key, { dir });
  await mkdir(join(dir, "blocked.jsonl"));
  await assert.rejects(store.verify("blocked"));
  await assert.rejects(store.head("blocked"));
});

test("a missing workspace can still start an empty ledger", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "nomo-security-ledger-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const key = await devKeyProvider({ dir: join(dir, "keys"), env: {} });
  const store = jsonlStore(key, { dir });
  assert.deepEqual(await store.verify("new"), { ok: true, checked: 0 });
  await store.append({ workspace: "new" });
  assert.deepEqual(await store.verify("new"), { ok: true, checked: 1 });
});

for (const umask of [0o022, 0o077] as const) {
  test(`a ledger file is owner-only under umask ${umask.toString(8)}`, async (t) => {
    if (process.platform === "win32") return;
    const dir = await mkdtemp(join(tmpdir(), "nomo-ledger-mode-"));
    t.after(() => rm(dir, { recursive: true, force: true }));
    const previous = process.umask(umask);
    t.after(() => {
      process.umask(previous);
    });
    const key = await devKeyProvider({ dir: join(dir, "keys"), env: {} });
    await jsonlStore(key, { dir }).append({ workspace: "mode" });
    const mode = (await stat(join(dir, "mode.jsonl"))).mode & 0o777;
    assert.equal(mode, 0o600);
    assert.equal((await stat(dir)).mode & 0o777, 0o700);
  });
}

test("a ledger file left broad by an earlier build is refused, not repaired", async (t) => {
  if (process.platform === "win32") return;
  const dir = await mkdtemp(join(tmpdir(), "nomo-ledger-broad-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const key = await devKeyProvider({ dir: join(dir, "keys"), env: {} });
  const file = join(dir, "broad.jsonl");
  await writeFile(file, "");
  await chmod(file, 0o644);
  // Repairing the mode would hide the exposure instead of reporting it: the
  // bytes were world-readable before this call, and an operator who never sees
  // a refusal has no way to learn that. The path to a clean ledger is to remove
  // or chmod it deliberately.
  await assert.rejects(
    () => jsonlStore(key, { dir }).append({ workspace: "broad" }),
    /permissions 0600/,
  );
  assert.equal((await stat(file)).mode & 0o777, 0o644);
});

test("unsigned workspace relabeling cannot change signed ledger ownership", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "nomo-security-ledger-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const key = await devKeyProvider({ dir: join(dir, "keys"), env: {} });
  const store = jsonlStore(key, { dir });
  const entry = await store.append({ workspace: "source" });
  const relabeled = { ...entry, workspace: "target" };
  const verified = await verifyChain([relabeled], { publicKey: (id) => key.publicKey(id) });
  assert.equal(verified.ok, false);
  await writeFile(join(dir, "target.jsonl"), `${JSON.stringify(relabeled)}\n`);
  await chmod(join(dir, "target.jsonl"), 0o600);
  assert.equal((await store.verify("target")).ok, false);
  await assert.rejects(attestLedger(dir, "target", key));
});

test("copying a valid ledger into another workspace cannot mint an attestation", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "nomo-security-ledger-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const key = await devKeyProvider({ dir: join(dir, "keys"), env: {} });
  const store = jsonlStore(key, { dir });
  const entry = await store.append({ workspace: "source" });
  await writeFile(join(dir, "target.jsonl"), `${JSON.stringify(entry)}\n`);
  await chmod(join(dir, "target.jsonl"), 0o600);
  assert.equal((await store.verify("target")).ok, false);
  await assert.rejects(attestLedger(dir, "target", key));
});

test("merkle digest retains entry order", async () => {
  const a = "a".repeat(64);
  const b = "b".repeat(64);
  assert.notEqual(await merkleDigest([a, b]), await merkleDigest([b, a]));
});

test("an oversized ledger line is refused instead of loading whole file", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "nomo-security-ledger-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, "big.jsonl");
  await writeFile(file, `{"workspace":"big","seq":1,"body":"${"x".repeat(3 * 1024 * 1024)}"}\n`);
  await assert.rejects(
    readLedgerEntries(file, { maxBytes: 1024 * 1024 }),
    /exceeds the 1048576 byte read limit/,
  );
});

test("a ledger with too many entries stops reading at the entry limit", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "nomo-security-ledger-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, "many.jsonl");
  const entry = JSON.stringify({
    workspace: "many",
    seq: 1,
    body: { workspace: "many" },
    prev_hash: "0".repeat(64),
    hash: "1".repeat(64),
    key_id: "k",
    alg: "ed25519",
    signature: "ed25519:AA",
  });
  await writeFile(file, `${`${entry}\n`.repeat(11)}`);
  await assert.rejects(
    readLedgerEntries(file, { maxEntries: 10 }),
    /exceeds the 10 entry read limit/,
  );
});

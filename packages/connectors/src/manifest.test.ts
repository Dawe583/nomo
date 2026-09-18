import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, open, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { findEntry, collectManifestGarbage, manifestReader, manifestWriter, resolveRecoveryReadiness, type SnapshotManifestEntry } from "./manifest.ts";
import { LocalSnapshotStore } from "./snapshot/local.ts";
import { sha256Digest } from "./snapshot/store.ts";

const reference = {
  namespace: "workspace-a",
  digest: "sha256:" + "b".repeat(64) as `sha256:${string}`,
  uri: "file:///snapshots/workspace-a/update.json",
};

const first: SnapshotManifestEntry = {
  digest: "sha256:" + "a".repeat(64),
  reference,
  tool: "postgres.row.update",
};

const second: SnapshotManifestEntry = {
  digest: "sha256:" + "c".repeat(64),
  reference: { ...reference, uri: "file:///snapshots/workspace-a/delete.json" },
  tool: "s3.object_delete",
};

describe("manifest", () => {
  test("failed flush preserves the old manifest, cleans up and permits retry", async (t) => {
    const dir = await tempDir();
    await manifestWriter(dir).write(first);
    const probe = await open(join(dir, "manifest.jsonl"), "r");
    const prototype = Object.getPrototypeOf(probe);
    await probe.close();
    const fault = t.mock.method(prototype, "sync", async () => { throw new Error("injected flush failure"); });
    try {
      await assert.rejects(manifestWriter(dir).write(second), /injected flush failure/);
      assert.deepEqual(await manifestReader(dir), [first]);
      assert.deepEqual(await readdir(dir), ["manifest.jsonl"]);
    } finally { fault.mock.restore(); }
    await manifestWriter(dir).write(second);
    assert.deepEqual(await manifestReader(dir), [first, second]);
  });

  test("concurrent writers retain every entry and competing locks refuse writes", async () => {
    const dir = await tempDir();
    const entries = Array.from({ length: 40 }, (_, i) => ({ ...first, digest: `digest-${i}` }));
    await Promise.all(entries.map((entry) => manifestWriter(dir).write(entry)));
    assert.deepEqual(await manifestReader(dir), entries);
    await writeFile(join(dir, "manifest.jsonl.lock"), "competing writer");
    await assert.rejects(manifestWriter(dir).write(second), { code: "EEXIST" });
    assert.deepEqual(await manifestReader(dir), entries);
  });

  test("write and read round trip manifest entries", async () => {
    const dir = await tempDir();
    await manifestWriter(dir).write(first);
    await manifestWriter(dir).write(second);

    assert.deepEqual(await manifestReader(dir), [first, second]);
    assert.equal(await readFile(join(dir, "manifest.jsonl"), "utf8"), `${JSON.stringify(first)}\n${JSON.stringify(second)}\n`);
  });

  test("writes through a temporary file and leaves only manifest.jsonl after rename", async () => {
    const dir = await tempDir();
    await manifestWriter(dir).write(first);

    assert.deepEqual(await readdir(dir), ["manifest.jsonl"]);
    assert.deepEqual(await manifestReader(dir), [first]);
  });

  test("findEntry matches digest and tool", async () => {
    const dir = await tempDir();
    await manifestWriter(dir).write(first);
    await manifestWriter(dir).write(second);

    assert.deepEqual(await findEntry(dir, second.digest, second.tool), second);
    assert.equal(await findEntry(dir, second.digest, first.tool), null);
  });

  test("missing manifest reads as an empty list", async () => {
    const dir = await tempDir();

    assert.deepEqual(await manifestReader(dir), []);
  });

  test("pinned entries round trip format version, key id, and expiry", async () => {
    const dir = await tempDir();
    const entry: SnapshotManifestEntry = {
      ...first,
      operationId: "op-1",
      recoveryJobId: "job-1",
      pinned: true,
      expiresAt: new Date("2030-01-01T00:00:00.000Z").toISOString(),
      formatVersion: 1,
      keyId: "k1",
    };
    await manifestWriter(dir).write(entry);
    assert.deepEqual(await manifestReader(dir), [entry]);
    assert.deepEqual(await findEntry(dir, entry.digest, entry.tool), entry);
  });

  test("resolveRecoveryReadiness returns available only for verified bytes", async () => {
    const dir = await tempDir();
    const store = LocalSnapshotStore(join(dir, "snapshots"));
    const bytes = new TextEncoder().encode("before-image");
    const stored = await store.put("ws", bytes);
    const entry: SnapshotManifestEntry = { digest: stored.digest, reference: stored.reference, tool: "postgres.row.update", operationId: "op-1" };
    await manifestWriter(dir).write(entry);

    const ok = await resolveRecoveryReadiness(dir, store, entry.digest, entry.tool);
    assert.equal(ok.status, "available");

    const missing = await resolveRecoveryReadiness(dir, store, "sha256:" + "0".repeat(64), entry.tool);
    assert.equal(missing.status, "unavailable");
  });

  test("resolveRecoveryReadiness reports unavailable on expiry, corruption, and loss", async () => {
    const dir = await tempDir();
    const store = LocalSnapshotStore(join(dir, "snapshots"));
    const expiredBytes = new TextEncoder().encode("gone");
    const expired = await store.put("ws", expiredBytes, {}, { expiresAt: new Date("2020-01-01T00:00:00.000Z") });
    const expiredEntry: SnapshotManifestEntry = { digest: expired.digest, reference: expired.reference, tool: "postgres.row.update" };
    await manifestWriter(dir).write(expiredEntry);
    const expiredReadiness = await resolveRecoveryReadiness(dir, store, expiredEntry.digest, expiredEntry.tool);
    assert.equal(expiredReadiness.status, "unavailable");
    assert.match(expiredReadiness.status === "unavailable" ? expiredReadiness.reason : "", /expired/);

    const live = await store.put("ws", new TextEncoder().encode("live"));
    const liveEntry: SnapshotManifestEntry = { digest: live.digest, reference: live.reference, tool: "postgres.row.update" };
    await manifestWriter(dir).write(liveEntry);
    await writeFile(join(dir, "snapshots", encodeURIComponent("ws"), live.digest.slice("sha256:".length)), "forged");
    const forged = await resolveRecoveryReadiness(dir, store, liveEntry.digest, liveEntry.tool);
    assert.equal(forged.status, "unavailable");
    assert.match(forged.status === "unavailable" ? forged.reason : "", /digest mismatch|unavailable/);
  });

  test("GC during Undo keeps pinned snapshots and reports the rest as unavailable", async () => {
    const dir = await tempDir();
    const store = LocalSnapshotStore(join(dir, "snapshots"));
    const pinnedBytes = new TextEncoder().encode("undo-me");
    const pinned = await store.put("ws", pinnedBytes, {}, { pin: { ownerId: "job-1", kind: "recovery" } });
    const pinnedEntry: SnapshotManifestEntry = {
      digest: pinned.digest,
      reference: pinned.reference,
      tool: "postgres.row.update",
      recoveryJobId: "job-1",
      pinned: true,
    };
    await manifestWriter(dir).write(pinnedEntry);

    const gc = await store.collectGarbage?.("ws", { cutoff: new Date("2030-01-01T00:00:00.000Z") });
    assert.equal(gc?.skippedPinned, 1);
    const readiness = await resolveRecoveryReadiness(dir, store, pinnedEntry.digest, pinnedEntry.tool);
    assert.equal(readiness.status, "available");

    const report = await collectManifestGarbage(dir, store);
    assert.equal(report.skippedPinned, 1);
    assert.equal(report.retained, 0);
  });

  test("key binding mismatch and lost key stay unavailable", async () => {
    const dir = await tempDir();
    const writer = LocalSnapshotStore(join(dir, "snapshots"), { availableKeyIds: ["k1"] });
    const stored = await writer.put("ws", new TextEncoder().encode("enc"), {}, { keyId: "k1" });
    await manifestWriter(dir).write({ digest: stored.digest, reference: stored.reference, tool: "s3.object_delete", keyId: "k1" });
    const rotated = LocalSnapshotStore(join(dir, "snapshots"), { availableKeyIds: ["k2"] });
    const lost = await resolveRecoveryReadiness(dir, rotated, stored.digest, "s3.object_delete");
    assert.equal(lost.status, "unavailable");
    assert.match(lost.status === "unavailable" ? lost.reason : "", /key|unavailable/);
    void sha256Digest(new TextEncoder().encode("touch-import"));
  });
});

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "void-manifest-"));
  test.after(async () => {
    await rm(dir, { recursive: true, force: true });
  });
  return dir;
}

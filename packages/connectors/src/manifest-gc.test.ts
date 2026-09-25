import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, unlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  collectManifestGarbage,
  manifestReader,
  manifestWriter,
  resolveRecoveryReadiness,
  type SnapshotManifestEntry,
} from "./manifest.ts";
import { LocalSnapshotStore } from "./snapshot/local.ts";
import type { SnapshotStore } from "./snapshot/store.ts";

/**
 * Covers the paths manifest.test.ts does not: that a proven collectable artifact
 * is actually collected, and that every unproven one survives. A garbage
 * collector that only ever refuses passes a refusal suite and ships a disk that
 * fills up.
 */

const encoder = new TextEncoder();
const tool = "postgres.row.update";

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "void-garbage-"));
  test.after(async () => {
    await rm(dir, { recursive: true, force: true });
  });
  return dir;
}

async function capture(
  dir: string,
  bytes: string,
  options: Parameters<ReturnType<typeof LocalSnapshotStore>["put"]>[3] = {},
  declared: Omit<SnapshotManifestEntry, "digest" | "reference"> = { tool },
): Promise<SnapshotManifestEntry> {
  const store = LocalSnapshotStore(join(dir, "snapshots"));
  const stored = await store.put("ws", encoder.encode(bytes), {}, options);
  const entry: SnapshotManifestEntry = {
    digest: stored.digest,
    reference: stored.reference,
    ...declared,
  };
  await manifestWriter(dir).write(entry);
  return entry;
}

function artifactPath(dir: string, entry: SnapshotManifestEntry): string {
  return join(
    dir,
    "snapshots",
    encodeURIComponent(entry.reference.namespace),
    entry.reference.digest.slice("sha256:".length),
  );
}

describe("manifest garbage collection", () => {
  test("collects an expired unpinned artifact and drops its index entry", async () => {
    const dir = await tempDir();
    const entry = await capture(dir, "expired", {
      expiresAt: new Date("2020-01-01T00:00:00.000Z"),
    });
    const store = LocalSnapshotStore(join(dir, "snapshots"));

    const report = await collectManifestGarbage(dir, store);

    assert.equal(report.deleted, 1);
    assert.equal(report.retained, 0);
    assert.equal(report.skippedPinned, 0);
    assert.equal(report.errors.length, 0);
    assert.deepEqual(await manifestReader(dir), []);
    const readiness = await resolveRecoveryReadiness(
      dir,
      store,
      entry.digest,
      tool,
    );
    assert.equal(readiness.status, "unavailable");
  });

  test("collects an undeclared artifact only once it is older than retention", async () => {
    const dir = await tempDir();
    const entry = await capture(dir, "aged");
    const store = LocalSnapshotStore(join(dir, "snapshots"));

    const fresh = await collectManifestGarbage(dir, store, {
      retentionMs: 7 * 24 * 60 * 60 * 1000,
    });
    assert.equal(fresh.deleted, 0);
    assert.equal(fresh.retained, 1);
    assert.equal(
      (await resolveRecoveryReadiness(dir, store, entry.digest, tool)).status,
      "available",
    );

    const old = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000);
    await utimes(artifactPath(dir, entry), old, old);
    const aged = await collectManifestGarbage(dir, store, {
      retentionMs: 7 * 24 * 60 * 60 * 1000,
    });
    assert.equal(aged.deleted, 1);
    assert.equal(
      (await resolveRecoveryReadiness(dir, store, entry.digest, tool)).status,
      "unavailable",
    );
  });

  test("retains an unexpired, a pinned, and a still referenced artifact", async () => {
    const dir = await tempDir();
    const live = await capture(dir, "live", {
      expiresAt: new Date("2999-01-01T00:00:00.000Z"),
    });
    const pinned = await capture(dir, "pinned", {
      pin: { ownerId: "job-1", kind: "recovery" },
    });
    const running = await capture(
      dir,
      "running",
      { expiresAt: new Date("2020-01-01T00:00:00.000Z") },
      { tool, operationId: "op-1" },
    );
    const store = LocalSnapshotStore(join(dir, "snapshots"));

    const report = await collectManifestGarbage(dir, store);

    assert.equal(report.deleted, 0);
    assert.equal(report.retained, 1);
    assert.equal(report.skippedPinned, 1);
    assert.equal(report.skippedActiveJob, 1);
    assert.deepEqual(
      (await manifestReader(dir)).map((entry) => entry.digest),
      [live.digest, pinned.digest, running.digest],
    );
    for (const entry of [live, pinned]) {
      assert.equal(
        (await resolveRecoveryReadiness(dir, store, entry.digest, tool)).status,
        "available",
      );
    }
    // Retained for the job that still references it, yet past its own deadline,
    // so it is honestly not ready. Retention and readiness are separate verdicts.
    const held = await resolveRecoveryReadiness(
      dir,
      store,
      running.digest,
      tool,
    );
    assert.equal(held.status, "unavailable");
    assert.match(held.status === "unavailable" ? held.reason : "", /expired/);
    assert.equal(
      new TextDecoder().decode(await store.get(running.reference)),
      "running",
    );
  });

  test("collects a referenced artifact only once the caller proves it terminal", async () => {
    const dir = await tempDir();
    await capture(
      dir,
      "done",
      { expiresAt: new Date("2020-01-01T00:00:00.000Z") },
      { tool, operationId: "op-1", recoveryJobId: "job-1" },
    );
    const store = LocalSnapshotStore(join(dir, "snapshots"));

    const held = await collectManifestGarbage(dir, store);
    assert.equal(held.deleted, 0);
    assert.equal(held.skippedActiveJob, 1);

    const released = await collectManifestGarbage(dir, store, {
      terminalOperationIds: new Set(["op-1"]),
      terminalJobIds: new Set(["job-1"]),
    });
    assert.equal(released.deleted, 1);
    assert.deepEqual(await manifestReader(dir), []);
  });

  test("retains an artifact whose durable record is gone", async () => {
    const dir = await tempDir();
    const store = LocalSnapshotStore(join(dir, "snapshots"));
    const entry = await store.put(
      "ws",
      encoder.encode("unrecorded"),
      {},
      {
        expiresAt: new Date("2020-01-01T00:00:00.000Z"),
      },
    );
    await manifestWriter(dir).write({
      digest: entry.digest,
      reference: entry.reference,
      tool,
    });
    // Dropping the journal models a capture taken before this record existed.
    // Its state is unknown, so nothing may be collected on the strength of a
    // field that is not there, while the bytes themselves are still evidence.
    await unlink(
      join(dir, "snapshots", encodeURIComponent("ws"), "artifacts.jsonl"),
    );

    const report = await collectManifestGarbage(dir, store);

    assert.equal(report.deleted, 0);
    assert.equal(report.skippedUnreadable, 1);
    assert.equal((await manifestReader(dir)).length, 1);
    assert.equal(
      (await resolveRecoveryReadiness(dir, store, entry.digest, tool)).status,
      "available",
    );
  });

  test("retains and refuses an artifact with two conflicting key bindings", async () => {
    const dir = await tempDir();
    const store = LocalSnapshotStore(join(dir, "snapshots"), {
      availableKeyIds: ["k1", "k2"],
    });
    const expired = new Date("2020-01-01T00:00:00.000Z");
    const stored = await store.put(
      "ws",
      encoder.encode("conflicted"),
      {},
      { keyId: "k1", expiresAt: expired },
    );
    // The same bytes recorded under two different keys cannot be decrypted by
    // either one alone, so the record must not resolve to a readable artifact.
    await store.put("ws", encoder.encode("conflicted"), {}, { keyId: "k2" });
    await manifestWriter(dir).write({
      digest: stored.digest,
      reference: stored.reference,
      tool,
    });

    const report = await collectManifestGarbage(dir, store);
    const readiness = await resolveRecoveryReadiness(
      dir,
      store,
      stored.digest,
      tool,
    );

    assert.equal(report.deleted, 0);
    assert.equal(report.skippedUnreadable, 1);
    assert.equal((await manifestReader(dir)).length, 1);
    assert.equal(readiness.status, "unavailable");
    assert.match(
      readiness.status === "unavailable" ? readiness.reason : "",
      /not readable/,
    );
  });

  test("a rotated key keeps its artifact instead of collecting unreadable evidence", async () => {
    const dir = await tempDir();
    const writer = LocalSnapshotStore(join(dir, "snapshots"), {
      availableKeyIds: ["k1"],
    });
    const stored = await writer.put(
      "ws",
      encoder.encode("secret"),
      {},
      { keyId: "k1", expiresAt: new Date("2020-01-01T00:00:00.000Z") },
    );
    const entry: SnapshotManifestEntry = {
      digest: stored.digest,
      reference: stored.reference,
      tool,
      keyId: "k1",
    };
    await manifestWriter(dir).write(entry);
    const rotated = LocalSnapshotStore(join(dir, "snapshots"), {
      availableKeyIds: ["k2"],
    });

    const report = await collectManifestGarbage(dir, rotated);

    assert.equal(report.deleted, 0);
    assert.equal(report.skippedUnreadable, 1);
    await assert.rejects(
      () => rotated.get(entry.reference),
      /key k1 is not available/,
    );
    const readiness = await resolveRecoveryReadiness(
      dir,
      rotated,
      entry.digest,
      tool,
    );
    assert.equal(readiness.status, "unavailable");
    assert.match(
      readiness.status === "unavailable" ? readiness.reason : "",
      /key k1/,
    );
  });

  test("a store without artifact state collects nothing rather than orphaning its index", async () => {
    const dir = await tempDir();
    const entry = await capture(dir, "bare", {
      expiresAt: new Date("2020-01-01T00:00:00.000Z"),
    });
    const backing = LocalSnapshotStore(join(dir, "snapshots"));
    const bare: SnapshotStore = {
      put: (namespace, bytes) => backing.put(namespace, bytes),
      get: (reference) => backing.get(reference),
      retention: (namespace) => backing.retention(namespace),
    };

    const report = await collectManifestGarbage(dir, bare);

    assert.equal(report.deleted, 0);
    assert.equal(report.skippedUnreadable, 1);
    assert.deepEqual(
      (await manifestReader(dir)).map((kept) => kept.digest),
      [entry.digest],
    );
  });

  test("an unknown capture format is neither claimed ready nor collected", async () => {
    const dir = await tempDir();
    const entry = await capture(dir, "future", {}, { tool, formatVersion: 99 });
    const store = LocalSnapshotStore(join(dir, "snapshots"));

    const readiness = await resolveRecoveryReadiness(
      dir,
      store,
      entry.digest,
      tool,
    );
    assert.equal(readiness.status, "unavailable");
    assert.match(
      readiness.status === "unavailable" ? readiness.reason : "",
      /format version 99/,
    );
    const report = await collectManifestGarbage(dir, store);
    assert.equal(report.deleted, 0);
    assert.equal(report.skippedUnreadable, 1);
  });

  test("byte budget fails closed instead of evicting a pinned inverse", async () => {
    const dir = await tempDir();
    const store = LocalSnapshotStore(join(dir, "snapshots"), { maxBytes: 10 });
    const pinned = await store.put(
      "ws",
      encoder.encode("keepme!"),
      {},
      {
        pin: { ownerId: "job-1", kind: "recovery" },
      },
    );

    // 7 pinned bytes plus 8 new bytes exceed the budget. The only way to meet
    // it is to remove the pinned inverse, so the capture is refused instead.
    await assert.rejects(
      () => store.put("ws", encoder.encode("newone!!")),
      /pinned or unreadable/,
    );
    assert.deepEqual(
      new TextDecoder().decode(await store.get(pinned.reference)),
      "keepme!",
    );
  });

  test("delete by age reports every pinned artifact it refused to remove", async () => {
    const dir = await tempDir();
    const store = LocalSnapshotStore(join(dir, "snapshots"));
    const old = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000);
    const pinned = await store.put(
      "ws",
      encoder.encode("pinned"),
      {},
      { pin: { ownerId: "job-1", kind: "recovery" } },
    );
    const plain = await store.put("ws", encoder.encode("plain"));
    for (const entry of [pinned, plain]) {
      await utimes(
        artifactPath(dir, {
          digest: entry.digest,
          reference: entry.reference,
          tool,
        }),
        old,
        old,
      );
    }

    const report = await (
      await store.retention("ws")
    ).deleteOlderThan(new Date());

    assert.equal(report.deleted, 1);
    assert.equal(report.skipped, 1);
    assert.equal(report.errors.length, 1);
    assert.match(report.errors[0]!, /pinned/);
    assert.equal(
      new TextDecoder().decode(await store.get(pinned.reference)),
      "pinned",
    );
    await assert.rejects(
      () => store.get(plain.reference),
      /snapshot is unavailable/,
    );
  });

  test("a competing writer lock refuses collection instead of racing a rewrite", async () => {
    const dir = await tempDir();
    await capture(dir, "locked", {
      expiresAt: new Date("2020-01-01T00:00:00.000Z"),
    });
    const store = LocalSnapshotStore(join(dir, "snapshots"));
    await writeFile(join(dir, "manifest.jsonl.lock"), "competing writer");

    await assert.rejects(() => collectManifestGarbage(dir, store), {
      code: "EEXIST",
    });
    assert.equal((await manifestReader(dir)).length, 1);
  });
});

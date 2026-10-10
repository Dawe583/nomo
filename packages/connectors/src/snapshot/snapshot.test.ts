import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { LocalSnapshotStore } from "./local.ts";
import { applyRedaction } from "./redact.ts";
import { S3SnapshotStore, type S3LikeClient } from "./s3.ts";
import { sha256Digest } from "./store.ts";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

async function tempRoot(): Promise<string> {
  return mkdtemp(join(tmpdir(), "nomo-snapshots-"));
}

describe("snapshot stores", () => {
  test("local store round trips bytes and returns a stable digest", async () => {
    const root = await tempRoot();
    try {
      const store = LocalSnapshotStore(root);
      const bytes = encoder.encode("payload");
      const first = await store.put("pg", bytes);
      const second = await store.put("pg", bytes);

      assert.equal(first.digest, sha256Digest(bytes));
      assert.equal(second.digest, first.digest);
      assert.equal(decoder.decode(await store.get(first.reference)), "payload");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("local store evicts oldest snapshots first when the byte budget is exceeded", async () => {
    const root = await tempRoot();
    try {
      const store = LocalSnapshotStore(root, { maxBytes: 8 });
      const oldest = await store.put("pg", encoder.encode("aaaa"));
      const kept = await store.put("pg", encoder.encode("bbbb"));
      const oldDate = new Date("2020-01-01T00:00:00.000Z");
      const newerDate = new Date("2020-01-02T00:00:00.000Z");
      await utimes(filePath(root, oldest.reference.namespace, oldest.digest), oldDate, oldDate);
      await utimes(filePath(root, kept.reference.namespace, kept.digest), newerDate, newerDate);

      const newest = await store.put("pg", encoder.encode("cccc"));

      await assert.rejects(() => store.get(oldest.reference), /snapshot is unavailable/);
      assert.equal(decoder.decode(await store.get(kept.reference)), "bbbb");
      assert.equal(decoder.decode(await store.get(newest.reference)), "cccc");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("local store ignores crash leftovers and never treats tmp bytes as snapshots", async () => {
    const root = await tempRoot();
    try {
      const store = LocalSnapshotStore(root);
      const tmpDir = join(root, encodeURIComponent("pg"));
      await mkdir(tmpDir, { recursive: true });
      await writeFile(join(tmpDir, ".tmp-dead-process"), encoder.encode("partial"));
      const partialDigest = sha256Digest(encoder.encode("partial"));
      await assert.rejects(
        () => store.get({ namespace: "pg", digest: partialDigest, uri: "file://partial" }),
        /snapshot is unavailable/,
      );

      const stored = await store.put("pg", encoder.encode("complete"));
      assert.equal(decoder.decode(await store.get(stored.reference)), "complete");
      const retention = await store.retention("pg");
      assert.equal(retention.retainedBytes, encoder.encode("complete").byteLength);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("redaction runs before storage and the digest covers redacted bytes", async () => {
    const root = await tempRoot();
    try {
      const redacted = encoder.encode("token=masked");
      const store = LocalSnapshotStore(root, {
        redaction: async ({ namespace, bytes }) => {
          assert.equal(namespace, "pg");
          assert.equal(decoder.decode(bytes), "token=secret");
          return redacted;
        },
      });

      const result = await store.put("pg", encoder.encode("token=secret"));

      assert.equal(result.digest, sha256Digest(redacted));
      assert.equal(decoder.decode(await readFile(filePath(root, "pg", result.digest))), "token=masked");
      assert.equal(decoder.decode(await store.get(result.reference)), "token=masked");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("applyRedaction defaults to identity", async () => {
    const bytes = encoder.encode("unchanged");
    assert.equal(await applyRedaction(bytes), bytes);
  });

  test("s3 store uses an injected client, round trips bytes, and verifies digest", async () => {
    const objects = new Map<string, Uint8Array>();
    const client: S3LikeClient = {
      async putObject(input) {
        objects.set(input.key, input.bytes);
      },
      async getObject(input) {
        const value = objects.get(input.key);
        if (value === undefined) {
          throw new Error("missing object");
        }
        return value;
      },
    };
    const store = S3SnapshotStore(client, { bucket: "customer", prefix: "prefix" });
    const result = await store.put("s3", encoder.encode("object"));

    assert.equal(result.digest, sha256Digest(encoder.encode("object")));
    assert.equal(result.reference.uri, `s3://customer/prefix/s3/${result.digest.slice("sha256:".length)}`);
    assert.equal(decoder.decode(await store.get(result.reference)), "object");
  });

  test("s3 store redacts before upload and the digest covers uploaded bytes", async () => {
    let uploaded: Uint8Array | undefined;
    const client: S3LikeClient = {
      async putObject(input) {
        uploaded = input.bytes;
      },
      async getObject() {
        if (uploaded === undefined) {
          throw new Error("missing object");
        }
        return uploaded;
      },
    };
    const masked = encoder.encode("masked");
    const store = S3SnapshotStore(client, { redaction: async () => masked });
    const result = await store.put("s3", encoder.encode("secret"));

    assert.equal(result.digest, sha256Digest(masked));
    assert.equal(decoder.decode(await store.get(result.reference)), "masked");
  });
});

describe("local snapshot retention safety", () => {
  const old = new Date("2020-01-01T00:00:00Z");
  const cutoff = new Date("2021-01-01T00:00:00Z");
  const actions = {
    retention: async (store: ReturnType<typeof LocalSnapshotStore>, date: Date) =>
      (await store.retention("pg")).deleteOlderThan(date),
    gc: async (store: ReturnType<typeof LocalSnapshotStore>, date: Date) =>
      store.collectGarbage!("pg", { cutoff: date }),
  };

  for (const kind of ["recovery", "operator"] as const) {
    for (const action of ["budget", "retention", "gc"] as const) {
      test(`${action} preserves ${kind} pins and removes only unpinned bytes`, async (t) => {
        const root = await tempRoot();
        t.after(() => rm(root, { recursive: true, force: true }));
        const store = LocalSnapshotStore(root, { maxBytes: 12 });
        const pinned = await store.put("pg", encoder.encode("aaaa"), {}, { pin: { ownerId: "job", kind } });
        const unpinned = await store.put("pg", encoder.encode("bbbb"), {}, { keyId: "old-key" });
        for (const item of [pinned, unpinned]) await utimes(filePath(root, "pg", item.digest), old, old);
        if (action === "budget") {
          const newest = await store.put("pg", encoder.encode("cccccccc"));
          assert.equal(decoder.decode(await store.get(newest.reference)), "cccccccc");
        } else {
          const report = await actions[action](store, cutoff);
          assert.equal(report.deleted, 1);
          assert.equal(report.freedBytes, 4);
        }
        assert.equal(decoder.decode(await store.get(pinned.reference)), "aaaa");
        await assert.rejects(store.get(unpinned.reference), /snapshot is unavailable/);
        await assert.rejects(readFile(filePath(root, "pg", unpinned.digest) + ".meta"), { code: "ENOENT" });
        assert.equal(JSON.parse(await readFile(filePath(root, "pg", pinned.digest) + ".meta", "utf8")).pin.kind, kind);
      });
    }
  }

  test("concurrent protected admissions keep the namespace within its byte budget", async (t) => {
    const root = await tempRoot();
    t.after(() => rm(root, { recursive: true, force: true }));
    const store = LocalSnapshotStore(root, { maxBytes: 8 });
    const pin = { ownerId: "job", kind: "recovery" } as const;
    const results = await Promise.allSettled([
      store.put("pg", encoder.encode("aaaaaa"), {}, { pin }),
      store.put("pg", encoder.encode("bbbbbb"), {}, { pin }),
    ]);
    assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
    assert.equal(results.filter((result) => result.status === "rejected").length, 1);
    assert.equal((await store.retention("pg")).retainedBytes, 6);
  });

  test("missing metadata refuses retention without deleting possible pinned evidence", async (t) => {
    const root = await tempRoot();
    t.after(() => rm(root, { recursive: true, force: true }));
    const store = LocalSnapshotStore(root);
    const item = await store.put("pg", encoder.encode("before"), {}, { pin: { ownerId: "job", kind: "recovery" } });
    await rm(filePath(root, "pg", item.digest) + ".meta");
    await utimes(filePath(root, "pg", item.digest), old, old);
    await assert.rejects(async () => (await store.retention("pg")).deleteOlderThan(cutoff), /metadata/i);
    assert.equal(decoder.decode(await store.get(item.reference)), "before");
  });

  test("duplicate captures retain pins and key binding and refuse conflicting metadata", async (t) => {
    const root = await tempRoot();
    t.after(() => rm(root, { recursive: true, force: true }));
    const store = LocalSnapshotStore(root, { maxBytes: 4, availableKeyIds: ["old", "new"] });
    const bytes = encoder.encode("aaaa");
    const first = await store.put("pg", bytes);
    const options = { pin: { ownerId: "job", kind: "recovery" as const }, keyId: "old" };
    assert.equal((await store.put("pg", bytes, {}, options)).digest, first.digest);
    assert.equal((await store.put("pg", bytes, {}, options)).digest, first.digest);
    await store.put("pg", bytes);
    await assert.rejects(store.put("pg", bytes, {}, { ...options, keyId: "new" }), { kind: "WriteFailed" });
    await assert.rejects(store.put("pg", bytes, {}, { pin: { ownerId: "another", kind: "operator" } }), { kind: "WriteFailed" });
    assert.deepEqual(JSON.parse(await readFile(filePath(root, "pg", first.digest) + ".meta", "utf8")), options);
    assert.equal((await store.collectGarbage!("pg", { cutoff: new Date("2100-01-01") })).skippedPinned, 1);
    assert.equal(decoder.decode(await store.get(first.reference)), "aaaa");
  });

  test("a capture never overwrites tampered existing bytes while attempting a retry", async (t) => {
    const root = await tempRoot();
    t.after(() => rm(root, { recursive: true, force: true }));
    const store = LocalSnapshotStore(root);
    const first = await store.put("pg", encoder.encode("before"), {}, { pin: { ownerId: "job", kind: "recovery" } });
    const path = filePath(root, "pg", first.digest);
    await writeFile(path, "changed");
    await assert.rejects(store.put("pg", encoder.encode("before")), { kind: "WriteFailed" });
    assert.equal(await readFile(path, "utf8"), "changed");
    assert.equal(JSON.parse(await readFile(path + ".meta", "utf8")).pin.ownerId, "job");
  });

  test("an existing mutation lock refuses writes and cleanup without deleting snapshots", async (t) => {
    const root = await tempRoot();
    t.after(() => rm(root, { recursive: true, force: true }));
    const store = LocalSnapshotStore(root);
    const item = await store.put("pg", encoder.encode("before"));
    const lock = join(root, "pg", ".retention.lock");
    await writeFile(lock, "operator must inspect");
    await assert.rejects(store.put("pg", encoder.encode("after")), { kind: "WriteFailed" });
    for (const action of Object.values(actions)) await assert.rejects(action(store, cutoff), { code: "EEXIST" });
    assert.equal(decoder.decode(await store.get(item.reference)), "before");
    assert.equal(await readFile(lock, "utf8"), "operator must inspect");
    await rm(lock);
    await store.put("pg", encoder.encode("after"));
    await assert.rejects(readFile(lock), { code: "ENOENT" });
  });

  test("concurrent store instances cannot admit two pinned captures into one slot", async (t) => {
    const root = await tempRoot();
    t.after(() => rm(root, { recursive: true, force: true }));
    const stores = [LocalSnapshotStore(root, { maxBytes: 4 }), LocalSnapshotStore(root, { maxBytes: 4 })];
    const results = await Promise.allSettled(stores.map((store, i) =>
      store.put("pg", encoder.encode(i ? "bbbb" : "aaaa"), {}, { pin: { ownerId: `job-${i}`, kind: "recovery" } })));
    assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
    assert.equal(results.filter((result) => result.status === "rejected").length, 1);
    for (const result of results) if (result.status === "fulfilled")
      assert.equal((await stores[0]!.get(result.value.reference)).byteLength, 4);
    assert.equal((await stores[0]!.retention("pg")).retainedBytes, 4);
  });

  test("full protected budget refuses admission without deleting any existing snapshot", async (t) => {
    const root = await tempRoot();
    t.after(() => rm(root, { recursive: true, force: true }));
    const store = LocalSnapshotStore(root, { maxBytes: 8 });
    const pinned = await store.put("pg", encoder.encode("aaaa"), {}, { pin: { ownerId: "job", kind: "recovery" } });
    const unpinned = await store.put("pg", encoder.encode("bb"));
    const bytes = encoder.encode("cccccc");
    await assert.rejects(store.put("pg", bytes), { kind: "RetentionFailed" });
    assert.equal(decoder.decode(await store.get(pinned.reference)), "aaaa");
    assert.equal(decoder.decode(await store.get(unpinned.reference)), "bb");
    await assert.rejects(readFile(filePath(root, "pg", sha256Digest(bytes))), { code: "ENOENT" });
    assert.equal((await store.retention("pg")).retainedBytes, 6);
  });

  for (const action of ["retention", "gc"] as const) {
    test(`${action} rejects an invalid cutoff before deleting anything`, async (t) => {
      const root = await tempRoot();
      t.after(() => rm(root, { recursive: true, force: true }));
      const store = LocalSnapshotStore(root);
      const item = await store.put("pg", encoder.encode("before"));
      await assert.rejects(actions[action](store, new Date(NaN)), /cutoff/i);
      assert.equal(decoder.decode(await store.get(item.reference)), "before");
    });
  }

  for (const action of ["budget", "retention", "gc"] as const) {
    test(`${action} refuses malformed or unreadable metadata without deleting evidence`, async (t) => {
      const root = await tempRoot();
      t.after(() => rm(root, { recursive: true, force: true }));
      const invalid = ["{", "null", "[]", '{"pin":null}', '{"pin":{"kind":"recovery"}}', '{"pin":{"ownerId":"job","kind":"unknown"}}', '{"expiresAt":"invalid"}', '{"keyId":42}', '{"unknown":true}', "directory"];
      for (const [i, metadata] of invalid.entries()) {
        const dir = join(root, String(i));
        const store = LocalSnapshotStore(dir, { maxBytes: 8 });
        const first = await store.put("pg", encoder.encode("aaaa"));
        const second = await store.put("pg", encoder.encode("bbbb"));
        for (const item of [first, second]) await utimes(filePath(dir, "pg", item.digest), old, old);
        const sidecar = filePath(dir, "pg", second.digest) + ".meta";
        if (metadata === "directory") { await rm(sidecar); await mkdir(sidecar); }
        else await writeFile(sidecar, metadata);
        await assert.rejects(action === "budget"
          ? store.put("pg", encoder.encode("cccc"))
          : actions[action](store, cutoff), /metadata|snapshot write failed/i, metadata);
        for (const item of [first, second]) assert.equal((await store.get(item.reference)).byteLength, 4, metadata);
        await assert.rejects(readFile(filePath(dir, "pg", sha256Digest(encoder.encode("cccc")))), { code: "ENOENT" });
      }
    });
  }
});

function filePath(root: string, namespace: string, digest: `sha256:${string}`): string {
  return join(root, encodeURIComponent(namespace), digest.slice("sha256:".length));
}

import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, open, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { findEntry, manifestReader, manifestWriter, type SnapshotManifestEntry } from "./manifest.ts";

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
});

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "void-manifest-"));
  test.after(async () => {
    await rm(dir, { recursive: true, force: true });
  });
  return dir;
}

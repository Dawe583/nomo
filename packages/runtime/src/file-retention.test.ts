/**
 * The file vault's dry-run prediction is the surface an operator reads before
 * they let the collector delete anything. These tests pin the rules the
 * prediction reuses from the collector: absent evidence protects, a recorded
 * pin protects, only unpinned artifacts with a provably past write time
 * expire, a manual policy deletes nothing, and the audit writes nothing at
 * all because a prediction that left evidence would read as a run that happened.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";

import {
  auditFileVaultCollection,
  evaluateFileVaultRetentionPolicy,
  summarizeFileVaultRetention,
} from "./file-retention.ts";
import {
  MANUAL_RETENTION_POLICY,
  markVaultLifecycle,
  type RetentionPolicy,
} from "./retention.ts";

const BASE = Date.UTC(2026, 0, 2);

const fixture = async (t: { after: (fn: () => unknown) => void }) => {
  const dir = await mkdtemp(join(tmpdir(), "nomo-file-retention-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const root = join(dir, "vault"),
    index = join(dir, "retention-index");
  await mkdir(join(root, "test"), { recursive: true });
  const put = async (value: string) => {
    const bytes = Buffer.from(value, "utf8"),
      digest = createHash("sha256").update(bytes).digest("hex"),
      path = join(root, "test", digest);
    await writeFile(path, bytes);
    return { digest, size: bytes.byteLength };
  };
  const age = async (reference: { digest: string }, ms: number) => {
    const when = new Date(BASE - ms);
    await utimes(join(root, "test", reference.digest), when, when);
  };
  const release = (reference: { digest: string; size: number }) =>
    markVaultLifecycle({
      root,
      index,
      workspace: "test",
      reference: { digest: reference.digest, keyId: "local", bytes: reference.size },
    });
  const audit = async (policy?: RetentionPolicy) =>
    auditFileVaultCollection({
      root,
      index,
      workspace: "test",
      ...(policy === undefined ? {} : { policy }),
      clock: () => new Date(BASE),
    });
  return { dir, root, index, put, age, release, audit };
};

test("a manual policy expires nothing on the file surface", async (t) => {
  const f = await fixture(t),
    artifact = await f.put("kept");
  await f.age(artifact, 60_000);
  const audit = await f.audit();
  assert.deepEqual(
    { deleted: audit.deleted, retained: audit.retained, skippedPinned: audit.skippedPinned },
    { deleted: 0, retained: 1, skippedPinned: 0 },
  );
  assert.deepEqual(audit.digests, []);
});

test("only an unpinned file past the ttl is predicted for deletion", async (t) => {
  const f = await fixture(t),
    released = await f.put("released"),
    protectedFile = await f.put("protected");
  await f.release(released);
  await f.age(released, 60_000);
  await f.age(protectedFile, 60_000);
  const audit = await f.audit({
    version: 1,
    mode: "age",
    ttlByKind: { unpinned: 30_000, recovery: null, operator: null },
  });
  assert.equal(audit.deleted, 1);
  assert.deepEqual(audit.digests, [released.digest]);
  // The counts stay the collector's verbatim: an expired file the scan reads
  // as protected, whatever protects it, lands in skippedPinned, and only the
  // nothing-expired remainder is retained.
  assert.equal(audit.skippedPinned, 1);
  assert.equal(audit.retained, 0);
  assert.equal(audit.freedBytes, released.size);
});

test("absent evidence protects a file the prediction never deletes", async (t) => {
  const f = await fixture(t),
    unmarked = await f.put("unmarked");
  await f.age(unmarked, 60_000);
  const audit = await f.audit({
    version: 1,
    mode: "age",
    ttlByKind: { unpinned: 30_000, recovery: null, operator: null },
  });
  assert.deepEqual(
    { deleted: audit.deleted, retained: audit.retained, skippedPinned: audit.skippedPinned },
    { deleted: 0, retained: 0, skippedPinned: 1 },
  );
});

test("an unknown age is not a passed age", async (t) => {
  const f = await fixture(t),
    artifact = await f.put("beyond");
  // A write time in the future of the run's clock cannot have passed any TTL.
  const when = new Date(BASE + 60_000);
  await utimes(join(f.root, "test", artifact.digest), when, when);
  const audit = await f.audit({
    version: 1,
    mode: "age",
    ttlByKind: { unpinned: 30_000, recovery: null, operator: null },
  });
  assert.equal(audit.deleted, 0);
});

test("the prediction writes nothing at all", async (t) => {
  const f = await fixture(t),
    artifact = await f.put("kept");
  await f.age(artifact, 60_000);
  await f.audit({
    version: 1,
    mode: "age",
    ttlByKind: { unpinned: 30_000, recovery: null, operator: null },
  });
  // No evidence index is created and the artifact stays: a dry run that left
  // a sidecar behind would make the next real run read its prediction as state.
  const index = await stat(f.index).catch(() => null);
  assert.equal(index, null);
  const bytes = await stat(join(f.root, "test", artifact.digest));
  assert.equal(bytes.isFile(), true);
});

test("the evaluator stays a pure function over the listed files", () => {
  const policy = MANUAL_RETENTION_POLICY,
    now = 1_000,
    files = [
      { path: "/a", artifact: { digest: "a".repeat(64) }, size: 1, mtimeMs: now - 99_000, pinned: false },
      { path: "/b", artifact: { digest: "b".repeat(64) }, size: 2, mtimeMs: now - 99_000, pinned: true },
    ],
    age: RetentionPolicy = {
      version: 1,
      mode: "age",
      ttlByKind: { unpinned: 30_000, recovery: null, operator: null },
    };
  const manual = evaluateFileVaultRetentionPolicy(files, policy, now);
  assert.deepEqual(manual.deleting, []);
  assert.equal(manual.retained, 2);
  const aged = evaluateFileVaultRetentionPolicy(files, age, now);
  assert.equal(aged.deleting.length, 1);
  assert.equal(aged.skippedPinned, 1);
  assert.equal(aged.retained, 0);
});

test("the summary reports files the never written evidence tree still holds", async (t) => {
  const f = await fixture(t),
    artifact = await f.put("kept");
  await f.age(artifact, 60_000);
  const summary = await summarizeFileVaultRetention({
    root: f.root,
    index: f.index,
    workspace: "test",
  });
  // present stays false because nothing is recorded anywhere, while the
  // files are exactly the protected-with-nothing-readable case a health
  // report exists to surface rather than hide.
  assert.deepEqual(summary, {
    present: false,
    evidence: 0,
    pinned: 0,
    released: 0,
    withoutEvidence: 1,
  });
});

test("the summary counts pins, releases and files with no record at all", async (t) => {
  const f = await fixture(t),
    releasedFile = await f.put("released"),
    pinnedFile = await f.put("pinned");
  await f.release(releasedFile);
  await markVaultLifecycle({
    root: f.root,
    index: f.index,
    workspace: "test",
    reference: { digest: pinnedFile.digest, keyId: "local", bytes: pinnedFile.size },
    pin: { ownerId: "op-a", kind: "recovery" },
  });
  await f.put("unrecorded");
  const summary = await summarizeFileVaultRetention({
    root: f.root,
    index: f.index,
    workspace: "test",
  });
  assert.deepEqual(summary, {
    present: true,
    evidence: 2,
    pinned: 1,
    released: 1,
    // The artifact beyond both sidecars is the protected-with-nothing-
    // readable count the reserved store names as its orphans.
    withoutEvidence: 1,
  });
});

test("a record the summary cannot prove refuses the counts outright", async (t) => {
  const f = await fixture(t),
    artifact = await f.put("kept");
  // A sidecar the lifecycle reader refuses is a refusal, not a zero: health
  // inherits the collector's rule that unparsable or unknown evidence never
  // counts as protection. The sidecar must sit where the collector reads
  // it, in the workspace directory of the evidence tree.
  const sidecar = join(f.index, "test", `${artifact.digest}.meta`);
  await mkdir(join(f.index, "test"), { recursive: true });
  await writeFile(sidecar, "{not proven");
  await assert.rejects(
    summarizeFileVaultRetention({
      root: f.root,
      index: f.index,
      workspace: "test",
    }),
    /lifecycle is invalid/,
  );
});

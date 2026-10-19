import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  open,
  readFile,
  readdir,
  rm,
  stat,
  utimes,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { randomBytes } from "node:crypto";
import { devKeyProvider } from "../../ledger/src/sign.ts";
import { canonicalJson } from "../../ledger/src/canonical.ts";
import {
  localOperationJournal,
  localRecoveryVault,
  reservedRecoveryVault,
  type Json,
  type OperationJournal,
  type RecoveryVault,
  type VaultPin,
  type VaultReference,
} from "./index.ts";
import {
  MANUAL_RETENTION_POLICY,
  backupRetentionIndex,
  collectVaultGarbage,
  markVaultLifecycle,
  releaseVaultPin,
  restoreRetentionIndex,
  RETENTION_INDEX_MANIFEST,
  validateRetentionPolicy,
  type RetentionPolicy,
} from "./retention.ts";
import type { GarbageReport } from "../../connectors/src/snapshot/store.ts";

const WORKSPACE = "ops";
const BASE = Date.UTC(2026, 0, 2, 3, 4, 5);
const AGE_POLICY: RetentionPolicy = {
  version: 1,
  mode: "age",
  ttlByKind: { unpinned: 1000, recovery: null, operator: null },
};

const fixture = async (t: TestContext) => {
  const dir = await mkdtemp(join(tmpdir(), "nomo-retention-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const root = join(dir, "vault"),
    index = join(dir, "retention"),
    keys = { first: randomBytes(32) },
    vault: RecoveryVault = localRecoveryVault(root, keys, "first"),
    journal: OperationJournal = localOperationJournal(
      join(dir, "journal"),
      await devKeyProvider({ dir: join(dir, "keys"), env: {} }),
    );
  return {
    root,
    index,
    journal,
    keys,
    put: (value: Json) => vault.put(WORKSPACE, value),
    read: (reference: VaultReference) => vault.get(WORKSPACE, reference),
    path: (reference: VaultReference) =>
      join(root, WORKSPACE, reference.digest),
    evidence: (reference: VaultReference) =>
      join(index, WORKSPACE, `${reference.digest}.meta`),
    mark: (reference: VaultReference, pin?: VaultPin) =>
      markVaultLifecycle({
        root,
        index,
        workspace: WORKSPACE,
        reference,
        pin,
      }),
    age: async (reference: VaultReference, ms = 60_000) => {
      const when = new Date(BASE - ms);
      await utimes(join(root, WORKSPACE, reference.digest), when, when);
    },
    markIn: (reference: VaultReference, index: string) =>
      markVaultLifecycle({
        root,
        index,
        workspace: WORKSPACE,
        reference,
      }),
    collectIn: (operationId: string, index: string) =>
      collectVaultGarbage({
        root,
        index,
        workspace: WORKSPACE,
        journal,
        operationId,
        agentId: "agent",
        runId: "run",
        policy: AGE_POLICY,
        clock: () => new Date(BASE),
        authorize: async () => true,
      }),
    collect: (operationId: string, policy?: RetentionPolicy) =>
      collectVaultGarbage({
        root,
        index,
        workspace: WORKSPACE,
        journal,
        operationId,
        agentId: "agent",
        runId: "run",
        policy,
        clock: () => new Date(BASE),
        authorize: async () => true,
      }),
    events: (operationId: string) =>
      journal.transaction(WORKSPACE, async (tx) =>
        (tx.records ?? [])
          .map((record) => record.event)
          .filter(
            (event) =>
              "operationId" in event && event.operationId === operationId,
          ),
      ),
    artifacts: async () =>
      (await readdir(join(root, WORKSPACE))).filter((name) =>
        /^[a-f0-9]{64}$/.test(name),
      ),
  };
};
type OperationEventLike = { stage: string; data: Json; adapterId: string };
const stages = (events: readonly OperationEventLike[]) =>
  events.map((event) => event.stage);
const reportOf = (garbage: GarbageReport) => ({
  skippedPinned: garbage.skippedPinned,
  retained: garbage.retained,
  deleted: garbage.deleted,
  freedBytes: garbage.freedBytes,
});

test("the default retention policy is manual and the garbage collector is a no-op", async (t) => {
  const f = await fixture(t);
  assert.equal(MANUAL_RETENTION_POLICY.mode, "manual");
  assert.deepEqual(
    MANUAL_RETENTION_POLICY.ttlByKind,
    { unpinned: null, recovery: null, operator: null },
  );
  const kept = await f.put("kept"),
    released = await f.put("released");
  await f.mark(released);
  await f.age(kept);
  await f.age(released);
  const before = (await f.artifacts()).length;
  assert.deepEqual(
    reportOf(await f.collect("gc-default")),
    { skippedPinned: 0, retained: before, deleted: 0, freedBytes: 0 },
  );
  assert.equal((await f.artifacts()).length, before);
  assert.equal(await f.read(kept), "kept");
  assert.equal(await f.read(released), "released");
});

test("age collection deletes only released artifacts and reports every count", async (t) => {
  const f = await fixture(t);
  const unmarked = await f.put("unmarked"),
    released = await f.put("released"),
    fresh = await f.put("fresh");
  await f.mark(released);
  await f.mark(fresh);
  await f.age(unmarked);
  await f.age(released);
  const freed = (await stat(f.path(released))).size;
  const report = reportOf(await f.collect("gc-age", AGE_POLICY));
  assert.deepEqual(report, {
    skippedPinned: 1,
    retained: 1,
    deleted: 1,
    freedBytes: freed,
  });
  // unmarked has no lifecycle evidence at all, so it is protected.
  assert.equal(await f.read(unmarked), "unmarked");
  assert.equal(await f.read(fresh), "fresh");
  await assert.rejects(f.read(released), /ENOENT/);
  assert.deepEqual(await f.artifacts(), [
    unmarked.digest,
    fresh.digest,
  ].sort());
  assert.equal(
    report.retained + report.skippedPinned + report.deleted,
    3,
  );
});

test("a pinned recovery artifact survives collection whatever the policy TTL", async (t) => {
  const policy: RetentionPolicy = {
    version: 1,
    mode: "age",
    ttlByKind: { unpinned: 1, recovery: null, operator: null },
  };
  for (const kind of ["recovery", "operator"] as const) {
    const f = await fixture(t);
    const pinned = await f.put(`pinned-${kind}`);
    await f.mark(pinned, {
      ownerId: "operator-1",
      kind,
    } satisfies VaultPin);
    await f.age(pinned, 10 * 365 * 24 * 3_600_000);
    assert.deepEqual(reportOf(await f.collect("gc-pin", policy)), {
      skippedPinned: 1,
      retained: 0,
      deleted: 0,
      freedBytes: 0,
    });
    assert.equal(await f.read(pinned), `pinned-${kind}`);
  }
});

const damaged = async (t: TestContext, damage: "invalid-json" | "unreadable") => {
  const f = await fixture(t);
  const first = await f.put(`first-${damage}`),
    second = await f.put(`second-${damage}`);
  await f.mark(first);
  await f.mark(second);
  await f.age(first);
  await f.age(second);
  const sidecar = f.evidence(first);
  await rm(sidecar);
  if (damage === "invalid-json") await writeFile(sidecar, "{not json");
  else await mkdir(sidecar);
  await assert.rejects(
    f.collect(`gc-${damage}`, AGE_POLICY),
    /lifecycle is (unreadable|invalid); retention refused/,
  );
  // Nothing is deleted while a pin is unproven.
  assert.equal(await f.read(first), `first-${damage}`);
  assert.equal(await f.read(second), `second-${damage}`);
  assert.deepEqual(
    (await f.artifacts()).sort(),
    [first.digest, second.digest].sort(),
  );
};

test("invalid lifecycle evidence refuses the whole run", async (t) => {
  await damaged(t, "invalid-json");
});

test("unreadable lifecycle evidence refuses the whole run", async (t) => {
  await damaged(t, "unreadable");
});

test("two consecutive collections are idempotent", async (t) => {
  const f = await fixture(t);
  const first = await f.put("first"),
    second = await f.put("second");
  await f.mark(first);
  await f.mark(second);
  await f.age(first);
  await f.age(second);
  const freed =
    (await stat(f.path(first))).size + (await stat(f.path(second))).size;
  assert.deepEqual(reportOf(await f.collect("gc-1", AGE_POLICY)), {
    skippedPinned: 0,
    retained: 0,
    deleted: 2,
    freedBytes: freed,
  });
  assert.deepEqual(await f.artifacts(), []);
  assert.deepEqual(reportOf(await f.collect("gc-2", AGE_POLICY)), {
    skippedPinned: 0,
    retained: 0,
    deleted: 0,
    freedBytes: 0,
  });
  assert.deepEqual(await f.artifacts(), []);
});

test("a collection run is a signed journal chain ending in its report", async (t) => {
  const f = await fixture(t);
  const released = await f.put("released");
  await f.mark(released);
  await f.age(released);
  const report = reportOf(await f.collect("gc-journal", AGE_POLICY));
  const events = (await f.events("gc-journal")) as OperationEventLike[];
  assert.deepEqual(stages(events), [
    "received",
    "authorized",
    "prepared",
    "dispatched",
    "succeeded",
  ]);
  const received = events[0]!.data as {
    policy: RetentionPolicy;
    policyDigest: string;
  };
  assert.deepEqual(received.policy, AGE_POLICY);
  assert.match(received.policyDigest, /^[a-f0-9]{64}$/);
  const succeeded = events.at(-1)!.data as GarbageReport & {
    policyDigest: string;
  };
  assert.deepEqual(reportOf(succeeded), report);
  assert.equal(succeeded.policyDigest, received.policyDigest);
});

test("a denied collection collects nothing and records the refusal", async (t) => {
  const f = await fixture(t);
  const released = await f.put("released");
  await f.mark(released);
  await f.age(released);
  await assert.rejects(
    collectVaultGarbage({
      root: f.root,
      index: f.index,
      workspace: WORKSPACE,
      journal: f.journal,
      operationId: "gc-denied",
      agentId: "agent",
      runId: "run",
      policy: AGE_POLICY,
      clock: () => new Date(BASE),
      authorize: async () => false,
    }),
    /retention was denied/,
  );
  assert.deepEqual(await f.artifacts(), [released.digest]);
  assert.deepEqual(stages((await f.events("gc-denied")) as OperationEventLike[]), [
    "received",
    "denied",
  ]);
});

test("lifecycle evidence is recorded once and never silently released", async (t) => {
  const f = await fixture(t);
  const reference = await f.put("artifact");
  const missing = { digest: "0".repeat(64), keyId: "first", bytes: 0 };
  await assert.rejects(
    f.mark(missing),
    /artifact is unavailable/,
  );
  await f.mark(reference, { ownerId: "op", kind: "recovery" });
  await f.mark(reference, { ownerId: "op", kind: "recovery" });
  await assert.rejects(
    f.mark(reference),
    /is not released by retention/,
  );
  await assert.rejects(
    f.mark(reference, { ownerId: "other", kind: "recovery" }),
    /does not match the stated pin/,
  );
  await assert.rejects(
    f.mark(reference, {
      ownerId: "op",
      kind: "operator",
    } as VaultPin),
    /does not match the stated pin/,
  );
  const reread = await f.put("other");
  await f.mark(reread);
  assert.equal(await f.read(reread), "other");
});

test("retention evidence never enters the legacy artifact directory", async (t) => {
  const f = await fixture(t);
  const released = await f.put("released"),
    pinned = await f.put("pinned");
  await f.mark(released);
  await f.mark(pinned, { ownerId: "op", kind: "recovery" });
  await f.age(released);
  await f.collect("gc-isolation", AGE_POLICY);
  // The reserved vault reads every file in a workspace directory as a legacy
  // artifact, so a sidecar or a lock file stored there breaks migration.
  assert.deepEqual(
    (await readdir(join(f.root, WORKSPACE))).sort(),
    [pinned.digest],
  );
  const migrated = reservedRecoveryVault(f.root, f.keys, "first");
  const stored = await migrated.put(WORKSPACE, "migrated");
  assert.equal(stored.keyId, "first");
  assert.equal(await migrated.get(WORKSPACE, pinned), "pinned");
});

test("a retention policy is versioned, per kind, and pinned kinds never expire", () => {
  assert.deepEqual(validateRetentionPolicy(MANUAL_RETENTION_POLICY), {
    version: 1,
    mode: "manual",
    ttlByKind: { unpinned: null, recovery: null, operator: null },
  });
  for (const policy of [
    { ...MANUAL_RETENTION_POLICY, version: 2 as unknown as 1 },
    { ...MANUAL_RETENTION_POLICY, mode: "sweep" as unknown as "manual" },
    {
      ...MANUAL_RETENTION_POLICY,
      ttlByKind: { unpinned: 0, recovery: null, operator: null },
    },
    {
      ...MANUAL_RETENTION_POLICY,
      ttlByKind: { unpinned: -1, recovery: null, operator: null },
    },
    {
      version: 1 as const,
      mode: "age" as const,
      ttlByKind: { unpinned: 10, recovery: 10, operator: null },
    },
    {
      version: 1 as const,
      mode: "age" as const,
      ttlByKind: { unpinned: 10, recovery: null, operator: 10 },
    },
    {
      version: 1 as const,
      mode: "manual" as const,
      ttlByKind: { unpinned: 10, recovery: null, operator: null },
    },
    {
      version: 1 as const,
      mode: "age" as const,
      ttlByKind: { unpinned: null, recovery: null, operator: null },
    },
    {
      ...MANUAL_RETENTION_POLICY,
      ttlByKind: { unpinned: null, recovery: null },
    } as unknown as RetentionPolicy,
    {
      ...MANUAL_RETENTION_POLICY,
      ttlByKind: { unpinned: null, recovery: null, operator: null, extra: null },
    } as unknown as RetentionPolicy,
  ])
    assert.throws(() => validateRetentionPolicy(policy), /retention|pinned|TTL/);
});

test("a pin that appears after the scan still stops the delete", async (t) => {
  const f = await fixture(t);
  const released = await f.put("released");
  await f.age(released, 60_000);
  // No pin and no evidence: the collector is free to take this one.
  await f.mark(released);

  // A writer that does not take the collection lock lands a pin between the
  // scan and the unlink. The collector re-reads the evidence immediately before
  // deleting, so the artifact survives and the pin record is not removed with
  // it. Written straight to the sidecar, which is exactly what such a writer
  // does.
  await writeFile(
    f.evidence(released),
    canonicalJson({ pin: { ownerId: "ops", kind: "operator" } }),
    { mode: 0o600 },
  );

  const garbage = await f.collect("pin-race", AGE_POLICY);
  assert.deepEqual(reportOf(garbage).deleted, 0, "a pin written after the scan must stop the delete");
  assert.ok(
    (await f.artifacts()).includes(released.digest),
    "the artifact is still on disk after a refused delete",
  );
  assert.equal(await f.read(released), "released");
  assert.equal(
    await readFile(f.evidence(released), "utf8").then((value) => value, () => ""),
    canonicalJson({ pin: { ownerId: "ops", kind: "operator" } }),
    "the pin record that stopped the delete must survive it",
  );
});

test("retention evidence must not be written inside the artifact root", async (t) => {
  const f = await fixture(t);
  const reference = await f.put("first");
  // The artifact tree itself and any parent of it are both refused: a `.meta`
  // sidecar there makes the reserved vault refuse the whole store as
  // unverifiable, which is the reason evidence lives outside it.
  for (const index of [f.root, dirname(f.root)]) {
    await assert.rejects(
      f.markIn(reference, index),
      /outside the artifact root/,
    );
  }
  await assert.rejects(
    f.collectIn("index-root", f.root),
    /outside the artifact root/,
  );
  await assert.rejects(
    f.collectIn("index-parent", dirname(f.root)),
    /outside the artifact root/,
  );
});

test("recording a lifecycle obeys the same lock as a collection", async (t) => {
  const f = await fixture(t);
  const reference = await f.put("first");
  // Hold the lock the way a running collection does, then try to record a pin.
  // If marking did not participate, it would succeed and the collector's
  // snapshot would never see the pin it just wrote.
  const lock = join(f.index, WORKSPACE, ".retention.lock");
  await mkdir(dirname(lock), { recursive: true, mode: 0o700 });
  const held = await open(lock, "wx", 0o600);
  t.after(async () => { await held.close(); await rm(lock, { force: true }); });

  await assert.rejects(
    f.mark(reference, { ownerId: "ops", kind: "operator" }),
    /retention is locked/,
  );
  await assert.rejects(f.collect("locked"), /retention is locked/);
  // Nothing was recorded and the artifact is untouched.
  assert.equal(await f.read(reference), "first");
  assert.equal(
    await readFile(f.evidence(reference), "utf8").then(
      () => true,
      () => false,
    ),
    false,
    "a refused mark must not leave evidence behind",
  );
});

test("a lock left by a dead collector is reclaimed, a live or unreadable one is not", async (t) => {
  const f = await fixture(t);
  const reference = await f.put("first");
  const lock = join(f.index, WORKSPACE, ".retention.lock");
  await mkdir(dirname(lock), { recursive: true, mode: 0o700 });

  // A lock this process still holds is never reclaimed, however old it looks.
  const live = await open(lock, "wx", 0o600);
  await live.writeFile(JSON.stringify({ schema: "void.retention.lock.v1", pid: process.pid, expiresAt: 0 }));
  await live.close();
  await assert.rejects(f.collect("live-lock"), /retention is locked/);
  assert.equal(await f.read(reference), "first");

  // A lock whose owner is gone and whose lease has passed is reclaimed, so a
  // crash does not freeze retention until an operator notices. A real exited
  // child supplies the pid; guessing one is unreliable because an existing but
  // foreign pid answers EPERM, not ESRCH, and that case must stay refused.
  await rm(lock, { force: true });
  const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
  const deadPid = child.pid;
  assert.ok(typeof deadPid === "number");
  await once(child, "exit");
  const handle = await open(lock, "wx", 0o600);
  await handle.writeFile(JSON.stringify({
    schema: "void.retention.lock.v1",
    pid: deadPid,
    expiresAt: Date.now() - 1000,
  }));
  await handle.close();
  assert.equal(
    (await f.collect("dead-lock")).deleted >= 0,
    true,
    "a dead owner's expired lock must not freeze collection",
  );
  assert.equal(await rm(lock, { force: true }), undefined, "the reclaimed lock is released again");

  // A lock we cannot parse is a lock we will not take.
  await writeFile(lock, "not json", { mode: 0o600 });
  await assert.rejects(f.collect("unreadable-lock"), /retention is locked/);
});

const release = (
  f: Awaited<ReturnType<typeof fixture>>,
  reference: VaultReference,
  pin: VaultPin,
  operatorId = "ops-1",
) =>
  releaseVaultPin({
    root: f.root,
    index: f.index,
    workspace: WORKSPACE,
    reference,
    pin,
    operatorId,
    clock: () => new Date(BASE),
  });

test("a pinned artifact is released through the supported surface, not by hand", async (t) => {
  const f = await fixture(t);
  const pinned = await f.put("pinned");
  await f.mark(pinned, { ownerId: "ops", kind: "operator" });
  await f.age(pinned);
  // While pinned, an age policy may run but must not take it.
  assert.deepEqual(reportOf(await f.collect("gc-pinned", AGE_POLICY)), {
    skippedPinned: 1,
    retained: 0,
    deleted: 0,
    freedBytes: 0,
  });
  const record = await release(f, pinned, {
    ownerId: "ops",
    kind: "operator",
  });
  assert.equal(record.operatorId, "ops-1", "the release names who released it");
  assert.deepEqual(record.released, { ownerId: "ops", kind: "operator" });
  assert.equal(record.at, new Date(BASE).toISOString());
  // The release is recorded evidence, not an absent pin: an artifact that was
  // never reviewed and one an operator released must stay distinguishable.
  assert.deepEqual(
    JSON.parse(await readFile(f.evidence(pinned), "utf8")),
    {
      release: {
        operatorId: "ops-1",
        at: new Date(BASE).toISOString(),
        released: { ownerId: "ops", kind: "operator" },
      },
    },
  );
  assert.equal(reportOf(await f.collect("gc-released", AGE_POLICY)).deleted, 1);
  assert.deepEqual(await f.artifacts(), []);
});

test("a pin release refuses any owner or kind it cannot prove it is removing", async (t) => {
  const f = await fixture(t);
  const pinned = await f.put("pinned"),
    unmarked = await f.put("unmarked");
  await f.mark(pinned, { ownerId: "ops", kind: "operator" });
  await f.age(pinned);
  await f.age(unmarked);
  // A release must name the protection it removes. Naming a different owner,
  // a different kind, or an artifact with no evidence at all, all refuse:
  // absent evidence means "protect", not "nothing to do".
  await assert.rejects(
    release(f, pinned, { ownerId: "someone-else", kind: "operator" }),
    /recorded pin ops:operator does not match the stated pin/,
  );
  await assert.rejects(
    release(f, pinned, { ownerId: "ops", kind: "recovery" }),
    /recorded pin ops:operator does not match the stated pin/,
  );
  await assert.rejects(
    release(f, unmarked, { ownerId: "ops", kind: "operator" }),
    /no recorded pin/,
  );
  // An operator identity that is not an identity is refused outright.
  await assert.rejects(
    release(f, pinned, { ownerId: "ops", kind: "operator" }, "../escape"),
    /pin release operator is/,
  );
  // Nothing was released: every refusal left the pin standing. Both artifacts
  // are protected, the pinned one by its record and the unmarked one because
  // an absent record means "protect", so neither is collectable.
  assert.equal(await f.read(pinned), "pinned");
  assert.deepEqual(reportOf(await f.collect("gc-refused", AGE_POLICY)), {
    skippedPinned: 2,
    retained: 0,
    deleted: 0,
    freedBytes: 0,
  });
  // Releasing an already released artifact refuses rather than recording twice.
  await release(f, pinned, { ownerId: "ops", kind: "operator" });
  await assert.rejects(
    release(f, pinned, { ownerId: "ops", kind: "operator" }),
    /names no pin/,
  );
});

test("a pin release takes the collection lock", async (t) => {
  const f = await fixture(t);
  const pinned = await f.put("pinned");
  await f.mark(pinned, { ownerId: "ops", kind: "operator" });
  // Hold the lock the way a running collection does. A release that did not
  // participate would land in the gap between the scan and the unlink, and the
  // artifact would be deleted on evidence the collector never saw.
  const lock = join(f.index, WORKSPACE, ".retention.lock");
  await mkdir(dirname(lock), { recursive: true, mode: 0o700 });
  const held = await open(lock, "wx", 0o600);
  t.after(async () => { await held.close(); await rm(lock, { force: true }); });
  await assert.rejects(
    release(f, pinned, { ownerId: "ops", kind: "operator" }),
    /retention is locked/,
  );
  assert.equal(await f.read(pinned), "pinned");
  assert.equal(
    await readFile(f.evidence(pinned), "utf8").then(
      (value) => JSON.parse(value).release === undefined,
      () => false,
    ),
    true,
    "a refused release must not record a release",
  );
});

test("a retention index backup restores the pins it recorded", async (t) => {
  const f = await fixture(t);
  const pinned = await f.put("pinned"),
    released = await f.put("released");
  await f.mark(pinned, { ownerId: "ops", kind: "operator" });
  await f.mark(released);
  await f.age(pinned);
  await f.age(released);
  const backup = join(dirname(f.index), "index-backup");
  const manifest = await backupRetentionIndex({
    index: f.index,
    destination: backup,
    artifactRoot: f.root,
  });
  assert.equal(manifest.schema, RETENTION_INDEX_MANIFEST);
  assert.deepEqual(
    manifest.entries.map((entry) => entry.path).sort(),
    [`${WORKSPACE}/${pinned.digest}.meta`, `${WORKSPACE}/${released.digest}.meta`].sort(),
  );
  // Lose the index entirely, as a damaged volume would.
  await rm(f.index, { recursive: true, force: true });
  // With no index every artifact is protected, because a missing record is
  // not permission: this is the state a restore has to fix.
  assert.deepEqual(reportOf(await f.collect("gc-no-index", AGE_POLICY)), {
    skippedPinned: 2,
    retained: 0,
    deleted: 0,
    freedBytes: 0,
  });
  const restored = await restoreRetentionIndex({
    index: f.index,
    source: backup,
    artifactRoot: f.root,
  });
  assert.deepEqual(restored.entries, manifest.entries);
  // The restored pin protects its artifact and the restored release does not.
  const freed = (await stat(f.path(released))).size;
  assert.deepEqual(reportOf(await f.collect("gc-restored", AGE_POLICY)), {
    skippedPinned: 1,
    retained: 0,
    deleted: 1,
    freedBytes: freed,
  });
  assert.deepEqual(await f.artifacts(), [pinned.digest]);
  assert.equal(await f.read(pinned), "pinned");
});

test("a tampered or unlisted retention index backup refuses to restore", async (t) => {
  const f = await fixture(t);
  const pinned = await f.put("pinned");
  await f.mark(pinned, { ownerId: "ops", kind: "operator" });
  const backup = join(dirname(f.index), "index-backup");
  await backupRetentionIndex({
    index: f.index,
    destination: backup,
    artifactRoot: f.root,
  });
  const sidecar = join(backup, WORKSPACE, `${pinned.digest}.meta`);
  // One flipped byte: the manifest no longer describes the file, and a restore
  // that trusted the file would install a pin record nobody wrote.
  const original = await readFile(sidecar, "utf8");
  await writeFile(sidecar, original.replace("operator", "recovery"));
  await assert.rejects(
    restoreRetentionIndex({
      index: f.index,
      source: backup,
      artifactRoot: f.root,
    }),
    /does not match its manifest/,
  );
  // A file the manifest does not list refuses the whole restore, so the index
  // never ends up half-restored.
  await writeFile(sidecar, original);
  await writeFile(join(backup, WORKSPACE, `${"a".repeat(64)}.meta`), "{}");
  await assert.rejects(
    restoreRetentionIndex({
      index: f.index,
      source: backup,
      artifactRoot: f.root,
    }),
    /does not list/,
  );
  // A backup with no manifest is not a backup.
  await rm(join(backup, "retention-index.json"));
  await assert.rejects(
    restoreRetentionIndex({
      index: f.index,
      source: backup,
      artifactRoot: f.root,
    }),
    /has no manifest/,
  );
  // Through all of that the original index still holds the pin it had.
  assert.equal(await f.read(pinned), "pinned");
  assert.deepEqual(
    JSON.parse(await readFile(f.evidence(pinned), "utf8")),
    JSON.parse(original),
  );
});

test("a retention index backup refuses an index that is not evidence, and the artifact root", async (t) => {
  const f = await fixture(t);
  const pinned = await f.put("pinned");
  await f.mark(pinned, { ownerId: "ops", kind: "operator" });
  // A stray file in the index is refused rather than skipped: a backup that
  // omitted it would restore an index that no longer protects what it used to.
  await writeFile(join(f.index, WORKSPACE, "notes.txt"), "not evidence");
  await assert.rejects(
    backupRetentionIndex({
      index: f.index,
      destination: join(dirname(f.index), "backup"),
      artifactRoot: f.root,
    }),
    /not artifact evidence/,
  );
  // The lock is coordination, not evidence, and is excluded rather than refused.
  await rm(join(f.index, WORKSPACE, "notes.txt"));
  const lock = join(f.index, WORKSPACE, ".retention.lock");
  await writeFile(lock, JSON.stringify({ schema: "void.retention.lock.v1" }));
  const manifest = await backupRetentionIndex({
    index: f.index,
    destination: join(dirname(f.index), "backup"),
    artifactRoot: f.root,
  });
  assert.deepEqual(manifest.entries.map((entry) => entry.path), [
    `${WORKSPACE}/${pinned.digest}.meta`,
  ]);
  // A backup inside the artifact tree would make the reserved vault read it as
  // a legacy artifact, so it is refused for the same reason evidence is.
  await assert.rejects(
    backupRetentionIndex({
      index: f.index,
      destination: join(f.root, "backup"),
      artifactRoot: f.root,
    }),
    /outside the artifact root/,
  );
});

import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createCipheriv, createHash, randomBytes } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { devKeyProvider } from "../../ledger/src/sign.ts";
import { reservedRecoveryVault } from "./reserved-vault.ts";
import { auditReservedVaultCollection, collectReservedVaultGarbage } from "./reserved-retention.ts";
import {
  MANUAL_RETENTION_POLICY,
  type RetentionPolicy,
  type VaultPin,
} from "./retention.ts";
import {
  localOperationJournal,
  type Json,
  type OperationJournal,
  type VaultReference,
} from "./index.ts";
import type { GarbageReport } from "../../connectors/src/snapshot/store.ts";

const WORKSPACE = "ops";
const BASE = Date.UTC(2026, 0, 2, 3, 4, 5);
const AGE_POLICY: RetentionPolicy = {
  version: 1,
  mode: "age",
  ttlByKind: { unpinned: 1000, recovery: null, operator: null },
};

const fixture = async (t: TestContext) => {
  const dir = await mkdtemp(join(tmpdir(), "nomo-reserved-retention-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const root = join(dir, "vault"),
    keys = { first: randomBytes(32) },
    vault = reservedRecoveryVault(root, keys, "first", {
      maxArtifactBytes: 1024 * 1024,
      maxTotalBytes: 64 * 1024 * 1024,
    }),
    journal: OperationJournal = localOperationJournal(
      join(dir, "journal"),
      await devKeyProvider({ dir: join(dir, "keys"), env: {} }),
    );
  const withAt = async (reference: VaultReference, ageMs: number) => {
    // The vault holds its write time in SQLite rather than as a file mtime, so
    // the aging helper writes the same column the writer would have stamped.
    const db = new DatabaseSync(join(root, "vault.sqlite"));
    try {
      db.prepare("UPDATE artifacts SET at=? WHERE workspace=? AND digest=?").run(
        new Date(BASE - ageMs).toISOString(),
        WORKSPACE,
        reference.digest,
      );
    } finally {
      db.close();
    }
  };
  return {
    root,
    journal,
    vault,
    put: (value: string) => vault.put(WORKSPACE, value),
    read: (reference: VaultReference) => vault.get(WORKSPACE, reference),
    mark: (reference: VaultReference, pin?: VaultPin) =>
      vault.markVaultLifecycle(WORKSPACE, reference, { pin }),
    release: (reference: VaultReference, pin: VaultPin) =>
      vault.releaseVaultPin(WORKSPACE, reference, {
        pin,
        operatorId: "operator-2",
        clock: () => new Date(BASE),
      }),
    age: withAt,
    collect: async (operationId: string, policy?: RetentionPolicy) =>
      collectReservedVaultGarbage({
        workspace: WORKSPACE,
        journal,
        vault,
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
    userVersion: () => {
      const db = new DatabaseSync(join(root, "vault.sqlite"));
      try {
        return (
          db.prepare("PRAGMA user_version").get() as { user_version: number }
        ).user_version;
      } finally {
        db.close();
      }
    },
    usedBytes: () => {
      const db = new DatabaseSync(join(root, "vault.sqlite"));
      try {
        const row = db
          .prepare(
            "SELECT COALESCE(SUM(LENGTH(data)),0) AS used FROM artifacts",
          )
          .get() as { used: number };
        return row.used;
      } finally {
        db.close();
      }
    },
    /** A hand built schema 1 row: the old writer had no `at` column, so the
     * ciphertext shape is replicated here with the exact AAD and digest the
     * vault derives from the base64 preimage. */
    handInsertV1: (value: string): VaultReference => {
      const iv = randomBytes(12),
        // Artifacts are Json values, so the plaintext is the JSON encoding.
        payload = Buffer.from(JSON.stringify(value), "utf8"),
        cipher = createCipheriv("aes-256-gcm", keys.first, iv);
      cipher.setAAD(Buffer.from(`void.recovery.v1:${WORKSPACE}:first`));
      const body = Buffer.concat([cipher.update(payload), cipher.final()]);
      const stored = Buffer.concat([iv, cipher.getAuthTag(), body]);
      const digest = createHash("sha256")
        .update('"' + stored.toString("base64") + '"')
        .digest("hex");
      const db = new DatabaseSync(join(root, "vault.sqlite"));
      try {
        db.prepare(
          "INSERT INTO artifacts(workspace,digest,key_id,data,operation_id,slot,content_digest) VALUES(?,?,?,?,?,?,?)",
        ).run(WORKSPACE, digest, "first", stored, null, null, digest);
      } finally {
        db.close();
      }
      return { digest, keyId: "first", bytes: stored.byteLength };
    },
  };
};
type OperationEventLike = { stage: string };
const stages = (events: readonly OperationEventLike[]) =>
  events.map((event) => event.stage);
const reportOf = (garbage: GarbageReport) => ({
  skippedPinned: garbage.skippedPinned,
  retained: garbage.retained,
  deleted: garbage.deleted,
  freedBytes: garbage.freedBytes,
});

test("the manual policy collects nothing and the report counts every artifact", async (t) => {
  const f = await fixture(t);
  assert.equal(MANUAL_RETENTION_POLICY.mode, "manual");
  const kept = await f.put("kept"),
    released = await f.put("released");
  await f.mark(released);
  await f.age(kept, 60_000);
  await f.age(released, 60_000);
  assert.deepEqual(reportOf(await f.collect("gc-default")), {
    skippedPinned: 0,
    retained: 2,
    deleted: 0,
    freedBytes: 0,
  });
  assert.equal(await f.read(kept), "kept");
  assert.equal(await f.read(released), "released");
  assert.deepEqual(stages(await f.events("gc-default")), [
    "received",
    "authorized",
    "prepared",
    "dispatched",
    "succeeded",
  ]);
});

test("a declined delete names the rows the vault would not remove", async (t) => {
  const f = await fixture(t);
  const ref = await f.put("collect me, then decline me");
  await f.age(ref, 2000);
  await f.mark(ref);
  // A bare "failed" sentence sent the operator reading journal records to
  // learn which digests died; the refusal carries them instead.
  const stub = {
    async retentionEntries(_workspace: string) {
      return [
        {
          digest: ref.digest,
          bytes: 12,
          at: new Date(BASE - 2000).toISOString(),
          lifecycle: {},
        },
      ];
    },
    async deleteRetained(_workspace: string, digests: readonly string[]) {
      return {
        deleted: 0,
        freedBytes: 0,
        errors: digests.map(
          (digest) => `${digest} is not a digest this vault holds; not deleted`,
        ),
      };
    },
  };
  await assert.rejects(
    collectReservedVaultGarbage({
      workspace: WORKSPACE,
      journal: f.journal,
      vault: stub as unknown as typeof f.vault,
      operationId: "gc-declined",
      agentId: "agent",
      runId: "run",
      policy: AGE_POLICY,
      clock: () => new Date(BASE),
      authorize: async () => true,
    }),
    (error: unknown) => {
      assert.match(
        (error as Error).message,
        new RegExp(`Reserved vault garbage collection failed: ${ref.digest}`),
      );
      return true;
    },
  );
  assert.equal(stages(await f.events("gc-declined")).slice(-1)[0], "failed");
});

test("age collection deletes only released artifacts and reports every count", async (t) => {
  const f = await fixture(t);
  const unmarked = await f.put("unmarked"),
    released = await f.put("released"),
    fresh = await f.put("fresh");
  await f.mark(released);
  await f.mark(fresh);
  await f.age(unmarked, 60_000);
  await f.age(released, 60_000);
  const garbage = await f.collect("gc-age", AGE_POLICY);
  assert.deepEqual(reportOf(garbage), {
    skippedPinned: 1,
    retained: 1,
    deleted: 1,
    freedBytes: released.bytes,
  });
  assert.equal(
    garbage.retained + garbage.skippedPinned + garbage.deleted,
    3,
  );
  // unmarked has no lifecycle evidence at all, so it is protected.
  assert.equal(await f.read(unmarked), "unmarked");
  assert.equal(await f.read(fresh), "fresh");
  await assert.rejects(f.read(released), /ENOENT|unavailable/);
});

test("a pinned artifact survives collection whatever the policy TTL", async (t) => {
  const policy: RetentionPolicy = {
    version: 1,
    mode: "age",
    ttlByKind: { unpinned: 1, recovery: null, operator: null },
  };
  for (const kind of ["recovery", "operator"] as const) {
    const f = await fixture(t);
    const pinned = await f.put(`pinned-${kind}`);
    await f.mark(pinned, { ownerId: "operator-1", kind } satisfies VaultPin);
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

test("a deny records the denied stage and leaves every artifact in place", async (t) => {
  const f = await fixture(t);
  const kept = await f.put("kept");
  await f.age(kept, 60_000);
  await assert.rejects(
    collectReservedVaultGarbage({
      workspace: WORKSPACE,
      journal: f.journal,
      vault: f.vault,
      operationId: "gc-deny",
      agentId: "agent",
      runId: "run",
      policy: AGE_POLICY,
      clock: () => new Date(BASE),
      authorize: async () => false,
    }),
    /denied/,
  );
  assert.equal(await f.read(kept), "kept");
  assert.deepEqual(stages(await f.events("gc-deny")), [
    "received",
    "denied",
  ]);
});

test("an invalid identity refuses before the journal opens", async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    collectReservedVaultGarbage({
      workspace: "not a workspace id",
      journal: f.journal,
      vault: f.vault,
      operationId: "gc-bad",
      agentId: "agent",
      runId: "run",
      clock: () => new Date(BASE),
      authorize: async () => true,
    }),
    /Recovery retention identity/,
  );
});

test("an unreadable or invalid retention record refuses the whole run", async (t) => {
  const f = await fixture(t);
  const first = await f.put("first"),
    second = await f.put("second");
  await f.mark(first);
  await f.mark(second);
  await f.age(first, 60_000);
  await f.age(second, 60_000);
  const db = new DatabaseSync(join(f.root, "vault.sqlite"));
  try {
    db.prepare("UPDATE retention SET record=? WHERE digest=?").run(
      "{not json",
      first.digest,
    );
  } finally {
    db.close();
  }
  await assert.rejects(f.collect("gc-bad-record", AGE_POLICY), /invalid/);
  assert.equal(await f.read(first), "first");
  assert.equal(await f.read(second), "second");
});

test("releasing a pin is a named compare-and-swap, never an unpinning", async (t) => {
  const f = await fixture(t);
  const pinned = await f.put("pinned"),
    young = await f.put("young");
  await f.mark(pinned, { ownerId: "operator-1", kind: "recovery" });
  await f.age(pinned, 60_000);
  await assert.rejects(
    f.release(pinned, { ownerId: "other", kind: "recovery" }),
    /does not match/,
  );
  await assert.rejects(
    f.release(pinned, { ownerId: "operator-1", kind: "operator" }),
    /does not match/,
  );
  // An artifact with no recorded pin cannot be released either: unknown stays
  // protected.
  await assert.rejects(
    f.release(young, { ownerId: "operator-1", kind: "recovery" }),
    /no recorded pin/,
  );
  const release = await f.release(pinned, {
    ownerId: "operator-1",
    kind: "recovery",
  });
  assert.deepEqual(release.released, {
    ownerId: "operator-1",
    kind: "recovery",
  });
  assert.equal(release.operatorId, "operator-2");
  assert.deepEqual(reportOf(await f.collect("gc-release", AGE_POLICY)), {
    skippedPinned: 0,
    retained: 1,
    deleted: 1,
    freedBytes: pinned.bytes,
  });
  await assert.rejects(f.read(pinned), /ENOENT|unavailable/);
  assert.equal(await f.read(young), "young");
});

test("marking refuses conflicts, refuses absent artifacts and stays idempotent", async (t) => {
  const f = await fixture(t);
  const pinned = await f.put("pinned");
  await f.mark(pinned, { ownerId: "operator-1", kind: "recovery" });
  await assert.rejects(
    f.mark(pinned, { ownerId: "operator-1", kind: "operator" }),
    /does not match the stated pin/,
  );
  // Marking no pin over a recorded pin is not a release; it is refused so
  // nothing unpins itself silently.
  await assert.rejects(f.mark(pinned), /not released by retention/);
  await f.mark(pinned, { ownerId: "operator-1", kind: "recovery" });
  await assert.rejects(
    f.mark({ digest: "a".repeat(64), keyId: "first", bytes: 10 }),
    /unavailable; lifecycle was not recorded/,
  );
});

test("a schema 1 database migrates, keeps its rows readable and stays writable", async (t) => {
  const f = await fixture(t);
  await f.put("probe");
  // The pre-v2 shape is what an older writer left on disk: artifacts without
  // a write time and no retention table at all.
  const legacy = new DatabaseSync(join(f.root, "vault.sqlite"));
  try {
    legacy.exec("DROP TABLE artifacts");
    legacy.exec("DROP TABLE IF EXISTS retention");
    legacy.exec(
      "CREATE TABLE artifacts(workspace TEXT NOT NULL,digest TEXT NOT NULL,key_id TEXT NOT NULL,data BLOB NOT NULL,operation_id TEXT,slot TEXT,content_digest TEXT NOT NULL,PRIMARY KEY(workspace,digest),UNIQUE(workspace,operation_id,slot))",
    );
    legacy.exec("PRAGMA user_version=1");
  } finally {
    legacy.close();
  }
  // Written before the column existed: schema 2 leaves its write time NULL.
  const carried = f.handInsertV1("carried");
  const kept = await f.put("kept");
  assert.equal(f.userVersion(), 2);
  const released = await f.put("released");
  await f.mark(released);
  await f.age(released, 60_000);
  assert.deepEqual(reportOf(await f.collect("gc-migrate", AGE_POLICY)), {
    skippedPinned: 0,
    retained: 2,
    deleted: 1,
    freedBytes: released.bytes,
  });
  // An unknown age is not a passed age, so the carried v1 row survives.
  assert.equal(await f.read(carried), "carried");
  assert.equal(await f.read(kept), "kept");
  await assert.rejects(f.read(released), /ENOENT|unavailable/);
});

test("collection frees the quota the deleted artifacts held", async (t) => {
  const f = await fixture(t);
  const released = await f.put("released");
  await f.mark(released);
  await f.age(released, 60_000);
  assert.equal(f.usedBytes(), released.bytes);
  assert.deepEqual(reportOf(await f.collect("gc-quota", AGE_POLICY)), {
    skippedPinned: 0,
    retained: 0,
    deleted: 1,
    freedBytes: released.bytes,
  });
  assert.equal(f.usedBytes(), 0);
});

test("a dry run predicts the collector without writing anything", async (t) => {
  const f = await fixture(t);
  const released = await f.put("released"),
    pinned = await f.put("pinned");
  await f.mark(released);
  await f.mark(pinned, { ownerId: "operator-1", kind: "recovery" });
  await f.age(released, 60_000);
  await f.age(pinned, 60_000);
  const audit = await auditReservedVaultCollection({
    workspace: WORKSPACE,
    policy: AGE_POLICY,
    clock: () => new Date(BASE),
    vault: f.vault,
  });
  assert.deepEqual(
    { skippedPinned: audit.skippedPinned, retained: audit.retained, deleted: audit.deleted, freedBytes: audit.freedBytes },
    { skippedPinned: 1, retained: 0, deleted: 1, freedBytes: released.bytes },
  );
  assert.deepEqual(audit.digests, [released.digest]);
  assert.equal(await f.read(released), "released");
  assert.equal(await f.read(pinned), "pinned");
  // No journal chain opened: a prediction is not an operation.
  assert.deepEqual(stages(await f.events("no-such-operation")), []);
  // The real run then deletes exactly what the audit named.
  assert.deepEqual(reportOf(await f.collect("gc-audited", AGE_POLICY)), {
    skippedPinned: 1,
    retained: 0,
    deleted: 1,
    freedBytes: released.bytes,
  });
});

test("a dry run on an unreadable record refuses exactly like the collector", async (t) => {
  const f = await fixture(t);
  const first = await f.put("first");
  await f.mark(first);
  await f.age(first, 60_000);
  const db = new DatabaseSync(join(f.root, "vault.sqlite"));
  try {
    db.prepare("UPDATE retention SET record=? WHERE digest=?").run(
      "{not json",
      first.digest,
    );
  } finally {
    db.close();
  }
  await assert.rejects(
    auditReservedVaultCollection({
      workspace: WORKSPACE,
      policy: AGE_POLICY,
      vault: f.vault,
    }),
    /invalid/,
  );
  await assert.rejects(
    auditReservedVaultCollection({
      workspace: "not a workspace",
      vault: f.vault,
    }),
    /Recovery retention identity/,
  );
});

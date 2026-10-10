import test from "node:test";
import assert from "node:assert/strict";
import { PGlite } from "@electric-sql/pglite";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";
import {
  inspectManagedPostgres,
  installManagedPostgres,
  managedPostgresAdapter,
  migrateManagedPostgres,
  type ManagedPostgresOptions,
} from "./managed.ts";
import {
  recoveryRuntime,
  localOperationJournal,
  localRecoveryVault,
  type ExecutionRequest,
} from "../../../runtime/src/index.ts";
import { devKeyProvider } from "../../../ledger/src/sign.ts";
async function fixture(t: import("node:test").TestContext) {
  const db = new PGlite(),
    root = await mkdtemp(join(tmpdir(), "nomo-managed-pg-"));
  t.after(async () => {
    await db.close();
    await rm(root, { recursive: true, force: true });
  });
  await db.exec(
    "CREATE TABLE account(id integer PRIMARY KEY, balance integer NOT NULL CHECK(balance>=0), note text); INSERT INTO account VALUES(1,10,'original'),(2,90,'untouched')",
  );
  const options: ManagedPostgresOptions = {
    workspace: "test",
    schema: "nomo_recovery",
    tables: [
      {
        table: "public.account",
        primaryKey: ["id"],
        columns: ["balance", "note"],
      },
    ],
    connect: async () => ({
      query: async <T>(sql: string, params?: readonly unknown[]) =>
        (await db.query<T>(sql, params ? [...params] : [])).rows,
      close: async () => {},
    }),
  };
  const installed = await installManagedPostgres(options);
  assert.deepEqual(installed, {
    installedTables: ["public.account"],
    metadataVersion: 2,
  });
  assert.deepEqual(await inspectManagedPostgres(options), {
    metadataVersion: 2,
    complete: true,
    legacyWithoutVersion: false,
  });
  const signer = await devKeyProvider({ dir: join(root, "keys"), env: {} }),
    runtimeOptions = {
      journal: localOperationJournal(join(root, "journal"), signer),
      vault: localRecoveryVault(
        join(root, "vault"),
        { first: randomBytes(32) },
        "first",
      ),
      adapters: [managedPostgresAdapter(options)],
      authorize: async () => true,
    };
  const request: ExecutionRequest = {
    workspace: "test",
    operationId: "op",
    agentId: "agent",
    runId: "run",
    adapterId: runtimeOptions.adapters[0]!.id,
    arguments: {
      table: "public.account",
      action: "update",
      key: { id: 1 },
      values: { balance: 20 },
    },
  };
  return { db, options, runtimeOptions, request };
}
test("managed PostgreSQL capture, write and outbox are integrated; restarted runtime restores exact rows", async (t) => {
  const f = await fixture(t),
    runtime = recoveryRuntime(f.runtimeOptions);
  assert.equal((await runtime.execute(f.request)).status, "succeeded");
  assert.equal(
    (
      await f.db.query<Record<string, unknown>>(
        "select count(*)::int as n from nomo_recovery.operations",
      )
    ).rows[0]?.n,
    1,
  );
  const fresh = recoveryRuntime({
    ...f.runtimeOptions,
    adapters: [managedPostgresAdapter(f.options)],
  });
  const plan = await fresh.planRecovery("test", "op");
  assert.equal(
    (await fresh.recover(plan, async () => true)).status,
    "restored",
  );
  assert.deepEqual(
    (
      await f.db.query<Record<string, unknown>>(
        "select * from account order by id",
      )
    ).rows,
    [
      { id: 1, balance: 10, note: "original" },
      { id: 2, balance: 90, note: "untouched" },
    ],
  );
  assert.equal(
    (await fresh.recover(plan, async () => true)).status,
    "restored",
  );
});

test("recovery job restores consecutive updates to one PostgreSQL primary key", async (t) => {
  const f = await fixture(t);
  const runtime = recoveryRuntime(f.runtimeOptions);
  await runtime.execute({
    ...f.request,
    operationId: "first-update",
    arguments: {
      table: "public.account",
      action: "update",
      key: { id: 1 },
      values: { balance: 20 },
    },
  });
  await runtime.execute({
    ...f.request,
    operationId: "second-update",
    arguments: {
      table: "public.account",
      action: "update",
      key: { id: 1 },
      values: { balance: 30 },
    },
  });
  const plan = await runtime.planRecoveryJob({
    workspace: "test",
    jobId: "same-row",
    selection: { kind: "run", runId: "run" },
  });
  assert.deepEqual(
    plan.steps.map((step) => step.operationId),
    ["second-update", "first-update"],
  );
  const result = await runtime.runRecoveryJob(
    "test",
    "same-row",
    async () => true,
  );
  assert.equal(result.status, "restored");
  assert.equal(result.outcomes.length, 2);
  assert.equal(
    (
      await f.db.query<{ balance: number }>(
        "select balance from account where id=1",
      )
    ).rows[0]?.balance,
    10,
  );
  assert.equal(
    (
      await f.db.query<{ n: number }>(
        "select count(*)::int as n from nomo_recovery.revisions",
      )
    ).rows[0]?.n,
    1,
  );
});

test("PostgreSQL continuation refuses same-value ABA between row inverses", async (t) => {
  const f = await fixture(t);
  const base = f.runtimeOptions.adapters[0]!;
  let recoverCount = 0;
  const adapter = {
    ...base,
    async recover(
      prepared: Parameters<typeof base.recover>[0],
      outcome: Parameters<typeof base.recover>[1],
      id: string,
    ) {
      const result = await base.recover(prepared, outcome, id);
      recoverCount++;
      if (recoverCount === 1)
        await f.db.exec("update account set balance=20 where id=1");
      return result;
    },
  };
  const runtime = recoveryRuntime({ ...f.runtimeOptions, adapters: [adapter] });
  await runtime.execute({
    ...f.request,
    operationId: "first-update",
    arguments: {
      table: "public.account",
      action: "update",
      key: { id: 1 },
      values: { balance: 20 },
    },
  });
  await runtime.execute({
    ...f.request,
    operationId: "second-update",
    arguments: {
      table: "public.account",
      action: "update",
      key: { id: 1 },
      values: { balance: 30 },
    },
  });
  await runtime.planRecoveryJob({
    workspace: "test",
    jobId: "aba",
    selection: { kind: "run", runId: "run" },
  });
  const result = await runtime.runRecoveryJob("test", "aba", async () => true);
  assert.equal(result.status, "conflict");
  assert.equal(
    (
      await f.db.query<{ balance: number }>(
        "select balance from account where id=1",
      )
    ).rows[0]?.balance,
    20,
  );
});

// The E0 acceptance asks for repeatedly updated rows restored within the
// declared transaction and trigger boundary, with a foreign concurrent update
// raising a conflict. Two updates are covered above; this is the mixed chain,
// where the row is updated, updated again and then deleted, so the inverses run
// as insert, update, update rather than the one shape already proved.
test("E0: a recovery job restores an update, update and delete chain on one row", async (t) => {
  const f = await fixture(t);
  const runtime = recoveryRuntime(f.runtimeOptions);
  await runtime.execute({
    ...f.request,
    operationId: "first-update",
    arguments: {
      table: "public.account",
      action: "update",
      key: { id: 1 },
      values: { balance: 20 },
    },
  });
  await runtime.execute({
    ...f.request,
    operationId: "second-update",
    arguments: {
      table: "public.account",
      action: "update",
      key: { id: 1 },
      values: { balance: 30 },
    },
  });
  await runtime.execute({
    ...f.request,
    operationId: "delete-row",
    arguments: { table: "public.account", action: "delete", key: { id: 1 } },
  });
  const plan = await recoveryRuntime(f.runtimeOptions).planRecoveryJob({
    workspace: "test",
    jobId: "row-journey",
    selection: { kind: "run", runId: "run" },
  });
  assert.deepEqual(
    plan.steps.map((step) => step.operationId),
    ["delete-row", "second-update", "first-update"],
  );
  const result = await recoveryRuntime(f.runtimeOptions).runRecoveryJob(
    "test",
    "row-journey",
    async () => true,
  );
  assert.deepEqual(result.residuals, []);
  assert.equal(result.status, "restored");
  // The row must come back with its original value, not merely with a row.
  assert.deepEqual(
    (await f.db.query("select id, balance, note from account where id=1")).rows,
    [{ id: 1, balance: 10, note: "original" }],
  );
  // The untouched row is evidence that the chain stayed inside its declared
  // scope rather than rewriting the table.
  assert.equal(
    (
      await f.db.query<{ balance: number }>(
        "select balance from account where id=2",
      )
    ).rows[0]?.balance,
    90,
  );
});

// The same chain with a foreign writer arriving between two inverses. The row
// must keep the foreign value, the job must say conflict rather than restored,
// and the untouched row must still be untouched.
test("E0: a concurrent write injected into a PostgreSQL chain conflicts and survives", async (t) => {
  const f = await fixture(t);
  const base = f.runtimeOptions.adapters[0]!;
  let inverses = 0;
  const adapter = {
    ...base,
    async recover(
      prepared: Parameters<typeof base.recover>[0],
      outcome: Parameters<typeof base.recover>[1],
      id: string,
    ) {
      const result = await base.recover(prepared, outcome, id);
      inverses++;
      if (inverses === 1)
        await f.db.exec("update account set balance=77 where id=1");
      return result;
    },
  };
  const runtimeOptions = { ...f.runtimeOptions, adapters: [adapter] };
  const runtime = recoveryRuntime(runtimeOptions);
  await runtime.execute({
    ...f.request,
    operationId: "first-update",
    arguments: {
      table: "public.account",
      action: "update",
      key: { id: 1 },
      values: { balance: 20 },
    },
  });
  await runtime.execute({
    ...f.request,
    operationId: "second-update",
    arguments: {
      table: "public.account",
      action: "update",
      key: { id: 1 },
      values: { balance: 30 },
    },
  });
  await recoveryRuntime(runtimeOptions).planRecoveryJob({
    workspace: "test",
    jobId: "concurrent",
    selection: { kind: "run", runId: "run" },
  });
  const result = await recoveryRuntime(runtimeOptions).runRecoveryJob(
    "test",
    "concurrent",
    async () => true,
  );
  assert.equal(result.status, "conflict");
  assert.equal(
    (
      await f.db.query<{ balance: number }>(
        "select balance from account where id=1",
      )
    ).rows[0]?.balance,
    77,
  );
  assert.ok(
    result.residuals.some(
      (residual: { status: string }) =>
        residual.status === "conflict" ||
        residual.status === "blocked-by-conflict",
    ),
    `expected a conflict residual, got ${JSON.stringify(result.residuals)}`,
  );
});

test("lost response after a chained PostgreSQL inverse reconciles the bound lineage after restart", async (t) => {
  const f = await fixture(t);
  const base = f.runtimeOptions.adapters[0]!;
  let recoveryCalls = 0;
  const adapter = {
    ...base,
    reconcileRecovery: undefined,
    async recoverWithContinuation(
      prepared: Parameters<typeof base.recover>[0],
      outcome: Parameters<typeof base.recover>[1],
      id: string,
      previous: Parameters<NonNullable<typeof base.recoverWithContinuation>>[3],
    ) {
      const result = await base.recoverWithContinuation!(
        prepared,
        outcome,
        id,
        previous,
      );
      recoveryCalls++;
      if (recoveryCalls === 1) throw new Error("response lost after commit");
      return result;
    },
  };
  const open = () =>
    recoveryRuntime({ ...f.runtimeOptions, adapters: [adapter] });
  const runtime = open();
  await runtime.execute({
    ...f.request,
    operationId: "first-update",
    arguments: {
      table: "public.account",
      action: "update",
      key: { id: 1 },
      values: { balance: 20 },
    },
  });
  await runtime.execute({
    ...f.request,
    operationId: "second-update",
    arguments: {
      table: "public.account",
      action: "update",
      key: { id: 1 },
      values: { balance: 30 },
    },
  });
  await runtime.planRecoveryJob({
    workspace: "test",
    jobId: "lost-lineage-receipt",
    selection: { kind: "run", runId: "run" },
  });
  assert.equal(
    (
      await runtime.runRecoveryJob(
        "test",
        "lost-lineage-receipt",
        async () => true,
      )
    ).status,
    "unknown",
  );

  const restarted = open();
  assert.equal(
    (await restarted.reconcileRecovery("test", "first-update")).status,
    "restored",
  );
  assert.equal(
    (
      await restarted.runRecoveryJob(
        "test",
        "lost-lineage-receipt",
        async () => false,
      )
    ).status,
    "restored",
  );
  assert.equal(recoveryCalls, 1);
  assert.equal(
    (
      await f.db.query<{ balance: number }>(
        "select balance from account where id=1",
      )
    ).rows[0]?.balance,
    10,
  );
});

test("managed PostgreSQL INSERT and DELETE restore supported row state", async (t) => {
  const f = await fixture(t),
    runtime = recoveryRuntime(f.runtimeOptions);
  for (const [operationId, action, key, values] of [
    ["insert", "insert", { id: 3 }, { balance: 30, note: "new" }],
    ["delete", "delete", { id: 1 }, {}],
  ] as const) {
    assert.equal(
      (
        await runtime.execute({
          ...f.request,
          operationId,
          arguments: { table: "public.account", action, key, values },
        })
      ).status,
      "succeeded",
    );
    assert.equal(
      (
        await runtime.recover(
          await runtime.planRecovery("test", operationId),
          async () => true,
        )
      ).status,
      "restored",
    );
  }
  assert.deepEqual(
    (
      await f.db.query<Record<string, unknown>>(
        "select id from account order by id",
      )
    ).rows,
    [{ id: 1 }, { id: 2 }],
  );
});
test("managed revision detects human ABA and preserves human writes", async (t) => {
  const f = await fixture(t),
    runtime = recoveryRuntime(f.runtimeOptions);
  await runtime.execute(f.request);
  await f.db.exec(
    "update account set balance=99 where id=1; update account set balance=20 where id=1",
  );
  assert.equal(
    (
      await runtime.recover(
        await runtime.planRecovery("test", "op"),
        async () => true,
      )
    ).status,
    "conflict",
  );
  assert.equal(
    (
      await f.db.query<Record<string, unknown>>(
        "select balance from account where id=1",
      )
    ).rows[0]?.balance,
    20,
  );
});
test("target drift during authorization blocks dispatch; constraints roll back mutation and receipt", async (t) => {
  const f = await fixture(t),
    runtime = recoveryRuntime({
      ...f.runtimeOptions,
      authorize: async () => {
        await f.db.exec("update account set balance=15 where id=1");
        return true;
      },
    });
  assert.equal((await runtime.execute(f.request)).status, "failed");
  assert.equal(
    (
      await f.db.query<Record<string, unknown>>(
        "select balance from account where id=1",
      )
    ).rows[0]?.balance,
    15,
  );
  assert.equal(
    (
      await f.db.query<Record<string, unknown>>(
        "select count(*)::int as n from nomo_recovery.operations",
      )
    ).rows[0]?.n,
    0,
  );
  const normal = recoveryRuntime(f.runtimeOptions);
  assert.equal(
    (
      await normal.execute({
        ...f.request,
        operationId: "invalid",
        arguments: {
          table: "public.account",
          action: "update",
          key: { id: 1 },
          values: { balance: -10 },
        },
      })
    ).status,
    "unknown",
  );
  assert.equal(
    (
      await f.db.query<Record<string, unknown>>(
        "select balance from account where id=1",
      )
    ).rows[0]?.balance,
    15,
  );
});
test("lost PostgreSQL commit response reconciles from transactionally stored outcome without retry", async (t) => {
  const f = await fixture(t),
    adapter = f.runtimeOptions.adapters[0]!,
    execute = adapter.execute;
  adapter.execute = async (...args) => {
    await execute(...args);
    throw new Error("lost response");
  };
  const runtime = recoveryRuntime(f.runtimeOptions);
  assert.equal((await runtime.execute(f.request)).status, "unknown");
  const fresh = recoveryRuntime({
    ...f.runtimeOptions,
    adapters: [managedPostgresAdapter(f.options)],
  });
  assert.equal((await fresh.reconcile("test", "op")).status, "succeeded");
  assert.equal(
    (
      await f.db.query<Record<string, unknown>>(
        "select count(*)::int as n from nomo_recovery.operations",
      )
    ).rows[0]?.n,
    1,
  );
});
test("disabled revision trigger fails closed before mutation", async (t) => {
  const f = await fixture(t);
  await f.db.exec("ALTER TABLE account DISABLE TRIGGER USER");
  assert.equal(
    (await recoveryRuntime(f.runtimeOptions).execute(f.request)).status,
    "failed",
  );
  assert.equal(
    (
      await f.db.query<Record<string, unknown>>(
        "select balance from account where id=1",
      )
    ).rows[0]?.balance,
    10,
  );
});
test("lost recovery response reconciles durable receipt after restart without a second inverse", async (t) => {
  const f = await fixture(t),
    adapter = f.runtimeOptions.adapters[0]!,
    recover = adapter.recover;
  const runtime = recoveryRuntime(f.runtimeOptions);
  await runtime.execute(f.request);
  const plan = await runtime.planRecovery("test", "op");
  adapter.recover = async (...args) => {
    await recover(...args);
    throw new Error("lost recovery response");
  };
  assert.equal(
    (await runtime.recover(plan, async () => true)).status,
    "unknown",
  );
  const fresh = recoveryRuntime({
    ...f.runtimeOptions,
    adapters: [managedPostgresAdapter(f.options)],
  });
  assert.equal(
    (await fresh.reconcileRecovery("test", "op")).status,
    "restored",
  );
  assert.equal(
    (await fresh.reconcileRecovery("test", "op")).status,
    "restored",
  );
  assert.equal(
    (await fresh.recover(plan, async () => true)).status,
    "restored",
  );
  assert.equal(
    (
      await f.db.query<Record<string, unknown>>(
        "select count(*)::int as n from nomo_recovery.recoveries",
      )
    ).rows[0]?.n,
    1,
  );
  assert.equal(
    (
      await f.db.query<Record<string, unknown>>(
        "select balance from account where id=1",
      )
    ).rows[0]?.balance,
    10,
  );
});
test("uncertified row-level security refuses execution even for an owner that bypasses policies", async (t) => {
  const f = await fixture(t);
  await f.db.exec("ALTER TABLE account ENABLE ROW LEVEL SECURITY");
  assert.equal(
    (await recoveryRuntime(f.runtimeOptions).execute(f.request)).status,
    "failed",
  );
  assert.equal(
    (
      await f.db.query<Record<string, unknown>>(
        "select balance from account where id=1",
      )
    ).rows[0]?.balance,
    10,
  );
});

test("managed PostgreSQL metadata migration is explicit, transactional and idempotent", async (t) => {
  const db = new PGlite();
  t.after(() => db.close());
  await db.exec(
    "CREATE TABLE account(id integer PRIMARY KEY, balance integer NOT NULL); CREATE SCHEMA nomo_recovery; CREATE TABLE nomo_recovery.meta(key text PRIMARY KEY, version integer NOT NULL); CREATE TABLE nomo_recovery.revisions(resource text PRIMARY KEY, revision bigint NOT NULL); CREATE TABLE nomo_recovery.operations(id text PRIMARY KEY, request_digest text NOT NULL, capture jsonb NOT NULL, outcome jsonb NOT NULL); CREATE TABLE nomo_recovery.recoveries(id text PRIMARY KEY, input_digest text NOT NULL, outcome jsonb NOT NULL); INSERT INTO nomo_recovery.meta VALUES('version',1)",
  );
  const options: ManagedPostgresOptions = {
    workspace: "test",
    schema: "nomo_recovery",
    tables: [
      {
        table: "public.account",
        primaryKey: ["id"],
        columns: ["balance"],
      },
    ],
    connect: async () => ({
      query: async <T>(sql: string, params?: readonly unknown[]) =>
        (await db.query<T>(sql, params ? [...params] : [])).rows,
      close: async () => {},
    }),
  };
  assert.deepEqual(await inspectManagedPostgres(options), {
    metadataVersion: 1,
    complete: false,
    legacyWithoutVersion: false,
  });
  await assert.rejects(
    installManagedPostgres(options),
    /explicit migration|review/i,
  );
  assert.deepEqual(await migrateManagedPostgres(options), {
    fromVersion: 1,
    metadataVersion: 2,
  });
  assert.deepEqual(await migrateManagedPostgres(options), {
    fromVersion: 2,
    metadataVersion: 2,
  });
  assert.deepEqual(await inspectManagedPostgres(options), {
    metadataVersion: 2,
    complete: true,
    legacyWithoutVersion: false,
  });
});

test("managed PostgreSQL deletes and restores exact configured cascade descendants", async (t) => {
  const db = new PGlite();
  t.after(() => db.close());
  await db.exec(
    "CREATE TABLE parent(id integer PRIMARY KEY, label text NOT NULL); CREATE TABLE child(id integer PRIMARY KEY, parent_id integer NOT NULL REFERENCES parent(id) ON DELETE CASCADE, label text NOT NULL); CREATE TABLE grandchild(id integer PRIMARY KEY, child_id integer NOT NULL REFERENCES child(id) ON DELETE CASCADE, label text NOT NULL); INSERT INTO parent VALUES(1,'remove'),(2,'keep'); INSERT INTO child VALUES(10,1,'remove-child'),(20,2,'keep-child'); INSERT INTO grandchild VALUES(100,10,'remove-grandchild'),(200,20,'keep-grandchild')",
  );
  const options: ManagedPostgresOptions = {
    workspace: "test",
    schema: "nomo_recovery",
    tables: [
      { table: "public.parent", primaryKey: ["id"], columns: ["label"] },
      {
        table: "public.child",
        primaryKey: ["id"],
        columns: ["parent_id", "label"],
      },
      {
        table: "public.grandchild",
        primaryKey: ["id"],
        columns: ["child_id", "label"],
      },
    ],
    connect: async () => ({
      query: async <T>(sql: string, params?: readonly unknown[]) =>
        (await db.query<T>(sql, params ? [...params] : [])).rows,
      close: async () => {},
    }),
  };
  await installManagedPostgres(options);
  const adapter = managedPostgresAdapter(options);
  const input = {
    table: "public.parent",
    action: "delete",
    key: { id: 1 },
    values: {},
  };
  const observation = await adapter.preflight(input);
  assert.deepEqual(observation.blastRadius, { count: 3, precision: "exact" });
  const prepared = await adapter.prepare(input, observation, "cascade");
  const outcome = await adapter.execute(input, prepared, "cascade");
  assert.deepEqual((await db.query("SELECT id FROM parent ORDER BY id")).rows, [
    { id: 2 },
  ]);
  assert.deepEqual((await db.query("SELECT id FROM child ORDER BY id")).rows, [
    { id: 20 },
  ]);
  assert.deepEqual(
    (await db.query("SELECT id FROM grandchild ORDER BY id")).rows,
    [{ id: 200 }],
  );
  assert.equal(
    (await adapter.recover(prepared, outcome, "cascade-recovery")).status,
    "restored",
  );
  assert.deepEqual((await db.query("SELECT * FROM parent ORDER BY id")).rows, [
    { id: 1, label: "remove" },
    { id: 2, label: "keep" },
  ]);
  assert.deepEqual((await db.query("SELECT * FROM child ORDER BY id")).rows, [
    { id: 10, parent_id: 1, label: "remove-child" },
    { id: 20, parent_id: 2, label: "keep-child" },
  ]);
  assert.deepEqual(
    (await db.query("SELECT * FROM grandchild ORDER BY id")).rows,
    [
      { id: 100, child_id: 10, label: "remove-grandchild" },
      { id: 200, child_id: 20, label: "keep-grandchild" },
    ],
  );
});

test("managed PostgreSQL binds tenant RLS to a server setting and rejects cross-tenant recovery", async (t) => {
  const db = new PGlite();
  t.after(() => db.close());
  await db.exec(
    "CREATE TABLE account(id integer PRIMARY KEY, tenant_id text NOT NULL, balance integer NOT NULL); INSERT INTO account VALUES(1,'tenant-a',10),(2,'tenant-b',20); ALTER TABLE account ENABLE ROW LEVEL SECURITY; CREATE POLICY tenant_scope ON account USING (tenant_id=current_setting('void.tenant_id',true)) WITH CHECK (tenant_id=current_setting('void.tenant_id',true))",
  );
  await db.query("SELECT set_config('void.tenant_id','tenant-a',false)");
  const options: ManagedPostgresOptions = {
    workspace: "test",
    schema: "nomo_recovery",
    tenant: { column: "tenant_id", setting: "void.tenant_id" },
    tables: [
      {
        table: "public.account",
        primaryKey: ["id"],
        columns: ["balance"],
      },
    ],
    connect: async () => ({
      query: async <T>(sql: string, params?: readonly unknown[]) =>
        (await db.query<T>(sql, params ? [...params] : [])).rows,
      close: async () => {},
    }),
  };
  await installManagedPostgres(options);
  const adapter = managedPostgresAdapter(options);
  const input = {
    table: "public.account",
    action: "update",
    key: { id: 1 },
    values: { balance: 11 },
  };
  const observation = await adapter.preflight(input);
  const prepared = await adapter.prepare(input, observation, "tenant");
  const outcome = await adapter.execute(input, prepared, "tenant");
  assert.equal(
    (
      await db.query<{ balance: number }>(
        "SELECT balance FROM account WHERE id=1",
      )
    ).rows[0]?.balance,
    11,
  );
  assert.equal(
    (
      await db.query<{ balance: number }>(
        "SELECT balance FROM account WHERE id=2",
      )
    ).rows[0]?.balance,
    20,
  );
  await assert.rejects(
    adapter.preflight({
      ...input,
      key: { id: 2 },
      values: { balance: 21 },
    }),
    /tenant|scope/i,
  );
  await db.query("SELECT set_config('void.tenant_id','tenant-b',false)");
  await assert.rejects(
    adapter.recover(prepared, outcome, "tenant-recovery"),
    /tenant|scope/i,
  );
  await db.query("SELECT set_config('void.tenant_id','tenant-a',false)");
  assert.equal(
    (await adapter.recover(prepared, outcome, "tenant-recovery")).status,
    "restored",
  );
});
test("a managed PostgreSQL observation names the rows it read at the revision it read them", async (t) => {
  const f = await fixture(t);
  const adapter = managedPostgresAdapter(f.options);
  const before = await adapter.preflight(f.request.arguments);
  // The read set is the capture, not a declaration: the same row the
  // observation will write, at the revision the metadata ledger holds for it.
  assert.deepEqual(before.reads, [
    { resource: before.resources[0], revision: "0" },
  ]);
  assert.equal(
    (await recoveryRuntime(f.runtimeOptions).execute(f.request)).status,
    "succeeded",
  );
  const after = await adapter.preflight(f.request.arguments);
  // The revision moved with the write, which is what lets a plan order two
  // operations on one row instead of assuming it.
  assert.deepEqual(after.reads, [
    { resource: after.resources[0], revision: "1" },
  ]);
});

// Issue #47: `prepare` certifies the receipt layout inside its SERIALIZABLE
// transaction, but it locks the target rows rather than the metadata tables,
// and `execute` reuses that same transaction from the same connection. Between
// the two calls the layout can drift, so the check `execute` was leaning on is
// only as old as `prepare`. PGlite is a single in-process connection and cannot
// run two sessions, so the drift is planted on the adapter's own still-open
// transaction; these are the statements a second session would commit, and what
// `execute` does with a receipt layout that no longer matches does not depend
// on who wrote the DDL. This is fixture evidence, not two-session certification.
for (const [name, drift] of [
  [
    "an extra constraint",
    "ALTER TABLE nomo_recovery.operations ADD CONSTRAINT drift_receipt CHECK(length(id)>0)",
  ],
  [
    "a replaced format_version default",
    "ALTER TABLE nomo_recovery.operations ALTER COLUMN format_version SET DEFAULT 1",
  ],
  ["a downgraded metadata version", "UPDATE nomo_recovery.meta SET version=1"],
] as const) {
  test(`execute refuses a receipt layout changed by ${name} between prepare and execute`, async (t) => {
    const f = await fixture(t);
    const adapter = managedPostgresAdapter(f.options);
    const input = f.request.arguments;
    // The layout is the installed one here: `prepare` passes its own
    // re-certification, so only drift after it can be the thing refused.
    const prepared = await adapter.prepare(
      input,
      await adapter.preflight(input),
      "op",
    );
    await f.db.exec(drift);
    await assert.rejects(
      adapter.execute(input, prepared, "op"),
      /receipt/i,
      "execute must re-check the receipt layout under the lock it already holds",
    );
    await adapter.release("op");
    assert.equal(
      (
        await f.db.query<Record<string, unknown>>(
          "SELECT balance FROM account WHERE id=1",
        )
      ).rows[0]?.balance,
      10,
      "a refused receipt layout must not leave the business mutation committed",
    );
    assert.equal(
      (
        await f.db.query<Record<string, unknown>>(
          "SELECT count(*)::int AS n FROM nomo_recovery.operations",
        )
      ).rows[0]?.n,
      0,
    );
  });
}

// Opt-in real PostgreSQL test. Creates and removes only unique test-owned schemas.
import assert from "node:assert/strict";
import net from "node:net";
import { fork } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import { Pool, neonConfig } from "@neondatabase/serverless";
import {
  managedPostgresAdapter,
  installManagedPostgres,
} from "../../packages/connectors/src/postgres/managed.ts";
import {
  recoveryRuntime,
  localOperationJournal,
  reservedRecoveryVault,
} from "../../packages/runtime/src/index.ts";
import { devKeyProvider } from "../../packages/ledger/src/sign.ts";
assert.equal(
  process.env.VOID_RECOVERY_DATABASE_TEST,
  "1",
  "Explicit isolated test opt-in required.",
);
const url = new URL(process.env.DATABASE_URL);
assert.equal(
  url.pathname,
  "/void_gui_upgrade_preview",
  "Production databases are forbidden.",
);
assert.ok(
  !url.hostname.includes("-pooler"),
  "Use a direct connection for this test.",
);
neonConfig.webSocketConstructor = WebSocket;
const pool = new Pool({
  connectionString: url.href,
  max: 3,
  connectionTimeoutMillis: 10000,
  idleTimeoutMillis: 1000,
});
const suffix = randomBytes(8).toString("hex"),
  schema = "qa_recovery_" + suffix,
  metadata = "qa_recovery_meta_" + suffix,
  abaMetadata = "qa_recovery_aba_" + suffix,
  freshRaceMetadata = "qa_recovery_fresh_race_" + suffix,
  ruleMetadata = "qa_recovery_rule_" + suffix,
  defaultMetadata = "qa_recovery_default_" + suffix,
  nullDefaultMetadata = "qa_recovery_null_default_" + suffix;
const root = await mkdtemp(join(tmpdir(), "void-real-postgres-"));
const connect = async () => {
  const c = await pool.connect();
  // Terminated test backends may report an asynchronous driver error.
  let broken = false;
  const onError = () => {
    broken = true;
  };
  c.on("error", onError);
  return {
    query: async (sql, params) => (await c.query(sql, params)).rows,
    close: async () => {
      c.release(broken);
      c.removeListener("error", onError);
    },
  };
};
const db = await connect();
let created = false;
try {
  await db.query(`CREATE SCHEMA "${schema}"`);
  created = true;
  await db.query(
    `CREATE TABLE "${schema}".account(id integer PRIMARY KEY,balance integer NOT NULL CHECK(balance>=0)); INSERT INTO "${schema}".account VALUES(1,10),(2,90)`,
  );
  const options = {
    workspace: "qa-test",
    schema: metadata,
    tables: [
      { table: schema + ".account", primaryKey: ["id"], columns: ["balance"] },
    ],
    connect,
  };
  await installManagedPostgres(options);

  const ruleOptions = { ...options, schema: ruleMetadata, tables: [] };
  await installManagedPostgres(ruleOptions);
  await db.query(
    `CREATE RULE suppress_receipt AS ON INSERT TO "${ruleMetadata}".operations DO INSTEAD NOTHING`,
  );
  await assert.rejects(
    installManagedPostgres(ruleOptions),
    /malformed|structure/i,
  );
  assert.deepEqual(
    await db.query(
      `SELECT rulename FROM pg_rewrite WHERE ev_class='"${ruleMetadata}".operations'::regclass`,
    ),
    [{ rulename: "suppress_receipt" }],
  );

  const defaultOptions = { ...options, schema: defaultMetadata, tables: [] };
  await installManagedPostgres(defaultOptions);
  await db.query(
    `ALTER TABLE "${defaultMetadata}".operations ALTER COLUMN format_version SET DEFAULT (2 + floor(random())::integer)`,
  );
  await assert.rejects(
    installManagedPostgres(defaultOptions),
    /malformed|structure/i,
  );
  const poisonedDefault = await db.query(
    `SELECT column_default FROM information_schema.columns WHERE table_schema=$1 AND table_name='operations' AND column_name='format_version'`,
    [defaultMetadata],
  );
  assert.equal(poisonedDefault.length, 1);
  assert.notEqual(poisonedDefault[0].column_default.trim(), "2");

  const nullDefaultOptions = {
    ...options,
    schema: nullDefaultMetadata,
    tables: [],
  };
  await installManagedPostgres(nullDefaultOptions);
  await db.query(
    `ALTER TABLE "${nullDefaultMetadata}".operations ALTER COLUMN capture SET DEFAULT '{}'::jsonb`,
  );
  await assert.rejects(
    installManagedPostgres(nullDefaultOptions),
    /malformed|structure/i,
  );
  const unexpectedDefault = await db.query(
    `SELECT column_default FROM information_schema.columns WHERE table_schema=$1 AND table_name='operations' AND column_name='capture'`,
    [nullDefaultMetadata],
  );
  assert.equal(unexpectedDefault.length, 1);
  assert.notEqual(unexpectedDefault[0].column_default, null);

  const abaOptions = { ...options, schema: abaMetadata, tables: [] };
  await installManagedPostgres(abaOptions);
  await db.query(`INSERT INTO "${abaMetadata}".operations(id,request_digest,capture,outcome) VALUES('sentinel','digest','{}','{}');
    INSERT INTO "${abaMetadata}".recoveries(id,input_digest,outcome) VALUES('sentinel','digest','{}')`);
  let beginSeenResolve, continueInstallResolve;
  const beginSeen = new Promise((resolve) => {
    beginSeenResolve = resolve;
  });
  const continueInstall = new Promise((resolve) => {
    continueInstallResolve = resolve;
  });
  const guardedOptions = {
    ...abaOptions,
    connect: async () => {
      const connection = await connect();
      return {
        query: async (sql, params) => {
          if (sql.trim() === "BEGIN") {
            beginSeenResolve();
            await continueInstall;
          }
          return connection.query(sql, params);
        },
        close: () => connection.close(),
      };
    },
  };
  const guardedInstall = installManagedPostgres(guardedOptions);
  await beginSeen;
  const replacer = await connect();
  try {
    await replacer.query(`DROP SCHEMA "${abaMetadata}" CASCADE;
      CREATE SCHEMA "${abaMetadata}";
      CREATE TABLE "${abaMetadata}".meta(key text PRIMARY KEY,version integer NOT NULL);
      CREATE TABLE "${abaMetadata}".revisions(resource text PRIMARY KEY,revision bigint NOT NULL);
      CREATE TABLE "${abaMetadata}".operations(id text PRIMARY KEY,request_digest text NOT NULL,capture jsonb NOT NULL,outcome jsonb NOT NULL,format_version integer NOT NULL DEFAULT 2);
      CREATE TABLE "${abaMetadata}".recoveries(id text PRIMARY KEY,input_digest text NOT NULL,outcome jsonb NOT NULL,format_version integer NOT NULL DEFAULT 2);
      INSERT INTO "${abaMetadata}".meta VALUES('version',2)`);
  } finally {
    await replacer.close();
    continueInstallResolve();
  }
  await assert.rejects(guardedInstall, /identity changed/i);
  assert.deepEqual(
    await db.query(
      `SELECT count(*)::int AS count FROM "${abaMetadata}".operations`,
    ),
    [{ count: 0 }],
  );
  assert.deepEqual(
    await db.query(
      `SELECT count(*)::int AS count FROM "${abaMetadata}".recoveries`,
    ),
    [{ count: 0 }],
  );
  assert.deepEqual(
    await db.query(
      `SELECT count(*)::int AS count FROM pg_trigger WHERE tgname LIKE 'void_revision_%' AND tgrelid='"${schema}".account'::regclass`,
    ),
    [{ count: 1 }],
  );

  await db.query(`CREATE SCHEMA "${freshRaceMetadata}"`);
  let createSeenResolve, continueFreshResolve;
  const createSeen = new Promise((resolve) => {
    createSeenResolve = resolve;
  });
  const continueFresh = new Promise((resolve) => {
    continueFreshResolve = resolve;
  });
  const freshRaceOptions = {
    ...options,
    schema: freshRaceMetadata,
    tables: [],
    connect: async () => {
      const connection = await connect();
      return {
        query: async (sql, params) => {
          if (sql.includes("CREATE TABLE") && sql.includes(".meta")) {
            createSeenResolve();
            await continueFresh;
          }
          return connection.query(sql, params);
        },
        close: () => connection.close(),
      };
    },
  };
  const freshInstall = installManagedPostgres(freshRaceOptions);
  await createSeen;
  const freshRacer = await connect();
  try {
    await freshRacer.query(`CREATE TABLE "${freshRaceMetadata}".meta(key text PRIMARY KEY,version integer NOT NULL);
      CREATE TABLE "${freshRaceMetadata}".revisions(resource text PRIMARY KEY,revision bigint NOT NULL);
      CREATE TABLE "${freshRaceMetadata}".operations(id text PRIMARY KEY,request_digest text NOT NULL,capture jsonb NOT NULL,outcome jsonb NOT NULL,format_version integer NOT NULL DEFAULT 2);
      CREATE TABLE "${freshRaceMetadata}".recoveries(id text PRIMARY KEY,input_digest text NOT NULL,outcome jsonb NOT NULL,format_version integer NOT NULL DEFAULT 2);
      INSERT INTO "${freshRaceMetadata}".meta VALUES('version',2)`);
  } finally {
    await freshRacer.close();
    continueFreshResolve();
  }
  await assert.rejects(freshInstall, /already exists|duplicate/i);

  const keyDir = join(root, "keys"),
    journalDir = join(root, "journal"),
    vaultDir = join(root, "vault"),
    vaultKey = randomBytes(32),
    signer = await devKeyProvider({ dir: keyDir, env: {} });
  const base = {
    journal: localOperationJournal(journalDir, signer),
    vault: reservedRecoveryVault(vaultDir, { test: vaultKey }, "test"),
    authorize: async () => true,
  };
  let adapter = managedPostgresAdapter(options),
    runtime = recoveryRuntime({ ...base, adapters: [adapter] });
  const request = {
    workspace: "qa-test",
    operationId: randomUUID(),
    agentId: "test-agent",
    runId: "test-run",
    adapterId: adapter.id,
    arguments: {
      table: schema + ".account",
      action: "update",
      key: { id: 1 },
      values: { balance: 20 },
    },
  };
  const crashWorker = async (mode, input) => {
    const child = fork(
      new URL("./fixtures/managed-postgres-crash-worker.mjs", import.meta.url),
      [],
      {
        stdio: ["ignore", "inherit", "inherit", "ipc"],
        env: {
          ...process.env,
          VOID_POSTGRES_CRASH_CONFIG: JSON.stringify({
            mode,
            workspace: options.workspace,
            metadata: options.schema,
            tables: options.tables,
            keyDir,
            journalDir,
            vaultDir,
            vaultKey: vaultKey.toString("hex"),
            ...input,
          }),
        },
      },
    );
    try {
      const [message] = await Promise.race([
        once(child, "message"),
        new Promise((_, reject) =>
          setTimeout(
            () => reject(new Error("PostgreSQL crash worker timed out.")),
            20000,
          ).unref(),
        ),
      ]);
      assert.deepEqual(message, { stage: "committed", mode });
      child.kill("SIGKILL");
      const [code, signal] = await once(child, "exit");
      assert.equal(code, null);
      assert.equal(signal, "SIGKILL");
    } finally {
      if (child.exitCode === null && child.signalCode === null)
        child.kill("SIGKILL");
    }
  };
  assert.equal((await runtime.execute(request)).status, "succeeded");
  adapter = managedPostgresAdapter(options);
  runtime = recoveryRuntime({ ...base, adapters: [adapter] });
  let plan = await runtime.planRecovery("qa-test", request.operationId);
  assert.equal(
    (await runtime.recover(plan, async () => true)).status,
    "restored",
  );
  assert.deepEqual(
    await db.query(`SELECT * FROM "${schema}".account ORDER BY id`),
    [
      { id: 1, balance: 10 },
      { id: 2, balance: 90 },
    ],
  );
  assert.equal(
    (await runtime.recover(plan, async () => true)).status,
    "restored",
  );
  const second = { ...request, operationId: randomUUID() };
  assert.equal((await runtime.execute(second)).status, "succeeded");
  await db.query(
    `UPDATE "${schema}".account SET balance=99 WHERE id=1; UPDATE "${schema}".account SET balance=20 WHERE id=1`,
  );
  plan = await runtime.planRecovery("qa-test", second.operationId);
  assert.equal(
    (await runtime.recover(plan, async () => true)).status,
    "conflict",
  );
  const third = {
    ...request,
    operationId: randomUUID(),
    arguments: { ...request.arguments, values: { balance: 30 } },
  };
  const execute = adapter.execute;
  adapter.execute = async (...args) => {
    await execute(...args);
    throw new Error("Injected lost commit response");
  };
  assert.equal((await runtime.execute(third)).status, "unknown");
  runtime = recoveryRuntime({
    ...base,
    adapters: [managedPostgresAdapter(options)],
  });
  assert.equal(
    (await runtime.reconcile("qa-test", third.operationId)).status,
    "succeeded",
  );
  assert.equal(
    (
      await runtime.recover(
        await runtime.planRecovery("qa-test", third.operationId),
        async () => true,
      )
    ).status,
    "restored",
  );
  // Force a real SERIALIZABLE conflict during prepare: the human commits
  // after the executor has read its snapshot but before SELECT FOR UPDATE.
  const human = await connect();
  let reached, proceed, seenCode;
  const preparing = new Promise((resolve) => {
      reached = resolve;
    }),
    resume = new Promise((resolve) => {
      proceed = resolve;
    });
  const concurrentOptions = {
    ...options,
    connect: async () => {
      const c = await connect();
      return {
        close: c.close,
        query: async (sql, params) => {
          if (sql.includes("FOR UPDATE")) {
            await c.query(`SELECT balance FROM "${schema}".account WHERE id=1`);
            reached();
            await resume;
          }
          try {
            return await c.query(sql, params);
          } catch (error) {
            seenCode = error.code;
            throw error;
          }
        },
      };
    },
  };
  try {
    await human.query("BEGIN");
    await human.query(`UPDATE "${schema}".account SET balance=40 WHERE id=1`);
    const operation = recoveryRuntime({
      ...base,
      adapters: [managedPostgresAdapter(concurrentOptions)],
    }).execute({ ...request, operationId: randomUUID() });
    await Promise.race([
      preparing,
      new Promise((_, reject) =>
        setTimeout(
          () => reject(new Error("Prepare synchronization timed out")),
          15000,
        ).unref(),
      ),
    ]);
    await human.query("COMMIT");
    proceed();
    assert.equal((await operation).status, "failed");
    assert.equal(seenCode, "40001");
    assert.equal(
      (await db.query(`SELECT balance FROM "${schema}".account WHERE id=1`))[0]
        .balance,
      40,
    );
  } finally {
    proceed();
    await human.query("ROLLBACK").catch(() => {});
    await human.close();
  }
  console.log(
    "PASS: existing capture, restore, ABA and serialization scenarios",
  );
  // Terminate only a backend acquired by this fixture. Probe the dead connection
  // to make the adapter observe a real driver failure at the commit boundary.
  function terminatedAdapter(phase) {
    let armed = true;
    return managedPostgresAdapter({
      ...options,
      connect: async () => {
        const c = await connect();
        const [{ pid }] = await c.query("SELECT pg_backend_pid() AS pid");
        return {
          close: c.close,
          query: async (sql, params) => {
            if (sql !== "COMMIT" || !armed) return c.query(sql, params);
            armed = false;
            if (phase === "after") await c.query(sql, params);
            const [{ terminated }] = await db.query(
              "SELECT pg_terminate_backend($1) AS terminated",
              [pid],
            );
            assert.equal(terminated, true);
            // Before COMMIT this rolls back both mutation and database receipt.
            return c.query(phase === "after" ? "SELECT 1" : sql, params);
          },
        };
      },
    });
  }
  const balance = async () =>
    (await db.query(`SELECT balance FROM "${schema}".account WHERE id=1`))[0]
      .balance;
  const receipts = async (table) =>
    Number(
      (
        await db.query(`SELECT count(*) AS count FROM "${metadata}".${table}`)
      )[0].count,
    );
  for (const phase of ["before", "after"]) {
    const beforeCount = await receipts("operations");
    const operation = {
      ...request,
      operationId: randomUUID(),
      arguments: { ...request.arguments, values: { balance: 50 } },
    };
    const faulty = recoveryRuntime({
      ...base,
      adapters: [terminatedAdapter(phase)],
    });
    assert.equal((await faulty.execute(operation)).status, "unknown");
    assert.equal(await balance(), phase === "after" ? 50 : 40);
    assert.equal(
      await receipts("operations"),
      beforeCount + (phase === "after" ? 1 : 0),
    );
    const restarted = recoveryRuntime({
      ...base,
      adapters: [managedPostgresAdapter(options)],
    });
    // A repeated caller never redispatches the uncertain operation.
    assert.equal((await restarted.execute(operation)).status, "unknown");
    assert.equal(
      (await restarted.reconcile("qa-test", operation.operationId)).status,
      phase === "after" ? "succeeded" : "unknown",
    );
    if (phase === "after") {
      assert.equal(
        (
          await restarted.recover(
            await restarted.planRecovery("qa-test", operation.operationId),
            async () => true,
          )
        ).status,
        "restored",
      );
    } else {
      await assert.rejects(
        restarted.planRecovery("qa-test", operation.operationId),
      );
    }
    assert.equal(await balance(), 40);
    console.log(`PASS: backend termination ${phase} commit`);
    await base.journal.transaction("qa-test", async (tx) => {
      assert.equal(
        tx.events.filter(
          (e) =>
            e.operationId === operation.operationId && e.stage === "dispatched",
        ).length,
        1,
      );
    });
  }
  // Recovery itself can commit while its acknowledgement is lost.
  const recoveryOperation = {
    ...request,
    operationId: randomUUID(),
    arguments: { ...request.arguments, values: { balance: 60 } },
  };
  runtime = recoveryRuntime({
    ...base,
    adapters: [managedPostgresAdapter(options)],
  });
  assert.equal((await runtime.execute(recoveryOperation)).status, "succeeded");
  plan = await runtime.planRecovery("qa-test", recoveryOperation.operationId);
  const recoveryCount = await receipts("recoveries");
  const faultyRecovery = recoveryRuntime({
    ...base,
    adapters: [terminatedAdapter("after")],
  });
  assert.equal(
    (await faultyRecovery.recover(plan, async () => true)).status,
    "unknown",
  );
  assert.equal(await balance(), 40);
  assert.equal(await receipts("recoveries"), recoveryCount + 1);
  runtime = recoveryRuntime({
    ...base,
    adapters: [managedPostgresAdapter(options)],
  });
  assert.equal(
    (await runtime.reconcileRecovery("qa-test", recoveryOperation.operationId))
      .status,
    "restored",
  );
  assert.equal(
    (await runtime.recover(plan, async () => true)).status,
    "restored",
  );
  assert.equal(await receipts("recoveries"), recoveryCount + 1);

  console.log("PASS: recovery commit termination and receipt reconciliation");

  const crashedForward = {
    ...request,
    operationId: randomUUID(),
    arguments: { ...request.arguments, values: { balance: 65 } },
  };
  const operationCount = await receipts("operations");
  await crashWorker("forward", { request: crashedForward });
  assert.equal(await balance(), 65);
  assert.equal(await receipts("operations"), operationCount + 1);
  runtime = recoveryRuntime({
    ...base,
    adapters: [managedPostgresAdapter(options)],
  });
  assert.equal((await runtime.execute(crashedForward)).status, "unknown");
  assert.equal(
    (await runtime.reconcile("qa-test", crashedForward.operationId)).status,
    "succeeded",
  );
  assert.equal(
    (
      await runtime.recover(
        await runtime.planRecovery("qa-test", crashedForward.operationId),
        async () => true,
      )
    ).status,
    "restored",
  );
  assert.equal(await balance(), 40);
  assert.equal(await receipts("operations"), operationCount + 1);
  await base.journal.transaction("qa-test", async (tx) => {
    assert.equal(
      tx.events.filter(
        (event) =>
          event.operationId === crashedForward.operationId &&
          event.stage === "dispatched",
      ).length,
      1,
    );
  });
  console.log("PASS: client SIGKILL after forward commit");

  const crashedRecovery = {
    ...request,
    operationId: randomUUID(),
    arguments: { ...request.arguments, values: { balance: 66 } },
  };
  assert.equal((await runtime.execute(crashedRecovery)).status, "succeeded");
  const crashedPlan = await runtime.planRecovery(
      "qa-test",
      crashedRecovery.operationId,
    ),
    recoveryReceiptCount = await receipts("recoveries");
  await crashWorker("recovery", { plan: crashedPlan });
  assert.equal(await balance(), 40);
  assert.equal(await receipts("recoveries"), recoveryReceiptCount + 1);
  runtime = recoveryRuntime({
    ...base,
    adapters: [managedPostgresAdapter(options)],
  });
  assert.equal(
    (await runtime.reconcileRecovery("qa-test", crashedRecovery.operationId))
      .status,
    "restored",
  );
  assert.equal(
    (await runtime.recover(crashedPlan, async () => true)).status,
    "restored",
  );
  assert.equal(await receipts("recoveries"), recoveryReceiptCount + 1);
  await base.journal.transaction("qa-test", async (tx) => {
    assert.equal(
      tx.events.filter(
        (event) =>
          event.operationId === crashedRecovery.operationId &&
          event.stage === "recovery-dispatched",
      ).length,
      1,
    );
  });
  console.log("PASS: client SIGKILL after recovery commit");

  // Create a real lock cycle while the managed adapter is dispatching. PostgreSQL
  // chooses the victim; assert the correct behavior for either valid selection.
  const competitor = await connect();
  let blocked, managedCode;
  const atDispatch = new Promise((resolve) => {
    blocked = resolve;
  });
  const deadlockAdapter = managedPostgresAdapter({
    ...options,
    connect: async () => {
      const c = await connect();
      return {
        close: c.close,
        query: async (sql, params) => {
          try {
            if (sql.startsWith(`UPDATE "${schema}"."account" SET`)) {
              blocked();
              await c.query(
                `SELECT id FROM "${schema}".account WHERE id=2 FOR UPDATE`,
              );
            }
            const result = await c.query(sql, params);
            if (sql.startsWith("BEGIN"))
              await c.query("SET LOCAL statement_timeout='8s'");
            return result;
          } catch (error) {
            managedCode = error.code;
            throw error;
          }
        },
      };
    },
  });
  try {
    await competitor.query("BEGIN; SET LOCAL statement_timeout='8s'");
    await competitor.query(
      `SELECT id FROM "${schema}".account WHERE id=2 FOR UPDATE`,
    );
    const operation = {
      ...request,
      operationId: randomUUID(),
      arguments: { ...request.arguments, values: { balance: 70 } },
    };
    const execution = recoveryRuntime({
      ...base,
      adapters: [deadlockAdapter],
    }).execute(operation);
    await Promise.race([
      atDispatch,
      new Promise((_, reject) =>
        setTimeout(
          () => reject(new Error("Managed dispatch timed out")),
          15000,
        ).unref(),
      ),
    ]);
    let competitorCode;
    try {
      await competitor.query(
        `SELECT id FROM "${schema}".account WHERE id=1 FOR UPDATE`,
      );
    } catch (error) {
      competitorCode = error.code;
    } finally {
      await competitor.query("ROLLBACK");
    }
    const result = await execution;
    assert.ok(managedCode === "40P01" || competitorCode === "40P01");
    runtime = recoveryRuntime({
      ...base,
      adapters: [managedPostgresAdapter(options)],
    });
    assert.equal((await runtime.execute(operation)).status, result.status);
    if (managedCode === "40P01") {
      assert.equal(result.status, "unknown");
      assert.equal(
        (await runtime.reconcile("qa-test", operation.operationId)).status,
        "unknown",
      );
      assert.equal(await balance(), 40);
    } else {
      assert.equal(result.status, "succeeded");
      assert.equal(
        (
          await runtime.recover(
            await runtime.planRecovery("qa-test", operation.operationId),
            async () => true,
          )
        ).status,
        "restored",
      );
    }
  } finally {
    await competitor.query("ROLLBACK").catch(() => {});
    await competitor.close();
  }
  // PostgreSQL deadlock detection against two independent test-only transactions.
  const left = await connect(),
    right = await connect();
  try {
    await left.query("BEGIN; SET LOCAL statement_timeout='8s'");
    await right.query("BEGIN; SET LOCAL statement_timeout='8s'");
    await left.query(
      `UPDATE "${schema}".account SET balance=balance+1 WHERE id=1`,
    );
    await right.query(
      `UPDATE "${schema}".account SET balance=balance+1 WHERE id=2`,
    );
    const deadlock = await Promise.allSettled([
      left.query(`UPDATE "${schema}".account SET balance=balance+1 WHERE id=2`),
      right.query(
        `UPDATE "${schema}".account SET balance=balance+1 WHERE id=1`,
      ),
    ]);
    assert.ok(
      deadlock.some(
        (result) =>
          result.status === "rejected" && result.reason.code === "40P01",
      ),
    );
  } finally {
    await left.query("ROLLBACK");
    await right.query("ROLLBACK");
    await left.close();
    await right.close();
  }
  assert.deepEqual(
    await db.query(`SELECT * FROM "${schema}".account ORDER BY id`),
    [
      { id: 1, balance: 40 },
      { id: 2, balance: 90 },
    ],
  );
  // A partitioned peer is neither dead nor slow: packets vanish while both
  // sockets stay open, so no server timeout can fire. The client must bound
  // the wait itself, fail closed with no partial commit, and work again once
  // the path heals. A dumb TCP proxy blackholes a direct connection; the
  // pool carries a client-side query timeout because the server, which never
  // receives the statement, cannot be the one that times out.
  {
    let blackhole = false;
    const proxy = net.createServer((downstream) => {
      const upstream = net.connect(5432, "127.0.0.1");
      downstream.on("data", (chunk) => {
        if (!blackhole) upstream.write(chunk);
      });
      upstream.on("data", (chunk) => {
        if (!blackhole) downstream.write(chunk);
      });
      downstream.on("close", () => upstream.destroy());
      upstream.on("close", () => downstream.destroy());
      downstream.on("error", () => upstream.destroy());
      upstream.on("error", () => downstream.destroy());
    });
    await new Promise((resolve) => proxy.listen(0, "127.0.0.1", resolve));
    const direct = new pg.Pool({
      host: "127.0.0.1",
      port: proxy.address().port,
      user: "void_test",
      database: "void_gui_upgrade_preview",
      max: 1,
      query_timeout: 3000,
    });
    try {
      const setup = await direct.connect();
      try {
        await setup.query(
          `CREATE TABLE "${schema}".partition_probe(id integer PRIMARY KEY, v integer NOT NULL)`,
        );
      } finally {
        setup.release();
      }
      const held = await direct.connect();
      await held.query("BEGIN");
      await held.query(`INSERT INTO "${schema}".partition_probe VALUES(1, 1)`);
      blackhole = true;
      await assert.rejects(
        held.query(`UPDATE "${schema}".partition_probe SET v=2 WHERE id=1`),
        /timeout/i,
      );
      held.release(new Error("partitioned"));
      blackhole = false;
      const check = await direct.connect();
      try {
        assert.deepEqual(
          (await check.query(`SELECT * FROM "${schema}".partition_probe`)).rows,
          [],
        );
        await check.query("BEGIN");
        await check.query(`INSERT INTO "${schema}".partition_probe VALUES(1, 1)`);
        await check.query("COMMIT");
        assert.deepEqual(
          (await check.query(
            `SELECT v FROM "${schema}".partition_probe WHERE id=1`,
          )).rows,
          [{ v: 1 }],
        );
      } finally {
        check.release();
      }
    } finally {
      await direct.end();
      await new Promise((resolve) => proxy.close(resolve));
    }
  }
  console.log(
    JSON.stringify({
      passed: true,
      backend: "real PostgreSQL / Neon",
      checks: [
        "integrated capture and commit",
        "restart and restore",
        "idempotent recovery",
        "human ABA conflict",
        "injected lost response reconciliation",
        "signed journal verification on reload",
        "capacity reservation vault",
        "real serialization conflict before dispatch",
        "isolated PostgreSQL deadlock rollback",
        "terminated backend before commit: no mutation or receipt, no retry",
        "terminated backend after commit: receipt reconciliation and restore",
        "terminated recovery backend after commit: idempotent reconciliation",
        "client SIGKILL after forward commit: receipt reconciliation",
        "client SIGKILL after recovery commit: idempotent reconciliation",
        "real deadlock during managed dispatch",
        "metadata rewrite rule rejection",
        "poisoned metadata default rejection",
        "unexpected metadata default rejection",
        "two-client metadata ABA rejection",
        "two-client fresh metadata race rejection",
        "blackholed peer times out client-side with no partial commit",
      ],
      networkPartitionTest: true,
    }),
  );
} finally {
  try {
    if (created) {
      await db.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await db.query(`DROP SCHEMA IF EXISTS "${metadata}" CASCADE`);
      await db.query(`DROP SCHEMA IF EXISTS "${abaMetadata}" CASCADE`);
      await db.query(`DROP SCHEMA IF EXISTS "${freshRaceMetadata}" CASCADE`);
    }
  } finally {
    await db.close();
    await pool.end();
    await rm(root, { recursive: true, force: true });
  }
}

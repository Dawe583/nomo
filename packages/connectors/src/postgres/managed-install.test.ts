import test from "node:test";
import assert from "node:assert/strict";
import { PGlite } from "@electric-sql/pglite";
import {
  installManagedPostgres,
  migrateManagedPostgres,
  type ManagedPostgresOptions,
} from "./managed.ts";

async function setup(t: import("node:test").TestContext) {
  const db = new PGlite();
  t.after(() => db.close());
  await db.exec(
    "CREATE TABLE account(id integer PRIMARY KEY, balance integer NOT NULL)",
  );
  const statements: string[] = [];
  let beforeQuery: ((sql: string) => Promise<void>) | undefined;
  const options: ManagedPostgresOptions = {
    workspace: "test",
    schema: "nomo_recovery",
    tables: [
      { table: "public.account", primaryKey: ["id"], columns: ["balance"] },
    ],
    connect: async () => ({
      query: async <T>(sql: string, params?: readonly unknown[]) => {
        await beforeQuery?.(sql);
        statements.push(sql);
        return (await db.query<T>(sql, params ? [...params] : [])).rows;
      },
      close: async () => {},
    }),
  };
  return {
    db,
    options,
    statements,
    onBeforeQuery: (hook: (sql: string) => Promise<void>) => {
      beforeQuery = hook;
    },
  };
}

async function receipts(db: PGlite) {
  const operations = (
    await db
      .query("SELECT * FROM nomo_recovery.operations ORDER BY id")
      .catch(() => ({ rows: [] }))
  ).rows;
  const recoveries = (
    await db
      .query("SELECT * FROM nomo_recovery.recoveries ORDER BY id")
      .catch(() => ({ rows: [] }))
  ).rows;
  return { operations, recoveries };
}

async function seedV1(db: PGlite) {
  await db.exec(`CREATE SCHEMA nomo_recovery;
    CREATE TABLE nomo_recovery.meta(key text PRIMARY KEY, version integer NOT NULL);
    CREATE TABLE nomo_recovery.revisions(resource text PRIMARY KEY, revision bigint NOT NULL);
    CREATE TABLE nomo_recovery.operations(id text PRIMARY KEY, request_digest text NOT NULL, capture jsonb NOT NULL, outcome jsonb NOT NULL);
    CREATE TABLE nomo_recovery.recoveries(id text PRIMARY KEY, input_digest text NOT NULL, outcome jsonb NOT NULL);
    INSERT INTO nomo_recovery.meta VALUES('version',1);
    INSERT INTO nomo_recovery.operations VALUES('op','digest','{}','{}');
    INSERT INTO nomo_recovery.recoveries VALUES('recovery','digest','{}')`);
}

function transactionStatements(statements: readonly string[]) {
  return statements.filter((sql) =>
    /^(?:BEGIN|COMMIT|ROLLBACK)/i.test(sql.trim()),
  );
}

test("v2 reinstall preserves both receipt tables", async (t) => {
  const f = await setup(t);
  await installManagedPostgres(f.options);
  await f.db
    .exec(`INSERT INTO nomo_recovery.operations(id,request_digest,capture,outcome) VALUES('op','digest','{}','{}');
    INSERT INTO nomo_recovery.recoveries(id,input_digest,outcome) VALUES('recovery','digest','{}')`);
  const before = await receipts(f.db);
  await installManagedPostgres(f.options);
  assert.deepEqual(await receipts(f.db), before);
});

for (const [name, ddl, error] of [
  [
    "legacy partial",
    "CREATE SCHEMA nomo_recovery; CREATE TABLE nomo_recovery.revisions(resource text PRIMARY KEY, revision bigint NOT NULL)",
    /legacy|version/i,
  ],
  [
    "unknown version",
    "CREATE SCHEMA nomo_recovery; CREATE TABLE nomo_recovery.meta(key text PRIMARY KEY, version integer NOT NULL); INSERT INTO nomo_recovery.meta VALUES('version',9)",
    /version 9|unsupported/i,
  ],
  [
    "malformed v2",
    `CREATE SCHEMA nomo_recovery; CREATE TABLE nomo_recovery.meta(key text PRIMARY KEY, version integer NOT NULL); INSERT INTO nomo_recovery.meta VALUES('version',2); CREATE TABLE nomo_recovery.revisions(resource text PRIMARY KEY, revision bigint NOT NULL); CREATE TABLE nomo_recovery.operations(id text PRIMARY KEY,request_digest text NOT NULL,capture jsonb NOT NULL,outcome jsonb NOT NULL,format_version integer); CREATE TABLE nomo_recovery.recoveries(id text PRIMARY KEY,input_digest text NOT NULL,outcome jsonb NOT NULL,format_version integer NOT NULL DEFAULT 2)`,
    /malformed|structure/i,
  ],
] as const) {
  test(`${name} install fails closed before a transaction`, async (t) => {
    const f = await setup(t);
    await f.db.exec(ddl);
    f.statements.length = 0;
    await assert.rejects(installManagedPostgres(f.options), error);
    assert.deepEqual(transactionStatements(f.statements), []);
  });
}

test("install rejects metadata version changed after preflight and rolls back once", async (t) => {
  const f = await setup(t);
  await installManagedPostgres(f.options);
  f.statements.length = 0;
  let changed = false;
  f.onBeforeQuery(async (sql) => {
    if (!changed && sql.trim() === "BEGIN") {
      changed = true;
      await f.db.exec(
        "UPDATE nomo_recovery.meta SET version=9 WHERE key='version'",
      );
    }
  });
  await assert.rejects(
    installManagedPostgres(f.options),
    /version 9|changed|unsupported/i,
  );
  assert.deepEqual(transactionStatements(f.statements), ["BEGIN", "ROLLBACK"]);
});

test("install rejects exact layout replacement between inspection and lock", async (t) => {
  const f = await setup(t);
  await installManagedPostgres(f.options);
  f.statements.length = 0;
  let replaced = false;
  f.onBeforeQuery(async (sql) => {
    if (!replaced && sql.trim() === "BEGIN") {
      replaced = true;
      await f.db.exec(
        `DROP SCHEMA nomo_recovery CASCADE; CREATE SCHEMA nomo_recovery; CREATE TABLE nomo_recovery.meta(key text PRIMARY KEY,version integer NOT NULL); CREATE TABLE nomo_recovery.revisions(resource text PRIMARY KEY,revision bigint NOT NULL); CREATE TABLE nomo_recovery.operations(id text PRIMARY KEY,request_digest text NOT NULL,capture jsonb NOT NULL,outcome jsonb NOT NULL,format_version integer NOT NULL DEFAULT 2); CREATE TABLE nomo_recovery.recoveries(id text PRIMARY KEY,input_digest text NOT NULL,outcome jsonb NOT NULL,format_version integer NOT NULL DEFAULT 2); INSERT INTO nomo_recovery.meta VALUES('version',2)`,
      );
    }
  });
  await assert.rejects(installManagedPostgres(f.options), /identity changed/i);
  assert.deepEqual(transactionStatements(f.statements), ["BEGIN", "ROLLBACK"]);
});

test("v1 migration preserves receipts and writes v2 format columns", async (t) => {
  const f = await setup(t);
  await seedV1(f.db);
  const before = await receipts(f.db);
  assert.deepEqual(await migrateManagedPostgres(f.options), {
    fromVersion: 1,
    metadataVersion: 2,
  });
  assert.deepEqual(
    (
      await f.db.query(
        "SELECT id,request_digest,capture,outcome FROM nomo_recovery.operations",
      )
    ).rows,
    before.operations,
  );
  assert.deepEqual(
    (
      await f.db.query(
        "SELECT id,input_digest,outcome FROM nomo_recovery.recoveries",
      )
    ).rows,
    before.recoveries,
  );
  assert.deepEqual(
    (await f.db.query("SELECT format_version FROM nomo_recovery.operations"))
      .rows,
    [{ format_version: 1 }],
  );
  assert.deepEqual(
    (await f.db.query("SELECT format_version FROM nomo_recovery.recoveries"))
      .rows,
    [{ format_version: 1 }],
  );
  await f.db
    .exec(`INSERT INTO nomo_recovery.operations(id,request_digest,capture,outcome) VALUES('new','digest','{}','{}');
    INSERT INTO nomo_recovery.recoveries(id,input_digest,outcome) VALUES('new','digest','{}')`);
  assert.deepEqual(
    (
      await f.db.query(
        "SELECT format_version FROM nomo_recovery.operations WHERE id='new'",
      )
    ).rows,
    [{ format_version: 2 }],
  );
  assert.deepEqual(
    (
      await f.db.query(
        "SELECT format_version FROM nomo_recovery.recoveries WHERE id='new'",
      )
    ).rows,
    [{ format_version: 2 }],
  );
});

test("migration rejects exact layout replacement between inspection and lock", async (t) => {
  const f = await setup(t);
  await seedV1(f.db);
  f.statements.length = 0;
  let replaced = false;
  f.onBeforeQuery(async (sql) => {
    if (!replaced && sql.trim() === "BEGIN") {
      replaced = true;
      await f.db.exec(
        `DROP SCHEMA nomo_recovery CASCADE; CREATE SCHEMA nomo_recovery; CREATE TABLE nomo_recovery.meta(key text PRIMARY KEY,version integer NOT NULL); CREATE TABLE nomo_recovery.revisions(resource text PRIMARY KEY,revision bigint NOT NULL); CREATE TABLE nomo_recovery.operations(id text PRIMARY KEY,request_digest text NOT NULL,capture jsonb NOT NULL,outcome jsonb NOT NULL); CREATE TABLE nomo_recovery.recoveries(id text PRIMARY KEY,input_digest text NOT NULL,outcome jsonb NOT NULL); INSERT INTO nomo_recovery.meta VALUES('version',1)`,
      );
    }
  });
  await assert.rejects(migrateManagedPostgres(f.options), /identity changed/i);
  assert.deepEqual(transactionStatements(f.statements), ["BEGIN", "ROLLBACK"]);
});

test("fresh install refuses a concurrent exact metadata layout", async (t) => {
  const f = await setup(t);
  let raced = false;
  f.onBeforeQuery(async (sql) => {
    if (!raced && sql.includes("CREATE TABLE") && sql.includes(".meta")) {
      raced = true;
      await f.db
        .exec(`CREATE TABLE nomo_recovery.meta(key text PRIMARY KEY,version integer NOT NULL);
        CREATE TABLE nomo_recovery.revisions(resource text PRIMARY KEY,revision bigint NOT NULL);
        CREATE TABLE nomo_recovery.operations(id text PRIMARY KEY,request_digest text NOT NULL,capture jsonb NOT NULL,outcome jsonb NOT NULL,format_version integer NOT NULL DEFAULT 2);
        CREATE TABLE nomo_recovery.recoveries(id text PRIMARY KEY,input_digest text NOT NULL,outcome jsonb NOT NULL,format_version integer NOT NULL DEFAULT 2);
        INSERT INTO nomo_recovery.meta VALUES('version',2)`);
    }
  });
  await assert.rejects(
    installManagedPostgres(f.options),
    /already exists|duplicate/i,
  );
  assert.deepEqual(transactionStatements(f.statements), ["BEGIN", "ROLLBACK"]);
});

for (const [name, mutation] of [
  [
    "extra relation",
    "CREATE TABLE nomo_recovery.unowned(id integer PRIMARY KEY)",
  ],
  [
    "extra index",
    "CREATE INDEX operations_digest_idx ON nomo_recovery.operations(request_digest)",
  ],
  [
    "extra constraint",
    "ALTER TABLE nomo_recovery.operations ADD CONSTRAINT digest_not_empty CHECK(request_digest <> '')",
  ],
  [
    "metadata trigger",
    `CREATE FUNCTION nomo_recovery.reject_write() RETURNS trigger LANGUAGE plpgsql AS 'BEGIN RETURN NEW; END'; CREATE TRIGGER reject_write BEFORE INSERT ON nomo_recovery.operations FOR EACH ROW EXECUTE FUNCTION nomo_recovery.reject_write()`,
  ],
  [
    "row level security",
    "ALTER TABLE nomo_recovery.operations ENABLE ROW LEVEL SECURITY",
  ],
  [
    "rewrite rule",
    "CREATE RULE suppress_receipt AS ON INSERT TO nomo_recovery.operations DO INSTEAD NOTHING",
  ],
  [
    "poisoned format default",
    "ALTER TABLE nomo_recovery.operations ALTER COLUMN format_version SET DEFAULT (2 + floor(random())::integer)",
  ],
  [
    "unexpected capture default",
    "ALTER TABLE nomo_recovery.operations ALTER COLUMN capture SET DEFAULT '{}'::jsonb",
  ],
] as const) {
  test(`install refuses ${name} on metadata`, async (t) => {
    const f = await setup(t);
    await installManagedPostgres(f.options);
    await f.db.exec(mutation);
    f.statements.length = 0;
    await assert.rejects(
      installManagedPostgres(f.options),
      /malformed|structure/i,
    );
    assert.deepEqual(transactionStatements(f.statements), []);
  });
}

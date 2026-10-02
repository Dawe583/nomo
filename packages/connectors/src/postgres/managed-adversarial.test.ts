import test from "node:test";
import assert from "node:assert/strict";
import { PGlite } from "@electric-sql/pglite";
import {
  managedPostgresAdapter,
  installManagedPostgres,
  type ManagedPostgresOptions,
} from "./managed.ts";
import type { Json, Prepared } from "../recovery.ts";

async function fixture(t: import("node:test").TestContext) {
  const db = new PGlite();
  t.after(() => db.close());
  await db.exec(
    "CREATE TABLE account(id integer PRIMARY KEY, balance integer NOT NULL); INSERT INTO account VALUES(1,10),(2,20)",
  );
  const options: ManagedPostgresOptions = {
    workspace: "test",
    schema: "void_recovery",
    tables: [
      { table: "public.account", primaryKey: ["id"], columns: ["balance"] },
    ],
    connect: async () => ({
      query: async <T>(sql: string, params?: readonly unknown[]) =>
        (await db.query<T>(sql, params ? [...params] : [])).rows,
      close: async () => {},
    }),
  };
  await installManagedPostgres(options);
  const adapter = managedPostgresAdapter(options);
  const args = (id: number, balance: number): Json => ({
    table: "public.account",
    action: "update",
    key: { id },
    values: { balance },
  });
  async function execute(id: string, row: number, balance: number) {
    const input = args(row, balance),
      observation = await adapter.preflight(input);
    const prepared = await adapter.prepare(input, observation, id);
    try {
      return { prepared, outcome: await adapter.execute(input, prepared, id) };
    } finally {
      await adapter.release(id);
    }
  }
  return { db, options, adapter, args, execute };
}

test("a recovery ID cannot claim success for a different operation capture", async (t) => {
  const f = await fixture(t),
    first = await f.execute("one", 1, 11),
    second = await f.execute("two", 2, 22);
  assert.equal(
    (await f.adapter.recover(first.prepared, first.outcome, "recovery")).status,
    "restored",
  );
  await assert.rejects(
    f.adapter.recover(second.prepared, second.outcome, "recovery"),
    /identity|digest|match|another/i,
  );
  assert.deepEqual(
    (
      await f.db.query<Record<string, unknown>>(
        "SELECT * FROM account ORDER BY id",
      )
    ).rows,
    [
      { id: 1, balance: 10 },
      { id: 2, balance: 22 },
    ],
  );
});

test("reconciliation rejects a capture belonging to another operation", async (t) => {
  const f = await fixture(t),
    first = await f.execute("one", 1, 11),
    second = await f.execute("two", 2, 22);
  await assert.rejects(
    f.adapter.reconcile("one", second.prepared),
    /identity|digest|match|capture/i,
  );
  assert.equal(
    (await f.adapter.reconcile("one", first.prepared)).status,
    "succeeded",
  );
});

test("recovery rejects a substituted before image instead of overwriting with invented data", async (t) => {
  const f = await fixture(t),
    operation = await f.execute("one", 1, 11);
  const substituted: Prepared = {
    ...operation.prepared,
    before: { id: 1, balance: 999 },
  };
  await assert.rejects(
    f.adapter.recover(substituted, operation.outcome, "recovery"),
    /identity|digest|match|capture/i,
  );
  assert.equal(
    (
      await f.db.query<Record<string, unknown>>(
        "SELECT balance FROM account WHERE id=1",
      )
    ).rows[0]?.balance,
    11,
  );
});

test("a replacement trigger function cannot conceal intervening human ABA writes", async (t) => {
  const f = await fixture(t),
    operation = await f.execute("one", 1, 11);
  const fn = (
    await f.db.query<{ name: string }>(
      "SELECT p.proname AS name FROM pg_trigger t JOIN pg_proc p ON p.oid=t.tgfoid WHERE t.tgrelid='account'::regclass AND NOT t.tgisinternal",
    )
  ).rows[0]!.name;
  assert.match(fn, /^revision_[a-f0-9]+$/);
  await f.db.exec(
    `CREATE OR REPLACE FUNCTION void_recovery.${fn}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NULL; END $$; UPDATE account SET balance=30 WHERE id=1; UPDATE account SET balance=11 WHERE id=1`,
  );
  let rejected = false;
  try {
    rejected =
      (
        await f.adapter.recover(
          operation.prepared,
          operation.outcome,
          "recovery",
        )
      ).status === "conflict";
  } catch {
    rejected = true;
  }
  assert.equal(
    rejected,
    true,
    "a changed revision trigger must invalidate certification",
  );
  assert.equal(
    (
      await f.db.query<Record<string, unknown>>(
        "SELECT balance FROM account WHERE id=1",
      )
    ).rows[0]?.balance,
    11,
  );
});

test("failed receipt insertion rolls back the business mutation", async (t) => {
  const f = await fixture(t);
  await f.db.exec(
    "ALTER TABLE void_recovery.operations ADD CONSTRAINT reject_receipt CHECK(false)",
  );
  await assert.rejects(f.execute("one", 1, 11));
  assert.equal(
    (
      await f.db.query<Record<string, unknown>>(
        "SELECT balance FROM account WHERE id=1",
      )
    ).rows[0]?.balance,
    10,
  );
  assert.equal(
    (
      await f.db.query<Record<string, unknown>>(
        "SELECT count(*)::int AS n FROM void_recovery.operations",
      )
    ).rows[0]?.n,
    0,
  );
});

test("failed recovery receipt insertion rolls back the inverse", async (t) => {
  const f = await fixture(t),
    operation = await f.execute("one", 1, 11);
  await f.db.exec(
    "ALTER TABLE void_recovery.recoveries ADD CONSTRAINT reject_receipt CHECK(false)",
  );
  await assert.rejects(
    f.adapter.recover(operation.prepared, operation.outcome, "recovery"),
  );
  assert.equal(
    (
      await f.db.query<Record<string, unknown>>(
        "SELECT balance FROM account WHERE id=1",
      )
    ).rows[0]?.balance,
    11,
  );
  assert.equal(
    (
      await f.db.query<Record<string, unknown>>(
        "SELECT count(*)::int AS n FROM void_recovery.recoveries",
      )
    ).rows[0]?.n,
    0,
  );
});

test("inbound foreign keys, rules and generated columns fail closed as uncertified", async (t) => {
  const f = await fixture(t);
  await f.db.exec("CREATE TABLE child(id integer PRIMARY KEY, account_id integer REFERENCES account(id) ON DELETE CASCADE); INSERT INTO child VALUES(1,1)");
  await assert.rejects(f.execute("cascade-inbound", 1, 12), /cascade|referenced|cert/i);
  await f.db.exec("DROP TABLE child");
  await f.db.exec("CREATE RULE protect AS ON UPDATE TO account DO INSTEAD NOTHING");
  await assert.rejects(f.execute("rule", 1, 13), /rule|cert/i);
  await f.db.exec("DROP RULE protect ON account");
  await f.db.exec("ALTER TABLE account ADD COLUMN serial_no integer GENERATED ALWAYS AS IDENTITY");
  await assert.rejects(f.execute("generated", 1, 14), /generated|identity|cert/i);
  assert.equal((await f.db.query<{ balance: number }>("SELECT balance FROM account WHERE id=1")).rows[0]?.balance, 10);
  assert.equal(
    (
      await f.db.query<Record<string, unknown>>(
        "SELECT count(*)::int AS n FROM void_recovery.operations",
      )
    ).rows[0]?.n,
    0,
  );
});

test("recreating a table at the same name invalidates the old target capture", async (t) => {
  const f = await fixture(t),
    operation = await f.execute("one", 1, 11);
  await f.db.exec(
    "DROP TABLE account; CREATE TABLE account(id integer PRIMARY KEY, balance integer NOT NULL); INSERT INTO account VALUES(1,11),(2,200)",
  );
  await installManagedPostgres(f.options);
  let rejected = false;
  try {
    rejected =
      (
        await f.adapter.recover(
          operation.prepared,
          operation.outcome,
          "recovery",
        )
      ).status === "conflict";
  } catch {
    rejected = true;
  }
  assert.equal(
    rejected,
    true,
    "a replacement relation must not inherit an old relation recovery",
  );
  assert.deepEqual(
    (
      await f.db.query<Record<string, unknown>>(
        "SELECT * FROM account ORDER BY id",
      )
    ).rows,
    [
      { id: 1, balance: 11 },
      { id: 2, balance: 200 },
    ],
  );
});

for (const [name, mutation] of [
  [
    "a rewrite rule that swallows receipts",
    "CREATE RULE suppress_receipt AS ON INSERT TO void_recovery.operations DO INSTEAD NOTHING",
  ],
  [
    "a trigger on a receipt table",
    `CREATE FUNCTION void_recovery.reject_write() RETURNS trigger LANGUAGE plpgsql AS 'BEGIN RETURN NEW; END'; CREATE TRIGGER reject_write BEFORE INSERT ON void_recovery.operations FOR EACH ROW EXECUTE FUNCTION void_recovery.reject_write()`,
  ],
  [
    "an extra relation in the metadata schema",
    "CREATE TABLE void_recovery.unowned(id integer PRIMARY KEY)",
  ],
  [
    "an extra index on a receipt table",
    "CREATE INDEX operations_digest_idx ON void_recovery.operations(request_digest)",
  ],
  [
    "an extra constraint on a receipt table",
    "ALTER TABLE void_recovery.operations ADD CONSTRAINT digest_not_empty CHECK(request_digest <> '')",
  ],
  [
    "row level security on a receipt table",
    "ALTER TABLE void_recovery.operations ENABLE ROW LEVEL SECURITY",
  ],
  [
    "a poisoned receipt format default",
    "ALTER TABLE void_recovery.operations ALTER COLUMN format_version SET DEFAULT (2 + floor(random())::integer)",
  ],
  [
    "an unexpected receipt default",
    "ALTER TABLE void_recovery.operations ALTER COLUMN capture SET DEFAULT '{}'::jsonb",
  ],
] as const) {
  test(`execution refuses ${name}`, async (t) => {
    const f = await fixture(t);
    await f.db.exec(mutation);
    // Install refuses this layout, so it must not be executable either.
    await assert.rejects(
      installManagedPostgres(f.options),
      /malformed|structure/i,
    );
    // The refusal has to land before the mutation is prepared, let alone
    // executed: a committed change whose receipt the rule or trigger
    // discarded reported success and can never be recovered.
    await assert.rejects(
      f.adapter.preflight(f.args(1, 11)),
      /structure|migration|metadata/i,
    );
    assert.deepEqual(
      (
        await f.db.query<Record<string, unknown>>(
          "SELECT * FROM account ORDER BY id",
        )
      ).rows,
      [
        { id: 1, balance: 10 },
        { id: 2, balance: 20 },
      ],
    );
    for (const table of ["operations", "recoveries"]) {
      assert.deepEqual(
        (
          await f.db.query<{ count: number }>(
            `SELECT count(*)::int AS count FROM void_recovery.${table}`,
          )
        ).rows,
        [{ count: 0 }],
      );
    }
  });
}

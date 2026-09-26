/**
 * Disposable managed-PostgreSQL conformance fixtures (OPEN-WORK-AUDIT row 28).
 *
 * `managedPostgresAdapter` is a complete `RecoveryAdapter` that shipped with
 * no capability profile behind it, so nothing published what it could
 * recover. The profile lives in `packages/cli/src/conformance.ts`; the
 * fixtures live here because PGlite is a devDependency of this package, and
 * `void.mjs` must not need it to print a profile list or run the other three
 * adapters. A run for this adapter without it is refused, and the refusal
 * names the missing precondition.
 *
 * PGlite is a real PostgreSQL engine in process: the same SQL, the same
 * transaction boundary, the same row triggers, the same foreign-key cascade
 * and the same version 2 recovery metadata the adapter uses against a server,
 * with no service to start. What it cannot prove is anything about a
 * networked cluster — replication, disk exhaustion, a server this fixture did
 * not create. Those stay the real-server certification gate, and nothing here
 * claims to have crossed it.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateKeyPairSync, randomBytes } from "node:crypto";

import type { PGlite } from "@electric-sql/pglite";
import { keyProviderFromPkcs8 } from "../../../ledger/src/sign.ts";
import {
  localOperationJournal,
  reservedRecoveryVault,
  type ConformanceFixture,
  type Json,
} from "../../../runtime/src/index.ts";
import {
  installManagedPostgres,
  managedPostgresAdapter,
  type ManagedPostgresOptions,
  type ManagedTable,
} from "./managed.ts";

/**
 * Every scenario the published profile runs, each one a real mutation against
 * a real engine: the three actions the adapter parses, a delete whose captured
 * descendants are the rows a foreign-key cascade removed, and an update under
 * a server-bound tenant policy that an unprivileged role cannot bypass.
 */
export const MANAGED_POSTGRES_SCENARIOS = [
  "insert",
  "update",
  "delete",
  "delete-cascade",
  "tenant-update",
] as const;
export type ManagedPostgresScenario = (typeof MANAGED_POSTGRES_SCENARIOS)[number];

const WORKSPACE = "conformance";
const SCHEMA = "void_recovery";
const ACCOUNT = "public.conformance_account";
const PARENT = "public.conformance_parent";
const CHILD = "public.conformance_child";
const LEDGER = "public.conformance_ledger";
const TENANT_SETTING = "app.tenant";
const TENANT_ROLE = "conformance_app";
const TENANT_VALUE = "acme";

/**
 * Dynamic, unlike every other import in this file: @electric-sql/pglite is a
 * devDependency of @void/connectors, so a static import would make the
 * shipped CLI fail to load for anyone who installs production dependencies.
 * Only these fixtures need the engine, and the refusal names what is missing.
 */
const startEngine = async (): Promise<PGlite> => {
  const { PGlite: Engine } = await import("@electric-sql/pglite").catch(() => {
    throw new Error(
      "Managed PostgreSQL conformance needs @electric-sql/pglite, a devDependency of @void/connectors; it is not installed in this checkout.",
    );
  });
  return new Engine();
};

/**
 * One journal and one vault per fixture, with a fresh key per fixture: the
 * restarted runtime reopens both, so a key minted per `options()` call would
 * make every restart fail verification for the wrong reason.
 */
const persisted = (dir: string) => {
  const { privateKey } = generateKeyPairSync("ed25519");
  const signer = keyProviderFromPkcs8(
    privateKey.export({ type: "pkcs8", format: "der" }),
  );
  const key = randomBytes(32);
  return () => ({
    journal: localOperationJournal(join(dir, "journal"), signer),
    vault: reservedRecoveryVault(
      join(dir, "vault"),
      { conformance: key },
      "conformance",
    ),
  });
};

/**
 * The identity the conformance profile binds, read from the factory rather
 * than written out: the adapter derives its id from the workspace, so a
 * profile that spelled the concatenation by hand would assert a string no
 * code checks. Building the adapter does no I/O — `connect` runs per request,
 * and the refusal below names that precondition instead of quietly answering
 * from a closure that could never work.
 */
export function managedPostgresConformanceIdentity(): {
  id: string;
  version: string;
} {
  const adapter = managedPostgresAdapter({
    workspace: WORKSPACE,
    schema: SCHEMA,
    tables: [{ table: ACCOUNT, primaryKey: ["id"], columns: ["label"] }],
    connect: async () => {
      throw new Error(
        "The conformance adapter identity opens no connection; build a fixture to run one.",
      );
    },
  });
  return { id: adapter.id, version: adapter.version };
};

type FixtureSpec = {
  /** Disposable-directory prefix, so a leftover from a killed run is identifiable. */
  name: string;
  tables: readonly ManagedTable[];
  tenant?: ManagedPostgresOptions["tenant"];
  /** Schema and seed rows, executed before the managed metadata install. */
  seed: string;
  /** Executed after the install, before any scenario runs. */
  prepare?: (db: PGlite) => string;
  /** The mutation under test, and a different request with the same shape. */
  request: Json;
  changed: Json;
  /** Observed state before, after, and following an out-of-band edit. */
  before: Json;
  after: Json;
  human: Json;
  read(db: PGlite): Promise<Json>;
  writeHuman(db: PGlite, human: Json): Promise<void>;
};

/** Row shapes named after the column the read returns them under. */
const labelRow = (id: number, label: string) => ({ id, label });
const noteRow = (id: number, note: string) => ({ id, note });
const memoRow = (id: number, memo: string) => ({ id, memo });
const ORIGINAL = labelRow(1, "conformance original");

const ACCOUNT_TABLES: readonly ManagedTable[] = [
  { table: ACCOUNT, primaryKey: ["id"], columns: ["label"] },
];

/**
 * One selected row, read by primary key. The three actions differ only in
 * what they do to it, so they share the table, the seed and the read; the
 * request differs, and so does what a human edit has to look like for
 * recovery to be able to tell drift from its own evidence.
 */
const accountSpec = (
  operation: "insert" | "update" | "delete",
): FixtureSpec => {
  const mutation = (action: "insert" | "update" | "delete", key: number, values: Record<string, Json>) =>
    ({ table: ACCOUNT, action, key: { id: key }, values }) as Json;
  const selected = async (db: PGlite) =>
    ((await db.query("SELECT id,label FROM conformance_account WHERE id=$1", [1]))
      .rows[0] ?? null) as Json;
  if (operation === "insert")
    return {
      name: "insert",
      tables: ACCOUNT_TABLES,
      seed:
        "CREATE TABLE conformance_account(id integer PRIMARY KEY, label text NOT NULL); " +
        "INSERT INTO conformance_account VALUES(1,'conformance original'),(2,'conformance untouched')",
      request: mutation("insert", 4, { label: "conformance agent insert" }),
      // A different, individually valid request: the refusal this exercises is
      // the idempotency key, not argument validation.
      changed: mutation("insert", 5, { label: "conformance changed request" }),
      before: null,
      after: { id: 4, label: "conformance agent insert" },
      human: { id: 4, label: "conformance human insert" },
      // The insert scenario writes and reads the row it created, so the
      // selected id is the one the request names.
      read: async (db) =>
        ((await db.query("SELECT id,label FROM conformance_account WHERE id=4"))
          .rows[0] ?? null) as Json,
      writeHuman: async (db, human) => {
        await db.query("UPDATE conformance_account SET label=$1 WHERE id=4", [
          (human as { label: string }).label,
        ]);
      },
    };
  if (operation === "update")
    return {
      name: "update",
      tables: ACCOUNT_TABLES,
      seed:
        "CREATE TABLE conformance_account(id integer PRIMARY KEY, label text NOT NULL); " +
        "INSERT INTO conformance_account VALUES(1,'conformance original'),(2,'conformance untouched')",
      request: mutation("update", 1, { label: "conformance agent update" }),
      changed: mutation("update", 1, { label: "conformance changed request" }),
      before: ORIGINAL,
      after: { id: 1, label: "conformance agent update" },
      human: { id: 1, label: "conformance human update" },
      read: selected,
      writeHuman: async (db, human) => {
        await db.query("UPDATE conformance_account SET label=$1 WHERE id=1", [
          (human as { label: string }).label,
        ]);
      },
    };
  return {
    name: "delete",
    tables: ACCOUNT_TABLES,
    seed:
      "CREATE TABLE conformance_account(id integer PRIMARY KEY, label text NOT NULL); " +
      "INSERT INTO conformance_account VALUES(1,'conformance original'),(2,'conformance untouched')",
    request: mutation("delete", 1, {}),
    changed: mutation("delete", 2, {}),
    before: ORIGINAL,
    after: null,
    human: { id: 1, label: "conformance human restore" },
    read: selected,
    // A human putting the row back is drift the recovery must refuse rather
    // than overwrite, and it is the only way a deleted row comes back.
    writeHuman: async (db, human) => {
      await db.query(
        "INSERT INTO conformance_account(id,label) VALUES(1,$1) ON CONFLICT (id) DO UPDATE SET label=EXCLUDED.label",
        [(human as { label: string }).label],
      );
    },
  };
};

/**
 * A parent with two children and a second parent the request never names.
 * Recovery has to re-insert the whole captured subtree in dependency order and
 * leave the other parent exactly as it was, so the read spans both.
 */
const CASCADE_SPEC: FixtureSpec = {
  name: "delete-cascade",
  tables: [
    { table: PARENT, primaryKey: ["id"], columns: ["label"] },
    { table: CHILD, primaryKey: ["id"], columns: ["parent", "note"] },
  ],
  seed:
    "CREATE TABLE conformance_parent(id integer PRIMARY KEY, label text NOT NULL); " +
    "CREATE TABLE conformance_child(id integer PRIMARY KEY, parent integer NOT NULL REFERENCES conformance_parent(id) ON DELETE CASCADE, note text NOT NULL); " +
    "INSERT INTO conformance_parent VALUES(1,'conformance original'),(2,'conformance untouched'); " +
    "INSERT INTO conformance_child VALUES(10,1,'child original'),(11,1,'child second'),(12,2,'other parent')",
  request: { table: PARENT, action: "delete", key: { id: 1 }, values: {} },
  changed: { table: PARENT, action: "delete", key: { id: 2 }, values: {} },
  before: {
    parent: ORIGINAL,
    children: [noteRow(10, "child original"), noteRow(11, "child second")],
    other: labelRow(2, "conformance untouched"),
    otherChildren: [noteRow(12, "other parent")],
  },
  after: {
    parent: null,
    children: [],
    other: labelRow(2, "conformance untouched"),
    otherChildren: [noteRow(12, "other parent")],
  },
  human: {
    parent: labelRow(1, "conformance human restore"),
    children: [noteRow(10, "child original"), noteRow(11, "child second")],
    other: labelRow(2, "conformance untouched"),
    otherChildren: [noteRow(12, "other parent")],
  },
  read: async (db) =>
    ({
      parent:
        (await db.query<{ id: number; label: string }>(
          "SELECT id,label FROM conformance_parent WHERE id=$1",
          [1],
        )).rows[0] ?? null,
      children: (
        await db.query<{ id: number; note: string }>(
          "SELECT id,note FROM conformance_child WHERE parent=$1 ORDER BY id",
          [1],
        )
      ).rows,
      other: (
        await db.query<{ id: number; label: string }>(
          "SELECT id,label FROM conformance_parent WHERE id=$1",
          [2],
        )
      ).rows[0] ?? null,
      otherChildren: (
        await db.query<{ id: number; note: string }>(
          "SELECT id,note FROM conformance_child WHERE parent=$1 ORDER BY id",
          [2],
        )
      ).rows,
    }) as Json,
  // The whole subtree comes back, not just the parent: the human state this
  // declares has to be what the read returns, and a recovery that ran
  // against a half-restored tree would be a different measurement.
  writeHuman: async (db) => {
    await db.query("BEGIN");
    await db.query(
      "INSERT INTO conformance_parent(id,label) VALUES(1,$1) ON CONFLICT (id) DO UPDATE SET label=EXCLUDED.label",
      ["conformance human restore"],
    );
    await db.query(
      "INSERT INTO conformance_child(id,parent,note) VALUES(10,1,'child original'),(11,1,'child second') ON CONFLICT (id) DO UPDATE SET note=EXCLUDED.note",
    );
    await db.query("COMMIT");
  },
};

/**
 * Row-level security is only evidence when the session role cannot bypass it,
 * so this fixture ends by dropping into an unprivileged role. The globex row
 * is then hidden by the policy rather than by a WHERE clause, and the read
 * proves the bound tenant's recovery did not reach across it.
 */
const TENANT_SPEC: FixtureSpec = {
  name: "tenant-update",
  tables: [{ table: LEDGER, primaryKey: ["id"], columns: ["amount", "memo"] }],
  tenant: { column: "tenant", setting: TENANT_SETTING },
  seed:
    `CREATE TABLE conformance_ledger(id integer PRIMARY KEY, tenant text NOT NULL, amount integer NOT NULL, memo text NOT NULL); ` +
    `INSERT INTO conformance_ledger VALUES(1,'${TENANT_VALUE}',10,'conformance original'),(2,'globex',90,'conformance other tenant'),(3,'${TENANT_VALUE}',5,'conformance untouched'); ` +
    `ALTER TABLE conformance_ledger ENABLE ROW LEVEL SECURITY; ` +
    `CREATE POLICY ledger_tenant ON conformance_ledger USING (tenant = current_setting('${TENANT_SETTING}', true)) WITH CHECK (tenant = current_setting('${TENANT_SETTING}', true)); ` +
    `CREATE ROLE ${TENANT_ROLE} NOLOGIN`,
  prepare: () =>
    `GRANT SELECT,INSERT,UPDATE,DELETE ON conformance_ledger TO ${TENANT_ROLE}; ` +
    `GRANT USAGE ON SCHEMA ${SCHEMA} TO ${TENANT_ROLE}; ` +
    `GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA ${SCHEMA} TO ${TENANT_ROLE}; ` +
    `SELECT set_config('${TENANT_SETTING}','${TENANT_VALUE}',false); ` +
    `SET ROLE ${TENANT_ROLE}`,
  request: {
    table: LEDGER,
    action: "update",
    key: { id: 1 },
    values: { amount: 20, memo: "conformance agent update" },
  },
  changed: {
    table: LEDGER,
    action: "update",
    key: { id: 1 },
    values: { amount: 30, memo: "conformance changed request" },
  },
  before: {
    ledger: [memoRow(1, "conformance original"), memoRow(3, "conformance untouched")],
  },
  after: {
    ledger: [memoRow(1, "conformance agent update"), memoRow(3, "conformance untouched")],
  },
  human: {
    ledger: [memoRow(1, "conformance human update"), memoRow(3, "conformance untouched")],
  },
  read: async (db) =>
    ({
      ledger: (
        await db.query<{ id: number; memo: string }>(
          "SELECT id,memo FROM conformance_ledger ORDER BY id",
        )
      ).rows,
    }) as Json,
  writeHuman: async (db) => {
    await db.query("UPDATE conformance_ledger SET memo=$1 WHERE id=$2", [
      "conformance human update",
      1,
    ]);
  },

};

function specFor(operation: ManagedPostgresScenario): FixtureSpec {
  if (operation === "insert" || operation === "update" || operation === "delete")
    return accountSpec(operation);
  return operation === "delete-cascade" ? CASCADE_SPEC : TENANT_SPEC;
}

export async function managedPostgresConformanceFixture(
  operation: ManagedPostgresScenario = "update",
): Promise<ConformanceFixture> {
  if (!MANAGED_POSTGRES_SCENARIOS.includes(operation))
    throw new Error(
      `Unknown managed PostgreSQL conformance scenario ${JSON.stringify(operation)}.`,
    );
  const spec = specFor(operation);
  const db = await startEngine();
  const dir = await mkdtemp(join(tmpdir(), `void-postgres-${spec.name}-`));
  const managed: ManagedPostgresOptions = {
    workspace: WORKSPACE,
    schema: SCHEMA,
    tables: [...spec.tables],
    ...(spec.tenant ? { tenant: spec.tenant } : {}),
    connect: async () => ({
      query: async <T>(sql: string, params?: readonly unknown[]) =>
        (await db.query<T>(sql, params ? [...params] : [])).rows,
      close: async () => {},
    }),
  };
  const reopen = persisted(dir);
  try {
    await db.exec(spec.seed);
    await installManagedPostgres(managed);
    if (spec.prepare) await db.exec(spec.prepare(db));
    return {
      // A fresh adapter per call: it holds the prepared transaction in
      // per-instance state, so one shared instance would hide a leaked
      // connection across a restart.
      adapter: () => managedPostgresAdapter(managed),
      options: reopen,
      arguments: spec.request,
      changedArguments: spec.changed,
      before: spec.before,
      after: spec.after,
      human: spec.human,
      read: () => spec.read(db),
      writeHuman: () => spec.writeHuman(db, spec.human),
      dispose: async () => {
        await db.close();
        await rm(dir, { recursive: true, force: true });
      },
    };
  } catch (error) {
    await db.close().catch(() => {});
    await rm(dir, { recursive: true, force: true });
    throw error;
  }
}

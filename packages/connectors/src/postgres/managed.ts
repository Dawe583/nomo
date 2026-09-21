import { createHash } from "node:crypto";
import { canonicalJson } from "../../../ledger/src/canonical.ts";
import type {
  Json,
  Observation,
  Outcome,
  Prepared,
  RecoveryAdapter,
} from "../recovery.ts";
import type { QueryExecutor } from "./capture.ts";

export interface ManagedConnection extends QueryExecutor {
  close(): Promise<void>;
}

export type ManagedTable = {
  table: string;
  primaryKey: string[];
  columns: string[];
};

/**
 * A tenant is chosen by PostgreSQL role/database configuration, never by a
 * recovery request. The configured RLS policy must use this setting.
 */
export type ManagedTenantScope = {
  column: string;
  setting: string;
};

export type ManagedPostgresOptions = {
  workspace: string;
  schema: string;
  tables: ManagedTable[];
  tenant?: ManagedTenantScope;
  connect(): Promise<ManagedConnection>;
};

type Mutation = {
  table: string;
  action: "insert" | "update" | "delete";
  key: Record<string, Json>;
  values: Record<string, Json>;
};

type BoundTenantScope = ManagedTenantScope & { value: string };

type RowCapture = {
  table: string;
  key: Record<string, Json>;
  row: Json | null;
  resource: string;
  revision: string;
  relationOid: string;
  depth: number;
};

type ManagedState = {
  rows: RowCapture[];
  tenant: BoundTenantScope | null;
};

type CascadeEdge = {
  table: string;
  childColumns: string[];
  parentColumns: string[];
  deleteAction: string;
};

const hash = (v: unknown) =>
  createHash("sha256").update(canonicalJson(v)).digest("hex");

const ident = (s: string) => {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(s))
    throw new Error("Unsupported SQL identifier.");
  return '"' + s + '"';
};

const tableName = (s: string) => {
  const parts = s.split(".");
  if (parts.length !== 2) throw new Error("Use an explicit schema.table.");
  return parts.map(ident).join(".");
};

const json = (value: unknown): Json => JSON.parse(canonicalJson(value));

function triggerSource(target: ManagedTable, schema: string): string {
  const pairs = (prefix: string) =>
    target.primaryKey
      .flatMap((k) => ["'" + k + "'", `to_jsonb(${prefix})->'${k}'`])
      .join(",");
  return `DECLARE old_key text; new_key text;
    BEGIN
     IF TG_OP <> 'INSERT' THEN old_key := TG_TABLE_SCHEMA || '.' || TG_TABLE_NAME || ':' || jsonb_build_object(${pairs("OLD")})::text; END IF;
     IF TG_OP <> 'DELETE' THEN new_key := TG_TABLE_SCHEMA || '.' || TG_TABLE_NAME || ':' || jsonb_build_object(${pairs("NEW")})::text; END IF;
     IF old_key IS NOT NULL THEN INSERT INTO ${schema}.revisions VALUES(old_key,1) ON CONFLICT(resource) DO UPDATE SET revision=${schema}.revisions.revision+1; END IF;
     IF new_key IS NOT NULL AND new_key IS DISTINCT FROM old_key THEN INSERT INTO ${schema}.revisions VALUES(new_key,1) ON CONFLICT(resource) DO UPDATE SET revision=${schema}.revisions.revision+1; END IF;
     RETURN NULL;
    END`;
}

/** Explicitly installed and migrated by an operator, never during a tool call. */
export const MANAGED_METADATA_VERSION = 2;

export type ManagedMetadataInspection = {
  metadataVersion: number | null;
  complete: boolean;
  legacyWithoutVersion: boolean;
};

type MetadataColumn = readonly [
  name: string,
  type: string,
  nullable: boolean,
  primaryKey: boolean,
  defaultVersion: number | null | "invalid",
];

const metadataLayoutV1: Readonly<Record<string, readonly MetadataColumn[]>> = {
  meta: [
    ["key", "text", false, true, null],
    ["version", "int4", false, false, null],
  ],
  revisions: [
    ["resource", "text", false, true, null],
    ["revision", "int8", false, false, null],
  ],
  operations: [
    ["id", "text", false, true, null],
    ["request_digest", "text", false, false, null],
    ["capture", "jsonb", false, false, null],
    ["outcome", "jsonb", false, false, null],
  ],
  recoveries: [
    ["id", "text", false, true, null],
    ["input_digest", "text", false, false, null],
    ["outcome", "jsonb", false, false, null],
  ],
};
const metadataLayoutV2: Readonly<Record<string, readonly MetadataColumn[]>> = {
  ...metadataLayoutV1,
  operations: [
    ...metadataLayoutV1.operations,
    ["format_version", "int4", false, false, MANAGED_METADATA_VERSION],
  ],
  recoveries: [
    ...metadataLayoutV1.recoveries,
    ["format_version", "int4", false, false, MANAGED_METADATA_VERSION],
  ],
};
const metadataTables = Object.keys(metadataLayoutV2);

async function metadataPresent(
  connection: ManagedConnection,
  schema: string,
  table: string,
): Promise<boolean> {
  const rows = await connection.query<{ exists: string | boolean }>(
    "SELECT to_regclass($1)::text IS NOT NULL AS exists",
    [`${schema}.${table}`],
  );
  return rows[0]?.exists === true || rows[0]?.exists === "true";
}

async function metadataLayout(connection: ManagedConnection, schema: string) {
  const [revisions, operations, recoveries, meta] = await Promise.all([
    metadataPresent(connection, schema, "revisions"),
    metadataPresent(connection, schema, "operations"),
    metadataPresent(connection, schema, "recoveries"),
    metadataPresent(connection, schema, "meta"),
  ]);
  return { revisions, operations, recoveries, meta };
}

async function metadataVersion(
  connection: ManagedConnection,
  schema: string,
): Promise<number | null> {
  const version = (
    await connection.query<{ version: string }>(
      `SELECT version::text AS version FROM ${schema}.meta WHERE key='version'`,
    )
  )[0]?.version;
  const value = version === undefined ? null : Number(version);
  return Number.isSafeInteger(value) ? value : null;
}

async function metadataColumnPresent(
  connection: ManagedConnection,
  schema: string,
  table: string,
  column: string,
): Promise<boolean> {
  const rows = await connection.query<{ exists: string | boolean }>(
    "SELECT EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema=$1 AND table_name=$2 AND column_name=$3) AS exists",
    [schema, table, column],
  );
  return rows[0]?.exists === true || rows[0]?.exists === "true";
}

async function metadataStructureValid(
  connection: ManagedConnection,
  schemaName: string,
  expected: Readonly<Record<string, readonly MetadataColumn[]>>,
): Promise<boolean> {
  const rows = await connection.query<{
    table_name: string;
    column_name: string;
    udt_name: string;
    nullable: boolean;
    primary_key: boolean;
    column_default: string | null;
  }>(
    `SELECT c.table_name,c.column_name,c.udt_name,c.is_nullable='YES' AS nullable,
      EXISTS (SELECT 1 FROM pg_index i WHERE i.indrelid=(quote_ident(c.table_schema)||'.'||quote_ident(c.table_name))::regclass
        AND i.indisprimary AND c.ordinal_position=ANY(i.indkey)) AS primary_key,c.column_default
    FROM information_schema.columns c
    WHERE c.table_schema=$1 AND c.table_name=ANY($2::text[])
    ORDER BY c.table_name,c.ordinal_position`,
    [schemaName, Object.keys(expected)],
  );
  const actual = new Map<string, MetadataColumn[]>();
  for (const row of rows) {
    const columns = actual.get(row.table_name) ?? [];
    const defaultSource = row.column_default?.trim() ?? null;
    const defaultVersion =
      defaultSource === null
        ? null
        : /^-?(?:0|[1-9][0-9]*)$/.test(defaultSource)
          ? Number(defaultSource)
          : "invalid";
    columns.push([
      row.column_name,
      row.udt_name,
      row.nullable,
      row.primary_key,
      defaultVersion,
    ]);
    actual.set(row.table_name, columns);
  }
  const [relations, indexes, constraints, triggers, rules] = await Promise.all([
    connection.query<{
      name: string;
      kind: string;
      rls: boolean;
      force_rls: boolean;
      has_rules: boolean;
    }>(
      `SELECT c.relname AS name,c.relkind AS kind,c.relrowsecurity AS rls,c.relforcerowsecurity AS force_rls,c.relhasrules AS has_rules
       FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
       WHERE n.nspname=$1 AND c.relkind IN ('r','p','v','m','S','f') ORDER BY c.relname`,
      [schemaName],
    ),
    connection.query<{
      table_name: string;
      primary_index: boolean;
      valid: boolean;
    }>(
      `SELECT c.relname AS table_name,i.indisprimary AS primary_index,i.indisvalid AS valid
       FROM pg_index i JOIN pg_class c ON c.oid=i.indrelid JOIN pg_namespace n ON n.oid=c.relnamespace
       WHERE n.nspname=$1 AND c.relname=ANY($2::text[]) ORDER BY c.relname,i.indexrelid`,
      [schemaName, Object.keys(expected)],
    ),
    connection.query<{ table_name: string; type: string }>(
      `SELECT c.relname AS table_name,k.contype AS type FROM pg_constraint k
       JOIN pg_class c ON c.oid=k.conrelid JOIN pg_namespace n ON n.oid=c.relnamespace
       WHERE n.nspname=$1 AND c.relname=ANY($2::text[]) ORDER BY c.relname,k.oid`,
      [schemaName, Object.keys(expected)],
    ),
    connection.query<{ table_name: string }>(
      `SELECT c.relname AS table_name FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid
       JOIN pg_namespace n ON n.oid=c.relnamespace
       WHERE n.nspname=$1 AND c.relname=ANY($2::text[]) AND NOT t.tgisinternal`,
      [schemaName, Object.keys(expected)],
    ),
    connection.query<{ table_name: string; rule_name: string }>(
      `SELECT c.relname AS table_name,r.rulename AS rule_name FROM pg_rewrite r
       JOIN pg_class c ON c.oid=r.ev_class JOIN pg_namespace n ON n.oid=c.relnamespace
       WHERE n.nspname=$1 AND c.relname=ANY($2::text[])`,
      [schemaName, Object.keys(expected)],
    ),
  ]);
  const tableNames = Object.keys(expected).sort();
  return (
    Object.entries(expected).every(
      ([table, columns]) =>
        canonicalJson(actual.get(table)) === canonicalJson(columns),
    ) &&
    rows.length ===
      Object.values(expected).reduce(
        (sum, columns) => sum + columns.length,
        0,
      ) &&
    canonicalJson(relations.map((relation) => relation.name)) ===
      canonicalJson(tableNames) &&
    relations.every(
      (relation) =>
        relation.kind === "r" && !relation.rls && !relation.force_rls,
    ) &&
    indexes.length === tableNames.length &&
    indexes.every((index) => index.primary_index && index.valid) &&
    constraints.length === tableNames.length &&
    constraints.every((constraint) => constraint.type === "p") &&
    triggers.length === 0 &&
    rules.length === 0
  );
}

async function inspectMetadata(
  connection: ManagedConnection,
  schemaName: string,
): Promise<ManagedMetadataInspection> {
  const schema = ident(schemaName),
    layout = await metadataLayout(connection, schema);
  if (!layout.meta)
    return {
      metadataVersion: null,
      complete: false,
      legacyWithoutVersion:
        layout.revisions || layout.operations || layout.recoveries,
    };
  const version = await metadataVersion(connection, schema);
  return {
    metadataVersion: version,
    complete:
      version === MANAGED_METADATA_VERSION &&
      Object.values(layout).every(Boolean) &&
      (await metadataStructureValid(connection, schemaName, metadataLayoutV2)),
    legacyWithoutVersion: false,
  };
}

async function metadataIdentity(
  connection: ManagedConnection,
  schemaName: string,
): Promise<readonly string[]> {
  const rows = await connection.query<{ identity: string }>(
    `SELECT 'schema:'||n.oid::text AS identity FROM pg_namespace n WHERE n.nspname=$1
     UNION ALL SELECT c.relname||':'||c.oid::text AS identity FROM pg_class c
     JOIN pg_namespace n ON n.oid=c.relnamespace
     WHERE n.nspname=$1 AND c.relname=ANY($2::text[]) ORDER BY identity`,
    [schemaName, metadataTables],
  );
  return rows.map((row) => row.identity);
}

function sameIdentity(
  left: readonly string[],
  right: readonly string[],
): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

function assertInstallableMetadata(
  inspection: ManagedMetadataInspection,
  metaPresent: boolean,
): void {
  if (inspection.legacyWithoutVersion)
    throw new Error("Legacy managed PostgreSQL metadata has no version.");
  if (inspection.metadataVersion === 1)
    throw new Error(
      "Managed PostgreSQL metadata version 1 requires explicit migration.",
    );
  if (
    inspection.metadataVersion !== null &&
    inspection.metadataVersion !== MANAGED_METADATA_VERSION
  )
    throw new Error(
      `Unsupported managed PostgreSQL metadata version ${inspection.metadataVersion}.`,
    );
  if (
    inspection.metadataVersion === MANAGED_METADATA_VERSION &&
    !inspection.complete
  )
    throw new Error(
      "Managed PostgreSQL metadata version 2 has malformed structure.",
    );
  if (inspection.metadataVersion === null && metaPresent)
    throw new Error(
      "Managed PostgreSQL metadata version is missing or malformed.",
    );
}

export async function inspectManagedPostgres(
  options: ManagedPostgresOptions,
): Promise<ManagedMetadataInspection> {
  const connection = await options.connect();
  try {
    return await inspectMetadata(connection, options.schema);
  } finally {
    await connection.close();
  }
}

function assertTableConfig(target: ManagedTable, tenant?: ManagedTenantScope) {
  tableName(target.table);
  if (!target.primaryKey.length) throw new Error("A primary key is required.");
  target.primaryKey.forEach(ident);
  target.columns.forEach(ident);
  if (tenant) {
    ident(tenant.column);
    if (target.primaryKey.includes(tenant.column))
      throw new Error("Tenant scope cannot be supplied as a request key.");
  }
}

function assertTenantConfig(tenant: ManagedTenantScope | undefined) {
  if (!tenant) return;
  ident(tenant.column);
  if (
    !/^[a-zA-Z_][a-zA-Z0-9_]*(?:\.[a-zA-Z_][a-zA-Z0-9_]*)+$/.test(
      tenant.setting,
    )
  )
    throw new Error("Tenant setting must be a qualified PostgreSQL setting.");
}

/** Creates metadata only for a fresh schema or reinstalls exact version 2 metadata. */
export async function installManagedPostgres(
  options: ManagedPostgresOptions,
): Promise<{ installedTables: readonly string[]; metadataVersion: number }> {
  const schema = ident(options.schema);
  assertTenantConfig(options.tenant);
  options.tables.forEach((target) => assertTableConfig(target, options.tenant));
  const connection = await options.connect();
  let begun = false;
  try {
    const identityBefore = await metadataIdentity(connection, options.schema);
    const inspection = await inspectMetadata(connection, options.schema);
    const identityAfter = await metadataIdentity(connection, options.schema);
    if (!sameIdentity(identityBefore, identityAfter))
      throw new Error(
        "Managed PostgreSQL metadata identity changed during preflight.",
      );
    assertInstallableMetadata(
      inspection,
      await metadataPresent(connection, schema, "meta"),
    );
    const existing = inspection.metadataVersion === MANAGED_METADATA_VERSION;
    await connection.query("BEGIN");
    begun = true;
    await connection.query(
      "SELECT pg_advisory_xact_lock(hashtextextended($1,0))",
      [`void-managed-metadata:${options.schema}`],
    );
    if (existing)
      await connection.query(
        `LOCK TABLE ${schema}.meta,${schema}.revisions,${schema}.operations,${schema}.recoveries IN ACCESS EXCLUSIVE MODE`,
      );
    const locked = await inspectMetadata(connection, options.schema);
    assertInstallableMetadata(
      locked,
      await metadataPresent(connection, schema, "meta"),
    );
    if (
      existing !== (locked.metadataVersion === MANAGED_METADATA_VERSION) ||
      !sameIdentity(
        identityAfter,
        await metadataIdentity(connection, options.schema),
      )
    )
      throw new Error(
        "Managed PostgreSQL metadata identity changed during installation.",
      );
    await connection.query(`CREATE SCHEMA IF NOT EXISTS ${schema}`);
    const createTable = existing
      ? "CREATE TABLE IF NOT EXISTS"
      : "CREATE TABLE";
    await connection.query(
      `${createTable} ${schema}.meta(key text PRIMARY KEY, version integer NOT NULL)`,
    );
    await connection.query(
      `${createTable} ${schema}.revisions(resource text PRIMARY KEY, revision bigint NOT NULL)`,
    );
    await connection.query(
      `${createTable} ${schema}.operations(id text PRIMARY KEY, request_digest text NOT NULL, capture jsonb NOT NULL, outcome jsonb NOT NULL, format_version integer NOT NULL DEFAULT ${MANAGED_METADATA_VERSION})`,
    );
    await connection.query(
      `${createTable} ${schema}.recoveries(id text PRIMARY KEY, input_digest text NOT NULL, outcome jsonb NOT NULL, format_version integer NOT NULL DEFAULT ${MANAGED_METADATA_VERSION})`,
    );
    const installed: string[] = [];
    for (const target of options.tables) {
      const table = tableName(target.table),
        suffix = hash(target.table).slice(0, 16);
      const fn = `${schema}.${ident("revision_" + suffix)}`,
        trigger = ident("void_revision_" + suffix);
      await connection.query(
        `CREATE OR REPLACE FUNCTION ${fn}() RETURNS trigger LANGUAGE plpgsql AS $body$${triggerSource(target, schema)}$body$`,
      );
      await connection.query(`DROP TRIGGER IF EXISTS ${trigger} ON ${table}`);
      await connection.query(
        `CREATE TRIGGER ${trigger} AFTER INSERT OR UPDATE OR DELETE ON ${table} FOR EACH ROW EXECUTE FUNCTION ${fn}()`,
      );
      installed.push(target.table);
    }
    if (
      !(await metadataStructureValid(
        connection,
        options.schema,
        metadataLayoutV2,
      ))
    )
      throw new Error(
        "Managed PostgreSQL metadata changed during installation.",
      );
    const finalVersion = await metadataVersion(connection, schema);
    if (
      (existing && finalVersion !== MANAGED_METADATA_VERSION) ||
      (!existing && finalVersion !== null)
    )
      throw new Error(
        "Managed PostgreSQL metadata changed during installation.",
      );
    await connection.query(
      `INSERT INTO ${schema}.meta(key,version) VALUES('version',${MANAGED_METADATA_VERSION}) ON CONFLICT(key) DO UPDATE SET version=EXCLUDED.version`,
    );
    if (
      !(await metadataStructureValid(
        connection,
        options.schema,
        metadataLayoutV2,
      )) ||
      (await metadataVersion(connection, schema)) !== MANAGED_METADATA_VERSION
    )
      throw new Error(
        "Managed PostgreSQL metadata changed during installation.",
      );
    await connection.query("COMMIT");
    begun = false;
    return {
      installedTables: installed,
      metadataVersion: MANAGED_METADATA_VERSION,
    };
  } catch (error) {
    if (begun) await connection.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    await connection.close();
  }
}

/** Explicitly migrates the exact released version 1 layout to version 2. */
export async function migrateManagedPostgres(
  options: ManagedPostgresOptions,
): Promise<{ fromVersion: number; metadataVersion: number }> {
  const schema = ident(options.schema),
    connection = await options.connect();
  let begun = false;
  try {
    const identityBefore = await metadataIdentity(connection, options.schema);
    const inspection = await inspectMetadata(connection, options.schema);
    const identityAfter = await metadataIdentity(connection, options.schema);
    if (!sameIdentity(identityBefore, identityAfter))
      throw new Error(
        "Managed PostgreSQL metadata identity changed during preflight.",
      );
    if (inspection.legacyWithoutVersion || inspection.metadataVersion === null)
      throw new Error(
        "Recovery metadata version is missing; manual review is required.",
      );
    if (
      inspection.metadataVersion !== 1 &&
      inspection.metadataVersion !== MANAGED_METADATA_VERSION
    )
      throw new Error(
        `Unsupported managed PostgreSQL metadata version ${inspection.metadataVersion}.`,
      );
    const expected =
      inspection.metadataVersion === 1 ? metadataLayoutV1 : metadataLayoutV2;
    if (!(await metadataStructureValid(connection, options.schema, expected)))
      throw new Error(
        `Managed PostgreSQL metadata version ${inspection.metadataVersion} has malformed structure.`,
      );
    const fromVersion = inspection.metadataVersion;
    await connection.query("BEGIN");
    begun = true;
    await connection.query(
      "SELECT pg_advisory_xact_lock(hashtextextended($1,0))",
      [`void-managed-metadata:${options.schema}`],
    );
    await connection.query(
      `LOCK TABLE ${schema}.meta,${schema}.revisions,${schema}.operations,${schema}.recoveries IN ACCESS EXCLUSIVE MODE`,
    );
    if (
      !sameIdentity(
        identityAfter,
        await metadataIdentity(connection, options.schema),
      )
    )
      throw new Error(
        "Managed PostgreSQL metadata identity changed during migration.",
      );
    if (
      (await metadataVersion(connection, schema)) !== fromVersion ||
      !(await metadataStructureValid(connection, options.schema, expected))
    )
      throw new Error("Managed PostgreSQL metadata changed during migration.");
    if (fromVersion === MANAGED_METADATA_VERSION) {
      await connection.query("COMMIT");
      begun = false;
      return { fromVersion, metadataVersion: MANAGED_METADATA_VERSION };
    }
    await connection.query(
      `ALTER TABLE ${schema}.operations ADD COLUMN format_version integer NOT NULL DEFAULT 1`,
    );
    await connection.query(
      `ALTER TABLE ${schema}.recoveries ADD COLUMN format_version integer NOT NULL DEFAULT 1`,
    );
    await connection.query(
      `ALTER TABLE ${schema}.operations ALTER COLUMN format_version SET DEFAULT ${MANAGED_METADATA_VERSION}`,
    );
    await connection.query(
      `ALTER TABLE ${schema}.recoveries ALTER COLUMN format_version SET DEFAULT ${MANAGED_METADATA_VERSION}`,
    );
    if (
      !(await metadataStructureValid(
        connection,
        options.schema,
        metadataLayoutV2,
      ))
    )
      throw new Error("Managed PostgreSQL metadata changed during migration.");
    if ((await metadataVersion(connection, schema)) !== 1)
      throw new Error("Managed PostgreSQL metadata changed during migration.");
    const updated = await connection.query<{ version: number }>(
      `UPDATE ${schema}.meta SET version=${MANAGED_METADATA_VERSION} WHERE key='version' AND version=1 RETURNING version`,
    );
    if (
      updated.length !== 1 ||
      !(await metadataStructureValid(
        connection,
        options.schema,
        metadataLayoutV2,
      )) ||
      (await metadataVersion(connection, schema)) !==
        MANAGED_METADATA_VERSION ||
      !sameIdentity(
        identityAfter,
        await metadataIdentity(connection, options.schema),
      )
    )
      throw new Error("Managed PostgreSQL metadata changed during migration.");
    await connection.query("COMMIT");
    begun = false;
    return { fromVersion, metadataVersion: MANAGED_METADATA_VERSION };
  } catch (error) {
    if (begun) await connection.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    await connection.close();
  }
}

export function managedPostgresAdapter(
  options: ManagedPostgresOptions,
): RecoveryAdapter {
  const schema = ident(options.schema);
  assertTenantConfig(options.tenant);
  options.tables.forEach((target) => assertTableConfig(target, options.tenant));
  const tables = new Map(
    options.tables.map((target) => [target.table, target]),
  );
  if (!/^[\w-]{1,100}$/.test(options.workspace))
    throw new Error("Invalid managed workspace.");

  const pending = new Map<
    string,
    {
      connection: ManagedConnection;
      mutation: Mutation;
      prepared: Prepared;
      state: ManagedState;
      digest: string;
    }
  >();
  const operationKey = (id: string) => options.workspace + ":" + id;

  function mutation(args: Json): Mutation {
    if (!args || Array.isArray(args) || typeof args !== "object")
      throw new Error("Expected a structured row mutation.");
    if (
      Object.keys(args).some(
        (key) => !["table", "action", "key", "values"].includes(key),
      )
    )
      throw new Error("Unexpected mutation argument.");
    const target =
      typeof args.table === "string" ? tables.get(args.table) : undefined;
    if (
      !target ||
      !["insert", "update", "delete"].includes(String(args.action))
    )
      throw new Error("Table or action is not configured.");
    const key = args.key;
    const values = args.values ?? {};
    if (
      !key ||
      typeof key !== "object" ||
      Array.isArray(key) ||
      !values ||
      typeof values !== "object" ||
      Array.isArray(values)
    )
      throw new Error("Expected key and values objects.");
    if (
      Object.keys(key).length !== target.primaryKey.length ||
      target.primaryKey.some(
        (column) =>
          !Object.hasOwn(key, column) ||
          key[column] === null ||
          typeof key[column] === "object",
      )
    )
      throw new Error("Exact non-null primary key required.");
    if (options.tenant && Object.hasOwn(key, options.tenant.column))
      throw new Error("Tenant scope is server-bound and cannot be requested.");
    if (
      Object.keys(values).some(
        (column) =>
          !target.columns.includes(column) ||
          target.primaryKey.includes(column) ||
          column === options.tenant?.column,
      )
    )
      throw new Error("Column is not writable.");
    if (
      (args.action === "update" && !Object.keys(values).length) ||
      (args.action === "delete" && Object.keys(values).length)
    )
      throw new Error("Invalid values for mutation action.");
    return {
      table: target.table,
      action: args.action as Mutation["action"],
      key: key as Record<string, Json>,
      values: values as Record<string, Json>,
    };
  }

  async function requireCurrentMetadata(connection: ManagedConnection) {
    const version = await metadataVersion(connection, schema);
    if (version !== MANAGED_METADATA_VERSION)
      throw new Error(
        "Recovery metadata migration is required before execution.",
      );
    const [operations, recoveries] = await Promise.all([
      metadataColumnPresent(
        connection,
        options.schema,
        "operations",
        "format_version",
      ),
      metadataColumnPresent(
        connection,
        options.schema,
        "recoveries",
        "format_version",
      ),
    ]);
    if (!operations || !recoveries)
      throw new Error("Recovery metadata migration is incomplete.");
  }

  async function boundTenant(
    connection: ManagedConnection,
    target: ManagedTable,
  ): Promise<BoundTenantScope | null> {
    if (!options.tenant) return null;
    const value = (
      await connection.query<{ value: string | null }>(
        "SELECT current_setting($1,true) AS value",
        [options.tenant.setting],
      )
    )[0]?.value;
    if (!value) throw new Error("Server-bound tenant setting is unavailable.");
    const policies = await connection.query<{
      qual: string | null;
      withCheck: string | null;
    }>(
      "SELECT pg_get_expr(polqual,polrelid) AS qual,pg_get_expr(polwithcheck,polrelid) AS with_check FROM pg_policy WHERE polrelid=$1::regclass",
      [target.table],
    );
    const expectedSetting = options.tenant.setting.toLowerCase();
    const expectedColumn = options.tenant.column.toLowerCase();
    if (
      !policies.some((policy) => {
        const source =
          `${policy.qual ?? ""} ${policy.withCheck ?? ""}`.toLowerCase();
        return (
          source.includes(expectedSetting) && source.includes(expectedColumn)
        );
      })
    )
      throw new Error(
        "Tenant RLS policy does not bind the configured server setting.",
      );
    return { ...options.tenant, value };
  }

  async function certifyTable(
    connection: ManagedConnection,
    target: ManagedTable,
    tenant: BoundTenantScope | null,
  ) {
    const expected = "void_revision_" + hash(target.table).slice(0, 16);
    const triggers = await connection.query<{
      tgname: string;
      tgenabled: string;
      prosrc: string;
      namespace: string;
      tgtype: number;
      unconditional: boolean;
    }>(
      `SELECT t.tgname,t.tgenabled,t.tgtype,t.tgqual IS NULL AS unconditional,p.prosrc,n.nspname AS namespace FROM pg_trigger t JOIN pg_proc p ON p.oid=t.tgfoid JOIN pg_namespace n ON n.oid=p.pronamespace WHERE t.tgrelid=$1::regclass AND NOT t.tgisinternal`,
      [target.table],
    );
    if (
      triggers.length !== 1 ||
      triggers[0]?.tgname !== expected ||
      triggers[0]?.tgenabled !== "O" ||
      triggers[0]?.namespace !== options.schema ||
      triggers[0]?.prosrc.trim() !== triggerSource(target, schema).trim() ||
      triggers[0]?.tgtype !== 29 ||
      !triggers[0]?.unconditional
    )
      throw new Error(
        "Managed revision trigger missing or additional trigger requires certification.",
      );
    const actual = await connection.query<{ name: string }>(
      `SELECT a.attname AS name FROM pg_index i CROSS JOIN LATERAL unnest(i.indkey) WITH ORDINALITY k(attnum,ord) JOIN pg_attribute a ON a.attrelid=i.indrelid AND a.attnum=k.attnum WHERE i.indrelid=$1::regclass AND i.indisprimary ORDER BY k.ord`,
      [target.table],
    );
    if (
      canonicalJson(actual.map((row) => row.name).sort()) !==
      canonicalJson([...target.primaryKey].sort())
    )
      throw new Error("Configured primary key does not match the database.");
    const generated = await connection.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM pg_attribute WHERE attrelid=$1::regclass AND (attgenerated<>'' OR attidentity<>'')`,
      [target.table],
    );
    if (generated[0]?.count !== "0")
      throw new Error(
        "Generated/identity columns require a certified restore strategy.",
      );
    const relation = (
      await connection.query<{
        oid: string;
        relkind: string;
        relrowsecurity: boolean;
        relhasrules: boolean;
        relispartition: boolean;
      }>(
        "SELECT oid::text,relkind,relrowsecurity,relhasrules,relispartition FROM pg_class WHERE oid=$1::regclass",
        [target.table],
      )
    )[0];
    if (!relation) throw new Error("Configured relation does not exist.");
    if (
      relation.relkind !== "r" ||
      relation.relhasrules ||
      relation.relispartition ||
      (tenant ? !relation.relrowsecurity : relation.relrowsecurity)
    )
      throw new Error(
        tenant
          ? "Configured tenant table requires certified row-level security."
          : "RLS, rules, partitioned and nonordinary relations require separate certification.",
      );
    return relation.oid;
  }

  async function resourceFor(
    connection: ManagedConnection,
    table: string,
    key: Record<string, Json>,
  ) {
    return (
      await connection.query<{ resource: string }>(
        "SELECT $1::text || ':' || $2::jsonb::text AS resource",
        [table, canonicalJson(key)],
      )
    )[0]!.resource;
  }

  function whereForKey(
    key: Record<string, Json>,
    offset: number,
    tenant: BoundTenantScope | null,
  ) {
    const keys = Object.keys(key).sort();
    const clauses = keys.map(
      (column, index) => `${ident(column)}=$${offset + index + 1}`,
    );
    const params: Json[] = keys.map((column) => key[column]!);
    if (tenant) {
      clauses.push(
        `${ident(tenant.column)}=current_setting($${offset + params.length + 1},true)`,
      );
      params.push(tenant.setting);
    }
    return { where: clauses.join(" AND "), params };
  }

  function keyForRow(target: ManagedTable, row: Json): Record<string, Json> {
    if (!row || Array.isArray(row) || typeof row !== "object")
      throw new Error("Captured PostgreSQL row is invalid.");
    const key: Record<string, Json> = {};
    for (const column of target.primaryKey) {
      const value = row[column];
      if (value === null || value === undefined || typeof value === "object")
        throw new Error("Captured PostgreSQL primary key is invalid.");
      key[column] = value;
    }
    return key;
  }

  async function inspectRow(
    connection: ManagedConnection,
    target: ManagedTable,
    key: Record<string, Json>,
    tenant: BoundTenantScope | null,
    lock = false,
    depth = 0,
  ): Promise<RowCapture> {
    const resource = await resourceFor(connection, target.table, key);
    if (lock)
      await connection.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1,0))",
        [resource],
      );
    const relationOid = await certifyTable(connection, target, tenant);
    const predicate = whereForKey(key, 0, tenant);
    const row =
      (
        await connection.query<{ row: Json }>(
          `SELECT to_jsonb(target) AS row FROM ${tableName(target.table)} AS target WHERE ${predicate.where}${lock ? " FOR UPDATE" : ""}`,
          predicate.params,
        )
      )[0]?.row ?? null;
    if (
      tenant &&
      row !== null &&
      (Array.isArray(row) ||
        typeof row !== "object" ||
        String(row[tenant.column]) !== tenant.value)
    )
      throw new Error("Tenant RLS scope returned an out-of-scope row.");
    const revision =
      (
        await connection.query<{ revision: string }>(
          `SELECT revision::text AS revision FROM ${schema}.revisions WHERE resource=$1`,
          [resource],
        )
      )[0]?.revision ?? "0";
    return {
      table: target.table,
      key,
      row,
      resource,
      revision,
      relationOid,
      depth,
    };
  }

  async function cascadeEdges(
    connection: ManagedConnection,
    parent: string,
  ): Promise<CascadeEdge[]> {
    return connection.query<CascadeEdge>(
      `SELECT child_ns.nspname || '.' || child.relname AS table,
        array_agg(child_att.attname ORDER BY child_key.ordinality) AS "childColumns",
        array_agg(parent_att.attname ORDER BY parent_key.ordinality) AS "parentColumns",
        con.confdeltype AS "deleteAction"
       FROM pg_constraint con
       JOIN pg_class child ON child.oid=con.conrelid
       JOIN pg_namespace child_ns ON child_ns.oid=child.relnamespace
       JOIN unnest(con.conkey) WITH ORDINALITY AS child_key(attnum,ordinality) ON true
       JOIN unnest(con.confkey) WITH ORDINALITY AS parent_key(attnum,ordinality) ON parent_key.ordinality=child_key.ordinality
       JOIN pg_attribute child_att ON child_att.attrelid=child.oid AND child_att.attnum=child_key.attnum
       JOIN pg_attribute parent_att ON parent_att.attrelid=con.confrelid AND parent_att.attnum=parent_key.attnum
       WHERE con.contype='f' AND con.confrelid=$1::regclass
       GROUP BY child_ns.nspname,child.relname,con.oid,con.confdeltype`,
      [parent],
    );
  }

  async function captureCascade(
    connection: ManagedConnection,
    root: RowCapture,
    tenant: BoundTenantScope | null,
    lock: boolean,
  ): Promise<RowCapture[]> {
    const captures = [root];
    const seen = new Set([root.resource]);
    for (let index = 0; index < captures.length; index += 1) {
      const parent = captures[index]!;
      if (parent.row === null) continue;
      for (const edge of await cascadeEdges(connection, parent.table)) {
        if (edge.deleteAction !== "c")
          throw new Error(
            "Referenced tables require an ON DELETE CASCADE-certified adapter.",
          );
        const child = tables.get(edge.table);
        if (!child)
          throw new Error("Every cascade table must be explicitly configured.");
        if (
          tenant &&
          (!edge.childColumns.includes(tenant.column) ||
            !edge.parentColumns.includes(tenant.column))
        )
          throw new Error(
            "Tenant scope must be part of every cascade foreign key.",
          );
        const clauses: string[] = [];
        const params: Json[] = [];
        for (let column = 0; column < edge.childColumns.length; column += 1) {
          const value = (parent.row as Record<string, Json>)[
            edge.parentColumns[column]!
          ];
          if (value === undefined)
            throw new Error("Cascade parent value was not captured.");
          clauses.push(
            `${ident(edge.childColumns[column]!)}=$${params.length + 1}`,
          );
          params.push(value);
        }
        if (tenant) {
          clauses.push(
            `${ident(tenant.column)}=current_setting($${params.length + 1},true)`,
          );
          params.push(tenant.setting);
        }
        const rows = await connection.query<{ row: Json }>(
          `SELECT to_jsonb(target) AS row FROM ${tableName(child.table)} AS target WHERE ${clauses.join(" AND ")}${lock ? " FOR UPDATE" : ""}`,
          params,
        );
        for (const candidate of rows) {
          const key = keyForRow(child, candidate.row);
          const capture = await inspectRow(
            connection,
            child,
            key,
            tenant,
            lock,
            parent.depth + 1,
          );
          if (capture.row === null)
            throw new Error("Cascade row disappeared during capture.");
          if (!seen.has(capture.resource)) {
            seen.add(capture.resource);
            captures.push(capture);
          }
        }
      }
    }
    return captures;
  }

  async function inspectState(
    connection: ManagedConnection,
    m: Mutation,
    lock = false,
  ): Promise<ManagedState> {
    await requireCurrentMetadata(connection);
    const target = tables.get(m.table)!;
    const tenant = await boundTenant(connection, target);
    const root = await inspectRow(connection, target, m.key, tenant, lock);
    if (tenant && m.action !== "insert" && root.row === null)
      throw new Error(
        "Target is absent or outside the server-bound tenant scope.",
      );
    if (m.action !== "delete") {
      const inbound = await cascadeEdges(connection, target.table);
      if (inbound.length)
        throw new Error(
          "Referenced tables require a cascade-certified delete operation.",
        );
    }
    const rows =
      m.action === "delete" && root.row !== null
        ? await captureCascade(connection, root, tenant, lock)
        : [root];
    return { rows, tenant };
  }

  function planFrom(prepared: Prepared) {
    const plan = prepared.plan as unknown as {
      mutation?: Mutation;
      operationKey?: string;
      captures?: RowCapture[];
      tenant?: BoundTenantScope | null;
    };
    if (
      !plan ||
      typeof plan !== "object" ||
      !plan.mutation ||
      typeof plan.operationKey !== "string" ||
      !Array.isArray(plan.captures) ||
      !plan.captures.length
    )
      throw new Error("Recovery plan is malformed.");
    const captures = plan.captures.map((capture) => {
      if (
        !capture ||
        typeof capture.table !== "string" ||
        !capture.key ||
        typeof capture.key !== "object" ||
        Array.isArray(capture.key) ||
        typeof capture.resource !== "string" ||
        typeof capture.revision !== "string" ||
        typeof capture.relationOid !== "string" ||
        !Number.isSafeInteger(capture.depth)
      )
        throw new Error("Recovery capture is malformed.");
      return capture;
    });
    return {
      mutation: mutation(json(plan.mutation)),
      operationKey: plan.operationKey,
      captures,
      tenant: plan.tenant ?? null,
    };
  }

  async function stateForCaptures(
    connection: ManagedConnection,
    captures: RowCapture[],
    planTenant: BoundTenantScope | null,
    lock = false,
  ): Promise<ManagedState> {
    const first = tables.get(captures[0]!.table);
    if (!first) throw new Error("Recovery capture table is not configured.");
    const actualTenant = await boundTenant(connection, first);
    if (canonicalJson(actualTenant) !== canonicalJson(planTenant))
      throw new Error("Server-bound tenant scope changed since capture.");
    const lookup = async (capture: RowCapture) => {
      const target = tables.get(capture.table);
      if (!target) throw new Error("Recovery capture table is not configured.");
      return inspectRow(
        connection,
        target,
        capture.key,
        actualTenant,
        lock,
        capture.depth,
      );
    };
    const locks = lock
      ? new Map(
          await Promise.all(
            [...captures]
              .sort((left, right) =>
                left.resource.localeCompare(right.resource),
              )
              .map(
                async (capture) =>
                  [capture.resource, await lookup(capture)] as const,
              ),
          ),
        )
      : null;
    return {
      rows: captures
        .map((capture) => locks?.get(capture.resource) ?? lookup(capture))
        .map((value) => value as RowCapture),
      tenant: actualTenant,
    };
  }

  async function observedCaptures(
    connection: ManagedConnection,
    captures: RowCapture[],
    planTenant: BoundTenantScope | null,
    lock = false,
  ): Promise<ManagedState> {
    const first = tables.get(captures[0]!.table);
    if (!first) throw new Error("Recovery capture table is not configured.");
    const actualTenant = await boundTenant(connection, first);
    if (canonicalJson(actualTenant) !== canonicalJson(planTenant))
      throw new Error("Server-bound tenant scope changed since capture.");
    const ordered = lock
      ? [...captures].sort((left, right) =>
          left.resource.localeCompare(right.resource),
        )
      : captures;
    const states = new Map<string, RowCapture>();
    for (const capture of ordered) {
      const target = tables.get(capture.table);
      if (!target) throw new Error("Recovery capture table is not configured.");
      states.set(
        capture.resource,
        await inspectRow(
          connection,
          target,
          capture.key,
          actualTenant,
          lock,
          capture.depth,
        ),
      );
    }
    return {
      rows: captures.map((capture) => states.get(capture.resource)!),
      tenant: actualTenant,
    };
  }

  async function readReceipt(id: string) {
    const connection = await options.connect();
    try {
      return (
        await connection.query<{ outcome: Outcome; capture: Prepared }>(
          `SELECT outcome,capture FROM ${schema}.operations WHERE id=$1`,
          [operationKey(id)],
        )
      )[0];
    } finally {
      await connection.close();
    }
  }

  return {
    id: "postgres-managed-" + options.workspace,
    version: "2",
    async preflight(args) {
      const m = mutation(args);
      const connection = await options.connect();
      try {
        const state = await inspectState(connection, m);
        return {
          effect: "write",
          reversibility: "r1",
          readiness: "verified",
          scope:
            "Configured PostgreSQL row values and captured cascade descendants; excludes external observers and transaction history.",
          resources: state.rows.map((row) => row.resource),
          revision: json(state),
          blastRadius: { count: state.rows.length, precision: "exact" },
        };
      } finally {
        await connection.close();
      }
    },
    async prepare(args, observation, id) {
      if (pending.has(id)) throw new Error("Operation already prepared.");
      const m = mutation(args);
      const connection = await options.connect();
      try {
        await connection.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
        const state = await inspectState(connection, m, true);
        if (canonicalJson(state) !== canonicalJson(observation.revision))
          throw new Error("Target changed since authorization.");
        const root = state.rows[0]!;
        if ((m.action === "insert") !== (root.row === null))
          throw new Error("Row existence precondition failed.");
        const prepared = {
          before: root.row,
          plan: json({
            mutation: m,
            operationKey: operationKey(id),
            captures: state.rows,
            tenant: state.tenant,
          }),
        };
        pending.set(id, {
          connection,
          mutation: m,
          prepared,
          state,
          digest: hash(args),
        });
        return prepared;
      } catch (error) {
        await connection.query("ROLLBACK").catch(() => {});
        await connection.close();
        throw error;
      }
    },
    async execute(args, prepared, id) {
      const p = pending.get(id);
      if (
        !p ||
        p.digest !== hash(args) ||
        canonicalJson(p.prepared) !== canonicalJson(prepared)
      )
        throw new Error("Preparation does not match dispatch.");
      const m = p.mutation;
      const connection = p.connection;
      const target = tables.get(m.table)!;
      const values = Object.keys(m.values).sort();
      const table = tableName(m.table);
      if (m.action === "insert") {
        const row: Record<string, Json> = { ...m.key, ...m.values };
        if (p.state.tenant) row[p.state.tenant.column] = p.state.tenant.value;
        const columns = Object.keys(row).sort();
        await connection.query(
          `INSERT INTO ${table} (${columns.map(ident).join(",")}) VALUES (${columns.map((_, index) => "$" + (index + 1)).join(",")})`,
          columns.map((column) => row[column]!),
        );
      } else if (m.action === "update") {
        const predicate = whereForKey(m.key, values.length, p.state.tenant);
        await connection.query(
          `UPDATE ${table} SET ${values.map((column, index) => `${ident(column)}=$${index + 1}`).join(",")} WHERE ${predicate.where}`,
          [...values.map((column) => m.values[column]!), ...predicate.params],
        );
      } else {
        const predicate = whereForKey(m.key, 0, p.state.tenant);
        await connection.query(
          `DELETE FROM ${table} WHERE ${predicate.where}`,
          predicate.params,
        );
      }
      const after = await observedCaptures(
        connection,
        p.state.rows,
        p.state.tenant,
      );
      const outcome = { result: after.rows[0]!.row, evidence: json(after) };
      await connection.query(
        `INSERT INTO ${schema}.operations(id,request_digest,capture,outcome,format_version) VALUES($1,$2,$3::jsonb,$4::jsonb,$5)`,
        [
          operationKey(id),
          p.digest,
          canonicalJson(prepared),
          canonicalJson(outcome),
          MANAGED_METADATA_VERSION,
        ],
      );
      await connection.query("COMMIT");
      pending.delete(id);
      await connection.close();
      return outcome;
    },
    async release(id) {
      const p = pending.get(id);
      if (p) {
        pending.delete(id);
        try {
          await p.connection.query("ROLLBACK");
        } finally {
          await p.connection.close();
        }
      }
    },
    async reconcile(id, prepared) {
      const receipt = await readReceipt(id);
      if (receipt && canonicalJson(receipt.capture) !== canonicalJson(prepared))
        throw new Error("Capture identity mismatch.");
      return receipt
        ? { status: "succeeded", outcome: receipt.outcome }
        : { status: "unknown" };
    },
    async reconcileRecovery(prepared, outcome, id) {
      const connection = await options.connect();
      try {
        const receipt = (
          await connection.query<{
            input_digest: string;
            outcome: { status: "restored"; evidence: Json };
          }>(
            `SELECT input_digest,outcome FROM ${schema}.recoveries WHERE id=$1`,
            [operationKey(id)],
          )
        )[0];
        if (!receipt) return { status: "unknown" };
        if (receipt.input_digest !== hash({ prepared, outcome }))
          throw new Error("Recovery receipt input mismatch.");
        return receipt.outcome;
      } finally {
        await connection.close();
      }
    },
    async recover(prepared, outcome, id) {
      const plan = planFrom(prepared);
      const connection = await options.connect();
      try {
        await connection.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
        await connection.query(
          "SELECT pg_advisory_xact_lock(hashtextextended($1,0))",
          [operationKey(id)],
        );
        const inputDigest = hash({ prepared, outcome });
        const original = (
          await connection.query<{ capture: Prepared; outcome: Outcome }>(
            `SELECT capture,outcome FROM ${schema}.operations WHERE id=$1`,
            [plan.operationKey],
          )
        )[0];
        if (
          !original ||
          hash({ prepared: original.capture, outcome: original.outcome }) !==
            inputDigest
        )
          throw new Error("Capture or outcome identity mismatch.");
        const receipt = (
          await connection.query<{
            input_digest: string;
            outcome: { status: "restored"; evidence: Json };
          }>(
            `SELECT input_digest,outcome FROM ${schema}.recoveries WHERE id=$1`,
            [operationKey(id)],
          )
        )[0];
        if (receipt) {
          if (receipt.input_digest !== inputDigest)
            throw new Error("Recovery ID belongs to another input digest.");
          await connection.query("COMMIT");
          return receipt.outcome;
        }
        await requireCurrentMetadata(connection);
        const state = await observedCaptures(
          connection,
          plan.captures,
          plan.tenant,
          true,
        );
        if (canonicalJson(state) !== canonicalJson(outcome.evidence)) {
          await connection.query("ROLLBACK");
          return {
            status: "conflict",
            evidence: json({
              resources: state.rows.map((row) => ({
                resource: row.resource,
                revision: row.revision,
              })),
            }),
          };
        }
        const root = plan.captures[0]!;
        if (plan.mutation.action === "delete") {
          for (const capture of [...plan.captures].sort(
            (left, right) => left.depth - right.depth,
          )) {
            if (capture.row === null)
              throw new Error("Delete recovery capture is incomplete.");
            const row = capture.row as Record<string, Json>;
            const columns = Object.keys(row).sort();
            await connection.query(
              `INSERT INTO ${tableName(capture.table)} (${columns.map(ident).join(",")}) VALUES (${columns.map((_, index) => "$" + (index + 1)).join(",")})`,
              columns.map((column) => row[column]!),
            );
          }
        } else if (plan.mutation.action === "insert") {
          const predicate = whereForKey(root.key, 0, plan.tenant);
          await connection.query(
            `DELETE FROM ${tableName(root.table)} WHERE ${predicate.where}`,
            predicate.params,
          );
        } else {
          if (root.row === null)
            throw new Error("Update recovery capture is incomplete.");
          const target = tables.get(root.table)!;
          const before = root.row as Record<string, Json>;
          const writable = target.columns.filter(
            (column) =>
              column !== plan.tenant?.column &&
              !target.primaryKey.includes(column),
          );
          if (writable.length) {
            const predicate = whereForKey(
              root.key,
              writable.length,
              plan.tenant,
            );
            await connection.query(
              `UPDATE ${tableName(root.table)} SET ${writable.map((column, index) => `${ident(column)}=$${index + 1}`).join(",")} WHERE ${predicate.where}`,
              [
                ...writable.map((column) => before[column]!),
                ...predicate.params,
              ],
            );
          }
        }
        const restored = await observedCaptures(
          connection,
          plan.captures,
          plan.tenant,
        );
        if (
          canonicalJson(restored.rows.map((row) => row.row)) !==
          canonicalJson(plan.captures.map((capture) => capture.row))
        )
          throw new Error("Restored rows did not match the capture.");
        const result = {
          status: "restored" as const,
          evidence: json(restored),
        };
        await connection.query(
          `INSERT INTO ${schema}.recoveries(id,input_digest,outcome,format_version) VALUES($1,$2,$3::jsonb,$4)`,
          [
            operationKey(id),
            inputDigest,
            canonicalJson(result),
            MANAGED_METADATA_VERSION,
          ],
        );
        await connection.query("COMMIT");
        return result;
      } catch (error) {
        await connection.query("ROLLBACK").catch(() => {});
        throw error;
      } finally {
        await connection.close();
      }
    },
  };
}

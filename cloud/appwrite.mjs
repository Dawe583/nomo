/**
 * The Appwrite resources the hosted VOID surfaces on top of the MCP function.
 *
 * This is the manifest, not the provisioning. `cloud/appwrite.mjs` applies it
 * with `ensure` semantics — create, or verify on 409 — so a run is safe to
 * repeat and a drift is a named refusal rather than a silent overwrite. The
 * manifest lives here rather than inline in the provisioner for the reason
 * every other manifest in this repository lives in a file: a resource shape a
 * reviewer has to weigh is a resource shape that should be readable without
 * tracing control flow.
 *
 * What these tables are for. The local product is append-only and signed: a
 * ledger is a JSONL chain whose integrity is a property of bytes on a
 * machine nobody else can read. Nothing here replaces that, and nothing here
 * may be presented as evidence that a chain verified. What these tables hold
 * is the part a hosted surface can honestly serve: public reference data that
 * is identical for every reader, so serving it needs no key, no tenancy and
 * no trust decision.
 *
 * The rows are therefore all read-only-by-nature. `rowSecurity` is on for
 * every table and every table has no row-level permission at all, which means
 * a client SDK cannot read them and only the server API key can. That is the
 * correct posture for a catalogue: it is published by the MCP function, not
 * by a browser.
 */

import { readFileSync } from "node:fs";

export const appwriteManifest = Object.freeze({
  /**
   * The API root this project may send a server key to.
   *
   * Pinned for the same reason the web origins are: HTTPS alone is not a
   * boundary, and every provisioner and seeder request carries the elevated key
   * in `x-appwrite-key`. A self-hosted or non-fra region is a one-line change
   * here rather than a value smuggled in through the environment.
   */
  apiOrigin: "https://fra.cloud.appwrite.io",
  database: Object.freeze({ id: "void_control_plane", existing: true }),
  bucket: Object.freeze({
    bucketId: "void_documents",
    name: "VOID Documents",
    permissions: [],
    fileSecurity: true,
    enabled: true,
  }),
  platforms: Object.freeze([
    Object.freeze({
      platformId: "void_web",
      name: "VOID Production",
      hostname: "void-tui.vercel.app",
      origin: "https://void-tui.vercel.app",
    }),
    Object.freeze({
      platformId: "void_local_web",
      name: "VOID Local Development",
      hostname: "localhost",
      origin: "http://localhost",
    }),
  ]),
  function: Object.freeze({
    functionId: "6abbae3e000f6f24ce2a",
    name: "MCP server",
    runtime: "python-3.14",
    entrypoint: "src/main.py",
    commands: "pip install -r requirements.txt",
    timeout: 30,
    execute: Object.freeze(["any"]),
    scopes: Object.freeze([]),
    variables: Object.freeze([
      "MCP_SERVER_NAME",
      "MCP_AUTH_MODE",
      "MCP_AUTH_TOKEN",
      "MCP_TOOL_TIMEOUT",
    ]),
  }),

  /**
   * The tables this manifest adds to the existing control-plane database.
   *
   * Three tables, each answering one question a hosted reader can be given
   * without a signing key:
   *
   *   - `registry_operations` — one row per classified operation. Its `id` is
   *     the registry's own canonical dotted id, which is what makes the row a
   *     stable identity rather than a copy that has to be reconciled.
   *   - `registry_cases` — one row per precondition. This is the row that
   *     carries `tone`, because a tone belongs to a precondition and not to an
   *     operation: the same S3 PUT is r0 on a versioned bucket and r3 on an
   *     unversioned one, and a single `tone` column on the operation would
   *     have to pick one and lie about the other.
   *   - `mcp_tools` — one row per tool the hosted endpoint publishes, with the
   *     annotations a client reads before prompting.
   *
   * Indexes are declared rather than left to the server. Every column a
   * published query filters or orders by carries one, because an unindexed
   * filter on a table that grows to hold every vendor is a table scan on the
   * public path, and the public path is the one that must stay fast.
   */
  tables: Object.freeze([
    Object.freeze({
      tableId: "registry_operations",
      name: "VOID Registry Operations",
      enabled: true,
      rowSecurity: true,
      documentSecurity: true,
      columns: Object.freeze([
        Object.freeze({ key: "operation_id", type: "string", size: 160, required: true }),
        Object.freeze({ key: "vendor", type: "string", size: 64, required: true }),
        Object.freeze({ key: "surface", type: "string", size: 96, required: true }),
        Object.freeze({ key: "summary", type: "string", size: 512, required: true }),
        Object.freeze({ key: "tags", type: "string", size: 256, required: false, array: true }),
        Object.freeze({ key: "registry_version", type: "string", size: 32, required: true }),
      ]),
      indexes: Object.freeze([
        Object.freeze({ key: "operation_id_key", type: "key", columns: ["operation_id"] }),
        Object.freeze({ key: "vendor_key", type: "key", columns: ["vendor"] }),
        Object.freeze({ key: "surface_key", type: "key", columns: ["surface"] }),
        Object.freeze({ key: "registry_version_key", type: "key", columns: ["registry_version"] }),
      ]),
    }),
    Object.freeze({
      tableId: "registry_cases",
      name: "VOID Registry Cases",
      enabled: true,
      rowSecurity: true,
      documentSecurity: true,
      columns: Object.freeze([
        Object.freeze({ key: "operation_id", type: "string", size: 160, required: true }),
        Object.freeze({ key: "case_index", type: "integer", required: true }),
        Object.freeze({ key: "tone", type: "string", size: 8, required: true }),
        Object.freeze({ key: "when", type: "string", size: 512, required: true }),
        Object.freeze({ key: "inverse", type: "string", size: 512, required: false }),
        Object.freeze({ key: "window", type: "string", size: 256, required: true }),
      ]),
      indexes: Object.freeze([
        Object.freeze({ key: "operation_id_key", type: "key", columns: ["operation_id"] }),
        Object.freeze({ key: "tone_key", type: "key", columns: ["tone"] }),
      ]),
    }),
    Object.freeze({
      tableId: "mcp_tools",
      name: "VOID MCP Tools",
      enabled: true,
      rowSecurity: true,
      documentSecurity: true,
      columns: Object.freeze([
        Object.freeze({ key: "tool_name", type: "string", size: 96, required: true }),
        Object.freeze({ key: "description", type: "string", size: 512, required: true }),
        Object.freeze({ key: "hosted", type: "boolean", required: true }),
        Object.freeze({ key: "read_only", type: "boolean", required: true }),
        Object.freeze({ key: "required_arguments", type: "string", size: 256, required: false, array: true }),
      ]),
      indexes: Object.freeze([
        Object.freeze({ key: "tool_name_key", type: "key", columns: ["tool_name"] }),
      ]),
    }),
  ]),

  /**
   * A console-scoped step this manifest declares but cannot perform.
   *
   * A function's public domain is created in the Appwrite console, not through
   * the API a project-scoped key can reach: the domain routes refuse that key
   * with `general_access_forbidden`, which was measured on 2026-09-30 against
   * the live project rather than assumed. Until a domain exists, the function
   * answers `router_rule_not_found` on every public URL form, so there is no
   * hosted MCP URL to hand a client and nothing to register.
   *
   * It is recorded here because it is the one step that blocks the whole
   * public surface, and a blocker nobody can see in the manifest is a blocker
   * a reader discovers by trying.
   */
  manualSteps: Object.freeze([
    Object.freeze({
      id: "mcp-function-domain",
      why: "The function has no registered public domain, so no hosted MCP URL exists yet.",
      how: "Appwrite console > project > Functions > MCP server > Domains > add a domain.",
      blocks: Object.freeze(["public MCP endpoint", "registry submission"]),
      verified: "2026-09-30: POST to https://6abbae3e000f6f24ce2a.fra.appwrite.run answered router_rule_not_found (404)",
    }),
  ]),
});

/** The first field the live resource disagrees with, so the refusal names it. */
const driftField = (actual, expected, fields) =>
  fields.find((field) => JSON.stringify(actual?.[field]) !== JSON.stringify(expected[field])) ?? null;

function localEnv() {
  try {
    return Object.fromEntries(
      readFileSync(".env.local", "utf8")
        .split(/\r?\n/)
        .flatMap((line) => {
          const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
          return match ? [[match[1], match[2].replace(/^['"]|['"]$/g, "")]] : [];
        }),
    );
  } catch {
    return {};
  }
}

/**
 * The API root, normalised, and pinned to the manifest's origin.
 *
 * The protocol check alone is not a boundary: both callers send the elevated
 * project key to whatever host this resolves to, so the host is checked here,
 * once, rather than in each caller — a second check is a second thing to forget.
 */
export function endpoint(value) {
  const url = new URL(value);
  if (url.protocol !== "https:") throw new Error("Appwrite endpoint must use HTTPS.");
  if (url.origin !== appwriteManifest.apiOrigin)
    throw new Error(`Appwrite endpoint must be ${appwriteManifest.apiOrigin}.`);
  return new URL(`${url.pathname.replace(/\/$/, "")}/`, url.origin).href;
}

export function readProvisionConfig(env = { ...localEnv(), ...process.env }) {
  const projectId = env.APPWRITE_PROJECT_ID;
  const provisionKey = env.APPWRITE_PROVISION_KEY ?? env.APPWRITE_API_KEY;
  const databaseId = env.APPWRITE_DATABASE_ID ?? appwriteManifest.database.id;
  const webOrigins = (
    env.APPWRITE_WEB_ORIGINS ??
    appwriteManifest.platforms.map((platform) => platform.origin).join(",")
  )
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  if (
    !projectId ||
    !provisionKey ||
    !webOrigins.length ||
    webOrigins.some(
      (origin) => !appwriteManifest.platforms.some((platform) => platform.origin === origin),
    )
  )
    throw new Error(
      "Provisioning requires APPWRITE_PROJECT_ID, an Appwrite API key, and the exact manifest origins.",
    );
  return { endpoint: endpoint(env.APPWRITE_ENDPOINT), projectId, provisionKey, databaseId, webOrigins };
}

export async function provisionAppwrite(config = readProvisionConfig(), fetcher = fetch) {
  const base = endpoint(config.endpoint);
  const request = async (path, method, body) => {
    const response = await fetcher(new URL(path, base), {
      method,
      headers: {
        "content-type": "application/json",
        "x-appwrite-project": config.projectId,
        "x-appwrite-key": config.provisionKey,
      },
      body: body ? JSON.stringify(body) : undefined,
      redirect: "error",
      signal: AbortSignal.timeout(10000),
    });
    let result = {};
    if (response.status !== 204)
      try {
        result = await response.json();
      } catch {}
    return { response, result };
  };

  const database = await request(`tablesdb/${encodeURIComponent(config.databaseId)}`, "GET");
  if (!database.response.ok || database.result.$id !== config.databaseId)
    throw new Error("Appwrite control plane database drift.");

  const bucket = (value) => ({
    bucketId: value.$id,
    name: value.name,
    permissions: value.$permissions,
    fileSecurity: value.fileSecurity,
    enabled: value.enabled,
  });
  const platform = (value) => ({
    platformId: value.$id,
    name: value.name,
    hostname: value.hostname,
  });

  const ensure = async (createPath, readPath, resource, fields, normalize) => {
    const created = await request(createPath, "POST", resource);
    if (created.response.ok) return created.result;
    if (created.response.status !== 409) throw new Error(`Appwrite provision failed: ${created.response.status}`);
    const existing = await request(readPath, "GET");
    if (!existing.response.ok) throw new Error("Appwrite manifest drift.");
    const field = driftField(normalize(existing.result), resource, fields);
    if (field) throw new Error(`Appwrite manifest drift in ${field}.`);
    return existing.result;
  };

  await ensure(
    "storage/buckets",
    `storage/buckets/${appwriteManifest.bucket.bucketId}`,
    appwriteManifest.bucket,
    ["bucketId", "name", "permissions", "fileSecurity", "enabled"],
    bucket,
  );

  const platforms = appwriteManifest.platforms.filter((item) =>
    config.webOrigins.includes(item.origin),
  );
  for (const item of platforms)
    await ensure(
      `projects/${encodeURIComponent(config.projectId)}/platforms`,
      `projects/${encodeURIComponent(config.projectId)}/platforms/${item.platformId}`,
      item,
      ["platformId", "name", "hostname"],
      platform,
    );

  const mcp = appwriteManifest.function;
  const createFunction = {
    functionId: mcp.functionId,
    name: mcp.name,
    runtime: mcp.runtime,
    entrypoint: mcp.entrypoint,
    commands: mcp.commands,
    timeout: mcp.timeout,
    execute: mcp.execute,
    scopes: mcp.scopes,
  };
  const readFunction = (value) => ({
    functionId: value.$id,
    name: value.name,
    runtime: value.runtime,
    entrypoint: value.entrypoint,
    commands: value.commands,
    timeout: value.timeout,
    execute: value.execute,
    scopes: value.scopes,
  });
  const deployed = await ensure(
    "functions",
    `functions/${encodeURIComponent(mcp.functionId)}`,
    createFunction,
    [
      "functionId",
      "name",
      "runtime",
      "entrypoint",
      "commands",
      "timeout",
      "execute",
      "scopes",
    ],
    readFunction,
  );
  const set = new Set((Array.isArray(deployed?.vars) ? deployed.vars : []).map((variable) => variable.key));
  const missingVariables = mcp.variables.filter((name) => !set.has(name));

  const tables = await ensureTables(request, config.databaseId);

  // A public domain is a console-scoped resource. The domain routes reject the
  // project API key this repository holds with general_access_forbidden, and
  // adding a domain is a console action rather than manifest drift, so an
  // absent or unreadable domain is reported in the result and never thrown.
  const domains = await request(`functions/${encodeURIComponent(mcp.functionId)}/domains`, "GET");
  const domain = Array.isArray(domains.result?.domains) ? domains.result.domains[0]?.name : undefined;
  const hostedMcp = {
    functionId: mcp.functionId,
    url: domain ? `https://${domain}` : null,
    needsDomain: !domain,
    reason: domain
      ? null
      : domains.response.ok
        ? "The function has no registered public domain. Add one in the Appwrite console for this project."
        : `The Appwrite API answered ${domains.response.status} for the function domains, so this key cannot read them. Add a public domain in the Appwrite console.`,
    missingVariables,
  };
  return {
    databaseId: config.databaseId,
    bucketId: appwriteManifest.bucket.bucketId,
    platforms: platforms.map((platform) => platform.platformId),
    tables,
    hostedMcp,
    manualSteps: appwriteManifest.manualSteps,
  };
}

/**
 * Create the manifest's tables and their columns, then the indexes.
 *
 * Indexes are created separately from the table because a table cannot be
 * created with its indexes in one call, and an index that silently failed to
 * land is the exact drift this provisioner exists to make visible: the table
 * would exist, would answer, and would scan.
 */
async function ensureTables(request, databaseId) {
  const results = [];
  for (const table of appwriteManifest.tables) {
    const created = await request(
      `tablesdb/${encodeURIComponent(databaseId)}/tables`,
      "POST",
      {
        tableId: table.tableId,
        name: table.name,
        enabled: table.enabled,
        rowSecurity: table.rowSecurity,
        documentSecurity: table.documentSecurity,
        columns: table.columns,
      },
    );
    let state = created.response.ok ? "created" : "existing";
    if (!created.response.ok && created.response.status !== 409)
      throw new Error(`Appwrite table ${table.tableId} failed: ${created.response.status}`);

    if (created.response.ok) {
      // A table created with columns can return before the column attributes
      // finish building. Creating one twice is a 409, which is the only signal
      // available for "already there", so each column is attempted and the
      // outcome recorded rather than assumed.
      for (const column of table.columns) {
        const type = column.type;
        const response = await request(
          `tablesdb/${encodeURIComponent(databaseId)}/tables/${encodeURIComponent(table.tableId)}/columns/${type}`,
          "POST",
          { key: column.key, required: column.required, ...(column.array ? { array: true } : {}), ...(column.size ? { size: column.size } : {}) },
        );
        if (!response.response.ok && response.response.status !== 409)
          throw new Error(
            `Appwrite column ${table.tableId}.${column.key} failed: ${response.response.status}`,
          );
      }
    }

    for (const index of table.indexes) {
      const response = await request(
        `tablesdb/${encodeURIComponent(databaseId)}/tables/${encodeURIComponent(table.tableId)}/indexes`,
        "POST",
        { key: index.key, type: index.type, columns: index.columns },
      );
      if (!response.response.ok && response.response.status !== 409)
        throw new Error(`Appwrite index ${table.tableId}.${index.key} failed: ${response.response.status}`);
    }

    results.push({ tableId: table.tableId, state, indexes: table.indexes.length });
  }
  return results;
}

if (import.meta.url === `file://${process.argv[1]}`)
  provisionAppwrite()
    .then((result) => console.log(JSON.stringify(result)))
    .catch((error) => {
      console.error(error.message);
      process.exitCode = 1;
    });

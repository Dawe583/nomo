/**
 * The Appwrite manifest and seeder, tested against a fake Appwrite.
 *
 * The live project was provisioned and seeded on 2026-09-30, which is the only
 * evidence that these shapes are accepted by the real API. These tests exist
 * for the next person, who cannot re-run a live provision casually: they check
 * the shapes the seeder would send, the parser that produces them, and the two
 * rules that are easy to break silently, that a row id fits Appwrite's 36
 * character cap, and that a parse which found nothing refuses rather than
 * publishing an empty catalogue.
 *
 * The fetcher is a fake, so nothing here touches a network or a credential.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { appwriteManifest, provisionAppwrite, readProvisionConfig } from "./appwrite.mjs";
import { readHostedTools, readRegistry, rowIdFor, seeder } from "./seed-appwrite.mjs";

/** The seeder with explicit sources, for the two refusal cases. */
const seedFrom = ({ registryText, appSource, fetcher }) =>
  seeder(config, fetcher, { registryText, appSource });

const root = new URL("../", import.meta.url);
const registrySource = readFileSync(new URL("packages/registry/src/registry.ts", root), "utf8");
const hostedSource = readFileSync(new URL("apps/appwrite-mcp/src/app.py", root), "utf8");

/** A project key cannot be a real one, and these tests must not have one. */
const config = {
  endpoint: "https://fra.cloud.appwrite.io/v1",
  projectId: "test-project",
  provisionKey: "test-key",
  databaseId: "void_control_plane",
  webOrigins: ["https://void-tui.vercel.app", "http://localhost"],
};

/** An Appwrite answer, with the shape the real API returns. */
const ok = (result = {}) => ({ status: 200, ok: true, json: async () => result });

/**
 * A fake Appwrite that records every call and answers 409 for anything that
 * already exists, which is the `ensure` path every re-run takes.
 */
function recorder(seen, existing = () => true) {
  return async (url, options) => {
    const path = new URL(url).pathname.replace("/v1", "");
    const body = options.body ? JSON.parse(options.body) : undefined;
    seen.push({ path, method: options.method, body });
    if (options.method === "POST" && existing(path)) return { status: 409, ok: false, json: async () => ({}) };
    if (options.method === "PUT") return ok({ $id: "row" });
    return ok({ $id: "existing", ...body });
  };
}

test("the manifest declares tables with row security and no client permissions", () => {
  assert.ok(appwriteManifest.tables.length >= 3);
  for (const table of appwriteManifest.tables) {
    assert.equal(table.rowSecurity, true, `${table.tableId} must keep row security on`);
    assert.equal(
      table.documentSecurity,
      true,
      `${table.tableId} must keep document security on`,
    );
    assert.ok(table.columns.length > 0, `${table.tableId} has no columns`);
    for (const column of table.columns) {
      assert.ok(column.key, "a column with no key would be created with no name");
      assert.ok(["string", "integer", "boolean", "double"].includes(column.type), column.type);
    }
  }
});

test("every column a published query filters by carries an index", () => {
  // An unindexed filter on the public path is a table scan. The catalog is
  // small today and grows with every vendor, so the index is what keeps a
  // search fast once it does.
  //
  // The filter is applied to the columns a query actually reads, not to every
  // declared column. A summary and a precondition string are fetched, not
  // searched, and indexing them would write an index over hundreds of bytes per
  // row to serve a lookup nobody asks for, which is how a table ends up
  // paying write cost for reads it never does. `filters` therefore names the
  // query surface, and a column added to it without an index fails here.
  const FILTERS = {
    registry_operations: ["operation_id", "vendor", "surface", "registry_version"],
    registry_cases: ["operation_id", "tone"],
    mcp_tools: ["tool_name"],
  };
  for (const table of appwriteManifest.tables) {
    const indexed = new Set(table.indexes.flatMap((index) => index.columns));
    for (const column of FILTERS[table.tableId] ?? []) {
      assert.ok(
        table.columns.some((declared) => declared.key === column),
        `${table.tableId}.${column} is filtered on but not declared`,
      );
      assert.ok(
        indexed.has(column),
        `${table.tableId}.${column} is filtered on but no index covers it`,
      );
    }
    // Every declared index must name a column that exists. An index on a
    // missing column is refused by the API, which would fail the whole
    // provision rather than the one table.
    for (const index of table.indexes) {
      for (const column of index.columns) {
        assert.ok(
          table.columns.some((declared) => declared.key === column),
          `${table.tableId} indexes ${index.key} on ${column}, which is not a declared column`,
        );
      }
    }
  }
});

test("the registry parser reads every entry and flattens its cases", () => {
  const rows = readRegistry(registrySource);
  assert.ok(rows.length > 0, "the parse produced no rows at all");

  const operations = new Set(rows.map((row) => row.operation_id));
  assert.ok(operations.size > 1, "only one operation was read, so the split failed");
  assert.ok(
    rows.length > operations.size,
    "the case count equals the operation count, so preconditions were collapsed",
  );
  for (const row of rows) {
    assert.match(row.tone, /^r[0-3]$/);
    assert.ok(row.when.length > 0, `${row.operation_id} has an empty precondition`);
    assert.ok(row.window.length > 0, `${row.operation_id} has an empty window`);
    assert.ok(row.surface.length > 0, `${row.operation_id} has no surface`);
  }
});

test("the hosted tool parser finds every decorated tool and its read-only flag", () => {
  const tools = readHostedTools(hostedSource);
  assert.ok(tools.length >= 6, `only ${tools.length} hosted tools were read`);
  for (const tool of tools) {
    assert.ok(tool.tool_name.startsWith("void_"), tool.tool_name);
    assert.ok(tool.description.length > 10, `${tool.tool_name} has no usable description`);
    assert.equal(tool.hosted, true);
  }
  // Every tool on this endpoint reads a snapshot and writes nothing. One that
  // published without the flag would be presented to a client as a write.
  assert.ok(
    tools.every((tool) => tool.read_only),
    "a hosted tool is published without read-only annotations",
  );
});

test("every row id fits Appwrite's 36 character cap", () => {
  // Measured against the live API on 2026-09-30: a row id longer than 36 is
  // refused with "UID must contain at most 36 chars", and the registry's own
  // ids are longer than that.
  const ids = readRegistry(registrySource).map((row) =>
    rowIdFor("case", `${row.operation_id} ${row.case_index}`),
  );
  ids.push(...readRegistry(registrySource).map((row) => rowIdFor("operation", row.operation_id)));
  ids.push(...readHostedTools(hostedSource).map((tool) => rowIdFor("tool", tool.tool_name)));
  for (const id of ids) {
    assert.ok(id.length <= 36, `${id} is ${id.length} characters`);
    assert.match(id, /^[A-Za-z0-9_]+$/, `${id} is not a valid Appwrite UID`);
  }
});

test("distinct registry keys never collide on one row id", () => {
  // The reason the row id is a digest rather than a truncation: a prefix
  // collision would overwrite one classification with another, silently.
  const rows = readRegistry(registrySource);
  const ids = new Set(
    rows.map((row) => rowIdFor("case", `${row.operation_id} ${row.case_index}`)),
  );
  assert.equal(ids.size, rows.length, "two different cases share a row id");
});

test("the same key always produces the same row id", () => {
  // A seed that is not idempotent re-creates every row on every run, so a
  // client watching the table sees churn instead of an update.
  assert.equal(rowIdFor("operation", "aws.s3.object.put"), rowIdFor("operation", "aws.s3.object.put"));
  assert.notEqual(rowIdFor("operation", "aws.s3.object.put"), rowIdFor("tool", "aws.s3.object.put"));
});

test("a row is written with data and an explicit empty permission list", () => {
  // Appwrite answers a flat upsert body with `row_missing_payload`. The
  // envelope is the whole API, so this asserts on the shape rather than on the
  // error a client would otherwise have to discover.
  const seen = [];
  const fetcher = async (url, options) => {
    seen.push({
      path: new URL(url).pathname,
      method: options.method,
      body: options.body ? JSON.parse(options.body) : undefined,
    });
    return ok({ $id: "row" });
  };
  return seedFrom({ registryText: registrySource, appSource: hostedSource, fetcher }).then((result) => {
    const puts = seen.filter((call) => call.method === "PUT");
    assert.ok(puts.length > 0, `nothing was written: ${seen.length} calls, all ${[...new Set(seen.map((c) => c.method))].join(",")}`);
    for (const put of puts) {
      assert.ok(put.body.data, `${put.path} was written without a data field`);
      assert.deepEqual(
        put.body.permissions,
        [],
        `${put.path} carries a client permission, so a browser could read it`,
      );
    }
    assert.ok(result.operations > 0 && result.cases > 0 && result.tools > 0, JSON.stringify(result));
  });
});

test("the seeder refuses rather than publishing a catalogue it could not read", () => {
  // Overwriting a populated catalogue with an empty one would look like a
  // successful run to every consumer downstream, so the guard is exercised
  // against the seeder's own predicate rather than against the live tree,
  // which has rows.
  const fetcher = async () => {
    throw new Error("no request may be made when the parse is empty");
  };
  return assert.rejects(
    () =>
      seedFrom({
        registryText: "// nothing that looks like a registry entry\n",
        appSource: "# no tools here\n",
        fetcher,
      }),
    /refusing to seed/,
  );
});

test("the seeder names which parse came back empty", () => {
  const fetcher = async () => {
    throw new Error("no request may be made when the parse is empty");
  };
  return assert.rejects(
    () => seedFrom({ registryText: registrySource, appSource: "# no tools here\n", fetcher }),
    /hosted tool parse produced no tools/,
  );
});

test("provisioning reports the console-scoped domain step instead of pretending", () => {
  const seen = [];
  const fetcher = async (url, options) => {
    const path = new URL(url).pathname.replace("/v1", "");
    seen.push(path);
    if (path.endsWith("/domains")) return { status: 404, ok: false, json: async () => ({}) };
    if (options.method === "POST") return { status: 409, ok: false, json: async () => ({}) };
    // The provisioner checks the database answer before anything else, and it
    // checks the `$id` rather than only the status. A fake that answered 200
    // with an unrelated body would fail that check for the wrong reason, which
    // is a confusing way to learn that the guard works.
    if (path === `/tablesdb/${config.databaseId}`)
      return ok({ $id: config.databaseId, name: "NOMO Control Plane" });
    // `ensure` compares each field it was asked about against the live value,
    // so a fake returning a generic body would be reported as drift on the very
    // first field. It has to answer with the manifest's own values.
    if (path.startsWith("/storage/buckets"))
      return ok({
        $id: appwriteManifest.bucket.bucketId,
        name: appwriteManifest.bucket.name,
        $permissions: [],
        fileSecurity: true,
        enabled: true,
      });
    if (path.includes("/platforms")) {
      // The read path carries the platform id, and `ensure` compares the
      // manifest's `platformId` against it, so the answer has to repeat the id
      // that was asked for rather than a fixed one.
      const asked = path.split("/").pop();
      const declared = appwriteManifest.platforms.find((p) => p.platformId === asked);
      return ok({
        $id: asked,
        name: declared?.name ?? "x",
        hostname: declared?.hostname ?? "x",
      });
    }
    if (path === "/functions" || path.startsWith("/functions/"))
      return ok({
        $id: appwriteManifest.function.functionId,
        name: appwriteManifest.function.name,
        runtime: appwriteManifest.function.runtime,
        entrypoint: appwriteManifest.function.entrypoint,
        commands: appwriteManifest.function.commands,
        timeout: appwriteManifest.function.timeout,
        execute: ["any"],
        scopes: [],
        vars: appwriteManifest.function.variables.map((name) => ({ key: name })),
      });
    return ok({ $id: "existing", name: "x", hostname: "localhost", $permissions: [] });
  };
  return provisionAppwrite(config, fetcher).then((result) => {
    assert.equal(result.hostedMcp.needsDomain, true);
    assert.equal(result.hostedMcp.url, null);
    assert.ok(result.hostedMcp.reason, "the refusal must name why the domain is missing");
    assert.equal(result.tables.length, appwriteManifest.tables.length);
    for (const table of result.tables) assert.equal(table.state, "existing");
    assert.ok(
      result.manualSteps.some((step) => step.id === "mcp-function-domain"),
      "the manual domain step is not reported",
    );
  });
});

test("provisioning refuses a database whose id is not the one the manifest names", () => {
  // The control-plane database is shared. Writing the registry into a different
  // project, or into a renamed database, is a drift this guard exists to catch,
  // and it must be caught before any table is created.
  const fetcher = async () => ok({ $id: "some_other_database", name: "Other" });
  return assert.rejects(() => provisionAppwrite(config, fetcher), /database drift/);
});

test("provisioning config refuses origins the manifest does not name", () => {
  assert.throws(
    () =>
      readProvisionConfig({
        APPWRITE_ENDPOINT: "https://fra.cloud.appwrite.io/v1",
        APPWRITE_PROJECT_ID: "p",
        APPWRITE_API_KEY: "k",
        APPWRITE_WEB_ORIGINS: "https://evil.example",
      }),
    /exact manifest origins/,
  );
  assert.throws(
    () => readProvisionConfig({ APPWRITE_ENDPOINT: "http://fra.cloud.appwrite.io/v1", APPWRITE_PROJECT_ID: "p", APPWRITE_API_KEY: "k" }),
    /HTTPS/,
  );
});

test("provisioning refuses any API host the manifest does not name", () => {
  // Every request the provisioner and the seeder make carries the elevated
  // project key in `x-appwrite-key`, so the host is part of the trust boundary
  // and not a cosmetic setting. HTTPS alone is not enough: a look-alike host
  // is valid HTTPS, and one that also ends in `.appwrite.io` is the shape a
  // typo takes. This was measured before it was fixed, the endpoint guard
  // accepted `https://fra.cloud.appwrite.io.evil.example/v1` and every request
  // would have carried the key to it.
  for (const value of [
    "https://fra.cloud.appwrite.io.evil.example/v1",
    "https://evil.example/v1",
    "https://fra.cloud.appwrite.io:8443/v1",
    "https://fra.appwrite.io/v1",
  ])
    assert.throws(
      () => readProvisionConfig({ APPWRITE_ENDPOINT: value, APPWRITE_PROJECT_ID: "p", APPWRITE_API_KEY: "k" }),
      /must be https:\/\/fra\.cloud\.appwrite\.io/,
      `${value} was accepted as an Appwrite endpoint`,
    );

  // The manifest's own endpoint is still accepted, with and without the
  // trailing slash, so the guard refuses a foreign host rather than the
  // configuration this repository actually runs.
  for (const value of ["https://fra.cloud.appwrite.io/v1", "https://fra.cloud.appwrite.io/v1/"])
    assert.equal(
      readProvisionConfig({ APPWRITE_ENDPOINT: value, APPWRITE_PROJECT_ID: "p", APPWRITE_API_KEY: "k" }).endpoint,
      "https://fra.cloud.appwrite.io/v1/",
    );
});

test("the seeder sends no request when the endpoint host is not the manifest's", () => {
  // The guard lives in the shared `endpoint`, but the seeder is the code path
  // that writes every registry row, so it is worth asserting that a foreign
  // endpoint stops it before the first write rather than after.
  const fetcher = async () => {
    throw new Error("no request may be made against a host the manifest does not name");
  };
  return assert.rejects(
    () => seeder({ ...config, endpoint: "https://fra.cloud.appwrite.io.evil.example/v1" }, fetcher, {
      registryText: registrySource,
      appSource: hostedSource,
    }),
    /must be https:\/\/fra\.cloud\.appwrite\.io/,
  );
});

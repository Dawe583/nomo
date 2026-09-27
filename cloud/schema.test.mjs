import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const schema = await readFile(new URL("./schema.sql", import.meta.url), "utf8");

test("public cloud tables deny Data API roles and enforce RLS", () => {
  for (const table of ["void_cloud_state", "void_cloud_ledger", "void_cloud_events"]) {
    assert.match(schema, new RegExp(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`, "i"));
  }
  assert.match(schema, /REVOKE ALL ON TABLE void_cloud_state, void_cloud_ledger, void_cloud_events FROM PUBLIC/i);
  assert.match(schema, /ARRAY\['anon', 'authenticated'\]/i);
});

test("immutable trigger function pins its search path", async () => {
  assert.match(schema, /RETURNS trigger LANGUAGE plpgsql SET search_path = '' AS/i);
  const migration = await readFile(
    new URL("./0002-immutable-function-search-path.sql", import.meta.url),
    "utf8",
  );
  assert.match(
    migration,
    /ALTER FUNCTION public\.void_cloud_immutable\(\) SET search_path = ''/i,
  );
  const accountMigration = await readFile(
    new URL("./0001-account-ownership.sql", import.meta.url),
    "utf8",
  );
  assert.match(
    accountMigration,
    /IF to_regprocedure\('public\.void_cloud_immutable\(\)'\) IS NOT NULL THEN\s+ALTER FUNCTION public\.void_cloud_immutable\(\) SET search_path = ''/i,
  );
});

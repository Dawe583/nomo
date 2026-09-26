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

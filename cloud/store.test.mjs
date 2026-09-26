import test from "node:test";
import assert from "node:assert/strict";
import { Pool } from "pg";
import { database } from "./store.mjs";

test("cloud database uses a standard PostgreSQL Pool for Supabase", async () => {
  process.env.DATABASE_URL = "postgresql://void_test:secret@127.0.0.1:5432/void_test";
  const pool = database();
  assert.ok(pool instanceof Pool);
  assert.equal(pool.options.connectionString, process.env.DATABASE_URL);
  assert.equal(pool.options.max, 3);
  await pool.end();
});

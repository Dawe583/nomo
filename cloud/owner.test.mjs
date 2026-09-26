/**
 * Account ownership: the tests that make a cross-account read impossible to
 * write by accident.
 *
 * Every other cloud test exercises behaviour. These exercise the shape of the
 * code, because the failure they exist to prevent is silent: a query that
 * forgets its owner predicate renders correctly and hands back somebody else's
 * rows, and no screenshot catches that. The checks below read the queries and
 * the signatures rather than trusting a comment, and each one fails when the
 * change it guards is reverted.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import * as store from "./store.mjs";
import { assertOwner, DEMO_OWNER, isOwner, OPERATOR_OWNER } from "./owner.mjs";

const cloudDir = new URL(".", import.meta.url).pathname;
const readCloud = (name) => readFileSync(join(cloudDir, name), "utf8");

const TABLES = /void_cloud_(?:state|ledger|events)/;

/** The first argument of every `.query(` call, as the text the author wrote. */
function statements(source) {
  const found = [];
  const pattern = /\.query\(\s*(`[^`]*`|"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')/g;
  let match;
  while ((match = pattern.exec(source)) !== null) {
    const literal = match[1];
    const sql = literal.startsWith("`")
      ? literal.slice(1, -1)
      : literal.slice(1, -1).replace(/\\(['"\\])/g, "$1");
    if (TABLES.test(sql)) found.push(sql);
  }
  return found;
}

/**
 * The rule a statement touching cloud state has to satisfy. A read, an update
 * or a delete must compare the owner column; an insert must supply it. Anything
 * else is a statement that can reach a row it was not issued for.
 */
export function ownerIsBound(sql) {
  if (/^\s*(select|update|delete|with)\b/i.test(sql))
    return /\bowner\s*=\s*\$?\d/.test(sql) || /\bowner\s*=\s*\$\{/.test(sql);
  if (/^\s*insert\b/i.test(sql)) return /\bowner\b/i.test(sql);
  return false;
}

const SOURCES = readdirSync(cloudDir)
  .filter((name) => name.endsWith(".mjs"))
  .sort();

test("every statement that reads or writes cloud state is scoped to an owner", () => {
  const unscoped = [];
  let seen = 0;
  for (const name of SOURCES) {
    for (const sql of statements(readCloud(name))) {
      seen++;
      if (!ownerIsBound(sql))
        unscoped.push(`${name}: ${sql.slice(0, 90)}`);
    }
  }
  // A scan that quietly stopped finding statements would pass everything below,
  // so the count is asserted as well. Seventeen statements touch these tables
  // in the shipped code and the fixtures; the floor is below that on purpose,
  // because a test that breaks whenever a query is added is a test that gets
  // deleted.
  assert.ok(seen >= 17, `only ${seen} scoped statements were found`);
  assert.deepEqual(unscoped, []);
});

test("the predicate check rejects a statement that has no owner", () => {
  // The scan above is only worth anything if the rule can fail.
  assert.equal(
    ownerIsBound("SELECT document FROM void_cloud_state WHERE key=$1"),
    false,
  );
  assert.equal(
    ownerIsBound(
      "UPDATE void_cloud_state SET document=$1 WHERE key=$2",
    ),
    false,
  );
  assert.equal(
    ownerIsBound("DELETE FROM void_cloud_events WHERE session_id=$1"),
    false,
  );
  assert.equal(
    ownerIsBound("SELECT entry FROM void_cloud_ledger WHERE workspace=$1"),
    false,
  );
  assert.equal(
    ownerIsBound(
      "SELECT document FROM void_cloud_state WHERE owner=$1 AND key=$2",
    ),
    true,
  );
  assert.equal(
    ownerIsBound(
      "INSERT INTO void_cloud_state(owner,key,document) VALUES ($1,$2,$3)",
    ),
    true,
  );
  assert.equal(ownerIsBound("INSERT INTO void_cloud_state(key,document) VALUES ($1,$2)"), false);
});

/** The functions that reach a table, and the arity each one keeps. */
const OWNER_FIRST = {
  transaction: 3,
  read: 3,
  write: 4,
  sessions: 1,
  append: 3,
  ledger: 3,
  // The cursor has a default, so the declared arity is one lower.
  eventsAfter: 2,
  sessionPage: 2,
  ledgerPage: 3,
  allEvents: 3,
};

test("a store function cannot be called without an owner", () => {
  const source = readCloud("store.mjs");
  for (const [name, arity] of Object.entries(OWNER_FIRST)) {
    const declared = source.match(
      new RegExp(`export (?:async )?function ${name}\\(([^)]*)`),
    );
    assert.ok(declared, `${name} must be declared in cloud/store.mjs`);
    const [first] = declared[1].split(",").map((part) => part.trim());
    assert.equal(first, "owner", `${name} must take the owner first`);
    assert.equal(
      store[name].length,
      arity,
      `${name} must keep arity ${arity}`,
    );
    // The owner is checked before anything else runs, so a caller that forgot
    // it cannot have already built a query.
    const body = source.slice(declared.index);
    assert.match(
      body.slice(0, 400),
      /assertOwner\(|assertOwner\(scope\)/,
      `${name} must call assertOwner before it resolves a client`,
    );
  }
});

test("a store function called without an owner throws instead of querying", async () => {
  const queried = [];
  const client = {
    query: async (sql) => {
      queried.push(sql);
      return { rows: [] };
    },
  };
  for (const name of Object.keys(OWNER_FIRST)) {
    for (const bad of [undefined, "", "not an owner", 42, null]) {
      await assert.rejects(
        () => store[name](bad, "key", client, "value"),
        /requires a verified owner/,
        `${name} must refuse ${JSON.stringify(bad)}`,
      );
    }
  }
  assert.deepEqual(queried, [], "a refused call must not reach the database");
});

test("the owner reaches the statement as a bound parameter, not as text", async () => {
  const calls = [];
  const client = {
    query: async (sql, params) => {
      calls.push({ sql, params });
      return { rows: [] };
    },
  };
  await store.read("account-one", "session:a", client);
  await store.write(
    "account-one",
    "session:a",
    { id: "a", events: [{ seq: 1, text: "one" }] },
    client,
  );
  await store.allEvents("account-one", "a", client);
  assert.equal(calls.length, 4, "one event insert plus three statements");
  for (const call of calls) {
    assert.match(call.sql, /\bowner\s*=\s*\$1|INSERT INTO void_cloud_\w+\(owner,/);
    assert.equal(
      call.params[0],
      "account-one",
      "the first bound parameter is the owner",
    );
  }
  // Two owners writing the same key are two rows, and neither can read the other.
  const seen = [];
  for (const owner of ["account-one", "account-two"]) {
    await store.read(owner, "session:a", client);
    seen.push(calls.at(-1));
  }
  assert.notDeepEqual(seen[0].params, seen[1].params);
  assert.equal(seen[0].sql, seen[1].sql);
});

test("the owner is produced by the session middleware and nowhere else", () => {
  const assignments = [];
  for (const name of SOURCES.filter((file) => !file.endsWith(".test.mjs"))) {
    // Template and double quoted text is SQL, not JavaScript: `e.owner=$1`
    // inside a statement is a column comparison and never an assignment.
    const source = readCloud(name).replace(
      /(`[^`]*`|"(?:[^"\\]|\\.)*")/g,
      '""',
    );
    for (const match of source.matchAll(/(\w+)\.owner\s*=[^=]/g))
      assignments.push(`${name}:${match[1]}.owner`);
    // A header, a query parameter or a body field is not a source of identity.
    for (const forbidden of [
      "req.query.owner",
      "req.body.owner",
      'req.headers["x-void-owner"]',
      "req.headers.owner",
    ])
      assert.equal(
        source.includes(forbidden),
        false,
        `${name} must not read an owner from the request: ${forbidden}`,
      );
  }
  assert.deepEqual(
    assignments,
    ["server.mjs:req.owner", "server.mjs:req.owner"],
    "only the middleware may put an owner on a request",
  );
});

test("the migration is additive first, idempotent, and never leaves a trigger off", () => {
  const migration = readCloud("0001-account-ownership.sql");
  // Comments are not statements. Reading them as statements is how a test ends
  // up asserting that a sentence is still in the file.
  const body = migration.replace(/^--.*$/gm, "");
  const steps = body
    .split(";")
    .map((part) => part.trim())
    .filter(Boolean);

  // Additive first: nothing but the transaction opens the file, and the first
  // statement inside it changes the column set and nothing else.
  assert.equal(steps[0], "BEGIN");
  assert.match(
    steps[1],
    /^ALTER TABLE IF EXISTS void_cloud_state ADD COLUMN IF NOT EXISTS owner text$/,
  );
  // No default, so a statement that forgot the owner cannot land somewhere.
  assert.doesNotMatch(body, /owner text[^;]*DEFAULT/);

  // Idempotent: a shape change only happens when the shape is not already right.
  for (const table of [
    "void_cloud_state",
    "void_cloud_ledger",
    "void_cloud_events",
  ]) {
    assert.match(
      body,
      new RegExp(`ALTER TABLE IF EXISTS ${table} ADD COLUMN IF NOT EXISTS owner text`),
    );
    assert.match(
      body,
      new RegExp(`ALTER TABLE IF EXISTS ${table} ALTER COLUMN owner SET NOT NULL`),
    );
    assert.match(
      body,
      new RegExp(`to_regclass\\('${table}'\\) IS NOT NULL`),
    );
  }
  assert.match(body, /current_key IS DISTINCT FROM target\.wanted/);
  assert.match(body, /ADD CONSTRAINT %I PRIMARY KEY \(%s\)/);

  // The append-only triggers refuse an UPDATE, so the backfill lifts them and
  // puts them back, and it does so entirely inside this one transaction.
  const disable = body.indexOf("DISABLE TRIGGER void_cloud_immutable");
  const backfill = body.indexOf("UPDATE void_cloud_ledger SET owner");
  const events = body.indexOf("UPDATE void_cloud_events SET owner");
  const enable = body.indexOf("ENABLE TRIGGER void_cloud_immutable");
  assert.ok(disable > 0, "the migration must lift the append-only trigger");
  assert.ok(backfill > disable, "the ledger backfill must run with its trigger off");
  assert.ok(events > disable, "the events backfill must run with its trigger off");
  assert.ok(enable > backfill && enable > events, "the triggers must be restored after the backfill");
  assert.match(body, /^\s*BEGIN;/);
  assert.match(body, /COMMIT;\s*$/);
});

test("the owner the migration writes is the owner the code names", () => {
  const migration = readCloud("0001-account-ownership.sql");
  // The backfill runs through EXECUTE, so the literal is quoted twice.
  assert.match(
    migration,
    new RegExp(`SET owner = ''${OPERATOR_OWNER}'' WHERE owner IS NULL`),
  );
  const schema = readCloud("schema.sql");
  // No default, on purpose: a statement that forgot the owner must fail loudly
  // rather than land in a namespace nobody chose.
  assert.doesNotMatch(schema, /owner text NOT NULL DEFAULT/);
  assert.match(schema, /PRIMARY KEY\(owner,key\)/);
  assert.match(schema, /PRIMARY KEY\(owner,workspace,seq\)/);
  assert.match(schema, /PRIMARY KEY\(owner,session_id,seq\)/);
});

test("the trigger is restored under the same guard that lifted it", () => {
  // The asymmetry this guards was a real abort, not a theoretical one. The
  // disable step asked whether the trigger existed before disabling it; the
  // restore asked only whether the table did. On a database that has the table
  // and never had the trigger, the restore raised `trigger ... does not exist`,
  // and because the file is one transaction that took the added column, the
  // backfill, the not null and the primary key swap down with it. The header's
  // claim that every step is conditional was false for that shape.
  //
  // Verified against a real PostgreSQL 17, not reasoned about: with the tables
  // and their primary keys present and no trigger, the previous file aborted
  // and this one commits, and with the trigger present the trigger ends the
  // run enabled. What is asserted here is the shape that made both true, so
  // the symmetry cannot drift back apart silently.
  const body = readCloud("0001-account-ownership.sql").replace(/^--.*$/gm, "");

  for (const [table, trigger] of [
    ["void_cloud_ledger", "void_cloud_immutable"],
    ["void_cloud_events", "void_cloud_events_immutable"],
  ]) {
    for (const action of ["DISABLE", "ENABLE"]) {
      // The guard has to be the catalog lookup, not just the table check, or a
      // database without the trigger aborts the whole file.
      assert.match(
        body,
        new RegExp(
          `IF EXISTS \\(SELECT 1 FROM pg_trigger\\s+WHERE tgrelid = \\w+\\s+AND tgname = '${trigger}' AND NOT tgisinternal\\) THEN\\s+EXECUTE 'ALTER TABLE ${table} ${action} TRIGGER ${trigger}'`,
        ),
        `${action} TRIGGER ${trigger} must be guarded by the same pg_trigger lookup`,
      );
    }
  }

  // Counted rather than matched once, because the bug was an asymmetry: two
  // of one and one of the other reads as "it is guarded" to any single check.
  assert.equal(
    (body.match(/IF EXISTS \(SELECT 1 FROM pg_trigger/g) ?? []).length,
    4,
    "both tables must guard both directions, or one shape of database aborts",
  );
});

test("the demo owns its namespace and never the operator's", () => {
  const source = readCloud("demo.mjs");
  assert.match(source, /read: \(key, c\) => store\.read\(DEMO_OWNER, key, c\)/);
  assert.match(source, /write: \(key, value, c\) => store\.write\(DEMO_OWNER, key, value, c\)/);
  assert.match(source, /transaction: \(key, run\) => store\.transaction\(DEMO_OWNER, key, run\)/);
  assert.notEqual(DEMO_OWNER, OPERATOR_OWNER);
  assert.equal(isOwner(DEMO_OWNER), true);
});

test("an owner value that is not an identity is refused", () => {
  assert.equal(isOwner("operator"), true);
  assert.equal(isOwner("public-demo"), true);
  assert.equal(isOwner("3f2b1c4e-0000-4000-8000-000000000000"), true);
  for (const bad of [
    "",
    " owner",
    "owner ",
    "owner;drop",
    "owner'",
    "a".repeat(121),
    "owner\n",
  ]) {
    assert.equal(isOwner(bad), false, `${JSON.stringify(bad)} is not an owner`);
    assert.throws(() => assertOwner(bad), /requires a verified owner/);
  }
});

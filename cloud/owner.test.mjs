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
 * A statement, with everything a string literal or a comment says removed and
 * nothing else changed: same length, so a position here is a position there.
 * A parenthesis inside `'session:%'` is text, not structure, and a rule that
 * counted it would measure the author's quoting rather than their scoping.
 */
function skeleton(sql) {
  const out = [];
  let i = 0;
  while (i < sql.length) {
    const ch = sql[i];
    if (ch === "'" || ch === '"') {
      let j = i + 1;
      while (j < sql.length) {
        if (sql[j] === ch) {
          // A doubled quote is one escaped quote, not the end of the literal.
          if (sql[j + 1] === ch) {
            j += 2;
            continue;
          }
          break;
        }
        j++;
      }
      out.push(" ".repeat(Math.min(j + 1, sql.length) - i));
      i = j + 1;
      continue;
    }
    if (ch === "-" && sql[i + 1] === "-") {
      const end = sql.indexOf("\n", i);
      const stop = end < 0 ? sql.length : end;
      out.push(" ".repeat(stop - i));
      i = stop;
      continue;
    }
    if (ch === "/" && sql[i + 1] === "*") {
      const end = sql.indexOf("*/", i + 2);
      const stop = end < 0 ? sql.length : end + 2;
      out.push(" ".repeat(stop - i));
      i = stop;
      continue;
    }
    out.push(ch);
    i++;
  }
  return out.join("");
}

/**
 * The statement split into query blocks: the statement itself, then one block
 * per parenthesised group, each holding only the text of its own block with
 * every nested group blanked out.
 *
 * This is the whole point of the rewrite. A table reference is judged only by
 * the block it sits in, so an outer `WHERE owner=$1` cannot stand in for a
 * subquery that has no predicate of its own, which is exactly the mistake a
 * future refactor makes when it hoists a subquery into a helper.
 *
 * A scanner and not a SQL parser, and the reason is measured rather than
 * preferred. The parser this repository already depends on,
 * `node-sql-parser`, cannot read the statement `cloud/store.mjs` runs on every
 * write that carries events:
 *
 *   INSERT INTO void_cloud_events(owner,session_id,seq,event) SELECT
 *   $1,$2,(e->>'seq')::integer,e FROM jsonb_array_elements($3::jsonb) e
 *
 * A scan built on it would need a fallback for precisely the statements it has
 * to police, and a fallback is where a rule quietly stops applying. The
 * structure the rule needs is narrower than a parse tree, and this supplies
 * all of it.
 */
function blocks(sql) {
  const text = skeleton(sql);
  const spans = [];
  const open = [];
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "(") open.push(i);
    else if (text[i] === ")" && open.length > 0) spans.push([open.pop(), i]);
  }
  const own = (from, to) => {
    const chars = text.slice(from, to + 1).split("");
    for (const [start, end] of spans)
      if (from < start && end < to)
        for (let i = start; i <= end; i++) chars[i - from] = " ";
    return chars.join("");
  };
  return [
    { from: 0, to: text.length - 1, text: own(0, text.length - 1) },
    ...spans.map(([from, to]) => ({ from, to, text: own(from, to) })),
  ];
}

/**
 * Words that follow a table name without being its alias. Without this
 * `FROM void_cloud_state WHERE` would read `WHERE` as the alias and then look
 * for a predicate written `where.owner=`, which is not what anybody wrote.
 */
const NOT_AN_ALIAS = new Set([
 "as", "and", "cross", "delete", "except", "fetch", "for", "from", "full",
 "group", "having", "in", "inner", "insert", "intersect", "into", "join",
 "lateral", "left", "limit", "natural", "offset", "on", "or", "order",
 "outer", "returning", "right", "select", "set", "union", "update", "using",
 "values", "where", "window", "with",
]);

const REFERENCE =
  /\b(void_cloud_(?:state|ledger|events))\b(?:\s+(?:as\s+)?([A-Za-z_][\w]*))?/gi;

/** The owner of one reference, if this block writes one out. */
const isBound = (reference, block, single, masked) => {
  const { table, alias } = reference;
  if (/\binsert\s+into\s+$/i.test(block.text.slice(0, reference.at)))
    return /\bowner\b/.test(
      masked.slice(reference.at + table.length).match(/^\s*\(([^)]*)\)/)?.[1] ?? "",
    );
  const qualified = new RegExp(
    `\\b${alias ?? table}\\.\\s*owner\\s*=\\s*\\$(?:\\d+|\\{)`,
    "i",
  );
  if (qualified.test(block.text)) return true;
  // A block naming two cloud tables cannot say `owner=$1` and mean both of
  // them: the database would call the column ambiguous. An unqualified
  // predicate is only an answer when there is one table to answer about.
  return single && /(^|[^.\w])owner\s*=\s*\$(?:\d+|\{)/.test(block.text);
};

/**
 * Every table reference in a statement that no owner predicate in its own
 * block accounts for, each with the text that proves it.
 *
 * A read, an update or a delete has to compare the owner column; an insert has
 * to supply it in its column list. Anything else is a reference that can reach
 * a row it was not issued for.
 */
export function unscopedTables(sql) {
  const masked = skeleton(sql);
  const found = [];
  for (const block of blocks(sql)) {
    const references = [...block.text.matchAll(REFERENCE)].map((match) => ({
      table: match[1],
      // A keyword where an alias would be is not an alias, and the reference it
      // follows is still a reference. Dropping the whole match there is how a
      // statement ends up unexamined and reads as scoped.
      alias:
        match[2] && !NOT_AN_ALIAS.has(match[2].toLowerCase()) ? match[2] : null,
      at: match.index,
    }));
    if (references.length === 0) continue;
    for (const reference of references) {
      if (isBound(reference, block, references.length === 1, masked)) continue;
      const qualifier = [reference.table, reference.alias && ` ${reference.alias}`]
        .filter(Boolean)
        .join("");
      // A block is a window onto the statement, so an offset measured inside
      // one is a position in the statement only once the window is added.
      const at = block.from + reference.at;
      found.push(
        `${qualifier} is read without an owner predicate ("${sql
          .slice(at, at + 80)
          .replace(/\s+/g, " ")
          .trim()}")`,
      );
    }
  }
  return found;
}

/** True when no table reference in the statement is left unscoped. */
export function ownerIsBound(sql) {
  return unscopedTables(sql).length === 0;
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
      for (const problem of unscopedTables(sql))
        unscoped.push(`${name}: ${problem}`);
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

/**
 * The same rule, run against the SQL the page functions actually hand to the
 * database rather than against the text they were written with.
 *
 * `sessionPage` and `ledgerPage` assemble their filters in JavaScript and
 * interpolate the result, so the statement that names two tables is not
 * written down anywhere in the source. A scan of the file cannot see it, and
 * neither can the account isolation suite, whose per-row session ids keep one
 * owner's subquery away from another's rows whatever the predicate says. So the
 * statement is captured at the driver, and the driver is stubbed here rather
 * than the store: no database is started, no socket is opened, and the store
 * runs its real composition.
 *
 * Broken by: dropping `e.owner=$1` from the event search, or hoisting that
 * subquery into a helper, or moving the page off a bound owner. Each leaves a
 * table reference that only the outer predicate was covering.
 */
test("the statements the page functions compose are scoped per table reference", async (t) => {
  const { Pool } = await import("pg");
  const issued = [];
  const driver = Pool.prototype.query;
  const previousUrl = process.env.DATABASE_URL;
  // Never dialled: `query` is replaced before anything can reach a server.
  process.env.DATABASE_URL = "postgresql://void:void@127.0.0.1:1/void";
  Pool.prototype.query = function (text) {
    const sql = String(text);
    issued.push(sql);
    return Promise.resolve({
      rows: /count\(\*\)/i.test(sql) ? [{ count: "0" }] : [],
      rowCount: 0,
    });
  };
  t.after(async () => {
    Pool.prototype.query = driver;
    await store.database().end();
    if (previousUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previousUrl;
  });

  const owner = "5c1f7a10-0000-4000-8000-000000000000";
  const filter = new URLSearchParams({ q: "needle", limit: "50" });
  await store.sessionPage(owner, filter);
  await store.ledgerPage(owner, "default", filter);

  // A capture that caught nothing would pass every line below.
  assert.ok(issued.length >= 4, `only ${issued.length} statements were captured`);
  // And one of them has to be the two table one, or the check is not covering
  // the case it exists for.
  assert.equal(
    issued.filter((sql) => /void_cloud_state/i.test(sql) && /void_cloud_events/i.test(sql))
      .length,
    2,
    "the session page composes two statements that name both tables",
  );
  assert.deepEqual(
    issued.flatMap((sql) => unscopedTables(sql).map((problem) => `${sql.slice(0, 60)}… ${problem}`)),
    [],
  );
});

/**
 * The rule is about a table reference rather than a statement, and the case
 * that proves it is the one a text scan over the whole statement gets wrong:
 * an outer `WHERE owner=$1` is not an answer for a subquery that has none.
 *
 * `sessionPage` builds its search condition in JavaScript and interpolates the
 * result, so the composed statement is not written down anywhere in the
 * source. This is the shape of the real hole, stated as text the rule can be
 * run against directly.
 */
test("an outer owner predicate is not an answer for a table inside a subquery", () => {
  const search = (owner) =>
    `SELECT count(*) FROM void_cloud_state WHERE owner=$1 AND (document->>'title' ILIKE $2 OR EXISTS (SELECT 1 FROM void_cloud_events e ${owner}AND e.session_id=document->>'id'))`;
  assert.deepEqual(unscopedTables(search("WHERE e.owner=$1 ")), []);

  const unscoped = unscopedTables(search(""));
  assert.equal(unscoped.length, 1, JSON.stringify(unscoped));
  assert.match(unscoped[0], /^void_cloud_events e is read without an owner predicate/);
  // The predicate it is missing is quoted back, so a reader of the failure can
  // see which text was judged rather than only that something was.
  assert.match(unscoped[0], /\("void_cloud_events e\s+AND e\.session_id/);
  assert.equal(
    /\bowner\s*=\s*\$1/.test(search("")),
    true,
    "the rule this replaced read the same statement as scoped, on the outer predicate alone",
  );

  // A join inside one block is the other shape, and `owner=$1` cannot mean two
  // tables there: the database would call the column ambiguous. So both
  // references are reported, and qualifying both is what silences it.
  const joined =
    "SELECT 1 FROM void_cloud_state s JOIN void_cloud_events e ON e.session_id=s.document->>'id' WHERE e.session_id=$1";
  assert.deepEqual(
    unscopedTables(joined).map((problem) => problem.split(" is ")[0]),
    ["void_cloud_state s", "void_cloud_events e"],
  );
  assert.deepEqual(
    unscopedTables(
      joined.replace("WHERE e.session_id=$1", "WHERE s.owner=$1 AND e.owner=$1"),
    ),
    [],
  );
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

import { test } from "node:test";
import assert from "node:assert/strict";
import type { Row } from "./api.ts";
import {
  blastSummary,
  plainAction,
  riskOf,
  sortRiskFirst,
} from "./approval-text.ts";

test("riskOf reports only a class the server actually stated", () => {
  assert.equal(riskOf({}), "unknown");
  assert.equal(riskOf({ klass: "" }), "unknown");
  assert.equal(riskOf({ klass: "r9" }), "unknown");
  assert.equal(riskOf({ klass: "irreversible" }), "unknown");
  assert.equal(riskOf({ klass: 3 }), "unknown");
  assert.equal(riskOf({ klass: null }), "unknown");
  assert.equal(riskOf({ call: { klass: "R2" } }), "r2");
  assert.equal(riskOf({ klass: " R1 " }), "r1");
  assert.equal(riskOf({ klass: "r0" }), "r0");
  assert.equal(riskOf({ call: { klass: "r3" } }), "r3");
});

test("riskOf never falls back to the safest class or reads the tool name", () => {
  // A destructive tool id says nothing about the class it was given, so a
  // record with no class has to stay unknown instead of being softened.
  const unclassified = { tool: "postgres.row.delete", reason: "needs a human" };
  assert.equal(riskOf(unclassified), "unknown");
  assert.notEqual(riskOf(unclassified), "r0");
  assert.equal(riskOf({ ...unclassified, klass: "unclassified" }), "unknown");
});

test("sortRiskFirst puts the worst class first and unknown last", () => {
  const rows: Row[] = [
    { id: "a", klass: "r0" },
    { id: "b", klass: "unknown" },
    { id: "c", klass: "r3" },
    { id: "d" },
    { id: "e", klass: "r1" },
    { id: "f", klass: "r2" },
  ];
  assert.deepEqual(
    sortRiskFirst(rows, (r) => r).map((r) => r.id),
    ["c", "f", "e", "a", "b", "d"],
  );
});

test("sortRiskFirst keeps the server order inside one class", () => {
  const rows: Row[] = [
    { id: "first", klass: "r2", seq: 1 },
    { id: "top", klass: "r3", seq: 2 },
    { id: "second", klass: "r2", seq: 3 },
    { id: "unknown-first", seq: 4 },
    { id: "third", klass: "r2", seq: 5 },
    { id: "unknown-second", seq: 6 },
  ];
  assert.deepEqual(
    sortRiskFirst(rows, (r) => r).map((r) => r.id),
    ["top", "first", "second", "third", "unknown-first", "unknown-second"],
  );
  // A new array: the list on screen is the server's order until it is sorted.
  assert.deepEqual(
    rows.map((r) => r.id),
    ["first", "top", "second", "unknown-first", "third", "unknown-second"],
  );
});

test("sortRiskFirst reads the class through the identity it is given", () => {
  const rows: Row[] = [
    { id: "nested-unknown", call: { klass: "unknown" } },
    { id: "nested-r2", call: { klass: "r2" } },
    { id: "nested-r3", call: { klass: "r3" } },
  ];
  assert.deepEqual(
    sortRiskFirst(rows, (r) => r.call).map((r) => r.id),
    ["nested-r3", "nested-r2", "nested-unknown"],
  );
});

test("blastSummary never renders a missing radius as zero", () => {
  assert.equal(blastSummary({}), "unknown");
  assert.equal(blastSummary({ blastRadius: undefined }), "unknown");
  assert.equal(blastSummary({ blastRadius: null }), "unknown");
  assert.equal(
    blastSummary({ blastRadius: { count: null, precision: "unknown" } }),
    "unknown",
  );
  // A count with no precision states a number nobody said how they measured,
  // so it is neither rendered as exact nor hidden as a missing radius.
  const unstated = blastSummary({ blastRadius: { count: 4 } });
  assert.notEqual(unstated, "4");
  assert.match(unstated, /4/);
  assert.equal(blastSummary({ blastRadius: "12" }), "unknown");
});

test("blastSummary states the precision it was given", () => {
  // A measured zero is a measurement. A missing radius is not, and the two
  // must never render the same.
  assert.equal(
    blastSummary({ blastRadius: { count: 0, precision: "exact" } }),
    "0",
  );
  assert.equal(
    blastSummary({ blastRadius: { count: 3, precision: "exact" } }),
    "3",
  );

  const bounded = blastSummary({
    blastRadius: { count: 12, precision: "bounded" },
  });
  assert.notEqual(bounded, "12");
  assert.match(bounded, /12/);

  // The approval API carries a bare number, which claims no precision at all.
  const bare = blastSummary({ call: { blastRadius: 12 } });
  assert.notEqual(bare, "12");
  assert.match(bare, /12/);
});

test("plainAction falls back honestly and invents no row count", () => {
  const bare = plainAction({ status: "pending", expiresAt: 0 });
  assert.equal(bare, "Server supplied no detail for this call");
  assert.doesNotMatch(bare, /\d/);

  const counted = plainAction({ args: { rows: 1200 } });
  assert.doesNotMatch(counted, /1200/);
  assert.match(counted, /unknown tool/);
  assert.match(counted, /rows/);

  const bounded = plainAction({
    tool: "postgres.row.delete",
    args: { limit: 500 },
  });
  assert.doesNotMatch(bounded, /500/);
});

test("plainAction names the tool and the one most consequential argument", () => {
  assert.equal(
    plainAction({
      call: {
        tool: "postgres.row.delete",
        args: { table: "orders", rows: 1200 },
      },
    }),
    "postgres.row.delete (table: orders)",
  );
  // One argument only: the table is the object the write touches, and the
  // schema that qualifies it stays in the dialog's JSON view with the rest.
  assert.equal(
    plainAction({
      tool: "postgres.row.update",
      args: { schema: "billing", table: "invoices" },
    }),
    "postgres.row.update (table: invoices)",
  );
  assert.equal(
    plainAction({ tool: "filesystem.write", args: { path: "plan.md" } }),
    "filesystem.write (path: plan.md)",
  );
  assert.equal(
    plainAction({ tool: "postgres.row.delete" }),
    "postgres.row.delete (no arguments supplied)",
  );
  assert.equal(
    plainAction({
      tool: "postgres.query",
      args: { payload: { secret: "not rendered" } },
    }),
    "postgres.query (arguments: payload)",
  );
  assert.equal(
    plainAction({ reason: "rule 3 held the production write" }),
    "unknown tool: rule 3 held the production write",
  );
});

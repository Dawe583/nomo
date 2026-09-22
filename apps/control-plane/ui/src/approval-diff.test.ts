import test from "node:test";
import assert from "node:assert/strict";

import {
  diffLines,
  extractBeforeAfter,
  requiresConfirm,
} from "./approval-diff.ts";

test("extract prefers the record, then the call descriptor", () => {
  const record = {
    holdId: "h1",
    status: "pending",
    call: {
      tool: "postgres.row.delete",
      klass: "r3",
      args: { table: "users", id: 7 },
      before: { id: 7, name: "ada" },
    },
  };
  const found = extractBeforeAfter(record);
  assert.equal(found.beforeKey, "before");
  assert.deepEqual(found.before, { id: 7, name: "ada" });
  assert.equal(found.afterKey, "args");
  assert.deepEqual(found.after, { table: "users", id: 7 });
  assert.equal(found.beforeMissing, false);
  assert.equal(found.empty, false);
});

test("extract reports a missing before image instead of inventing one", () => {
  const found = extractBeforeAfter({
    holdId: "h2",
    status: "pending",
    call: { tool: "s3.object.delete", klass: "r2" },
  });
  assert.equal(found.beforeMissing, true);
  assert.equal(found.after, undefined);
  assert.equal(found.empty, true);
});

test("diff marks changed lines and keeps context", () => {
  const lines = diffLines({ a: 1, b: 2 }, { a: 1, b: 3 });
  const kinds = lines.map((line) => line.kind);
  assert.ok(kinds.includes("del"));
  assert.ok(kinds.includes("add"));
  assert.ok(kinds.includes("same"));
  const changed = lines.filter((line) => line.kind !== "same");
  assert.ok(changed.some((line) => line.text.includes("2")));
  assert.ok(changed.some((line) => line.text.includes("3")));
});

test("diff of identical values is all context", () => {
  const lines = diffLines({ a: [1, 2] }, { a: [1, 2] });
  assert.ok(lines.length > 0);
  assert.ok(lines.every((line) => line.kind === "same"));
});

test("destructive gate covers r3 and unknown only", () => {
  assert.equal(requiresConfirm({ call: { klass: "r3", tool: "x" } }), true);
  assert.equal(requiresConfirm({ call: { tool: "x" } }), true);
  assert.equal(
    requiresConfirm({ klass: "r2", call: { klass: "r2", tool: "x" } }),
    false,
  );
  assert.equal(requiresConfirm({ call: { klass: "r0", tool: "x" } }), false);
  assert.equal(requiresConfirm({ call: { klass: "r1", tool: "x" } }), false);
});

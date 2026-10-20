import test from "node:test";
import assert from "node:assert/strict";
import { harnessEntries } from "./harness-entries.ts";

/**
 * The operator's view of what the harness holds.
 *
 * A mined lesson and an operator-approved one are shown apart, because the
 * difference is the difference between a pattern the harness noticed and a
 * rule a human wrote.
 */
test("an operator-approved entry and a mined one are kept apart", () => {
  const entries = harnessEntries({
    entries: [
      {
        id: "lesson-1",
        kind: "lesson",
        title: "approval pattern",
        content: "the operator approved the same action",
        tool: "postgres.row.update",
        klass: "r2",
        repeats: 3,
        decidedByOperator: true,
        derivedFromSeq: [1, 2],
      },
      {
        id: "lesson-2",
        kind: "lesson",
        title: "drift",
        content: "the same tool is classified two ways",
        tool: "postgres.row.delete",
        klass: "r3",
        repeats: 1,
        decidedByOperator: false,
        derivedFromSeq: [4],
      },
    ],
  });
  assert.equal(entries.length, 2);
  assert.equal(entries[0]!.decidedByOperator, true);
  assert.equal(entries[1]!.decidedByOperator, false);
  assert.equal(entries[0]!.tool, "postgres.row.update");
  assert.deepEqual(entries[0]!.derivedFromSeq, [1, 2]);
});

test("a missing field shows an empty value, never undefined", () => {
  const entries = harnessEntries({ entries: [{ id: "lesson-1", kind: "lesson" }] });
  assert.equal(entries[0]!.title, "");
  assert.equal(entries[0]!.content, "");
  assert.equal(entries[0]!.decidedByOperator, false);
  assert.deepEqual(entries[0]!.derivedFromSeq, []);
});

test("no entries show nothing rather than a broken card", () => {
  assert.deepEqual(harnessEntries({}), []);
  assert.deepEqual(harnessEntries(undefined), []);
});

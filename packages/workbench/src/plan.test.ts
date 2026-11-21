import assert from "node:assert/strict";
import test from "node:test";

import { PLAN_LIMITS, parsePlanUpdate, type PlanItem } from "./plan.ts";

/**
 * A plan is the model's own account of what it is doing, and the operator
 * reads it as the record of the run. The text arrives from a provider as
 * unknown JSON, so the parser is the trust boundary: every refusal below is a
 * rule the future tool relies on rather than a shape it hopes for.
 */

const item = (id: string, text: string, status: string) => ({
  id,
  text,
  status,
});

test("a replacement list is trimmed and kept in the model's order", () => {
  const plan: PlanItem[] = parsePlanUpdate({
    items: [
      item("  read-design ", "  Read the design  ", "done"),
      item("write-tests", "Write the failing tests", "in_progress"),
      item("implement", " Implement  the parser. ", "pending"),
    ],
  });
  assert.deepEqual(plan, [
    { id: "read-design", text: "Read the design", status: "done" },
    {
      id: "write-tests",
      text: "Write the failing tests",
      status: "in_progress",
    },
    { id: "implement", text: "Implement  the parser.", status: "pending" },
  ]);
});

test("an empty list clears the plan", () => {
  assert.deepEqual(parsePlanUpdate({ items: [] }), []);
});

test("the design's bound is 50 items", () => {
  assert.equal(PLAN_LIMITS.items, 50);
});

test("a plan at the item limit is accepted", () => {
  const items = Array.from({ length: PLAN_LIMITS.items }, (_, index) =>
    item(`step-${index}`, `Step ${index}`, "pending"),
  );
  assert.equal(parsePlanUpdate({ items }).length, PLAN_LIMITS.items);
});

test("one item past the limit is refused", () => {
  const items = Array.from({ length: PLAN_LIMITS.items + 1 }, (_, index) =>
    item(`step-${index}`, `Step ${index}`, "pending"),
  );
  assert.throws(() => parsePlanUpdate({ items }), /at most 50 items, got 51/);
});

test("a duplicate id is refused, including one hidden by whitespace", () => {
  assert.throws(
    () =>
      parsePlanUpdate({
        items: [item("a", "First", "pending"), item(" a ", "Second", "pending")],
      }),
    /duplicate id/,
  );
});

test("an unknown status is refused", () => {
  assert.throws(
    () => parsePlanUpdate({ items: [item("a", "Do it", "started")] }),
    /status must be pending, in_progress or done/,
  );
  assert.throws(
    () => parsePlanUpdate({ items: [item("a", "Do it", "DONE")] }),
    /status must be pending, in_progress or done/,
  );
});

test("an empty id or text is refused", () => {
  assert.throws(
    () => parsePlanUpdate({ items: [item("   ", "Do it", "pending")] }),
    /id must not be empty/,
  );
  assert.throws(
    () => parsePlanUpdate({ items: [item("a", " \n ", "pending")] }),
    /text must not be empty/,
  );
});

test("an id or text past its bound is refused", () => {
  const longId = "a".repeat(PLAN_LIMITS.idLength);
  assert.equal(
    parsePlanUpdate({ items: [item(longId, "Do it", "pending")] })[0]?.id,
    longId,
  );
  assert.throws(
    () => parsePlanUpdate({ items: [item(`${longId}a`, "Do it", "pending")] }),
    new RegExp(`id is at most ${PLAN_LIMITS.idLength} characters`),
  );
  const longText = "b".repeat(PLAN_LIMITS.textLength);
  assert.equal(
    parsePlanUpdate({ items: [item("a", longText, "pending")] })[0]?.text,
    longText,
  );
  assert.throws(
    () => parsePlanUpdate({ items: [item("a", `${longText}b`, "pending")] }),
    new RegExp(`text is at most ${PLAN_LIMITS.textLength} characters`),
  );
});

test("a field that is not text is refused", () => {
  assert.throws(
    () =>
      parsePlanUpdate({
        items: [{ id: 1, text: "Do it", status: "pending" }],
      }),
    /id must be text/,
  );
  assert.throws(
    () =>
      parsePlanUpdate({
        items: [{ id: "a", text: null, status: "pending" }],
      }),
    /text must be text/,
  );
  assert.throws(
    () =>
      parsePlanUpdate({
        items: [{ id: "a", text: "Do it", status: 1 }],
      }),
    /status must be pending, in_progress or done/,
  );
});

test("more than one in_progress item is refused", () => {
  assert.throws(
    () =>
      parsePlanUpdate({
        items: [
          item("a", "One", "in_progress"),
          item("b", "Two", "in_progress"),
        ],
      }),
    /at most one item may be in_progress, got 2/,
  );
});

test("control characters are refused in an id or text", () => {
  assert.throws(
    () => parsePlanUpdate({ items: [item("a\u0000b", "Do it", "pending")] }),
    /control character/,
  );
  assert.throws(
    () => parsePlanUpdate({ items: [item("a", "line\nbreak", "pending")] }),
    /control character/,
  );
  assert.throws(
    () => parsePlanUpdate({ items: [item("a", "bell\u0007", "pending")] }),
    /control character/,
  );
});

test("input that is not an object with an items array is refused", () => {
  for (const input of [null, undefined, 7, "items", [], true])
    assert.throws(
      () => parsePlanUpdate(input),
      /expected an object with an items array/,
    );
  for (const items of [undefined, null, "items", 7, {}])
    assert.throws(() => parsePlanUpdate({ items }), /items must be an array/);
  assert.throws(() => parsePlanUpdate({}), /items must be an array/);
});

test("an item that is not an object is refused", () => {
  for (const raw of [null, "a", 7, ["a", "Do it", "pending"]])
    assert.throws(
      () => parsePlanUpdate({ items: [raw] }),
      /expected an object with id, text and status/,
    );
});

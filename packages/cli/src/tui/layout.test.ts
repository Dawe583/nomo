import assert from "node:assert/strict";
import test from "node:test";
import { box, fit, visibleLength } from "./layout.ts";

test("box rows stay within the requested terminal-cell width", () => {
  for (const width of [1, 2, 3, 20]) {
    const rows = box("A long title", ["A long content row", "界界"], width);

    for (const row of rows) {
      assert.ok(
        visibleLength(row) <= width,
        `width ${width} produced a ${visibleLength(row)}-cell row: ${JSON.stringify(row)}`,
      );
    }
  }
});

test("box uses borders only when too narrow to fit both sides", () => {
  assert.deepEqual(box("title", ["content"], 1), ["+", "|", "+"]);
  assert.deepEqual(box("title", ["content"], 2), ["++", "||", "++"]);
});

test("box preserves fitted content and a full frame at normal widths", () => {
  assert.deepEqual(box("Title", ["content"], 12), [
    "+ Title ---+",
    "|content   |",
    "+----------+",
  ]);
});

test("left truncation never separates a combining mark from its base", () => {
  const label = "xy\u6f22\u0301";
  assert.equal(fit(label, 2, "left"), ".");
  assert.equal(fit(label, 3, "left"), ".\u6f22\u0301");
});

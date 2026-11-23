import test from "node:test";
import assert from "node:assert/strict";
import { barChart } from "./charts.ts";

test("bar chart renders supplied timestamps and preserves one row per reading", () => {
  const rows = barChart(
    { values: [4, 8, 12], labels: ["10:00", "10:01", "10:02"] },
    40,
  );
  assert.equal(rows.length, 3);
  assert.match(rows[0]!, /10:02 12/);
  assert.match(rows[1]!, /10:01\s+8/);
  assert.match(rows[2]!, /10:00\s+4/);
});

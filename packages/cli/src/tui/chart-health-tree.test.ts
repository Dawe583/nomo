import assert from "node:assert/strict";
import test from "node:test";
import { barChart, gauge, sparkline } from "./charts.ts";
import { renderHealth } from "./health.ts";
import { visibleLength } from "./layout.ts";
import { motionContext } from "./motion.ts";
import { renderTree, type TreeNode } from "./widgets.ts";

test("usage sparklines keep both endpoints, measurement gaps and exact heights", () => {
  const series = { values: [0, 1, 2, 3, 8] };
  for (const frame of [0, 1, 7]) {
    assert.equal(sparkline(series, 2, { motion: motionContext(frame) }), "▁█");
  }
  assert.equal(sparkline(series, 1), "█");
  assert.equal(sparkline({ values: [4, NaN, 4] }, 3), "▄·▄");
});

test("budget overages stay visible and tiny charts respect terminal width", () => {
  assert.match(gauge(150, 100), /150\/100 150%/);
  for (const width of [1, 2, 3, 8]) {
    for (const row of barChart({ values: [123456, 10] }, width)) {
      assert.ok(visibleLength(row) <= width);
    }
  }
});

test("a one-row health inspector includes the worst observed state", () => {
  const rows = renderHealth(
    [
      { name: "storage", area: "local", state: "ok", detail: "connected" },
      { name: "ledger", area: "local", state: "fail", detail: "chain break" },
    ],
    28,
    { height: 1 },
  );
  assert.equal(rows.length, 1);
  assert.match(rows[0]!, /Health.*fail/i);
});

test("tree connectors follow visible siblings and reserve room for labels", () => {
  const leaf = (id: string, depth: number): TreeNode => ({
    id,
    label: id,
    depth,
    hasChildren: false,
  });
  const nodes = [
    {
      ...leaf("folder", 0),
      hasChildren: true,
      children: [leaf("alpha", 1), leaf("beta", 1)],
    },
  ];
  const state = { expanded: new Set(["folder"]), cursor: 1 };
  const rows = renderTree(nodes, state, 28, 3, { symbolPreset: "classic" });
  assert.match(rows[1]!, /├─.*alpha/);
  assert.match(rows[2]!, /└─.*beta/);
  const deep = renderTree([leaf("README", 80)], state, 18, 1);
  assert.match(deep[0]!, /README/);
  assert.equal(visibleLength(deep[0]!), 18);
});

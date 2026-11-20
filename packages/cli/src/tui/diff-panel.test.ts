import assert from "node:assert/strict";
import test from "node:test";
import { buildDiffView, diffStats, renderDiffPanel } from "./diff-panel.ts";
import { stripAnsi, visibleLength } from "./layout.ts";

test("split view aligns replacement runs without shifting subsequent context", () => {
  const view = buildDiffView(
    "first\nold A\nold B\nlast",
    "first\nnew A\nnew B\nnew C\nlast",
    { side: "split" },
  );
  const rows = renderDiffPanel(view, 60, 12);
  assert.match(rows[3]!, /^2:-old A\s+\| 2:\+new A/);
  assert.match(rows[4]!, /^3:-old B\s+\| 3:\+new B/);
  assert.match(rows[5]!, /^\s+\| 4:\+new C/);
  assert.match(rows[6]!, /^4:last\s+\| 5:last/);
  assert.deepEqual(
    renderDiffPanel(view, 60, 12, { color: true }).map(stripAnsi),
    rows,
  );
  for (const width of [1, 2, 3, 10, 48]) {
    const compact = renderDiffPanel(view, width, 12);
    assert.ok(compact.every((row) => visibleLength(row) <= width));
  }
});

test("change counts include content that resembles a diff file header", () => {
  assert.deepEqual(
    diffStats(["--- before", "+++ after", "@@ -1 +1 @@", "---old", "+++new"]),
    { added: 1, removed: 1 },
  );
  const view = buildDiffView("--old", "++new");
  assert.match(renderDiffPanel(view, 60, 3)[0]!, /\+1 -1/);
});

import test from "node:test";
import assert from "node:assert/strict";
import { splitPaneWidths } from "./split-pane.ts";

test("split pane collapses below the supported wide breakpoint", () => {
  for (const width of [40, 80, 119])
    assert.equal(splitPaneWidths(width), undefined);
});

test("split pane preserves both usable panes and the divider budget", () => {
  for (const width of [120, 121, 159, 160, 200]) {
    const panes = splitPaneWidths(width)!;
    assert.ok(panes.main >= 48);
    assert.ok(panes.inspector >= 36);
    assert.equal(panes.main + panes.inspector + panes.gap, width);
    assert.ok(panes.inspector <= 68);
  }
});

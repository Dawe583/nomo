import assert from "node:assert/strict";
import test from "node:test";
import { minimapOffsetAtPoint, minimapOwnsPoint } from "./mouse-selection.ts";
import { applyWorkspaceMinimapNavigation } from "./workspace-runner.ts";
import type { WorkspaceTui } from "./workspace.ts";

const bounds = {
  minimapStart: 78,
  minimapTop: 8,
  minimapRows: 10,
  total: 200,
  height: 10,
} as const;

test("minimap hit detection uses the outermost column and painted rows", () => {
  assert.equal(minimapOwnsPoint(bounds, { x: 77, y: 7 }), true);
  assert.equal(minimapOwnsPoint(bounds, { x: 77, y: 16 }), true);
  assert.equal(minimapOwnsPoint(bounds, { x: 76, y: 7 }), false);
  assert.equal(minimapOwnsPoint(bounds, { x: 77, y: 17 }), false);
});

test("minimap rows invert to centred clamped transcript offsets", () => {
  assert.equal(minimapOffsetAtPoint(bounds, { x: 77, y: 7 }), 0);
  assert.equal(
    minimapOffsetAtPoint(bounds, { x: 77, y: 16 }),
    190,
    "the bottom row reaches live-follow range rather than overshooting",
  );
  const middle = minimapOffsetAtPoint(bounds, { x: 77, y: 12 })!;
  assert.ok(middle > 70 && middle < 110, `middle row got ${middle}`);
});

test("clamped drag lookup stays inside the minimap band", () => {
  assert.equal(minimapOffsetAtPoint(bounds, { x: 77, y: 0 }), undefined);
  assert.equal(minimapOffsetAtPoint(bounds, { x: 77, y: 0 }, true), 0);
  assert.equal(minimapOffsetAtPoint(bounds, { x: 77, y: 99 }, true), 190);
});

test("workspace minimap navigation scrolls, follows at the end and ignores misses", () => {
  const ui = {
    scroll: 12,
    viewport: { ...bounds, offset: 20 },
  } as WorkspaceTui;
  assert.equal(applyWorkspaceMinimapNavigation(ui, { x: 77, y: 7 }), true);
  assert.equal(ui.scroll, 0);
  assert.equal(applyWorkspaceMinimapNavigation(ui, { x: 77, y: 16 }), true);
  assert.equal(ui.scroll, -1, "the bottom of the minimap restores live follow");
  ui.scroll = 42;
  assert.equal(applyWorkspaceMinimapNavigation(ui, { x: 1, y: 7 }), false);
  assert.equal(ui.scroll, 42);
});

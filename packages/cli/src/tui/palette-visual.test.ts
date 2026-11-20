import assert from "node:assert/strict";
import test from "node:test";
import { stripAnsi, visibleLength } from "./layout.ts";
import {
  initialPaletteState,
  paletteFromCommands,
  renderPalette,
} from "./palette.ts";
import { getSymbols } from "./theme.ts";

test("workspace destinations keep their navigation icons in the command picker", () => {
  const tabs = Object.entries(getSymbols("unicode").tab);
  const items = paletteFromCommands(tabs.map(([tab]) => ["/" + tab, tab]));
  assert.deepEqual(
    items.map((item) => item.icon),
    tabs.map(([, icon]) => icon),
  );
});

test("wide picker aligns descriptions, compact picker keeps the selected action", () => {
  const items = paletteFromCommands([
    ["/new", "Create"],
    ["/sessions", "History"],
  ]);
  const state = initialPaletteState(items);
  const plain = renderPalette(state, items, 60);
  const colored = renderPalette(state, items, 60, { color: true });
  assert.deepEqual(colored.lines.map(stripAnsi), plain.lines);
  assert.equal(
    plain.lines[1]!.indexOf("Create"),
    plain.lines[2]!.indexOf("History"),
  );
  for (const width of [12, 30, 60]) {
    const view = renderPalette({ ...state, selected: 1 }, items, width);
    assert.ok(view.lines.every((row) => visibleLength(row) === width));
    assert.ok(
      view.lines.some(
        (row) => row.startsWith(">") && row.includes("/sessions"),
      ),
    );
  }
});

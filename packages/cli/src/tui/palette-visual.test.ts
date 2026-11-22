import assert from "node:assert/strict";
import test from "node:test";
import {
  advanceSelection,
  filterPalette,
  initialPaletteState,
  paletteFromCommands,
  renderPalette,
} from "./palette.ts";

test("palette navigation order matches grouped command rows", () => {
  const items = paletteFromCommands([
    ["/help", "Help"],
    ["/sessions", "History"],
    ["/ledger", "Evidence"],
    ["/chat", "Conversation"],
  ]);
  const recent = new Map([["/help", { count: 8, lastUsed: Date.now() }]]);
  for (const [query, frecency] of [
    ["", new Map()],
    ["", recent],
    ["e", new Map()],
  ] as const) {
    const state = {
      ...initialPaletteState(items),
      query,
      recent: frecency,
    };
    const navigable = filterPalette(items, query, frecency);
    const view = renderPalette(state, items, 60);
    const renderedIds = view.lines.flatMap((line) => {
      const item = items.find((candidate) => line.includes(candidate.id));
      return item ? [item.id] : [];
    });

    for (let selected = 0; selected < navigable.length; selected++) {
      const keyboardState = advanceSelection(
        {
          ...state,
          selected: (selected + navigable.length - 1) % navigable.length,
        },
        navigable,
        1,
      );
      const selectedView = renderPalette(keyboardState, items, 60);
      const selectedLine = selectedView.lines.find((line) =>
        line.trimStart().startsWith(">"),
      );
      const selectedItem = navigable[keyboardState.selected];

      assert.ok(selectedItem);
      assert.ok(
        selectedLine?.includes(selectedItem.id),
        `Up/Down selection ${selected} marks the corresponding rendered row`,
      );
      assert.equal(
        selectedView.items[selectedView.selected]?.id,
        selectedItem.id,
        `Enter index ${keyboardState.selected} selects the rendered item`,
      );
    }
    assert.deepEqual(
      renderedIds,
      navigable.map((item) => item.id),
      `query ${JSON.stringify(query)} keeps rendered and selectable order aligned`,
    );
  }
});

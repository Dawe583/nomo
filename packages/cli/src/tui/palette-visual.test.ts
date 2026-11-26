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

test("fuzzy ranking keeps exact, prefix, substring and subsequence matches in score order", () => {
  const items = paletteFromCommands([
    ["/ab", "exact"],
    ["/abc", "prefix"],
    ["/zab", "substring"],
    ["/axxb", "subsequence"],
  ]);
  const ranked = filterPalette(items, "ab");
  assert.deepEqual(
    ranked.map((item) => item.id),
    ["/ab", "/abc", "/zab", "/axxb"],
  );
});

test("recent commands float above unfrequented commands without hiding the rest", () => {
  const items = paletteFromCommands([
    ["/alpha", "first"],
    ["/beta", "second"],
    ["/gamma", "third"],
  ]);
  const recent = new Map([
    ["/gamma", { count: 2, lastUsed: Date.now() }],
  ]);
  const ranked = filterPalette(items, "", recent);
  assert.equal(ranked[0]?.id, "/gamma");
  assert.deepEqual(
    new Set(ranked.map((item) => item.id)),
    new Set(items.map((item) => item.id)),
    "frecency changes order only; it must not hide a command",
  );
});

test("operator aliases discover canonical commands and remain visible in preview data", () => {
  const items = paletteFromCommands([
    ["/keybindings", "Keyboard shortcut reference"],
    ["/usage", "Token usage and cost"],
    ["/sessions", "Open conversation history"],
  ]);
  assert.equal(filterPalette(items, "keys")[0]?.id, "/keybindings");
  assert.equal(filterPalette(items, "tokens")[0]?.id, "/usage");
  assert.equal(filterPalette(items, "history")[0]?.id, "/sessions");
  assert.deepEqual(items.find((item) => item.id === "/usage")?.aliases, [
    "stats",
    "tokens",
    "cost",
  ]);
});

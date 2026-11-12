import test from "node:test";
import assert from "node:assert/strict";
import { stripAnsi, visibleLength } from "./layout.ts";
import { NOMO_PALETTE } from "./theme.ts";
import type { TerminalCapabilities } from "./types.ts";
import {
  SHORTCUT_ICONS,
  categoryTone,
  renderShortcutKey,
  renderShortcutLegend,
  shortcutHintsFor,
  type ShortcutCategory,
  type ShortcutHint,
  type ShortcutLegendContext,
  type ShortcutLegendOptions,
} from "./shortcuts.ts";

// Contract tests for the shortcut legend module. The field names used here
// (editing, confirming, running, pending on the context; caps and width on
// the options) are the frozen contract the shortcuts.ts implementation must
// satisfy, so this file doubles as the interface reference for the builder.

function makeCaps(): TerminalCapabilities {
  // Shape matches TerminalCapabilities in ./types.ts exactly: there is no
  // color boolean and no isTTY flag, color intent lives in ansi/colorDepth.
  return {
    interactive: true,
    ansi: false,
    colorDepth: 0,
    columns: 120,
    rows: 40,
    reason: "interactive",
  };
}

function makeContext(
  overrides: Partial<ShortcutLegendContext> = {},
): ShortcutLegendContext {
  return {
    editing: false,
    confirming: false,
    running: false,
    pending: 0,
    ...overrides,
  };
}

function makeOptions(
  overrides: Partial<ShortcutLegendOptions> = {},
): ShortcutLegendOptions {
  return {
    caps: makeCaps(),
    width: 120,
    ...overrides,
  };
}

function hintKeys(context: ShortcutLegendContext): string[] {
  return shortcutHintsFor(context).map((hint: ShortcutHint) => hint.key);
}

function hintText(context: ShortcutLegendContext): string {
  return shortcutHintsFor(context)
    .map((hint: ShortcutHint) => `${hint.key} ${hint.label}`)
    .join("\n");
}

const ALL_CONTEXTS: Array<{
  name: string;
  context: ShortcutLegendContext;
}> = [
  { name: "editing", context: makeContext({ editing: true }) },
  { name: "confirming", context: makeContext({ confirming: true }) },
  { name: "running", context: makeContext({ running: true }) },
  { name: "idle", context: makeContext() },
  { name: "pending", context: makeContext({ pending: 3 }) },
];

test("every shortcut icon occupies exactly one terminal cell", () => {
  const entries = Object.entries(SHORTCUT_ICONS) as Array<[string, string]>;
  for (const [category, icon] of entries) {
    assert.equal(
      visibleLength(icon),
      1,
      `icon for ${category} must stay single cell so the legend columns align`,
    );
  }
});

test("every category tone is a valid palette key", () => {
  const categories = Object.keys(SHORTCUT_ICONS) as ShortcutCategory[];
  assert.ok(categories.length > 0, "expected at least one shortcut category");
  for (const category of categories) {
    const tone = categoryTone(category);
    assert.ok(
      Object.prototype.hasOwnProperty.call(NOMO_PALETTE, tone),
      `tone ${tone} for ${category} must exist in NOMO_PALETTE`,
    );
  }
});

test("editing and running contexts list their distinct control shortcuts", () => {
  const keys = hintKeys(makeContext({ editing: true }));
  assert.ok(keys.includes("Ctrl+R"), "editing offers history search");
  assert.ok(!keys.includes("Ctrl+O"), "editing does not resize or toggle the composer");
  assert.ok(keys.includes("Ctrl+T"), "editing offers TODOs");
  const running = hintKeys(makeContext({ running: true }));
  assert.ok(running.includes("Ctrl+O"), "running offers activity detail cycling");
});

test("confirmation context lists the decision keys and cancel", () => {
  const context = makeContext({ confirming: true });
  const keys = hintKeys(context);
  assert.ok(keys.includes("y"), "confirmation offers approve");
  assert.ok(keys.includes("n"), "confirmation offers deny");
  assert.match(hintText(context), /Esc/, "confirmation names the Esc key");
  assert.match(
    hintText(context),
    /cancel/i,
    "confirmation explains that Esc cancels",
  );
});

test("running context offers Esc to stop the agent", () => {
  const text = hintText(makeContext({ running: true }));
  assert.match(text, /Esc/, "running names the Esc key");
  assert.match(text, /stop/i, "running explains that Esc stops the agent");
});

test("idle context carries fewer hints than any active context", () => {
  const idle = shortcutHintsFor(makeContext()).length;
  const editing = shortcutHintsFor(makeContext({ editing: true })).length;
  const confirming = shortcutHintsFor(makeContext({ confirming: true })).length;
  const running = shortcutHintsFor(makeContext({ running: true })).length;
  assert.ok(idle < editing, "idle is shorter than editing");
  assert.ok(idle < confirming, "idle is shorter than confirming");
  assert.ok(idle < running, "idle is shorter than running");
});

test("every context keeps the panel switcher and help hints", () => {
  for (const { name, context } of ALL_CONTEXTS) {
    const keys = hintKeys(context);
    assert.ok(keys.includes("Tab"), `${name} keeps the Tab panel hint`);
    assert.ok(keys.includes("?"), `${name} keeps the ? help hint`);
  }
});

test("pending approvals add approve and deny hints", () => {
  const before = hintText(makeContext({ pending: 0 }));
  const after = hintText(makeContext({ pending: 3 }));
  assert.match(after, /approve/i, "pending=3 surfaces the approve hint");
  assert.match(after, /deny/i, "pending=3 surfaces the deny hint");
  assert.ok(
    shortcutHintsFor(makeContext({ pending: 3 })).length >
      shortcutHintsFor(makeContext({ pending: 0 })).length,
    "pending approvals grow the hint list",
  );
  assert.doesNotMatch(
    before,
    /approve.*3 pending|3 pending.*approve/i,
    "no pending count leaks into the idle legend",
  );
});

test("rendered legend fits the requested width", () => {
  for (const { name, context } of ALL_CONTEXTS) {
    const lines = renderShortcutLegend(context, makeOptions({ width: 40 }));
    for (const line of lines) {
      assert.ok(
        visibleLength(line) <= 40,
        `${name} line exceeds width 40: ${stripAnsi(line)}`,
      );
    }
  }
});

test("every context renders at least one legend line", () => {
  for (const { name, context } of ALL_CONTEXTS) {
    const lines = renderShortcutLegend(context, makeOptions());
    assert.ok(lines.length >= 1, `${name} must produce a legend line`);
  }
});

test("renderShortcutKey shows the category icon next to the key", () => {
  const rendered = stripAnsi(renderShortcutKey("Tab", "nav", makeOptions()));
  assert.ok(
    rendered.includes(SHORTCUT_ICONS.nav),
    "key chip carries the nav icon",
  );
  assert.ok(rendered.includes("Tab"), "key chip names the key");
});

test("ascii symbol preset renders a usable legend", () => {
  const lines = renderShortcutLegend(
    makeContext({ editing: true }),
    makeOptions({ width: 40, symbolPreset: "ascii" }),
  );
  assert.ok(lines.length >= 1, "ascii preset still produces legend lines");
  for (const line of lines) {
    assert.ok(
      visibleLength(line) <= 40,
      `ascii line exceeds width 40: ${line}`,
    );
  }
});

test("dark color theme renders a usable legend", () => {
  const lines = renderShortcutLegend(
    makeContext({ editing: true }),
    makeOptions({ width: 40, colorTheme: "dark" }),
  );
  assert.ok(lines.length >= 1, "dark theme still produces legend lines");
  for (const line of lines) {
    assert.ok(
      visibleLength(line) <= 40,
      `dark theme line exceeds width 40: ${stripAnsi(line)}`,
    );
  }
});

test("legend output carries no raw escape sequences when color is off", () => {
  const rendered = ALL_CONTEXTS.map(({ context }) =>
    renderShortcutLegend(context, makeOptions({ width: 40 })).join("\n"),
  ).join("\n");
  assert.doesNotMatch(
    rendered,
    /\u001b/,
    "legend must sanitize hostile control text at the boundary",
  );
  // A hostile key label must be neutralized, never passed through: the
  // legend renders agent supplied text, so raw escapes here could clear the
  // screen or spoof a verdict in the seconds before a human decides.
  const hostile = renderShortcutKey("\u001b[2J", "nav", makeOptions());
  assert.doesNotMatch(hostile, /\u001b/);
});

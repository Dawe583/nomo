import type { TerminalCapabilities } from "./types.ts";
import type { Tone } from "./theme.ts";
import type { ColorPalette, ColorTheme, SymbolPreset } from "./theme-config.ts";
import { fit, pad, visibleLength, sanitizeText } from "./layout.ts";
import {
  paintWithPalette,
  getPalette,
  getSymbols,
  NOMO_PALETTE,
} from "./theme.ts";
import {
  DEFAULT_WORKSPACE_KEYBINDINGS,
  type WorkspaceKeybindings,
} from "./workspace-keybindings.ts";

export type ShortcutCategory =
  "nav" | "edit" | "action" | "mode" | "panel" | "approval";

export interface ShortcutHint {
  readonly icon: string;
  readonly key: string;
  readonly label: string;
  readonly category: ShortcutCategory;
}

// The frozen legend context. Only these four facts change which shortcuts
// are shown: the composer state, the review state, the run state and the
// approval count. Mode and tab tint the frame elsewhere, so they stay out
// of this interface and the hint catalog needs no other inputs.
export interface ShortcutLegendContext {
  readonly editing: boolean;
  readonly confirming: boolean;
  readonly running: boolean;
  readonly pending: number;
}

export interface ShortcutLegendOptions {
  readonly width: number;
  readonly caps: TerminalCapabilities;
  readonly symbolPreset?: SymbolPreset;
  readonly colorTheme?: ColorTheme;
  readonly paint?: (text: string, tone: Tone, bold?: boolean) => string;
}

// Single cell icons only. layout.ts counts the emoji and geometric ranges
// (U+2600 to U+27BF) as two cells, so the obvious glyphs (pencil, bolt,
// diamond) would misalign every column they touch. These picks stay out of
// the wide ranges: arrows, technical and math symbols render one cell on
// every terminal, and the contract test pins visibleLength === 1.
export const SHORTCUT_ICONS: Record<ShortcutCategory, string> = {
  nav: "⇥",
  edit: "⌘",
  action: "⇒",
  mode: "⎇",
  panel: "⊞",
  approval: "!",
};

// Plain ascii twins for the ascii symbol preset, where even the tab icons
// are multi cell strings like [O]. Same single cell guarantee, no unicode.
export const ASCII_SHORTCUT_ICONS: Record<ShortcutCategory, string> = {
  nav: ">",
  edit: "E",
  action: "*",
  mode: "M",
  panel: "#",
  approval: "!",
};

// The bar is exactly one row. The workspace frame subtracts the legend from
// the body height, and a legend that grew with the terminal width would make
// the body a different height at every width, which the parity tests pin as
// a frame of exactly height rows. One row with truncation keeps the frame the
// same shape everywhere; every hint is still listed by /keybindings.

export function categoryTone(category: ShortcutCategory): Tone {
  switch (category) {
    case "nav":
      return "info";
    case "edit":
      return "warning";
    case "action":
      return "accent";
    case "mode":
      return "success";
    case "panel":
      return "muted";
    case "approval":
      return "error";
  }
}

// Resolve which icon set to draw. The symbol set is inspected, not the
// preset name, so a future multi cell set falls back to ascii automatically.
function resolveIcons(
  preset: SymbolPreset | undefined,
): Record<ShortcutCategory, string> {
  const symbols = getSymbols(preset ?? "unicode");
  const singleCell = Object.values(symbols.tab).every(
    (icon) => visibleLength(icon) === 1,
  );
  return singleCell ? SHORTCUT_ICONS : ASCII_SHORTCUT_ICONS;
}

function resolvePalette(theme: ColorTheme | undefined): ColorPalette {
  return theme ? getPalette(theme) : NOMO_PALETTE;
}

let workspaceKeybindings: WorkspaceKeybindings = DEFAULT_WORKSPACE_KEYBINDINGS;

/** Render a workspace legend with its runner's bindings without leaking state. */
export function withShortcutLegendBindings<T>(
  bindings: WorkspaceKeybindings,
  render: () => T,
): T {
  const previous = workspaceKeybindings;
  workspaceKeybindings = bindings;
  try {
    return render();
  } finally {
    workspaceKeybindings = previous;
  }
}

export function shortcutHintsFor(
  context: ShortcutLegendContext,
): ShortcutHint[] {
  const hints: ShortcutHint[] = [];
  const push = (
    key: string,
    label: string,
    category: ShortcutCategory,
  ): void => {
    hints.push({ icon: SHORTCUT_ICONS[category], key, label, category });
  };
  // Keep the help trigger first so the one-row legend preserves its
  // discovery path even when later contextual hints are truncated.
  push("?", "cheat", "panel");
  if (context.editing) push("Tab", "complete; else panels", "nav");
  else push("Tab", "panels", "nav");
  push("Enter", "open/details", "nav");
  // One Esc key, one current meaning. Listing Esc back next to Esc stop
  // would show the same key twice with conflicting labels, so the label
  // follows the state that owns Esc right now: review, then run, then back.
  if (context.confirming) push("Esc", "cancel", "approval");
  else if (context.running) push("Esc", "stop", "action");
  else push("Esc", "back", "nav");
  if (!context.confirming && context.editing) {
    push("Shift+Enter", "newline", "edit");
    push(workspaceKeybindings["search-history"].label, "search", "edit");
    push("Ctrl+J", "newline", "edit");
    push("/", "commands", "edit");
  } else if (!context.confirming) {
    push(workspaceKeybindings["show-todos"].label, "todos", "edit");
  }
  if (context.confirming) {
    push("y", "accept", "approval");
    push("n", "reject", "approval");
    push("PgUp/PgDn", "scroll", "panel");
    push("1-9", "toggle hunks", "panel");
  }
  if (!context.confirming && context.running) {
    push(
      workspaceKeybindings["cycle-activity"].label,
      "activity detail",
      "panel",
    );
    push("/queue", "prompt", "action");
  }
  // The count itself never enters a label: the status bar owns the number,
  // and a stale count baked into a hint reads as authority after it changes.
  if (context.pending > 0) {
    push("a", "approve", "approval");
    push("d", "deny", "approval");
  }
  push("Shift+Tab", "cycle mode", "mode");
  push("u", "undo", "action");
  return hints;
}

export function renderShortcutLegend(
  context: ShortcutLegendContext,
  options: ShortcutLegendOptions,
): string[] {
  const width = options.width;
  if (width <= 0) return [""];
  const icons = resolveIcons(options.symbolPreset);
  const palette = resolvePalette(options.colorTheme);
  const caps = options.caps;
  let current = "";
  let currentCompact = "";
  for (const [index, hint] of shortcutHintsFor(context).entries()) {
    const icon = sanitizeText(icons[hint.category]);
    const key = sanitizeText(hint.key);
    const label = sanitizeText(hint.label);
    const tone = categoryTone(hint.category);
    const paint = options.paint ?? ((text: string) => text);
    const chip = (includeIcon: boolean): string => {
      const shortcut = includeIcon ? `${icon} ${key}` : key;
      return `${paint(shortcut, tone, true)} ${paint(label, "muted")}`;
    };
    const renderedChip = chip(true);
    const compactChip = chip(false);
    const separator = current === "" ? "" : "  ";
    const next = `${current}${separator}${renderedChip}`;
    const compactNext = `${currentCompact}${separator}${compactChip}`;
    if (visibleLength(next) <= width) {
      current = next;
      currentCompact = compactNext;
    } else if (index < 3 && visibleLength(compactNext) <= width) {
      // Compact only to keep the essential help, Tab and Enter labels.
      // Optional hints must not change how the discovery controls look.
      current = compactNext;
      currentCompact = compactNext;
    } else {
      if (!current) current = compactChip;
      break;
    }
  }
  return [pad(fit(current, width), width)];
}

export function renderShortcutKey(
  key: string,
  category: ShortcutCategory,
  options: ShortcutLegendOptions,
): string {
  // The icon is never optional. Without colour the icon plus key shape is
  // what distinguishes a shortcut chip from body text, and sanitizeText runs
  // first because key labels can arrive from agent supplied text where a raw
  // escape could clear the screen or spoof a verdict.
  const icons = resolveIcons(options.symbolPreset);
  const palette = resolvePalette(options.colorTheme);
  const clean = sanitizeText(key);
  const paint = options.paint ?? ((text: string) => text);
  return paint(
    `${sanitizeText(icons[category])} ${clean}`,
    categoryTone(category),
    true,
  );
}

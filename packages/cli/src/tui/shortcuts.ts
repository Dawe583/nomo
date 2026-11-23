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

export type ShortcutCategory =
  "nav" | "edit" | "action" | "mode" | "panel" | "approval" | "model";

export interface ShortcutHint {
  readonly icon: string;
  readonly key: string;
  readonly label: string;
  readonly category: ShortcutCategory;
}

// The shortcut legend depends on the focused composer, current panel, review
// or overlay ownership, active run and pending approval count. Panels are
// opened from Chat and use Escape or Tab to return to the conversation.
export interface ShortcutLegendContext {
  readonly editing: boolean;
  readonly confirming: boolean;
  readonly running: boolean;
  readonly pending: number;
  readonly retryable?: boolean;
  readonly backable?: boolean;
  readonly tab?: string;
  readonly suspendSupported?: boolean;
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
  model: "◐",
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
  model: "M",
};

// The bar is exactly one row. The workspace frame subtracts the legend from
// the body height, and a legend that grew with the terminal width would make
// the body a different height at every width, which the parity tests pin as
// a frame of exactly height rows. One row with truncation keeps the frame the
// same shape everywhere; every hint is still listed by /keybindings.
const MAX_LEGEND_LINES = 1;

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
    case "model":
      return "accent";
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
  // Tab is a completion/focus key in Chat and a return-to-Chat key in panels.
  // It never cycles screens, so the legend must not imply that it does.
  push(
    "Tab",
    context.tab !== undefined && context.tab !== "chat"
      ? "return Chat"
      : context.editing
        ? "complete"
        : "focus composer",
    "nav",
  );
  if (context.editing && context.tab === "chat") push("Enter", "send", "edit");
  else if (context.editing) push("Enter", "run command", "action");
  else if (context.tab === "sessions") push("Enter", "open chat", "nav");
  else if (context.tab === "documents") push("Enter", "preview", "nav");
  else if (context.tab === "models") push("Enter", "set future model", "model");
  else if (context.tab === "approvals") push("Enter", "inspect", "nav");
  else push("Enter", "open/details", "nav");
  if (context.tab !== undefined && !context.editing) {
    if (context.tab !== "chat") {
      push("Type", "filter", "edit");
      push("Up/Down", "select", "nav");
      push("Home/End", "bounds", "nav");
      push("PgUp/PgDn", "page", "panel");
      push("Ctrl+P/N", "select", "nav");
    }
  }
  if (context.editing) push("Ctrl+P", "commands", "action");
  if (context.tab !== undefined) {
    push("Alt+M", "choose model", "model");
  }
  push("Alt+L", "redraw view", "action");
  push("Ctrl+O", "cycle agent activity details during a run", "panel");
  if (context.editing) push("Ctrl+T", "transpose", "edit");
  else push("Ctrl+T", "todos", "panel");
  if (context.retryable) push("F5 / Alt+R", "retry", "action");
  // One Esc key, one current meaning. Listing Esc back next to Esc stop
  // would show the same key twice with conflicting labels, so the label
  // follows the state that owns Esc right now: review, detail/filter, panel,
  // run, then the underlying Chat view.
  if (context.confirming) push("Esc", "cancel", "approval");
  else if (context.backable) push("Esc", "close", "nav");
  else if (context.tab !== undefined && context.tab !== "chat")
    push("Esc", "return Chat", "nav");
  else if (context.running) push("Esc", "stop", "action");
  else push("Esc", "back", "nav");
  if (context.editing) {
    push("Shift+Enter", "newline", "edit");
    push("Alt+D / Alt+Delete", "delete next word", "edit");
    push(
      "Alt+Backspace / Ctrl+Backspace / Ctrl+W",
      "delete previous word",
      "edit",
    );
    push("Ctrl+K", "delete to end of prompt", "edit");
    push("Ctrl+U", "delete to start of prompt", "edit");
    push("Ctrl+R", "search", "edit");
    push("Ctrl+] / Ctrl+Alt+]", "jump to character", "edit");
    push("Ctrl+J", "newline", "edit");
    push("/", "commands", "edit");
  }
  if (context.editing && context.tab === "chat") {
    push("Alt+Shift+C", "copy prompt", "edit");
    push("Alt+Shift+P", "plan mode", "mode");
  }
  if (context.confirming) {
    push("y", "accept", "approval");
    push("n", "reject", "approval");
    push("PgUp/PgDn", "scroll", "panel");
    push("1-9", "toggle hunks", "panel");
  }
  if (context.running) push("/queue", "prompt", "action");
  if (context.running && context.editing && context.tab === "chat")
    push("Ctrl+Q / Ctrl+Enter", "queue follow-up", "action");
  // The count itself never enters a label: the status bar owns the number,
  // and a stale count baked into a hint reads as authority after it changes.
  if (context.pending > 0) {
    push("a", "approve", "approval");
    push("d", "deny", "approval");
  }
  push("Shift+Tab", "cycle mode", "mode");
  push("Alt+A", "agents", "panel");
  if (context.suspendSupported !== false)
    push("Ctrl+Z", "suspend to shell", "action");
  push("u", "undo", "action");
  // The label says cheat, not keys, because that is what the key does: it
  // opens a filterable sheet over the current view, not a page listing every
  // binding. The legend has to describe the press, not the intent behind it.
  push("?", "cheat", "panel");
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
  const lines: string[] = [];
  let current = "";
  for (const hint of shortcutHintsFor(context)) {
    const icon = sanitizeText(icons[hint.category]);
    const key = sanitizeText(hint.key);
    const label = sanitizeText(hint.label);
    const tone = categoryTone(hint.category);
    // Icon plus key carry the category tone, the description stays muted.
    // Colour is redundant information: icon shape plus words keep every
    // state legible with NOMO_TUI_COLOR=0.
    const paint = options.paint ?? ((text: string) => text);
    const chip =
      `${paint(`${icon} ${key}`, tone, true)} ` + `${paint(label, "muted")}`;
    const next = current === "" ? chip : `${current}  ${chip}`;
    // visibleLength sees through the ANSI paint, so the measure is cells on
    // screen rather than bytes in the string.
    if (current !== "" && visibleLength(next) > width) {
      lines.push(current);
      current = chip;
    } else {
      current = next;
    }
  }
  if (current !== "") lines.push(current);
  if (lines.length === 0) return [pad("", width)];
  // Dropped hints stay listed under ? keys. fit() is the backstop for a
  // single chip wider than the whole bar; pad() keeps each row aligned to the
  // terminal width without painting a background over the user's terminal.
  return lines
    .slice(0, MAX_LEGEND_LINES)
    .map((line) => pad(fit(line, width), width));
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

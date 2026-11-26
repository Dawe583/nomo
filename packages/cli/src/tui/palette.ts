// Interactive command palette: fuzzy search over every slash command with
// a recognisable glyph per command, the way OMP/Prime democratised it.
// The old /command-palette was a static text dump; this module is the
// searchable model workspace.ts will drive (query keystrokes in, Enter runs
// the selected item). It owns no screen state and never touches raw mode,
// so it stays safe to unit test and to render inside any surface.
import { fit, pad } from "./layout.ts";
import { paint } from "./theme.ts";
import type { TerminalCapabilities } from "./types.ts";

export type PaletteGroup =
  | "session"
  | "chat"
  | "tools"
  | "ledger"
  | "agents"
  | "settings"
  | "help"
  | "exit";

// A palette entry. The icons come from the command's own identity so the
// operator recognises a command by its glyph, the way OMP does.
export interface PaletteItem {
  readonly id: string;
  readonly label: string;
  readonly hint: string;
  readonly icon: string;
  readonly group: PaletteGroup;
  readonly aliases?: readonly string[];
}

export interface PaletteState {
  readonly query: string;
  readonly selected: number;
  readonly visible: number;
  /** Frecency: command id -> { count, lastUsed timestamp }. */
  readonly recent: ReadonlyMap<string, { count: number; lastUsed: number }>;
}

export interface PaletteView {
  readonly lines: readonly string[];
  readonly items: readonly PaletteItem[];
  readonly selected: number;
}

// Group glyphs. Every pick must stay a single terminal cell under the width
// table in layout.ts, which counts U+2600-U+27BF as two cells wide, so the
// gear (U+2699) and the power symbol are deliberately avoided here in favour
// of ASCII and Latin-1/pre-2600 glyphs. A two cell icon would misalign every
// row because pad() counts cells, not code units.
export const PALETTE_ICONS: Record<PaletteGroup, string> = {
  session: "≡",
  chat: "●",
  tools: "+",
  ledger: "▪",
  agents: "◆",
  settings: "§",
  help: "?",
  exit: ">",
};

// First token of an id, lowercased, without arguments: "/connect
// opencode:zen" classifies as "/connect". Command specific icons are matched
// the same way so aliases and arguments never change the glyph.
function commandKey(id: string): string {
  const first = id.trim().split(/\s+/)[0] ?? "";
  return first.toLowerCase();
}

// Icon for a specific command. Commands whose glyph carries meaning override
// the group default (undo arrow, help question mark, theme palette, mcp
// connector node, export arrow, verify root sign, stop square, exit marker);
// everything else falls back to the group icon so new commands still render.
export function commandIcon(id: string, group: PaletteGroup): string {
  const key = commandKey(id);
  if (key === "/undo") return "↩";
  if (key === "/help" || key === "/keybindings") return "?";
  if (key === "/theme") return "◐";
  if (key === "/mcp") return "◉";
  if (key === "/export") return "↓";
  if (key === "/verify") return "√";
  if (key === "/stop") return "■";
  if (key === "/exit" || key === "/quit") return ">";
  return PALETTE_ICONS[group];
}

// Lowercase a match candidate. Aliases are matched slash agnostic, the same
// as ids, so an alias written either way behaves identically.
function matchText(value: string): string {
  const lower = value.toLowerCase();
  return lower.startsWith("/") ? lower.slice(1) : lower;
}

// Score one candidate string against the normalised query. Tier gaps of 1000
// dwarf any length or position penalty, so a prefix match always outranks a
// substring, which always outranks a gapped subsequence, no matter how short
// the weaker candidate is. The length penalty uses the item id length for
// every candidate, so an alias match scores as if the id itself matched.
function scoreCandidate(
  candidate: string,
  idLength: number,
  query: string,
  idBonus: number,
): number | undefined {
  if (candidate === query) return 5000 + idBonus - idLength;
  if (candidate.startsWith(query)) return 4000 + idBonus - idLength;
  const at = candidate.indexOf(query);
  if (at >= 0) return 2000 + idBonus - at - idLength;
  // Gapped subsequence: every query character in order. The penalty grows
  // with the span of skipped characters plus the start offset, so a tight
  // early match outranks a scattered late one within the tier.
  let cursor = 0;
  let first = -1;
  let last = -1;
  for (const point of query) {
    const found = candidate.indexOf(point, cursor);
    if (found < 0) return undefined;
    if (first < 0) first = found;
    last = found;
    cursor = found + 1;
  }
  if (first < 0 || last < 0) return undefined;
  const gaps = last - first + 1 - query.length;
  return 1000 + idBonus - gaps * 10 - first - idLength;
}

export function fuzzyTextScore(
  query: string,
  candidates: readonly string[],
): number | undefined {
  const normalised = matchText(query.trim());
  if (normalised === "") return 0;
  let best: number | undefined;
  for (const value of candidates) {
    const candidate = matchText(value);
    const score = scoreCandidate(candidate, candidate.length, normalised, 0);
    if (score !== undefined && (best === undefined || score > best))
      best = score;
  }
  return best;
}

export function fuzzyScore(
  item: PaletteItem,
  query: string,
): number | undefined {
  const normalised = matchText(query.trim());
  // Empty query matches everything with a flat score so the palette opens
  // as a stable id sorted browser instead of an empty list.
  if (normalised === "") return 0;
  const id = matchText(item.id);
  const idLength = id.length;
  let best: number | undefined;
  const consider = (score: number | undefined): void => {
    if (score !== undefined && (best === undefined || score > best))
      best = score;
  };
  // The id match carries a small bonus over an equal alias match, which is
  // what keeps "/help" above an alias-only hit without disturbing tiers.
  consider(scoreCandidate(id, idLength, normalised, 100));
  for (const alias of item.aliases ?? [])
    consider(scoreCandidate(matchText(alias), idLength, normalised, 0));
  return best;
}

/** Record a command execution for frecency. */
export function recordPaletteCommand(
  state: PaletteState,
  commandId: string,
): PaletteState {
  const recent = new Map(state.recent);
  const now = Date.now();
  const existing = recent.get(commandId);
  recent.set(commandId, {
    count: (existing?.count ?? 0) + 1,
    lastUsed: now,
  });
  return { ...state, recent };
}

/** Score bonus for frecency: up to +500 for very recent/frequent commands. */
function frecencyBonus(
  recent: ReadonlyMap<string, { count: number; lastUsed: number }>,
  id: string,
): number {
  const rec = recent.get(id);
  if (!rec) return 0;
  const ageMs = Date.now() - rec.lastUsed;
  const ageHours = ageMs / 3_600_000;
  // Decay: recent use gives big bonus, frequency gives smaller sustained bonus
  const recencyBoost = Math.max(0, 300 - ageHours * 10); // decays over ~30 hours
  const frequencyBoost = Math.min(rec.count * 15, 200); // caps at ~13 uses
  return recencyBoost + frequencyBoost;
}

export function filterPalette(
  items: readonly PaletteItem[],
  query: string,
  recent?: ReadonlyMap<string, { count: number; lastUsed: number }>,
): PaletteItem[] {
  const scored: Array<{ readonly item: PaletteItem; readonly score: number }> =
    [];
  for (const item of items) {
    const score = fuzzyScore(item, query);
    if (score !== undefined) {
      const bonus = recent ? frecencyBonus(recent, item.id) : 0;
      scored.push({ item, score: score + bonus });
    }
  }
  // Score descending for relevance, id ascending for a stable order the
  // operator can learn (and shorter ids already won ties inside the score).
  scored.sort((left, right) =>
    right.score !== left.score
      ? right.score - left.score
      : left.item.id < right.item.id
        ? -1
        : left.item.id > right.item.id
          ? 1
          : 0,
  );
  // Rank matches first, then keep each section contiguous so up/down follows
  // visible rows. The section containing the strongest match stays first.
  const grouped = new Map<PaletteGroup, PaletteItem[]>();
  for (const { item } of scored) {
    const group = grouped.get(item.group);
    if (group) group.push(item);
    else grouped.set(item.group, [item]);
  }
  const ordered: PaletteItem[] = [];
  for (const group of grouped.values()) {
    for (const item of group) ordered.push(item);
  }
  return ordered;
}

export function paletteGroupsInOrder(
  items: readonly PaletteItem[],
): PaletteGroup[] {
  const groups = new Set<PaletteGroup>();
  for (const item of items) groups.add(item.group);
  return [...groups];
}

export function initialPaletteState(
  _items: readonly PaletteItem[],
): PaletteState {
  // Eight rows fit the overlay without covering the transcript; 0 would mean
  // "render all" and flood narrow terminals on open.
  return { query: "", selected: 0, visible: 8, recent: new Map() };
}

export function advanceSelection(
  state: PaletteState,
  items: readonly PaletteItem[],
  delta: number,
): PaletteState {
  const count = items.length;
  if (count === 0) return { ...state, selected: 0 };
  // Wraparound over the whole filtered list. The visible window follows the
  // selection at render time (selecting past the window scrolls it), so no
  // offset needs to live in the state; the modulo also repairs a selection
  // left out of range by a query that shrank the list.
  const selected = (((state.selected + delta) % count) + count) % count;
  return { ...state, selected };
}

export function typeInPalette(
  state: PaletteState,
  character: string,
): PaletteState {
  return { ...state, query: state.query + character, selected: 0 };
}

export function backspaceInPalette(state: PaletteState): PaletteState {
  if (state.query === "") return state;
  return { ...state, query: state.query.slice(0, -1), selected: 0 };
}

// Capabilities for the optional coloured overlay. The palette defaults to
// uncoloured output (pipe safe); colour is only painted on explicit request.
const PALETTE_CAPS: TerminalCapabilities = {
  interactive: true,
  ansi: true,
  colorDepth: 8,
  columns: 80,
  rows: 24,
  reason: "interactive",
};

export function renderPalette(
  state: PaletteState,
  items: readonly PaletteItem[],
  width: number,
  options?: { color?: boolean },
): PaletteView {
  const filtered = filterPalette(items, state.query, state.recent);
  const colour = options?.color === true;
  if (filtered.length === 0) {
    const line = pad(
      fit(`No matches for "${state.query}".`, Math.max(1, width)),
      Math.max(1, width),
    );
    return {
      lines: [colour ? paint(line, "muted", PALETTE_CAPS) : line],
      items: filtered,
      selected: 0,
    };
  }
  const selected =
    ((state.selected % filtered.length) + filtered.length) % filtered.length;
  // At compact widths the renderer only has room for one grouped result;
  // keep the active command on screen instead of clipping it below the body.
  const windowSize =
    width < 40
      ? 1
      : state.visible > 0
        ? state.visible
        : filtered.length;
  const offset =
    windowSize > 0 ? Math.floor(selected / windowSize) * windowSize : 0;
  const page = filtered.slice(offset, offset + windowSize);
  const groups = paletteGroupsInOrder(page);
  const lines: string[] = [];
  for (const group of groups) {
    const header = pad(
      fit(`${PALETTE_ICONS[group]} ${group.toUpperCase()}`, Math.max(1, width)),
      Math.max(1, width),
    );
    lines.push(colour ? paint(header, "accent", PALETTE_CAPS, true) : header);
    for (const item of page) {
      if (item.group !== group) continue;
      const marker = item === filtered[selected] ? ">" : " ";
      const row = pad(
        fit(
          `${marker} ${item.icon} ${item.id}  ${item.hint}`,
          Math.max(1, width),
        ),
        Math.max(1, width),
      );
      // The selected row is marked twice (">" plus colour) so the choice
      // stays legible on a monochrome terminal with colour disabled.
      lines.push(
        colour && marker === ">"
          ? paint(row, "accent", PALETTE_CAPS, true)
          : row,
      );
    }
  }
  return { lines, items: filtered, selected };
}

// First token classifiers for paletteFromCommands. Only the listed commands
// map out of settings, so a newly added command lands visibly in settings
// instead of silently in the wrong section.
const SESSION_COMMANDS: ReadonlySet<string> = new Set([
  "/new",
  "/clear",
  "/chat",
  "/resume",
  "/sessions",
]);

const CHAT_COMMANDS: ReadonlySet<string> = new Set([
  "/rewind",
  "/recovery",
  "/queue",
  "/cancel",
  "/stop",
]);

const TOOLS_COMMANDS: ReadonlySet<string> = new Set([
  "/undo",
  "/edit",
  "/history",
  "/branch",
  "/retry",
  "/tools",
  "/expand",
  "/mcp",
]);

const LEDGER_COMMANDS: ReadonlySet<string> = new Set([
  "/ledger",
  "/approvals",
  "/verify",
  "/attest",
  "/export",
]);

const AGENTS_COMMANDS: ReadonlySet<string> = new Set([
  "/agents",
  "/harness",
  "/agent",
]);

const SETTINGS_COMMANDS: ReadonlySet<string> = new Set([
  "/settings",
  "/theme",
  "/models",
  "/usage",
  "/cost",
  "/context",
  "/login",
  "/logout",
  "/connect",
  "/providers",
  "/permissions",
  "/policy",
  "/config",
  "/projects",
]);

const HELP_COMMANDS: ReadonlySet<string> = new Set(["/help", "/keybindings"]);

const EXIT_COMMANDS: ReadonlySet<string> = new Set(["/exit", "/quit"]);

function defaultGroupOf(id: string): PaletteGroup {
  const key = commandKey(id);
  if (SESSION_COMMANDS.has(key)) return "session";
  if (CHAT_COMMANDS.has(key)) return "chat";
  if (TOOLS_COMMANDS.has(key)) return "tools";
  if (LEDGER_COMMANDS.has(key)) return "ledger";
  if (AGENTS_COMMANDS.has(key)) return "agents";
  if (HELP_COMMANDS.has(key)) return "help";
  if (EXIT_COMMANDS.has(key)) return "exit";
  if (SETTINGS_COMMANDS.has(key)) return "settings";
  // Unknown commands default to settings: a visible bucket the operator
  // already checks, rather than a guessed group that misleads.
  return "settings";
}

// Builds palette items from the existing TUI_COMMANDS shape (id and hint
// tuples), so workspace.ts needs no parallel command registry.
// Operator words that are not the command id itself. They improve discovery
// without creating another action surface or hiding the canonical slash command.
const PALETTE_ALIASES: Readonly<Record<string, readonly string[]>> = {
  "/approvals": ["review", "permissions"],
  "/keybindings": ["keys", "shortcuts"],
  "/models": ["model", "provider"],
  "/sessions": ["history", "conversations", "resume"],
  "/settings": ["config", "preferences"],
  "/usage": ["stats", "tokens", "cost"],
};

export function paletteFromCommands(
  commands: readonly (readonly [string, string])[],
  groupOf?: (id: string) => PaletteGroup,
): PaletteItem[] {
  const classify = groupOf ?? defaultGroupOf;
  return commands.map(([id, hint]) => {
    const group = classify(id);
    const item: PaletteItem = {
      id,
      label: id,
      hint,
      icon: commandIcon(id, group),
      group,
      ...(PALETTE_ALIASES[id] === undefined
        ? {}
        : { aliases: PALETTE_ALIASES[id] }),
    };
    return item;
  });
}

import {
  fit,
  pad,
  sanitizeText,
  splitDiffHunks,
  unifiedDiff,
} from "./layout.ts";
import { NOMO_PALETTE, paintWithPalette } from "./theme.ts";
import type { TerminalCapabilities } from "./types.ts";

// OMP ships a diff review surface with hunk navigation and per hunk
// staging; NOMO had only a bare unified string plus number key hunk
// selection, so review state lived in the caller's head. This module owns
// the small immutable review state (cursor, staged flags, side) and the
// fitted panel render, reusing the layout.ts diff pipeline instead of
// reimplementing hunk splitting.

export type DiffSide = "unified" | "split";

export interface DiffHunkState {
  /** Index into the hunk list, zero based. */
  readonly index: number;
  /** Whether this hunk is included in the staged scope. */
  readonly staged: boolean;
  /** The rows of this hunk including its @@ header. */
  readonly rows: readonly string[];
}

export interface DiffViewState {
  readonly before: string;
  readonly after: string;
  readonly side: DiffSide;
  readonly hunks: readonly DiffHunkState[];
  readonly cursor: number; // which hunk the operator is on
  readonly scroll: number; // first visible body row
}

export function diffStats(rows: readonly string[]): {
  readonly added: number;
  readonly removed: number;
} {
  let added = 0;
  let removed = 0;
  for (const row of rows) {
    // File headers and hunk headers are metadata, not changed lines: a
    // "---"/"+++" pair would otherwise inflate both counters by one each.
    if (row.startsWith("+++") || row.startsWith("---")) continue;
    if (row.startsWith("@@")) continue;
    if (row.startsWith("+")) added += 1;
    else if (row.startsWith("-")) removed += 1;
  }
  return { added, removed };
}

export function buildDiffView(
  before: string,
  after: string,
  options?: { side?: DiffSide; context?: number },
): DiffViewState {
  const rows = unifiedDiff(before, after, options?.context ?? 3);
  const chunks = splitDiffHunks(rows);
  // Every hunk starts staged so the default verdict covers the whole diff;
  // the operator narrows scope by toggling hunks off, not by opting in.
  const hunks: readonly DiffHunkState[] = chunks.map((chunk, index) => ({
    index,
    staged: true,
    rows: [...chunk],
  }));
  return {
    before,
    after,
    side: options?.side ?? "unified",
    hunks,
    cursor: 0,
    scroll: 0,
  };
}

export function toggleHunk(state: DiffViewState, index: number): DiffViewState {
  // A keypress can arrive after the file changed under the view, so an out
  // of range index is a stale event, not a crash: return the state as is.
  if (!Number.isInteger(index) || index < 0 || index >= state.hunks.length)
    return state;
  const hunks = state.hunks.map((hunk, hunkIndex) =>
    hunkIndex === index ? { ...hunk, staged: !hunk.staged } : hunk,
  );
  return { ...state, hunks };
}

export function moveHunk(state: DiffViewState, delta: number): DiffViewState {
  if (state.hunks.length === 0) return state;
  // Wraparound keeps j/k usable without bounds checking at the call site;
  // hunk lists are short, so modulo navigation never loses the operator.
  const next =
    (((state.cursor + delta) % state.hunks.length) + state.hunks.length) %
    state.hunks.length;
  return { ...state, cursor: next };
}

export function setSide(state: DiffViewState, side: DiffSide): DiffViewState {
  return { ...state, side };
}

// Hunk headers carry 1 based line numbers ("@@ -aStart,aLen +bStart,bLen
// @@"); the split gutter replays those numbers so each column reads like
// the file it came from. An unparsable header means hand built state, so
// fall back to origin rather than showing a misleading line number.
function parseHunkHeader(header: string): { aStart: number; bStart: number } {
  const match = /@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(header);
  if (!match) return { aStart: 0, bStart: 0 };
  return {
    aStart: Number.parseInt(match[1] ?? "0", 10),
    bStart: Number.parseInt(match[2] ?? "0", 10),
  };
}

function hunkHeaderLine(
  hunk: DiffHunkState,
  hunkIndex: number,
  total: number,
  isCursor: boolean,
): string {
  // ">>" versus two spaces marks the cursor, "[x]" versus "[ ]" marks the
  // staged flag: both are plain text because colour is redundant signal in
  // this product and the panel must read identically in mono.
  const cursorMark = isCursor ? ">>" : "  ";
  const stageMark = hunk.staged ? "[x]" : "[ ]";
  const header = sanitizeText(hunk.rows[0] ?? "@@");
  return `${cursorMark} ${stageMark} hunk ${hunkIndex + 1}/${total} ${header}`;
}

function unifiedBody(state: DiffViewState, compact = false): string[] {
  const out: string[] = [];
  const total = state.hunks.length;
  state.hunks.forEach((hunk, hunkIndex) => {
    const isCursor = hunkIndex === state.cursor;
    out.push(hunkHeaderLine(hunk, hunkIndex, total, isCursor));
    // The cursor bar prefixes the row instead of replacing the diff sigil,
    // so "+" and "-" stay in column for scanning while the current hunk
    // still stands out without colour.
    const bar = isCursor ? ">" : " ";
    for (const row of hunk.rows.slice(1)) {
      if (!compact) {
        out.push(`${bar} ${sanitizeText(row)}`);
        continue;
      }
      const changed = row.startsWith("+") || row.startsWith("-");
      const marker = changed ? (row[0] ?? " ") : " ";
      const content = changed || row.startsWith(" ") ? row.slice(1) : row;
      out.push(`${marker}${sanitizeText(content)}`);
    }
  });
  return out;
}

function splitBody(state: DiffViewState, width: number): string[] {
  const separator = width >= 20 ? " | " : "|";
  const leftWidth = Math.max(1, Math.floor((width - separator.length) / 2));
  const rightWidth = Math.max(1, width - separator.length - leftWidth);
  const out: string[] = [];
  const total = state.hunks.length;
  state.hunks.forEach((hunk, hunkIndex) => {
    const isCursor = hunkIndex === state.cursor;
    out.push(hunkHeaderLine(hunk, hunkIndex, total, isCursor));
    const start = parseHunkHeader(hunk.rows[0] ?? "");
    let aLine = start.aStart;
    let bLine = start.bStart;
    const left: string[] = [];
    const right: string[] = [];
    for (const row of hunk.rows.slice(1)) {
      // Context lines exist in both files, so they appear in both columns
      // with their own line number; removed lines sit left, added right.
      // Unknown row kinds render as context to stay visible, never dropped.
      if (row.startsWith("-")) {
        left.push(`${aLine}:${sanitizeText(row.slice(1))}`);
        right.push("");
        aLine += 1;
      } else if (row.startsWith("+")) {
        left.push("");
        right.push(`${bLine}:${sanitizeText(row.slice(1))}`);
        bLine += 1;
      } else {
        const text = sanitizeText(row.startsWith(" ") ? row.slice(1) : row);
        left.push(`${aLine}:${text}`);
        right.push(`${bLine}:${text}`);
        aLine += 1;
        bLine += 1;
      }
    }
    const pairs = Math.max(left.length, right.length);
    for (let index = 0; index < pairs; index += 1) {
      out.push(
        `${pad(left[index] ?? "", leftWidth)}${separator}${fit(right[index] ?? "", rightWidth)}`,
      );
    }
  });
  return out;
}

export function renderDiffPanel(
  state: DiffViewState,
  width: number,
  height: number,
  options?: { color?: boolean },
): string[] {
  const safeWidth = Number.isFinite(width)
    ? Math.max(1, Math.floor(width))
    : 80;
  const safeHeight = Number.isFinite(height)
    ? Math.max(1, Math.floor(height))
    : 1;
  const useColor: boolean = options?.color === true;
  const caps: TerminalCapabilities = {
    interactive: true,
    ansi: true,
    colorDepth: 24,
    columns: safeWidth,
    rows: safeHeight,
    reason: "interactive",
  };
  const paint = (line: string, tone: "info" | "accent" | "muted"): string =>
    useColor ? paintWithPalette(line, tone, NOMO_PALETTE, caps, true) : line;

  const total = state.hunks.length;
  const staged = state.hunks.filter((hunk) => hunk.staged).length;
  const counts = diffStats(state.hunks.flatMap((hunk) => hunk.rows));
  const compact = state.side === "split" && safeWidth < 3;
  const displaySide = compact ? "unified" : state.side;
  const header = paint(
    fit(
      `Diff [${displaySide}] staged ${staged}/${total} +${counts.added} -${counts.removed}`,
      safeWidth,
    ),
    "info",
  );
  if (safeHeight === 1) return [header];
  const footer = paint(
    fit("j/k move hunk  space toggle stage  s split  u unified", safeWidth),
    "muted",
  );
  if (safeHeight === 2) return [header, footer];

  // An unchanged pair yields zero hunks; say so explicitly so an empty
  // screen is never mistaken for a failed render.
  const fullBody: readonly string[] =
    total === 0
      ? ["No differences: before and after are identical."]
      : state.side === "split" && !compact
        ? splitBody(state, safeWidth)
        : unifiedBody(state, compact);
  const bodyCount = safeHeight - 2;
  const scroll = Number.isFinite(state.scroll)
    ? Math.max(0, Math.floor(state.scroll))
    : 0;
  const visible = fullBody.slice(scroll, scroll + bodyCount);
  const body: string[] = visible.map((line, index) => {
    const absolute = scroll + index;
    const hunkStart = isHunkHeaderRow(fullBody, absolute);
    const fitted =
      compact && hunkStart !== null
        ? hunkStart === state.cursor
          ? safeWidth === 1
            ? ">"
            : ">>"
          : " ".repeat(safeWidth)
        : compact && safeWidth === 1 && /^[+-]/.test(line)
          ? line[0]!
          : fit(line, safeWidth);
    if (!useColor) return fitted;
    // Colour decorates the already legible text markers: the cursor hunk
    // header carries the accent, change rows keep their +/- sigils.
    if (hunkStart !== null && hunkStart === state.cursor)
      return paintWithPalette(fitted, "accent", NOMO_PALETTE, caps, true);
    if (
      line.startsWith("> +") ||
      line.startsWith("  +") ||
      line.startsWith("+")
    )
      return paintWithPalette(fitted, "success", NOMO_PALETTE, caps);
    if (
      line.startsWith("> -") ||
      line.startsWith("  -") ||
      line.startsWith("-")
    )
      return paintWithPalette(fitted, "error", NOMO_PALETTE, caps);
    return fitted;
  });
  // Fill short screens with blank rows so the panel keeps an exact height
  // for alternate screen repaint callers.
  while (body.length < bodyCount) body.push("");
  return [header, ...body, footer];
}

// Locate which hunk owns an absolute body row by scanning back to the
// nearest hunk header. Header rows are the only body rows starting with
// the cursor or idle hunk mark, so the scan cannot mistake a diff row.
function isHunkHeaderRow(
  body: readonly string[],
  absolute: number,
): number | null {
  for (let index = absolute; index >= 0; index -= 1) {
    const line = body[index] ?? "";
    const headerMatch = /^(?:>>| {2}) \[[ x]\] hunk (\d+)\/\d+ /.exec(line);
    if (headerMatch) return Number.parseInt(headerMatch[1] ?? "1", 10) - 1;
  }
  return null;
}

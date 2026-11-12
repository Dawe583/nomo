// What can be recovered, as one OMP style timeline: what happened, what can
// be undone, and what is lost. Without it the only way to learn any of that
// is `/recovery <id>` by guesswork, which fails exactly when a run has failed
// and the operator is least able to guess well.
import { fit, sanitizeText, visibleLength } from "./layout.ts";
import { motionContext, pill } from "./motion.ts";
import type { MotionContext } from "./motion.ts";
import { renderInspector } from "./inspector.ts";
import type { Field, InspectorSpec } from "./inspector.ts";
import type { Tone } from "./theme.ts";

export type Recoverable =
  "recoverable" | "needs-reconcile" | "already-undone" | "kept" | "unknown";

export interface RecoveryRow {
  readonly id: string;
  readonly kind: "edit" | "delete" | "undo" | "branch" | "reversal";
  readonly path: string;
  /** Sequence number within the chain. */
  readonly seq: number;
  readonly recoverable: Recoverable;
  /** Human line about why, or undefined when the record has none. */
  readonly reason?: string;
  /** ISO timestamp, or undefined when the record carried none. */
  readonly at?: string;
  /** Set when this row is the undo of another. */
  readonly undoesId?: string;
}

// Single cell under layout.ts: every glyph here sits below U+2600, above
// which the width table counts two cells, which is what forbids the otherwise
// tempting shapes. "!" is punctuation, not a shape, and reads as "look here
// before acting", which is what needs-reconcile means.
const RECOVERABLE_ICONS: Record<Recoverable, string> = {
  recoverable: "●",
  "needs-reconcile": "!",
  "already-undone": "↩",
  kept: "▪",
  unknown: "?",
};

// needs-reconcile is the only error: it is the one state where the previous
// outcome was never observed, so an operator must look before doing anything
// else. Warning would sort it with the merely inconvenient. unknown gets the
// neutral tone and no other state shares it, because an unmeasured state is
// not a safe one and must not borrow a measured state's colour.
const RECOVERABLE_TONES: Record<
  Recoverable,
  "success" | "warning" | "error" | "muted" | "default"
> = {
  recoverable: "success",
  "needs-reconcile": "error",
  "already-undone": "muted",
  kept: "warning",
  unknown: "default",
};

const RECOVERABLE_WORDS: Record<Recoverable, string> = {
  recoverable: "recoverable",
  "needs-reconcile": "needs-reconcile",
  "already-undone": "already-undone",
  kept: "kept",
  unknown: "unknown",
};

/** The glyph for a state. Always paired with recoverableWord at the call site. */
export function recoverableIcon(state: Recoverable): string {
  return RECOVERABLE_ICONS[state] ?? "?";
}

export function recoverableTone(
  state: Recoverable,
): "success" | "warning" | "error" | "muted" | "default" {
  return RECOVERABLE_TONES[state] ?? "default";
}

/** The word for a state. This is the signal; the icon is decoration. */
export function recoverableWord(state: Recoverable): string {
  return RECOVERABLE_WORDS[state] ?? "unknown";
}

/**
 * Group consecutive rows by path, so a file edited three times reads as one
 * run rather than scattered lines. The input order is never changed: rows are
 * only clustered, because adjacency is what tells an operator what happened
 * to what, and re-sorting would rewrite that story.
 */
export function groupRecovery(rows: readonly RecoveryRow[]): RecoveryRow[][] {
  const groups: RecoveryRow[][] = [];
  for (const row of rows) {
    const last: RecoveryRow[] | undefined = groups[groups.length - 1];
    if (last !== undefined && last[0]?.path === row.path) last.push(row);
    else groups.push([row]);
  }
  return groups;
}

// Settled rows sort last: a row the operator has already answered (undone, or
// kept) is not what they are scrolling to find, so open rows come first.
function settledRank(state: Recoverable): number {
  return state === "already-undone" || state === "kept" ? 1 : 0;
}

// An invalid or missing timestamp prints nothing. Never "Invalid Date": that
// string reads as a failed measurement rather than a missing one, while the
// record simply carried no time. Carried text that parses prints as-is, so the
// output never depends on the machine's timezone.
function formatWhen(at: string | undefined): string {
  if (at === undefined) return "";
  const clean: string = sanitizeText(at).trim();
  if (clean === "" || Number.isNaN(Date.parse(clean))) return "";
  return ` (${clean})`;
}

// Every segment is sanitized here, before paint ever runs: reasons arrive
// from agents and servers, and sanitizing after paint would strip the escapes
// paint just inserted. Empty segments are dropped, so no dangling "--" or
// empty parens survive to confuse the reader.
function buildValue(row: RecoveryRow, motion: MotionContext): string {
  const icon: string = recoverableIcon(row.recoverable);
  const word: string = recoverableWord(row.recoverable);
  const tone = recoverableTone(row.recoverable);
  // The inspector has no "default" tone key, so the neutral state maps to the
  // same base text tone the inspector itself uses for it. The tone is
  // invisible here anyway: this pill is built unpainted, and the inspector
  // paints the whole value with the field tone afterwards.
  const pillTone: Tone = tone === "default" ? "fg" : tone;
  const statePill: string = pill(word, pillTone, motion);
  const kind: string = sanitizeText(row.kind);
  const undoes: string =
    row.undoesId !== undefined && sanitizeText(row.undoesId).trim() !== ""
      ? ` undoes ${sanitizeText(row.undoesId).trim()}`
      : "";
  const path: string =
    sanitizeText(row.path).trim() !== ""
      ? ` ${sanitizeText(row.path).trim()}`
      : "";
  const reason: string =
    row.reason !== undefined && sanitizeText(row.reason).trim() !== ""
      ? ` · ${sanitizeText(row.reason).trim()}`
      : "";
  return `${icon} ${statePill} ${kind}${undoes}${path}${reason}${formatWhen(row.at)}`;
}

// Mirror of the inspector's label column: widest sanitized label, capped so
// one value cell always survives. Reading the same inputs through the same
// functions keeps both sides on the same column without a second renderer,
// and pre-fitting the value to that column keeps every field to one line.
function fitFields(
  ordered: readonly RecoveryRow[],
  labels: readonly string[],
  cells: number,
  motion: MotionContext,
): Field[] {
  let widest = 1;
  for (const label of labels) {
    widest = Math.max(widest, visibleLength(sanitizeText(label)));
  }
  const labelCol: number = Math.min(widest, cells - 3);
  const valueWidth: number = cells - labelCol - 2;
  return ordered.map((row, index) => ({
    label: labels[index] ?? "",
    value: fit(buildValue(row, motion), valueWidth),
    tone: recoverableTone(row.recoverable),
  }));
}

export function renderRecovery(
  rows: readonly RecoveryRow[],
  width: number,
  options?: {
    readonly motion?: MotionContext;
    readonly paint?: (text: string, tone: string, bold?: boolean) => string;
  },
): string[] {
  const cells: number = Number.isFinite(width)
    ? Math.max(0, Math.floor(width))
    : 0;
  if (rows.length === 0)
    return [fit(sanitizeText("Nothing to recover."), cells)];
  if (cells <= 0) return rows.map(() => "");
  // Static view: the frozen first frame keeps two renders byte identical.
  // pill ignores the frame, so even a live motion context cannot move output.
  const motion: MotionContext =
    options?.motion ?? motionContext(0, false, true);
  // Stable settled-last order. The index tiebreak keeps identical states in
  // input order on any engine, not just ones with a stable sort.
  const ordered: RecoveryRow[] = rows
    .map((row, index) => ({ row, index }))
    .sort(
      (a, b) =>
        settledRank(a.row.recoverable) - settledRank(b.row.recoverable) ||
        a.index - b.index,
    )
    .map((entry) => entry.row);
  const labels: string[] = ordered.map((row) => `#${row.seq} ${row.id}`);
  const fields: Field[] =
    cells >= 4
      ? fitFields(ordered, labels, cells, motion)
      : ordered.map((row, index) => ({
          label: labels[index] ?? "",
          value: buildValue(row, motion),
          tone: recoverableTone(row.recoverable),
        }));
  const spec: InspectorSpec = {
    title: "Recovery",
    sections: [{ title: "Changes", fields }],
  };
  const lines: string[] = renderInspector(spec, {
    width: cells,
    motion,
    paint: options?.paint,
  });
  // One output row per input row: the inspector's title, rule and section
  // header are display chrome, and keeping them would return more rows than
  // were given. Every line below still IS inspector output, with its shared
  // label column intact; the chrome is dropped, never rewritten. Each field
  // is exactly one line (labels never wrap in the inspector, values are
  // pre-fitted above), so the field block is lines 3 through 3 + N.
  return lines.slice(3, 3 + fields.length);
}

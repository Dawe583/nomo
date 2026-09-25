import type { Row } from "./api";

/**
 * Plain-language text for the approval inbox and the approval dialog.
 *
 * Every function here renders only what the record actually carries, because
 * the record is not always the whole call: packages/policy keeps payload
 * arguments out of ApprovalRecord on purpose, so a missing field is the normal
 * case and an invented sentence about a target nobody recorded is worse than an
 * admitted unknown.
 *
 * Locale is deliberately not a parameter: the call sites pass none and
 * ui.tsx defaults Locale to "en", so English is the honest fallback here. The
 * Czech copy lives in the components that own a translator.
 */

const RISK_ORDER = ["r3", "r2", "r1", "r0"];
const UNKNOWN = "unknown";
const NO_DETAIL = "Server supplied no detail for this call";
const MAX_VALUE = 60;

/** Argument names that identify the target, in the order an operator reads them. */
const TARGET_KEYS = [
  "table",
  "schema",
  "database",
  "path",
  "file",
  "bucket",
  "object",
  "key",
  "collection",
  "index",
  "branch",
  "ref",
  "statement",
  "query",
  "sql",
  "url",
  "uri",
  "id",
  "name",
];

/**
 * Count-shaped arguments are never the headline: in a one line summary
 * "rows: 500" reads like a blast radius. They stay visible in the dialog's
 * JSON view and in blastSummary, which states the precision instead.
 */
const MEASURE_KEYS = [
  "rows",
  "rowcount",
  "count",
  "limit",
  "offset",
  "take",
  "skip",
  "pagesize",
  "page_size",
  "n",
];

/**
 * The reversibility class exactly as the server stated it. Anything else is
 * "unknown": a missing or unrecognised class is the case a human has to look
 * at, and defaulting it to r0 would invent permission that was never granted.
 */
export function riskOf(record: Row): string {
  const raw = record.klass ?? record.call?.klass;
  const value = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  return RISK_ORDER.includes(value) ? value : UNKNOWN;
}

/**
 * Risk first, unknown last, and the server's own order inside a class. The
 * index tiebreak states the stability in the output rather than trusting the
 * engine's sort, so two operators reading the same list see the same order.
 */
export function sortRiskFirst<T>(
  rows: readonly T[],
  identity: (row: T) => Row,
): T[] {
  return rows
    .map((row, index) => ({ row, index }))
    .sort(
      (a, b) =>
        riskRank(identity(a.row)) - riskRank(identity(b.row)) ||
        a.index - b.index,
    )
    .map((entry) => entry.row);
}

/**
 * Blast radius with its precision, because CONTEXT.md defines three of them:
 * sampling cannot prove an exact count, and unknown is not zero. A count whose
 * precision nobody stated is therefore never rendered as an exact figure.
 */
export function blastSummary(record: Row): string {
  const radius = record.blastRadius ?? record.call?.blastRadius;
  if (radius === null || radius === undefined) return UNKNOWN;
  // The approval API carries a bare number; the managed runtime carries the
  // counted object. A bare number states a count but not how it was measured.
  if (typeof radius === "number")
    return finiteCount(radius) === undefined
      ? UNKNOWN
      : `${String(radius)}, precision not stated`;
  if (typeof radius !== "object" || Array.isArray(radius)) return UNKNOWN;
  const shaped = radius as Row;
  const count = finiteCount(shaped.count);
  if (count === undefined) return UNKNOWN;
  const precision =
    typeof shaped.precision === "string"
      ? shaped.precision.trim().toLowerCase()
      : "";
  if (precision === "exact") return String(count);
  if (precision === "bounded") return `up to ${String(count)}`;
  return `${String(count)}, precision not stated`;
}

/**
 * One line saying what the call is, built only from the tool id and the single
 * most consequential argument. The target leads because "which table" is what
 * the operator approves; a vague sentence is worse than the raw tool id.
 */
export function plainAction(record: Row): string {
  const tool = text(record.call?.tool) ?? text(record.tool);
  const args = argsOf(record);
  const target = targetArgument(args);
  const names = argumentNames(args);
  if (tool === undefined) {
    if (target !== undefined) return `unknown tool (${target})`;
    if (names.length > 0)
      return `unknown tool (arguments: ${names.join(", ")})`;
    // The reason is the only text the server sent, so it is quoted as a reason
    // and never presented as a description of the call.
    const reason = text(record.reason);
    return reason === undefined ? NO_DETAIL : `unknown tool: ${reason}`;
  }
  if (target !== undefined) return `${tool} (${target})`;
  if (names.length > 0) return `${tool} (arguments: ${names.join(", ")})`;
  return `${tool} (no arguments supplied)`;
}

function riskRank(record: Row): number {
  const rank = RISK_ORDER.indexOf(riskOf(record));
  return rank === -1 ? RISK_ORDER.length : rank;
}

function finiteCount(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : undefined;
}

function argsOf(record: Row): Row | undefined {
  const value = record.call?.args ?? record.args;
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Row)
    : undefined;
}

function targetArgument(args: Row | undefined): string | undefined {
  if (args === undefined) return undefined;
  const keys = Object.keys(args);
  const ordered = [
    ...TARGET_KEYS.filter((key) => keys.includes(key)),
    ...keys.filter(
      (key) => !TARGET_KEYS.includes(key) && !MEASURE_KEYS.includes(key),
    ),
  ];
  for (const key of ordered) {
    const value = scalar(args[key]);
    if (value !== undefined) return `${key}: ${clip(value)}`;
  }
  return undefined;
}

function argumentNames(args: Row | undefined): string[] {
  const keys = args === undefined ? [] : Object.keys(args);
  const shown = keys.slice(0, 3);
  return keys.length > shown.length ? [...shown, "…"] : shown;
}

function scalar(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim() !== "") return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value === "boolean") return String(value);
  // A nested value would print a payload rather than name a target, and the
  // dialog already shows the whole object.
  return undefined;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== ""
    ? value.trim()
    : undefined;
}

function clip(value: string): string {
  return value.length > MAX_VALUE ? value.slice(0, MAX_VALUE - 1) + "…" : value;
}

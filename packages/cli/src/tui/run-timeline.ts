// A run rendered as a timeline: which phase it is in, how long each phase
// took, and what each step cost. The run list elsewhere shows events and
// counters; this view answers the next question, where the time and the
// tokens went, in the same frame the operator is already watching.
import { animatedBar, motionContext, stepper } from "./motion.ts";
import type { MotionContext } from "./motion.ts";
import { stackedBar } from "./charts.ts";
import { fit, sanitizeText, visibleLength } from "./layout.ts";

export type RunPhase =
  | "queued"
  | "starting"
  | "thinking"
  | "tool"
  | "writing"
  | "verifying"
  | "settling"
  | "done"
  | "failed"
  | "unknown";

export interface TimelineStep {
  readonly phase: RunPhase;
  /** Milliseconds. Undefined means the phase never finished. */
  readonly ms?: number;
  /** Optional one line detail, for example the tool name. */
  readonly detail?: string;
  /** Optional measured cost, used by the budget bar. */
  readonly tokens?: number;
}

export interface TimelineState {
  readonly steps: readonly TimelineStep[];
  readonly current: number;
}

export interface TimelineOptions {
  readonly motion?: MotionContext;
  readonly paint?: (text: string, tone: string, bold?: boolean) => string;
}

export interface BudgetOptions {
  readonly maxTokens?: number;
  readonly motion?: MotionContext;
  readonly paint?: (text: string, tone: string, bold?: boolean) => string;
}

// ASCII only, so every icon is exactly one cell under layout.ts. Anything in
// U+2600 to U+27BF counts as two cells and would misalign the bar column, and
// a wider icon set would need a font the operator may not have.
const PHASE_ICONS: Record<RunPhase, string> = {
  queued: "+",
  starting: ">",
  thinking: "~",
  tool: "*",
  writing: "=",
  verifying: "v",
  settling: "-",
  done: "o",
  failed: "x",
  unknown: "?",
};

const ALL_PHASES: readonly RunPhase[] = [
  "queued",
  "starting",
  "thinking",
  "tool",
  "writing",
  "verifying",
  "settling",
  "done",
  "failed",
  "unknown",
];

// The tone is decoration only: every row also prints the icon and the word,
// so a monochrome terminal loses nothing when paint is the identity.
function phaseTone(phase: RunPhase): string {
  if (phase === "failed") return "r3";
  if (phase === "done") return "r0";
  if (phase === "unknown") return "muted";
  return "accent";
}

/** The glyph for a phase. Always paired with phaseLabel at the call site. */
export function phaseIcon(phase: RunPhase): string {
  return PHASE_ICONS[phase] ?? "?";
}

/** The word for a phase. This is the signal; the icon is decoration. */
export function phaseLabel(phase: RunPhase): string {
  return phase;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function firstString(
  record: Record<string, unknown>,
  keys: readonly string[],
): string | undefined {
  for (const key of keys) {
    const value: unknown = record[key];
    if (typeof value === "string" && value !== "") return value;
  }
  return undefined;
}

function firstNumber(
  record: Record<string, unknown>,
  keys: readonly string[],
): number | undefined {
  for (const key of keys) {
    const value: unknown = record[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return undefined;
}

function eventTimestamp(record: Record<string, unknown>): number | undefined {
  const numeric: number | undefined = firstNumber(record, [
    "ts",
    "timestamp",
    "time",
    "at",
  ]);
  if (numeric !== undefined) return numeric;

  const value: unknown = record["at"];
  if (typeof value !== "string") return undefined;
  const timestamp: number = Date.parse(value);
  if (!Number.isFinite(timestamp)) return undefined;
  return new Date(timestamp).toISOString() === value ? timestamp : undefined;
}

// Map one event to a phase. Returns null for events with no type so the
// caller drops them: an event nobody typed is not a phase, it is noise.
function eventPhase(event: Record<string, unknown>): RunPhase | null {
  const type: unknown = event["type"];
  if (typeof type !== "string" || type === "") return null;
  if (type === "tool.started") return "tool";
  if (type === "message.delta") return "writing";
  if (type === "run.queued") return "queued";
  if (type === "run.started" || type === "run.starting") return "starting";
  if (
    type === "run.completed" ||
    type === "run.done" ||
    type === "run.finished"
  )
    return "done";
  if (type === "run.failed" || type === "run.error") return "failed";
  if (type === "run.status") {
    const status: unknown = event["status"];
    if (status === "queued") return "queued";
    if (status === "starting" || status === "running") return "starting";
    if (status === "thinking") return "thinking";
    if (status === "tool") return "tool";
    if (status === "writing") return "writing";
    if (status === "verifying") return "verifying";
    if (status === "settling") return "settling";
    if (status === "done" || status === "completed") return "done";
    if (status === "failed" || status === "error") return "failed";
    return "unknown";
  }
  return "unknown";
}

/**
 * Derive phases from event objects with a `type` field. Events without a
 * type are ignored, unrecognised types become `unknown` rather than a guess,
 * and an empty array yields zero steps rather than a fabricated one.
 */
export function buildTimeline(events: readonly unknown[]): TimelineState {
  const steps: TimelineStep[] = [];
  const stamps: (number | undefined)[] = [];
  for (const event of events) {
    if (!isRecord(event)) continue;
    const phase: RunPhase | null = eventPhase(event);
    if (phase === null) continue;
    const step: TimelineStep = { phase };
    const detail: string | undefined = firstString(event, [
      "detail",
      "tool",
      "name",
    ]);
    // The tool name is the detail an operator asks for first on a tool step.
    const withDetail: TimelineStep =
      detail !== undefined ? { ...step, detail } : step;
    const tokens: number | undefined = firstNumber(event, ["tokens"]);
    const withCost: TimelineStep =
      tokens !== undefined ? { ...withDetail, tokens } : withDetail;
    steps.push(withCost);
    stamps.push(eventTimestamp(event));
  }
  // A duration needs both neighbours stamped. A missing end stamp leaves ms
  // undefined: zero would read as instant, and instant is a claim.
  const timed: TimelineStep[] = steps.map(
    (step: TimelineStep, index: number) => {
      const start: number | undefined = stamps[index];
      const end: number | undefined = stamps[index + 1];
      if (start === undefined || end === undefined || end < start) return step;
      const duration: number = end - start;
      if (!Number.isFinite(duration)) return step;
      return { ...step, ms: duration };
    },
  );
  return { steps: timed, current: timed.length === 0 ? 0 : timed.length - 1 };
}

function resolveMotion(motion: MotionContext | undefined): MotionContext {
  return motion ?? motionContext(0, false, true);
}

// Durations are words, never the bar alone: a fill with no number is
// unreadable on a monochrome terminal. Undefined is named, not blanked,
// because a missing measurement must not read as zero.
function formatDuration(ms: number | undefined): string {
  if (ms === undefined || !Number.isFinite(ms)) return "time unknown";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60000) return `${Math.round(ms / 100) / 10}s`;
  const minutes: number = Math.floor(ms / 60000);
  const seconds: number = Math.round((ms - minutes * 60000) / 1000);
  return `${minutes}m ${seconds}s`;
}

/**
 * Render the phase row plus one row per step, capped at height. The phase row
 * comes from stepper so the timeline animates in phase with the rest of the
 * frame. A zero step state still returns one row naming the state.
 */
export function renderTimeline(
  state: TimelineState,
  width: number,
  height: number,
  options?: TimelineOptions,
): string[] {
  const cells: number = Math.max(0, Math.floor(width));
  const rows: number = Math.max(0, Math.floor(height));
  if (rows <= 0) return [];
  if (cells <= 0) return new Array<string>(rows).fill("");
  const motion: MotionContext = resolveMotion(options?.motion);
  const paint: (text: string, tone: string, bold?: boolean) => string =
    options?.paint ?? ((text: string) => text);
  if (state.steps.length === 0) {
    return [fit(sanitizeText("no steps"), cells)];
  }
  const current: number = Math.max(
    0,
    Math.min(state.current, state.steps.length - 1),
  );
  const labels: readonly string[] = state.steps.map((step: TimelineStep) =>
    sanitizeText(phaseLabel(step.phase)),
  );
  const phaseRow: string = fit(
    sanitizeText(stepper(labels, current, motion).join(" ")),
    cells,
  );
  let slowest = -1;
  let top = -1;
  for (let index = 0; index < state.steps.length; index += 1) {
    const ms: number | undefined = state.steps[index]?.ms;
    if (ms !== undefined && Number.isFinite(ms) && ms > top) {
      top = ms;
      slowest = index;
    }
  }
  const maxMs: number = top > 0 ? top : 1;
  const out: string[] = [phaseRow];
  for (let index = 0; index < state.steps.length; index += 1) {
    const step: TimelineStep = state.steps[index]!;
    // Sanitize before painting: sanitizeText replaces ESC, so running it
    // after paint would corrupt the caller's ANSI sequences.
    const glyph: string = sanitizeText(phaseIcon(step.phase));
    const icon: string = paint(glyph, phaseTone(step.phase), index === current);
    const duration: string = sanitizeText(formatDuration(step.ms));
    const detail: string =
      step.detail !== undefined && step.detail !== ""
        ? sanitizeText(step.detail)
        : "";
    const mark: string = index === slowest && slowest >= 0 ? " slowest" : "";
    const head: string = `${glyph} ${labels[index]} ${duration}`;
    const tail: string = `${detail !== "" ? ` ${detail}` : ""}${mark}`;
    // The bar takes whatever the words leave. At a cramped width that can be
    // nothing, and the words still carry the measurement on their own.
    const barWidth: number = Math.max(
      0,
      cells - visibleLength(head) - visibleLength(tail) - 1,
    );
    const bar: string = animatedBar(step.ms ?? 0, maxMs, barWidth, motion, {
      paint: (text: string, tone: string, bold?: boolean) =>
        paint(text, tone, bold),
    });
    out.push(
      fit(
        `${icon} ${labels[index]} ${duration}${bar !== "" ? ` ${bar}` : ""}${tail}`,
        cells,
      ),
    );
  }
  return out.slice(0, rows);
}

function countTokens(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0)
    return undefined;
  return value;
}

// Suffix a repeated phase so two tool steps do not share one legend entry.
// The count is per phase in first-seen order, which matches the bar order.
function budgetSegments(
  steps: readonly TimelineStep[],
): readonly { readonly label: string; readonly value: number }[] {
  const frequencies = new Map<string, number>();
  for (const step of steps) {
    if (countTokens(step.tokens) !== undefined) {
      frequencies.set(step.phase, (frequencies.get(step.phase) ?? 0) + 1);
    }
  }
  const seen = new Map<string, number>();
  const segments: { readonly label: string; readonly value: number }[] = [];
  for (const step of steps) {
    const tokens: number | undefined = countTokens(step.tokens);
    if (tokens === undefined) continue;
    const base: string = sanitizeText(phaseLabel(step.phase));
    const order: number = (seen.get(step.phase) ?? 0) + 1;
    seen.set(step.phase, order);
    const label: string =
      (frequencies.get(step.phase) ?? 0) > 1
        ? sanitizeText(`${base} ${order}`)
        : base;
    segments.push({ label, value: tokens });
  }
  return segments;
}

/**
 * Render token cost as a stacked bar plus a legend naming each segment. With
 * no tokens the state is said in words, never drawn as an empty bar, which
 * would read as a measurement of zero.
 */
export function renderBudget(
  steps: readonly TimelineStep[],
  width: number,
  options?: BudgetOptions,
): string[] {
  const cells: number = Math.max(0, Math.floor(width));
  if (cells <= 0) return ["", ""];
  const motion: MotionContext = resolveMotion(options?.motion);
  const segments = budgetSegments(steps);
  if (segments.length === 0) {
    return [fit(sanitizeText("no token data"), cells)];
  }
  // stackedBar renders shares of the reported total, so the absolute scale
  // cannot move the widths. The budget is therefore stated in words on the
  // legend row, where a monochrome reader finds it. The maxTokens guard below
  // accepts only a finite positive number, so maxTokens: 0 falls back to the
  // reported values and can never divide by zero or print NaN.
  const maxTokens: number | undefined = options?.maxTokens;
  const budgeted: boolean =
    maxTokens !== undefined && Number.isFinite(maxTokens) && maxTokens > 0;
  const suffix: string = budgeted ? sanitizeText(` (budget ${maxTokens})`) : "";
  const parts: readonly string[] = stackedBar(segments, cells, {
    motion,
  }).split("\n");
  const bar: string = fit(sanitizeText(parts[0] ?? ""), cells);
  const legend: string = fit(
    sanitizeText(`${(parts[1] ?? "").trimEnd()}${suffix}`),
    cells,
  );
  return [bar, legend];
}

export { ALL_PHASES };

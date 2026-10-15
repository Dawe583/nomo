// An activity strip for a conversation: one small mark per event so the
// SHAPE of a wall of events is visible without reading it. A flat transcript
// shows what was said; this answers the glanceable questions instead: when
// did it start, what did it do, where did it stop, what came in last.
import { fit, sanitizeText, visibleLength } from "./layout.ts";
import type { MotionContext } from "./motion.ts";
import { idleBreath, motionContext } from "./motion.ts";
import { sparkline } from "./charts.ts";
import { phaseIcon } from "./run-timeline.ts";

export interface ActivityEvent {
  readonly kind: string;
  readonly at: string;
  /** One short line describing it. */
  readonly label: string;
  /** Milliseconds from the previous event, when both have timestamps. */
  readonly gapMs?: number;
}

export interface ActivityStrip {
  readonly events: readonly ActivityEvent[];
  readonly firstAt?: string;
  readonly lastAt?: string;
}

export interface ActivityOptions {
  readonly motion?: MotionContext;
  readonly paint?: (text: string, tone: string, bold?: boolean) => string;
  /** Maximum rows returned. Without it every row is returned. */
  readonly height?: number;
}

// A silence longer than this draws a visible break in the strip. Five minutes
// is past normal turn latency, so it usually means the operator was away or
// something stalled, which is exactly the gap worth seeing on return.
export const GAP_THRESHOLD_MS = 5 * 60 * 1000;

// Conversation roles are not run lifecycle phases, so run-timeline's phase
// model cannot label them: there is no phase for "the human wrote back". The
// marks below are a separate small table on purpose, but they reuse
// phaseIcon where the meaning already matches (failure, unknown) so the two
// views never disagree on those glyphs. Every mark is plain ASCII, which is
// one cell under layout.ts; anything in U+2600 to U+27BF counts two cells
// and would halve the strip resolution and shift every mark after it.
function markFor(kind: string, timed: boolean): string {
  if (!timed) return "?";
  if (kind === "error") return phaseIcon("failed");
  if (kind === "unknown") return phaseIcon("unknown");
  if (kind === "user") return ">";
  if (kind === "assistant") return "=";
  if (kind === "tool") return "*";
  if (kind === "usage") return "+";
  return "?";
}

// A silence break inside the strip. Distinct from every event mark so a gap
// never reads as one more event of some kind.
const GAP_MARK = "|";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function firstText(
  record: Record<string, unknown>,
  keys: readonly string[],
): string | undefined {
  for (const key of keys) {
    const value: unknown = record[key];
    if (typeof value === "string" && value !== "") return value;
  }
  return undefined;
}

// Canonical role from a free-form kind or type string. Anything unrecognised
// becomes "unknown" rather than a guess, and the raw word stays out of the
// kind so the strip marks stay a closed set the legend can name.
function canonicalKind(raw: string): string {
  const word: string = raw.trim().toLowerCase();
  if (word === "user" || word === "human" || word === "prompt") return "user";
  if (
    word === "assistant" ||
    word === "agent" ||
    word === "model" ||
    word === "ai" ||
    word === "message" ||
    word === "message.delta" ||
    word === "reply"
  )
    return "assistant";
  if (
    word === "tool" ||
    word === "tool.started" ||
    word === "tool.result" ||
    word === "function" ||
    word === "call"
  )
    return "tool";
  if (
    word === "error" ||
    word === "failed" ||
    word === "failure" ||
    word === "run.failed" ||
    word === "run.error"
  )
    return "error";
  if (
    word === "usage" ||
    word === "tokens" ||
    word === "token" ||
    word === "cost"
  )
    return "usage";
  return "unknown";
}

// A timestamp is valid only when it parses to a finite epoch. Numbers are
// accepted as epoch millis because some producers stamp numerically; the
// canonical stored form is always ISO so the summary prints one shape.
function parseAt(
  value: unknown,
): { readonly iso: string; readonly ms: number } | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    const date = new Date(value);
    const ms: number = date.getTime();
    if (!Number.isFinite(ms)) return null;
    return { iso: date.toISOString(), ms };
  }
  if (typeof value === "string" && value !== "") {
    const ms: number = Date.parse(value);
    if (!Number.isFinite(ms)) return null;
    return { iso: new Date(ms).toISOString(), ms };
  }
  return null;
}

/**
 * Normalise loose event objects into a strip. Nothing is dropped: events
 * with no timestamp, an invalid timestamp, or an unrecognised kind still
 * appear, marked "?" in the strip, because dropping them would hide events
 * from the shape the operator is trying to read.
 */
export function buildActivity(
  events: readonly {
    kind?: unknown;
    type?: unknown;
    at?: unknown;
    text?: unknown;
  }[],
): ActivityStrip {
  const out: ActivityEvent[] = [];
  let previousMs: number | undefined;
  let firstAt: string | undefined;
  let lastAt: string | undefined;
  for (const input of events) {
    const record: Record<string, unknown> = isRecord(input)
      ? (input as Record<string, unknown>)
      : {};
    const rawKind: string =
      firstText(record, ["kind", "type", "role"]) ?? "unknown";
    const kind: string = canonicalKind(rawKind);
    const stamp = parseAt(
      record["at"] ?? record["ts"] ?? record["timestamp"] ?? record["time"],
    );
    // gapMs needs both neighbours stamped. A missing stamp leaves it
    // undefined: zero would read as instant, and instant is a claim.
    const gapMs: number | undefined =
      stamp !== null && previousMs !== undefined
        ? stamp.ms - previousMs
        : undefined;
    if (stamp !== null) {
      if (firstAt === undefined) firstAt = stamp.iso;
      lastAt = stamp.iso;
      previousMs = stamp.ms;
    }
    const rawLabel: unknown = record["text"] ?? record["label"];
    // First line only and capped: the label is a caption for the summary,
    // not a second copy of the transcript.
    const label: string =
      typeof rawLabel === "string" && rawLabel.trim() !== ""
        ? rawLabel.split("\n")[0]!.trim().slice(0, 160)
        : kind;
    const event: ActivityEvent =
      gapMs === undefined
        ? { kind, at: stamp?.iso ?? "", label }
        : { kind, at: stamp?.iso ?? "", label, gapMs };
    out.push(event);
  }
  const strip: ActivityStrip =
    firstAt === undefined
      ? { events: out }
      : lastAt !== undefined && lastAt !== firstAt
        ? { events: out, firstAt, lastAt }
        : { events: out, firstAt, lastAt: firstAt };
  return strip;
}

// One mark per event plus a break mark for each long silence, in order. Gap
// breaks are part of the shape: a flat run of marks hides the hour the
// operator was away, and that hour is often where something went wrong.
function stripMarks(strip: ActivityStrip): string[] {
  const marks: string[] = [];
  for (const event of strip.events) {
    if (
      event.gapMs !== undefined &&
      Number.isFinite(event.gapMs) &&
      event.gapMs > GAP_THRESHOLD_MS
    ) {
      marks.push(GAP_MARK);
    }
    marks.push(markFor(event.kind, event.at !== ""));
  }
  return marks;
}

function resolveMotion(motion: MotionContext | undefined): MotionContext {
  return motion ?? motionContext(0, false, true);
}

/**
 * One row of small marks, one per event, so a conversation's shape is
 * visible without reading it. Never empty: no events names the empty state.
 * Overflow keeps the newest marks, because the end is where the
 * conversation is now, and prefixes how many events folded away so nothing
 * is silently dropped.
 */
export function activityStrip(
  strip: ActivityStrip,
  width: number,
  options?: { readonly motion?: MotionContext },
): string {
  const cells: number = Number.isFinite(width) ? Math.floor(width) : 0;
  const motion: MotionContext = resolveMotion(options?.motion);
  if (strip.events.length === 0) {
    // The breath dot is decoration on a named state, so a frozen frame and
    // a monochrome terminal still read the words.
    const text: string = sanitizeText(`no activity yet ${idleBreath(motion)}`);
    return cells <= 0 ? text : fit(text, cells);
  }
  // Degenerate widths cannot bound anything, so the newest mark at least
  // keeps the return non-empty rather than honest about width.
  if (cells <= 0) {
    const marks: readonly string[] = stripMarks(strip);
    return sanitizeText(marks[marks.length - 1] ?? "?");
  }
  const marks: string[] = stripMarks(strip);
  const row: string = marks.join("");
  if (visibleLength(row) <= cells) return fit(sanitizeText(row), cells);
  // Compression keeps the newest marks, because the end is where the
  // conversation is now, and counts the folded head. The count is events,
  // not marks, because gap breaks fold with their neighbours and the
  // operator thinks in events. The widest fitting tail wins; a width too
  // narrow for any prefix still names the total rather than going silent.
  const maxShown: number = Math.min(marks.length - 1, cells);
  for (let shown = maxShown; shown >= 1; shown -= 1) {
    const folded: number = marks.length - shown;
    const prefix: string = `+${folded} `;
    if (visibleLength(prefix) + shown <= cells) {
      return fit(
        sanitizeText(`${prefix}${row.slice(row.length - shown)}`),
        cells,
      );
    }
  }
  return fit(sanitizeText(`+${marks.length}`), cells);
}

function formatSpan(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "?";
  if (ms < 1000) return `${Math.max(0, Math.round(ms))}ms`;
  const totalSeconds: number = Math.floor(ms / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const totalMinutes: number = Math.floor(totalSeconds / 60);
  if (totalMinutes < 60) {
    const seconds: number = totalSeconds - totalMinutes * 60;
    return seconds === 0 ? `${totalMinutes}m` : `${totalMinutes}m ${seconds}s`;
  }
  const hours: number = Math.floor(totalMinutes / 60);
  const minutes: number = totalMinutes - hours * 60;
  return minutes === 0 ? `${hours}h` : `${hours}h ${minutes}m`;
}

// The last event in words. The word carries it, never the glyph alone, so a
// monochrome reader gets the same sentence.
function kindWords(kind: string): string {
  if (kind === "user") return "a user message";
  if (kind === "assistant") return "an assistant reply";
  if (kind === "tool") return "a tool call";
  if (kind === "error") return "an error";
  if (kind === "usage") return "a usage report";
  return "an event of unknown kind";
}

/**
 * One sentence describing where the conversation is in time: both the span
 * and the recency, because an operator returning after an hour wants both.
 * Without `now` there is no honest age, so the sentence states the span and
 * the last kind instead of inventing one. Stamps after `now` are reported
 * as future time, never as a negative age.
 */
export function activitySummary(strip: ActivityStrip, now?: number): string {
  const count: number = strip.events.length;
  if (count === 0) return sanitizeText("no activity yet");
  const noun: string = count === 1 ? "1 event" : `${count} events`;
  const last: ActivityEvent = strip.events[strip.events.length - 1]!;
  const lastWords: string = kindWords(last.kind);
  const firstMs: number =
    strip.firstAt !== undefined ? Date.parse(strip.firstAt) : NaN;
  const lastMs: number =
    strip.lastAt !== undefined ? Date.parse(strip.lastAt) : NaN;
  const timed: boolean = Number.isFinite(firstMs) && Number.isFinite(lastMs);
  const span: string = timed
    ? formatSpan(Math.max(0, (lastMs as number) - (firstMs as number)))
    : "?";
  if (now === undefined || !Number.isFinite(now)) {
    return sanitizeText(
      timed
        ? `${noun} over ${span}, last ${lastWords}`
        : `${noun}, last ${lastWords}`,
    );
  }
  const at: number = now as number;
  if (!timed) return sanitizeText(`${noun}, last ${lastWords}, no timestamps`);
  // A stamp past `now` is clock skew or a plan, never a negative age.
  if ((lastMs as number) > at) {
    return sanitizeText(
      `${noun} over ${span}, last ${lastWords} stamped ${formatSpan((lastMs as number) - at)} in the future (check clock)`,
    );
  }
  const age: number = at - (lastMs as number);
  const ago: string = age < 5000 ? "just now" : `${formatSpan(age)} ago`;
  return sanitizeText(`${noun} over ${span}, last ${lastWords} ${ago}`);
}

// The legend pairs every mark with its word, so the strip stays legible
// without colour and without memorising glyphs.
function legendRow(): string {
  return sanitizeText(
    "> user = assistant * tool x error + usage ? unknown/time | gap 5m+",
  );
}

/**
 * The strip plus its pacing and its sentence: a sparkline of the gaps
 * between timed events, then the summary, then the legend. Always at least
 * one row; capped at `height` when given, newest-first importance would put
 * the strip first so the cap keeps the shape over the explanation.
 */
export function renderActivity(
  strip: ActivityStrip,
  width: number,
  options?: {
    readonly motion?: MotionContext;
    readonly paint?: (text: string, tone: string, bold?: boolean) => string;
  } & { readonly height?: number },
): string[] {
  const cells: number = Number.isFinite(width) ? Math.floor(width) : 0;
  const height: number =
    options?.height !== undefined && Number.isFinite(options.height)
      ? Math.floor(options.height)
      : 0;
  const motion: MotionContext = resolveMotion(options?.motion);
  // Sanitize before painting: sanitizeText replaces ESC, so running it after
  // paint would corrupt the caller's ANSI sequences.
  const paint: (text: string, tone: string, bold?: boolean) => string =
    options?.paint ?? ((text: string) => text);
  const rows: string[] = [];
  const stripRow: string = activityStrip(strip, Math.max(cells, 1), { motion });
  rows.push(
    cells <= 0
      ? stripRow
      : fit(paint(sanitizeText(stripRow), "accent", true), cells),
  );
  const gaps: number[] = [];
  for (const event of strip.events) {
    if (event.gapMs !== undefined && Number.isFinite(event.gapMs)) {
      gaps.push(Math.max(0, event.gapMs) / 1000);
    }
  }
  if (gaps.length > 0 && (height <= 0 || rows.length < height)) {
    const label: string = sanitizeText("pace ");
    const chart: string = sparkline(
      { values: gaps },
      Math.max(0, cells - visibleLength(label)),
      {
        motion,
      },
    );
    rows.push(
      cells <= 0
        ? `${label}${chart}`
        : fit(paint(sanitizeText(`${label}${chart}`), "muted"), cells),
    );
  }
  if (height <= 0 || rows.length < height) {
    const summary: string = sanitizeText(activitySummary(strip));
    rows.push(cells <= 0 ? summary : fit(paint(summary, "muted"), cells));
  }
  if (height <= 0 || rows.length < height) {
    rows.push(cells <= 0 ? legendRow() : fit(legendRow(), cells));
  }
  if (rows.length === 0)
    return [cells <= 0 ? "?" : fit(sanitizeText("?"), cells)];
  return height > 0 ? rows.slice(0, height) : rows;
}

import { fit, sanitizeText, stripAnsi, visibleLength } from "./layout.ts";

const DAMAGED_ANSI_SGR = /\?\[[0-?]*[ -/]*m/g;

function blockText(value: string): string {
  return sanitizeText(stripAnsi(value).replace(DAMAGED_ANSI_SGR, ""));
}
import {
  animatedBar,
  completionRing,
  cursorMarker,
  idleBreath,
  levelMeter,
  motionContext,
  type MotionContext,
} from "./motion.ts";
import { getSymbols, type SymbolPreset } from "./theme.ts";

// Titled transcript blocks: NOMO prints raw wrapped text while OMP renders
// each event as a block with a role marker, a timestamp, a collapsible body
// and a status footer. This module is that renderer, kept plain text first
// so every state stays legible without colour.

export type BlockRole =
  "user" | "assistant" | "tool" | "error" | "system" | "usage" | "thinking";

export type BlockTone =
  "default" | "muted" | "accent" | "success" | "warning" | "error";

export interface BlockInput {
  readonly role: BlockRole;
  /** Body text. May be multi-line. */
  readonly text: string;
  /** ISO timestamp, or undefined when the event carried none. */
  readonly at?: string;
  /** Optional heading such as a tool name or a run id. */
  readonly heading?: string;
  /** Tool lifecycle state, surfaced in its heading. */
  readonly status?: "running" | "done" | "failed";
  /** Tool lifecycle duration, when the matching start event is available. */
  readonly durationMs?: number;
  /** Collapse the body when it exceeds the block's row budget. */
  readonly collapsible?: boolean;
  /** Optional tone override for the heading. */
  readonly tone?: BlockTone;
}

export interface BlockOptions {
  readonly width: number;
  readonly motion?: MotionContext;
  readonly paint?: (text: string, tone: string, bold?: boolean) => string;
  readonly symbolPreset?: SymbolPreset;
}

// Iconoir and HugeIcons ship vector artwork; role markers below are one-cell
// terminal analogues, never embedded SVGs. The adjacent role label is the
// readable source of meaning in every color and motion mode.

const ROLE_LABELS: Record<BlockRole, string> = {
  user: "USER",
  assistant: "ASSISTANT",
  tool: "TOOL",
  error: "ERROR",
  system: "SYSTEM",
  usage: "USAGE",
  thinking: "THINKING",
};

// The default heading tone per role. Words always carry the meaning beside
// the tone, so a monochrome terminal loses emphasis but never information.
const ROLE_TONES: Record<BlockRole, BlockTone> = {
  user: "accent",
  assistant: "default",
  tool: "success",
  error: "error",
  system: "muted",
  usage: "muted",
  thinking: "warning",
};

export function roleIcon(
  role: BlockRole,
  preset: SymbolPreset = "unicode",
): string {
  return getSymbols(preset).role[role];
}

export function roleLabel(role: BlockRole): string {
  return ROLE_LABELS[role];
}

// A heading is caller data, so blank or padded headings collapse to absent:
// invisible padding would break the heading scan without adding information.
function displayName(input: BlockInput): string {
  return blockText(input.heading ?? "").trim();
}

function shortTime(at: string | undefined): string {
  // A full ISO timestamp is wider than most terminals and nobody reads the
  // date of the message they just sent, so the heading carries a short local
  // time. An absent or invalid timestamp prints nothing rather than a raw
  // exception value on screen.
  if (at === undefined || at.trim() === "") return "";
  const ms = Date.parse(at);
  if (!Number.isFinite(ms)) return "";
  const date = new Date(ms);
  const hours = date.getHours();
  const minutes = date.getMinutes();
  if (!Number.isFinite(hours) || !Number.isFinite(minutes)) return "";
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
}

function lifecycleLabel(status: BlockInput["status"]): string | undefined {
  if (status === "running") return "requested";
  if (status === "done") return "completed";
  if (status === "failed") return "failed";
  return undefined;
}

/** Heading row for one block: icon, role, action, state and timestamp. */
export function blockHeading(
  input: BlockInput,
  width: number,
  preset: SymbolPreset = "unicode",
): string {
  const safe = Number.isFinite(width) ? Math.max(1, Math.floor(width)) : 1;
  const name = displayName(input);
  const role = roleLabel(input.role);
  const hasDistinctName =
    name !== "" && name.toLowerCase() !== role.toLowerCase();
  const state =
    input.role === "tool" ? lifecycleLabel(input.status) : undefined;
  // The tool icon already carries the role. Lead with its actual name to
  // avoid repeating the generic "TOOL" label beside "Tool" or "Bash".
  const identity =
    input.role === "tool" && hasDistinctName
      ? [name, ...(state ? [state] : [])].join(" · ")
      : [role, ...(state ? [state] : [])].join(" · ");
  const base = `${roleIcon(input.role, preset)} ${identity}`;
  const time = shortTime(
    input.at === undefined ? undefined : blockText(input.at),
  );
  if (time !== "" && visibleLength(`${base} ${time}`) <= safe)
    return `${base} ${time}`;
  // A heading broken across two lines stops being a heading, so it is
  // fitted to one row; the timestamp already dropped out above.
  return fit(base, safe);
}

// Cell based wrapper for one sanitized line. Local because layout.ts
// exposes no wrapper and workspace.ts is off limits (import cycle); it
// mirrors the inspector wrapper so wide glyphs never split mid cell.
function wrapCells(line: string, width: number): string[] {
  const safe = Math.max(1, width);
  const out: string[] = [];
  let part = "";
  for (const point of line) {
    if (part !== "" && visibleLength(part + point) > safe) {
      out.push(part);
      part = "";
    }
    part += point;
  }
  out.push(part);
  return out;
}

function wrapBody(input: BlockInput, width: number): string[] {
  // sanitizeText maps newline to "?" (it guards terminal injection), so the
  // body is split into lines before sanitising; sanitising first would fuse
  // every multi-line body into one row of question marks.
  if (input.text === "") return [];
  const rows: string[] = [];
  for (const raw of input.text.split("\n")) {
    // CRLF is a line ending, not body content, so the carriage return goes
    // before sanitising turns it into a visible question mark.
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    // Keep line shape intact, but remove terminal styling before sanitizing
    // control characters so damaged ANSI fragments cannot leak into the UI.
    for (const chunk of wrapCells(blockText(line), width)) rows.push(chunk);
  }
  return rows;
}

interface CollapsedBody {
  readonly rows: string[];
  readonly shown: number;
  readonly total: number;
  readonly hidden: number;
}

function collapseBody(
  all: readonly string[],
  maxRows: number,
  collapsible: boolean,
  width: number,
): CollapsedBody {
  const total = all.length;
  // An empty body is reported, never rendered as silence: a blank block
  // reads as a rendering failure rather than as an empty answer.
  if (total === 0) return { rows: ["(empty)"], shown: 0, total: 0, hidden: 0 };
  const asked = Number.isFinite(maxRows)
    ? Math.max(1, Math.floor(maxRows))
    : total;
  // A caller that marks a block non-collapsible takes responsibility for the
  // height; the budget is then advisory and the body prints whole.
  const budget = collapsible ? asked : total;
  if (budget >= total)
    return { rows: [...all], shown: total, total, hidden: 0 };
  const shown = Math.max(0, budget - 1);
  const hidden = total - shown;
  // The marker names the hidden count, so a cut body can never pass as a
  // short one; silently cutting the body is the defect this replaces.
  const marker = fit(
    `... ${hidden} more line${hidden === 1 ? "" : "s"}`,
    width,
  );
  return { rows: [...all.slice(0, shown), marker], shown, total, hidden };
}

/** The body rows, collapsed to `maxRows` with an explicit marker. */
export function blockBody(
  input: BlockInput,
  width: number,
  maxRows: number,
): string[] {
  const safe = Number.isFinite(width) ? Math.max(1, Math.floor(width)) : 1;
  // The final fit is the last width guard: wrapping cannot split one wide
  // cell, so a single wide glyph could otherwise overshoot a tiny width.
  return collapseBody(
    wrapBody(input, safe),
    maxRows,
    input.collapsible !== false,
    safe,
  ).rows.map((row) => fit(row, safe));
}

// Motion glyphs are built plain and fitted before painting, the inspector
// badge pattern: fitting after painting would strip the escapes paint just
// inserted. Tool state is written in the heading; the footer carries measured
// duration or collapsed-row information only.
function footerPlain(
  input: BlockInput,
  body: CollapsedBody,
  width: number,
  motion: MotionContext,
): string | undefined {
  if (input.role === "tool") {
    const details: string[] = [];
    if (
      typeof input.durationMs === "number" &&
      Number.isFinite(input.durationMs)
    ) {
      const duration =
        input.durationMs < 1_000
          ? `${Math.round(input.durationMs)}ms`
          : `${(input.durationMs / 1_000).toFixed(1)}s`;
      details.push(`${duration} elapsed`);
    }
    if (body.hidden > 0) details.push(`${body.shown} of ${body.total} lines`);
    return details.length ? details.join(" · ") : undefined;
  }
  const counts =
    body.hidden > 0 ? ` · ${body.shown} of ${body.total} lines` : "";
  if (input.role === "error") {
    return `${completionRing(0, 1, motion)} failed · see above${counts}`;
  }
  if (input.role === "thinking") {
    return `${cursorMarker(true, motion)}thinking ${idleBreath(motion)}${counts}`;
  }
  if (input.role === "usage") {
    // The meter measures shown against total body rows: how much of the
    // report survived the row budget, a real measurement, not decoration.
    const meterText = levelMeter(
      body.shown,
      Math.max(1, body.total),
      8,
      motion,
    );
    return `${meterText} ${body.shown} of ${body.total} lines`;
  }
  if (body.hidden === 0) return undefined;
  // A collapsed body without a status role still reports progress: the bar
  // fills with shown over total rows and the words state the same count.
  const progress = `${body.shown} of ${body.total} lines`;
  const barWidth = Math.max(1, width - visibleLength(progress) - 1);
  return `${animatedBar(body.shown, Math.max(1, body.total), barWidth, motion)} ${progress}`;
}

/** The whole block: heading, body, optional footer. */
export function renderBlock(
  input: BlockInput,
  options: BlockOptions,
  maxRows?: number,
): string[] {
  const width = Number.isFinite(options.width)
    ? Math.max(1, Math.floor(options.width))
    : 1;
  // Static detail frame by default, like the inspector: two renders of the
  // same block stay byte identical and tests can assert on footer output.
  const motion: MotionContext = options.motion ?? motionContext(0, false, true);
  const symbolPreset = options.symbolPreset ?? "unicode";
  const paint = options.paint;
  // Sanitising happens inside the builders while the text is still plain;
  // paint runs last here, never the other way round.
  const paintLine = (text: string, tone: BlockTone, bold?: boolean): string =>
    paint === undefined ? text : paint(text, tone, bold);
  const rows: string[] = [];
  const headingTone: BlockTone =
    input.tone ??
    (input.role === "tool" && input.status === "failed"
      ? "error"
      : input.role === "tool" && input.status === "running"
        ? "warning"
        : ROLE_TONES[input.role]);
  rows.push(
    paintLine(
      fit(blockHeading(input, width, symbolPreset), width),
      headingTone,
      true,
    ),
  );
  const all = wrapBody(input, width);
  const budget = maxRows === undefined ? all.length : maxRows;
  const body = collapseBody(all, budget, input.collapsible !== false, width);
  body.rows.forEach((row, index) => {
    const marker = body.hidden > 0 && index === body.rows.length - 1;
    rows.push(paintLine(fit(row, width), marker ? "muted" : "default"));
  });
  const footer = footerPlain(input, body, width, motion);
  if (footer !== undefined)
    rows.push(
      paintLine(
        fit(footer, width),
        input.role === "tool" && input.status === "failed"
          ? "error"
          : ROLE_TONES[input.role],
      ),
    );
  // A block always says something, even at width 1 with an empty body.
  if (rows.length === 0)
    rows.push(paintLine(fit("(empty block)", width), "muted"));
  return rows;
}

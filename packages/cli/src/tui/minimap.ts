/**
 * Conversation minimap – a vertical indicator on the right edge of the chat
 * pane showing the shape of the conversation. Each marker is one row high
 * and maps to a conversation event: user message, assistant message, tool call,
 * error, approval hold, usage, or gap. The current viewport is highlighted.
 *
 * This gives an operator an instant sense of where they are in a long
 * conversation without scrolling, and where the interesting events (tools,
 * errors, approvals) are clustered.
 */

import { sanitizeText, visibleLength } from "./layout.ts";
import { motionContext, type MotionContext } from "./motion.ts";
import type { TerminalCapabilities } from "./types.ts";

export type MinimapEventKind =
  | "user"
  | "assistant"
  | "tool"
  | "error"
  | "approval"
  | "usage"
  | "gap"
  | "unknown";

export interface MinimapEvent {
  readonly kind: MinimapEventKind;
  readonly seq: number;
  readonly label?: string;
}

/** One cell markers per event kind, all verified single-cell. */
const MINIMAP_GLYPHS: Record<MinimapEventKind, string> = {
  user: "▮",
  assistant: "▯",
  tool: "◆",
  error: "●",
  approval: "◉",
  usage: "▲",
  gap: "·",
  unknown: "?",
};

/** Colours per kind for the minimap. */
const MINIMAP_TONES: Record<MinimapEventKind, string> = {
  user: "accent",
  assistant: "muted",
  tool: "success",
  error: "error",
  approval: "warning",
  usage: "info",
  gap: "muted",
  unknown: "muted",
};

export interface MinimapOptions {
  readonly height: number;
  readonly motion?: MotionContext;
  readonly paint?: (text: string, tone: string, bold?: boolean) => string;
  readonly viewportStart?: number;
  readonly viewportEnd?: number;
  readonly totalEvents?: number;
  readonly capabilities?: TerminalCapabilities;
}

/**
 * Build minimap events from conversation events.
 * Filters out noise events, keeps only the ones that matter for navigation.
 */
export function buildMinimapEvents(
  events: readonly {
    kind?: unknown;
    type?: unknown;
    seq?: unknown;
    text?: unknown;
  }[],
): MinimapEvent[] {
  const out: MinimapEvent[] = [];
  let prevSeq = 0;
  for (const e of events) {
    const kind = String(e.kind ?? "unknown");
    const type = String(e.type ?? "");
    const seq = typeof e.seq === "number" ? e.seq : out.length;
    const isGap = prevSeq > 0 && seq - prevSeq > 1;
    if (isGap) {
      out.push({ kind: "gap", seq, label: `gap ${seq - prevSeq - 1}` });
    }
    let mapped: MinimapEventKind = "unknown";
    if (kind === "user") mapped = "user";
    else if (kind === "assistant") mapped = "assistant";
    else if (kind === "tool") mapped = "tool";
    else if (kind === "error") mapped = "error";
    else if (type.includes("approval") || kind === "approval")
      mapped = "approval";
    else if (kind === "usage") mapped = "usage";
    out.push({ kind: mapped, seq, label: String(e.text ?? "").slice(0, 20) });
    prevSeq = seq;
  }
  return out;
}

/**
 * Render the minimap as an array of strings, one per row of the viewport.
 * Returns exactly `height` rows.
 */
export function renderMinimap(
  events: readonly MinimapEvent[],
  options: MinimapOptions,
): string[] {
  const height = Math.max(1, options.height);
  const motion = options.motion ?? motionContext(0);
  const paint = options.paint ?? ((text: string) => text);
  const viewportStart = options.viewportStart ?? 0;
  const viewportEnd = options.viewportEnd ?? events.length;
  const total = options.totalEvents ?? events.length;

  const out: string[] = [];

  if (total === 0) {
    for (let i = 0; i < height; i++) out.push(paint("│", "muted"));
    return out;
  }

  // Map each viewport row to an event index
  for (let row = 0; row < height; row++) {
    const t =
      total > height ? (row + 0.5) / height : row / Math.max(1, height - 1);
    const eventIndex = Math.min(total - 1, Math.floor(t * total));
    const event = events[eventIndex];
    const inViewport = eventIndex >= viewportStart && eventIndex < viewportEnd;

    let glyph = MINIMAP_GLYPHS[event.kind] ?? "?";
    let tone = MINIMAP_TONES[event.kind] ?? "muted";

    // Highlight viewport position with a brighter variant
    if (inViewport) {
      glyph = "▸"; // viewport marker
      tone = "accent";
    }

    // For gap events, show as dots
    if (event.kind === "gap" && !inViewport) {
      glyph = "·";
    }

    out.push(paint(glyph, tone));
  }

  return out;
}

/**
 * Build a minimap summary string for the status bar.
 * E.g. "▮▯◆●▮▯▮▯▮ 12/47" showing the shape and position.
 */
export function minimapSummary(
  events: readonly MinimapEvent[],
  viewportStart: number,
  viewportEnd: number,
  width: number,
): string {
  if (events.length === 0) return "";
  const displayWidth = Math.max(8, Math.min(24, width - 4));
  const step = Math.max(1, Math.ceil(events.length / displayWidth));
  let out = "";
  for (let i = 0; i < events.length; i += step) {
    const e = events[i];
    const inViewport = i >= viewportStart && i < viewportEnd;
    const glyph = inViewport ? "▸" : (MINIMAP_GLYPHS[e.kind] ?? "?");
    out += glyph;
  }
  return `${out} ${viewportEnd}/${events.length}`;
}

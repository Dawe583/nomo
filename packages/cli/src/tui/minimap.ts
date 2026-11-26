/**
 * Conversation minimap: a one-cell vertical indicator at the edge of Chat.
 * Rows are positional, not a second transcript; glyphs and colour both change
 * so meaning never depends on colour alone.
 */

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

const MINIMAP_ASCII_GLYPHS: Record<MinimapEventKind, string> = {
  user: "#",
  assistant: "-",
  tool: "*",
  error: "x",
  approval: "!",
  usage: "^",
  gap: ".",
  unknown: "?",
};

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
  readonly paint?: (text: string, tone: string, bold?: boolean) => string;
  readonly viewportStart?: number;
  readonly viewportEnd?: number;
  readonly totalEvents?: number;
  readonly ascii?: boolean;
}

function glyphs(ascii = false): Record<MinimapEventKind, string> {
  return ascii ? MINIMAP_ASCII_GLYPHS : MINIMAP_GLYPHS;
}

/** Build minimap events from conversation events. */
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
  for (const event of events) {
    const kind = String(event.kind ?? "unknown");
    const type = String(event.type ?? "");
    const seq = typeof event.seq === "number" ? event.seq : out.length;
    if (prevSeq > 0 && seq - prevSeq > 1)
      out.push({ kind: "gap", seq, label: `gap ${seq - prevSeq - 1}` });
    const mapped: MinimapEventKind =
      kind === "user"
        ? "user"
        : kind === "assistant"
          ? "assistant"
          : type.includes("approval") || kind === "approval"
            ? "approval"
            : kind === "tool"
              ? "tool"
              : kind === "error"
                ? "error"
                : kind === "usage"
                  ? "usage"
                  : "unknown";
    out.push({ kind: mapped, seq, label: String(event.text ?? "").slice(0, 20) });
    prevSeq = seq;
  }
  return out;
}

/** Map rendered Chat rows onto minimap events, one event per visible row. */
export function minimapEventsFromRows(
  rows: readonly { readonly style?: string; readonly text?: string }[],
): MinimapEvent[] {
  return rows.map((row, seq) => {
    const style = row.style ?? "unknown";
    const kind: MinimapEventKind =
      style === "user"
        ? "user"
        : style === "role-error" || style === "error"
          ? "error"
          : style === "role-tool" ||
              style === "tool" ||
              style === "diff-add" ||
              style === "diff-remove" ||
              style === "diff-context"
            ? "tool"
            : style === "assistant" ||
                style === "heading" ||
                style === "code" ||
                style === "text" ||
                style === "quote" ||
                style === "reasoning"
              ? "assistant"
              : "unknown";
    return { kind, seq, label: row.text?.slice(0, 20) };
  });
}

/** Render exactly `height` one-cell minimap rows. */
export function renderMinimap(
  events: readonly MinimapEvent[],
  options: MinimapOptions,
): string[] {
  const height = Math.max(1, Math.floor(options.height));
  const paint = options.paint ?? ((text: string) => text);
  const viewportStart = options.viewportStart ?? 0;
  const viewportEnd = options.viewportEnd ?? events.length;
  const total = Math.max(0, options.totalEvents ?? events.length);
  const marks = glyphs(options.ascii === true);
  const viewportMark = options.ascii === true ? ">" : "▸";
  const track = options.ascii === true ? "|" : "│";
  if (total === 0)
    return Array.from({ length: height }, () => paint(track, "muted"));

  return Array.from({ length: height }, (_, row) => {
    const position =
      total > height ? (row + 0.5) / height : row / Math.max(1, height - 1);
    const eventIndex = Math.min(total - 1, Math.floor(position * total));
    const event = events[eventIndex];
    const inViewport = eventIndex >= viewportStart && eventIndex < viewportEnd;
    const kind = event?.kind ?? "unknown";
    const glyph = inViewport
      ? viewportMark
      : kind === "gap"
        ? marks.gap
        : (marks[kind] ?? marks.unknown);
    return paint(glyph, inViewport ? "accent" : (MINIMAP_TONES[kind] ?? "muted"));
  });
}

/** Build a compact positional summary for a status row. */
export function minimapSummary(
  events: readonly MinimapEvent[],
  viewportStart: number,
  viewportEnd: number,
  width: number,
  ascii = false,
): string {
  if (events.length === 0) return "";
  const marks = glyphs(ascii);
  const viewportMark = ascii ? ">" : "▸";
  const displayWidth = Math.max(8, Math.min(24, width - 4));
  const step = Math.max(1, Math.ceil(events.length / displayWidth));
  let out = "";
  for (let index = 0; index < events.length; index += step) {
    const event = events[index]!;
    const inViewport = index >= viewportStart && index < viewportEnd;
    out += inViewport ? viewportMark : (marks[event.kind] ?? marks.unknown);
  }
  return `${out} ${viewportEnd}/${events.length}`;
}

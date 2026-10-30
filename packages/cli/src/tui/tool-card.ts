import { fit, sanitizeText, visibleLength } from "./layout.ts";

export type ToolCardState = "requested" | "complete" | "error" | "unknown";

export interface ToolCardInput {
  readonly name: string;
  readonly state: ToolCardState;
  readonly body: string;
}

const STATE_LABEL: Record<ToolCardState, string> = {
  requested: "REQUESTED",
  complete: "COMPLETE",
  error: "ERROR",
  unknown: "UNKNOWN",
};

// Render safe event summaries; the arguments remain owned by the Workbench.
export function renderToolCard(
  input: ToolCardInput,
  width: number,
  compact = false,
): string[] {
  const safeWidth = Math.max(1, Math.floor(width));
  const name = sanitizeText(input.name);
  const body = input.body
    .split("\n")
    .map((line) => sanitizeText(line.replace(/\r$/, "")));
  const rows: string[] = [
    fit(`◆ TOOL ${STATE_LABEL[input.state]} / ${name}`, safeWidth),
  ];
  const limit = input.state === "error" || !compact ? body.length : 4;
  const bodyWidth = safeWidth - 2;
  for (const line of body.slice(0, limit)) {
    let part = "";
    for (const point of line) {
      if (part && visibleLength(part + point) > bodyWidth) {
        const breakAt = part.lastIndexOf(" ");
        const next = breakAt > 0 ? part.slice(breakAt + 1) : "";
        if (
          breakAt > 0 &&
          part.slice(0, breakAt).trim() &&
          visibleLength(next + point) <= bodyWidth
        ) {
          rows.push(fit(`  ${part.slice(0, breakAt).trimEnd()}`, safeWidth));
          part = next;
        } else {
          rows.push(fit(`  ${part}`, safeWidth));
          part = "";
        }
      }
      part += point;
    }
    rows.push(fit(`  ${part}`, safeWidth));
  }
  if (limit < body.length)
    rows.push(
      fit(`  ... ${body.length - limit} more lines /expand`, safeWidth),
    );
  return rows;
}

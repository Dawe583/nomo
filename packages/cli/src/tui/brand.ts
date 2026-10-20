import { fit, sanitizeText, visibleLength } from "./layout.ts";
import { paint } from "./theme.ts";
import type { TerminalCapabilities } from "./types.ts";

// The terminal mark keeps the aperture's open corners and nested center in five rows.
const MARK_ROWS = [
  "⌜       ⌝",
  "│  ┌─┐  │",
  "│  │·│  │",
  "│  └─┘  │",
  "⌞       ⌟",
] as const;

export function brandHeader(
  label: string,
  caps: TerminalCapabilities,
): string[] {
  const width = Math.max(0, caps.columns);
  const title = sanitizeText(label);
  const middle = `${MARK_ROWS[1]}${title ? `  ${title}` : ""}`;
  const offset = title
    ? Math.max(0, Math.floor((width - visibleLength(middle)) / 2))
    : 0;
  return MARK_ROWS.map((line, row) => {
    const content = row === 1 ? middle : line;
    const aligned = title ? " ".repeat(offset) + content : content;
    return fit(paint(aligned, "accent", caps, true), width);
  });
}

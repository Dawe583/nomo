import { fit, sanitizeText } from "./layout.ts";
import { paint } from "./theme.ts";
import type { TerminalCapabilities } from "./types.ts";

// The mark is the NOMO icon, gui-web/icon.svg, viewBox 0 0 64 64:
//
//   <rect x="14" y="14" width="36" height="36" stroke-width="5"/>   ink square
//   <rect x="24" y="24" width="16" height="16" stroke-width="4"/>   accent square
//   <circle cx="32" cy="32" r="3"/>                                  accent dot
//
// Rasterizing those coordinates directly does not work here. A cell spans
// about 3.4 units while a rule is 5 units thick, so whether a cell centre
// lands inside a rule depends on the phase of the grid: sampling the outer
// rule at cell centres misses the left and right edges by two tenths of a
// unit and drops them, which turns the square into two horizontal lines.
// Widening the band until every edge survives would instead smear the ring
// into the hollow centre.
//
// So the mark is drawn in terminal cells rather than sampled from the SVG.
// The design is unchanged: a square outline, a square outline inside it,
// and a dot in the middle. Only the resolution changes, and a cell grid is
// the resolution a terminal actually has. Half blocks carry the vertical
// resolution, so the grid is two rows of samples per character row.

const MARK_COLS = 13;
const MARK_ROWS = 7;
const MARK_HALF_ROWS = MARK_ROWS * 2;

const LAST_COL = MARK_COLS - 1;
const LAST_HALF_ROW = MARK_HALF_ROWS - 1;
/** Inset of the inner rule, in cells, from the outer rule. */
const INNER_INSET = 2;
const INNER_LOW_COL = INNER_INSET;
const INNER_HIGH_COL = LAST_COL - INNER_INSET;
const INNER_LOW_ROW = INNER_INSET * 2;
const INNER_HIGH_ROW = LAST_HALF_ROW - INNER_INSET * 2;
const DOT_COL = Math.floor(MARK_COLS / 2);

function sample(column: number, halfRow: number): "ink" | "accent" | undefined {
  // A horizontal rule fills both half rows of its cell, so the edge lands on
  // a cell boundary instead of drifting half a cell inside the mark. Both
  // rows of the top and bottom cell are ink, which is what a bold terminal
  // font draws for a rule anyway.
  const onOuterHorizontal =
    halfRow === 0 ||
    halfRow === 1 ||
    halfRow === LAST_HALF_ROW - 1 ||
    halfRow === LAST_HALF_ROW;
  const onOuterVertical = column === 0 || column === LAST_COL;
  if (onOuterHorizontal || onOuterVertical) return "ink";
  const inInnerColumn = column >= INNER_LOW_COL && column <= INNER_HIGH_COL;
  const inInnerRow = halfRow >= INNER_LOW_ROW && halfRow <= INNER_HIGH_ROW;
  const onInnerHorizontal =
    halfRow === INNER_LOW_ROW || halfRow === INNER_HIGH_ROW;
  const onInnerVertical = column === INNER_LOW_COL || column === INNER_HIGH_COL;
  // The inner rule stops at the outer rule instead of crossing it, so the
  // two squares read as separate shapes rather than one thick frame.
  if (inInnerColumn && inInnerRow && (onInnerHorizontal || onInnerVertical))
    return "accent";
  // The dot is two half rows tall so it fills one character cell.
  if (column === DOT_COL && (halfRow === DOT_COL || halfRow === DOT_COL + 1))
    return "accent";
  return undefined;
}

export function brandHeader(
  label: string,
  caps: TerminalCapabilities,
): string[] {
  return Array.from({ length: MARK_ROWS }, (_, row) => {
    let line = "";
    for (let column = 0; column < MARK_COLS; column++) {
      const top = sample(column, row * 2);
      const bottom = sample(column, row * 2 + 1);
      const glyph = top && bottom ? "█" : top ? "▀" : bottom ? "▄" : " ";
      line += paint(glyph, top ?? bottom ?? "ink", caps);
    }
    return fit(
      `${line}  ${row === 3 ? sanitizeText(label) : ""}`,
      caps.columns,
    );
  });
}

import { stripAnsi, visibleLength } from "./layout.ts";

export type MousePoint = Readonly<{ x: number; y: number }>;

/**
 * The geometry the renderer publishes for the frame it just drew. Every field
 * is optional: a frame without a rail keeps the full terminal width, and the
 * selection then behaves exactly as it did before the rail existed.
 */
export type MouseSelectionBounds = Readonly<{
  /** Visible transcript cells per row. The rail is painted right of them. */
  textWidth?: number;
  /** One-based column of the first rail cell, when a rail is painted. */
  railStart?: number;
  /** One-based first row of the rail band. */
  railTop?: number;
  /** Rows the rail band paints below `railTop`. */
  railRows?: number;
}>;

/**
 * True when a zero-based screen point lands on the rail. The rail carries
 * status, never conversation text, so a click there must not open a selection:
 * the highlight would repaint a column the transcript never owned.
 */
export function railOwnsPoint(
  bounds: MouseSelectionBounds,
  point: MousePoint,
): boolean {
  const { railStart, railTop, railRows } = bounds;
  if (railStart === undefined || railTop === undefined) return false;
  if (!railRows || railRows < 1) return false;
  // SGR mouse reports are one-based; `point` is zero-based.
  const column = point.x + 1;
  const row = point.y + 1;
  return column >= railStart && row >= railTop && row < railTop + railRows;
}

/**
 * The widest selectable cell count. The transcript pane starts after the
 * panel margin, so the rail column is also the exclusive end of everything a
 * selection may cover.
 */
export function mouseSelectionLimit(
  columns: number,
  bounds: MouseSelectionBounds,
): number {
  const width = Math.max(1, Math.floor(columns));
  const { railStart } = bounds;
  if (railStart === undefined) return width;
  return Math.max(1, Math.min(width, railStart - 1));
}

function clampX(point: MousePoint, width: number): MousePoint {
  return {
    x: Math.min(Math.max(0, point.x), Math.max(0, width - 1)),
    y: point.y,
  };
}

function ordered(anchor: MousePoint, focus: MousePoint) {
  return anchor.y < focus.y || (anchor.y === focus.y && anchor.x <= focus.x)
    ? { start: anchor, end: focus }
    : { start: focus, end: anchor };
}

function rowRange(
  row: number,
  start: MousePoint,
  end: MousePoint,
  width: number,
): readonly [number, number] | undefined {
  if (row < start.y || row > end.y) return undefined;
  return [row === start.y ? start.x : 0, row === end.y ? end.x : width - 1];
}

function paintSelectedRow(line: string, from: number, to: number): string {
  const parts = line.split(/(\x1b\[[0-9;]*m)/g);
  let column = 0;
  return parts
    .map((part) => {
      if (part.startsWith("\x1b[")) return part;
      let painted = "";
      const points = [...part];
      for (let index = 0; index < points.length; index += 1) {
        let cluster = points[index]!;
        const cells = visibleLength(cluster);
        while (
          index + 1 < points.length &&
          visibleLength(points[index + 1]!) === 0
        )
          cluster += points[++index]!;
        const selected =
          cells === 0
            ? column > 0 && column - 1 >= from && column - 1 <= to
            : column <= to && column + cells - 1 >= from;
        painted += selected ? `\x1b[7m${cluster}\x1b[27m` : cluster;
        column += cells;
      }
      return painted;
    })
    .join("");
}

/** Apply a visible reverse-video selection to an ANSI-rendered terminal frame. */
export function highlightMouseSelection(
  frame: string,
  anchor: MousePoint,
  focus: MousePoint,
  columns: number,
  limit = columns,
): string {
  const width = Math.max(1, Math.floor(limit));
  const { start, end } = ordered(clampX(anchor, width), clampX(focus, width));
  return frame
    .split("\n")
    .map((line, y) => {
      const range = rowRange(y, start, end, width);
      return range ? paintSelectedRow(line, range[0], range[1]) : line;
    })
    .join("\n");
}

/** Extract selected visible cells and drop renderer colors. */
export function selectedMouseText(
  frame: string,
  anchor: MousePoint,
  focus: MousePoint,
  columns: number,
  limit = columns,
): string {
  const width = Math.max(1, Math.floor(limit));
  const { start, end } = ordered(clampX(anchor, width), clampX(focus, width));
  const lines = frame.split("\n");
  const selected: string[] = [];
  for (let y = start.y; y <= end.y && y < lines.length; y += 1) {
    const range = rowRange(y, start, end, width);
    if (!range) continue;
    let column = 0;
    let text = "";
    for (const point of stripAnsi(lines[y]!)) {
      const cells = visibleLength(point);
      const selected =
        cells === 0
          ? column > 0 && column - 1 >= range[0] && column - 1 <= range[1]
          : column <= range[1] && column + cells - 1 >= range[0];
      if (selected) text += point;
      column += cells;
    }
    selected.push(text);
  }
  return selected.join("\n");
}

import { fit, sanitizeText, stripAnsi } from "./layout.ts";
import {
  TODO_MAX_ITEMS,
  TODO_MAX_TEXT,
  type TodoStatus,
} from "../../../workbench/src/todo-tool.ts";

/** The state the `todo_write` tool records for a row, re-exported so callers
 * read the renderer's vocabulary from one place. */
export type { TodoStatus };

// The checklist rail and its compact chips.
//
// Two sources feed this module, and they are not equal. A `todo.updated` event
// carries the model's own structured checklist, so a row, its state and its
// count are read from a record rather than inferred. An older conversation may
// have no such event, so a task list the assistant wrote in a real message is
// still accepted as a fallback. Nothing here may invent an item, a state or a
// count: an absent checklist renders nothing rather than a zero that reads
// like a measurement.

/** A checklist item read from a structured event or a real assistant message. */
export interface TodoItem {
  readonly done: boolean;
  readonly text: string;
  /** Present only for a structured row; markdown carries no state but done. */
  readonly status?: TodoStatus;
}

const TODO_STATUSES: readonly TodoStatus[] = [
  "pending",
  "in_progress",
  "completed",
];

/**
 * The rows a `todo.updated` event carries, or undefined when the payload is
 * not one this renderer understands.
 *
 * Fail closed: one malformed row rejects the whole event rather than printing
 * the rest as if the checklist were complete. The event is produced by the
 * Workbench tool, so a payload that does not match is a contract break, not a
 * display problem, and the markdown fallback is the honest answer to it.
 */
export function todoItemsFromEventPayload(
  payload: unknown,
): readonly TodoItem[] | undefined {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload))
    return undefined;
  const items = (payload as { items?: unknown }).items;
  if (!Array.isArray(items) || items.length === 0 || items.length > TODO_MAX_ITEMS)
    return undefined;
  const out: TodoItem[] = [];
  for (const item of items) {
    if (typeof item !== "object" || item === null || Array.isArray(item))
      return undefined;
    const keys = Object.keys(item);
    if (keys.some((key) => key !== "text" && key !== "status")) return undefined;
    const { text, status } = item as { text?: unknown; status?: unknown };
    if (typeof text !== "string" || typeof status !== "string") return undefined;
    if (!TODO_STATUSES.includes(status as TodoStatus)) return undefined;
    if (/[\x00-\x1f\x7f-\x9f]/.test(text)) return undefined;
    const clean = text.trim();
    if (!clean || clean.length > TODO_MAX_TEXT) return undefined;
    out.push({
      done: status === "completed",
      text: clean,
      status: status as TodoStatus,
    });
  }
  return out;
}

/** The rail needs a wide, tall Chat; below this it collapses to a chip. */
export const CHAT_RAIL_MIN_WIDTH = 100;
export const CHAT_RAIL_MIN_HEIGHT = 20;
/** Below this width the chip keeps only the count, never the heading word. */
export const TODO_CHIP_MIN_WIDTH = 72;
/**
 * The widest gauge the rail draws beside the heading.
 *
 * A longer bar would read as a ruler and would push the count away from the
 * heading; the count is the measurement, the bar is the shape of it.
 */
export const TODO_BAR_MAX = 10;
/** Below this many cells a gauge is noise, so the heading keeps the count. */
const TODO_BAR_MIN = 4;

export interface TodoProgress {
  readonly done: number;
  readonly total: number;
}

/** Done and total counts, or undefined when the conversation has no checklist. */
export function todoProgress(
  todos: readonly TodoItem[],
): TodoProgress | undefined {
  if (todos.length === 0) return undefined;
  return {
    done: todos.filter((item) => item.done).length,
    total: todos.length,
  };
}

/**
 * A progress gauge: filled `━`, the head `╸` where the work currently stands,
 * and empty `─`.
 *
 * The glyphs are single cell box drawing, so the gauge keeps its shape on a
 * monochrome terminal and cannot misalign the row. A finished checklist has no
 * head, because there is nowhere left to move; an untouched one has no head
 * either, because nothing has started.
 */
export function todoProgressBar(
  done: number,
  total: number,
  width: number,
): string {
  const cells = Number.isFinite(width) ? Math.max(0, Math.floor(width)) : 0;
  const count = Number.isFinite(total) ? Math.max(0, Math.floor(total)) : 0;
  if (cells <= 0 || count <= 0) return "";
  const safeDone = Number.isFinite(done)
    ? Math.min(count, Math.max(0, Math.floor(done)))
    : 0;
  if (safeDone >= count) return "━".repeat(cells);
  // The head always needs one cell of its own, so the fill can never reach the
  // last column while work remains.
  const filled = Math.min(
    cells - 1,
    Math.max(0, Math.round((safeDone / count) * cells)),
  );
  if (filled <= 0) return "─".repeat(cells);
  return `${"━".repeat(filled)}╸${"─".repeat(cells - filled - 1)}`;
}

/**
 * The one-row chip for the existing activity row.
 *
 * `full` is the readable form used where the row has space; `count` is the
 * same measurement without the heading word, for a forty column terminal.
 */
export function todoChip(
  todos: readonly TodoItem[],
  variant: "full" | "count" = "full",
): string {
  const progress = todoProgress(todos);
  if (!progress) return "";
  return variant === "full"
    ? `TODO ${progress.done}/${progress.total}`
    : `${progress.done}/${progress.total}`;
}

/**
 * The row the model marked `in_progress`, if it marked one.
 *
 * This is the only source of the live marker. A pending row is not active
 * because a child session happens to share its title, and a row is never
 * active because time passed: the status is a statement the model made, and
 * nothing in this module may promote a row the model did not promote.
 */
export function todoActiveItem(
  todos: readonly TodoItem[],
): string | undefined {
  return todos.find((item) => item.status === "in_progress")?.text;
}

export interface TodoRailOptions {
  /** The live marker to print on the in-progress row, for example runningIndicator(). */
  readonly indicator?: string;
}

function railHeadingRow(progress: TodoProgress, width: number): string {
  const heading = `TODO ${progress.done}/${progress.total}`;
  const room = width - heading.length - 1;
  if (room < TODO_BAR_MIN) return fit(heading, width);
  const gauge = todoProgressBar(
    progress.done,
    progress.total,
    Math.min(TODO_BAR_MAX, room),
  );
  return fit(`${heading} ${gauge}`, width);
}

function railItemRow(
  item: TodoItem,
  width: number,
  options: TodoRailOptions | undefined,
): string {
  const text = sanitizeText(stripAnsi(item.text)).replace(/\s+/g, " ").trim();
  // The check mark names the finished state again in a glyph that survives
  // without colour, and the live marker is printed only for a row the model
  // itself marked in progress. Neither carries a duration: no per-item timing
  // is recorded anywhere, so none is shown.
  if (item.done) return fit(`[x] ✓ ${text}`, width);
  if (item.status === "in_progress") {
    const indicator = options?.indicator ?? "";
    return fit(
      indicator ? `[ ] ${indicator} ${text}` : `[~] ${text}`,
      width,
    );
  }
  return fit(`[ ] ${text}`, width);
}

/**
 * The fixed-width TODO block: heading with its gauge, item rows, then an
 * explicit count of the items the row budget hid.
 */
export function todoRailLines(
  todos: readonly TodoItem[],
  width: number,
  maximumRows: number,
  options?: TodoRailOptions,
): string[] {
  const safeWidth = Number.isFinite(width) ? Math.max(1, Math.floor(width)) : 1;
  const budget = Number.isFinite(maximumRows)
    ? Math.max(0, Math.floor(maximumRows))
    : 0;
  const progress = todoProgress(todos);
  if (!progress || budget < 1) return [];
  const rows = [railHeadingRow(progress, safeWidth)];
  const itemBudget = budget - 1;
  if (itemBudget < 1) return rows;
  if (todos.length <= itemBudget) {
    rows.push(...todos.map((item) => railItemRow(item, safeWidth, options)));
    return rows;
  }
  // One row is spent naming what did not fit, so a cut rail can never pass as
  // a complete one.
  const shown = Math.max(0, itemBudget - 1);
  rows.push(
    ...todos
      .slice(0, shown)
      .map((item) => railItemRow(item, safeWidth, options)),
  );
  rows.push(fit(`+${todos.length - shown} more`, safeWidth));
  return rows;
}

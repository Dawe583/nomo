import { fit, sanitizeText, stripAnsi } from "./layout.ts";

// The subagent rail.
//
// The only facts available about a child are the session fields the Workbench
// actually stores: its title, model, status and its creation and update
// timestamps, plus the tool events in its own transcript. Workbench.list()
// returns child views with `events: []`, so the caller reads the child's own
// view and passes the derived activity down. This module never invents a
// heartbeat or a progress percentage for a child that reports neither.

/** The state a child's latest recorded tool event proves. */
export type SubagentActivityState = "running" | "completed" | "failed";

/** The child session fields the rail reads, as Workbench.list() returns them. */
export interface SubagentSession {
  readonly id: string;
  readonly title?: string;
  readonly model?: string;
  readonly status?: string;
  readonly createdAt?: string;
  readonly updatedAt?: string;
  /**
   * The child's last recorded event type, when the source exposes one.
   *
   * The live TUI fills this from the child's own view (`tool.started` or
   * `tool.result`). It is optional rather than derived because a rail that
   * guessed at a child's current tool from the parent's events would be
   * reporting work it cannot see.
   */
  readonly lastEventType?: string;
  /** The child's last recorded tool name, under the same rule as above. */
  readonly lastTool?: string;
  /** The recorded target of that call: a path or a command, never a guess. */
  readonly lastTarget?: string;
  /** The state the child's own event proves, when the type alone is not enough. */
  readonly lastState?: SubagentActivityState;
}

/** The glyph for each activity state, matching the transcript's own markers. */
const SUBAGENT_ACTIVITY_GLYPHS: Readonly<Record<SubagentActivityState, string>> =
  {
    running: "⠋",
    completed: "✓",
    failed: "✗",
  };

/**
 * The activity state a child proves, or undefined when it proves none.
 *
 * A started event with no result yet is running; a result is completed unless
 * the recorded payload says it failed. A tool name with no event type is not
 * enough, because the state would then be a guess.
 */
export function subagentActivityState(
  entry: SubagentSession,
): SubagentActivityState | undefined {
  const stated = entry.lastState;
  if (
    stated === "running" ||
    stated === "completed" ||
    stated === "failed"
  )
    return stated;
  const type = (entry.lastEventType ?? "").trim().toLowerCase();
  if (type === "tool.started") return "running";
  if (type === "tool.result") return "completed";
  return undefined;
}

/**
 * One activity line, only when the child's transcript proves both a tool and
 * its state. The target is printed only when the recorded arguments carry one.
 */
export function subagentActivityLine(
  entry: SubagentSession,
  width: number,
): string | undefined {
  const tool = sanitizeText(stripAnsi(entry.lastTool ?? "")).trim();
  const state = subagentActivityState(entry);
  if (tool === "" || state === undefined) return undefined;
  const target = sanitizeText(stripAnsi(entry.lastTarget ?? ""))
    .split("\n", 1)[0]!
    .trim();
  const safeWidth = Number.isFinite(width) ? Math.max(1, Math.floor(width)) : 1;
  return fit(
    `  ${SUBAGENT_ACTIVITY_GLYPHS[state]} ${tool}${target === "" ? "" : ` ${target}`}`,
    safeWidth,
  );
}

/**
 * The rows one child card costs: title, state, and the activity line when the
 * child really reports one. The caller budgets with this so a card never
 * claims rows it will not print.
 */
export function subagentCardRows(entry: SubagentSession): number {
  return subagentActivityLine(entry, 1) === undefined ? 2 : 3;
}

/**
 * The word the rail prints for a child state.
 *
 * Running keeps its own word. A child that is neither running nor failed has
 * finished, and Workbench keeps "idle" as the status of a settled run, so that
 * reads as done. Failure and cancellation keep their own words rather than
 * being folded into done, because "done" over a failed child would be a lie.
 */
export function subagentStateWord(status: string | undefined): string {
  const key = (status ?? "").toLowerCase();
  if (key === "running") return "running";
  if (key === "queued") return "queued";
  if (key === "paused") return "paused";
  if (key === "stopping") return "stopping";
  if (key === "failed" || key === "error") return "failed";
  if (key === "cancelled" || key === "canceled") return "cancelled";
  return "done";
}

/**
 * Elapsed seconds measured from the child's own timestamps.
 *
 * A running child measures to the supplied clock; a finished one measures to
 * its last recorded update. Missing or unreadable timestamps yield undefined,
 * and the rail then prints the state without a duration rather than a number
 * it would have had to guess.
 */
export function subagentDurationSeconds(
  entry: SubagentSession,
  now?: number,
): number | undefined {
  const startedAt = entry.createdAt ? Date.parse(entry.createdAt) : NaN;
  if (!Number.isFinite(startedAt)) return undefined;
  const running = subagentStateWord(entry.status) === "running";
  const endedAt = running
    ? now
    : entry.updatedAt
      ? Date.parse(entry.updatedAt)
      : NaN;
  if (endedAt === undefined || !Number.isFinite(endedAt)) return undefined;
  if (endedAt < startedAt) return undefined;
  return Math.floor((endedAt - startedAt) / 1_000);
}

export function formatSubagentDuration(seconds: number): string {
  const safe = Math.max(0, Math.floor(seconds));
  if (safe < 60) return `${safe}s`;
  const minutes = Math.floor(safe / 60);
  const rest = safe % 60;
  return rest === 0 ? `${minutes}m` : `${minutes}m ${rest}s`;
}

function subagentTitleRow(entry: SubagentSession, width: number): string {
  const title = sanitizeText(stripAnsi(entry.title ?? "")).trim();
  const model = sanitizeText(stripAnsi(entry.model ?? "")).trim();
  const name = title === "" ? entry.id.slice(0, 8) : title;
  return fit(`▸ ${name}${model === "" ? "" : ` · ${model}`}`, width);
}

function subagentStateRow(
  entry: SubagentSession,
  width: number,
  now: number | undefined,
): string {
  const seconds = subagentDurationSeconds(entry, now);
  const state = subagentStateWord(entry.status);
  // The duration beside the state is measured from the child's own
  // timestamps, never from the parent's clock. The tool itself rides its own
  // row, so the state row keeps one shape whether or not the child reports
  // activity.
  return fit(
    `  ${state}${seconds === undefined ? "" : ` · ${formatSubagentDuration(seconds)}`}`,
    width,
  );
}

/** The title, state and (when proven) activity rows of one child card. */
function subagentCard(
  entry: SubagentSession,
  width: number,
  now: number | undefined,
): string[] {
  const rows = [
    subagentTitleRow(entry, width),
    subagentStateRow(entry, width, now),
  ];
  const activity = subagentActivityLine(entry, width);
  if (activity !== undefined) rows.push(activity);
  return rows;
}

/**
 * The fixed-width SUBAGENTS block: heading, then one card per real child, then
 * an explicit count of the children the budget hid.
 *
 * A card always keeps its title and state together. The activity row is the
 * part that gives way first, so a compact body prints the same card as before
 * and a tall one adds the tool line the child's transcript proves.
 */
export function subagentRailLines(
  entries: readonly SubagentSession[],
  width: number,
  maximumRows: number,
  now?: number,
): string[] {
  const safeWidth = Number.isFinite(width) ? Math.max(1, Math.floor(width)) : 1;
  const budget = Number.isFinite(maximumRows)
    ? Math.max(0, Math.floor(maximumRows))
    : 0;
  if (entries.length === 0 || budget < 1) return [];
  const rows = [fit(`SUBAGENTS ${entries.length}`, safeWidth)];
  const entryBudget = budget - 1;
  if (entryBudget < 1) return rows;
  const cards = entries.map((entry) => subagentCard(entry, safeWidth, now));
  const full = cards.reduce((sum, card) => sum + card.length, 0);
  if (full <= entryBudget) {
    for (const card of cards) rows.push(...card);
    return rows;
  }
  // Every card reaches its title and state before any card gains an activity
  // row, so the block never spends a row on a tool line while another child
  // is still unlisted.
  const base = entries.length * 2;
  if (base <= entryBudget) {
    let extra = entryBudget - base;
    cards.forEach((card) => {
      rows.push(card[0]!, card[1]!);
      if (card.length === 3 && extra > 0) {
        rows.push(card[2]!);
        extra -= 1;
      }
    });
    return rows;
  }
  // Not every child fits: one row is reserved for the explicit hidden count,
  // and a card is never cut between its title and its state.
  const room = Math.max(0, entryBudget - 1);
  let used = 0;
  let shown = 0;
  for (const card of cards) {
    if (used + 2 > room) break;
    rows.push(card[0]!, card[1]!);
    used += 2;
    if (card.length === 3 && used < room) {
      rows.push(card[2]!);
      used += 1;
    }
    shown += 1;
  }
  rows.push(fit(`+${entries.length - shown} more`, safeWidth));
  return rows;
}

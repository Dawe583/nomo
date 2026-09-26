import type { Row } from "./api";
import { runState } from "./workspace-state.ts";

/** States in which the run can still send more streamed text. `stopping` is
 * deliberately absent: the model has stopped and an already-issued tool may
 * finish, so no further deltas are coming and the text will never be
 * completed. */
const STILL_STREAMING: Record<string, true> = {
  running: true,
  queued: true,
  "awaiting-approval": true,
  paused: true,
};

/** The transcript has to tell a settled message from one that is still
 * arriving. Three server events settle streamed text:
 *
 *   - `message.completed` carries the authoritative message,
 *   - `run.error` says the run failed instead of completing,
 *   - a `run.status` whose state no longer accepts input says the run will
 *     not complete it either, which is what a stop, a cancel and the end of a
 *     truncated history all look like.
 *
 * A `run.status` the client cannot read stays open on purpose: an unknown
 * state is not evidence that the message finished. Nothing here invents
 * progress the server did not report. */
export type StreamPhase = {
  readonly streaming: boolean;
  readonly seq: string | null;
  readonly at: string | null;
};

export function streamPhase(source: readonly Row[]): StreamPhase {
  let open: { seq: string; at: string } | null = null;
  for (const event of source) {
    if (event.type === "message.delta") {
      open = { seq: String(event.seq ?? ""), at: String(event.at ?? "") };
      continue;
    }
    if (event.type === "message.completed" || event.type === "run.error") {
      open = null;
      continue;
    }
    if (event.type === "run.status" && !runStillStreams(event.payload?.status)) {
      open = null;
    }
  }
  return open
    ? { streaming: true, seq: open.seq, at: open.at }
    : { streaming: false, seq: null, at: null };
}

/** An unreadable state is not evidence that the message finished, so it keeps
 * the run open. Only a state the client understands can settle the text. */
function runStillStreams(status: unknown): boolean {
  const state = runState({ status } as Record<string, unknown>);
  if (state === "unknown") return true;
  return STILL_STREAMING[state] === true;
}

export type ToolTiming = {
  readonly callId: string;
  readonly startedAt: number | null;
  readonly endedAt: number | null;
};

/** Tool calls are merged by call id, so a duration can only come from the raw
 * event stream: the first `tool.started` and the matching `tool.result`. A
 * missing or unparseable timestamp stays null rather than becoming a zero. */
export function toolTimings(
  source: readonly Row[],
): ReadonlyMap<string, ToolTiming> {
  const timings = new Map<string, ToolTiming>();
  for (const event of source) {
    if (event.type !== "tool.started" && event.type !== "tool.result") continue;
    const callId = event.payload?.callId;
    if (typeof callId !== "string" || !callId) continue;
    const at = Date.parse(String(event.at ?? ""));
    const stamp = Number.isFinite(at) ? at : null;
    const prior = timings.get(callId);
    timings.set(
      callId,
      prior
        ? { ...prior, endedAt: stamp }
        : { callId, startedAt: stamp, endedAt: null },
    );
  }
  return timings;
}

export function toolDuration(timing: ToolTiming | undefined): number | null {
  if (!timing || timing.startedAt === null || timing.endedAt === null) {
    return null;
  }
  return Math.max(0, timing.endedAt - timing.startedAt);
}

/** A duration is only worth showing once it passes a second. Below that the
 * number is noise, so the card omits it instead of printing a rounded zero. */
export function formatDuration(ms: number | null): string | null {
  if (ms === null || ms < 1000) return null;
  if (ms >= 60000) {
    return (
      Math.floor(ms / 60000) + " min " + Math.round((ms % 60000) / 1000) + " s"
    );
  }
  return (ms < 10000 ? (ms / 1000).toFixed(1) : String(Math.round(ms / 1000))) + " s";
}

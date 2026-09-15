import type { Json } from "../../../connectors/src/recovery.ts";
import type { RecoveryJobEvent } from "../journal.ts";
import type { RecoveryJobPlan, RecoveryJobResult } from "./plan.ts";

export type RecoveryJobProgress = Pick<
  RecoveryJobResult,
  "checkpoint" | "outcomes" | "residuals"
>;

export function jobPlan(
  events: readonly RecoveryJobEvent[],
  jobId: string,
): RecoveryJobPlan | undefined {
  const event = events.find(
    (candidate) => candidate.jobId === jobId && candidate.stage === "planned",
  );
  if (
    !event ||
    typeof event.data !== "object" ||
    event.data === null ||
    Array.isArray(event.data)
  )
    return undefined;
  return event.data.plan as unknown as RecoveryJobPlan;
}

export function latestJobEvent(
  events: readonly RecoveryJobEvent[],
  jobId: string,
): RecoveryJobEvent | undefined {
  return [...events].reverse().find((event) => event.jobId === jobId);
}

export function progressFrom(
  event: RecoveryJobEvent | undefined,
  plan: RecoveryJobPlan,
): RecoveryJobProgress {
  if (
    !event ||
    typeof event.data !== "object" ||
    event.data === null ||
    Array.isArray(event.data)
  )
    return { checkpoint: 0, outcomes: [], residuals: plan.residuals };
  const value = event.data as Record<string, Json>;
  return {
    checkpoint: typeof value.checkpoint === "number" ? value.checkpoint : 0,
    outcomes: Array.isArray(value.outcomes)
      ? (value.outcomes as unknown as RecoveryJobProgress["outcomes"])
      : [],
    residuals: Array.isArray(value.residuals)
      ? (value.residuals as unknown as RecoveryJobProgress["residuals"])
      : plan.residuals,
  };
}

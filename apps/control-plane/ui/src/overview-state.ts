import type { Row } from "./api.ts";

export type OverviewState = {
  readonly tone: "attention" | "active" | "clear" | "unknown";
  readonly count: number | undefined;
  readonly kind: "decisions" | "failures" | "running" | "clear" | "unknown";
  /**
   * Fleet view fields (plan Task 7): one registered agent's current run, the
   * stop acknowledgement of this process, and in-flight calls whose result is
   * not confirmed yet. In flight reads as unknown on purpose, a killed local
   * process cannot prove what an already dispatched call did.
   */
  readonly agentId: string | undefined;
  readonly runState: string | undefined;
  readonly stopAck: "pending" | "acknowledged" | "unknown";
  readonly inFlight: number | undefined;
};

const wholeCount = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isInteger(value) && value >= 0
    ? value
    : undefined;

const oneLine = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim().length > 0 ? value : undefined;

const ackState = (value: unknown): "pending" | "acknowledged" | "unknown" =>
  value === "pending" || value === "acknowledged" ? value : "unknown";

export function overviewState(data: Row | undefined): OverviewState {
  const decisions = wholeCount(data?.pendingApprovals);
  const failures = wholeCount(data?.failed);
  const running = wholeCount(data?.running);
  const inFlight = wholeCount(data?.inFlight);
  const base = {
    agentId: oneLine(data?.agentId),
    runState: oneLine(data?.runState),
    stopAck: ackState(data?.stopAck),
    inFlight,
  };
  if (decisions !== undefined && decisions > 0)
    return { tone: "attention", count: decisions, kind: "decisions", ...base };
  if (failures !== undefined && failures > 0)
    return { tone: "attention", count: failures, kind: "failures", ...base };
  if (running !== undefined && running > 0)
    return { tone: "active", count: running, kind: "running", ...base };
  if (decisions === 0 && failures === 0 && running === 0)
    return { tone: "clear", count: 0, kind: "clear", ...base };
  return { tone: "unknown", count: undefined, kind: "unknown", ...base };
}

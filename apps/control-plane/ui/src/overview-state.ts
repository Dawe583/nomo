import type { Row } from "./api.ts";

export type OverviewState = {
  readonly tone: "attention" | "active" | "clear" | "unknown";
  readonly count: number | undefined;
  readonly kind: "decisions" | "failures" | "running" | "clear" | "unknown";
};

const wholeCount = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isInteger(value) && value >= 0
    ? value
    : undefined;

export function overviewState(data: Row | undefined): OverviewState {
  const decisions = wholeCount(data?.pendingApprovals);
  const failures = wholeCount(data?.failed);
  const running = wholeCount(data?.running);
  if (decisions !== undefined && decisions > 0)
    return { tone: "attention", count: decisions, kind: "decisions" };
  if (failures !== undefined && failures > 0)
    return { tone: "attention", count: failures, kind: "failures" };
  if (running !== undefined && running > 0)
    return { tone: "active", count: running, kind: "running" };
  if (decisions === 0 && failures === 0 && running === 0)
    return { tone: "clear", count: 0, kind: "clear" };
  return { tone: "unknown", count: undefined, kind: "unknown" };
}

type StateRecord = Record<string, unknown> | undefined;
export const RUN_STATES = [
  "idle",
  "running",
  "awaiting-approval",
  "stopping",
  "stopped",
  "failed",
  "unknown",
  "paused",
] as const;
export type RunState = (typeof RUN_STATES)[number];
export type ProviderStatus =
  "ready" | "setup-required" | "rate-limited" | "unavailable";

export function providerStatus(provider: StateRecord): ProviderStatus {
  const status = provider?.status;
  if (
    status === "ready" ||
    status === "setup-required" ||
    status === "rate-limited" ||
    status === "unavailable"
  )
    return status;
  if (provider?.setupRequired === true) return "setup-required";
  return provider?.connected === true ? "ready" : "unavailable";
}

export function runState(run: StateRecord): RunState {
  if (run?.reconcileRequired === true) return "unknown";
  if (RUN_STATES.includes(run?.state as RunState))
    return run!.state as RunState;
  const legacy: Record<string, RunState> = {
    queued: "paused",
    cancelling: "stopping",
    cancelled: "stopped",
    completed: "idle",
  };
  const status = String(run?.status ?? "unknown");
  return RUN_STATES.includes(status as RunState)
    ? (status as RunState)
    : (legacy[status] ?? "unknown");
}

export function runCanStop(run: StateRecord): boolean {
  const state = runState(run);
  return (
    state === "running" ||
    state === "awaiting-approval" ||
    (state === "paused" && run?.status === "queued")
  );
}

export function runBlocksInput(run: StateRecord): boolean {
  return (
    !!run &&
    ["running", "awaiting-approval", "stopping", "unknown", "paused"].includes(
      runState(run),
    )
  );
}

export type CompactionResult = {
  summary: string;
  retainedMessageIds: string[];
  omittedMessageCount: number;
  createdAt: string;
};
export function compactionResult(
  response: Record<string, unknown>,
): CompactionResult | null {
  const value = response.compaction ?? response.session ?? response;
  if (!value || typeof value !== "object") return null;
  const result = value as Record<string, unknown>;
  return typeof result.summary === "string" &&
    Array.isArray(result.retainedMessageIds) &&
    result.retainedMessageIds.every((id) => typeof id === "string") &&
    Number.isInteger(result.omittedMessageCount) &&
    Number(result.omittedMessageCount) >= 0 &&
    typeof result.createdAt === "string" &&
    Number.isFinite(Date.parse(result.createdAt))
    ? (result as CompactionResult)
    : null;
}

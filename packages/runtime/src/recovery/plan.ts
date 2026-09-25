import { canonicalJson } from "../../../ledger/src/canonical.ts";
import { digest } from "../digest.ts";
import type { RecoveryPlan } from "../execute.ts";

export type RecoverySelection =
  | { kind: "run"; runId: string }
  | { kind: "operations"; operationIds: readonly string[] };
export type RecoveryBoundary = { sequence: number; digest: string };
export type RecoveryResidualStatus =
  | "missing"
  | "not-successful"
  | "already-recovered"
  | "unsupported"
  | "unavailable"
  | "compensated"
  | "conflict"
  | "unknown"
  | "blocked-by-conflict";
export type RecoveryResidual = {
  operationId: string;
  status: RecoveryResidualStatus;
};
export type RecoveryJobStep = {
  operationId: string;
  sequence: number;
  plan: RecoveryPlan;
};
export type RecoveryJobPlan = {
  schema: "void.recovery-plan.v1";
  workspace: string;
  jobId: string;
  selection: RecoverySelection;
  boundary: RecoveryBoundary;
  steps: readonly RecoveryJobStep[];
  residuals: readonly RecoveryResidual[];
  digest: string;
};
export type RecoveryJobStepOutcome = {
  operationId: string;
  status: "restored" | "compensated";
};
export type RecoveryJobResult = {
  jobId: string;
  status: "restored" | "partial" | "conflict" | "unknown" | "paused";
  checkpoint: number;
  outcomes: readonly RecoveryJobStepOutcome[];
  residuals: readonly RecoveryResidual[];
  pause?: { code: "step-unavailable"; operationId: string };
};
export type RecoveryJobRequest = {
  workspace: string;
  jobId: string;
  selection: RecoverySelection;
};

export function completeRecoveryJobPlan(
  value: Omit<RecoveryJobPlan, "digest">,
): RecoveryJobPlan {
  const stable = JSON.parse(canonicalJson(value)) as Omit<
    RecoveryJobPlan,
    "digest"
  >;
  return { ...stable, digest: digest(stable) };
}

const residualStatuses = new Set<RecoveryResidualStatus>([
  "missing",
  "not-successful",
  "already-recovered",
  "unsupported",
  "unavailable",
  "compensated",
  "conflict",
  "unknown",
  "blocked-by-conflict",
]);

function object(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error(`Invalid recovery job ${name}.`);
  return value as Record<string, unknown>;
}
function exactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
  name: string,
): void {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index])
  )
    throw new Error(`Invalid recovery job ${name}.`);
}
function identity(value: unknown): value is string {
  return typeof value === "string" && /^[\w-]{1,120}$/.test(value);
}
function validResiduals(value: unknown): value is RecoveryResidual[] {
  if (!Array.isArray(value)) return false;
  const seen = new Set<string>();
  return value.every((candidate) => {
    const item = object(candidate, "residual");
    exactKeys(item, ["operationId", "status"], "residual");
    if (
      !identity(item.operationId) ||
      !residualStatuses.has(item.status as RecoveryResidualStatus) ||
      seen.has(item.operationId)
    )
      return false;
    seen.add(item.operationId);
    return true;
  });
}

export function validateRecoveryJobPlan(plan: RecoveryJobPlan): void {
  const value = object(plan, "plan");
  exactKeys(
    value,
    [
      "schema",
      "workspace",
      "jobId",
      "selection",
      "boundary",
      "steps",
      "residuals",
      "digest",
    ],
    "plan",
  );
  if (
    plan.schema !== "void.recovery-plan.v1" ||
    !identity(plan.workspace) ||
    !identity(plan.jobId)
  )
    throw new Error("Invalid recovery job plan.");
  const selection = object(plan.selection, "selection");
  if (plan.selection.kind === "run") {
    exactKeys(selection, ["kind", "runId"], "selection");
    if (typeof plan.selection.runId !== "string" || !/^[\w:-]{1,120}$/.test(plan.selection.runId))
      throw new Error("Invalid recovery job selection.");
  } else if (plan.selection.kind === "operations") {
    exactKeys(selection, ["kind", "operationIds"], "selection");
    if (
      !Array.isArray(plan.selection.operationIds) ||
      plan.selection.operationIds.length === 0 ||
      plan.selection.operationIds.some((id) => !identity(id)) ||
      new Set(plan.selection.operationIds).size !==
        plan.selection.operationIds.length
    )
      throw new Error("Invalid recovery job selection.");
  } else throw new Error("Invalid recovery job selection.");
  const boundary = object(plan.boundary, "boundary");
  exactKeys(boundary, ["sequence", "digest"], "boundary");
  if (
    !Number.isSafeInteger(plan.boundary.sequence) ||
    plan.boundary.sequence < 0 ||
    !/^[a-f0-9]{64}$/.test(plan.boundary.digest)
  )
    throw new Error("Invalid recovery job boundary.");
  if (!Array.isArray(plan.steps) || !validResiduals(plan.residuals))
    throw new Error("Invalid recovery job plan payload.");
  const operations = new Set<string>();
  let priorSequence = Number.MAX_SAFE_INTEGER;
  for (const candidate of plan.steps) {
    const step = object(candidate, "step");
    exactKeys(step, ["operationId", "sequence", "plan"], "step");
    if (
      !identity(candidate.operationId) ||
      operations.has(candidate.operationId) ||
      !Number.isSafeInteger(candidate.sequence) ||
      candidate.sequence < 1 ||
      candidate.sequence > plan.boundary.sequence ||
      candidate.sequence >= priorSequence
    )
      throw new Error("Invalid recovery job step.");
    operations.add(candidate.operationId);
    priorSequence = candidate.sequence;
    const single = object(candidate.plan, "single operation plan");
    exactKeys(
      single,
      [
        "workspace",
        "operationId",
        "digest",
        "scope",
        "resources",
        "reversibility",
      ],
      "single operation plan",
    );
    if (
      candidate.plan.workspace !== plan.workspace ||
      candidate.plan.operationId !== candidate.operationId ||
      !/^[a-f0-9]{64}$/.test(candidate.plan.digest) ||
      typeof candidate.plan.scope !== "string" ||
      !Array.isArray(candidate.plan.resources) ||
      candidate.plan.resources.some(
        (resource: unknown) => typeof resource !== "string",
      ) ||
      !["r0", "r1", "r2"].includes(candidate.plan.reversibility)
    )
      throw new Error("Invalid recovery job single operation plan.");
  }
  if (plan.residuals.some((residual) => operations.has(residual.operationId)))
    throw new Error("Invalid recovery job duplicate operation.");
  const { digest: claimed, ...unsigned } = plan;
  if (!/^[a-f0-9]{64}$/.test(claimed) || digest(unsigned) !== claimed)
    throw new Error("Recovery job plan digest is invalid.");
}

type JobEventLike = {
  workspace: string;
  jobId: string;
  planDigest: string;
  stage: string;
  data: unknown;
};

function planned(
  events: readonly JobEventLike[],
  jobId: string,
): RecoveryJobPlan | undefined {
  const event = events.find(
    (candidate) => candidate.jobId === jobId && candidate.stage === "planned",
  );
  if (!event) return undefined;
  const data = object(event.data, "planned payload");
  return data.plan as RecoveryJobPlan;
}

/** The shape check only. Whether a lease may be reclaimed is decided in
 * `recovery/lease.ts`, next to the rule and its tests. */
function validLease(value: unknown): value is { holder: string; expiresAt: number } {
  const lease = object(value, "lease");
  return (
    Object.keys(lease).length === 2 &&
    typeof lease.holder === "string" &&
    /^[\w.:-]{1,160}$/.test(lease.holder) &&
    typeof lease.expiresAt === "number" &&
    Number.isFinite(lease.expiresAt)
  );
}

function validateProgress(
  value: unknown,
  plan: RecoveryJobPlan,
  terminal?: string,
): void {
  const data = object(value, "progress payload");
  const keys =
    terminal === "paused"
      ? ["jobId", "status", "checkpoint", "outcomes", "residuals", "pause"]
      : terminal
        ? ["jobId", "status", "checkpoint", "outcomes", "residuals"]
        : ["checkpoint", "outcomes", "residuals"];
  // R06: a non-terminal payload may carry the lease of the worker applying it.
  // Absent means no lease was claimed, which the workspace guard treats as "the
  // holder is unknown" and therefore never reclaims.
  if (data.lease !== undefined && !validLease(data.lease))
    throw new Error("Invalid recovery job lease.");
  exactKeys(
    data,
    terminal === undefined && data.lease !== undefined
      ? [...keys, "lease"]
      : keys,
    "progress payload",
  );
  const checkpoint = data.checkpoint;
  if (
    !Number.isSafeInteger(checkpoint) ||
    (checkpoint as number) < 0 ||
    (checkpoint as number) > plan.steps.length
  )
    throw new Error("Invalid recovery job checkpoint.");
  if (
    !Array.isArray(data.outcomes) ||
    data.outcomes.length !== checkpoint ||
    !validResiduals(data.residuals)
  )
    throw new Error("Invalid recovery job progress.");
  const seen = new Set<string>();
  for (let index = 0; index < data.outcomes.length; index++) {
    const outcome = object(data.outcomes[index], "outcome");
    exactKeys(outcome, ["operationId", "status"], "outcome");
    if (
      outcome.operationId !== plan.steps[index]!.operationId ||
      !["restored", "compensated"].includes(outcome.status as string) ||
      seen.has(outcome.operationId as string)
    )
      throw new Error("Invalid recovery job outcome prefix.");
    seen.add(outcome.operationId as string);
  }
  if (
    (data.residuals as RecoveryResidual[]).some(
      (residual) =>
        seen.has(residual.operationId) && residual.status !== "compensated",
    )
  )
    throw new Error("Invalid recovery job residual overlap.");
  if (terminal) {
    if (data.jobId !== plan.jobId || data.status !== terminal)
      throw new Error("Invalid recovery job terminal payload.");
    if (
      (terminal === "restored" || terminal === "partial") &&
      checkpoint !== plan.steps.length
    )
      throw new Error("Invalid recovery job terminal checkpoint.");
    if (terminal === "restored" && (data.residuals as unknown[]).length !== 0)
      throw new Error("Invalid restored recovery job residuals.");
    if (terminal === "partial" && (data.residuals as unknown[]).length === 0)
      throw new Error("Invalid partial recovery job residuals.");
    if (terminal === "paused") {
      const pause = object(data.pause, "pause");
      exactKeys(pause, ["code", "operationId"], "pause");
      if (
        pause.code !== "step-unavailable" ||
        pause.operationId !== plan.steps[checkpoint]?.operationId
      )
        throw new Error("Invalid recovery job pause.");
    }
  }
}

export function validateRecoveryJobPayload(
  events: readonly JobEventLike[],
  event: JobEventLike,
): void {
  if (event.stage === "planned") {
    const data = object(event.data, "planned payload");
    exactKeys(data, ["plan"], "planned payload");
    const plan = data.plan as RecoveryJobPlan;
    validateRecoveryJobPlan(plan);
    if (
      plan.workspace !== event.workspace ||
      plan.jobId !== event.jobId ||
      plan.digest !== event.planDigest
    )
      throw new Error("Recovery job event does not match embedded plan.");
    return;
  }
  const plan = planned(events, event.jobId);
  if (!plan) throw new Error("Recovery job plan is missing.");
  validateRecoveryJobPlan(plan);
  if (
    plan.workspace !== event.workspace ||
    plan.jobId !== event.jobId ||
    plan.digest !== event.planDigest
  )
    throw new Error("Recovery job event does not match embedded plan.");
  if (event.stage === "approved") {
    if (event.data !== null)
      throw new Error("Invalid recovery job approval payload.");
    return;
  }
  validateProgress(
    event.data,
    plan,
    ["restored", "partial", "conflict", "unknown", "paused"].includes(
      event.stage,
    )
      ? event.stage
      : undefined,
  );
}

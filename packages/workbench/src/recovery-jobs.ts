import { digest, type RecoveryJobPlan, type RecoveryJobResult, type RecoverySelection } from "../../runtime/src/index.ts";

export type RecoveryRequest = { jobId: string; selection: RecoverySelection };
export type RecoveryApply = { jobId: string; planDigest: string; approved: boolean };
const identity = (value: unknown): value is string => typeof value === "string" && /^[\w-]{1,120}$/.test(value);
export function recoveryRequest(input: unknown): RecoveryRequest {
  const value = input as RecoveryRequest | null;
  if (!value || !identity(value.jobId)) throw new Error("Invalid recovery job identity.");
  const selection = value.selection;
  if (selection?.kind === "run" && typeof selection.runId === "string" && /^[\w:-]{1,120}$/.test(selection.runId))
    return { jobId: value.jobId, selection: { kind: "run", runId: selection.runId } };
  if (selection?.kind === "operations" && Array.isArray(selection.operationIds) && selection.operationIds.length > 0 && selection.operationIds.length <= 1000 && selection.operationIds.every(identity) && new Set(selection.operationIds).size === selection.operationIds.length)
    return { jobId: value.jobId, selection: { kind: "operations", operationIds: [...selection.operationIds] } };
  throw new Error("Choose one exact run or unique operation IDs.");
}
export function runtimeSelection(selection: RecoverySelection): RecoverySelection {
  return selection.kind === "operations" ? { kind: "operations", operationIds: selection.operationIds.map(digest) } : selection;
}
export function recoveryOperationMap(operationIds: readonly string[], selection: RecoverySelection) {
  return new Map([...operationIds, ...(selection.kind === "operations" ? selection.operationIds : [])].map(id => [digest(id), id]));
}
export function recoveryPreview(plan: RecoveryJobPlan, ids: ReadonlyMap<string, string>) {
  const external = (id: string) => ids.get(id) ?? id;
  return {
    jobId: plan.jobId, planDigest: plan.digest,
    selection: plan.selection.kind === "operations" ? { kind: "operations" as const, operationIds: plan.selection.operationIds.map(external) } : plan.selection,
    boundary: plan.boundary,
    steps: plan.steps.map(step => ({ operationId: external(step.operationId), sequence: step.sequence, resources: step.plan.resources, scope: step.plan.scope })),
    residuals: plan.residuals.map(item => ({ ...item, operationId: external(item.operationId) })),
  };
}
export function recoveryResult(result: RecoveryJobResult, ids: ReadonlyMap<string, string>) {
  const external = (id: string) => ids.get(id) ?? id;
  return {
    ...result,
    outcomes: result.outcomes.map(item => ({ ...item, operationId: external(item.operationId) })),
    residuals: result.residuals.map(item => ({ ...item, operationId: external(item.operationId) })),
    ...(result.pause ? { pause: { ...result.pause, operationId: external(result.pause.operationId) } } : {}),
  };
}

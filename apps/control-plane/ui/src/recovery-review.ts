export type RecoveryPlan = {
  jobId: string;
  planDigest: string;
  steps: {
    operationId: string;
    sequence: number;
    resources?: string[];
    scope?: string;
  }[];
  residuals: { operationId: string; status: string }[];
  selection?: unknown;
  boundary?: unknown;
};
export type RecoveryReview = {
  phase: "planning" | "ready" | "applying" | "blocked" | "settled";
  plan?: RecoveryPlan;
  result?: Record<string, unknown>;
};
type Action =
  | { type: "refresh" | "applying" | "failed" }
  | { type: "planned"; plan: RecoveryPlan }
  | { type: "observed"; result: Record<string, unknown> };

export function recoveryReview(
  state: RecoveryReview,
  action: Action,
): RecoveryReview {
  if (action.type === "refresh") return { phase: "planning" };
  if (action.type === "planned")
    return state.phase === "planning"
      ? { phase: "ready", plan: action.plan }
      : state;
  if (action.type === "applying")
    return recoveryApplyBody(state) ? { ...state, phase: "applying" } : state;
  if (action.type === "failed") return { ...state, phase: "blocked" };
  if (action.type === "observed")
    return { ...state, phase: "settled", result: action.result };
  return state;
}

export function recoveryApplyBody(state: RecoveryReview) {
  return state.phase === "ready" && state.plan?.steps.length
    ? {
        jobId: state.plan.jobId,
        planDigest: state.plan.planDigest,
        approved: true,
      }
    : null;
}

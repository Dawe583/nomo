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

export function recoveryStateLabel(
  value: unknown,
  locale: "cs" | "en",
): string {
  const labels: Record<string, readonly [string, string]> = {
    restored: ["Obnoveno", "Restored"],
    partial: ["Částečně obnoveno", "Partially restored"],
    conflict: ["Konflikt", "Conflict"],
    unknown: ["Výsledek neznámý", "Outcome unknown"],
    paused: ["Pozastaveno", "Paused"],
    missing: ["Chybí zdroj", "Missing source"],
    "not-successful": ["Nebyla úspěšná", "Not successful"],
    compensated: ["Kompenzováno", "Compensated"],
    "blocked-by-conflict": ["Blokováno konfliktem", "Blocked by conflict"],
  };
  const key = String(value ?? "");
  const label = labels[key];
  return label ? label[locale === "cs" ? 0 : 1] : key || "—";
}
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

export function recoveryStatusPath(session: {
  id: string;
  lastRecoveryJob?: unknown;
}): string | undefined {
  const retained = session.lastRecoveryJob;
  if (!retained || typeof retained !== "object" || !("jobId" in retained))
    return undefined;
  const jobId = retained.jobId;
  return typeof jobId === "string" && jobId.length > 0
    ? "/api/sessions/" +
        encodeURIComponent(session.id) +
        "/recovery-jobs/" +
        encodeURIComponent(jobId)
    : undefined;
}

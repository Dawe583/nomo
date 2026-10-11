import { read, write, transaction } from "./store.mjs";
import { isOwner } from "./owner.mjs";
import { cloudRecoveryJobStatus, cloudRecoveryJobPlanDigest, planCloudRecoveryJob, runCloudRecoveryJob } from "./recovery.mjs";

const identity = value => typeof value === "string" && /^[\w-]{1,120}$/.test(value);
const selection = value => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  if (value.kind === "run" && typeof value.runId === "string" && /^[\w:-]{1,160}$/.test(value.runId))
    return { kind: "run", runId: value.runId };
  if (value.kind === "operations" && Array.isArray(value.operationIds) && value.operationIds.length > 0 &&
      value.operationIds.length <= 500 && new Set(value.operationIds).size === value.operationIds.length && value.operationIds.every(identity))
    return { kind: "operations", operationIds: [...value.operationIds] };
  if (value.kind === "checkpoint" && Number.isSafeInteger(value.sequence) && value.sequence >= 0)
    return { kind: "checkpoint", sequence: value.sequence };
  return null;
};

// `402` rather than `403`: nothing about this caller is wrong. The capability is
// real, it works, and it is not theirs yet. The message names what stays free,
// so the refusal reads as a boundary rather than a dead end.
const APPLY_PAYWALL = "Executing a recovery on this server is part of the paid NOMO licence. Planning a recovery, reading its plan and receipt, and running the same recovery locally with the open-source CLI all stay free.";
const response = payload => "digest" in payload ? {
  jobId: payload.jobId, planDigest: payload.digest, selection: payload.selection, boundary: payload.boundary,
  steps: payload.steps.map(step => ({ operationId: step.operationId, sequence: step.sequence,
    resources: step.plan.resources, scope: step.plan.scope })),
  residuals: payload.residuals.map(({ operationId, status }) => ({ operationId, status })),
} : {
  jobId: payload.jobId, status: payload.status, checkpoint: payload.checkpoint,
  outcomes: payload.outcomes.map(({ operationId, status }) => ({ operationId, status })),
  residuals: payload.residuals.map(({ operationId, status }) => ({ operationId, status })),
  ...(payload.pause ? { pause: payload.pause } : {}),
};

export function mountRecoveryRoutes(app, overrides = {}) {
  const deps = { read, write, transaction, cloudRecoveryJobStatus, cloudRecoveryJobPlanDigest, planCloudRecoveryJob, runCloudRecoveryJob, ...overrides };
  // Hosted execution is the paid capability (`verifiedRecovery`, see
  // `cloud/capability-gate.mjs`), and `cloud/server.mjs` supplies it the same
  // way the taint route reads it. It is checked here, on the route, and not
  // only in the capability answer, because a capability flag the server ignores
  // is a label. A throw is not an entitlement either: the gate already fails
  // closed on a failed billing read, and a mount that wired no gate at all is
  // the free tier, because that is the only direction a missing entitlement is
  // allowed to fail in.
  const entitled = deps.entitled ?? (async () => false);
  const gate = async req => {
    try {
      return await entitled(req.owner) === true;
    } catch {
      return false;
    }
  };
  // Every current-state check shares the same lock as document writes and stop.
  // `paid` marks the one route that spends money: the gate is consulted before
  // the transaction opens, so a refused apply takes no lock, reads no session
  // row and writes nothing.
  const handle = (action, paid = false) => async (req, res) => {
    // A recovery plan is a write against somebody's session. No owner, no plan.
    if (!isOwner(req.owner))
      return res.status(401).json({ message: "Sign in to plan a recovery." });
    if (paid && !(await gate(req)))
      return res.status(402).json({ error: "capability_not_included", message: APPLY_PAYWALL });
    try {
      const result = await deps.transaction(req.owner, req.params.id, async client => {
        const session = await deps.read(req.owner, `session:${req.params.id}`, client);
        if (!session) return { status: 404, body: { message: "Session not found." } };
        return action(req, session, client);
      });
      res.status(result.status).json(result.body);
    } catch {
      res.status(409).json({ message: "Recovery is unavailable or the plan is stale. Inspect the job and explicitly refresh its preview." });
    }
  };
  const busy = session => ["running", "queued", "stopping"].includes(session.status) ||
    !!session.executing || !!session.pending || !!session.queue?.length;
  app.post("/api/sessions/:id/recovery-jobs/plan", handle(async (req, session, client) => {
    const chosen = selection(req.body?.selection), jobId = req.body?.jobId;
    if (!identity(jobId) || !chosen) return { status: 400, body: { message: "Select one exact run, a journal checkpoint, or a unique operation list and stable job ID." } };
    if (busy(session)) return { status: 409, body: { message: "Wait for the agent to stop." } };
    const plan = await deps.planCloudRecoveryJob(req.owner, { workspace: session.workspace, jobId, selection: chosen }, session, client);
    return { status: 200, body: response(plan) };
  }));
  app.post("/api/sessions/:id/recovery-jobs/apply", handle(async (req, session, client) => {
    const { jobId, planDigest, approved } = req.body ?? {};
    if (!identity(jobId) || typeof planDigest !== "string" || !/^[a-f0-9]{64}$/.test(planDigest) || approved !== true)
      return { status: 400, body: { message: "Applying recovery requires explicit approval of its stored digest." } };
    if (busy(session)) return { status: 409, body: { message: "Wait for the agent to stop." } };
    const status = await deps.cloudRecoveryJobStatus(req.owner, session, client, jobId);
    if (!status) return { status: 404, body: { message: "Recovery job not found." } };
    const storedDigest = "digest" in status ? status.digest : await deps.cloudRecoveryJobPlanDigest(req.owner, session, client, jobId);
    if (storedDigest !== planDigest) return { status: 409, body: { message: "Recovery job digest changed; explicitly refresh the preview." } };
    if (session.recoveryBlock && session.recoveryBlock.jobId !== jobId)
      return { status: 409, body: { message: "Resolve the owning recovery job before applying another job." } };
    // Retain ownership before dispatch; a repaired job cannot clear unrelated uncertainty.
    const dispatch = "digest" in status || status.status === "paused";
    if (dispatch && !session.recoveryBlock)
      session.recoveryBlock = { jobId, priorStatus: session.status };
    session.lastRecoveryJob = { jobId };
    await deps.write(req.owner, `session:${session.id}`, session, client);
    // Terminal and ambiguous results are observed, never dispatched again.
    const result = dispatch
      ? await deps.runCloudRecoveryJob(req.owner, session, client, jobId, async plan => plan.digest === planDigest)
      : status;
    if (["unknown", "paused"].includes(result.status)) {
      session.recoveryBlock ??= { jobId, priorStatus: session.status };
      if (session.status !== "unknown") session.status = result.status;
      await deps.write(req.owner, `session:${session.id}`, session, client);
    } else if (["restored", "partial", "conflict"].includes(result.status) && session.recoveryBlock?.jobId === jobId) {
      session.status = session.recoveryBlock.priorStatus;
      delete session.recoveryBlock;
      await deps.write(req.owner, `session:${session.id}`, session, client);
    }
    return { status: 200, body: response(result) };
  }, true));
  app.get("/api/sessions/:id/recovery-jobs/:job", handle(async (req, session, client) => {
    if (!identity(req.params.job)) return { status: 400, body: { message: "Invalid recovery job." } };
    const status = await deps.cloudRecoveryJobStatus(req.owner, session, client, req.params.job);
    return status ? { status: 200, body: response(status) } : { status: 404, body: { message: "Recovery job not found." } };
  }));
}

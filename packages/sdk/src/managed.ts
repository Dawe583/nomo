import {
  recoveryRuntime,
  type RecoveryJobPlan,
  type RecoveryJobRequest,
  type RecoveryJobResult,
  type RuntimeOptions,
  type Json,
  type RecoveryPlan,
} from "../../runtime/src/index.ts";

/** In-process managed host. Credentials and adapter selection belong to the host,
 * while operationId/runId stay explicit for durable caller-controlled retries. */
export function managedClient(
  options: RuntimeOptions & { workspace: string; agentId: string },
) {
  const workspace = options.workspace,
    agentId = options.agentId,
    runtime = recoveryRuntime(options);
  const forWorkspace = (plan: RecoveryPlan) => {
    if (plan.workspace !== workspace)
      throw new Error("Recovery plan belongs to another workspace.");
    return plan;
  };
  return {
    execute(adapterId: string, operationId: string, runId: string, args: Json) {
      return runtime.execute({
        workspace,
        agentId,
        adapterId,
        operationId,
        runId,
        arguments: args,
      });
    },
    planRecovery(operationId: string) {
      return runtime.planRecovery(workspace, operationId);
    },
    recover(
      plan: RecoveryPlan,
      authorize: (plan: RecoveryPlan) => Promise<boolean>,
    ) {
      return runtime.recover(forWorkspace(plan), authorize);
    },
    reconcile(operationId: string) {
      return runtime.reconcile(workspace, operationId);
    },
    reconcileRecovery(operationId: string) {
      return runtime.reconcileRecovery(workspace, operationId);
    },
    planRecoveryJob(request: RecoveryJobRequest) {
      if (request.workspace !== undefined && request.workspace !== workspace) throw new Error("Recovery job belongs to another workspace.");
      assertJobId(request.jobId);
      return runtime.planRecoveryJob({ workspace, jobId: request.jobId, selection: request.selection });
    },
    recoveryJobStatus(jobId: string) {
      assertJobId(jobId);
      return runtime.recoveryJobStatus(workspace, jobId);
    },
    runRecoveryJob(jobId: string, authorize: (plan: RecoveryJobPlan) => Promise<boolean>): Promise<RecoveryJobResult> {
      assertJobId(jobId);
      return runtime.runRecoveryJob(workspace, jobId, authorize);
    },
  };
}
function assertJobId(jobId: unknown): asserts jobId is string {
  if (typeof jobId !== "string" || !/^[\w-]{1,120}$/.test(jobId)) throw new Error("Invalid recovery job identity.");
}

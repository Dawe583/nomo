import type {
  Json,
  Observation,
  Outcome,
  Prepared,
  RecoveryAdapter,
  RecoveryOutcome,
} from "../../connectors/src/recovery.ts";
/** WP-R02: legacy host binding contract lives here so every host imports one boundary. */
export {
  legacyOutcomeDigest,
  runLegacyBoundCall,
  type LegacyBoundResult,
  type LegacyCallStatus,
  type LegacyCapture,
  type LegacyDispatch,
  type LegacyOutcomeRecord,
  type LegacyToolBinding,
} from "./adapter.ts";
import { canonicalJson } from "../../ledger/src/canonical.ts";
import {
  digest,
  type OperationEvent,
  type OperationJournal,
  type JournalTransaction,
  type RecoveryJobEvent,
  type RecoveryJobStage,
  type Stage,
} from "./journal.ts";
import {
  completeRecoveryJobPlan,
  independentBranches,
  resolveRecoverySelection,
  validateRecoveryJobPlan,
  type RecoveryJobPlan,
  type RecoveryJobRequest,
  type RecoveryJobResult,
  type RecoveryJournalState,
  type RecoveryOperationState,
  type RecoveryResidual,
  type RecoverySelection,
  type RecoverySelector,
} from "./recovery/plan.ts";
import { jobPlan, latestJobEvent, progressFrom } from "./recovery/run.ts";
import { leaseOf, leaseVerdict } from "./recovery/lease.ts";
import {
  orderRecoverySteps,
  provenanceOf,
  type ProvenanceFact,
} from "./recovery/provenance.ts";
import {
  VaultCapacityError,
  type RecoveryVault,
  type VaultReference,
} from "./vault.ts";
import {
  reserveBudget,
  validateBudget,
  type BudgetHold,
  type BudgetOutcome,
  type IrreversibilityBudget,
  type ServerBudgetLedger,
} from "./budget.ts";
export type ExecutionRequest = {
  workspace: string;
  operationId: string;
  agentId: string;
  runId: string;
  adapterId: string;
  arguments: Json;
};
export type Authorization = {
  digest: string;
  observation: Observation;
  request: ExecutionRequest;
};
export type RuntimeOptions = {
  journal: OperationJournal;
  vault: RecoveryVault;
  adapters: readonly RecoveryAdapter[];
  authorize: (request: Authorization) => Promise<boolean>;
  requireRecoverable?: boolean;
  irreversibilityBudget?: IrreversibilityBudget;
  /** R10: the shared authority for the irreversible budget.
   *
   * Opt in and the reservation has to clear both this ledger and
   * `irreversibilityBudget`, so a host that adopts it never loses the local
   * cap it already had. A host that does not adopt it is untouched, including
   * the journal derivation's own accounting. */
  readonly budgetLedger?: ServerBudgetLedger;
  /** Identifies this worker in a recovery-job lease. Defaults to a fixed label, so
   * the pid in the lease is what identifies the process. */
  readonly hostLabel?: string;
  /** How long this worker's claim on a recovery job stays valid. The lease is
   * renewed at every step; a job whose holder died is reclaimable only after it
   * expires AND its holder is provably gone. */
  readonly jobLeaseMs?: number;
};
export type ExecutionResult = {
  status: Stage;
  operationId: string;
  result?: Json;
  reason?: "recovery-capacity";
};
/** What the shared ledger still owes once the journal transaction is over.
 *
 * `null` means this operation reserved nothing. A `reason` is the only thing
 * that hands a unit back, so it is written down rather than inferred: a
 * failure before dispatch is the one case where nothing ran. */
type BudgetCharge =
  | { operationId: string; outcome: BudgetOutcome }
  | { operationId: string; reason: string }
  | null;
export type RecoveryPlan = {
  workspace: string;
  operationId: string;
  digest: string;
  scope: string;
  resources: string[];
  reversibility: string;
};
/** Named local recovery host contract. This is the boundary imported by MCP/CLI hosts. */
export interface RecoveryRuntime {
  execute(input: ExecutionRequest): Promise<ExecutionResult>;
  reconcile(workspace: string, operationId: string): Promise<ExecutionResult>;
  reconcileRecovery(
    workspace: string,
    operationId: string,
  ): Promise<RecoveryOutcome | { status: "unknown" }>;
  planRecovery(workspace: string, operationId: string): Promise<RecoveryPlan>;
  planRecoveryJob(request: RecoveryJobRequest): Promise<RecoveryJobPlan>;
  recoveryJobStatus(
    workspace: string,
    jobId: string,
  ): Promise<RecoveryJobResult | RecoveryJobPlan>;
  runRecoveryJob(
    workspace: string,
    jobId: string,
    authorize: (plan: RecoveryJobPlan) => Promise<boolean>,
  ): Promise<RecoveryJobResult>;
  recover(
    plan: RecoveryPlan,
    authorize: (plan: RecoveryPlan) => Promise<boolean>,
  ): Promise<RecoveryOutcome | { status: "unknown" }>;
  status(workspace: string, operationId: string): Promise<Stage | undefined>;
}
const isNodeError = (error: unknown): error is NodeJS.ErrnoException =>
  error instanceof Error && "code" in error;
const adapterKey = (workspace: string, operationId: string) =>
  digest({ workspace, operationId });
const clean = <T>(value: T): T => JSON.parse(JSON.stringify(value));
function latest(tx: JournalTransaction, id: string) {
  return [...tx.events].reverse().find((e) => e.operationId === id);
}
function artifact(
  tx: JournalTransaction,
  id: string,
  stage: Stage,
): VaultReference {
  const event = [...tx.events]
    .reverse()
    .find((e) => e.operationId === id && e.stage === stage);
  if (!event) throw new Error("Required operation evidence is missing.");
  return event.data as unknown as VaultReference;
}
export function recoveryRuntime(options: RuntimeOptions): RecoveryRuntime {
  if (options.irreversibilityBudget)
    validateBudget(options.irreversibilityBudget);
  const adapters = new Map<string, RecoveryAdapter>();
  for (const adapter of options.adapters) {
    if (adapters.has(adapter.id) || !adapter.id || !adapter.version)
      throw new Error("Invalid or duplicate recovery adapter.");
    adapters.set(adapter.id, adapter);
  }
  const adapterFor = (id: string, version?: string) => {
    const adapter = adapters.get(id);
    if (!adapter || (version && version !== adapter.version))
      throw new Error("Recovery adapter version is unavailable.");
    return adapter;
  };
  const record = async (
    tx: JournalTransaction,
    identity: OperationEvent,
    stage: Stage,
    data: Json = null,
  ) => {
    await tx.append({ ...identity, stage, data, at: new Date().toISOString() });
  };
  /** Close a shared budget hold, always after the journal transaction has
   * returned and never inside it.
   *
   * These are writes to a second store, and the journal's writer lock is held
   * for the whole transaction and is shared by every workspace in the journal
   * directory. Closing a hold under it would buy nothing and could stall
   * unrelated work, so the ordering is fixed here rather than at the call
   * site. A close that never lands leaves a `reserved` hold, which the ledger
   * makes visible through `expireStale` and never refunds: the journal is the
   * record of what happened, and a dispatch that already ran must not be
   * reported as a failure because the bookkeeping was contended. */
  const commitCharge = async (charge: BudgetCharge) => {
    if (!charge || !options.budgetLedger) return;
    await (
      "outcome" in charge
        ? options.budgetLedger.settle(charge)
        : options.budgetLedger.release(charge)
    ).catch(() => {});
  };
  const loadPrepared = async (tx: JournalTransaction, event: OperationEvent) =>
    (await options.vault.get(
      event.workspace,
      artifact(tx, event.operationId, "prepared"),
    )) as unknown as {
      request: ExecutionRequest;
      observation: Observation;
      prepared: Prepared;
    };
  const planFor = async (
    tx: JournalTransaction,
    event: OperationEvent,
  ): Promise<RecoveryPlan> => {
    if (event.stage !== "succeeded")
      throw new Error(
        "Only a confirmed successful operation can be planned for recovery.",
      );
    adapterFor(event.adapterId, event.adapterVersion);
    const bundle = await loadPrepared(tx, event);
    if (
      bundle.observation.readiness !== "verified" ||
      !["r0", "r1", "r2"].includes(bundle.observation.reversibility)
    )
      throw new Error("Operation has no verified recovery capability.");
    await options.vault.get(
      event.workspace,
      artifact(tx, event.operationId, "succeeded"),
    );
    await options.vault.reserve?.(event.workspace, event.operationId, [
      "recovery",
    ]);
    return {
      workspace: event.workspace,
      operationId: event.operationId,
      digest: digest({
        event,
        capture: artifact(tx, event.operationId, "prepared"),
      }),
      scope: bundle.observation.scope,
      resources: bundle.observation.resources,
      reversibility: bundle.observation.reversibility,
    };
  };
  const leaseHolder = `${options.hostLabel ?? "host"}:${process.pid}`;
  const leaseMs = options.jobLeaseMs ?? 15 * 60 * 1000;

  const recordJob = async (
    tx: JournalTransaction,
    plan: RecoveryJobPlan,
    stage: RecoveryJobStage,
    data: Json,
  ) => {
    if (!tx.appendJob)
      throw new Error("Recovery job journal support is unavailable.");
    return tx.appendJob({
      schema: "void.recovery-job.v1",
      workspace: plan.workspace,
      jobId: plan.jobId,
      planDigest: plan.digest,
      at: new Date().toISOString(),
      stage,
      data,
    });
  };
  const resultFor = async (
    tx: JournalTransaction,
    event: OperationEvent,
  ): Promise<ExecutionResult> => ({
    status: event.stage,
    operationId: event.operationId,
    ...(event.data &&
    typeof event.data === "object" &&
    !Array.isArray(event.data) &&
    event.data.reason === "recovery-capacity"
      ? { reason: "recovery-capacity" as const }
      : {}),
    ...(event.stage === "succeeded"
      ? {
          result: (
            (await options.vault.get(
              event.workspace,
              artifact(tx, event.operationId, "succeeded"),
            )) as unknown as Outcome
          ).result,
        }
      : {}),
  });
  let recoverOperation!: (
    plan: RecoveryPlan,
    authorize: (plan: RecoveryPlan) => Promise<boolean>,
  ) => Promise<RecoveryOutcome | { status: "unknown" }>;
  const runtime = {
    async status(
      workspace: string,
      operationId: string,
    ): Promise<Stage | undefined> {
      return options.journal.transaction(
        workspace,
        async (tx) => latest(tx, operationId)?.stage,
      );
    },
    async execute(input: ExecutionRequest): Promise<ExecutionResult> {
      // Canonical validation happens before the JSON clone, which would silently erase undefined.
      const requestDigest = digest(input),
        request = clean(input),
        adapter = adapterFor(request.adapterId);
      for (const value of [request.operationId, request.agentId])
        if (!/^[\w-]{1,120}$/.test(value))
          throw new Error("Invalid operation identity.");
      if (!/^[\w:-]{1,120}$/.test(request.runId)) throw new Error("Invalid run identity.");
      // R10: the shared account is read before the journal writer lock is
      // taken. This is a short read of prior records and it decides nothing
      // about the reservation, which is deliberate on two counts. It cannot
      // refuse on an exhausted account, because only the fenced read that
      // would have committed the hold can also prove this operation was not
      // already charged by a process that died mid-dispatch. And an account
      // that cannot be trusted is an incident, not a `failed` operation, so it
      // is discovered here rather than while every workspace in the journal
      // directory waits on the lock behind it.
      if (options.budgetLedger) await options.budgetLedger.snapshot();
      const pending = options.journal.transaction(
        request.workspace,
        async (tx): Promise<{ result: ExecutionResult; charge: BudgetCharge }> => {
          const prior = latest(tx, request.operationId);
          if (prior) {
            if (
              prior.requestDigest !== requestDigest ||
              prior.adapterVersion !== adapter.version
            )
              throw new Error(
                "Idempotency key belongs to another request or adapter version.",
              );
            // A crashed process never silently resumes a possibly dispatched operation.
            if (prior.stage === "dispatched") {
              await record(tx, prior, "unknown");
              return {
                result: { status: "unknown", operationId: prior.operationId },
                charge: null,
              };
            }
            return { result: await resultFor(tx, prior), charge: null };
          }
          const jobs = new Map(
            (tx.jobEvents ?? []).map((event) => [event.jobId, event]),
          );
          if (
            [...jobs.values()].some((event) =>
              [
                "approved",
                "applying",
                "checkpoint",
                "unknown",
                "paused",
              ].includes(event.stage),
            )
          )
            throw new Error(
              "A recovery job blocks new forward operations in this workspace.",
            );
          const identity: OperationEvent = {
            schema: "void.operation.v1",
            workspace: request.workspace,
            operationId: request.operationId,
            requestDigest,
            adapterId: adapter.id,
            adapterVersion: adapter.version,
            agentId: request.agentId,
            runId: request.runId,
            at: new Date().toISOString(),
            stage: "received",
            data: null,
          };
          await tx.append(identity);
          let dispatched = false;
          // The shared hold this process took, if any. It lives beside the
          // dispatch flag so the catch can close it: a failure after the
          // reservation and before dispatch is the one case that hands a unit
          // back.
          let charged: BudgetHold | null = null;
          try {
            const observation = JSON.parse(
              canonicalJson(await adapter.preflight(clean(request.arguments))),
            ) as Observation;
            digest(observation);
            // R07: what this operation read and wrote, from the observation
            // the adapter just made, not from the request the caller sent. A
            // read set the adapter never performed would be a false claim in a
            // signed journal, so an adapter that cannot observe its reads
            // leaves the field absent and the planner treats the step as
            // unproven rather than as independent. Every later record for this
            // operation repeats these three fields, because `identity` is what
            // each stage is written from.
            if (observation.reads)
              identity.readSet = observation.reads.map((read) => read.resource);
            identity.writeSet = [...observation.resources];
            // A null revision is an observation — there was no prior state —
            // and is recorded as such. A revision the adapter did not report
            // at all is an absence, and an absent field is the only honest
            // record of it: canonicalJson refuses undefined, and a signed
            // record that cannot be canonicalised is a defect here rather than
            // something the serialiser should absorb.
            if (typeof observation.revision === "string")
              identity.revision = observation.revision;
            else if (observation.revision !== undefined)
              identity.revision = canonicalJson(observation.revision);
            if (
              options.requireRecoverable !== false &&
              (observation.readiness !== "verified" ||
                !["r0", "r1"].includes(observation.reversibility))
            ) {
              await record(tx, identity, "denied");
              return {
                result: { status: "denied", operationId: request.operationId },
                charge: null,
              };
            }
            const approvalDigest = digest({
              requestDigest,
              adapterVersion: adapter.version,
              observation,
            });
            if (
              !(await options.authorize({
                digest: approvalDigest,
                observation: clean(observation),
                request: clean(request),
              }))
            ) {
              await record(tx, identity, "denied");
              return {
                result: { status: "denied", operationId: request.operationId },
                charge: null,
              };
            }
            const needsBudget =
              observation.readiness !== "verified" ||
              observation.reversibility === "r3" ||
              observation.reversibility === "unknown";
            const budget =
              needsBudget && options.irreversibilityBudget
                ? reserveBudget(
                    tx.events,
                    options.irreversibilityBudget,
                    request.agentId,
                  )
                : null;
            // An irreversible operation needs a budget behind it, and that is
            // the same gate as before this ledger existed: a host that
            // configured only the local cap keeps exactly the authority it had,
            // and a host that adopted the shared account gets that authority
            // instead of being asked for a redundant second one. A host that
            // configured both has to clear both, because the journal
            // derivation can only see the events its own process wrote.
            if (
              needsBudget &&
              (options.irreversibilityBudget ? !budget : !options.budgetLedger)
            ) {
              await record(tx, identity, "denied", {
                reason: "irreversibility-budget",
              });
              return {
                result: { status: "denied", operationId: request.operationId },
                charge: null,
              };
            }
            if (needsBudget && options.budgetLedger) {
              // One fenced attempt, never a retry. The journal's writer lock is
              // held for the whole transaction and is shared by every workspace
              // in the journal directory, so the one thing this path may not do
              // is re-decide under contention: that is the stall the first
              // attempt at this wiring was reverted for. Losing the fence is
              // reported, and the caller retries with a fresh operation id.
              const reservation = await options.budgetLedger.reserve({
                operationId: request.operationId,
                agentId: request.agentId,
                attempts: 1,
              });
              if (!reservation.ok) {
                if (reservation.reason === "exhausted") {
                  await record(tx, identity, "denied", {
                    reason: "irreversibility-budget",
                  });
                  return {
                    result: { status: "denied", operationId: request.operationId },
                    charge: null,
                  };
                }
                // Nothing ran and no unit was taken, so this is a failure and
                // not a denial: the cap never refused the operation.
                await record(tx, identity, "failed", {
                  reason: "budget-contention",
                });
                return {
                  result: { status: "failed", operationId: request.operationId },
                  charge: null,
                };
              }
              charged = reservation.hold;
            }
            await record(tx, identity, "authorized", {
              approvalDigest,
              ...(budget ? { budget } : {}),
            });
            await options.vault.reserve?.(request.workspace, request.operationId);
            const prepared = await adapter.prepare(
              clean(request.arguments),
              clean(observation),
              adapterKey(request.workspace, request.operationId),
            );
            digest(prepared);
            const capture = await options.vault.put(
              request.workspace,
              clean({ request, observation, prepared }) as unknown as Json,
              { operationId: request.operationId, slot: "capture" },
            );
            await record(tx, identity, "prepared", capture as unknown as Json);
            await record(tx, identity, "dispatched");
            dispatched = true;
            const outcome = await adapter.execute(
              clean(request.arguments),
              clean(prepared),
              adapterKey(request.workspace, request.operationId),
            );
            const result = await options.vault.put(
              request.workspace,
              outcome as unknown as Json,
              { operationId: request.operationId, slot: "outcome" },
            );
            await record(tx, identity, "succeeded", result as unknown as Json);
            return {
              result: {
                status: "succeeded",
                operationId: request.operationId,
                result: outcome.result,
              },
              charge: charged
                ? { operationId: request.operationId, outcome: "succeeded" }
                : null,
            };
          } catch (error) {
            const reason =
              error instanceof VaultCapacityError
                ? ("recovery-capacity" as const)
                : undefined;
            await record(
              tx,
              identity,
              dispatched ? "unknown" : "failed",
              reason ? { reason } : null,
            );
            return {
              result: {
                status: dispatched ? "unknown" : "failed",
                operationId: request.operationId,
                ...(reason ? { reason } : {}),
              },
              // Only a hold this process actually took may be closed. A
              // reservation that was never made leaves nothing to settle, and a
              // process that died after dispatching leaves its hold `reserved`
              // on purpose, because expiry makes that visible and never
              // refunds it.
              charge: charged
                ? dispatched
                  ? { operationId: request.operationId, outcome: "unknown" }
                  : {
                      operationId: request.operationId,
                      reason: "the operation failed before dispatch",
                    }
                : null,
            };
          } finally {
            if (!dispatched)
              await options.vault
                .release?.(request.workspace, request.operationId)
                .catch(() => {});
            await adapter
              .release(adapterKey(request.workspace, request.operationId))
              .catch(() => {});
          }
        },
      );
      const { result, charge } = await pending;
      // The journal is already the record of what happened, so the shared
      // hold is closed after the writer lock is gone rather than under it.
      await commitCharge(charge);
      return result;
    },
    async reconcile(
      workspace: string,
      operationId: string,
    ): Promise<ExecutionResult> {
      return options.journal.transaction(workspace, async (tx) => {
        let event = latest(tx, operationId);
        if (!event) throw new Error("Operation not found.");
        if (event.stage !== "dispatched" && event.stage !== "unknown")
          return resultFor(tx, event);
        const adapter = adapterFor(event.adapterId, event.adapterVersion),
          bundle = await loadPrepared(tx, event);
        await options.vault.reserve?.(workspace, operationId, ["outcome"]);
        const result = await adapter.reconcile(
          adapterKey(workspace, operationId),
          bundle.prepared,
        );
        if (result.status === "succeeded") {
          const reference = await options.vault.put(
            workspace,
            result.outcome as unknown as Json,
            { operationId, slot: "outcome" },
          );
          await record(tx, event, "succeeded", reference as unknown as Json);
        } else {
          await record(tx, event, result.status);
          if (result.status === "failed")
            await options.vault.release?.(workspace, operationId);
        }
        return resultFor(tx, latest(tx, operationId)!);
      });
    },
    async reconcileRecovery(
      workspace: string,
      operationId: string,
    ): Promise<RecoveryOutcome | { status: "unknown" }> {
      return options.journal.transaction(workspace, async (tx) => {
        const event = latest(tx, operationId);
        if (!event) throw new Error("Operation not found.");
        const data = event.data as unknown as {
          planDigest: string;
          receipt: VaultReference;
        };
        if (["restored", "compensated", "conflict"].includes(event.stage))
          return (await options.vault.get(
            workspace,
            data.receipt,
          )) as unknown as RecoveryOutcome;
        if (
          event.stage !== "recovery-dispatched" &&
          event.stage !== "recovery-unknown"
        )
          throw new Error("No uncertain recovery exists.");
        const adapter = adapterFor(event.adapterId, event.adapterVersion);
        if (!adapter.reconcileRecovery) return { status: "unknown" };
        await options.vault.reserve?.(workspace, operationId, ["recovery"]);
        const bundle = await loadPrepared(tx, event);
        const outcome = (await options.vault.get(
          workspace,
          artifact(tx, operationId, "succeeded"),
        )) as unknown as Outcome;
        const result = await adapter.reconcileRecovery(
          clean(bundle.prepared),
          clean(outcome),
          `recovery-${adapterKey(workspace, operationId)}`,
        );
        if (result.status === "unknown") return result;
        const receipt = await options.vault.put(
          workspace,
          result as unknown as Json,
          { operationId, slot: "recovery" },
        );
        await record(tx, event, result.status, {
          planDigest: data.planDigest,
          receipt: receipt as unknown as Json,
          reverses: operationId,
        });
        return result;
      });
    },
    async planRecovery(
      workspace: string,
      operationId: string,
    ): Promise<RecoveryPlan> {
      return options.journal.transaction(workspace, async (tx) => {
        const event = latest(tx, operationId);
        if (!event) throw new Error("Operation not found.");
        return planFor(tx, event);
      });
    },
    async planRecoveryJob(
      request: RecoveryJobRequest,
    ): Promise<RecoveryJobPlan> {
      const input = clean(request);
      if (!/^[\w-]{1,120}$/.test(input.jobId))
        throw new Error("Invalid recovery job identity.");
      // Every way a selection can be wrong is answered by the resolver, which
      // is a pure function of the journal state and names what a valid
      // selector looks like. What the runtime still owns is the identity of
      // the job the plan is for, because that is not the selector's business.
      if (!input.selection || typeof input.selection !== "object")
        throw new Error("Invalid recovery selection.");
      const recorded: RecoverySelector = input.selection;
      return options.journal.transaction(input.workspace, async (tx) => {
        const existing = jobPlan(tx.jobEvents ?? [], input.jobId);
        if (existing) {
          // A plan records the steps it undoes, not the rule that chose them,
          // so a selector the plan cannot store cannot be checked against it.
          // Re-resolving one later may reach different operations, and
          // re-planning under the same job id would approve a recovery nobody
          // signed.
          if (recorded.kind !== "run" && recorded.kind !== "operations")
            throw new Error(
              `Recovery job ${input.jobId} is already planned, and a ${recorded.kind} selector is not recorded in the plan, so this request cannot be proven to be the same one. Plan it under a new job id.`,
            );
          if (digest(existing.selection) !== digest(input.selection))
            throw new Error(
              "Recovery job identity belongs to another selection.",
            );
          validateRecoveryJobPlan(existing);
          return existing;
        }
        const records =
          tx.records ??
          (() => {
            throw new Error("Recovery job journal support is unavailable.");
          })();
        const head = records.at(-1);
        const boundary = {
          sequence: head?.sequence ?? 0,
          digest: head?.digest ?? "0".repeat(64),
        };
        const latestRecords = new Map<string, (typeof tx.records)[number]>();
        for (const record of records)
          if (record.event.schema === "void.operation.v1")
            latestRecords.set(record.event.operationId, record);
        // One pass over the journal, before any selector runs. A selector
        // orders and filters by journal position, and a provenance fact needs
        // the durable capture, so the capture is read here and kept instead of
        // being read again for whichever steps the plan turns out to contain.
        const facts = new Map<string, ProvenanceFact>();
        const operations: RecoveryOperationState[] = [];
        for (const [operationId, record] of latestRecords) {
          const event = record.event;
          if (event.schema !== "void.operation.v1") continue;
          let fact: ProvenanceFact;
          try {
            // The read and write sets come from the durable capture, not from
            // anything this transaction remembers, so the ordering survives a
            // restart and cannot be reconstructed after the fact.
            fact = provenanceOf(
              event.operationId,
              record.sequence,
              (await loadPrepared(tx, event)).observation,
            );
          } catch {
            // No capture means no claim either way. The step loop turns this
            // into an `unavailable` residual, and a dependency selector
            // refuses a root that recorded no reads rather than guessing at
            // the branch behind it.
            fact = {
              operationId: event.operationId,
              sequence: record.sequence,
              resources: [],
              reads: undefined,
            };
          }
          facts.set(event.operationId, fact);
          operations.push({
            operationId,
            sequence: record.sequence,
            at: event.at,
            runId: event.runId,
            fact,
          });
        }
        const state: RecoveryJournalState = { boundary, operations };
        const selection = resolveRecoverySelection(state, input.selection);
        if (selection.kind === "refused") throw new Error(selection.reason);
        // A plan stores the steps it undoes, so every selector lands on the two
        // recorded kinds. A rule that reached nothing has no list to store and
        // no true statement to record, which is the opposite of a `run`: an
        // empty run is recorded verbatim and stays a true one. The refusal says
        // the window was empty, because an operator who asked for one wants to
        // know that and not that their selector was malformed.
        const chosen: RecoverySelection =
          recorded.kind === "run" || recorded.kind === "operations"
            ? recorded
            : selection.operationIds.length
              ? { kind: "operations", operationIds: selection.operationIds }
              : (() => {
                  throw new Error(
                    `The ${recorded.kind} selector resolved to no operations before the boundary at sequence ${state.boundary.sequence}, and a plan records the steps it undoes rather than the rule that chose them. Name the operations instead.`,
                  );
                })();
        // A job that is applying, paused or in conflict is holding a step, and
        // anything provably joined to it by a recorded read has to wait rather
        // than be planned as though it were free.
        const jobEvents = tx.jobEvents ?? [];
        const blocked: string[] = [];
        for (const event of jobEvents)
          if (["applying", "paused", "conflict"].includes(event.stage)) {
            const plan = jobPlan(jobEvents, event.jobId);
            const step = plan?.steps[progressFrom(event, plan).checkpoint];
            if (step) blocked.push(step.operationId);
          }
        const branches = independentBranches(state, blocked);
        if (branches.kind === "refused") throw new Error(branches.reason);
        const held = new Set(
          branches.held.map((branch) => branch.operationId),
        );
        const steps: Array<{
          operationId: string;
          sequence: number;
          plan: RecoveryPlan;
        }> = [];
        const provenance: ProvenanceFact[] = [];
        const residuals: RecoveryResidual[] = selection.missing.map(
          (operationId) => ({ operationId, status: "missing" as const }),
        );
        for (const operationId of selection.operationIds) {
          const record = latestRecords.get(operationId);
          if (!record || record.event.schema !== "void.operation.v1") {
            residuals.push({ operationId, status: "missing" });
            continue;
          }
          const event = record.event;
          if (
            [
              "restored",
              "compensated",
              "conflict",
              "recovery-dispatched",
              "recovery-unknown",
            ].includes(event.stage)
          ) {
            const status =
              event.stage === "restored"
                ? "already-recovered"
                : event.stage === "compensated"
                  ? "compensated"
                  : event.stage === "conflict"
                    ? "conflict"
                    : "unknown";
            residuals.push({ operationId: event.operationId, status });
            continue;
          }
          if (event.stage !== "succeeded") {
            residuals.push({
              operationId: event.operationId,
              status: "not-successful",
            });
            continue;
          }
          if (held.has(event.operationId)) {
            // A branch joined to a step another job is holding is not free to
            // recover yet, and a plan that said nothing about that would be a
            // plan pretending the hold does not exist.
            residuals.push({
              operationId: event.operationId,
              status: "blocked-by-conflict",
            });
            continue;
          }
          try {
            // The plan first, then the fact. The ordering proof is over the
            // step set and nothing else, so a fact only enters it for an
            // operation that really became a step; otherwise an operation
            // whose capture could not be read would arrive at the ordering
            // proof as a claim of independence for a step that is not there.
            const plan = await planFor(tx, event);
            provenance.push(facts.get(event.operationId)!);
            steps.push({
              operationId: event.operationId,
              sequence: record.sequence,
              plan,
            });
          } catch (error) {
            residuals.push({
              operationId: event.operationId,
              status:
                error instanceof Error && error.message.includes("no verified")
                  ? "unsupported"
                  : "unavailable",
            });
          }
        }
        steps.sort((left, right) => right.sequence - left.sequence);
        // Reverse sequence is only safe when every step that read what another
        // step wrote is undone first. The recorded read and write sets prove it
        // or the plan is refused; nothing here reorders, because a plan whose
        // order cannot be proven is not a plan worth guessing at.
        const ordering = orderRecoverySteps(provenance);
        if (!ordering.safe)
          throw new Error(`Recovery job order is not provably safe: ${ordering.reason}.`);
        const plan = completeRecoveryJobPlan({
          schema: "void.recovery-plan.v1",
          workspace: input.workspace,
          jobId: input.jobId,
          selection: chosen,
          boundary,
          steps,
          residuals,
        });
        await recordJob(tx, plan, "planned", { plan: plan as unknown as Json });
        return plan;
      });
    },
    async recoveryJobStatus(
      workspace: string,
      jobId: string,
    ): Promise<RecoveryJobResult | RecoveryJobPlan> {
      return options.journal.transaction(workspace, async (tx) => {
        const plan = jobPlan(tx.jobEvents ?? [], jobId);
        if (!plan) throw new Error("Recovery job not found.");
        validateRecoveryJobPlan(plan);
        const event = latestJobEvent(tx.jobEvents ?? [], jobId);
        if (
          event &&
          ["restored", "partial", "conflict", "unknown", "paused"].includes(
            event.stage,
          )
        )
          return event.data as unknown as RecoveryJobResult;
        return plan;
      });
    },
    async runRecoveryJob(
      workspace: string,
      jobId: string,
      authorize: (plan: RecoveryJobPlan) => Promise<boolean>,
    ): Promise<RecoveryJobResult> {
      let plan!: RecoveryJobPlan;
      await options.journal.transaction(workspace, async (tx) => {
        plan =
          jobPlan(tx.jobEvents ?? [], jobId) ??
          (() => {
            throw new Error("Recovery job not found.");
          })();
        validateRecoveryJobPlan(plan);
        const event = latestJobEvent(tx.jobEvents ?? [], jobId)!;
        const records =
          tx.records ??
          (() => {
            throw new Error("Recovery job journal support is unavailable.");
          })();
        const boundaryRecord = records.find(
          (record) => record.sequence === plan.boundary.sequence,
        );
        if (
          plan.boundary.sequence === 0
            ? plan.boundary.digest !== "0".repeat(64) ||
              !records.some(
                (record) =>
                  record.sequence === 1 &&
                  record.event.schema === "void.recovery-job.v1" &&
                  record.event.jobId === jobId &&
                  record.event.stage === "planned",
              )
            : boundaryRecord?.digest !== plan.boundary.digest
        )
          throw new Error("Recovery job selection boundary is invalid.");
        if (["restored", "partial", "conflict"].includes(event.stage)) return;
        if (event.stage === "planned") {
          const latestJobs = new Map(
            (tx.jobEvents ?? []).map((candidate) => [
              candidate.jobId,
              candidate,
            ]),
          );
          // R06: another job blocks this workspace unless it is holding an
          // expired lease whose owner is provably gone. A live holder, an
          // unreadable lease and an absent lease all keep blocking, so the
          // failure mode is "no recovery" rather than "two recoveries".
          const blocking = [...latestJobs.values()].filter(
            (candidate) =>
              candidate.jobId !== jobId &&
              [
                "approved",
                "applying",
                "checkpoint",
                "unknown",
                "paused",
              ].includes(candidate.stage),
          );
          const reclaimable = blocking.filter((candidate) =>
            leaseVerdict(leaseOf(candidate.data)).reclaimable,
          );
          if (blocking.length > reclaimable.length)
            throw new Error(
              "Another recovery job is active in this workspace.",
            );
          const superseded: string[] = [];
          for (const stale of reclaimable) {
            // Record the supersession rather than silently proceeding, so the
            // history shows which job was displaced. Without its plan and
            // progress the job is not reclaimable: there would be nothing to
            // record, so the refusal stands.
            const stalePlan = jobPlan(tx.jobEvents ?? [], stale.jobId);
            if (stalePlan === undefined) {
              throw new Error("Another recovery job is active in this workspace.");
            }
            const staleProgress = progressFrom(
              latestJobEvent(tx.jobEvents ?? [], stale.jobId),
              stalePlan,
            );
            const step = stalePlan.steps[staleProgress.checkpoint];
            if (step === undefined) {
              throw new Error("Another recovery job is active in this workspace.");
            }
            await recordJob(
              tx,
              stalePlan,
              "paused",
              {
                ...staleProgress,
                pause: { code: "lease-expired", operationId: step.operationId },
              } as unknown as Json,
            );
            superseded.push(stale.jobId);
          }
          if (
            records.some(
              (record) =>
                record.sequence > plan.boundary.sequence &&
                record.event.schema === "void.operation.v1" &&
                record.event.stage === "received",
            )
          )
            throw new Error("Recovery job selection boundary is stale.");
          if (!(await authorize(clean(plan))))
            throw new Error("Recovery job was not authorized.");
          await recordJob(tx, plan, "approved", null);
        }
      });
      for (;;) {
        const state = await options.journal.transaction(
          workspace,
          async (tx) => {
            const event = latestJobEvent(tx.jobEvents ?? [], jobId)!;
            if (["restored", "partial", "conflict"].includes(event.stage))
              return {
                done: event.data as unknown as RecoveryJobResult,
              } as const;
            const storedProgress = progressFrom(event, plan);
            const progress =
              event.stage === "unknown"
                ? {
                    ...storedProgress,
                    residuals: storedProgress.residuals.filter(
                      (residual) =>
                        residual.status !== "unknown" ||
                        residual.operationId !==
                          plan.steps[storedProgress.checkpoint]?.operationId,
                    ),
                  }
                : storedProgress;
            if (progress.checkpoint === 0) {
              const records =
                tx.records ??
                (() => {
                  throw new Error(
                    "Recovery job journal support is unavailable.",
                  );
                })();
              const stale = records.some(
                (record) =>
                  record.sequence > plan.boundary.sequence &&
                  record.event.schema === "void.operation.v1" &&
                  record.event.stage === "received",
              );
              if (stale)
                throw new Error("Recovery job selection boundary is stale.");
            }
            if (
              event.stage === "approved" ||
              event.stage === "unknown" ||
              event.stage === "paused"
            )
              // R06: claim the lease before any step runs, so another worker can
              // tell an in-flight job from one whose holder died.
              await recordJob(tx, plan, "applying", {
                ...progress,
                lease: { holder: leaseHolder, expiresAt: Date.now() + leaseMs },
              } as unknown as Json);
            if (progress.checkpoint < plan.steps.length) {
              const step = plan.steps[progress.checkpoint]!;
              try {
                const operation = latest(tx, step.operationId);
                if (!operation) throw new Error("Operation not found.");
                adapterFor(operation.adapterId, operation.adapterVersion);
                await loadPrepared(tx, operation);
                await options.vault.get(
                  workspace,
                  artifact(tx, operation.operationId, "succeeded"),
                );
              } catch {
                const result: RecoveryJobResult = {
                  jobId,
                  status: "paused",
                  ...progress,
                  pause: {
                    code: "step-unavailable",
                    operationId: step.operationId,
                  },
                };
                await recordJob(tx, plan, "paused", result as unknown as Json);
                return { done: result } as const;
              }
            }
            if (progress.checkpoint >= plan.steps.length) {
              const result: RecoveryJobResult = {
                jobId,
                status:
                  progress.residuals.length === 0 ? "restored" : "partial",
                ...progress,
              };
              await recordJob(
                tx,
                plan,
                result.status,
                result as unknown as Json,
              );
              return { done: result } as const;
            }
            return {
              progress,
              step: plan.steps[progress.checkpoint]!,
            } as const;
          },
        );
        if ("done" in state) return state.done!;
        const outcome = await recoverOperation(
          state.step.plan,
          async () => true,
        );
        const terminal = await options.journal.transaction(
          workspace,
          async (tx) => {
            const current = progressFrom(
              latestJobEvent(tx.jobEvents ?? [], jobId),
              plan,
            );
            if (current.checkpoint > state.progress.checkpoint)
              return undefined;
            if (outcome.status === "unknown") {
              const result: RecoveryJobResult = {
                jobId,
                status: "unknown",
                ...current,
                residuals: [
                  ...current.residuals,
                  { operationId: state.step.operationId, status: "unknown" },
                ],
              };
              await recordJob(tx, plan, "unknown", result as unknown as Json);
              return result;
            }
            if (outcome.status === "conflict") {
              const residuals: RecoveryResidual[] = [
                ...current.residuals,
                { operationId: state.step.operationId, status: "conflict" },
                ...plan.steps.slice(current.checkpoint + 1).map((step) => ({
                  operationId: step.operationId,
                  status: "blocked-by-conflict" as const,
                })),
              ];
              const result: RecoveryJobResult = {
                jobId,
                status: "conflict",
                ...current,
                residuals,
              };
              await recordJob(tx, plan, "conflict", result as unknown as Json);
              return result;
            }
            const residuals =
              outcome.status === "compensated"
                ? [
                    ...current.residuals,
                    {
                      operationId: state.step.operationId,
                      status: "compensated" as const,
                    },
                  ]
                : current.residuals;
            // The lease is renewed at every step, so a job that is genuinely
            // working is never mistaken for one whose holder died.
            await recordJob(tx, plan, "checkpoint", {
              checkpoint: current.checkpoint + 1,
              outcomes: [
                ...current.outcomes,
                { operationId: state.step.operationId, status: outcome.status },
              ],
              residuals,
              lease: { holder: leaseHolder, expiresAt: Date.now() + leaseMs },
            } as unknown as Json);
            return undefined;
          },
        );
        if (terminal) return terminal;
      }
    },
    async recover(
      inputPlan: RecoveryPlan,
      authorize: (plan: RecoveryPlan) => Promise<boolean>,
    ): Promise<RecoveryOutcome | { status: "unknown" }> {
      const plan = JSON.parse(canonicalJson(inputPlan)) as RecoveryPlan;
      return options.journal.transaction(plan.workspace, async (tx) => {
        const event = latest(tx, plan.operationId);
        if (!event) throw new Error("Operation not found.");
        if (
          event.stage === "restored" ||
          event.stage === "compensated" ||
          event.stage === "conflict"
        ) {
          const reference = event.data as unknown as {
            planDigest: string;
            receipt: VaultReference;
          };
          if (reference.planDigest !== plan.digest)
            throw new Error("Recovery plan changed.");
          return (await options.vault.get(
            plan.workspace,
            reference.receipt,
          )) as unknown as RecoveryOutcome;
        }
        if (
          event.stage === "recovery-dispatched" ||
          event.stage === "recovery-unknown"
        )
          return { status: "unknown" };
        if (event.stage !== "succeeded")
          throw new Error("Operation is not ready for recovery.");
        const expected = digest({
          event,
          capture: artifact(tx, plan.operationId, "prepared"),
        });
        const bundle = await loadPrepared(tx, event);
        if (
          bundle.observation.readiness !== "verified" ||
          !["r0", "r1", "r2"].includes(bundle.observation.reversibility)
        )
          throw new Error("Operation has no verified recovery capability.");
        const actual = {
          workspace: plan.workspace,
          operationId: plan.operationId,
          digest: expected,
          scope: bundle.observation.scope,
          resources: bundle.observation.resources,
          reversibility: bundle.observation.reversibility,
        };
        if (digest(actual) !== digest(plan))
          throw new Error("Recovery plan changed.");
        if (!(await authorize(clean(actual))))
          throw new Error("Recovery was not authorized.");
        const adapter = adapterFor(event.adapterId, event.adapterVersion);
        const outcome = (await options.vault.get(
          plan.workspace,
          artifact(tx, plan.operationId, "succeeded"),
        )) as unknown as Outcome;
        await options.vault.reserve?.(plan.workspace, plan.operationId, [
          "recovery",
        ]);
        await record(tx, event, "recovery-dispatched", {
          planDigest: expected,
          reverses: event.operationId,
        });
        try {
          const result = await adapter.recover(
            clean(bundle.prepared),
            clean(outcome),
            `recovery-${adapterKey(plan.workspace, plan.operationId)}`,
          );
          const receipt = await options.vault.put(
            plan.workspace,
            result as unknown as Json,
            { operationId: plan.operationId, slot: "recovery" },
          );
          await record(tx, event, result.status, {
            planDigest: expected,
            receipt: receipt as unknown as Json,
            reverses: event.operationId,
          });
          return result;
        } catch {
          await record(tx, event, "recovery-unknown", {
            planDigest: expected,
            reverses: event.operationId,
          });
          return { status: "unknown" };
        }
      });
    },
  };
  recoverOperation = runtime.recover;
  return runtime;
}

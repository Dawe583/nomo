import { recoveryRuntime } from "../packages/runtime/src/execute.ts";
import {
  digest,
  validateJobTransition,
  validateTransition,
} from "../packages/runtime/src/journal.ts";
import { validateRecoveryJobPayload } from "../packages/runtime/src/recovery/plan.ts";
import { VaultCapacityError } from "../packages/runtime/src/vault.ts";
import { managedDocumentAdapter } from "../packages/workbench/src/managed-documents.ts";
import {
  createWorkspace,
  previewWorkspaceUndo,
} from "../packages/workbench/src/workspace.ts";
import { read, write, encrypt, decrypt, ledger, append } from "./store.mjs";
import { assertOwner } from "./owner.mjs";

const SLOT_BYTES = 4 * 1024 * 1024,
  CAPACITY = 64 * 1024 * 1024;
export const documentOperationId = (id) => digest(id);

/**
 * Surfaces that may authorize a managed document mutation. An agent is not on
 * this list and never can be: the identity is copied into the signed journal,
 * so a self-approval would falsify the audit trail that recovery and Undo are
 * built on. `public-demo` is the isolated public demo, which has no human
 * approval step by design and is therefore labelled truthfully rather than as
 * an approval.
 */
export const AUTHORIZED_WRITE_SURFACES = new Set([
  "web-operator",
  "public-demo",
]);

/** Only managed documents: caller holds the session transaction lock. Artifacts,
 * signed operation/job events and document state commit together inside the same
 * SQL transaction, including across process death. Local journal/result rows are
 * never the event source here; the cloud ledger entries are the persisted journal.
 * Never use this transaction host for external tools or network side effects. */
export async function cloudDocumentRuntime(
  owner,
  session,
  client,
  approvedBy = "web-operator",
) {
  assertOwner(owner);
  const workspace = session.workspace;
  const proof = await ledger(owner, workspace, client);
  const events = [];
  const jobEvents = [];
  for (const entry of proof.entries) {
    if (entry.body.runtimeEvent) {
      validateTransition(events, entry.body.runtimeEvent);
      events.push(entry.body.runtimeEvent);
    } else if (entry.body.runtimeJobEvent) {
      validateJobTransition(jobEvents, entry.body.runtimeJobEvent);
      validateRecoveryJobPayload(jobEvents, entry.body.runtimeJobEvent);
      jobEvents.push(entry.body.runtimeJobEvent);
    }
  }
  const records = [
    ...proof.entries
      .filter((entry) => entry.body.runtimeEvent)
      .map((entry) => ({
        event: entry.body.runtimeEvent,
        sequence: entry.seq,
        digest: entry.hash,
      })),
    ...proof.entries
      .filter((entry) => entry.body.runtimeJobEvent)
      .map((entry) => ({
        event: entry.body.runtimeJobEvent,
        sequence: entry.seq,
        digest: entry.hash,
      })),
  ].sort((left, right) => left.sequence - right.sequence);
  const journal = {
    transaction: async (scope, run) => {
      if (scope !== workspace) throw new Error("Recovery workspace mismatch.");
      return run({
        events,
        jobEvents,
        records,
        append: async (event) => {
          if (event.workspace !== workspace)
            throw new Error("Recovery workspace mismatch.");
          validateTransition(events, event);
          const signed = await append(
            owner,
            {
              workspace,
              at: event.at,
              tool: "nomo_recovery",
              klass: "r1",
              decision: `recovery:${event.stage}`,
              runtimeEvent: event,
            },
            client,
          );
          proof.entries.push(signed);
          events.push(event);
          records.push({
            event,
            sequence: signed.seq,
            digest: signed.hash,
          });
        },
        appendJob: async (event) => {
          if (event.workspace !== workspace)
            throw new Error("Recovery workspace mismatch.");
          validateJobTransition(jobEvents, event);
          validateRecoveryJobPayload(jobEvents, event);
          const signed = await append(
            owner,
            {
              workspace,
              at: event.at,
              tool: "nomo_recovery",
              klass: "r1",
              decision: `recovery:job:${event.stage}`,
              runtimeJobEvent: event,
            },
            client,
          );
          proof.entries.push(signed);
          jobEvents.push(event);
          records.push({
            event,
            sequence: signed.seq,
            digest: signed.hash,
          });
        },
      });
    },
  };
  const quotaKey = `recovery-quota:${session.id}`;
  const quota = (await read(owner, quotaKey, client)) ?? { bytes: 0, slots: {} };
  const saveQuota = () => write(owner, quotaKey, quota, client);
  const slotKey = (id, slot) => `${id}:${slot}`;
  const vault = {
    async reserve(scope, id, slots = ["capture", "outcome", "recovery"]) {
      if (scope !== workspace) throw new Error("Recovery workspace mismatch.");
      const missing = slots.filter((slot) => !quota.slots[slotKey(id, slot)]);
      if (quota.bytes + missing.length * SLOT_BYTES > CAPACITY)
        throw new VaultCapacityError("Cloud recovery quota exceeded.");
      for (const slot of missing)
        quota.slots[slotKey(id, slot)] = { reserved: true };
      quota.bytes += missing.length * SLOT_BYTES;
      await saveQuota();
    },
    async release(scope, id) {
      if (scope !== workspace) throw new Error("Recovery workspace mismatch.");
      for (const slot of ["capture", "outcome", "recovery"]) {
        const key = slotKey(id, slot);
        if (quota.slots[key]?.reserved) {
          delete quota.slots[key];
          quota.bytes -= SLOT_BYTES;
        }
      }
      await saveQuota();
    },
    async put(scope, value, allocation) {
      if (scope !== workspace || !allocation)
        throw new Error("Recovery allocation required.");
      const key = slotKey(allocation.operationId, allocation.slot);
      const bound = { workspace, value },
        hash = digest(bound);
      const previous = quota.slots[key];
      if (!previous) throw new Error("Missing recovery reservation.");
      if (!previous.reserved) {
        if (previous.digest !== hash)
          throw new Error("Recovery slot content changed.");
        return previous;
      }
      const encrypted = encrypt(bound),
        bytes = Buffer.byteLength(encrypted);
      if (bytes > SLOT_BYTES)
        throw new VaultCapacityError("Cloud recovery artifact exceeds quota.");
      const reference = { digest: hash, keyId: "cloud-v1", bytes };
      await write(owner, `recovery-artifact:${session.id}:${hash}`, encrypted, client);
      quota.bytes += bytes - SLOT_BYTES;
      quota.slots[key] = reference;
      await saveQuota();
      return reference;
    },
    async get(scope, reference) {
      if (scope !== workspace || reference.keyId !== "cloud-v1")
        throw new Error("Recovery workspace or key mismatch.");
      const stored = await read(
        owner,
        `recovery-artifact:${session.id}:${reference.digest}`,
        client,
      );
      if (!stored || Buffer.byteLength(stored) !== reference.bytes)
        throw new Error("Recovery artifact missing or changed.");
      const bound = decrypt(stored);
      if (bound.workspace !== workspace || digest(bound) !== reference.digest)
        throw new Error("Recovery artifact binding mismatch.");
      return bound.value;
    },
  };
  let state = await read(owner, `workspace:${session.id}`, client);
  state = state ? decrypt(state) : createWorkspace();
  const adapter = managedDocumentAdapter({
    read: async () => state,
    verify: async (operation) =>
      proof.entries.some(
        (e) =>
          e.body.operationId === operation.id &&
          e.body.captureDigest === digest(operation) &&
          e.body.decision === "execute:completed",
      ),
    commit: async (transition, input) => {
      const signed = await append(
        owner,
        {
          workspace,
          at: input.at,
          tool: input.name,
          klass: "r1",
          decision: "execute:completed",
          approvedBy,
          argsDigest: digest(input.arguments),
          operationId: transition.operation.id,
          captureDigest: digest(transition.operation),
          managedRuntimeOperationId: documentOperationId(
            input.arguments.operationId ?? input.id,
          ),
        },
        client,
      );
      proof.entries.push(signed);
      state = transition.state;
      await write(owner, `workspace:${session.id}`, encrypt(state), client);
    },
  });
  const runtime = recoveryRuntime({
    journal,
    vault,
    adapters: [adapter],
    // Fail closed. Returning false records a `denied` transition and dispatches
    // nothing, so an agent that somehow reaches this sink cannot forge the
    // `authorized` stage that the journal would otherwise attribute to it.
    authorize: async () => AUTHORIZED_WRITE_SURFACES.has(approvedBy),
  });
  return { runtime, state: () => state };
}

export async function mutateCloudDocument(owner, session, client, input, approvedBy) {
  const host = await cloudDocumentRuntime(owner, session, client, approvedBy);
  const result = await host.runtime.execute({
    workspace: session.workspace,
    operationId: documentOperationId(input.id),
    agentId: approvedBy ?? "web-operator",
    runId: session.generation === undefined ? session.id : `${session.id}:${session.generation}`,
    adapterId: "managed-documents",
    arguments: { ...input, at: input.at ?? new Date().toISOString() },
  });
  // Throw so the outer SQL transaction rolls back every state/artifact change.
  if (result.status !== "succeeded")
    throw new Error(`Managed document mutation ${result.status}.`);
  const state = host.state();
  return {
    state,
    result: result.result,
    operation: state.operations.find((op) => op.id === input.id),
  };
}

export async function managedCloudUndo(
  owner,
  session,
  client,
  operationId,
  previewOnly = false,
) {
  const proof = await ledger(owner, session.workspace, client);
  const marker = proof.entries.find(
    (e) =>
      e.body.operationId === operationId &&
      e.body.decision === "execute:completed",
  )?.body.managedRuntimeOperationId;
  if (!marker) return false; // Only genuinely legacy, unmarked records use legacy Undo.
  if (marker !== documentOperationId(operationId))
    throw new Error("Recovery marker mismatch.");
  const host = await cloudDocumentRuntime(owner, session, client);
  const status = await host.runtime.status(session.workspace, marker);
  if (!status) throw new Error("Managed recovery evidence is missing.");
  const preview = previewWorkspaceUndo(host.state(), operationId);
  if (status === "restored") {
    await host.runtime.reconcileRecovery(session.workspace, marker);
    return true;
  }
  if (!preview.canApply) {
    if (previewOnly) return true;
    throw new Error("Document changed. Undo newer changes first.");
  }
  const plan = await host.runtime.planRecovery(session.workspace, marker);
  if (!previewOnly) {
    const result = await host.runtime.recover(plan, async () => true);
    if (result.status !== "restored")
      throw new Error(`Managed document recovery ${result.status}.`);
  }
  return true;
}

/** Plan and run a retained recovery job for one exact run or an explicit operation
 * list. `session` supplies only the workspace/scope binding. The caller must hold
 * the session advisory lock and keep document state, artifacts, plan approval and
 * checkpoints inside the same outer SQL transaction. Job identity must be stable
 * across retries, so planning is load-or-create by job ID rather than caller bytes. */
const cloudJobOperationMapKey = (workspace, jobId) =>
  `recovery-job-operation-map:${workspace}:${jobId}`;

const presentCloudJob = (payload, operationMap) => {
  const external = (operationId) => operationMap[operationId] ?? operationId;
  return {
    ...payload,
    ...(payload.selection?.kind === "operations"
      ? {
          selection: {
            ...payload.selection,
            operationIds: payload.selection.operationIds.map(external),
          },
        }
      : {}),
    ...(payload.steps
      ? {
          steps: payload.steps.map((step) => ({
            ...step,
            operationId: external(step.operationId),
          })),
        }
      : {}),
    ...(payload.outcomes
      ? {
          outcomes: payload.outcomes.map((outcome) => ({
            ...outcome,
            operationId: external(outcome.operationId),
          })),
        }
      : {}),
    ...(payload.residuals
      ? {
          residuals: payload.residuals.map((residual) => ({
            ...residual,
            operationId: external(residual.operationId),
          })),
        }
      : {}),
  };
};

async function cloudJobOperationMap(owner, request, client, retainedOperationIds) {
  const key = cloudJobOperationMapKey(request.workspace, request.jobId);
  const stored = await read(owner, key, client);
  if (stored) return decrypt(stored);
  const operationIds = new Set(retainedOperationIds);
  if (request.selection.kind === "operations")
    for (const operationId of request.selection.operationIds)
      operationIds.add(operationId);
  const map = Object.fromEntries(
    [...operationIds].map((operationId) => [
      documentOperationId(operationId),
      operationId,
    ]),
  );
  await write(owner, key, encrypt(map), client);
  return map;
}

export async function planCloudRecoveryJob(owner, request, session, client) {
  const host = await cloudDocumentRuntime(owner, session, client);
  const operationMap = await cloudJobOperationMap(
    owner,
    request,
    client,
    host.state().operations.map((operation) => operation.id),
  );
  const selection =
    request.selection.kind === "operations"
      ? {
          kind: "operations",
          operationIds: request.selection.operationIds.map(documentOperationId),
        }
      : request.selection;
  const plan = await host.runtime.planRecoveryJob({ ...request, selection });
  return presentCloudJob(plan, operationMap);
}

/**
 * Apply one already-planned retained job. `approve` is the operator binding for
 * the whole stored plan digest; it is asked once, before application starts. The
 * caller stays in the same outer SQL transaction: signed checkpoints accumulate in
 * the ledger while the document adapter commits recovered state and receipts
 * atomically. A thrown setup error returns a redacted paused job without repeating
 * a confirmed inverse; reconcile one uncertain operation, then run the same job ID
 * again. Forward writes remain blocked outside this helper: `execute.ts` refuses
 * new operations while a retained job has not reached a terminal stage.
 */
export async function runCloudRecoveryJob(owner, session, client, jobId, approve) {
  const host = await cloudDocumentRuntime(owner, session, client);
  const result = await host.runtime.runRecoveryJob(
    session.workspace,
    jobId,
    approve,
  );
  const stored = await read(
    owner,
    cloudJobOperationMapKey(session.workspace, jobId),
    client,
  );
  return presentCloudJob(result, stored ? decrypt(stored) : {});
}

/**
 * Return the stored job plan below a terminal result, or the latest terminal
 * result when `runRecoveryJob` has already completed, conflicts, stayed unknown
 * or paused. No caller-supplied plan bytes are accepted.
 */
export async function cloudRecoveryJobStatus(owner, session, client, jobId) {
  const host = await cloudDocumentRuntime(owner, session, client);
  const status = await host.runtime.recoveryJobStatus(session.workspace, jobId);
  const stored = await read(
    owner,
    cloudJobOperationMapKey(session.workspace, jobId),
    client,
  );
  return status && presentCloudJob(status, stored ? decrypt(stored) : {});
}

export async function cloudRecoveryJobPlanDigest(owner, session, client, jobId) {
  const proof = await ledger(owner, session.workspace, client);
  return proof.entries.find(entry =>
    entry.body.runtimeJobEvent?.jobId === jobId &&
    entry.body.runtimeJobEvent.stage === "planned"
  )?.body.runtimeJobEvent.planDigest;
}

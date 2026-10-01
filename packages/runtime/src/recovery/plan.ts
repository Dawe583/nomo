import { canonicalJson } from "../../../ledger/src/canonical.ts";
import { digest } from "../digest.ts";
import type { RecoveryPlan } from "../execute.ts";
import {
  orderRecoverySteps,
  provenanceEdges,
  type ProvenanceFact,
} from "./provenance.ts";

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
  pause?: { code: RecoveryJobPauseCode; operationId: string };
  /** Set only when a verified lease takeover displaces this paused job. */
  supersededBy?: string;
};
/**
 * The two reasons a job stops, and the only two a reader may see. A step the
 * adapter cannot run right now is `step-unavailable` and is the operator's to
 * fix; a lease whose holder died is `lease-expired` and was written by another
 * worker that took the job over. They are one closed set because the payload
 * validator below is the only gate a signed, replayed journal passes through,
 * and a code it does not know makes an honest event unreadable.
 */
export const RECOVERY_PAUSE_CODES = [
  "step-unavailable",
  "lease-expired",
] as const;
export type RecoveryJobPauseCode = (typeof RECOVERY_PAUSE_CODES)[number];
/**
 * What a job request asks for: either an exact selection, or a rule the
 * resolver turns into one. The two are not the same thing and the difference
 * is why the recorded plan keeps `RecoverySelection`:
 *
 * - A request says what the operator asked for. A rule is convenient and is
 *   resolved against the journal at plan time.
 * - A plan records what it will undo, as a selection, and its digest binds
 *   that. Storing the rule would bind a decision that can reach different
 *   operations the next time it is resolved, so re-planning an existing job
 *   ID through a rule selector is refused: "is this the same request?" has no
 *   true answer to compare against.
 * - A rule that resolves to nothing is refused at the boundary, because a
 *   recorded plan has no honest way to say "this selector matched no
 *   operation". An exact `run` selection is unaffected: it is recorded
 *   verbatim, and a run that has done nothing yet is a zero step plan.
 */
export type RecoveryJobSelection = RecoverySelection | RecoverySelector;
export type RecoveryJobRequest = {
  workspace: string;
  jobId: string;
  selection: RecoveryJobSelection;
};


/**
 * R06: choosing which operations a plan undoes.
 *
 * Until now the only question a plan could ask was "this run" or "these
 * operations", and the answer came back in descending journal order. That is
 * one ordering, not a choice: an operator who wants the branch that produced a
 * value, or everything before a point in time, or the work up to a checkpoint,
 * had to name every step by hand.
 *
 * A selector is a request, not a plan. It resolves to the exact operation IDs
 * the existing `RecoverySelection` already stores, so a signed plan still
 * records which steps it undoes rather than the rule that chose them, and its
 * digest still binds that list. Re-resolving a selector later may reach
 * different operations, and a plan that recorded the selector instead of the
 * list would silently approve a different recovery.
 *
 * Everything here is a pure function of the journal state the caller hands
 * over, so a selector can be proven without a runtime, a journal or a lease.
 */
export type RecoverySelector =
  | { readonly kind: "run"; readonly runId: string }
  | { readonly kind: "operations"; readonly operationIds: readonly string[] }
  | { readonly kind: "dependencies"; readonly operationIds: readonly string[] }
  | { readonly kind: "time"; readonly before: string; readonly after?: string }
  | { readonly kind: "checkpoint"; readonly sequence: number };

export const RECOVERY_SELECTOR_KINDS = [
  "run",
  "operations",
  "dependencies",
  "time",
  "checkpoint",
] as const;

/** One operation the selectors can see: its journal position, its wall clock
 * time, and the provenance its capture recorded. */
export type RecoveryOperationState = {
  readonly operationId: string;
  readonly sequence: number;
  readonly at: string;
  readonly runId: string;
  readonly fact: ProvenanceFact;
};

export type RecoveryJournalState = {
  /** The head the caller would sign as the plan boundary. */
  readonly boundary: RecoveryBoundary;
  /** One entry per operation, no operation twice. */
  readonly operations: readonly RecoveryOperationState[];
};

export type RecoverySelectionResult =
  | {
      readonly kind: "resolved";
      /** The operations to undo, in the order they have to be undone. */
      readonly operationIds: readonly string[];
      /** Named operations the journal does not contain. */
      readonly missing: readonly string[];
    }
  | SelectorRefusal;

export type HeldBranch = {
  readonly operationId: string;
  readonly blocked: string;
  readonly resource: string;
  readonly reason: string;
};

export type BranchSelection =
  | {
      readonly kind: "resolved";
      /** Provably unconnected to every blocked operation, so still selectable. */
      readonly independent: readonly string[];
      /** Recorded no reads, so no edge either way; reported, never claimed. */
      readonly unproven: readonly string[];
      readonly held: readonly HeldBranch[];
    }
  | SelectorRefusal;

/** Every selector answers with a reason instead of a fallback: a named
 * precondition the caller did not meet is the only thing that stops it. */
export type SelectorRefusal = { readonly kind: "refused"; readonly reason: string };

const UTC_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;

function refused(reason: string): SelectorRefusal {
  return {
    kind: "refused",
    reason: `${reason} Valid recovery selector kinds are ${RECOVERY_SELECTOR_KINDS.join(", ")}.`,
  };
}

function instant(value: unknown): value is string {
  return typeof value === "string" && UTC_INSTANT.test(value) && Number.isFinite(Date.parse(value));
}

function uniqueIdentities(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every((id) => identity(id)) &&
    new Set(value).size === value.length
  );
}

function hasExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, at) => key === wanted[at]);
}

type IndexedState =
  | { readonly kind: "indexed"; readonly byId: Map<string, RecoveryOperationState> }
  | SelectorRefusal;

/** One state entry per operation, or a refusal: a state that names an
 * operation twice has two journal positions for one step, and no ordering of
 * it is honest. */
function index(state: RecoveryJournalState): IndexedState {
  const byId = new Map<string, RecoveryOperationState>();
  for (const operation of state.operations) {
    if (
      !identity(operation.operationId) ||
      !Number.isSafeInteger(operation.sequence) ||
      operation.sequence < 0
    )
      return refused(
        "Recovery journal state carries an operation with no usable identity or sequence.",
      );
    if (byId.has(operation.operationId))
      return refused(
        `Recovery journal state names ${operation.operationId} more than once; one operation appears once.`,
      );
    byId.set(operation.operationId, operation);
  }
  return { kind: "indexed", byId };
}

function ordered(
  operations: Iterable<RecoveryOperationState>,
): readonly string[] {
  return [...operations]
    .sort((left, right) =>
      right.sequence - left.sequence || left.operationId.localeCompare(right.operationId),
    )
    .map((operation) => operation.operationId);
}

/**
 * Resolve a selector against the journal state. Every way this can go wrong
 * ends in a refusal naming what a valid selector looks like: an unknown kind,
 * a malformed field, an instant the journal cannot be ordered against, a
 * checkpoint past the boundary or a dependency closure that cannot be proven
 * are all answers this function refuses to guess.
 */
export function resolveRecoverySelection(
  state: RecoveryJournalState,
  selector: unknown,
): RecoverySelectionResult {
  if (typeof selector !== "object" || selector === null || Array.isArray(selector))
    return refused("A recovery selector must be an object.");
  const value = selector as Record<string, unknown>;
  const indexed = index(state);
  if (indexed.kind === "refused") return indexed;
  const byId = indexed.byId;
  switch (value.kind) {
    case "run": {
      if (!hasExactKeys(value, ["kind", "runId"]))
        return refused('A "run" selector takes exactly a runId.');
      const runId = value.runId;
      if (typeof runId !== "string" || !/^[\w:-]{1,120}$/.test(runId))
        return refused("A run selector needs a runId of word characters, colons or dashes.");
      // A run that has done nothing yet is a real answer, not a malformed
      // request: an empty journal has nothing to undo, and refusing it would
      // make the tidier rule cost a legitimate path.
      return {
        kind: "resolved",
        operationIds: ordered(
          state.operations.filter((operation) => operation.runId === runId),
        ),
        missing: [],
      };
    }
    case "operations": {
      if (!hasExactKeys(value, ["kind", "operationIds"]))
        return refused('An "operations" selector takes exactly operationIds.');
      if (!uniqueIdentities(value.operationIds))
        return refused("An operations selector needs a non-empty list of unique operation IDs.");
      const requested = value.operationIds;
      return {
        kind: "resolved",
        operationIds: ordered(
          requested.flatMap((id) => {
            const operation = byId.get(id);
            return operation ? [operation] : [];
          }),
        ),
        missing: requested.filter((id) => !byId.has(id)),
      };
    }
    case "dependencies": {
      if (!hasExactKeys(value, ["kind", "operationIds"]))
        return refused('A "dependencies" selector takes exactly operationIds.');
      if (!uniqueIdentities(value.operationIds))
        return refused("A dependencies selector needs a non-empty list of unique operation IDs.");
      const roots = value.operationIds;
      const absent = roots.filter((id) => !byId.has(id));
      if (absent.length > 0)
        return refused(
          `A dependencies selector names ${absent.join(", ")}, which this journal does not contain, so the branch behind it cannot be resolved.`,
        );
      // The selector promises the whole branch, which only a recorded read set
      // can support. A root that read nothing proved nothing about what it
      // depends on, and silently returning it alone is the one answer that
      // turns a dependency selector back into a name lookup.
      const blind = roots.filter((id) => byId.get(id)!.fact.reads === undefined);
      if (blind.length > 0)
        return refused(
          `A dependencies selector needs a recorded read set; ${blind.join(", ")} recorded none, so the branch cannot be proven.`,
        );
      const producers = new Map<string, string[]>();
      for (const edge of provenanceEdges(state.operations.map((operation) => operation.fact))) {
        const upstream = producers.get(edge.consumer);
        if (upstream) upstream.push(edge.producer);
        else producers.set(edge.consumer, [edge.producer]);
      }
      const branch = new Set<string>();
      const walk = (id: string): void => {
        if (branch.has(id)) return;
        branch.add(id);
        for (const producer of producers.get(id) ?? []) walk(producer);
      };
      for (const root of roots) walk(root);
      const selected = state.operations.filter((operation) => branch.has(operation.operationId));
      const ordering = orderRecoverySteps(selected.map((operation) => operation.fact));
      if (!ordering.safe)
        return refused(
          `A dependencies selector selected a branch whose order is not provably safe: ${ordering.reason}.`,
        );
      return { kind: "resolved", operationIds: ordered(selected), missing: [] };
    }
    case "time": {
      const bounds = value.after === undefined ? ["kind", "before"] : ["kind", "before", "after"];
      if (!hasExactKeys(value, bounds))
        return refused('A "time" selector takes a before instant and an optional after instant.');
      if (!instant(value.before))
        return refused(
          `A time selector needs a UTC instant in before, for example 2026-09-26T12:00:00.000Z; ${JSON.stringify(value.before)} is not one.`,
        );
      if (value.after !== undefined && !instant(value.after))
        return refused(
          `A time selector needs a UTC instant in after, for example 2026-09-26T12:00:00.000Z; ${JSON.stringify(value.after)} is not one.`,
        );
      const before = Date.parse(value.before);
      const after = value.after === undefined ? undefined : Date.parse(value.after);
      if (after !== undefined && after >= before)
        return refused(
          `A time selector needs after earlier than before; ${value.after} is not earlier than ${value.before}.`,
        );
      // An operation whose instant the journal cannot order is not a step this
      // selector may skip: dropping it would recover everything except the one
 // operation the caller most likely wanted back.
      const unorderable = state.operations.filter((operation) => !instant(operation.at));
      if (unorderable.length > 0)
        return refused(
          `A time selector cannot order ${unorderable.map((operation) => operation.operationId).join(", ")}, which recorded no UTC instant.`,
        );
      return {
        kind: "resolved",
        operationIds: ordered(
          state.operations.filter((operation) => {
            const at = Date.parse(operation.at);
            return at <= before && (after === undefined || at > after);
          }),
        ),
        missing: [],
      };
    }
    case "checkpoint": {
      if (!hasExactKeys(value, ["kind", "sequence"]))
        return refused('A "checkpoint" selector takes exactly a journal sequence.');
      const sequence = value.sequence;
      if (typeof sequence !== "number" || !Number.isSafeInteger(sequence) || sequence < 0)
        return refused(
          `A checkpoint selector needs a journal sequence of zero or more; ${JSON.stringify(sequence)} is not one.`,
        );
      if (sequence > state.boundary.sequence)
        return refused(
          `A checkpoint selector cannot name sequence ${sequence}; this journal ends at the boundary at ${state.boundary.sequence}.`,
        );
      return {
        kind: "resolved",
        operationIds: ordered(
          state.operations.filter((operation) => operation.sequence <= sequence),
        ),
        missing: [],
      };
    }
    default:
      return refused(
        `${JSON.stringify(value.kind)} is not a recovery selector kind.`,
      );
  }
}

/**
 * Which branches survive while `blocked` is stopped, conflicting or in
 * progress. Independence is the same edge the ordering proof uses, so this
 * cannot disagree with `orderRecoverySteps` about what depends on what: a
 * branch is held when a proven edge joins it to a blocked operation in either
 * direction, because a consumer read what the blocked step wrote and a
 * producer must be restored after the consumer that read it.
 *
 * A step that recorded no reads has no edge either way. It is reported as
 * unproven instead of being called independent, so the gap is visible rather
 * than reported as a branch that was proven safe.
 */
export function independentBranches(
  state: RecoveryJournalState,
  blocked: readonly string[],
): BranchSelection {
  const indexed = index(state);
  if (indexed.kind === "refused") return indexed;
  const byId = indexed.byId;
  const stopped = new Set(blocked);
  const absent = blocked.filter((id) => !byId.has(id));
  if (absent.length > 0)
    return {
      kind: "refused",
      reason: `Continuation cannot start: ${absent.join(", ")} is blocked but this journal does not contain it, so what it holds is unknown.`,
    };
  const held = new Map<string, HeldBranch>();
  for (const edge of provenanceEdges(state.operations.map((operation) => operation.fact))) {
    const consumerStopped = stopped.has(edge.consumer);
    const producerStopped = stopped.has(edge.producer);
    if (consumerStopped === producerStopped) continue;
    if (consumerStopped && !held.has(edge.producer))
      held.set(edge.producer, {
        operationId: edge.producer,
        blocked: edge.consumer,
        resource: edge.resource,
        reason: `${edge.consumer} read ${edge.resource} from ${edge.producer}, so ${edge.producer} must be restored after it`,
      });
    if (producerStopped && !held.has(edge.consumer))
      held.set(edge.consumer, {
        operationId: edge.consumer,
        blocked: edge.producer,
        resource: edge.resource,
        reason: `${edge.consumer} read ${edge.resource} from ${edge.producer}, which is blocked or in progress`,
      });
  }
  const continuing = state.operations.filter(
    (operation) => !stopped.has(operation.operationId) && !held.has(operation.operationId),
  );
  return {
    kind: "resolved",
    independent: ordered(continuing.filter((operation) => operation.fact.reads !== undefined)),
    unproven: ordered(continuing.filter((operation) => operation.fact.reads === undefined)),
    held: state.operations
      .filter((operation) => held.has(operation.operationId))
      .map((operation) => held.get(operation.operationId)!),
  };
}

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
  expected: readonly string[],
  name: string,
): void {
  if (!hasExactKeys(value, expected))
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
      ? [
          "jobId",
          "status",
          "checkpoint",
          "outcomes",
          "residuals",
          "pause",
          ...(data.supersededBy === undefined ? [] : ["supersededBy"]),
        ]
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
        !RECOVERY_PAUSE_CODES.includes(pause.code as RecoveryJobPauseCode) ||
        pause.operationId !== plan.steps[checkpoint]?.operationId
      )
        throw new Error("Invalid recovery job pause.");
      if (
        data.supersededBy !== undefined &&
        (typeof data.supersededBy !== "string" || data.supersededBy.length === 0)
      )
        throw new Error("Invalid recovery job supersession.");
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

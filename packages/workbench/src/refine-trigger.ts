/**
 * When the harness is allowed to spend a model call on learning.
 *
 * This is a port of the consumption order in `prime-src`
 * (`crates/pa-core/src/session_engine/auto_refine_trigger.rs`), and the port is
 * deliberate: that file already gets the sequencing right, and the sequencing is
 * the whole safety property. Three rules are copied because each one has a
 * specific way of failing when it is left to the caller.
 *
 * **Gates first, then review, then work.** `cheapGate` decides before anything
 * is spent. Only an approving review runs a refinement. A gate checked after the
 * review would have saved nothing.
 *
 * **Every attempt stamps the cooldown, including the ones that failed.** This
 * is the rule most worth copying and the easiest to get wrong. `prime-src`
 * states it plainly: a persistent failure must not retry a full review at every
 * boundary, because "every boundary" on a failing provider is an unbounded bill.
 * A naive implementation stamps only on success, and a provider that is down
 * then becomes the most expensive possible configuration.
 *
 * **A branch move invalidates a round in flight.** The review resolved against a
 * conversation that no longer exists, so its edits must never surface. The
 * subtle half is what that round must *not* do: it must not stamp the moved-to
 * branch's cooldown and must not reset its settled-turn count, because a stale
 * round has nothing to say about the new branch and throttling it would suppress
 * learning on the branch that is actually live.
 *
 * Nothing here calls a model and nothing here writes. The state is plain data so
 * it can be reasoned about, and the effect is expressed as a value the caller
 * carries out.
 *
 * The storable form of that data lives here too (`persistTriggerState` and
 * `restoreTriggerState`), because a snapshot written by one shape and read by
 * another is a cooldown that silently disappears. The cooldown has to survive a
 * restart: a state kept only in memory made "stop the process and start it
 * again" a way to buy a free review.
 */

import { verifyArm, type ArmAxis, type HarnessArm } from "./harness-arms.ts";
import {
  guardrailRegressionGate,
  type GuardrailGate,
  type SplitSummary,
} from "./harness-scores.ts";

/** What one round did. `not-run` means nothing was spent.
 *
 * There is deliberately no `deferred` variant. One existed and nothing ever
 * constructed it: a gate that is merely not ready already leaves the trigger
 * and the counter alone, which is what deferral means. */
export type RoundOutcome =
  | { readonly kind: "not-run"; readonly reason: string }
  | { readonly kind: "declined"; readonly reason: string }
  | { readonly kind: "ran"; readonly instructions: string }
  | { readonly kind: "failed"; readonly error: unknown };

/** The reviewer, injected so this module never reaches for a model itself. */
export type ReviewVerdict =
  | { readonly approve: true; readonly instructions: string }
  | { readonly approve: false; readonly reason: string };

export type Reviewer = (instructions: string) => Promise<ReviewVerdict>;

export type TriggerState = {
  /** A compaction armed the trigger. */
  pending: boolean;
  /** The operator asked for a review by hand. Kept apart from `pending`
   * because the two say different things: `pending` means a boundary arrived
   * with the interval already waited out, while a manual request is precisely
   * the statement that the interval has not elapsed. The gate reads this flag
   * separately, and only a held refusal keeps it. */
  manualReviewRequested: boolean;
  /** Settled, non-error turns since the last review attempt. */
  settledTurnsSinceReview: number;
  /** Milliseconds since the last attempt, or null. */
  lastReviewAt: number | null;
  /** A round is in flight; a second is never joined. */
  inFlight: boolean;
  /** Bumped on every branch move. A round that started on an older value is
   * discarded rather than applied. */
  branchVersion: number;
  /** An approving review retained behind an active turn, so the next boundary
   * can act on it without a second model call. */
  pendingReview: string | null;
};

export function initialTriggerState(): TriggerState {
  return {
    pending: false,
    manualReviewRequested: false,
    settledTurnsSinceReview: 0,
    lastReviewAt: null,
    inFlight: false,
    branchVersion: 0,
    pendingReview: null,
  };
}

/**
 * A branch move drops the armed trigger, a manual request and any retained
 * review, and bumps the version so a round already in flight can tell it
 * belongs to an abandoned conversation.
 *
 * The retained review is dropped rather than carried over on purpose: it was an
 * approval of a trajectory that no longer exists, and approving a different one
 * by proxy is not a smaller mistake than skipping the review entirely. A manual
 * request is dropped for the same reason: it named a conversation, and that
 * conversation is gone.
 */
export function onBranchMove(state: TriggerState): TriggerState {
  return {
    pending: false,
    manualReviewRequested: false,
    settledTurnsSinceReview: state.settledTurnsSinceReview,
    lastReviewAt: state.lastReviewAt,
    inFlight: state.inFlight,
    branchVersion: state.branchVersion + 1,
    pendingReview: null,
  };
}

/** Arm the trigger, as a successful compaction does. */
export function arm(state: TriggerState): TriggerState {
  return { ...state, pending: true };
}

/**
 * Ask for a review now, as `/harness review` does.
 *
 * It sets the manual flag and deliberately not `pending`: `pending` is a
 * compaction's claim that a settled-turn boundary arrived, and reusing it here
 * would have a manual request claim the threshold it exists to bypass. The
 * gate consults the flag on its own, so the two arms stay distinguishable.
 */
export function requestManualReview(state: TriggerState): TriggerState {
  return { ...state, manualReviewRequested: true };
}

/** Count one settled turn. Called by the caller on turn boundaries. */
export function recordSettledTurn(state: TriggerState): TriggerState {
  if (state.settledTurnsSinceReview < Number.MAX_SAFE_INTEGER) {
    return { ...state, settledTurnsSinceReview: state.settledTurnsSinceReview + 1 };
  }
  return state;
}

export type ServiceResult = {
  readonly state: TriggerState;
  readonly outcome: RoundOutcome;
  /** The version this round started on. A caller carrying out a `ran` outcome
   * must re-check it before writing anything. */
  readonly startedAtBranchVersion: number | null;
};

/**
 * Run one boundary: decide, and if a round is warranted, run it.
 *
 * `decide` is the gate from `refine-gate.ts`, injected so this file holds no
 * knowledge about thresholds and the two can be tested apart.
 *
 * The two exits that do *not* stamp the cooldown are the interesting ones and
 * are both deliberate. A gate that is merely not ready (`cheapGate` said
 * `held: true`) leaves the trigger and the counter alone, so evidence survives
 * to a later boundary. And a round that lost its branch is discarded without
 * stamping, because stamping would throttle a branch it never saw.
 */
export async function serviceTrigger(
  state: TriggerState,
  decide: (state: TriggerState) => { proceed: true; instructions: string } | { proceed: false; reason: string; held: boolean },
  review: Reviewer,
  options: {
    readonly now: () => number;
    readonly run?: (instructions: string, branchVersion: number) => Promise<void>;
    /**
     * The session's current branch version, read live.
     *
     * This exists because the equivalent check in `prime-src` reads a mutex the
     * round can see change while it awaits, and there is no equivalent here
     * without it: `state` is the value this function was handed and comparing
     * `state.branchVersion` to itself can never fail. A branch moved during an
     * await would then apply its edits to a conversation that no longer exists,
     * so the check has to be a read of something that can actually change.
     *
     * A caller with no branches to move may omit it; the round then behaves as
     * if the branch never moved, which is the correct reading of a session that
     * has one.
     */
    readonly currentBranchVersion?: () => number;
  },
): Promise<ServiceResult> {
  const decision = decide(state);
  // Read the branch through the caller's accessor rather than off `state`.
  // `state` is the snapshot taken before the first await and cannot change under
  // us, so comparing `state.branchVersion` to itself would never fire -- the
  // guard would pass on exactly the case it exists to catch.
  const branchNow = options.currentBranchVersion ?? ((): number => state.branchVersion);

  if (!decision.proceed) {
    if (!decision.held) {
      // The settings changed or the surface cannot hold state. Clear the
      // trigger so it does not sit armed waiting for a gate that will never
      // open. A manual request goes with it: keeping it would have the
      // operator's request outlive the answer that it cannot be served.
      return {
        state: { ...state, pending: false, pendingReview: null, manualReviewRequested: false },
        outcome: { kind: "not-run", reason: decision.reason },
        startedAtBranchVersion: null,
      };
    }
    return { state, outcome: { kind: "not-run", reason: decision.reason }, startedAtBranchVersion: null };
  }

  // A retained review was already paid for. Act on it without asking again.
  if (state.pendingReview !== null) {
    const instructions = state.pendingReview;
    const version = state.branchVersion;
    if (branchNow() !== version)
      return {
        state,
        outcome: { kind: "not-run", reason: "branch moved before the retained review could run" },
        startedAtBranchVersion: version,
      };
    const running: TriggerState = { ...state, inFlight: true, pending: false, pendingReview: null, manualReviewRequested: false };
    try {
      await options.run?.(instructions, version);
    } catch (error) {
      // A failed *run* on a retained approval keeps the approval for a retry
      // after the cooldown, and stamps the cooldown. The approval is not
      // discarded: it was earned.
      return {
        state: {
          ...running,
          inFlight: false,
          lastReviewAt: options.now(),
          settledTurnsSinceReview: 0,
          pendingReview: instructions,
        },
        outcome: { kind: "failed", error },
        startedAtBranchVersion: version,
      };
    }
    if (branchNow() !== version) {
      // The branch moved while the run was in flight. Its writes never land,
      // and its cooldown must not be stamped on the branch it never ran against.
      return {
        state: { ...running, inFlight: false },
        outcome: { kind: "not-run", reason: "branch moved during the run" },
        startedAtBranchVersion: version,
      };
    }
    return {
      state: { ...running, inFlight: false, lastReviewAt: options.now(), settledTurnsSinceReview: 0 },
      outcome: { kind: "ran", instructions },
      startedAtBranchVersion: version,
    };
  }

  const version = state.branchVersion;
  if (branchNow() !== version)
    return {
      state,
      outcome: { kind: "not-run", reason: "branch moved before the review could start" },
      startedAtBranchVersion: version,
    };
  const running: TriggerState = { ...state, inFlight: true, pending: false, manualReviewRequested: false };

  let reviewed: Awaited<ReturnType<Reviewer>>;
  try {
    reviewed = await review(decision.instructions);
  } catch (error) {
    // The important line. A failed review stamps the cooldown, because a
    // provider that is down would otherwise be re-asked at every boundary.
    return {
      state: {
        ...running,
        inFlight: false,
        lastReviewAt: options.now(),
        settledTurnsSinceReview: 0,
      },
      outcome: { kind: "failed", error },
      startedAtBranchVersion: version,
    };
  }

  if (branchNow() !== version) {
    // The review answered about a conversation that has been abandoned. Its
    // verdict is about that conversation, and its cooldown has no bearing on
    // this one.
    return {
      state: { ...running, inFlight: false },
      outcome: { kind: "not-run", reason: "branch moved during the review" },
      startedAtBranchVersion: version,
    };
  }

  if (!reviewed.approve) {
    return {
      state: {
        ...running,
        inFlight: false,
        lastReviewAt: options.now(),
        settledTurnsSinceReview: 0,
      },
      outcome: { kind: "declined", reason: reviewed.reason },
      startedAtBranchVersion: version,
    };
  }

  try {
    await options.run?.(reviewed.instructions, version);
  } catch (error) {
    return {
      state: {
        ...running,
        inFlight: false,
        lastReviewAt: options.now(),
        settledTurnsSinceReview: 0,
      },
      outcome: { kind: "failed", error },
      startedAtBranchVersion: version,
    };
  }

  return {
    state: {
      ...running,
      inFlight: false,
      lastReviewAt: options.now(),
      settledTurnsSinceReview: 0,
    },
    outcome: { kind: "ran", instructions: reviewed.instructions },
    startedAtBranchVersion: version,
  };
}

/**
 * One trigger state as it is stored.
 *
 * Field for field the in-memory shape, with one deliberate difference in
 * meaning rather than in type: a stored `inFlight: true` is a record that a
 * round never finished, not a claim that one is running. `restoreTriggerState`
 * explains what that buys and what it costs.
 */
export type PersistedTriggerState = {
  readonly pending: boolean;
  readonly manualReviewRequested: boolean;
  readonly settledTurnsSinceReview: number;
  readonly lastReviewAt: number | null;
  /** Recorded as it stood. Never trusted as a live round on the way back in. */
  readonly inFlight: boolean;
  readonly branchVersion: number;
  readonly pendingReview: string | null;
};

/**
 * The storable form of one state.
 *
 * Written field by field rather than spread, so a field added to `TriggerState`
 * later has to be given a persistence decision instead of entering the snapshot
 * silently. A field that is stored without a restore rule is a field that
 * quietly becomes its default on the next start.
 */
export function persistTriggerState(state: TriggerState): PersistedTriggerState {
  return {
    pending: state.pending,
    manualReviewRequested: state.manualReviewRequested,
    settledTurnsSinceReview: state.settledTurnsSinceReview,
    lastReviewAt: state.lastReviewAt,
    inFlight: state.inFlight,
    branchVersion: state.branchVersion,
    pendingReview: state.pendingReview,
  };
}

/** A non-negative safe integer, or zero. A count this process wrote is never
 * negative, fractional or beyond the safe range, so one that is cannot be
 * trusted as a count and must not become a negative turn budget. */
function count(value: unknown): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : 0;
}

/**
 * One stored state, validated, with the two normalisations a restart needs.
 *
 * **A stored `inFlight: true` means the round never finished.** The process
 * died between arming the round and writing its outcome back, so there is no
 * round in flight to protect: restoring the flag would hold the `in-flight`
 * refusal for the whole life of the next process and the gate would never open
 * again. It is restored as `false`, and the review gate is re-entered from the
 * timing facts below instead.
 *
 * **The interrupted round stamps the cooldown.** Its review may already have
 * been paid for, and a restart must not buy a second one; the rule that every
 * attempt stamps the cooldown, including a failed one, applies to an attempt
 * the process died in the middle of. The cost is a delayed review after a
 * crash, which is the direction this repository is willing to be wrong in.
 *
 * A stored timestamp in the future is treated the same way, for the same
 * reason: it cannot be a real attempt time, and trusting it would hold the gate
 * shut until the clock caught up. Clamping it to `now` keeps a full cooldown
 * in force instead of an indefinite one.
 *
 * An entry that exists but whose timestamp cannot be read becomes `now` rather
 * than `null`: `null` is a free review, and a record that cannot be parsed is
 * not evidence that nothing was spent. A value that is not a state at all
 * returns `undefined`, so a caller can tell a corrupt record from an empty one.
 */
export function restoreTriggerState(
  value: unknown,
  now: number,
): TriggerState | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return undefined;
  const record = value as Record<string, unknown>;
  const stored =
    typeof record.lastReviewAt === "number" && Number.isFinite(record.lastReviewAt)
      ? record.lastReviewAt
      : record.lastReviewAt === null
        ? null
        : now;
  const interrupted = record.inFlight === true;
  return {
    pending: record.pending === true,
    manualReviewRequested: record.manualReviewRequested === true,
    settledTurnsSinceReview: count(record.settledTurnsSinceReview),
    lastReviewAt:
      interrupted || (stored !== null && stored > now) ? now : stored,
    inFlight: false,
    branchVersion: count(record.branchVersion),
    pendingReview: typeof record.pendingReview === "string" ? record.pendingReview : null,
  };
}

export type RestoredTriggerStates = {
  readonly states: Map<string, TriggerState>;
  /**
   * True when storing what was read back would not reproduce the snapshot: an
   * entry was dropped, normalised, or belonged to a session that is gone. The
   * caller writes the cleaned snapshot once, so a repair is not repeated on
   * every start.
   */
  readonly changed: boolean;
};

/**
 * Every stored state, keyed by session, validated one entry at a time.
 *
 * A trigger belongs to a session. An entry whose session no longer exists is
 * not state about anything the product can act on, and keeping it would grow
 * the snapshot for the life of the workspace, so it is dropped rather than
 * carried.
 */
export function restoreTriggerStates(
  value: unknown,
  now: number,
  liveSessions: ReadonlySet<string>,
): RestoredTriggerStates {
  const states = new Map<string, TriggerState>();
  if (value === undefined) return { states, changed: false };
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return { states, changed: true };
  let changed = false;
  for (const [id, raw] of Object.entries(value as Record<string, unknown>)) {
    const state = restoreTriggerState(raw, now);
    if (state === undefined || !liveSessions.has(id)) {
      changed = true;
      continue;
    }
    states.set(id, state);
    if (JSON.stringify(persistTriggerState(state)) !== JSON.stringify(raw))
      changed = true;
  }
  return { states, changed };
}

/* ------------------------------------------------------------------------- *
 * Activation and rollback (H5), and activation from a sampled arm (R5).
 *
 * Pure decisions, like the trigger above: nothing here writes the chain. The
 * caller carries out an approval or a rollback through the workbench, which
 * records it signed. A bandit arm is a contextual-bandit choice, not trained
 * policy; nothing here is reinforcement learning.
 * ------------------------------------------------------------------------- */

/** A proposal digest (64 hex) or an arm digest (`sha256:` + 64 hex). */
const ACTIVATION_DIGEST = /^(?:sha256:)?[a-f0-9]{64}$/;

export type ActivationDecision =
  | { readonly activate: true; readonly digest: string }
  | { readonly activate: false; readonly reason: string };

/**
 * Activation requires the operator to type the exact digest: no prefix, no
 * trimming, no case folding, because a near match is an approval of something
 * nobody read. A digest already rolled back is refused by name, so a variant
 * that regressed returns only as a new proposal with a new digest.
 */
export function activationGate(
  digest: string,
  typed: unknown,
  rolledBack: ReadonlySet<string>,
): ActivationDecision {
  if (!ACTIVATION_DIGEST.test(digest))
    return { activate: false, reason: "The activation target has no well-formed digest." };
  if (typeof typed !== "string" || typed.length === 0)
    return { activate: false, reason: "Type the full digest to activate." };
  if (typed !== digest)
    return { activate: false, reason: "The typed digest does not match exactly. Type the full digest." };
  if (rolledBack.has(digest))
    return {
      activate: false,
      reason: `${digest} was rolled back. Re-activation needs a new proposal with a new digest.`,
    };
  return { activate: true, digest };
}

/** Every digest a signed rollback record names, read from ledger bodies. */
export function rolledBackDigests(
  entries: readonly { readonly body: unknown }[],
): ReadonlySet<string> {
  const digests = new Set<string>();
  for (const entry of entries) {
    const body = entry.body as Record<string, unknown> | null;
    const refinement = body?.harnessRefinement as Record<string, unknown> | null | undefined;
    if (typeof refinement?.rolledBackDigest === "string") digests.add(refinement.rolledBackDigest);
  }
  return digests;
}

export type GuardrailRollback = {
  /** `rolled-back`: a measured guardrail got worse and the rollback ran.
   * `kept`: every guardrail measured and none worse. `insufficient-data`: no
   * measured regression, but a guardrail is unmeasured; nothing is rolled back
   * on missing evidence, and nothing is called a pass either. */
  readonly action: "rolled-back" | "kept" | "insufficient-data";
  readonly digest: string;
  readonly gate: GuardrailGate;
};

/**
 * Roll an activation back when any measured guardrail regressed against the
 * previous activation (H8's gate, no noise band). `rollback` is the one
 * command, injected so the workbench writes the signed record; a failure
 * propagates rather than reporting a rollback that did not happen.
 */
export async function rollbackOnGuardrailRegression(
  digest: string,
  previous: Readonly<Record<string, SplitSummary | undefined>>,
  current: Readonly<Record<string, SplitSummary | undefined>>,
  rollback: (digest: string) => Promise<unknown>,
): Promise<GuardrailRollback> {
  const gate = guardrailRegressionGate(previous, current);
  if (gate.checks.some((check) => check.status === "regressed")) {
    await rollback(digest);
    return { action: "rolled-back", digest, gate };
  }
  return { action: gate.pass ? "kept" : "insufficient-data", digest, gate };
}

export type ArmActivationDecision =
  | {
      readonly activate: true;
      readonly armId: string;
      readonly axis: ArmAxis;
      readonly value: number | string;
      readonly digest: string;
    }
  | { readonly activate: false; readonly reason: string };

/**
 * Activate the arm a bandit sampled (R5). The activation names the arm and its
 * digest, the arm must recompute its own digest, and the typed digest goes
 * through `activationGate` like any other activation, so a rolled-back arm
 * needs a new digest too.
 */
export function activateSampledArm(
  arms: readonly HarnessArm[],
  sampledArmId: string | null,
  typed: unknown,
  rolledBack: ReadonlySet<string>,
): ArmActivationDecision {
  if (sampledArmId === null)
    return { activate: false, reason: "No arm was sampled; the search has stopped or never started." };
  const arm = arms.find((candidate) => candidate.armId === sampledArmId);
  if (!arm) return { activate: false, reason: `Unknown arm ${sampledArmId}.` };
  if (!verifyArm(arm))
    return { activate: false, reason: `Arm ${arm.armId} does not verify against its digest.` };
  const gate = activationGate(arm.digest, typed, rolledBack);
  if (!gate.activate) return gate;
  return { activate: true, armId: arm.armId, axis: arm.axis, value: arm.value, digest: arm.digest };
}

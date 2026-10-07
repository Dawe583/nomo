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
 */

/** Why a round ended, or that none ran. */
/** What one round did. `not-run` means nothing was spent. */
export type RoundOutcome =
  | { readonly kind: "not-run"; readonly reason: string }
  | { readonly kind: "deferred"; readonly instructions: string }
  | { readonly kind: "declined"; readonly reason: string }
  | { readonly kind: "ran"; readonly instructions: string }
  | { readonly kind: "failed"; readonly error: unknown };

/** The reviewer, injected so this module never reaches for a model itself. */
export type ReviewVerdict =
  | { readonly approve: true; readonly instructions: string }
  | { readonly approve: false; readonly reason: string };

export type Reviewer = (instructions: string) => Promise<ReviewVerdict>;

export type TriggerState = {
  /** A compaction or a manual request armed the trigger. */
  pending: boolean;
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
    settledTurnsSinceReview: 0,
    lastReviewAt: null,
    inFlight: false,
    branchVersion: 0,
    pendingReview: null,
  };
}

/**
 * A branch move drops the armed trigger and any retained review, and bumps the
 * version so a round already in flight can tell it belongs to an abandoned
 * conversation.
 *
 * The retained review is dropped rather than carried over on purpose: it was an
 * approval of a trajectory that no longer exists, and approving a different one
 * by proxy is not a smaller mistake than skipping the review entirely.
 */
export function onBranchMove(state: TriggerState): TriggerState {
  return {
    pending: false,
    settledTurnsSinceReview: state.settledTurnsSinceReview,
    lastReviewAt: state.lastReviewAt,
    inFlight: state.inFlight,
    branchVersion: state.branchVersion + 1,
    pendingReview: null,
  };
}

/** Arm the trigger, as a successful compaction or a manual request does. */
export function arm(state: TriggerState): TriggerState {
  return { ...state, pending: true };
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
 * The three exits that do *not* stamp the cooldown are the interesting ones and
 * are all deliberate. A gate that is merely not ready (`cheapGate` said
 * `held: true`) leaves the trigger and the counter alone, so evidence survives
 * to a later boundary. A deferred review is retained without stamping, because
 * it has not been acted on yet. And a round that lost its branch is discarded
 * without stamping, because stamping would throttle a branch it never saw.
 */
export async function serviceTrigger(
  state: TriggerState,
  decide: (state: TriggerState) => { proceed: true; instructions: string } | { proceed: false; reason: string; held: boolean },
  review: Reviewer,
  options: {
    readonly now: () => number;
    readonly run?: (instructions: string) => Promise<void>;
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
      // open.
      return {
        state: { ...state, pending: false, pendingReview: null },
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
    const running: TriggerState = { ...state, inFlight: true, pending: false, pendingReview: null };
    try {
      await options.run?.(instructions);
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
  const running: TriggerState = { ...state, inFlight: true, pending: false };

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
    await options.run?.(reviewed.instructions);
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
 * Whether a round's result may still be applied.
 *
 * A caller that wrote something based on a round must call this first. It is the
 * same check the trigger makes internally, exposed because the caller is the one
 * holding the writes.
 */
export function resultIsCurrent(state: TriggerState, startedAtBranchVersion: number | null): boolean {
  return startedAtBranchVersion !== null && state.branchVersion === startedAtBranchVersion;
}
import test from "node:test";
import assert from "node:assert/strict";

import {
  arm,
  initialTriggerState,
  onBranchMove,
  recordSettledTurn,
  requestManualReview,
  serviceTrigger,
  type RoundOutcome,
  type TriggerState,
} from "./refine-trigger.ts";

/** A gate that always proceeds, so the trigger is tested on its own. */
const GO = { proceed: true as const, instructions: "" };
/** A gate that declines but holds the trigger. */
const WAIT = { proceed: false as const, reason: "under-cooldown", held: true };
/** A gate that declines and clears the trigger. */
const STOP = { proceed: false as const, reason: "disabled", held: false };

const approve = { approve: true as const, instructions: "add the lesson" };
const decline = { approve: false as const, reason: "one-off noise" };

const clock = (ms = 1_000) => {
  let now = 0;
  return () => {
    now += ms;
    return now;
  };
};

/** A state that is armed, past the gate, and not in flight. */
function ready(over: Partial<TriggerState> = {}): TriggerState {
  return { ...initialTriggerState(), pending: true, ...over };
}

test("an armed trigger runs a review and, on approval, the pass", async () => {
  const result = await serviceTrigger(
    ready(),
    () => GO,
    async () => approve,
    { now: clock(), run: async () => {} },
  );
  assert.equal(result.outcome.kind, "ran");
  assert.equal(result.state.inFlight, false);
  assert.ok(result.state.lastReviewAt !== null);
});

test("every attempt stamps the cooldown, and that includes a failure", async () => {
  // The rule that is easiest to get wrong and most expensive to get wrong. A
  // provider that throws on every call would otherwise be asked on every
  // boundary, and "every boundary" on a failing provider is an unbounded bill.
  const result = await serviceTrigger(
    ready(),
    () => GO,
    async () => {
      throw new Error("provider down");
    },
    { now: clock() },
  );
  assert.equal(result.outcome.kind, "failed");
  assert.ok(
    result.state.lastReviewAt !== null,
    "a failed review must still cost a cooldown, or it retries forever",
  );
  assert.equal(result.state.settledTurnsSinceReview, 0);
});

test("a decline stamps the cooldown too", async () => {
  const result = await serviceTrigger(
    ready(),
    () => GO,
    async () => decline,
    { now: clock() },
  );
  assert.equal(result.outcome.kind, "declined");
  assert.ok(result.state.lastReviewAt !== null);
});

test("a gate that holds leaves the trigger and the counter alone", async () => {
  const state = ready({ settledTurnsSinceReview: 7 });
  let asked = false;
  const result = await serviceTrigger(
    state,
    () => WAIT,
    async () => {
      asked = true;
      return approve;
    },
    { now: clock() },
  );
  assert.equal(result.outcome.kind, "not-run");
  assert.equal(asked, false, "a held gate must not reach the model");
  assert.equal(result.state.pending, true, "the evidence survives to a later boundary");
  assert.equal(result.state.settledTurnsSinceReview, 7);
});

test("a gate that stops clears the trigger and any retained approval", async () => {
  const state = ready({ pendingReview: "retained" });
  const result = await serviceTrigger(state, () => STOP, async () => approve, { now: clock() });
  assert.equal(result.state.pending, false);
  assert.equal(result.state.pendingReview, null);
});

test("a manual request is not a pending trigger", () => {
  // `pending` means a compaction armed the trigger. A manual request says the
  // opposite thing about the settled-turn threshold, so it gets its own flag
  // and the gate reads it separately.
  const state = requestManualReview(initialTriggerState());
  assert.equal(state.manualReviewRequested, true);
  assert.equal(state.pending, false);
});

test("a held refusal keeps the manual request for the next boundary", async () => {
  const state = requestManualReview(ready({ pending: false }));
  const held = await serviceTrigger(state, () => WAIT, async () => approve, { now: clock() });
  assert.equal(held.outcome.kind, "not-run");
  assert.equal(held.state.manualReviewRequested, true);

  const served = await serviceTrigger(held.state, () => GO, async () => approve, {
    now: clock(),
    run: async () => {},
  });
  assert.equal(served.outcome.kind, "ran");
});

test("a settled outcome consumes the manual request", async () => {
  for (const [reviewer, expected] of [
    [async () => approve, "ran"],
    [async () => decline, "declined"],
    [async () => {
      throw new Error("provider down");
    }, "failed"],
  ] as const) {
    const state = requestManualReview(ready({ pending: false }));
    const result = await serviceTrigger(state, () => GO, reviewer, {
      now: clock(),
      run: async () => {},
    });
    assert.equal(result.outcome.kind, expected);
    assert.equal(result.state.manualReviewRequested, false);
  }
});

test("a stopped gate clears the manual request, a branch move drops it", async () => {
  // Both cases leave nothing that could still run: the gate will never open,
  // or the conversation it was about no longer exists.
  const stopped = await serviceTrigger(
    requestManualReview(ready({ pending: false })),
    () => STOP,
    async () => approve,
    { now: clock() },
  );
  assert.equal(stopped.state.manualReviewRequested, false);

  const moved = onBranchMove(requestManualReview(ready({ pending: false })));
  assert.equal(moved.manualReviewRequested, false);
});

test("a manual round discarded by a branch move clears the flag and stamps nothing", async () => {
  let version = 0;
  const result = await serviceTrigger(
    requestManualReview(ready({ pending: false })),
    () => GO,
    async () => {
      version = 1;
      return approve;
    },
    { now: clock(), run: async () => {}, currentBranchVersion: () => version },
  );
  assert.equal(result.outcome.kind, "not-run");
  assert.equal(result.state.manualReviewRequested, false);
  assert.equal(result.state.lastReviewAt, null);
});

test("the in-flight guard releases after every outcome", async () => {
  // A guard that stayed set would stop the next boundary from ever starting.
  for (const reviewer of [
    async () => approve,
    async () => decline,
    async () => {
      throw new Error("x");
    },
  ]) {
    const result = await serviceTrigger(ready(), () => GO, reviewer, { now: clock() });
    assert.equal(result.state.inFlight, false);
  }
});

test("a round already on a stale branch is rejected before requesting review", async () => {
  let asked = 0;
  const result = await serviceTrigger(
    ready(),
    () => GO,
    async () => {
      asked += 1;
      return approve;
    },
    { now: clock(), currentBranchVersion: () => 1 },
  );

  assert.equal(result.outcome.kind, "not-run");
  assert.equal(asked, 0);
  assert.equal(result.state.lastReviewAt, null);
});

test("a branch move discards a round that resolved against the old conversation", async () => {
  let version = 0;
  const result = await serviceTrigger(
    ready(),
    () => GO,
    async () => {
      // The branch moves while the review is in flight. This is only visible to
      // the round through the accessor, because `state` it was handed is a
      // snapshot from before the await.
      version = 1;
      return approve;
    },
    { now: clock(), currentBranchVersion: () => version },
  );
  // Its verdict is about a conversation that no longer exists.
  assert.equal(result.outcome.kind, "not-run");
});

test("a stale round stamps no cooldown on the branch it never saw", async () => {
  // The subtle half. Stamping here would throttle the branch that replaced the
  // abandoned one, suppressing learning on the branch that is actually live.
  let version = 0;
  const result = await serviceTrigger(
    ready(),
    () => GO,
    async () => {
      // The move happens while the review is in flight, which is the only
      // window in which the round can be holding a stale answer.
      version = 1;
      return approve;
    },
    { now: clock(), run: async () => {}, currentBranchVersion: () => version },
  );
  // No cooldown, because stamping one would throttle the branch that replaced
  // the abandoned one -- suppressing learning where learning is still wanted.
  assert.equal(result.state.lastReviewAt, null);
  // The returned state carries the version the round *started* on; the caller
  // owns the branch, so the check that matters is against the state the caller
  // holds after its own move. Applying the round's writes would be applying a
  // verdict about a conversation that no longer exists.
  assert.equal(result.startedAtBranchVersion, 0);
  assert.notEqual(1, result.startedAtBranchVersion, "a moved branch must not accept the round's writes");
});

test("a retained approval runs without asking again", async () => {
  let asked = false;
  const result = await serviceTrigger(
    ready({ pendingReview: "already paid for" }),
    () => GO,
    async () => {
      asked = true;
      return approve;
    },
    { now: clock(), run: async () => {} },
  );
  assert.equal(result.outcome.kind, "ran");
  assert.equal(asked, false, "it was paid for once already");
});

test("a failed run on a retained approval keeps the approval for a retry", async () => {
  // The approval was earned; a run that failed does not un-earn it. It is kept
  // behind the cooldown, which is what stops it retrying on every boundary.
  const result = await serviceTrigger(
    ready({ pendingReview: "retained" }),
    () => GO,
    async () => approve,
    {
      now: clock(),
      run: async () => {
        throw new Error("write failed");
      },
    },
  );
  assert.equal(result.outcome.kind, "failed");
  assert.equal(result.state.pendingReview, "retained");
  assert.ok(result.state.lastReviewAt !== null);
});

test("a branch move drops a retained approval", async () => {
  // It was granted against a trajectory that no longer exists, and approving a
  // different one by proxy is not a smaller mistake than skipping the review.
  const moved = onBranchMove(ready({ pendingReview: "retained" }));
  assert.equal(moved.pendingReview, null);
  assert.equal(moved.branchVersion, 1);
});

test("a branch move bumps the version and invalidates a result", async () => {
  const before = ready();
  const result = await serviceTrigger(before, () => GO, async () => approve, { now: clock() });
  assert.equal(result.state.branchVersion, result.startedAtBranchVersion);
  const after = onBranchMove(result.state);
  // The same version no longer applies, so a caller holding those writes must
  // not apply them.
  assert.notEqual(after.branchVersion, result.startedAtBranchVersion);
});


test("the settled-turn counter advances and then stops at the safe ceiling", () => {
  // The counter is what the turn interval is measured against, and the
  // saturation branch is the one that stops a long-lived session from
  // wrapping into a negative count and opening the gate early.
  let state = recordSettledTurn(initialTriggerState());
  assert.equal(state.settledTurnsSinceReview, 1);
  state = recordSettledTurn(state);
  assert.equal(state.settledTurnsSinceReview, 2);
  const saturated = recordSettledTurn({
    ...state,
    settledTurnsSinceReview: Number.MAX_SAFE_INTEGER,
  });
  assert.equal(saturated.settledTurnsSinceReview, Number.MAX_SAFE_INTEGER);
});

test("an outcome with no round reports no version, so nothing can be applied", async () => {
  const result = await serviceTrigger(ready(), () => WAIT, async () => approve, {
    now: clock(),
  });
  assert.equal(result.outcome.kind, "not-run");
  assert.equal(result.startedAtBranchVersion, null);
  assert.equal(result.startedAtBranchVersion, null, "nothing ran, so there is nothing to apply");
});

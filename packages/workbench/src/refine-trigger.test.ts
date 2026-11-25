import test from "node:test";
import assert from "node:assert/strict";

import {
  arm,
  initialTriggerState,
  onBranchMove,
  persistTriggerState,
  recordSettledTurn,
  requestManualReview,
  restoreTriggerState,
  restoreTriggerStates,
  serviceTrigger,
  type RoundOutcome,
  type TriggerState,
} from "./refine-trigger.ts";
import { cheapGate, type GateDecision } from "./refine-gate.ts";
import type { HarnessEntry } from "./learned-harness.ts";
import { isolatedWorkbench } from "./test-fixture.ts";

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

/* ------------------------------------------------------------------------- *
 * Persistence: the cooldown has to survive a restart.
 *
 * The gate these tests consult is the real one, not a stub, because the claim
 * being proved is about the refusal the product shows: a restart that forgets
 * the cooldown is a free review, and "free review" is a statement about
 * `cheapGate` answering `under-cooldown`.
 * ------------------------------------------------------------------------- */

/** The production defaults, spelled out so a test cannot pass by inheriting a
 * cooldown of zero from somewhere else. */
const GATES = { enabled: true, turnInterval: 1, cooldownMs: 20 * 60_000 } as const;

const candidate: HarnessEntry = {
  id: "entry-1",
  kind: "lesson",
  scope: "workspace",
  tool: "shell",
  klass: "r1",
  title: "a repeated approval",
  content: "the operator approved the same call twice",
  derivedFromSeq: [1],
  repeats: 2,
  createdAt: new Date(0).toISOString(),
};

/** The gate, fed exactly as the runtime feeds it. */
function decide(state: TriggerState, now: number): GateDecision {
  return cheapGate({
    gates: GATES,
    pending: state.pending,
    hasPendingReview: state.pendingReview !== null,
    inFlight: state.inFlight,
    manual: state.manualReviewRequested,
    settledTurns: state.settledTurnsSinceReview,
    msSinceLastReview: state.lastReviewAt === null ? null : now - state.lastReviewAt,
    candidates: [candidate],
    harnessStateAvailable: true,
    surface: "checkpoint",
  });
}

/** A stored state, through real JSON, so the round trip is the stored one and
 * not an object identity that never left the process. */
function roundTrip(state: TriggerState): unknown {
  return JSON.parse(JSON.stringify(persistTriggerState(state)));
}

test("a cooldown survives a restart and still refuses under-cooldown", () => {
  const now = 10_000_000;
  const before = ready({ settledTurnsSinceReview: 40, lastReviewAt: now - 60_000 });
  const restored = restoreTriggerState(roundTrip(before), now);
  assert.ok(restored, "a stored state must come back, or the restart bought a review");
  assert.equal(restored.lastReviewAt, before.lastReviewAt);
  assert.equal(restored.pending, true);
  assert.equal(restored.settledTurnsSinceReview, 40);

  const decision = decide(restored, now);
  assert.equal(decision.proceed, false);
  assert.equal(
    decision.reason,
    "under-cooldown",
    "a restart inside the cooldown must not reopen the gate",
  );
  assert.equal(decision.held, true, "the armed trigger survives the refusal");

  // And the stamp is a delay, not a wedge: once the cooldown really elapses the
  // same restored state is allowed to spend.
  const after = now + GATES.cooldownMs;
  assert.equal(decide(restored, after).proceed, true);
});

test("a stale inFlight is not restored as in flight, and pays the cooldown", () => {
  // The process died while a round was running. Restoring the flag would hold
  // `in-flight` for the life of the next process, and the gate would never
  // open again; dropping it without a stamp would let the restart buy the
  // review the crashed round may already have paid for. The state comes back
  // not in flight, with a fresh cooldown.
  const now = 20_000_000;
  const crashed = ready({
    settledTurnsSinceReview: 40,
    inFlight: true,
    lastReviewAt: now - 24 * 60 * 60_000,
  });
  const restored = restoreTriggerState(roundTrip(crashed), now);
  assert.ok(restored);
  assert.equal(restored.inFlight, false, "a crash must not wedge the gate on in-flight forever");
  assert.equal(restored.lastReviewAt, now, "the interrupted round costs a cooldown");

  const decision = decide(restored, now);
  assert.equal(decision.proceed, false);
  assert.equal(decision.reason, "under-cooldown");
  assert.notEqual(decision.reason, "in-flight", "nothing is running after a restart");
});

test("a corrupt timestamp becomes now, never a free review", () => {
  // `null` means "no attempt", so an unreadable record that became `null`
  // would be the one shape of damage that opens the gate. It costs a cooldown
  // instead.
  const now = 5_000_000;
  for (const lastReviewAt of ["yesterday", 0 / 0, Number.POSITIVE_INFINITY, {}, undefined]) {
    const restored = restoreTriggerState(
      { ...persistTriggerState(ready()), lastReviewAt },
      now,
    );
    assert.ok(restored);
    assert.equal(restored.lastReviewAt, now, `a ${String(lastReviewAt)} stamp was trusted`);
    const decision = decide(restored, now);
    assert.equal(decision.proceed, false);
    assert.equal(decision.reason, "under-cooldown");
  }
  // A timestamp in the future is not a real attempt time either. Trusting it
  // would hold the gate shut until the clock caught up, so it is clamped to
  // one full cooldown from now.
  const future = restoreTriggerState(
    { ...persistTriggerState(ready()), lastReviewAt: now + 86_400_000 },
    now,
  );
  assert.ok(future);
  assert.equal(future.lastReviewAt, now);
});

test("counts and flags that are not what this process writes fall back safely", () => {
  const now = 7_000_000;
  const restored = restoreTriggerState(
    {
      pending: "yes",
      manualReviewRequested: 1,
      settledTurnsSinceReview: -3,
      lastReviewAt: null,
      inFlight: false,
      branchVersion: 1.5,
      pendingReview: 42,
    },
    now,
  );
  assert.ok(restored);
  assert.equal(restored.pending, false);
  assert.equal(restored.manualReviewRequested, false);
  assert.equal(restored.settledTurnsSinceReview, 0, "a negative turn count must not open the gate");
  assert.equal(restored.branchVersion, 0);
  assert.equal(restored.pendingReview, null);
  assert.equal(restored.lastReviewAt, null, "an explicit null is a real 'no attempt'");

  // Not a state at all is a different answer from an empty one: the caller has
  // to be able to tell a corrupt record from a workspace that never stored one.
  for (const value of [null, 42, "state", [1, 2]]) {
    assert.equal(restoreTriggerState(value, now), undefined);
  }
});

test("restored entries are keyed by session, and a gone session's entry is dropped", () => {
  const now = 8_000_000;
  const live = ready({ lastReviewAt: now - 1_000 });
  const snapshot = {
    live: JSON.parse(JSON.stringify(persistTriggerState(live))),
    gone: JSON.parse(JSON.stringify(persistTriggerState(ready({ pendingReview: "stale" })))),
    corrupt: "not a state",
  };

  const restored = restoreTriggerStates(snapshot, now, new Set(["live"]));
  assert.deepEqual([...restored.states.keys()], ["live"]);
  assert.equal(restored.states.get("live")!.lastReviewAt, live.lastReviewAt);
  assert.equal(restored.changed, true, "a dropped entry is a repair the caller must write back");

  // A snapshot that needs no repair is reported as unchanged, so a start does
  // not rewrite the store for nothing.
  const clean = restoreTriggerStates(
    { live: JSON.parse(JSON.stringify(persistTriggerState(live))) },
    now,
    new Set(["live"]),
  );
  assert.equal(clean.changed, false);
  assert.equal(clean.states.size, 1);
  // No key at all is not a repair: a workspace written before this existed has
  // nothing to clean.
  assert.deepEqual(restoreTriggerStates(undefined, now, new Set()), {
    states: new Map(),
    changed: false,
  });
});

/* ------------------------------------------------------------------------- *
 * The same claim through the real store: a restart inside the cooldown
 * refuses, and a crashed round neither wedges the gate nor buys a review.
 * ------------------------------------------------------------------------- */

/** Counts model calls, so "no free review" is a measurement and not a reading
 * of the note. */
function countingFetcher() {
  let calls = 0;
  const fetcher = async (url: unknown) => {
    if (String(url).endsWith("/models"))
      return Response.json({ data: [{ id: "fixture" }] });
    calls += 1;
    return Response.json({
      choices: [{ message: { role: "assistant", content: "Ready" }, finish_reason: "stop" }],
    });
  };
  return { fetcher, calls: () => calls };
}

type TriggerInternals = {
  harnessTriggers: Map<string, TriggerState>;
  persist(): void;
};

async function triggerFixture(t: { after(fn: () => Promise<void>): void }) {
  const counter = countingFetcher();
  const f = await isolatedWorkbench(t, counter.fetcher, {}, {
    prefix: "nomo-trigger-persist-",
  });
  const session = await f.app.start("Review the workspace", "fixture");
  await f.app.settled();
  const internals = f.app as unknown as TriggerInternals;
  return {
    f,
    session,
    calls: counter.calls,
    /** Writes a state the way a previous process would have left it. */
    seed(state: TriggerState) {
      internals.harnessTriggers.set(session.id, state);
      internals.persist();
    },
    async restart() {
      await f.app.shutdown();
      const reopened = f.restart({ keepOpen: true });
      return {
        app: reopened,
        triggers: (reopened as unknown as TriggerInternals).harnessTriggers,
      };
    },
  };
}

test("a restart inside the cooldown refuses with under-cooldown", async (t) => {
  const { session, seed, restart, calls } = await triggerFixture(t);
  const stamp = Date.now() - 60_000;
  seed({
    ...initialTriggerState(),
    pending: true,
    settledTurnsSinceReview: 40,
    lastReviewAt: stamp,
  });
  const spentBefore = calls();

  const { app, triggers } = await restart();
  const restored = triggers.get(session.id);
  assert.ok(restored, "the trigger did not survive the restart");
  assert.equal(restored.lastReviewAt, stamp, "the cooldown moved across the restart");
  assert.equal(restored.inFlight, false);

  const result = await app.requestHarnessReview(session.id);
  assert.equal(result.kind, "armed", "a held refusal keeps the request for a later boundary");
  assert.match(result.note, /cooldown/);
  assert.equal(
    calls(),
    spentBefore,
    "a restart inside the cooldown spent a model call, which is the free review",
  );
});

test("a restart after a crash mid-round neither wedges the gate nor buys a review", async (t) => {
  const { session, seed, restart, calls } = await triggerFixture(t);
  // A round was in flight when the process died, and its stamp is old enough
  // that the cooldown would otherwise have elapsed.
  seed({
    ...initialTriggerState(),
    pending: true,
    settledTurnsSinceReview: 40,
    inFlight: true,
    lastReviewAt: Date.now() - 24 * 60 * 60_000,
  });
  const spentBefore = calls();
  const restartedAt = Date.now();

  const { app, triggers } = await restart();
  const restored = triggers.get(session.id);
  assert.ok(restored);
  assert.equal(restored.inFlight, false, "a crashed round must not hold the gate shut forever");
  assert.ok(
    restored.lastReviewAt !== null && restored.lastReviewAt >= restartedAt,
    "the interrupted round must stamp a cooldown, or the restart buys it",
  );

  const result = await app.requestHarnessReview(session.id);
  assert.equal(result.kind, "armed");
  assert.match(result.note, /cooldown/);
  assert.doesNotMatch(result.note, /in flight/, "nothing is in flight after a restart");
  assert.equal(calls(), spentBefore, "the crashed round's review was paid for twice");
});

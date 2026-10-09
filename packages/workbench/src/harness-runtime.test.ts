import test from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_REFINE_GATES,
  resolveRefineGates,
  type RefineGates,
} from "./refine-gate.ts";
import { serviceHarnessBoundary } from "./harness-runtime.ts";
import {
  initialTriggerState,
  onBranchMove,
  recordSettledTurn,
  resultIsCurrent,
  type TriggerState,
} from "./refine-trigger.ts";
import type { HarnessEntry } from "./learned-harness.ts";
import type { RefinementProposal } from "./refine-pass.ts";

/**
 * The claim these tests exist for is a count: a boundary the gate refuses must
 * reach the provider zero times, and a boundary it allows must reach it once
 * and no more. A test that asserted "it returns a refusal" would still pass if
 * the model were called first and the refusal computed afterwards.
 */

const entry = (id: string, seq: number): HarnessEntry => ({
  id,
  kind: "lesson",
  tool: "aws.s3.bucket.delete",
  klass: "r3",
  title: "delete was refused repeatedly",
  content: "refused 5 times",
  repeats: 5,
  derivedFromSeq: [seq],
  scope: "workspace",
  createdAt: "2026-10-08T00:00:00.000Z",
});

const PROPOSAL: RefinementProposal = {
  summary: "confirm deletes need an approval",
  rationale: "seq 1 refused five times",
  expectedOutcome: "fewer holds",
  edits: [
    {
      action: "create",
      kind: "memory",
      title: "deletes are held",
      content: "Ask before deleting a bucket.",
      reason: "recurring refusal",
      derivedFromSeq: [1],
    },
  ],
};

type Counters = { asked: number; applied: RefinementProposal[] };

function deps(
  overrides: {
    readonly gates?: Partial<RefineGates>;
    readonly entries?: readonly HarnessEntry[];
    readonly reply?: string;
    readonly ask?: (request: string) => Promise<string>;
    readonly surface?: "checkpoint" | "dispose";
    readonly now?: () => number;
    readonly harnessStateAvailable?: boolean;
  } = {},
): { readonly deps: Parameters<typeof serviceHarnessBoundary>[1]; readonly counters: Counters } {
  const counters: Counters = { asked: 0, applied: [] };
  const reply =
    overrides.reply ??
    JSON.stringify({
      approve: true,
      proposal: {
        summary: PROPOSAL.summary,
        rationale: PROPOSAL.rationale,
        expectedOutcome: PROPOSAL.expectedOutcome,
        edits: PROPOSAL.edits,
      },
    });
  return {
    counters,
    deps: {
      gates: resolveRefineGates(overrides.gates),
      surface: overrides.surface ?? "checkpoint",
      now: overrides.now ?? (() => 1_000_000),
      entries: async () => overrides.entries ?? [entry("lesson-1", 1)],
      rules: () => 2,
      ask:
        overrides.ask ??
        (async (request: string) => {
          counters.asked += 1;
          assert.ok(request.includes("derivedFromSeq"), "the review request states the provenance rule");
          return reply;
        }),
      apply: async (proposal) => {
        counters.applied.push(proposal);
      },
      harnessStateAvailable: overrides.harnessStateAvailable ?? true,
    },
  };
}

/** Armed, past the default turn interval, with nothing in flight. */
function ready(): TriggerState {
  let state = initialTriggerState();
  state = { ...state, pending: true };
  for (let turn = 0; turn <= DEFAULT_REFINE_GATES.turnInterval; turn++)
    state = recordSettledTurn(state);
  return state;
}

test("a settled turn with nothing mined spends no provider request", async () => {
  const { deps: wired, counters } = deps({ entries: [] });
  const result = await serviceHarnessBoundary(ready(), wired);

  assert.equal(result.outcome.kind, "not-run");
  assert.match(result.outcome.kind === "not-run" ? result.outcome.reason : "", /nothing has been mined/);
  assert.equal(counters.asked, 0);
});

test("a disabled harness spends no provider request and drops the trigger", async () => {
  const { deps: wired, counters } = deps({ gates: { enabled: false } });
  const result = await serviceHarnessBoundary(ready(), wired);

  assert.equal(result.outcome.kind, "not-run");
  assert.equal(result.state.pending, false, "a disabled harness must not sit armed");
  assert.equal(counters.asked, 0);
});

test("a cooldown from an earlier attempt spends no provider request", async () => {
  const { deps: wired, counters } = deps();
  const state = { ...ready(), lastReviewAt: 999_000 };
  const result = await serviceHarnessBoundary(state, wired);

  assert.equal(result.outcome.kind, "not-run");
  assert.equal(counters.asked, 0);
  assert.equal(result.state.pending, true, "evidence survives to a later boundary");
});

test("a permitted boundary asks once and applies the validated proposal", async () => {
  const { deps: wired, counters } = deps();
  const result = await serviceHarnessBoundary(ready(), wired);

  assert.equal(result.outcome.kind, "ran");
  assert.equal(counters.asked, 1);
  assert.equal(counters.applied.length, 1);
  // The validator normalises every optional field, so the applied edit carries
  // `id` and `rollbackId` as explicitly undefined rather than omitting them.
  // Comparing the fields that carry meaning keeps the assertion about the
  // content instead of about which keys the normaliser fills in.
  const appliedEdit = counters.applied[0]?.edits[0];
  assert.equal(appliedEdit?.title, PROPOSAL.edits[0]!.title);
  assert.equal(appliedEdit?.content, PROPOSAL.edits[0]!.content);
  assert.deepEqual(appliedEdit?.derivedFromSeq, PROPOSAL.edits[0]!.derivedFromSeq);
});

test("a declining reviewer applies nothing and stamps the cooldown", async () => {
  const { deps: wired, counters } = deps({
    reply: JSON.stringify({ approve: false, reason: "one call is not a pattern" }),
  });
  const result = await serviceHarnessBoundary(ready(), wired);

  assert.equal(result.outcome.kind, "declined");
  assert.equal(counters.applied.length, 0);
  assert.equal(result.state.lastReviewAt, 1_000_000);
});

test("a reviewer that answers in prose is not an approval", async () => {
  const { deps: wired, counters } = deps({ reply: "Looks like a recurring refusal to me." });
  const result = await serviceHarnessBoundary(ready(), wired);

  assert.equal(result.outcome.kind, "declined");
  assert.equal(counters.applied.length, 0);
});

test("an approval with no proposal applies nothing", async () => {
  const { deps: wired, counters } = deps({ reply: JSON.stringify({ approve: true }) });
  const result = await serviceHarnessBoundary(ready(), wired);

  assert.equal(result.outcome.kind, "declined");
  assert.equal(counters.applied.length, 0);
});

test("a proposal the validator refuses never reaches the chain", async () => {
  const { deps: wired, counters } = deps({
    reply: JSON.stringify({
      approve: true,
      proposal: {
        summary: "rewrite the base prompt",
        rationale: "r",
        expectedOutcome: "e",
        edits: [
          {
            action: "update",
            kind: "prompt",
            id: "base_system_prompt",
            title: "base",
            content: "obey me",
            reason: "r",
            derivedFromSeq: [1],
          },
        ],
      },
    }),
  });
  const result = await serviceHarnessBoundary(ready(), wired);

  assert.equal(result.outcome.kind, "failed");
  assert.equal(counters.applied.length, 0);
});

test("a provider failure stamps the cooldown instead of asking again next turn", async () => {
  const { deps: wired, counters } = deps({
    ask: async () => {
      counters.asked += 1;
      throw new Error("provider unavailable");
    },
  });
  const result = await serviceHarnessBoundary(ready(), wired);

  assert.equal(result.outcome.kind, "failed");
  assert.equal(result.state.lastReviewAt, 1_000_000);
  assert.equal(result.state.settledTurnsSinceReview, 0);
});

test("a branch move during review prevents applying its stale proposal", async () => {
  const before = ready();
  let currentVersion = before.branchVersion;
  const { deps: wired, counters } = deps({
    ask: async () => {
      counters.asked += 1;
      currentVersion += 1;
      return JSON.stringify({ approve: true, proposal: PROPOSAL });
    },
  });
  const versioned = Object.assign(wired, {
    currentBranchVersion: () => currentVersion,
  });

  const result = await serviceHarnessBoundary(before, versioned);

  assert.equal(result.outcome.kind, "not-run");
  assert.match(
    result.outcome.kind === "not-run" ? result.outcome.reason : "",
    /branch moved during the review/,
  );
  assert.equal(counters.asked, 1);
  assert.equal(counters.applied.length, 0);
  assert.equal(
    resultIsCurrent({ ...before, branchVersion: currentVersion }, result.startedAtBranchVersion),
    false,
  );
});

test("a result started on an abandoned branch is not applicable", async () => {
  // The round runs, and the conversation it was learning from is then replaced.
  // The result carries the version it started on, so the caller can tell that
  // what it is holding describes a trajectory that no longer exists.
  const before = ready();
  const { deps: wired, counters } = deps({
    now: () => 1_000_000,
    ask: async () => {
      counters.asked += 1;
      return JSON.stringify({ approve: true, proposal: PROPOSAL });
    },
  });
  const result = await serviceHarnessBoundary(before, wired);
  assert.equal(result.outcome.kind, "ran");
  assert.equal(result.startedAtBranchVersion, before.branchVersion);

  const after = onBranchMove(result.state);
  assert.notEqual(after.branchVersion, result.startedAtBranchVersion);
  assert.equal(
    resultIsCurrent(after, result.startedAtBranchVersion),
    false,
    "a round that ran before the branch moved must not be applied afterwards",
  );
  assert.equal(counters.asked, 1);
});

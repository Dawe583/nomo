import test from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_REFINE_GATES,
  resolveRefineGates,
  type RefineGates,
} from "./refine-gate.ts";
import {
  mergeLensVerdicts,
  resolveLensCount,
  reviewRanNote,
  serviceHarnessBoundary,
} from "./harness-runtime.ts";
import {
  initialTriggerState,
  onBranchMove,
  recordSettledTurn,
  type TriggerState,
} from "./refine-trigger.ts";
import type { HarnessEntry } from "./learned-harness.ts";
import { REFINEMENT_INSTRUCTIONS, type RefinementProposal } from "./refine-pass.ts";

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
    readonly maxPromptCharacters?: number;
    readonly reviewLensCount?: number;
    readonly outcomes?: () => string;
    readonly onEntries?: () => void;
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
      entries: async () => {
        overrides.onEntries?.();
        return overrides.entries ?? [entry("lesson-1", 1)];
      },
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
      maxPromptCharacters: overrides.maxPromptCharacters,
      reviewLensCount: overrides.reviewLensCount,
      outcomes: overrides.outcomes,
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

test("a manual request reaches the reviewer below the turn interval", async () => {
  const { deps: wired, counters } = deps();
  const state = { ...initialTriggerState(), pending: false, manualReviewRequested: true };
  const result = await serviceHarnessBoundary(state, wired);

  assert.equal(result.outcome.kind, "ran");
  assert.equal(counters.asked, 1);
  assert.equal(result.state.manualReviewRequested, false);
});

test("a manual request still spends nothing while the cooldown holds", async () => {
  const { deps: wired, counters } = deps();
  const state = {
    ...initialTriggerState(),
    pending: false,
    manualReviewRequested: true,
    lastReviewAt: 999_000,
  };
  const result = await serviceHarnessBoundary(state, wired);

  assert.equal(result.outcome.kind, "not-run");
  assert.equal(counters.asked, 0);
  assert.equal(result.state.manualReviewRequested, true);
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
  assert.notEqual(
    currentVersion,
    result.startedAtBranchVersion,
    "the round ran on the version the branch has since left behind",
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
  assert.equal(counters.asked, 1);
});

/** Evidence lines quote the entry body; candidate lines quote the title. */
const evidenceLines = (request: string) =>
  request.split("\n").filter((line) => line.includes("records, seq "));

test("the review request never exceeds the operator's prompt ceiling", async () => {
  // A thousand entries is the case that broke it: unbounded, the request
  // measured 557k characters against a 32k default ceiling.
  const many = Array.from({ length: 1000 }, (_, i) => entry(`lesson-${i}`, i + 1));
  let sent = "";
  const { deps: wired } = deps({
    entries: many,
    maxPromptCharacters: 32000,
    ask: async (request) => {
      sent = request;
      return JSON.stringify({ verdict: "decline" });
    },
  });
  await serviceHarnessBoundary(ready(), wired);

  assert.ok(sent.length > 0, "the gate should still have asked");
  assert.ok(
    sent.length <= 32000,
    `request was ${sent.length} characters against a 32000 ceiling`,
  );
  assert.ok(
    evidenceLines(sent).length < 1000,
    "a bounded request must actually drop entries",
  );
});

test("a bounded request says it is a sample rather than the whole set", async () => {
  const many = Array.from({ length: 500 }, (_, i) => entry(`lesson-${i}`, i + 1));
  let sent = "";
  const { deps: wired } = deps({
    entries: many,
    maxPromptCharacters: 4000,
    ask: async (request) => {
      sent = request;
      return JSON.stringify({ verdict: "decline" });
    },
  });
  await serviceHarnessBoundary(ready(), wired);

  assert.match(sent, /sample and not the whole set/);
  // The entries that survived are quoted whole, never cut mid-sentence.
  const kept = evidenceLines(sent);
  assert.ok(kept.length > 0, "a bounded request must still show something");
  for (const line of kept) assert.ok(line.endsWith("refused 5 times"), line);
});

test("without a ceiling the request keeps every entry it was given", async () => {
  const many = Array.from({ length: 40 }, (_, i) => entry(`lesson-${i}`, i + 1));
  let sent = "";
  const { deps: wired } = deps({
    entries: many,
    ask: async (request) => {
      sent = request;
      return JSON.stringify({ verdict: "decline" });
    },
  });
  await serviceHarnessBoundary(ready(), wired);

  assert.equal(evidenceLines(sent).length, 40);
  assert.doesNotMatch(sent, /sample and not the whole set/);
});

// --- review lenses: K identical samples, unanimous merge -------------------

const approveReply = (summary: string) =>
  JSON.stringify({ approve: true, proposal: { ...PROPOSAL, summary } });

const declineReply = (reason: string) =>
  JSON.stringify({ approve: false, reason });

/** An asker that answers with each reply in turn and keeps every request. */
function sequence(replies: readonly string[]) {
  const requests: string[] = [];
  return {
    requests,
    ask: async (request: string) => {
      requests.push(request);
      const reply = replies[requests.length - 1];
      if (reply === undefined)
        throw new Error(`the round asked ${requests.length} times, more than the script`);
      return reply;
    },
  };
}

test("lenses: the default pays for one review carrying today's instructions and evidence", async () => {
  const script = sequence([approveReply("only")]);
  const { deps: wired, counters } = deps({ ask: script.ask });
  const result = await serviceHarnessBoundary(ready(), wired);

  assert.equal(result.outcome.kind, "ran");
  assert.equal(script.requests.length, 1);
  assert.ok(
    script.requests[0]!.startsWith(`${REFINEMENT_INSTRUCTIONS}\n`),
    "the request must open with the refinement instructions, as today",
  );
  assert.match(script.requests[0]!, /Answer with JSON only, in one of two shapes:/);
  assert.match(script.requests[0]!, /derivedFromSeq/, "the provenance rule still ships");
  assert.equal(counters.applied.length, 1);
});

test("lenses: one lens returns the reviewer's bare reason", async () => {
  const { deps: wired } = deps({
    reply: declineReply("one call is not a pattern"),
    reviewLensCount: 1,
  });
  const result = await serviceHarnessBoundary(ready(), wired);

  assert.equal(result.outcome.kind, "declined");
  assert.equal(
    result.outcome.kind === "declined" ? result.outcome.reason : "",
    "one call is not a pattern",
    "a single lens must not be given a tally it never earned",
  );
});

test("lenses: two approvals run the round with the first lens's text", async () => {
  const script = sequence([approveReply("first text"), approveReply("second text")]);
  const { deps: wired, counters } = deps({ ask: script.ask, reviewLensCount: 2 });
  const result = await serviceHarnessBoundary(ready(), wired);

  assert.equal(result.outcome.kind, "ran");
  assert.equal(script.requests.length, 2);
  assert.equal(counters.applied.length, 1);
  assert.equal(counters.applied[0]?.summary, "first text");
});

test("lenses: one decline vetoes the round", async () => {
  const script = sequence([
    approveReply("x"),
    declineReply("edits too vague to enforce"),
  ]);
  const { deps: wired, counters } = deps({ ask: script.ask, reviewLensCount: 2 });
  const result = await serviceHarnessBoundary(ready(), wired);

  assert.equal(result.outcome.kind, "declined");
  assert.equal(
    result.outcome.kind === "declined" ? result.outcome.reason : "",
    "(1 of 2 approved) lens 1 approved; lens 2: edits too vague to enforce",
  );
  assert.equal(counters.applied.length, 0);
});

test("lenses: all declines join every reason", async () => {
  const script = sequence([
    declineReply("one-off output"),
    declineReply("no durable lesson"),
  ]);
  const { deps: wired } = deps({ ask: script.ask, reviewLensCount: 2 });
  const result = await serviceHarnessBoundary(ready(), wired);

  assert.equal(result.outcome.kind, "declined");
  assert.equal(
    result.outcome.kind === "declined" ? result.outcome.reason : "",
    "(0 of 2 approved) lens 1: one-off output; lens 2: no durable lesson",
  );
});

test("lenses: a reason carrying the separator cannot fake extra lenses", async () => {
  const script = sequence([
    declineReply("edits vague; stamp nothing\nsecond line"),
    approveReply("x"),
  ]);
  const { deps: wired } = deps({ ask: script.ask, reviewLensCount: 2 });
  const result = await serviceHarnessBoundary(ready(), wired);

  assert.equal(result.outcome.kind, "declined");
  assert.equal(
    result.outcome.kind === "declined" ? result.outcome.reason : "",
    "(1 of 2 approved) lens 1: edits vague, stamp nothing second line; lens 2 approved",
  );
});

test("lenses: a reply that is not JSON declines rather than fails", async () => {
  const script = sequence([approveReply("x"), "Looks fine to me."]);
  const { deps: wired, counters } = deps({ ask: script.ask, reviewLensCount: 2 });
  const result = await serviceHarnessBoundary(ready(), wired);

  assert.equal(result.outcome.kind, "declined");
  assert.match(
    result.outcome.kind === "declined" ? result.outcome.reason : "",
    /^\(1 of 2 approved\) lens 1 approved; lens 2: Reviewer reply was not JSON: /,
  );
  assert.equal(counters.applied.length, 0);
});

test("lenses: a throwing lens fails the round and stamps the cooldown", async () => {
  let asked = 0;
  const { deps: wired } = deps({
    reviewLensCount: 2,
    ask: async () => {
      asked += 1;
      if (asked === 2) throw new Error("provider unavailable");
      return approveReply("x");
    },
  });
  const result = await serviceHarnessBoundary(ready(), wired);

  assert.equal(result.outcome.kind, "failed");
  assert.equal(
    result.outcome.kind === "failed" && result.outcome.error instanceof Error
      ? result.outcome.error.message
      : "",
    "lens 2 of 2: provider unavailable",
  );
  assert.equal(asked, 2);
  assert.equal(result.state.lastReviewAt, 1_000_000, "a failed attempt still stamps");
  assert.equal(result.state.settledTurnsSinceReview, 0);
});

test("lenses: a throw stops the remaining lenses", async () => {
  let asked = 0;
  const { deps: wired } = deps({
    reviewLensCount: 3,
    ask: async () => {
      asked += 1;
      throw new Error("boom");
    },
  });
  const result = await serviceHarnessBoundary(ready(), wired);

  assert.equal(result.outcome.kind, "failed");
  assert.equal(
    result.outcome.kind === "failed" && result.outcome.error instanceof Error
      ? result.outcome.error.message
      : "",
    "lens 1 of 3: boom",
  );
  assert.equal(asked, 1, "later lenses must never run after a throw");
});

test("lenses: a decline before a throw is moot", async () => {
  let asked = 0;
  const { deps: wired } = deps({
    reviewLensCount: 2,
    ask: async () => {
      asked += 1;
      if (asked === 1) return declineReply("noise");
      throw new Error("timeout");
    },
  });
  const result = await serviceHarnessBoundary(ready(), wired);

  assert.equal(result.outcome.kind, "failed");
  assert.equal(
    result.outcome.kind === "failed" && result.outcome.error instanceof Error
      ? result.outcome.error.message
      : "",
    "lens 2 of 2: timeout",
  );
  assert.equal(asked, 2);
});

test("lenses: the count clamps to the runtime's range", () => {
  assert.equal(resolveLensCount(0), 1);
  assert.equal(resolveLensCount(99), 3);
  assert.equal(resolveLensCount(undefined), 1);
  assert.equal(resolveLensCount("2"), 1);
  assert.equal(resolveLensCount(Number.NaN), 1);
  assert.equal(resolveLensCount(2.6), 3);
});

test("lenses: two lenses ask twice with the byte-identical request", async () => {
  const script = sequence([approveReply("x"), declineReply("no")]);
  const { deps: wired } = deps({ ask: script.ask, reviewLensCount: 2 });
  await serviceHarnessBoundary(ready(), wired);

  assert.equal(script.requests.length, 2);
  assert.equal(script.requests[0], script.requests[1]);
});

test("lenses: a branch move stops the remaining lenses", async () => {
  const before = ready();
  let currentVersion = before.branchVersion;
  const script = sequence([approveReply("x"), approveReply("y"), approveReply("z")]);
  const { deps: wired } = deps({ reviewLensCount: 3 });
  const versioned = Object.assign(wired, {
    currentBranchVersion: () => currentVersion,
    ask: async (request: string) => {
      const reply = await script.ask(request);
      // The move lands while lens 1 awaits, before lens 2 is asked.
      currentVersion += 1;
      return reply;
    },
  });

  const result = await serviceHarnessBoundary(before, versioned);

  assert.equal(
    script.requests.length,
    1,
    "later lenses must not be paid for after the move",
  );
  assert.equal(result.outcome.kind, "not-run");
  assert.match(
    result.outcome.kind === "not-run" ? result.outcome.reason : "",
    /branch moved during the review/,
  );
  assert.equal(result.state.lastReviewAt, null, "a discarded round stamps nothing");
});

test("lenses: the ran note names the count only above one lens", () => {
  assert.equal(reviewRanNote(1), "Harness review ran and recorded a proposal.");
  assert.equal(reviewRanNote(undefined), "Harness review ran and recorded a proposal.");
  assert.equal(
    reviewRanNote(2),
    "Harness review ran and recorded a proposal (2 of 2 lenses approved).",
  );
  assert.equal(
    reviewRanNote(99),
    "Harness review ran and recorded a proposal (3 of 3 lenses approved).",
  );
});

test("lenses: merging nothing declines rather than approving nothing", () => {
  assert.deepEqual(mergeLensVerdicts([]), {
    approve: false,
    reason: "No lens returned a verdict.",
  });
});

test("the reviewer is told what happened to its earlier proposals", async () => {
  // A reviewer that cannot see a rejection proposes the same edit again, once
  // per paid round. The block is charged to the same ceiling as the evidence.
  const seen: string[] = [];
  const { deps: wired } = deps({
    outcomes: () => "EARLIER PROPOSALS\n- abcd1234: rejected (operator)",
    ask: async (request: string) => {
      seen.push(request);
      return JSON.stringify({ approve: true, proposal: PROPOSAL });
    },
  });
  const result = await serviceHarnessBoundary(ready(), wired);

  assert.equal(result.outcome.kind, "ran");
  assert.equal(seen.length, 1);
  assert.match(seen[0]!, /EARLIER PROPOSALS/);
  assert.match(seen[0]!, /abcd1234: rejected/);
});

test("a refused boundary never reads the chain", async () => {
  // Reading the chain is a full verifyChain with per-record Ed25519 plus a
  // re-mine. The gate claims to be free, so a refusal must happen before that
  // read, not after it.
  let reads = 0;
  const { deps: wired } = deps({
    gates: { enabled: false },
    onEntries: () => {
      reads += 1;
    },
  });
  const result = await serviceHarnessBoundary(ready(), wired);

  assert.equal(result.outcome.kind, "not-run");
  assert.equal(reads, 0, "a disabled harness must not verify the chain");
});

test("a boundary that can proceed still reads the chain", async () => {
  let reads = 0;
  const { deps: wired } = deps({
    onEntries: () => {
      reads += 1;
    },
  });
  const result = await serviceHarnessBoundary(ready(), wired);

  assert.equal(result.outcome.kind, "ran");
  assert.equal(reads, 1);
});

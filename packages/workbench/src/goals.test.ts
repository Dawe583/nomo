/**
 * HP7: a goal is an objective, a token budget and optional operator gates.
 *
 * The parser and the transition are the whole contract the parent integration
 * leans on, so the tests below treat both as the trust boundary: a gate command
 * is only ever the operator's exact allowlist string, a terminal goal never
 * resumes, and a continuation prompt carries failure metadata but never the
 * command or the process output.
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  GOAL_LIMITS,
  UNTRUSTED_GATE_HISTORY_LABEL,
  evaluateGoal,
  goalContinuationPrompt,
  goalLimits,
  goalStartPrompt,
  parseGoalInput,
  type Goal,
  type GoalGateFailure,
  type GoalStatus,
} from "./goals.ts";

const ALLOWLIST = [
  "pnpm test",
  "pnpm run typecheck",
  "node scripts/check.mjs",
  "pnpm run build",
  "pnpm run lint",
] as const;

const MAX_PROMPT = 32_000;

const goal = (overrides: Partial<Goal> = {}): Goal => ({
  id: "goal-1",
  objective: "Make the suite pass",
  tokenBudget: 100_000,
  gates: ["pnpm test"],
  status: "active",
  runTokenBase: 0,
  continuationCount: 0,
  ...overrides,
});

const refuses = (run: () => unknown, pattern: RegExp) =>
  assert.throws(run, pattern);

test("the limits keep the operator's prompt bound and the fixed caps", () => {
  assert.equal(GOAL_LIMITS.tokenBudgetMax, 1_000_000);
  assert.equal(GOAL_LIMITS.gates, 4);
  assert.equal(GOAL_LIMITS.continuations, 8);
  assert.deepEqual(goalLimits(MAX_PROMPT), {
    objectiveCharacters: MAX_PROMPT,
    tokenBudgetMax: 1_000_000,
    gates: 4,
    continuations: 8,
  });
  assert.equal(goalLimits(4_096).objectiveCharacters, 4_096);
  assert.equal(goalLimits(0).objectiveCharacters, 0);
  assert.equal(goalLimits(Number.NaN).objectiveCharacters, 0);
});

test("a minimal goal input is trimmed and invents no gate", () => {
  assert.deepEqual(
    parseGoalInput(
      { objective: "  Make the suite pass  ", tokenBudget: 5_000 },
      ALLOWLIST,
      MAX_PROMPT,
    ),
    { objective: "Make the suite pass", tokenBudget: 5_000, gates: [] },
  );
});

test("gates keep the operator's order, trimmed, and only from the allowlist", () => {
  const parsed = parseGoalInput(
    {
      objective: "Make the suite pass",
      tokenBudget: 5_000,
      gates: ["  node scripts/check.mjs ", "pnpm test"],
    },
    ALLOWLIST,
    MAX_PROMPT,
  );
  assert.deepEqual(parsed.gates, ["node scripts/check.mjs", "pnpm test"]);
});

test("only objective, tokenBudget and gates are fields", () => {
  refuses(() => parseGoalInput(null, ALLOWLIST, MAX_PROMPT), /expected an object/);
  refuses(() => parseGoalInput("goal", ALLOWLIST, MAX_PROMPT), /expected an object/);
  refuses(() => parseGoalInput([], ALLOWLIST, MAX_PROMPT), /expected an object/);
  refuses(
    () =>
      parseGoalInput(
        { objective: "Ship it", tokenBudget: 10, id: "goal-1" },
        ALLOWLIST,
        MAX_PROMPT,
      ),
    /unknown field "id"/,
  );
  refuses(
    () =>
      parseGoalInput(
        { objective: "Ship it", tokenBudget: 10, status: "active" },
        ALLOWLIST,
        MAX_PROMPT,
      ),
    /unknown field "status"/,
  );
  refuses(
    () =>
      parseGoalInput(
        { objective: "Ship it", tokenBudget: 10, model: "fixture/model" },
        ALLOWLIST,
        MAX_PROMPT,
      ),
    /unknown field "model"/,
  );
});

test("the objective is required, trimmed, nonempty and bounded by the prompt limit", () => {
  refuses(
    () => parseGoalInput({ tokenBudget: 10 }, ALLOWLIST, MAX_PROMPT),
    /objective must be text/,
  );
  refuses(
    () => parseGoalInput({ objective: 42, tokenBudget: 10 }, ALLOWLIST, MAX_PROMPT),
    /objective must be text/,
  );
  refuses(
    () =>
      parseGoalInput(
        { objective: "   ", tokenBudget: 10 },
        ALLOWLIST,
        MAX_PROMPT,
      ),
    /objective must not be empty/,
  );
  refuses(
    () =>
      parseGoalInput(
        { objective: "x".repeat(MAX_PROMPT + 1), tokenBudget: 10 },
        ALLOWLIST,
        MAX_PROMPT,
      ),
    /at most 32000 characters, got 32001/,
  );
  refuses(
    () =>
      parseGoalInput(
        { objective: "Make\u0000the suite pass", tokenBudget: 10 },
        ALLOWLIST,
        MAX_PROMPT,
      ),
    /objective contains a control character/,
  );
  assert.equal(
    parseGoalInput(
      { objective: "x".repeat(MAX_PROMPT), tokenBudget: 10 },
      ALLOWLIST,
      MAX_PROMPT,
    ).objective.length,
    MAX_PROMPT,
  );
  // Prose keeps its line breaks; only the objective's other control characters
  // are refused.
  assert.equal(
    parseGoalInput(
      { objective: "Make the suite pass\nThen update the docs", tokenBudget: 10 },
      ALLOWLIST,
      MAX_PROMPT,
    ).objective,
    "Make the suite pass\nThen update the docs",
  );
});

test("the token budget is a positive integer within the cap", () => {
  for (const tokenBudget of [undefined, 0, -1, 1.5, "1000", Number.NaN, null]) {
    refuses(
      () =>
        parseGoalInput(
          { objective: "Ship it", tokenBudget },
          ALLOWLIST,
          MAX_PROMPT,
        ),
      /tokenBudget must be a positive integer/,
    );
  }
  refuses(
    () =>
      parseGoalInput(
        { objective: "Ship it", tokenBudget: GOAL_LIMITS.tokenBudgetMax + 1 },
        ALLOWLIST,
        MAX_PROMPT,
      ),
    /at most 1000000 tokens, got 1000001/,
  );
  assert.equal(
    parseGoalInput(
      { objective: "Ship it", tokenBudget: GOAL_LIMITS.tokenBudgetMax },
      ALLOWLIST,
      MAX_PROMPT,
    ).tokenBudget,
    GOAL_LIMITS.tokenBudgetMax,
  );
});

test("gates are a bounded array of unique operator commands", () => {
  refuses(
    () =>
      parseGoalInput(
        { objective: "Ship it", tokenBudget: 10, gates: "pnpm test" },
        ALLOWLIST,
        MAX_PROMPT,
      ),
    /gates must be an array/,
  );
  refuses(
    () =>
      parseGoalInput(
        { objective: "Ship it", tokenBudget: 10, gates: ["pnpm test", 42] },
        ALLOWLIST,
        MAX_PROMPT,
      ),
    /gate 2 must be text/,
  );
  refuses(
    () =>
      parseGoalInput(
        { objective: "Ship it", tokenBudget: 10, gates: ["pnpm test", "  "] },
        ALLOWLIST,
        MAX_PROMPT,
      ),
    /gate 2 must not be empty/,
  );
  refuses(
    () =>
      parseGoalInput(
        { objective: "Ship it", tokenBudget: 10, gates: ["pnpm test", " pnpm test "] },
        ALLOWLIST,
        MAX_PROMPT,
      ),
    /duplicate gate "pnpm test"/,
  );
  refuses(
    () =>
      parseGoalInput(
        {
          objective: "Ship it",
          tokenBudget: 10,
          gates: ["pnpm test", "pnpm run build", "pnpm run lint", "pnpm run typecheck", "node scripts/check.mjs"],
        },
        ALLOWLIST,
        MAX_PROMPT,
      ),
    /at most 4 gates, got 5/,
  );
  const four = parseGoalInput(
    {
      objective: "Ship it",
      tokenBudget: 10,
      gates: ["pnpm test", "pnpm run build", "pnpm run lint", "pnpm run typecheck"],
    },
    ALLOWLIST,
    MAX_PROMPT,
  );
  assert.equal(four.gates.length, GOAL_LIMITS.gates);
});

test("a gate is accepted only as the operator's exact allowlist string", () => {
  for (const command of [
    "pnpm",
    "pnpm test --watch",
    "PNPM TEST",
    "pnpm  test",
    "pnpm test; rm -rf /",
    "./pnpm test",
  ])
    refuses(
      () =>
        parseGoalInput(
          { objective: "Ship it", tokenBudget: 10, gates: [command] },
          ALLOWLIST,
          MAX_PROMPT,
        ),
      /not on the operator hook allowlist/,
    );
  // An empty allowlist authorises nothing, so no gate can be named at all.
  refuses(
    () =>
      parseGoalInput(
        { objective: "Ship it", tokenBudget: 10, gates: ["pnpm test"] },
        [],
        MAX_PROMPT,
      ),
    /not on the operator hook allowlist/,
  );
});

test("a passing gate completes the goal whatever the budget and digest say", () => {
  const stuck = goal({
    continuationCount: GOAL_LIMITS.continuations,
    lastWorkspaceDigest: "sha256:unchanged",
  });
  const decision = evaluateGoal(stuck, {
    gatesPassed: true,
    tokensUsed: GOAL_LIMITS.tokenBudgetMax,
    workspaceDigest: "sha256:unchanged",
  });
  assert.equal(decision.goal.status, "completed");
  assert.equal(decision.continue, false);
  assert.equal(decision.goal.continuationCount, GOAL_LIMITS.continuations);
  assert.equal(decision.goal.lastWorkspaceDigest, "sha256:unchanged");

  const fresh = evaluateGoal(goal(), {
    gatesPassed: true,
    tokensUsed: 0,
    workspaceDigest: "sha256:first",
  });
  assert.equal(fresh.goal.status, "completed");
  assert.equal(fresh.continue, false);
});

test("a spent budget ends the goal as budget_limited", () => {
  const decision = evaluateGoal(goal({ tokenBudget: 1_000 }), {
    gatesPassed: false,
    tokensUsed: 1_000,
    workspaceDigest: "sha256:changed",
  });
  assert.equal(decision.goal.status, "budget_limited");
  assert.equal(decision.continue, false);
  assert.equal(decision.goal.continuationCount, 0);
  assert.equal(decision.goal.lastWorkspaceDigest, undefined);

  const under = evaluateGoal(goal({ tokenBudget: 1_000 }), {
    gatesPassed: false,
    tokensUsed: 999,
    workspaceDigest: "sha256:changed",
  });
  assert.equal(under.goal.status, "active");
  assert.equal(under.continue, true);
});

test("the continuation cap ends the goal as budget_limited", () => {
  const atCap = evaluateGoal(
    goal({ continuationCount: GOAL_LIMITS.continuations }),
    { gatesPassed: false, tokensUsed: 1, workspaceDigest: "sha256:changed" },
  );
  assert.equal(atCap.goal.status, "budget_limited");
  assert.equal(atCap.continue, false);
  assert.equal(atCap.goal.continuationCount, GOAL_LIMITS.continuations);

  const belowCap = evaluateGoal(
    goal({ continuationCount: GOAL_LIMITS.continuations - 1 }),
    { gatesPassed: false, tokensUsed: 1, workspaceDigest: "sha256:changed" },
  );
  assert.equal(belowCap.goal.status, "active");
  assert.equal(belowCap.goal.continuationCount, GOAL_LIMITS.continuations);
  assert.equal(belowCap.continue, true);
});

test("the operator's continuation ceiling replaces the goal default", () => {
  const atCap = evaluateGoal(
    goal({ continuationCount: 3 }),
    {
      gatesPassed: false,
      tokensUsed: 1,
      workspaceDigest: "sha256:changed",
      maxContinuations: 3,
    },
  );
  assert.equal(atCap.goal.status, "budget_limited");
  assert.equal(atCap.continue, false);

  const belowCap = evaluateGoal(
    goal({ continuationCount: 2 }),
    {
      gatesPassed: false,
      tokensUsed: 1,
      workspaceDigest: "sha256:changed",
      maxContinuations: 3,
    },
  );
  assert.equal(belowCap.goal.status, "active");
  assert.equal(belowCap.goal.continuationCount, 3);
  assert.equal(belowCap.continue, true);
});

test("an unchanged workspace stalls the goal instead of spending more budget", () => {
  const decision = evaluateGoal(
    goal({ lastWorkspaceDigest: "sha256:unchanged", continuationCount: 2 }),
    { gatesPassed: false, tokensUsed: 10, workspaceDigest: "sha256:unchanged" },
  );
  assert.equal(decision.goal.status, "stalled");
  assert.equal(decision.continue, false);
  assert.equal(decision.goal.continuationCount, 2);
  assert.equal(decision.goal.lastWorkspaceDigest, "sha256:unchanged");
});

test("a changed workspace continues the goal and records the new digest", () => {
  const before = goal({
    lastWorkspaceDigest: "sha256:before",
    continuationCount: 2,
  });
  const decision = evaluateGoal(before, {
    gatesPassed: false,
    tokensUsed: 10,
    workspaceDigest: "sha256:after",
  });
  assert.equal(decision.goal.status, "active");
  assert.equal(decision.continue, true);
  assert.equal(decision.goal.continuationCount, 3);
  assert.equal(decision.goal.lastWorkspaceDigest, "sha256:after");
  // The transition is pure: the goal the caller passed is untouched.
  assert.equal(before.status, "active");
  assert.equal(before.continuationCount, 2);
  assert.equal(before.lastWorkspaceDigest, "sha256:before");
});

test("the first evaluation records the digest and starts the count", () => {
  const decision = evaluateGoal(goal(), {
    gatesPassed: false,
    tokensUsed: 10,
    workspaceDigest: "  sha256:first  ",
  });
  assert.equal(decision.goal.status, "active");
  assert.equal(decision.continue, true);
  assert.equal(decision.goal.continuationCount, 1);
  assert.equal(decision.goal.lastWorkspaceDigest, "sha256:first");
});

test("a cancelled goal never resumes, even if a gate reports a pass", () => {
  const cancelled = goal({ status: "cancelled", continuationCount: 2 });
  const decision = evaluateGoal(cancelled, {
    gatesPassed: true,
    tokensUsed: 0,
    workspaceDigest: "sha256:changed",
  });
  assert.equal(decision.goal.status, "cancelled");
  assert.equal(decision.continue, false);
  assert.equal(decision.goal.continuationCount, 2);
  assert.equal(decision.goal.lastWorkspaceDigest, undefined);
});

test("every settled status stays settled", () => {
  for (const status of [
    "completed",
    "budget_limited",
    "stalled",
  ] as const satisfies readonly GoalStatus[]) {
    const settled = goal({ status, continuationCount: 4 });
    const decision = evaluateGoal(settled, {
      gatesPassed: false,
      tokensUsed: 1,
      workspaceDigest: "sha256:changed",
    });
    assert.equal(decision.goal.status, status);
    assert.equal(decision.continue, false);
    assert.equal(decision.goal.continuationCount, 4);
  }
});

test("the evaluation input is refused rather than coerced", () => {
  const digest = "sha256:changed";
  refuses(
    () =>
      evaluateGoal(goal(), {
        gatesPassed: "yes" as unknown as boolean,
        tokensUsed: 1,
        workspaceDigest: digest,
      }),
    /gatesPassed must be a boolean/,
  );
  for (const tokensUsed of [-1, 1.5, Number.NaN])
    refuses(
      () =>
        evaluateGoal(goal(), {
          gatesPassed: false,
          tokensUsed,
          workspaceDigest: digest,
        }),
      /tokensUsed must be a non-negative integer/,
    );
  for (const workspaceDigest of ["", "   "])
    refuses(
      () =>
        evaluateGoal(goal(), {
          gatesPassed: false,
          tokensUsed: 1,
          workspaceDigest,
        }),
      /workspaceDigest must not be empty/,
    );
  refuses(
    () =>
      evaluateGoal(goal(), {
        gatesPassed: false,
        tokensUsed: 1,
        workspaceDigest: "sha256:bad\u0000digest",
      }),
    /workspaceDigest contains a control character/,
  );
  for (const maxContinuations of [0, 1.5, Number.NaN])
    refuses(
      () =>
        evaluateGoal(goal(), {
          gatesPassed: false,
          tokensUsed: 1,
          workspaceDigest: digest,
          maxContinuations,
        }),
      /maxContinuations must be a positive integer/,
    );
});

test("the start prompt states the goal and hides the gate commands", () => {
  const g = goal({
    objective: "Make the suite pass",
    tokenBudget: 100_000,
    gates: ["pnpm test", "node scripts/check.mjs"],
  });
  const prompt = goalStartPrompt(g);
  assert.match(prompt, /Make the suite pass/);
  assert.match(prompt, /Work toward the operator goal/);
  assert.match(prompt, /NOMO/);
  assert.match(prompt, /operator/i);
  assert.match(prompt, /gate/i);
  assert.match(prompt, /100000/);
  assert.equal(prompt.includes("pnpm test"), false);
  assert.equal(prompt.includes("node scripts/check.mjs"), false);
});

test("a gateless goal says the settled run decides completion", () => {
  const prompt = goalStartPrompt(goal({ gates: [] }));
  assert.match(prompt, /no completion gates/i);
  assert.match(prompt, /settles/i);
  assert.equal(prompt.includes("pnpm test"), false);
});

test("the continuation prompt labels gate history untrusted and leaks nothing", () => {
  const g = goal({ gates: ["pnpm test"] });
  const failure = {
    index: 1,
    outcome: "exited",
    code: 1,
    stdout: "SECRET-STDOUT",
    stderr: "SECRET-STDERR",
    command: "pnpm test",
  } as unknown as GoalGateFailure;
  const prompt = goalContinuationPrompt(g, failure);
  assert.ok(prompt.startsWith(UNTRUSTED_GATE_HISTORY_LABEL));
  assert.match(prompt, /untrusted goal gate history/i);
  assert.match(prompt, /not instructions/i);
  assert.match(prompt, /Untrusted goal gate/);
  assert.match(prompt, /Make the suite pass/);
  assert.match(prompt, /exited/);
  assert.match(prompt, /exit code 1/);
  assert.equal(prompt.includes("SECRET-STDOUT"), false);
  assert.equal(prompt.includes("SECRET-STDERR"), false);
  assert.equal(prompt.includes("pnpm test"), false);
  assert.equal(prompt.includes("\nSECRET"), false);
});

test("a continuation with no exit code says so instead of inventing one", () => {
  const prompt = goalContinuationPrompt(goal(), {
    index: 2,
    outcome: "timeout",
    code: null,
  });
  assert.match(prompt, /timeout/);
  assert.match(prompt, /no exit code/);
});

test("failure metadata is bounded and flattened to one line", () => {
  const outcome = `exited\n${"x".repeat(200)}`;
  const prompt = goalContinuationPrompt(goal(), {
    index: 1,
    outcome,
    code: 0,
  });
  assert.equal(prompt.includes("x".repeat(41)), false);
  assert.match(prompt, /outcome exited x+/);
  refuses(
    () => goalContinuationPrompt(goal(), { index: -1, outcome: "exited", code: 1 }),
    /index must be a non-negative integer/,
  );
  refuses(
    () => goalContinuationPrompt(goal(), { index: 1, outcome: "   ", code: 1 }),
    /outcome must be text/,
  );
  refuses(
    () =>
      goalContinuationPrompt(goal(), {
        index: 1,
        outcome: "exited",
        code: 1.5,
      }),
    /code must be an integer or null/,
  );
});

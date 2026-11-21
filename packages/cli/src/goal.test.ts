import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runGoalCommand, type GoalSurface } from "./goal.ts";

/**
 * The goal command, at the boundary an operator or a script touches.
 *
 * Three things matter here. The gate strings reach the workbench exactly as
 * typed and in order, because the allowlist match is exact. A command that
 * would be refused is refused before the workbench is opened, so a typo never
 * creates workspace state. And nothing in this command runs a gate: the
 * workbench owns the loop and its allowlist, and a second runner here would be
 * a second answer to what the operator allowed.
 */

const goal = {
  objective: "Finish verified work",
  tokenBudget: 100,
  tokensUsed: 12,
  gates: ["node gate.mjs"],
  status: "active",
  continuationCount: 1,
  startedAt: "2026-11-21T10:00:00.000Z",
};

function fake(overrides: Partial<GoalSurface> = {}) {
  const calls: { method: string; args: readonly string[] }[] = [];
  const surface: GoalSurface = {
    get(id) {
      calls.push({ method: "get", args: [id] });
      return id === "s1" ? { workspace: "agent-s1", goal } : undefined;
    },
    async startGoal(sessionId, input) {
      calls.push({
        method: "start",
        args: [sessionId, String(input.tokenBudget), ...input.gates, input.objective],
      });
      return {
        ...goal,
        objective: input.objective,
        tokenBudget: input.tokenBudget,
        gates: input.gates,
        tokensUsed: 0,
        continuationCount: 0,
        status: "active",
      };
    },
    async cancelGoal(sessionId) {
      calls.push({ method: "cancel", args: [sessionId] });
      return { ...goal, status: "cancelled" };
    },
    ...overrides,
  };
  return { surface, calls };
}

function io() {
  const out: string[] = [];
  const err: string[] = [];
  return {
    stdout: (line: string) => out.push(line),
    stderr: (line: string) => err.push(line),
    out,
    err,
  };
}

test("start hands the objective, the budget and every gate to the workbench", async () => {
  const { surface, calls } = fake();
  const terminal = io();
  const code = await runGoalCommand(
    [
      "start",
      "--session",
      "s1",
      "--token-budget",
      "100",
      "--gate",
      "node gate.mjs",
      "--gate",
      "pnpm test",
      "Finish verified work",
    ],
    terminal,
    { workbench: async () => surface },
  );
  assert.equal(code, 0, terminal.err.join("\n"));
  assert.deepEqual(calls, [
    {
      method: "start",
      args: ["s1", "100", "node gate.mjs", "pnpm test", "Finish verified work"],
    },
  ]);
  const text = terminal.out.join("\n");
  assert.match(text, /objective: Finish verified work/);
  assert.match(text, /status: active/);
  assert.match(text, /budget: 100 tokens, 0 used/);
  assert.match(text, /gates: 2/);
  assert.match(text, / {2}node gate\.mjs/);
  assert.match(text, / {2}pnpm test/);
  assert.match(text, /this command does not run/);
});

test("repeated gates keep their exact text and their order", async () => {
  // The allowlist matches an exact command string, so a gate reordered or
  // trimmed here would name a command the operator never allowed.
  const { surface, calls } = fake();
  const terminal = io();
  const code = await runGoalCommand(
    [
      "start",
      "--session",
      "s1",
      "--token-budget",
      "50",
      "--gate",
      "node scripts/a.mjs --flag",
      "--gate",
      "pnpm --filter x test",
      "--gate",
      "git diff --quiet",
      "do",
      "the",
      "thing",
    ],
    terminal,
    { workbench: async () => surface },
  );
  assert.equal(code, 0, terminal.err.join("\n"));
  assert.deepEqual(calls, [
    {
      method: "start",
      args: [
        "s1",
        "50",
        "node scripts/a.mjs --flag",
        "pnpm --filter x test",
        "git diff --quiet",
        "do the thing",
      ],
    },
  ]);
});

test("a missing budget, session or objective is refused before the store opens", async () => {
  let opened = false;
  const deps = {
    workbench: async () => {
      opened = true;
      return fake().surface;
    },
  };

  const noBudget = io();
  assert.equal(
    await runGoalCommand(["start", "--session", "s1", "Finish"], noBudget, deps),
    1,
  );
  assert.match(noBudget.err.join("\n"), /needs a token budget: --token-budget <n>/);

  const noSession = io();
  assert.equal(
    await runGoalCommand(["start", "--token-budget", "10", "Finish"], noSession, deps),
    1,
  );
  assert.match(noSession.err.join("\n"), /need a session: --session <id>/);

  const noObjective = io();
  assert.equal(
    await runGoalCommand(
      ["start", "--session", "s1", "--token-budget", "10"],
      noObjective,
      deps,
    ),
    1,
  );
  assert.match(noObjective.err.join("\n"), /needs an objective/);

  assert.equal(opened, false, "a refusal must not open the workspace");
});

test("a budget that is not a whole number above zero is refused by value", async () => {
  let opened = false;
  const deps = {
    workbench: async () => {
      opened = true;
      return fake().surface;
    },
  };
  for (const budget of ["0", "-5", "1.5", "ten", "1e3"]) {
    const terminal = io();
    assert.equal(
      await runGoalCommand(
        ["start", "--session", "s1", "--token-budget", budget, "Finish"],
        terminal,
        deps,
      ),
      1,
      budget,
    );
    assert.match(terminal.err.join("\n"), /whole number of tokens above zero/, budget);
  }
  assert.equal(opened, false);
});

test("status reads the session view goal when the workbench has no getGoal", async () => {
  const { surface, calls } = fake();
  const terminal = io();
  const code = await runGoalCommand(["status", "--session", "s1"], terminal, {
    workbench: async () => surface,
  });
  assert.equal(code, 0, terminal.err.join("\n"));
  const text = terminal.out.join("\n");
  assert.match(text, /objective: Finish verified work/);
  assert.match(text, /status: active/);
  assert.match(text, /budget: 100 tokens, 12 used/);
  assert.match(text, /continuations: 1/);
  assert.match(text, /started: 2026-11-21T10:00:00\.000Z/);
  assert.deepEqual(calls, [{ method: "get", args: ["s1"] }]);
});

test("status prints a goal that carries only the fields the workbench requires", async () => {
  // The workbench goal carries an id, a run token base and a continuation
  // count, and no start or end timestamp. Printing "undefined" for a field the
  // workbench does not report would make a script parse a value that is not
  // there.
  const terminal = io();
  const code = await runGoalCommand(["status", "--session", "s1"], terminal, {
    workbench: async () =>
      fake({
        get: () => ({
          workspace: "agent-s1",
          goal: {
            id: "g1",
            objective: "Finish verified work",
            tokenBudget: 100,
            gates: ["node gate.mjs"],
            status: "budget_limited",
            runTokenBase: 40,
            continuationCount: 2,
          },
        }),
      }).surface,
  });
  assert.equal(code, 0, terminal.err.join("\n"));
  const text = terminal.out.join("\n");
  assert.match(text, /status: budget_limited/);
  assert.match(text, /budget: 100 tokens$/m);
  assert.match(text, /continuations: 2/);
  assert.doesNotMatch(text, /undefined/);
});

test("status prefers getGoal when the workbench has one", async () => {
  const { surface, calls } = fake({
    async getGoal(sessionId) {
      calls.push({ method: "getGoal", args: [sessionId] });
      return { ...goal, status: "completed", endedAt: "2026-11-21T10:05:00.000Z" };
    },
  });
  const terminal = io();
  const code = await runGoalCommand(["status", "--session", "s1"], terminal, {
    workbench: async () => surface,
  });
  assert.equal(code, 0, terminal.err.join("\n"));
  const text = terminal.out.join("\n");
  assert.match(text, /status: completed/);
  assert.match(text, /ended: 2026-11-21T10:05:00\.000Z/);
  assert.deepEqual(calls, [{ method: "getGoal", args: ["s1"] }]);
});

test("status reports a session with no goal and succeeds", async () => {
  const terminal = io();
  const code = await runGoalCommand(["status", "--session", "s1"], terminal, {
    workbench: async () => fake({ get: () => ({ workspace: "agent-s1" }) }).surface,
  });
  assert.equal(code, 0);
  assert.match(terminal.out.join("\n"), /No goal for session s1\./);
});

test("status refuses a session the workbench does not hold", async () => {
  const terminal = io();
  const code = await runGoalCommand(["status", "--session", "missing"], terminal, {
    workbench: async () => fake({ get: () => undefined }).surface,
  });
  assert.equal(code, 1);
  assert.match(terminal.err.join("\n"), /Session not found\./);
  assert.equal(terminal.out.length, 0);
});

test("cancel cancels the session goal and prints what the workbench reports", async () => {
  const { surface, calls } = fake();
  const terminal = io();
  const code = await runGoalCommand(["cancel", "--session", "s1"], terminal, {
    workbench: async () => surface,
  });
  assert.equal(code, 0, terminal.err.join("\n"));
  assert.deepEqual(calls, [{ method: "cancel", args: ["s1"] }]);
  const text = terminal.out.join("\n");
  assert.match(text, /status: cancelled/);
  assert.match(text, /Cancelled the goal for s1\./);
});

test("cancel accepts a workbench that reports nothing back", async () => {
  const terminal = io();
  const code = await runGoalCommand(["cancel", "--session", "s1"], terminal, {
    workbench: async () => fake({ async cancelGoal() {} }).surface,
  });
  assert.equal(code, 0);
  assert.match(terminal.out.join("\n"), /Cancelled the goal for s1\./);
});

test("status and cancel refuse the options that belong to start", async () => {
  // Silently ignoring --gate on cancel would let an operator believe a
  // completion gate was registered when nothing was.
  let opened = false;
  const deps = {
    workbench: async () => {
      opened = true;
      return fake().surface;
    },
  };

  const budget = io();
  assert.equal(
    await runGoalCommand(["status", "--session", "s1", "--token-budget", "10"], budget, deps),
    1,
  );
  assert.match(budget.err.join("\n"), /status action takes no --token-budget/);

  const gate = io();
  assert.equal(
    await runGoalCommand(["cancel", "--session", "s1", "--gate", "pnpm test"], gate, deps),
    1,
  );
  assert.match(gate.err.join("\n"), /cancel action takes no --gate/);

  const objective = io();
  assert.equal(
    await runGoalCommand(["status", "--session", "s1", "Finish"], objective, deps),
    1,
  );
  assert.match(objective.err.join("\n"), /status action takes no objective/);

  assert.equal(opened, false);
});

test("a workbench without goal support is named, not guessed at", async () => {
  const terminal = io();
  const code = await runGoalCommand(["start", "--session", "s1", "--token-budget", "10", "Finish"], terminal, {
    workbench: async () => fake({ startGoal: undefined }).surface,
  });
  assert.equal(code, 1);
  assert.match(terminal.err.join("\n"), /no goal support/);
  assert.equal(terminal.out.length, 0);

  const cancel = io();
  assert.equal(
    await runGoalCommand(["cancel", "--session", "s1"], cancel, {
      workbench: async () => fake({ cancelGoal: undefined }).surface,
    }),
    1,
  );
  assert.match(cancel.err.join("\n"), /no goal support/);
});

test("a refusal from the workbench is printed as its own sentence", async () => {
  const terminal = io();
  const code = await runGoalCommand(
    [
      "start",
      "--session",
      "s1",
      "--token-budget",
      "10",
      "--gate",
      "curl https://example.test",
      "Finish",
    ],
    terminal,
    {
      workbench: async () =>
        fake({
          async startGoal() {
            throw new Error("The gate is not on the runtime hook allowlist.");
          },
        }).surface,
    },
  );
  assert.equal(code, 1);
  assert.match(terminal.err.join("\n"), /not on the runtime hook allowlist\./);
  assert.equal(terminal.out.length, 0);
});

test("the CLI never runs a gate command", async () => {
  const directory = mkdtempSync(join(tmpdir(), "nomo-goal-gate-"));
  try {
    const marker = join(directory, "ran.txt");
    const terminal = io();
    const code = await runGoalCommand(
      [
        "start",
        "--session",
        "s1",
        "--token-budget",
        "10",
        "--gate",
        `${process.execPath} -e "require('node:fs').writeFileSync('${marker}','ran')"`,
        "Finish",
      ],
      terminal,
      { workbench: async () => fake().surface },
    );
    assert.equal(code, 0, terminal.err.join("\n"));
    assert.equal(
      existsSync(marker),
      false,
      "a gate runs in the workbench loop, never in the command that records it",
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a machine with no workspace is refused, and none is created", async () => {
  const directory = join(tmpdir(), "nomo-goal-no-workspace-" + Date.now());
  const terminal = io();
  const code = await runGoalCommand(["status", "--session", "s1"], terminal, {
    env: { NOMO_DATA_DIR: directory },
  });
  assert.equal(code, 1);
  assert.match(terminal.err.join("\n"), /No workspace at/);
  assert.equal(
    existsSync(directory),
    false,
    "a command that only reads must not create the workspace it would read",
  );
});

test("status against the real workbench refuses a session it does not hold", async () => {
  // The surface above is a double. This one opens the workbench the binary
  // opens, so the cast from the real class to the narrow surface is proven
  // against the class rather than against the shape a test guessed.
  const directory = mkdtempSync(join(tmpdir(), "nomo-goal-real-"));
  try {
    const terminal = io();
    const code = await runGoalCommand(["status", "--session", "missing"], terminal, {
      env: { NOMO_DATA_DIR: directory },
    });
    assert.equal(code, 1);
    assert.match(terminal.err.join("\n"), /Session not found\./);
    assert.equal(terminal.out.length, 0);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("an unknown action, an unknown option and a missing value are refused by name", async () => {
  const unknownAction = io();
  assert.equal(await runGoalCommand(["pause"], unknownAction), 1);
  assert.match(unknownAction.err.join("\n"), /Unknown goal action pause\./);

  const unknownOption = io();
  assert.equal(
    await runGoalCommand(["status", "--session", "s1", "--budget", "10"], unknownOption, {
      workbench: async () => fake().surface,
    }),
    1,
  );
  assert.match(unknownOption.err.join("\n"), /Unknown option --budget\./);

  const missingValue = io();
  assert.equal(
    await runGoalCommand(["start", "--session", "s1", "--token-budget"], missingValue, {
      workbench: async () => fake().surface,
    }),
    1,
  );
  assert.match(missingValue.err.join("\n"), /--token-budget option needs a value/);

  const missingSessionValue = io();
  assert.equal(
    await runGoalCommand(["status", "--session", "--token-budget", "10"], missingSessionValue, {
      workbench: async () => fake().surface,
    }),
    1,
  );
  assert.match(missingSessionValue.err.join("\n"), /--session option needs a value/);
});

test("no action prints the usage and fails", async () => {
  const terminal = io();
  const code = await runGoalCommand([], terminal, {
    workbench: async () => fake().surface,
  });
  assert.equal(code, 1);
  assert.match(terminal.out.join("\n"), /nomo goal start --session <id> --token-budget <n>/);
});

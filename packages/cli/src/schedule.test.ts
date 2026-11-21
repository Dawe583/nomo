import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  runScheduleCommand,
  type ScheduleSurface,
  type ScheduleView,
} from "./schedule.ts";
import type { Schedule } from "../../workbench/src/schedules.ts";

/**
 * The schedule command, at the boundary an operator or a script touches.
 *
 * Three things matter here. The record reaches the workbench exactly as the
 * operator stated it, because the workbench parses it with the rules module and
 * a field this command dropped or invented would be a schedule nobody approved.
 * A command that would be refused is refused before the workbench is opened, so
 * a typo never creates workspace state. And nothing here runs a firing: only
 * `runDueSchedules` may start work, and it does so through the governed path
 * inside the workbench.
 */

const schedule: ScheduleView = {
  id: "11111111-1111-4111-8111-111111111111",
  name: "nightly",
  cadence: { kind: "interval", everySeconds: 300 },
  status: "active",
  enabled: true,
  maxRuns: 10,
  runCount: 0,
  tokensUsed: 0,
  nextRunAt: "2026-11-21T10:05:00.000Z",
};

const SESSION = "22222222-2222-4222-8222-222222222222";

function fake(overrides: Partial<ScheduleSurface> = {}) {
  const calls: { method: string; args: readonly unknown[] }[] = [];
  const surface: ScheduleSurface = {
    async listSchedules() {
      calls.push({ method: "listSchedules", args: [] });
      return [schedule];
    },
    async createSchedule(input) {
      calls.push({ method: "createSchedule", args: [input] });
      return {
        ...schedule,
        name: input.name,
        cadence: input.cadence,
        maxRuns: input.maxRuns,
        enabled: input.enabled,
        status: input.enabled ? "active" : "paused",
      };
    },
    async pauseSchedule(id) {
      calls.push({ method: "pauseSchedule", args: [id] });
      return { ...schedule, id, status: "paused", enabled: false };
    },
    async resumeSchedule(id) {
      calls.push({ method: "resumeSchedule", args: [id] });
      return { ...schedule, id, status: "active", enabled: true };
    },
    async deleteSchedule(id) {
      calls.push({ method: "deleteSchedule", args: [id] });
      return true;
    },
    async runDueSchedules(nowMs) {
      calls.push({ method: "runDueSchedules", args: [nowMs] });
      return [];
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

/** A dependency that records whether the workspace was opened at all, so a
 * refusal can be proven to happen before any store is touched. */
function unopened(overrides: Partial<ScheduleSurface> = {}) {
  const state = { opened: false };
  const deps = {
    workbench: async () => {
      state.opened = true;
      return fake(overrides).surface;
    },
  };
  return { state, deps };
}

test("add hands the operator's fields to the workbench and prints the record", async () => {
  const { surface, calls } = fake();
  const terminal = io();
  const code = await runScheduleCommand(
    [
      "add",
      "--name",
      "nightly",
      "--every",
      "300",
      "--max-runs",
      "10",
      "--token-budget",
      "500",
      "--session",
      SESSION,
      "--model",
      "deepseek/v4",
      "--agent",
      "nomo-worker",
      "Run",
      "the",
      "nightly",
      "sweep",
    ],
    terminal,
    { workbench: async () => surface },
  );
  assert.equal(code, 0, terminal.err.join("\n"));
  // The exact key set, because the workbench parser refuses an unknown key by
  // name: a field invented or dropped here is a refusal the operator cannot
  // explain from what they typed.
  assert.deepEqual(calls, [
    {
      method: "createSchedule",
      args: [
        {
          name: "nightly",
          prompt: "Run the nightly sweep",
          cadence: { kind: "interval", everySeconds: 300 },
          maxRuns: 10,
          enabled: true,
          sessionId: SESSION,
          model: "deepseek/v4",
          agent: "nomo-worker",
          tokenBudget: 500,
        },
      ],
    },
  ]);
  const text = terminal.out.join("\n");
  assert.match(text, /id: 11111111-1111-4111-8111-111111111111/);
  assert.match(text, /name: nightly/);
  assert.match(text, /cadence: every 300 seconds/);
  assert.match(text, /status: active/);
  assert.match(text, /enabled: yes/);
  assert.match(text, /runs: 0 of 10/);
  assert.match(text, /next: 2026-11-21T10:05:00\.000Z/);
  assert.match(text, /Created schedule 11111111-1111-4111-8111-111111111111\./);
  assert.match(text, /this command never does/);
});

test("add --at records a once cadence with the instant as typed", async () => {
  const { surface, calls } = fake();
  const terminal = io();
  const code = await runScheduleCommand(
    [
      "add",
      "--name",
      "one shot",
      "--at",
      "2030-01-01T00:00:00.000Z",
      "--max-runs",
      "1",
      "wake",
    ],
    terminal,
    { workbench: async () => surface },
  );
  assert.equal(code, 0, terminal.err.join("\n"));
  assert.deepEqual(calls, [
    {
      method: "createSchedule",
      args: [
        {
          name: "one shot",
          prompt: "wake",
          cadence: { kind: "once", at: "2030-01-01T00:00:00.000Z" },
          maxRuns: 1,
          enabled: true,
        },
      ],
    },
  ]);
  assert.match(terminal.out.join("\n"), /cadence: once at 2030-01-01T00:00:00\.000Z/);
});

test("add --paused creates a record that cannot fire until it is resumed", async () => {
  const { surface, calls } = fake();
  const terminal = io();
  const code = await runScheduleCommand(
    ["add", "--name", "held", "--every", "600", "--max-runs", "2", "--paused", "later"],
    terminal,
    { workbench: async () => surface },
  );
  assert.equal(code, 0, terminal.err.join("\n"));
  const input = calls[0]?.args[0] as { enabled?: boolean };
  assert.equal(input.enabled, false);
  const text = terminal.out.join("\n");
  assert.match(text, /enabled: no/);
  assert.doesNotMatch(text, /enabled: yes/);
});

test("a prompt typed as several words is one prompt", async () => {
  const { surface, calls } = fake();
  const terminal = io();
  const code = await runScheduleCommand(
    ["add", "--name", "n", "--every", "60", "--max-runs", "1", "do", "the", "thing"],
    terminal,
    { workbench: async () => surface },
  );
  assert.equal(code, 0, terminal.err.join("\n"));
  const input = calls[0]?.args[0] as { prompt?: string };
  assert.equal(input.prompt, "do the thing");
});

test("a cadence that is missing, doubled or not a whole number is refused before the store opens", async () => {
  const { state, deps } = unopened();

  const missing = io();
  assert.equal(
    await runScheduleCommand(["add", "--name", "n", "--max-runs", "1", "go"], missing, deps),
    1,
  );
  assert.match(missing.err.join("\n"), /needs a cadence: --every <seconds> or --at <iso>/);

  const doubled = io();
  assert.equal(
    await runScheduleCommand(
      [
        "add",
        "--name",
        "n",
        "--every",
        "60",
        "--at",
        "2030-01-01T00:00:00.000Z",
        "--max-runs",
        "1",
        "go",
      ],
      doubled,
      deps,
    ),
    1,
  );
  assert.match(doubled.err.join("\n"), /takes --every or --at, not both/);

  for (const every of ["0", "-5", "1.5", "ten", "1e3"]) {
    const terminal = io();
    assert.equal(
      await runScheduleCommand(
        ["add", "--name", "n", "--every", every, "--max-runs", "1", "go"],
        terminal,
        deps,
      ),
      1,
      every,
    );
    assert.match(
      terminal.err.join("\n"),
      /--every value must be a whole number of seconds above zero/,
      every,
    );
  }

  const at = io();
  assert.equal(
    await runScheduleCommand(
      ["add", "--name", "n", "--at", "tomorrow", "--max-runs", "1", "go"],
      at,
      deps,
    ),
    1,
  );
  assert.match(at.err.join("\n"), /--at value must be an ISO 8601 instant/);

  assert.equal(state.opened, false, "a refusal must not open the workspace");
});

test("a missing name, run ceiling, prompt or budget is refused by name", async () => {
  const { state, deps } = unopened();

  const noName = io();
  assert.equal(
    await runScheduleCommand(["add", "--every", "60", "--max-runs", "1", "go"], noName, deps),
    1,
  );
  assert.match(noName.err.join("\n"), /needs a name: --name <name>/);

  const noRuns = io();
  assert.equal(
    await runScheduleCommand(["add", "--name", "n", "--every", "60", "go"], noRuns, deps),
    1,
  );
  assert.match(noRuns.err.join("\n"), /needs a run ceiling: --max-runs <n>/);

  for (const maxRuns of ["0", "-2", "2.5", "many"]) {
    const terminal = io();
    assert.equal(
      await runScheduleCommand(
        ["add", "--name", "n", "--every", "60", "--max-runs", maxRuns, "go"],
        terminal,
        deps,
      ),
      1,
      maxRuns,
    );
    assert.match(
      terminal.err.join("\n"),
      /--max-runs value must be a whole number of runs above zero/,
      maxRuns,
    );
  }

  for (const budget of ["0", "-7", "1.5", "lots"]) {
    const terminal = io();
    assert.equal(
      await runScheduleCommand(
        [
          "add",
          "--name",
          "n",
          "--every",
          "60",
          "--max-runs",
          "1",
          "--token-budget",
          budget,
          "go",
        ],
        terminal,
        deps,
      ),
      1,
      budget,
    );
    assert.match(
      terminal.err.join("\n"),
      /--token-budget value must be a whole number of tokens above zero/,
      budget,
    );
  }

  const noPrompt = io();
  assert.equal(
    await runScheduleCommand(
      ["add", "--name", "n", "--every", "60", "--max-runs", "1"],
      noPrompt,
      deps,
    ),
    1,
  );
  assert.match(noPrompt.err.join("\n"), /needs a prompt/);

  assert.equal(state.opened, false);
});

test("an interval below the rules bound is handed through, not re-decided here", async () => {
  // The minimum interval, the run ceiling and the budget ceiling belong to
  // `packages/workbench/src/schedules.ts`. A second copy here would be a second
  // answer to what the workbench allows.
  const { surface, calls } = fake();
  const terminal = io();
  const code = await runScheduleCommand(
    ["add", "--name", "n", "--every", "5", "--max-runs", "5000", "go"],
    terminal,
    { workbench: async () => surface },
  );
  assert.equal(code, 0, terminal.err.join("\n"));
  const input = calls[0]?.args[0] as {
    cadence?: { everySeconds?: number };
    maxRuns?: number;
  };
  assert.equal(input.cadence?.everySeconds, 5);
  assert.equal(input.maxRuns, 5000);
});

test("list prints one line per schedule", async () => {
  const { surface, calls } = fake();
  const terminal = io();
  const code = await runScheduleCommand(["list"], terminal, {
    workbench: async () => surface,
  });
  assert.equal(code, 0, terminal.err.join("\n"));
  assert.deepEqual(calls, [{ method: "listSchedules", args: [] }]);
  assert.equal(terminal.out[0], "1 schedule.");
  const line = terminal.out.find((entry) => entry.includes(schedule.id)) ?? "";
  assert.match(line, /active/);
  assert.match(line, /every 300 seconds/);
  assert.match(line, /next 2026-11-21T10:05:00\.000Z/);
  assert.match(line, /runs 0\/10/);
  assert.match(line, /nightly$/);
});

test("list reads the design record's schedules() spelling too", async () => {
  // The design record names the workbench reader `schedules()`; this command
  // reads either spelling, so the two cannot disagree about whether schedules
  // exist.
  const terminal = io();
  const code = await runScheduleCommand(["list"], terminal, {
    workbench: async () => ({
      async schedules() {
        return [schedule];
      },
    }),
  });
  assert.equal(code, 0, terminal.err.join("\n"));
  assert.match(terminal.out.join("\n"), /nightly$/m);
});

test("list with no records says so and succeeds", async () => {
  const terminal = io();
  const code = await runScheduleCommand(["list"], terminal, {
    workbench: async () => fake({ async listSchedules() { return []; } }).surface,
  });
  assert.equal(code, 0);
  assert.match(terminal.out.join("\n"), /No schedules\./);
});

test("a record that carries only the required fields prints no undefined", async () => {
  const terminal = io();
  const code = await runScheduleCommand(["list"], terminal, {
    workbench: async () =>
      fake({
        async listSchedules() {
          return [
            {
              id: "33333333-3333-4333-8333-333333333333",
              name: "bare",
              cadence: { kind: "once", at: "2030-01-01T00:00:00.000Z" },
              status: "paused_unknown",
              enabled: false,
              maxRuns: 1,
              runCount: 0,
              nextRunAt: "2030-01-01T00:00:00.000Z",
            },
          ];
        },
      }).surface,
  });
  assert.equal(code, 0, terminal.err.join("\n"));
  const text = terminal.out.join("\n");
  assert.match(text, /paused_unknown/);
  assert.doesNotMatch(text, /undefined/);
});

test("a full workbench record prints every field it carries, and never the prompt", async () => {
  // The cast from `Workbench` to `ScheduleSurface` is unchecked, so this
  // assignment is the only place the stored record and the printed view are
  // compared. If the workbench record stopped satisfying the view, the narrow
  // surface would be a shape the real class cannot fill and only this line
  // would say so.
  const record: Schedule = {
    id: "44444444-4444-4444-8444-444444444444",
    name: "full",
    prompt: "run the sweep",
    cadence: { kind: "interval", everySeconds: 3600 },
    sessionId: SESSION,
    model: "deepseek/v4",
    agent: "nomo-worker",
    maxRuns: 3,
    tokenBudget: 1000,
    enabled: true,
    status: "active",
    runCount: 1,
    tokensUsed: 250,
    createdAt: "2026-11-21T09:00:00.000Z",
    nextRunAt: "2026-11-21T11:00:00.000Z",
    lastRunAt: "2026-11-21T10:00:00.000Z",
    lastSessionId: SESSION,
    lastOutcome: "idle",
  };
  const view: ScheduleView = record;
  const terminal = io();
  const code = await runScheduleCommand(["list"], terminal, {
    workbench: async () => ({
      async listSchedules() {
        return [view];
      },
    }),
  });
  assert.equal(code, 0, terminal.err.join("\n"));
  const text = terminal.out.join("\n");
  assert.match(text, /every 3600 seconds/);
  assert.match(text, /tokens 250\/1000/);
  assert.match(text, /runs 1\/3/);
  assert.match(text, /full$/m);
  assert.doesNotMatch(text, /run the sweep/, "a listing does not echo the prompt");

  const detail = io();
  assert.equal(
    await runScheduleCommand(["pause", record.id], detail, {
      workbench: async () => ({
        async pauseSchedule() {
          return { ...view, status: "paused", enabled: false };
        },
      }),
    }),
    0,
    detail.err.join("\n"),
  );
  const block = detail.out.join("\n");
  assert.match(block, /tokens: 250 of 1000/);
  assert.match(block, /created: 2026-11-21T09:00:00\.000Z/);
  assert.match(block, /last run: 2026-11-21T10:00:00\.000Z/);
  assert.match(block, /last outcome: idle/);
  assert.match(block, /last session: 22222222-2222-4222-8222-222222222222/);
  assert.match(block, /session: 22222222-2222-4222-8222-222222222222/);
  assert.match(block, /model: deepseek\/v4/);
  assert.match(block, /agent: nomo-worker/);
  assert.doesNotMatch(block, /undefined/);
});

test("pause and resume act on the id the operator named", async () => {
  const paused = fake();
  const pauseTerminal = io();
  assert.equal(
    await runScheduleCommand(["pause", schedule.id], pauseTerminal, {
      workbench: async () => paused.surface,
    }),
    0,
    pauseTerminal.err.join("\n"),
  );
  assert.deepEqual(paused.calls, [{ method: "pauseSchedule", args: [schedule.id] }]);
  const pausedText = pauseTerminal.out.join("\n");
  assert.match(pausedText, /status: paused/);
  assert.match(pausedText, /enabled: no/);
  assert.match(pausedText, /Paused schedule 11111111-1111-4111-8111-111111111111\./);

  const resumed = fake();
  const resumeTerminal = io();
  assert.equal(
    await runScheduleCommand(["resume", schedule.id], resumeTerminal, {
      workbench: async () => resumed.surface,
    }),
    0,
    resumeTerminal.err.join("\n"),
  );
  assert.deepEqual(resumed.calls, [{ method: "resumeSchedule", args: [schedule.id] }]);
  assert.match(
    resumeTerminal.out.join("\n"),
    /Resumed schedule 11111111-1111-4111-8111-111111111111\./,
  );
});

test("remove deletes the record and reports one the workbench never held", async () => {
  const removed = fake();
  const terminal = io();
  assert.equal(
    await runScheduleCommand(["remove", schedule.id], terminal, {
      workbench: async () => removed.surface,
    }),
    0,
    terminal.err.join("\n"),
  );
  assert.deepEqual(removed.calls, [{ method: "deleteSchedule", args: [schedule.id] }]);
  assert.match(
    terminal.out.join("\n"),
    /Removed schedule 11111111-1111-4111-8111-111111111111\./,
  );

  const absent = io();
  assert.equal(
    await runScheduleCommand(["remove", schedule.id], absent, {
      workbench: async () =>
        fake({ async deleteSchedule() { return false; } }).surface,
    }),
    1,
  );
  assert.match(absent.err.join("\n"), /No schedule 11111111-1111-4111-8111-111111111111\./);
  assert.equal(absent.out.length, 0);

  const silent = io();
  assert.equal(
    await runScheduleCommand(["remove", schedule.id], silent, {
      workbench: async () => fake({ async deleteSchedule() {} }).surface,
    }),
    0,
    silent.err.join("\n"),
  );
});

test("rm is the same action as remove", async () => {
  const { surface, calls } = fake();
  const terminal = io();
  assert.equal(
    await runScheduleCommand(["rm", schedule.id], terminal, {
      workbench: async () => surface,
    }),
    0,
    terminal.err.join("\n"),
  );
  assert.deepEqual(calls, [{ method: "deleteSchedule", args: [schedule.id] }]);
});

test("run-due asks for one evaluation at the injected clock and touches nothing else", async () => {
  // The only method called is the one that evaluates due schedules. This
  // command cannot start a run, and the assertion on the call list is what
  // proves it rather than a comment that says so.
  const { surface, calls } = fake({
    async runDueSchedules(nowMs) {
      calls.push({ method: "runDueSchedules", args: [nowMs] });
      return [
        { scheduleId: "a", outcome: "idle" },
        { scheduleId: "b", outcome: "failed", sessionId: "s2" },
      ];
    },
  });
  const terminal = io();
  const code = await runScheduleCommand(["run-due"], terminal, {
    workbench: async () => surface,
    now: () => 1_700_000_000_000,
  });
  assert.equal(code, 0, terminal.err.join("\n"));
  assert.deepEqual(calls, [{ method: "runDueSchedules", args: [1_700_000_000_000] }]);
  assert.deepEqual(terminal.out, ["a idle", "b failed session s2", "Fired 2 schedules."]);
});

test("run-due with nothing due says so and succeeds", async () => {
  const terminal = io();
  const code = await runScheduleCommand(["run-due"], terminal, {
    workbench: async () => fake().surface,
  });
  assert.equal(code, 0, terminal.err.join("\n"));
  assert.match(terminal.out.join("\n"), /No schedule is due\./);
});

test("the actions that are not add refuse the flags only add understands", async () => {
  // Silently ignoring --every on pause would let an operator believe a cadence
  // was changed when nothing was.
  const { state, deps } = unopened();
  const cases: readonly (readonly [string[], RegExp])[] = [
    [["list", "--every", "60"], /list action takes no --every/],
    [["list", "--name", "n"], /list action takes no --name/],
    [["list", "extra"], /list action takes no prompt/],
    [["pause", schedule.id, "--name", "n"], /pause action takes no --name/],
    [["resume", schedule.id, "--max-runs", "3"], /resume action takes no --max-runs/],
    [["remove", schedule.id, "--session", SESSION], /remove action takes no --session/],
    [["run-due", "--paused"], /run-due action takes no --paused/],
    [["run-due", "--at", "2030-01-01T00:00:00.000Z"], /run-due action takes no --at/],
    [["run-due", "extra"], /run-due action takes no prompt/],
  ];
  for (const [args, expected] of cases) {
    const terminal = io();
    assert.equal(await runScheduleCommand(args, terminal, deps), 1, args.join(" "));
    assert.match(terminal.err.join("\n"), expected, args.join(" "));
  }
  assert.equal(state.opened, false, "a refusal must not open the workspace");
});

test("pause, resume and remove need exactly one schedule id", async () => {
  const { state, deps } = unopened();
  const cases: readonly (readonly [string[], RegExp])[] = [
    [["pause"], /pause action needs a schedule id/],
    [["resume"], /resume action needs a schedule id/],
    [["remove"], /remove action needs a schedule id/],
    [["pause", "a", "b"], /pause action takes one schedule id/],
    [["resume", "a", "b"], /resume action takes one schedule id/],
    [["remove", "a", "b"], /remove action takes one schedule id/],
  ];
  for (const [args, expected] of cases) {
    const terminal = io();
    assert.equal(await runScheduleCommand(args, terminal, deps), 1, args.join(" "));
    assert.match(terminal.err.join("\n"), expected, args.join(" "));
  }
  assert.equal(state.opened, false);
});

test("a workbench without schedule support is named, not guessed at", async () => {
  const cases: readonly (readonly [string[], Partial<ScheduleSurface>])[] = [
    [["list"], { listSchedules: undefined }],
    [["add", "--name", "n", "--every", "60", "--max-runs", "1", "go"], { createSchedule: undefined }],
    [["pause", schedule.id], { pauseSchedule: undefined }],
    [["resume", schedule.id], { resumeSchedule: undefined }],
    [["remove", schedule.id], { deleteSchedule: undefined }],
    [["run-due"], { runDueSchedules: undefined }],
  ];
  for (const [args, overrides] of cases) {
    const terminal = io();
    assert.equal(
      await runScheduleCommand(args, terminal, {
        workbench: async () => fake(overrides).surface,
      }),
      1,
      args.join(" "),
    );
    assert.match(terminal.err.join("\n"), /no schedule support/, args.join(" "));
    assert.equal(terminal.out.length, 0, args.join(" "));
  }
});

test("a refusal from the workbench is printed as its own sentence", async () => {
  const terminal = io();
  const code = await runScheduleCommand(
    ["add", "--name", "n", "--every", "5", "--max-runs", "1", "go"],
    terminal,
    {
      workbench: async () =>
        fake({
          async createSchedule() {
            throw new Error(
              "Invalid schedule input: cadence.everySeconds is at least 60 seconds, got 5.",
            );
          },
        }).surface,
    },
  );
  assert.equal(code, 1);
  assert.match(terminal.err.join("\n"), /at least 60 seconds, got 5\./);
  assert.equal(terminal.out.length, 0);
});

test("a machine with no workspace is refused, and none is created", async () => {
  const directory = join(tmpdir(), "nomo-schedule-no-workspace-" + Date.now());
  const terminal = io();
  const code = await runScheduleCommand(["list"], terminal, {
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

test("list against the real workbench reads the real schedule table", async () => {
  // The surface above is a double. This one opens the workbench the binary
  // opens, so the cast from the real class to the narrow surface is proven
  // against the class rather than against the shape a test guessed. Before the
  // wiring landed this asserted the missing-support refusal; now it asserts the
  // listing the wired class answers.
  const directory = mkdtempSync(join(tmpdir(), "nomo-schedule-real-"));
  try {
    const terminal = io();
    const code = await runScheduleCommand(["list"], terminal, {
      env: { NOMO_DATA_DIR: directory },
    });
    assert.equal(code, 0, terminal.err.join("\n"));
    assert.match(terminal.out.join("\n"), /No schedules\./);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("an unknown action, an unknown option and a missing value are refused by name", async () => {
  const { state, deps } = unopened();

  const unknownAction = io();
  assert.equal(await runScheduleCommand(["fire"], unknownAction, deps), 1);
  assert.match(unknownAction.err.join("\n"), /Unknown schedule action fire\./);

  const unknownOption = io();
  assert.equal(await runScheduleCommand(["list", "--dry-run"], unknownOption, deps), 1);
  assert.match(unknownOption.err.join("\n"), /Unknown option --dry-run\./);

  const missingValue = io();
  assert.equal(await runScheduleCommand(["add", "--name"], missingValue, deps), 1);
  assert.match(missingValue.err.join("\n"), /--name option needs a value/);

  const flagAsValue = io();
  assert.equal(
    await runScheduleCommand(
      ["add", "--name", "--every", "60", "--max-runs", "1", "go"],
      flagAsValue,
      deps,
    ),
    1,
  );
  assert.match(flagAsValue.err.join("\n"), /--name option needs a value/);

  assert.equal(state.opened, false);
});

test("no action prints the usage and fails, and --help prints it and succeeds", async () => {
  const none = io();
  assert.equal(await runScheduleCommand([], none), 1);
  assert.match(none.out.join("\n"), /nomo schedule add --name <name>/);

  const help = io();
  assert.equal(await runScheduleCommand(["--help"], help), 0);
  const text = help.out.join("\n");
  assert.match(text, /nomo schedule list/);
  assert.match(text, /nomo schedule run-due/);
  assert.match(text, /operator record/);
});

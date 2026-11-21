/**
 * HP9: an operator-owned schedule is a prompt, a cadence and a bounded budget.
 *
 * The parser and the two transitions are the whole contract the parent
 * integration leans on, so the tests treat them as the trust boundary: the
 * schema has no field a model could use to widen it, a cadence can never be
 * shorter than the floor, a firing that cannot be proved due is never returned
 * and an unproven outcome parks the schedule for the operator instead of
 * guessing.
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  SCHEDULE_LIMITS,
  dueSchedules,
  parseScheduleInput,
  recordScheduleRun,
  type Schedule,
  type ScheduleCadence,
  type ScheduleStatus,
} from "./schedules.ts";

/** 2026-11-21T09:00:00.000Z, a fixed anchor so every expectation is exact. */
const NOW = Date.parse("2026-11-21T09:00:00.000Z");
const T0 = "2026-11-21T09:00:00.000Z";
const T1 = "2026-11-21T10:00:00.000Z";

const SESSION = "5f2b6c1e-0f3a-4b7c-9d21-8a1c2d3e4f50";
const OTHER_SESSION = "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";

const MAX_PROMPT = 32_000;

const input = (overrides: Record<string, unknown> = {}) => ({
  name: "Nightly suite",
  prompt: "Run the suite and summarize the failures.",
  cadence: { kind: "interval", everySeconds: 3600 },
  maxRuns: 10,
  ...overrides,
});

const schedule = (overrides: Partial<Schedule> = {}): Schedule => ({
  id: "sched-1",
  name: "Nightly suite",
  prompt: "Run the suite and summarize the failures.",
  cadence: { kind: "interval", everySeconds: 3600 },
  maxRuns: 10,
  enabled: true,
  status: "active",
  runCount: 0,
  tokensUsed: 0,
  createdAt: "2026-11-21T08:00:00.000Z",
  nextRunAt: T0,
  ...overrides,
});

const refuses = (run: () => unknown, pattern: RegExp) =>
  assert.throws(run, pattern);

test("the limits are the operator's contract", () => {
  assert.deepEqual(SCHEDULE_LIMITS, {
    schedules: 32,
    minIntervalSeconds: 60,
    maxIntervalSeconds: 604_800,
    maxRuns: 1_000,
    tokenBudgetMax: 1_000_000,
    nameCharacters: 80,
  });
});

test("a minimal schedule is trimmed and takes the documented defaults", () => {
  const parsed = parseScheduleInput(
    {
      name: "  Nightly suite  ",
      prompt: "  Run the suite.  ",
      cadence: { kind: "interval", everySeconds: 3600 },
      maxRuns: 10,
    },
    MAX_PROMPT,
    NOW,
  );
  assert.deepEqual(parsed, {
    name: "Nightly suite",
    prompt: "Run the suite.",
    cadence: { kind: "interval", everySeconds: 3600 },
    maxRuns: 10,
    enabled: true,
    nextRunAt: T1,
  });
});

test("an interval schedule first fires one interval after it is created", () => {
  for (const everySeconds of [60, 3600, 86_400, 604_800])
    assert.equal(
      parseScheduleInput(
        input({ cadence: { kind: "interval", everySeconds } }),
        MAX_PROMPT,
        NOW,
      ).nextRunAt,
      new Date(NOW + everySeconds * 1000).toISOString(),
    );
});

test("a once schedule keeps the operator's instant, canonicalised", () => {
  assert.equal(
    parseScheduleInput(
      input({ cadence: { kind: "once", at: "2026-12-01T10:00:00+01:00" } }),
      MAX_PROMPT,
      NOW,
    ).nextRunAt,
    "2026-12-01T09:00:00.000Z",
  );
});

test("the same nowMs always yields the same nextRunAt", () => {
  const a = parseScheduleInput(input(), MAX_PROMPT, NOW);
  const b = parseScheduleInput(input(), MAX_PROMPT, NOW);
  assert.deepEqual(a, b);
  assert.notEqual(
    parseScheduleInput(input(), MAX_PROMPT, NOW + 1000).nextRunAt,
    a.nextRunAt,
  );
});

test("without nowMs the next firing is still in the future", () => {
  const parsed = parseScheduleInput(input(), MAX_PROMPT);
  assert.ok(Date.parse(parsed.nextRunAt) > Date.now());
});

test("a clock the caller cannot state is refused, not rounded", () => {
  for (const nowMs of [Number.NaN, -1, 1.5, Number.POSITIVE_INFINITY])
    refuses(
      () => parseScheduleInput(input(), MAX_PROMPT, nowMs),
      /nowMs must be a non-negative integer/,
    );
});

test("only the nine operator fields exist", () => {
  for (const value of [null, "schedule", [], 7])
    refuses(() => parseScheduleInput(value, MAX_PROMPT, NOW), /expected an object/);
  for (const field of [
    "id",
    "status",
    "runCount",
    "tokensUsed",
    "nextRunAt",
    "createdAt",
    "lastRunAt",
  ])
    refuses(
      () => parseScheduleInput(input({ [field]: "x" }), MAX_PROMPT, NOW),
      new RegExp(`unknown field "${field}"`),
    );
});

test("a name is bounded text with no control character", () => {
  refuses(() => parseScheduleInput(input({ name: 5 }), MAX_PROMPT, NOW), /name must be text/);
  refuses(() => parseScheduleInput(input({ name: "   " }), MAX_PROMPT, NOW), /name must not be empty/);
  refuses(
    () => parseScheduleInput(input({ name: "x".repeat(81) }), MAX_PROMPT, NOW),
    /name is at most 80 characters, got 81/,
  );
  assert.equal(
    parseScheduleInput(input({ name: "x".repeat(80) }), MAX_PROMPT, NOW).name,
    "x".repeat(80),
  );
  refuses(
    () => parseScheduleInput(input({ name: "night\u0000ly" }), MAX_PROMPT, NOW),
    /name contains a control character/,
  );
});

test("a prompt is prose, so it may span lines but stays inside the operator bound", () => {
  const prompt = "Line one.\n\tLine two.";
  assert.equal(
    parseScheduleInput(input({ prompt }), MAX_PROMPT, NOW).prompt,
    prompt,
  );
  refuses(() => parseScheduleInput(input({ prompt: 5 }), MAX_PROMPT, NOW), /prompt must be text/);
  refuses(() => parseScheduleInput(input({ prompt: "  " }), MAX_PROMPT, NOW), /prompt must not be empty/);
  refuses(
    () => parseScheduleInput(input({ prompt: "x".repeat(9) }), 8, NOW),
    /prompt is at most 8 characters, got 9/,
  );
  refuses(
    () => parseScheduleInput(input({ prompt: "run\u0007it" }), MAX_PROMPT, NOW),
    /prompt contains a control character/,
  );
});

test("a prompt limit the caller cannot state refuses every prompt", () => {
  for (const max of [0, -1, Number.NaN, 1.5])
    refuses(
      () => parseScheduleInput(input(), max, NOW),
      /prompt is at most 0 characters/,
    );
});

test("an interval cadence is exactly kind and everySeconds, inside the floor and ceiling", () => {
  refuses(
    () => parseScheduleInput(input({ cadence: "hourly" }), MAX_PROMPT, NOW),
    /cadence must be an object/,
  );
  refuses(
    () => parseScheduleInput(input({ cadence: [] }), MAX_PROMPT, NOW),
    /cadence must be an object/,
  );
  refuses(
    () => parseScheduleInput(input({ cadence: { kind: "daily" } }), MAX_PROMPT, NOW),
    /cadence.kind must be "interval" or "once"/,
  );
  refuses(
    () =>
      parseScheduleInput(
        input({ cadence: { kind: "interval", everySeconds: 60, at: T1 } }),
        MAX_PROMPT,
        NOW,
      ),
    /interval cadence is exactly kind and everySeconds/,
  );
  for (const everySeconds of [59, 604_801, 0, -60, 3600.5, "3600", null])
    refuses(
      () =>
        parseScheduleInput(
          input({ cadence: { kind: "interval", everySeconds } }),
          MAX_PROMPT,
          NOW,
        ),
      /everySeconds/,
    );
});

test("a once cadence is exactly kind and at, in the future", () => {
  refuses(
    () =>
      parseScheduleInput(
        input({ cadence: { kind: "once", at: T1, everySeconds: 3600 } }),
        MAX_PROMPT,
        NOW,
      ),
    /once cadence is exactly kind and at/,
  );
  refuses(
    () => parseScheduleInput(input({ cadence: { kind: "once" } }), MAX_PROMPT, NOW),
    /cadence.at must be an ISO 8601 timestamp/,
  );
  refuses(
    () => parseScheduleInput(input({ cadence: { kind: "once", at: 7 } }), MAX_PROMPT, NOW),
    /cadence.at must be an ISO 8601 timestamp/,
  );
  refuses(
    () => parseScheduleInput(input({ cadence: { kind: "once", at: "tomorrow" } }), MAX_PROMPT, NOW),
    /cadence.at is not a timestamp/,
  );
  refuses(
    () => parseScheduleInput(input({ cadence: { kind: "once", at: T0 } }), MAX_PROMPT, NOW),
    /cadence.at must be in the future/,
  );
  refuses(
    () =>
      parseScheduleInput(
        input({ cadence: { kind: "once", at: "2026-11-20T09:00:00.000Z" } }),
        MAX_PROMPT,
        NOW,
      ),
    /cadence.at must be in the future/,
  );
});

test("maxRuns is required and bounded, tokenBudget is optional and bounded", () => {
  refuses(() => parseScheduleInput(input({ maxRuns: undefined }), MAX_PROMPT, NOW), /maxRuns must be an integer/);
  for (const maxRuns of [0, 1_001, 1.5, "10"])
    refuses(
      () => parseScheduleInput(input({ maxRuns }), MAX_PROMPT, NOW),
      /maxRuns/,
    );
  for (const maxRuns of [1, 1_000])
    assert.equal(
      parseScheduleInput(input({ maxRuns }), MAX_PROMPT, NOW).maxRuns,
      maxRuns,
    );
  assert.equal(
    "tokenBudget" in parseScheduleInput(input(), MAX_PROMPT, NOW),
    false,
  );
  for (const tokenBudget of [0, 1_000_001, 1.5, "100"])
    refuses(
      () => parseScheduleInput(input({ tokenBudget }), MAX_PROMPT, NOW),
      /tokenBudget/,
    );
  for (const tokenBudget of [1, 1_000_000])
    assert.equal(
      parseScheduleInput(input({ tokenBudget }), MAX_PROMPT, NOW).tokenBudget,
      tokenBudget,
    );
});

test("a target session is a canonical UUID the workbench minted", () => {
  assert.equal(
    parseScheduleInput(input({ sessionId: SESSION }), MAX_PROMPT, NOW).sessionId,
    SESSION,
  );
  for (const sessionId of ["", "sess-1", SESSION.toUpperCase(), ` ${SESSION} `, 7])
    refuses(
      () => parseScheduleInput(input({ sessionId }), MAX_PROMPT, NOW),
      /sessionId must be a canonical UUID/,
    );
});

test("a model id and an agent id are shape checked only", () => {
  const parsed = parseScheduleInput(
    input({ model: " fixture/model-1 ", agent: "reviewer-1" }),
    MAX_PROMPT,
    NOW,
  );
  assert.equal(parsed.model, "fixture/model-1");
  assert.equal(parsed.agent, "reviewer-1");
  refuses(() => parseScheduleInput(input({ model: 5 }), MAX_PROMPT, NOW), /model must be text/);
  refuses(() => parseScheduleInput(input({ model: "  " }), MAX_PROMPT, NOW), /model must not be empty/);
  refuses(
    () => parseScheduleInput(input({ model: "a".repeat(129) }), MAX_PROMPT, NOW),
    /model is at most 128 characters, got 129/,
  );
  refuses(
    () => parseScheduleInput(input({ model: "fixture model" }), MAX_PROMPT, NOW),
    /model may hold letters, digits/,
  );
  refuses(() => parseScheduleInput(input({ agent: 5 }), MAX_PROMPT, NOW), /agent must be text/);
  refuses(() => parseScheduleInput(input({ agent: "  " }), MAX_PROMPT, NOW), /agent must not be empty/);
  refuses(
    () => parseScheduleInput(input({ agent: "a".repeat(121) }), MAX_PROMPT, NOW),
    /agent is at most 120 characters, got 121/,
  );
  refuses(
    () => parseScheduleInput(input({ agent: "-reviewer" }), MAX_PROMPT, NOW),
    /agent must start with a letter or a digit/,
  );
});

test("enabled is a boolean and defaults to on", () => {
  assert.equal(parseScheduleInput(input({ enabled: false }), MAX_PROMPT, NOW).enabled, false);
  for (const enabled of [0, 1, "true", null])
    refuses(
      () => parseScheduleInput(input({ enabled }), MAX_PROMPT, NOW),
      /enabled must be a boolean/,
    );
});

test("only an active, enabled, due schedule is returned", () => {
  const at = (nextRunAt: string) => schedule({ nextRunAt });
  const due = schedule({ id: "due" });
  assert.deepEqual(dueSchedules([due], NOW - 1), []);
  assert.deepEqual(dueSchedules([due], NOW), [due]);
  assert.deepEqual(
    dueSchedules(
      [
        schedule({ id: "paused", status: "paused" }),
        schedule({ id: "completed", status: "completed" }),
        schedule({ id: "budget", status: "budget_limited" }),
        schedule({ id: "unknown", status: "paused_unknown", enabled: false }),
        schedule({ id: "disabled", enabled: false }),
        at("2026-11-21T09:00:01.000Z"),
        due,
      ],
      NOW,
    ),
    [due],
  );
  for (const status of [
    "paused",
    "completed",
    "budget_limited",
    "paused_unknown",
  ] satisfies ScheduleStatus[])
    assert.deepEqual(dueSchedules([schedule({ status })], NOW + 1), []);
});

test("due schedules are ordered by nextRunAt then id", () => {
  const ordered = dueSchedules(
    [
      schedule({ id: "c", nextRunAt: "2026-11-21T09:00:00.000Z" }),
      schedule({ id: "b", nextRunAt: "2026-11-21T08:00:00.000Z" }),
      schedule({ id: "a", nextRunAt: "2026-11-21T09:00:00.000Z" }),
      schedule({ id: "d", nextRunAt: "2026-11-21T07:00:00.000Z" }),
    ],
    NOW,
  );
  assert.deepEqual(
    ordered.map((s) => s.id),
    ["d", "b", "a", "c"],
  );
  assert.deepEqual(
    dueSchedules(ordered, NOW).map((s) => s.id),
    ["d", "b", "a", "c"],
  );
});

test("a schedule whose nextRunAt cannot be read is never due", () => {
  assert.deepEqual(
    dueSchedules([schedule({ nextRunAt: "soon" })], NOW + 1_000_000),
    [],
  );
});

test("dueSchedules returns the records themselves and never mutates them", () => {
  const one = schedule({ id: "one" });
  const two = schedule({ id: "two", nextRunAt: "2026-11-21T08:30:00.000Z" });
  const list = [one, two];
  const before = structuredClone(list);
  const due = dueSchedules(list, NOW);
  assert.equal(due[0], two);
  assert.equal(due[1], one);
  assert.deepEqual(list, before);
});

test("a nowMs that is not a number is a caller bug, not an empty queue", () => {
  for (const nowMs of [Number.NaN, Number.POSITIVE_INFINITY, 1.5])
    refuses(() => dueSchedules([schedule()], nowMs), /nowMs must be a non-negative integer/);
});

test("a settled firing records what happened and anchors the next slot", () => {
  const fired = recordScheduleRun(schedule(), {
    firedAtMs: NOW,
    sessionId: SESSION,
    tokensUsed: 1_200,
    outcome: "idle",
  });
  assert.equal(fired.runCount, 1);
  assert.equal(fired.tokensUsed, 1_200);
  assert.equal(fired.lastRunAt, T0);
  assert.equal(fired.lastSessionId, SESSION);
  assert.equal(fired.lastOutcome, "idle");
  assert.equal(fired.status, "active");
  assert.equal(fired.enabled, true);
  // One interval from the anchor, not from the moment the run settled.
  assert.equal(fired.nextRunAt, T1);
});

test("a late firing does not drag the cadence with it", () => {
  const fiveSecondsLate = recordScheduleRun(schedule(), {
    firedAtMs: NOW + 5_000,
    sessionId: SESSION,
    outcome: "idle",
  });
  assert.equal(fiveSecondsLate.nextRunAt, T1);

  // Three and a half intervals late skips the slots already missed.
  const hoursLate = recordScheduleRun(schedule(), {
    firedAtMs: NOW + 3.5 * 3_600_000,
    sessionId: SESSION,
    outcome: "idle",
  });
  assert.equal(hoursLate.nextRunAt, "2026-11-21T13:00:00.000Z");
  assert.ok(Date.parse(hoursLate.nextRunAt) > NOW + 3.5 * 3_600_000);
});

test("the next slot is always strictly after the firing", () => {
  const fired = recordScheduleRun(schedule(), {
    firedAtMs: NOW,
    sessionId: SESSION,
    outcome: "idle",
  });
  assert.ok(Date.parse(fired.nextRunAt) > NOW);

  const minute = recordScheduleRun(
    schedule({ cadence: { kind: "interval", everySeconds: 60 }, nextRunAt: T0 }),
    { firedAtMs: NOW + 59_999, sessionId: SESSION, outcome: "idle" },
  );
  assert.equal(minute.nextRunAt, "2026-11-21T09:01:00.000Z");
});

test("an unreadable anchor restarts the interval from the firing", () => {
  const fired = recordScheduleRun(schedule({ nextRunAt: "soon" }), {
    firedAtMs: NOW,
    sessionId: SESSION,
    outcome: "idle",
  });
  assert.equal(fired.nextRunAt, T1);
});

test("a once schedule completes after its single firing", () => {
  const fired = recordScheduleRun(
    schedule({ cadence: { kind: "once", at: T0 }, maxRuns: 10 }),
    { firedAtMs: NOW, sessionId: SESSION, outcome: "idle" },
  );
  assert.equal(fired.status, "completed");
  assert.equal(fired.runCount, 1);
  // A once cadence has no next slot, so the record keeps the instant it ran.
  assert.equal(fired.nextRunAt, T0);
  assert.deepEqual(dueSchedules([fired], NOW + 86_400_000), []);
});

test("the last allowed run completes the schedule", () => {
  const last = recordScheduleRun(
    schedule({ runCount: 9, maxRuns: 10, tokensUsed: 10 }),
    { firedAtMs: NOW, sessionId: SESSION, tokensUsed: 10, outcome: "idle" },
  );
  assert.equal(last.runCount, 10);
  assert.equal(last.status, "completed");
  assert.deepEqual(dueSchedules([last], NOW + 3_600_000), []);

  const remaining = recordScheduleRun(
    schedule({ runCount: 8, maxRuns: 10 }),
    { firedAtMs: NOW, sessionId: SESSION, outcome: "idle" },
  );
  assert.equal(remaining.status, "active");
});

test("the token budget stops the schedule at the limit", () => {
  const spent = recordScheduleRun(schedule({ tokenBudget: 100 }), {
    firedAtMs: NOW,
    sessionId: SESSION,
    tokensUsed: 100,
    outcome: "idle",
  });
  assert.equal(spent.status, "budget_limited");
  assert.equal(spent.tokensUsed, 100);

  const accumulated = recordScheduleRun(
    schedule({ tokenBudget: 100, tokensUsed: 60 }),
    { firedAtMs: NOW, sessionId: SESSION, tokensUsed: 40, outcome: "idle" },
  );
  assert.equal(accumulated.status, "budget_limited");

  const under = recordScheduleRun(schedule({ tokenBudget: 100 }), {
    firedAtMs: NOW,
    sessionId: SESSION,
    tokensUsed: 99,
    outcome: "idle",
  });
  assert.equal(under.status, "active");
});

test("a run that is also the last allowed run completes, not budget_limited", () => {
  const both = recordScheduleRun(
    schedule({ maxRuns: 1, tokenBudget: 1 }),
    { firedAtMs: NOW, sessionId: SESSION, tokensUsed: 5, outcome: "idle" },
  );
  assert.equal(both.status, "completed");
});

test("an unproven outcome parks the schedule for the operator", () => {
  for (const outcome of ["unknown"] as const) {
    const parked = recordScheduleRun(schedule({ tokenBudget: 1 }), {
      firedAtMs: NOW,
      sessionId: SESSION,
      tokensUsed: 5,
      outcome,
    });
    assert.equal(parked.status, "paused_unknown");
    assert.equal(parked.enabled, false);
    assert.equal(parked.lastOutcome, "unknown");
    // The counters still move: an unproven run spent tokens and happened.
    assert.equal(parked.runCount, 1);
    assert.equal(parked.tokensUsed, 5);
    assert.deepEqual(dueSchedules([parked], NOW + 3_600_000), []);
  }
});

test("failed and cancelled runs are recorded but do not stop the schedule", () => {
  for (const outcome of ["failed", "cancelled"] as const) {
    const fired = recordScheduleRun(schedule(), {
      firedAtMs: NOW,
      sessionId: SESSION,
      outcome,
    });
    assert.equal(fired.lastOutcome, outcome);
    assert.equal(fired.status, "active");
    assert.equal(fired.enabled, true);
  }
});

test("a late record never resumes a schedule the operator stopped", () => {
  const paused = recordScheduleRun(
    schedule({ status: "paused", enabled: false }),
    { firedAtMs: NOW, sessionId: SESSION, tokensUsed: 7, outcome: "idle" },
  );
  assert.equal(paused.status, "paused");
  assert.equal(paused.enabled, false);
  assert.equal(paused.runCount, 1);
  assert.equal(paused.tokensUsed, 7);
  // The slot advances, so a resume does not immediately re-fire a stale one.
  assert.equal(paused.nextRunAt, T1);

  const completed = recordScheduleRun(
    schedule({ status: "completed" }),
    { firedAtMs: NOW, sessionId: SESSION, outcome: "idle" },
  );
  assert.equal(completed.status, "completed");
});

test("a firing without tokens leaves the total alone and accumulates otherwise", () => {
  const noTokens = recordScheduleRun(schedule({ tokensUsed: 50 }), {
    firedAtMs: NOW,
    sessionId: SESSION,
    outcome: "idle",
  });
  assert.equal(noTokens.tokensUsed, 50);

  const first = recordScheduleRun(schedule(), {
    firedAtMs: NOW,
    sessionId: SESSION,
    tokensUsed: 30,
    outcome: "idle",
  });
  const second = recordScheduleRun(first, {
    firedAtMs: NOW + 3_600_000,
    sessionId: OTHER_SESSION,
    tokensUsed: 45,
    outcome: "idle",
  });
  assert.equal(second.runCount, 2);
  assert.equal(second.tokensUsed, 75);
  assert.equal(second.lastSessionId, OTHER_SESSION);
  assert.equal(second.nextRunAt, "2026-11-21T11:00:00.000Z");
});

test("recordScheduleRun returns a new record and never mutates the old one", () => {
  const original = schedule();
  const before = structuredClone(original);
  const fired = recordScheduleRun(original, {
    firedAtMs: NOW,
    sessionId: SESSION,
    outcome: "idle",
  });
  assert.notEqual(fired, original);
  assert.deepEqual(original, before);
  assert.deepEqual(original, schedule());
});

test("a firing that cannot be read is refused, not guessed", () => {
  refuses(
    () => recordScheduleRun(schedule(), null as never),
    /Invalid schedule run: expected an object/,
  );
  refuses(
    () =>
      recordScheduleRun(schedule(), {
        firedAtMs: NOW,
        outcome: "idle",
      } as never),
    /sessionId must be a canonical UUID/,
  );
  refuses(
    () =>
      recordScheduleRun(schedule(), {
        firedAtMs: NOW,
        sessionId: "",
        outcome: "idle",
      }),
    /sessionId must be a canonical UUID/,
  );
  for (const firedAtMs of [Number.NaN, -1, 1.5, Number.POSITIVE_INFINITY])
    refuses(
      () =>
        recordScheduleRun(schedule(), {
          firedAtMs,
          sessionId: SESSION,
          outcome: "idle",
        }),
      /firedAtMs must be a non-negative integer/,
    );
  for (const tokensUsed of [-1, 1.5, Number.NaN])
    refuses(
      () =>
        recordScheduleRun(schedule(), {
          firedAtMs: NOW,
          sessionId: SESSION,
          tokensUsed,
          outcome: "idle",
        }),
      /tokensUsed must be a non-negative integer/,
    );
  for (const outcome of ["success", "ok", "", 1])
    refuses(
      () =>
        recordScheduleRun(schedule(), {
          firedAtMs: NOW,
          sessionId: SESSION,
          outcome,
        } as never),
      /outcome must be one of idle, failed, cancelled or unknown/,
    );
});

test("a cadence is a value the record can be rebuilt from", () => {
  const cadence: ScheduleCadence = { kind: "interval", everySeconds: 60 };
  const parsed = parseScheduleInput(input({ cadence }), MAX_PROMPT, NOW);
  assert.equal(parsed.cadence.kind, "interval");
  assert.notEqual(parsed.cadence, cadence);
});

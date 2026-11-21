/**
 * HP9: a scheduled prompt fires through the governed run path.
 *
 * `schedules.ts` already pins the pure rules, so what is left to prove is the
 * wiring: a due operator record starts exactly one run through the normal
 * `start` or `send` path, the record advances only after a firing settled, a
 * budget or a run count ends it, and a target whose state cannot be proved
 * parks the record instead of repeating an unverified side effect.
 *
 * These tests are typed against `ScheduleRuntimeSurface` rather than against
 * `Workbench`. The wiring node adds those methods to `index.ts`; the narrow
 * surface keeps `tsc` green before that node lands while `node --test` stays
 * RED, because a method that does not exist yet is a runtime TypeError and not
 * a compile error someone could silence by widening a cast.
 *
 * The clock is the one piece of test scaffolding worth explaining. A real
 * minute is too long to wait and a fabricated future `nowMs` would make the
 * anchored next slot depend on whether the implementation dates the firing
 * from the caller's clock or from `Date.now()`. Instead a record is created
 * one interval in the past, so the production `runDueSchedules()` finds it
 * honestly overdue and the next slot is exactly one interval past the anchor
 * under either choice.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { isolatedWorkbench } from "./test-fixture.ts";
import { SCHEDULE_LIMITS, type Schedule } from "./schedules.ts";
import type { Workbench } from "./index.ts";

/** The interval floor, so "one interval ago" is the shortest honest anchor. */
const MINUTE_MS = 60_000;

const UNKNOWN_ID = "00000000-0000-4000-8000-000000000000";

/**
 * A schedule is an operator state write, and the control plane fixture runs
 * the same mode an operator uses. Naming it keeps the fixture from depending
 * on whatever the local default happens to be.
 */
const ENV = { NOMO_PERMISSION_MODE: "normal" };

const models = () => Response.json({ data: [{ id: "fixture" }] });
const answer = (tokens?: number) =>
  Response.json({
    choices: [
      {
        message: { role: "assistant", content: "Done" },
        finish_reason: "stop",
      },
    ],
    ...(tokens === undefined ? {} : { usage: { total_tokens: tokens } }),
  });

type ScheduleRunResult = {
  readonly scheduleId: string;
  readonly sessionId?: string;
  readonly outcome: string;
};

/** The slice of `Workbench` HP9 promises; see the file header. */
type ScheduleRuntimeSurface = {
  listSchedules(): Schedule[];
  createSchedule(input: unknown, nowMs?: number): Schedule;
  pauseSchedule(id: string): Schedule;
  resumeSchedule(id: string): Schedule;
  deleteSchedule(id: string): boolean;
  runDueSchedules(nowMs?: number): Promise<readonly ScheduleRunResult[]>;
};

const runtime = (app: Workbench): ScheduleRuntimeSurface =>
  app as unknown as ScheduleRuntimeSurface;

const surfaceOf = (f: { readonly app: Workbench }) => runtime(f.app);

/** The fields a restart must reproduce; the whole record is checked field by
 * field because an optional key that is absent and one that is `undefined`
 * read the same to an operator but not to `deepEqual`. */
const persisted = (schedule: Schedule) => ({
  id: schedule.id,
  name: schedule.name,
  prompt: schedule.prompt,
  cadence: schedule.cadence,
  model: schedule.model,
  maxRuns: schedule.maxRuns,
  enabled: schedule.enabled,
  status: schedule.status,
  runCount: schedule.runCount,
  tokensUsed: schedule.tokensUsed,
  createdAt: schedule.createdAt,
  nextRunAt: schedule.nextRunAt,
  lastOutcome: schedule.lastOutcome,
});

const readOne = (surface: ScheduleRuntimeSurface, id: string): Schedule => {
  const found = surface.listSchedules().find((entry) => entry.id === id);
  assert.ok(found, `the schedule table no longer holds ${id}`);
  return found;
};

/**
 * A record is written after its firing settles, and a firing that times out
 * settles on the harness clock, so the assertion waits for the state instead
 * of assuming the evaluation blocked for exactly as long as the run did.
 */
async function waitForSchedule(
  surface: ScheduleRuntimeSurface,
  id: string,
  done: (schedule: Schedule) => boolean,
): Promise<Schedule> {
  const deadline = Date.now() + 15_000;
  let last: Schedule | undefined;
  while (Date.now() < deadline) {
    last = surface.listSchedules().find((entry) => entry.id === id);
    if (last && done(last)) return last;
    await delay(20);
  }
  assert.fail(
    `the schedule never reached the expected state; last read: ${JSON.stringify(last)}`,
  );
}

async function waitForSessionStatus(
  app: Workbench,
  id: string,
  status: string,
): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (app.get(id)?.status === status) return;
    await delay(20);
  }
  assert.fail(
    `session ${id} never reached ${status}; last read: ${JSON.stringify(app.get(id)?.status)}`,
  );
}

test("a one-shot schedule fires at its instant and never fires twice", async (t) => {
  let calls = 0;
  const f = await isolatedWorkbench(
    t,
    async (url) => {
      if (String(url).endsWith("/models")) return models();
      calls++;
      return answer(5);
    },
    ENV,
    { prefix: "nomo-schedule-once-" },
  );
  const surface = surfaceOf(f);
  const createdAtMs = Date.now() - 2 * MINUTE_MS;
  const at = new Date(Date.now() - MINUTE_MS).toISOString();
  const created = surface.createSchedule(
    {
      name: "One shot",
      prompt: "Report the build state.",
      cadence: { kind: "once", at },
      maxRuns: 1,
      model: "fixture",
    },
    createdAtMs,
  );
  assert.equal(created.status, "active");
  assert.equal(created.enabled, true);
  assert.equal(created.runCount, 0);
  assert.equal(created.nextRunAt, at);
  const sessionsBefore = f.app.list().length;

  assert.deepEqual(
    await surface.runDueSchedules(createdAtMs),
    [],
    "a schedule is never due before its own instant",
  );
  assert.equal(readOne(surface, created.id).runCount, 0);
  assert.equal(calls, 0);

  const results = await surface.runDueSchedules();
  assert.equal(results.length, 1, "the overdue record fired once");
  const fired = results[0]!;
  assert.equal(fired.scheduleId, created.id);
  assert.equal(fired.outcome, "idle", "a settled run with no open tool call is idle");
  assert.equal(
    typeof fired.sessionId,
    "string",
    "a firing with no target session reports the session it started",
  );
  assert.ok(
    f.app.get(fired.sessionId!),
    "a firing with no target session starts a new one",
  );
  assert.equal(f.app.list().length, sessionsBefore + 1);

  const after = readOne(surface, created.id);
  assert.equal(after.runCount, 1);
  assert.equal(after.status, "completed");
  assert.equal(after.lastOutcome, "idle");
  assert.equal(after.lastSessionId, fired.sessionId);
  assert.ok(after.lastRunAt, "the record dates its last firing");
  assert.equal(after.nextRunAt, at, "a once schedule keeps the instant it ran");

  assert.deepEqual(
    await surface.runDueSchedules(Date.now() + 10 * MINUTE_MS),
    [],
    "a completed schedule is never due again",
  );
  assert.equal(readOne(surface, created.id).runCount, 1);
  assert.equal(calls, 1, "the record fired exactly once");
});

test("an interval schedule fires only when due and keeps its anchored slot", async (t) => {
  let calls = 0;
  const f = await isolatedWorkbench(
    t,
    async (url) => {
      if (String(url).endsWith("/models")) return models();
      calls++;
      return answer();
    },
    ENV,
    { prefix: "nomo-schedule-interval-" },
  );
  const surface = surfaceOf(f);
  const createdAtMs = Date.now() - MINUTE_MS - 1_000;
  const created = surface.createSchedule(
    {
      name: "Interval review",
      prompt: "Review the open threads.",
      cadence: { kind: "interval", everySeconds: 60 },
      maxRuns: 5,
      model: "fixture",
    },
    createdAtMs,
  );
  const anchorMs = createdAtMs + MINUTE_MS;
  assert.equal(created.nextRunAt, new Date(anchorMs).toISOString());

  assert.deepEqual(
    await surface.runDueSchedules(anchorMs - 1),
    [],
    "one millisecond before the slot nothing fires",
  );
  assert.equal(
    readOne(surface, created.id).runCount,
    0,
    "a skipped evaluation counts nothing",
  );
  assert.equal(calls, 0);

  const results = await surface.runDueSchedules();
  assert.equal(results.length, 1);
  const after = readOne(surface, created.id);
  assert.equal(after.runCount, 1);
  assert.equal(after.status, "active");
  assert.equal(after.lastOutcome, "idle");
  assert.equal(
    after.nextRunAt,
    new Date(anchorMs + MINUTE_MS).toISOString(),
    "the next slot is anchored to the operator's cadence, not to the firing",
  );

  assert.deepEqual(
    await surface.runDueSchedules(),
    [],
    "the advanced slot is in the future, so the record waits",
  );
  assert.equal(readOne(surface, created.id).runCount, 1);
  assert.equal(calls, 1);
});

test("an interval schedule completes at maxRuns and stops firing", async (t) => {
  let calls = 0;
  const f = await isolatedWorkbench(
    t,
    async (url) => {
      if (String(url).endsWith("/models")) return models();
      calls++;
      return answer();
    },
    ENV,
    { prefix: "nomo-schedule-maxruns-" },
  );
  const surface = surfaceOf(f);
  const createdAtMs = Date.now() - MINUTE_MS - 1_000;
  const created = surface.createSchedule(
    {
      name: "Twice only",
      prompt: "Check the deployment twice.",
      cadence: { kind: "interval", everySeconds: 60 },
      maxRuns: 2,
      model: "fixture",
    },
    createdAtMs,
  );
  const anchorMs = createdAtMs + MINUTE_MS;

  assert.equal((await surface.runDueSchedules()).length, 1);
  assert.equal(readOne(surface, created.id).runCount, 1);
  assert.equal(readOne(surface, created.id).status, "active");

  assert.equal(
    (await surface.runDueSchedules(anchorMs + MINUTE_MS)).length,
    1,
    "the second slot fired",
  );
  const after = readOne(surface, created.id);
  assert.equal(after.runCount, 2);
  assert.equal(after.status, "completed", "the configured run count ends the record");
  assert.equal(calls, 2);

  assert.deepEqual(
    await surface.runDueSchedules(anchorMs + 10 * MINUTE_MS),
    [],
    "a completed record is never due again",
  );
  assert.equal(calls, 2);
});

test("the token budget ends the schedule as budget_limited", async (t) => {
  let calls = 0;
  const f = await isolatedWorkbench(
    t,
    async (url) => {
      if (String(url).endsWith("/models")) return models();
      calls++;
      return answer(500);
    },
    ENV,
    { prefix: "nomo-schedule-budget-" },
  );
  const surface = surfaceOf(f);
  const createdAtMs = Date.now() - MINUTE_MS - 1_000;
  const created = surface.createSchedule(
    {
      name: "Budgeted sweep",
      prompt: "Sweep the queue once.",
      cadence: { kind: "interval", everySeconds: 60 },
      maxRuns: 10,
      tokenBudget: 1,
      model: "fixture",
    },
    createdAtMs,
  );

  assert.equal((await surface.runDueSchedules()).length, 1);
  const after = readOne(surface, created.id);
  assert.equal(after.runCount, 1);
  assert.ok(
    after.tokensUsed > 0,
    `a firing reports the tokens its run spent, got ${after.tokensUsed}`,
  );
  assert.equal(
    after.status,
    "budget_limited",
    "a spent token budget stops the record before it fires again",
  );
  assert.equal(calls, 1);

  assert.deepEqual(
    await surface.runDueSchedules(Date.now() + 10 * MINUTE_MS),
    [],
    "a budget limited record is never due again",
  );
  assert.equal(calls, 1);
});

test("a paused schedule never fires and resume recomputes its slot", async (t) => {
  const f = await isolatedWorkbench(
    t,
    async (url) =>
      String(url).endsWith("/models") ? models() : answer(),
    ENV,
    { prefix: "nomo-schedule-pause-" },
  );
  const surface = surfaceOf(f);
  const createdAtMs = Date.now() - MINUTE_MS - 1_000;
  const created = surface.createSchedule(
    {
      name: "Pausable review",
      prompt: "Review the open threads.",
      cadence: { kind: "interval", everySeconds: 60 },
      maxRuns: 5,
      model: "fixture",
    },
    createdAtMs,
  );

  const paused = surface.pauseSchedule(created.id);
  assert.equal(paused.status, "paused");
  assert.equal(paused.enabled, false, "a paused record is also switched off");
  assert.deepEqual(
    await surface.runDueSchedules(),
    [],
    "a paused record is never due, even on its own slot",
  );
  assert.equal(readOne(surface, created.id).runCount, 0);

  const resumed = surface.resumeSchedule(created.id);
  assert.equal(resumed.status, "active");
  assert.equal(resumed.enabled, true);
  assert.ok(
    Date.parse(resumed.nextRunAt) > Date.now(),
    "resume recomputes the next slot from the resume moment",
  );
  assert.deepEqual(
    await surface.runDueSchedules(),
    [],
    "a resume never fires immediately",
  );

  assert.throws(
    () => surface.pauseSchedule(UNKNOWN_ID),
    "pausing a schedule that does not exist is refused rather than invented",
  );
  assert.throws(
    () => surface.resumeSchedule(UNKNOWN_ID),
    "resuming a schedule that does not exist is refused rather than invented",
  );
  assert.equal(
    surface.deleteSchedule(UNKNOWN_ID),
    false,
    "deleting a schedule that does not exist reports that nothing was deleted",
  );
  assert.equal(surface.deleteSchedule(created.id), true);
  assert.deepEqual(surface.listSchedules(), []);
  assert.equal(
    surface.deleteSchedule(created.id),
    false,
    "a deleted schedule cannot be deleted twice",
  );
});

test("the schedule table survives a workbench restart", async (t) => {
  const f = await isolatedWorkbench(
    t,
    async (url) =>
      String(url).endsWith("/models") ? models() : answer(),
    ENV,
    { prefix: "nomo-schedule-restart-" },
  );
  const createdAtMs = Date.now() - MINUTE_MS - 1_000;
  const created = surfaceOf(f).createSchedule(
    {
      name: "Survives a restart",
      prompt: "Keep this record across a restart.",
      cadence: { kind: "interval", everySeconds: 60 },
      maxRuns: 5,
      model: "fixture",
    },
    createdAtMs,
  );
  assert.equal((await surfaceOf(f).runDueSchedules()).length, 1);
  const fired = readOne(surfaceOf(f), created.id);
  assert.equal(fired.runCount, 1);
  await f.app.settled();

  const reopened = f.restart();
  const listed = runtime(reopened).listSchedules();
  assert.equal(listed.length, 1, "the schedule table is read back from the snapshot");
  assert.deepEqual(
    persisted(listed[0]!),
    persisted(fired),
    "the record, its counters and its slot survive a restart",
  );
});

test("createSchedule refuses an invalid body and the table bound", async (t) => {
  const f = await isolatedWorkbench(
    t,
    async (url) =>
      String(url).endsWith("/models") ? models() : answer(),
    ENV,
    { prefix: "nomo-schedule-validation-" },
  );
  const surface = surfaceOf(f);
  const cadence = { kind: "interval", everySeconds: 3600 };
  const base = {
    name: "Refused",
    prompt: "This body must be refused.",
    cadence,
    maxRuns: 1,
  };

  assert.throws(
    () =>
      surface.createSchedule({
        ...base,
        cadence: { kind: "interval", everySeconds: 10 },
      }),
    /everySeconds/,
    "the interval floor is the operator's contract, not a default",
  );
  assert.throws(
    () => surface.createSchedule({ ...base, runCount: 4 }),
    /runCount/,
    "a body that names its own run count is refused by name",
  );
  assert.throws(
    () =>
      surface.createSchedule({
        ...base,
        cadence: {
          kind: "once",
          at: new Date(Date.now() - MINUTE_MS).toISOString(),
        },
      }),
    /future/,
    "a once instant that already passed would fire for a moment nobody meant",
  );
  assert.deepEqual(surface.listSchedules(), [], "a refused body creates nothing");

  for (let index = 0; index < SCHEDULE_LIMITS.schedules; index++)
    surface.createSchedule(
      { ...base, name: `Bounded ${index}` },
      Date.now(),
    );
  assert.equal(surface.listSchedules().length, SCHEDULE_LIMITS.schedules);
  assert.throws(
    () => surface.createSchedule({ ...base, name: "One too many" }, Date.now()),
    /32/,
    "the table bound is enforced where the table is visible",
  );
  assert.equal(surface.listSchedules().length, SCHEDULE_LIMITS.schedules);
});

test("a busy target session skips the firing and keeps the record due", async (t) => {
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  let calls = 0;
  const f = await isolatedWorkbench(
    t,
    async (url) => {
      if (String(url).endsWith("/models")) return models();
      calls++;
      await blocked;
      return answer();
    },
    ENV,
    { prefix: "nomo-schedule-busy-", beforeShutdown: release },
  );
  const target = await f.app.start("Hold the only run slot", "fixture");
  assert.equal(f.app.get(target.id)?.status, "running");
  // `start` returns while the run is still reaching the provider, so the
  // first request is waited for: the assertion below is about the absence of
  // a second one, and a count of zero would pass it for the wrong reason.
  const firstRequestBy = Date.now() + 15_000;
  while (calls === 0) {
    assert.ok(Date.now() < firstRequestBy, "the target run never reached the provider");
    await delay(5);
  }
  assert.equal(calls, 1);

  const createdAtMs = Date.now() - MINUTE_MS - 1_000;
  const created = surfaceOf(f).createSchedule(
    {
      name: "Continue the conversation",
      prompt: "Summarize the open threads.",
      cadence: { kind: "interval", everySeconds: 60 },
      maxRuns: 3,
      sessionId: target.id,
      model: "fixture",
    },
    createdAtMs,
  );

  // The record, not the returned list, is what a skip must be read from: an
  // evaluation may report only the firings it performed, but a skipped firing
  // has to leave the record exactly as it found it.
  await surfaceOf(f).runDueSchedules();
  const after = readOne(surfaceOf(f), created.id);
  assert.equal(after.runCount, 0, "a skipped firing counts nothing");
  assert.equal(after.tokensUsed, 0);
  assert.equal(after.status, "active");
  assert.equal(
    after.nextRunAt,
    created.nextRunAt,
    "a skipped firing keeps the same slot for the next evaluation",
  );
  assert.equal(calls, 1, "the busy target was sent no second request");

  release();
  await f.app.settled();
  assert.equal(
    calls,
    1,
    "a firing is never queued behind a run on the same conversation",
  );
});

test("a firing whose run ends unknown parks the schedule as paused_unknown", async (t) => {
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const f = await isolatedWorkbench(
    t,
    async (url) => {
      if (String(url).endsWith("/models")) return models();
      // Never answers inside the run budget, so the outcome cannot be proved.
      await blocked;
      return answer();
    },
    ENV,
    { prefix: "nomo-schedule-unknown-", beforeShutdown: release },
  );
  f.app.patchHarnessSettings({ maxRunTimeoutMs: 1000 });
  const createdAtMs = Date.now() - MINUTE_MS - 1_000;
  const created = surfaceOf(f).createSchedule(
    {
      name: "Unattended sweep",
      prompt: "Sweep the queue.",
      cadence: { kind: "interval", everySeconds: 60 },
      maxRuns: 5,
      model: "fixture",
    },
    createdAtMs,
  );

  assert.equal((await surfaceOf(f).runDueSchedules()).length, 1);
  const parked = await waitForSchedule(
    surfaceOf(f),
    created.id,
    (entry) => entry.status === "paused_unknown",
  );
  assert.equal(
    parked.enabled,
    false,
    "a parked record is switched off, not only labelled",
  );
  assert.equal(
    parked.runCount,
    1,
    "the unproven firing happened, so its run still counts",
  );
  assert.equal(parked.lastOutcome, "unknown");
  assert.deepEqual(
    await surfaceOf(f).runDueSchedules(Date.now() + 10 * MINUTE_MS),
    [],
    "a schedule that cannot prove its last outcome never fires again",
  );
  release();
});

test("a target session whose state cannot be read parks the schedule without a run", async (t) => {
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  let calls = 0;
  const f = await isolatedWorkbench(
    t,
    async (url) => {
      if (String(url).endsWith("/models")) return models();
      calls++;
      await blocked;
      return answer();
    },
    ENV,
    { prefix: "nomo-schedule-target-unknown-", beforeShutdown: release },
  );
  f.app.patchHarnessSettings({ maxRunTimeoutMs: 1000 });
  const target = await f.app.start("Time this run out", "fixture");
  await waitForSessionStatus(f.app, target.id, "unknown");
  assert.equal(calls, 1);

  const createdAtMs = Date.now() - MINUTE_MS - 1_000;
  const created = surfaceOf(f).createSchedule(
    {
      name: "Continue an unreadable conversation",
      prompt: "Summarize the open threads.",
      cadence: { kind: "interval", everySeconds: 60 },
      maxRuns: 3,
      sessionId: target.id,
      model: "fixture",
    },
    createdAtMs,
  );

  await surfaceOf(f).runDueSchedules();
  const parked = await waitForSchedule(
    surfaceOf(f),
    created.id,
    (entry) => entry.status === "paused_unknown",
  );
  assert.equal(parked.enabled, false);
  assert.equal(
    parked.runCount,
    0,
    "an unreadable target is parked before any run starts",
  );
  assert.equal(parked.tokensUsed, 0);
  assert.equal(calls, 1, "an unreadable target is never sent a prompt");
  release();
});

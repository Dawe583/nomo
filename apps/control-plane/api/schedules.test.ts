/**
 * HP9 over HTTP: the operator owns the schedule table.
 *
 * A schedule decides when unattended work starts, so the routes are the
 * operator's only door into that table. These tests pin the contract before
 * the routes exist: a body is validated by the rules module rather than by the
 * route, a refusal names the field it refused, an unknown id is a 404 and not
 * a new record, and `run-due` is the one route that starts work.
 *
 * Every 404 assertion is paired with a positive one in the same test, because
 * an unmatched `/api/` path already answers 404 today: a test that only
 * asserted 404 would pass before the routes were written and prove nothing.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { Workbench } from "../../../packages/workbench/src/index.ts";
import type { Schedule } from "../../../packages/workbench/src/schedules.ts";
import { listenControlPlane } from "./server.ts";

type ScheduleRunResult = {
  readonly scheduleId: string;
  readonly sessionId?: string;
  readonly outcome: string;
};

type Fixture = {
  readonly app: Workbench;
  readonly schedulesUrl: string;
};

const UNKNOWN_ID = "00000000-0000-4000-8000-000000000000";

const fetcher = async (url: unknown) =>
  String(url).endsWith("/models")
    ? Response.json({ data: [{ id: "fixture" }] })
    : Response.json({
        choices: [
          { message: { role: "assistant", content: "Done" }, finish_reason: "stop" },
        ],
        usage: { total_tokens: 7 },
      });

/**
 * A schedule is an operator state write and the control plane defaults to a
 * remote-facing mode, so the fixture states the local operator mode it means
 * instead of inheriting whatever the host sets.
 */
async function fixture(
  t: { after(fn: () => Promise<void>): void },
): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "nomo-schedule-api-"));
  const env = {
    NOMO_DATA_DIR: root,
    NOMO_PERMISSION_MODE: "normal",
  };
  const app = new Workbench(env, fetcher as typeof fetch);
  await app.configure({ baseUrl: "https://fixture.test/v1", apiKey: "fixture" });
  const server = await listenControlPlane({ env, workbench: app });
  t.after(async () => {
    await server.close();
    await app.shutdown();
    await rm(root, { recursive: true, force: true });
  });
  const origin = `http://127.0.0.1:${server.port}`;
  return { app, schedulesUrl: `${origin}/api/schedules` };
}

/** A JSON body on every POST, so a route that reads one and a route that does
 * not both see a well formed request. */
function post(url: string, body: unknown = {}): Promise<Response> {
  return fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

const input = (overrides: Record<string, unknown> = {}) => ({
  name: "Nightly suite",
  prompt: "Run the suite and summarize the failures.",
  cadence: { kind: "interval", everySeconds: 3600 },
  maxRuns: 3,
  model: "fixture",
  ...overrides,
});

async function readSchedules(f: Fixture): Promise<Schedule[]> {
  const response = await fetch(f.schedulesUrl);
  assert.equal(response.status, 200);
  const body = (await response.json()) as { schedules?: Schedule[] };
  assert.ok(Array.isArray(body.schedules), "the list route answers an array");
  return body.schedules;
}

async function createSchedule(f: Fixture, body: unknown): Promise<Schedule> {
  const response = await post(f.schedulesUrl, body);
  assert.equal(
    response.status,
    201,
    `a valid body creates a record: ${await response.clone().text()}`,
  );
  const parsed = (await response.json()) as { schedule?: Schedule };
  assert.ok(parsed.schedule, "the create route answers the record it stored");
  return parsed.schedule;
}

/**
 * A firing settles on the harness clock, so the record is waited for instead
 * of assumed to be written by the time the route answered.
 */
async function waitForSchedule(
  f: Fixture,
  id: string,
  done: (schedule: Schedule) => boolean,
): Promise<Schedule> {
  const deadline = Date.now() + 15_000;
  let last: Schedule | undefined;
  while (Date.now() < deadline) {
    last = (await readSchedules(f)).find((entry) => entry.id === id);
    if (last && done(last)) return last;
    await delay(20);
  }
  assert.fail(
    `the schedule never reached the expected state; last read: ${JSON.stringify(last)}`,
  );
}

test("POST creates a schedule and pause, resume and delete round-trip", async (t) => {
  const f = await fixture(t);

  const created = await createSchedule(f, input());
  assert.ok(created.id, "the workbench mints the id, never the body");
  assert.equal(created.name, "Nightly suite");
  assert.equal(created.status, "active");
  assert.equal(created.enabled, true);
  assert.equal(created.runCount, 0);
  assert.equal(created.tokensUsed, 0);
  assert.ok(
    Date.parse(created.nextRunAt) > Date.now(),
    "creating a schedule never starts work the operator has not seen listed",
  );

  const listed = await readSchedules(f);
  assert.equal(listed.length, 1);
  assert.equal(listed[0]!.id, created.id);
  assert.equal(listed[0]!.nextRunAt, created.nextRunAt);

  const paused = await post(`${f.schedulesUrl}/${created.id}/pause`);
  assert.equal(paused.status, 200);
  const pausedBody = (await paused.json()) as { schedule: Schedule };
  assert.equal(pausedBody.schedule.status, "paused");
  assert.equal(pausedBody.schedule.enabled, false);
  assert.equal((await readSchedules(f))[0]!.status, "paused");

  const resumed = await post(`${f.schedulesUrl}/${created.id}/resume`);
  assert.equal(resumed.status, 200);
  const resumedBody = (await resumed.json()) as { schedule: Schedule };
  assert.equal(resumedBody.schedule.status, "active");
  assert.equal(resumedBody.schedule.enabled, true);
  assert.ok(
    Date.parse(resumedBody.schedule.nextRunAt) > Date.now(),
    "resume recomputes the next slot, so it never fires immediately",
  );

  const deleted = await fetch(`${f.schedulesUrl}/${created.id}`, {
    method: "DELETE",
  });
  assert.equal(deleted.status, 200);
  const deletedBody = (await deleted.json()) as { deleted?: boolean };
  assert.equal(deletedBody.deleted, true, "the delete route reports the removal");
  assert.deepEqual(await readSchedules(f), [], "a deleted record is gone");
  assert.equal(
    (await fetch(`${f.schedulesUrl}/${created.id}`, { method: "DELETE" })).status,
    404,
    "a second delete is an unknown id",
  );
});

test("POST refuses an invalid body, names the field and creates nothing", async (t) => {
  const f = await fixture(t);
  const refusals: readonly { readonly body: Record<string, unknown>; readonly names: RegExp }[] = [
    {
      body: input({ cadence: { kind: "interval", everySeconds: 10 } }),
      names: /everySeconds/,
    },
    {
      body: input({ runCount: 4 }),
      names: /runCount/,
    },
    {
      body: input({ name: "   " }),
      names: /name/,
    },
    {
      body: input({ prompt: "  " }),
      names: /prompt/,
    },
    {
      body: input({ maxRuns: 0 }),
      names: /maxRuns/,
    },
    {
      body: input({
        cadence: { kind: "once", at: new Date(Date.now() - 60_000).toISOString() },
      }),
      names: /at|future/,
    },
  ];

  for (const refusal of refusals) {
    const response = await post(f.schedulesUrl, refusal.body);
    assert.equal(
      response.status,
      400,
      `a refused body must be a 400: ${JSON.stringify(refusal.body)}`,
    );
    const text = await response.text();
    assert.match(
      text,
      refusal.names,
      `the refusal must name the field it refused: ${text}`,
    );
  }

  assert.deepEqual(await readSchedules(f), [], "a refused body creates nothing");
});

test("schedule routes answer 404 for an unknown id without touching the table", async (t) => {
  const f = await fixture(t);
  const created = await createSchedule(f, input());
  // The positive case first: it proves the pause route exists, so the 404
  // assertions below cannot pass on the router's own not-found fallback.
  assert.equal((await post(`${f.schedulesUrl}/${created.id}/pause`)).status, 200);

  for (const url of [
    `${f.schedulesUrl}/${UNKNOWN_ID}/pause`,
    `${f.schedulesUrl}/${UNKNOWN_ID}/resume`,
  ]) {
    const response = await post(url);
    assert.equal(response.status, 404, `${url} is a 404`);
  }
  const deleted = await fetch(`${f.schedulesUrl}/${UNKNOWN_ID}`, {
    method: "DELETE",
  });
  assert.equal(deleted.status, 404);

  const listed = await readSchedules(f);
  assert.equal(listed.length, 1, "an unknown id never creates a record");
  assert.equal(listed[0]!.id, created.id);
  assert.equal(
    listed[0]!.status,
    "paused",
    "an unknown id never changes an existing record",
  );
});

test("run-due fires a due one-shot schedule and reports the result", async (t) => {
  const f = await fixture(t);
  const atMs = Date.now() + 3_000;
  const created = await createSchedule(
    f,
    input({
      name: "Fire once",
      cadence: { kind: "once", at: new Date(atMs).toISOString() },
      maxRuns: 1,
    }),
  );
  assert.equal(created.status, "active");

  const early = await post(`${f.schedulesUrl}/run-due`);
  assert.equal(early.status, 200);
  assert.deepEqual(
    ((await early.json()) as { results?: ScheduleRunResult[] }).results,
    [],
    "nothing is due before the operator's instant",
  );

  const deadline = Date.now() + 15_000;
  while (Date.now() < atMs + 100 && Date.now() < deadline) await delay(20);

  const due = await post(`${f.schedulesUrl}/run-due`);
  assert.equal(due.status, 200);
  const results = ((await due.json()) as { results?: ScheduleRunResult[] })
    .results;
  assert.ok(Array.isArray(results), "run-due answers the firings it evaluated");
  assert.equal(results.length, 1, "the due record fired once");
  assert.equal(results[0]!.scheduleId, created.id);

  const after = await waitForSchedule(
    f,
    created.id,
    (entry) => entry.status === "completed",
  );
  assert.equal(after.runCount, 1);
  assert.equal(after.status, "completed", "a once schedule is finished by its firing");
  assert.equal(after.lastOutcome, "idle");

  const again = await post(`${f.schedulesUrl}/run-due`);
  assert.equal(again.status, 200);
  assert.deepEqual(
    ((await again.json()) as { results?: ScheduleRunResult[] }).results,
    [],
    "a completed record is never due again",
  );
});

test("resume refuses a schedule whose work is already finished", async (t) => {
  const f = await fixture(t);
  const atMs = Date.now() + 3_000;
  const created = await createSchedule(
    f,
    input({
      name: "Finish then resume",
      cadence: { kind: "once", at: new Date(atMs).toISOString() },
      maxRuns: 1,
    }),
  );
  const deadline = Date.now() + 15_000;
  while (Date.now() < atMs + 100 && Date.now() < deadline) await delay(20);
  assert.equal((await post(`${f.schedulesUrl}/run-due`)).status, 200);
  const completed = await waitForSchedule(
    f,
    created.id,
    (entry) => entry.status === "completed",
  );
  assert.equal(completed.status, "completed");

  const refused = await post(`${f.schedulesUrl}/${created.id}/resume`);
  assert.ok(
    refused.status === 400 || refused.status === 409,
    `resuming finished work must be refused, got ${refused.status}`,
  );
  const after = (await readSchedules(f)).find((entry) => entry.id === created.id);
  assert.equal(after?.status, "completed", "a refused resume changes nothing");
});

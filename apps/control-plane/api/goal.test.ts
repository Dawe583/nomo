import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { Workbench } from "../../../packages/workbench/src/index.ts";
import { listenControlPlane } from "./server.ts";

/**
 * Operator goals over HTTP.
 *
 * HP7 makes a goal an objective with a token budget and optional gates, where
 * a gate is a command the operator already allowlisted for hooks. The
 * allowlist is the security boundary: a request may name a gate, but only a
 * command the runtime environment authorised may run. These tests pin the
 * route contract before it exists, and they prove the refusal by watching for
 * the file a forbidden command would create.
 */

// The gate waits before it passes so the cancellation test can observe a goal
// that is still active. It is still one harmless allowlisted Node command.
const GATE_PASSES = `${process.execPath} -e "setTimeout(() => process.exit(0), 2000)"`;

type Goal = {
  id?: string;
  objective: string;
  tokenBudget: number;
  gates: string[];
  status: string;
};

type Fixture = {
  readonly origin: string;
  readonly sessionId: string;
  readonly app: Workbench;
  readonly goalUrl: string;
  readonly marker: string;
  readonly forbidden: string;
};

const fetcher = async (url: unknown) =>
  String(url).endsWith("/models")
    ? Response.json({ data: [{ id: "fixture" }] })
    : Response.json({
        choices: [
          { message: { role: "assistant", content: "Done" }, finish_reason: "stop" },
        ],
      });

async function fixture(
  t: { after(fn: () => Promise<void>): void },
): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "nomo-goal-api-"));
  const marker = join(root, "forbidden-gate-ran");
  // The forbidden command is never in NOMO_HOOK_COMMANDS. If it ever runs,
  // the marker file is the durable evidence, so the assertion does not depend
  // on a status code alone.
  const forbidden = `${process.execPath} -e "require('node:fs').writeFileSync('${marker}','ran')"`;
  const env = {
    NOMO_DATA_DIR: root,
    // A goal is an operator state write, and the control plane defaults to
    // read-only. Normal mode is the mode an operator uses to create one.
    NOMO_PERMISSION_MODE: "normal",
    NOMO_HOOK_COMMANDS: JSON.stringify([GATE_PASSES]),
    // The gate waits two seconds, so an explicit bound keeps a slow machine
    // from turning a pass into a timeout.
    NOMO_HOOK_TIMEOUT_MS: "10000",
  };
  const app = new Workbench(env, fetcher as typeof fetch);
  await app.configure({ baseUrl: "https://fixture.test/v1", apiKey: "fixture" });
  const session = await app.start("Work the goal", "fixture");
  await app.settled();
  const server = await listenControlPlane({ env, workbench: app });
  t.after(async () => {
    await server.close();
    await app.shutdown();
    await rm(root, { recursive: true, force: true });
  });
  const origin = `http://127.0.0.1:${server.port}`;
  return {
    origin,
    sessionId: session.id,
    app,
    goalUrl: `${origin}/api/sessions/${session.id}/goal`,
    marker,
    forbidden,
  };
}

function postGoal(f: Fixture, body: unknown): Promise<Response> {
  return fetch(f.goalUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function readGoal(f: Fixture): Promise<Goal | null> {
  const response = await fetch(f.goalUrl);
  assert.equal(response.status, 200);
  const body = (await response.json()) as { goal?: Goal | null };
  return body.goal ?? null;
}

/**
 * Completion is observed through the read route rather than assumed from the
 * create response, so an implementation that finishes a gate asynchronously
 * is not forced to block the POST.
 */
async function waitForGoal(
  f: Fixture,
  done: (goal: Goal) => boolean,
  label: string,
): Promise<Goal> {
  const deadline = Date.now() + 10_000;
  let goal: Goal | null = null;
  while (Date.now() < deadline) {
    goal = await readGoal(f);
    if (goal && done(goal)) return goal;
    await delay(20);
  }
  assert.fail(`the goal did not reach ${label}; last read: ${JSON.stringify(goal)}`);
}

test("POST creates a goal and a passing allowlisted gate completes it", async (t) => {
  const f = await fixture(t);

  const created = await postGoal(f, {
    objective: "Ship the HP7 slice",
    tokenBudget: 5_000,
    gates: [GATE_PASSES],
  });

  assert.equal(created.status, 201);
  const body = (await created.json()) as { goal: Goal };
  assert.equal(body.goal.objective, "Ship the HP7 slice");
  assert.equal(body.goal.tokenBudget, 5_000);
  assert.deepEqual(body.goal.gates, [GATE_PASSES]);

  const completed = await waitForGoal(
    f,
    (goal) => goal.status === "completed",
    "completed",
  );
  assert.equal(completed.status, "completed");
});

test("GET returns the goal the operator created", async (t) => {
  const f = await fixture(t);
  const created = await postGoal(f, {
    objective: "Inspect the goal",
    tokenBudget: 1_000,
    gates: [GATE_PASSES],
  });
  assert.equal(created.status, 201);
  const createdBody = (await created.json()) as { goal: Goal };

  const read = await readGoal(f);

  assert.ok(read);
  assert.equal(read.objective, "Inspect the goal");
  assert.equal(read.tokenBudget, 1_000);
  assert.deepEqual(read.gates, [GATE_PASSES]);
  if (createdBody.goal.id !== undefined)
    assert.equal(read.id, createdBody.goal.id);
});

test("DELETE cancels the goal and the cancellation is visible", async (t) => {
  const f = await fixture(t);
  const created = await postGoal(f, {
    objective: "Cancel this goal",
    tokenBudget: 10_000,
    gates: [GATE_PASSES],
  });
  assert.equal(created.status, 201);
  const createdBody = (await created.json()) as { goal: Goal };
  assert.equal(createdBody.goal.status, "active");

  const deleted = await fetch(f.goalUrl, { method: "DELETE" });

  assert.equal(deleted.status, 200);
  const body = (await deleted.json()) as { goal: Goal };
  assert.equal(body.goal.status, "cancelled");
  const read = await readGoal(f);
  assert.equal(read?.status, "cancelled");
});

test("POST refuses a gate outside the operator allowlist and never runs it", async (t) => {
  const f = await fixture(t);

  const refused = await postGoal(f, {
    objective: "Run only allowed gates",
    tokenBudget: 1_000,
    gates: [GATE_PASSES, f.forbidden],
  });

  assert.ok(
    refused.status === 400 || refused.status === 409,
    `a non-allowlisted gate must be refused, got ${refused.status}`,
  );
  const body = (await refused.json()) as { message?: string; error?: string };
  assert.match(body.message ?? body.error ?? "", /allowlist/i);
  // The command would finish quickly if it ran, so a short bounded wait makes
  // a late spawn visible without making the assertion depend on that timing.
  await delay(100);
  assert.equal(
    existsSync(f.marker),
    false,
    "the forbidden gate command must never run",
  );
  assert.equal(await readGoal(f), null, "a refused goal creates nothing");
});

test("goal routes answer 404 for an unknown session", async (t) => {
  const f = await fixture(t);
  const url = `${f.origin}/api/sessions/00000000-0000-4000-8000-000000000000/goal`;
  const request = (method: "GET" | "POST" | "DELETE") =>
    method === "POST"
      ? fetch(url, {
          method,
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ objective: "x", tokenBudget: 1 }),
        })
      : fetch(url, { method });

  for (const method of ["GET", "POST", "DELETE"] as const) {
    const response = await request(method);
    assert.equal(response.status, 404, `${method} on an unknown session is a 404`);
    const body = (await response.json()) as { message?: string };
    assert.equal(body.message, "Session not found.");
  }
});

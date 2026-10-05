import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { Workbench } from "./index.ts";
import { HARNESS_SETTINGS } from "./harness-settings.ts";

/**
 * The settings table is only a claim about the run path until something proves
 * a lowered limit actually stops the run. These tests are behavioural rather
 * than structural on purpose: each one fails if the consumer reverts to its
 * literal, which is the failure the table exists to prevent.
 */

const models = () => Response.json({ data: [{ id: "fixture" }] });
const answer = () =>
  Response.json({ choices: [{ message: { role: "assistant", content: "Done" } }] });

/** A provider that always asks for one tool call, so a run cannot finish on its
 * own and the turn bound is what ends it. */
function toolCallLoop(calls: { count: number }) {
  return async (url: string, init?: RequestInit) => {
    if (String(url).endsWith("/models")) return models();
    calls.count++;
    const body = JSON.parse(String(init?.body));
    return Response.json({
      choices: [
        {
          message: {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: `call-${calls.count}`,
                type: "function",
                function: {
                  name: body.tools[0].function.name,
                  arguments: "{}",
                },
              },
            ],
          },
        },
      ],
    });
  };
}

async function fixture(
  t: TestContext,
  fetcher: typeof fetch,
  release?: () => void,
) {
  const root = await mkdtemp(join(tmpdir(), "void-harness-"));
  let app = new Workbench({ VOID_DATA_DIR: root }, fetcher);
  await app.configure({ baseUrl: "https://fixture.test/v1", apiKey: "fixture" });
  t.after(async () => {
    // Unblock any transport parked mid-request before shutting down, or
    // shutdown waits on a run this test deliberately made hang.
    release?.();
    await app.shutdown();
    await rm(root, { recursive: true, force: true });
  });
  return {
    get app() {
      return app;
    },
    restart() {
      app.close();
      app = new Workbench({ VOID_DATA_DIR: root }, fetcher);
      return app;
    },
  };
}

test("a lowered maxTurns stops the run earlier than the default would", async (t) => {
  const calls = { count: 0 };
  const f = await fixture(t, toolCallLoop(calls));

  f.app.patchHarnessSettings({ maxTurns: 2 });
  assert.equal(f.app.harnessSettings().maxTurns, 2);

  const session = await f.app.start("Inspect", "fixture");
  await f.app.settled();
  assert.equal(calls.count, 2, "the lowered bound did not stop the run at 2 turns");
  assert.match(
    f.app.get(session.id)!.events.find((e) => e.kind === "error")!.text,
    /2-turn/,
  );

  // The default is the point of comparison: same fixture, bound restored.
  const before = calls.count;
  f.app.patchHarnessSettings({ maxTurns: HARNESS_SETTINGS.maxTurns.default });
  const second = await f.app.start("Inspect again", "fixture");
  await f.app.settled();
  assert.equal(calls.count - before, HARNESS_SETTINGS.maxTurns.default);
  assert.match(
    f.app.get(second.id)!.events.find((e) => e.kind === "error")!.text,
    /20-turn/,
  );
});

test("an agent profile maxTurns still wins over the harness setting", async (t) => {
  const calls = { count: 0 };
  const f = await fixture(t, toolCallLoop(calls));
  f.app.patchHarnessSettings({ maxTurns: 20 });
  f.app.upsertAgent({
    id: "tight",
    name: "Tight",
    systemPrompt: "Only inspect",
    allowedTools: ["void_workspace_list"],
    policyProfile: "default",
    maxTurns: 1,
    maxContextTokens: 8192,
  });
  const session = await f.app.start("Inspect", "fixture", undefined, undefined, "tight");
  await f.app.settled();
  assert.equal(calls.count, 1, "the profile bound must beat the harness setting");
  assert.match(
    f.app.get(session.id)!.events.find((e) => e.kind === "error")!.text,
    /1-turn/,
  );
});

test("a raised maxQueuedRuns admits more runs and the refusal names the bound", async (t) => {
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const f = await fixture(
    t,
    async (url) => {
      if (String(url).endsWith("/models")) return models();
      await blocked;
      return answer();
    },
    release,
  );

  // One run active, so everything after it queues and counts against the bound.
  await f.app.start("First", "fixture");
  const raised = 3;
  f.app.patchHarnessSettings({ maxQueuedRuns: raised });

  for (let i = 0; i < raised; i++)
    await f.app.start(`Queued ${i}`, "fixture", undefined, undefined, undefined, true);
  assert.equal(
    f.app.list().filter((s) => s.status === "queued").length,
    raised,
    "the raised bound did not admit the extra runs",
  );

  await assert.rejects(
    f.app.start("Overflow", "fixture", undefined, undefined, undefined, true),
    new RegExp(`queue is full \\(${raised} queued runs\\)`),
    "the refusal must name the configured bound, not a literal",
  );
});

test("the default queue bound still refuses at 20 and names 20", async (t) => {
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const f = await fixture(
    t,
    async (url) => {
      if (String(url).endsWith("/models")) return models();
      await blocked;
      return answer();
    },
    release,
  );
  await f.app.start("First", "fixture");
  for (let i = 0; i < HARNESS_SETTINGS.maxQueuedRuns.default; i++)
    await f.app.start(`Queued ${i}`, "fixture", undefined, undefined, undefined, true);
  await assert.rejects(
    f.app.start("Overflow", "fixture", undefined, undefined, undefined, true),
    /queue is full \(20 queued runs\)/,
  );
});

test("maxRunTimeoutMs aborts a hanging run without reporting a clean finish", async (t) => {
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const f = await fixture(
    t,
    async (url) => {
      if (String(url).endsWith("/models")) return models();
      await blocked; // Never answers within the run budget.
      return answer();
    },
    release,
  );

  f.app.patchHarnessSettings({ maxRunTimeoutMs: 1000 });
  const session = await f.app.start("Hang", "fixture");
  // The provider's own per-request abort may or may not be honoured by this
  // transport, so wait on the status rather than a fixed sleep.
  const deadline = Date.now() + 15000;
  while (f.app.get(session.id)?.status === "running" && Date.now() < deadline)
    await delay(10);

  const view = f.app.get(session.id)!;
  assert.notEqual(view.status, "running", "the run was never aborted");
  assert.notEqual(view.status, "idle", "a timed-out run must not read as a clean finish");
  // `unknown` is what leaves Undo and reconciliation available, matching an
  // unknown tool outcome.
  assert.equal(view.status, "unknown");
  assert.match(
    view.events.find((e) => e.kind === "error")!.text,
    /exceeded its 1000ms limit/,
    "the operator cannot tell a timeout from any other stop",
  );
  assert.equal(f.app.runs().find((r) => r.sessionId === session.id)?.state, "unknown");
  // Reconciliation is the point of the status, so the session must refuse a
  // follow-up message until it is settled.
  assert.throws(() => f.app.send(session.id, "Continue"), /unknown|reconcile/i);
});

test("a clean finish is still idle, so the timeout status is not the default", async (t) => {
  const f = await fixture(t, async (url) =>
    String(url).endsWith("/models") ? models() : answer(),
  );
  f.app.patchHarnessSettings({ maxRunTimeoutMs: 60000 });
  const session = await f.app.start("Quick", "fixture");
  await f.app.settled();
  assert.equal(f.app.get(session.id)?.status, "idle");
});

test("patchHarnessSettings persists across a Workbench restart", async (t) => {
  const f = await fixture(t, async (url) =>
    String(url).endsWith("/models") ? models() : answer(),
  );
  const patched = f.app.patchHarnessSettings({
    maxTurns: 3,
    maxQueuedRuns: 7,
    hookTimeoutMs: 1234,
  });
  assert.equal(patched.maxTurns, 3);
  assert.equal(patched.maxQueuedRuns, 7);

  const reopened = f.restart();
  assert.equal(reopened.harnessSettings().maxTurns, 3);
  assert.equal(reopened.harnessSettings().maxQueuedRuns, 7);
  assert.equal(reopened.harnessSettings().hookTimeoutMs, 1234);
  // Untouched keys keep their defaults rather than becoming undefined.
  assert.equal(
    reopened.harnessSettings().maxOutputTokens,
    HARNESS_SETTINGS.maxOutputTokens.default,
  );
});

test("an unknown key is refused and changes nothing", async (t) => {
  const f = await fixture(t, async (url) =>
    String(url).endsWith("/models") ? models() : answer(),
  );
  const before = f.app.harnessSettings();
  assert.throws(
    () => f.app.patchHarnessSettings({ maxTurn: 5 }),
    /Unknown harness setting maxTurn\./,
  );
  assert.throws(
    () => f.app.patchHarnessSettings({ permissionMode: "normal" }),
    /Unknown harness setting permissionMode\./,
  );
  assert.deepEqual(f.app.harnessSettings(), before, "a refused patch mutated the settings");
});

test("an out-of-range patch is clamped rather than refused", async (t) => {
  const f = await fixture(t, async (url) =>
    String(url).endsWith("/models") ? models() : answer(),
  );
  assert.equal(f.app.patchHarnessSettings({ maxQueuedRuns: 0 }).maxQueuedRuns, 1);
  assert.equal(
    f.app.patchHarnessSettings({ maxQueuedRuns: 1e9 }).maxQueuedRuns,
    HARNESS_SETTINGS.maxQueuedRuns.max,
  );
  // A patch that lands in range survives a restart unchanged.
  f.app.patchHarnessSettings({ maxQueuedRuns: 5 });
  assert.equal(f.restart().harnessSettings().maxQueuedRuns, 5);
});

test("maxPromptCharacters refuses start and send at the configured bound", async (t) => {
  const f = await fixture(t, async (url) =>
    String(url).endsWith("/models") ? models() : answer(),
  );
  f.app.patchHarnessSettings({ maxPromptCharacters: 256 });
  const long = "x".repeat(300);
  // start refuses rather than truncating: a silently shortened prompt would run
  // an instruction the operator never wrote.
  await assert.rejects(f.app.start(long, "fixture"), /1 and 256 characters/);
  const session = await f.app.start("Short", "fixture");
  await f.app.settled();
  assert.throws(() => f.app.send(session.id, long), /1 and 256 characters/);
});

test("maxOutputTokens is sent with the request", async (t) => {
  const bodies: Array<Record<string, unknown>> = [];
  const f = await fixture(t, async (url, init) => {
    if (String(url).endsWith("/models")) return models();
    bodies.push(JSON.parse(String(init?.body)));
    return answer();
  });
  f.app.patchHarnessSettings({ maxOutputTokens: 512 });
  await f.app.start("Inspect", "fixture");
  await f.app.settled();
  assert.equal(bodies[0]!.max_tokens, 512);
  assert.equal(HARNESS_SETTINGS.maxOutputTokens.default, 4096);
});
test("maxPromptCharacters also bounds a branch prompt rewrite", async (t) => {
  // branch() rewrites a user message, so it accepts a prompt and must hold it
  // to the same bound as start and send. It carried its own 32000 literal,
  // which would have let a raised limit be ignored on this path entirely.
  const f = await fixture(t, async (url) =>
    String(url).endsWith("/models") ? models() : answer(),
  );
  const session = await f.app.start("Original prompt", "fixture");
  await f.app.settled();

  f.app.patchHarnessSettings({ maxPromptCharacters: 256 });
  await assert.rejects(
    f.app.branch(session.id, {
      seq: 1,
      prompt: "x".repeat(300),
      idempotencyKey: "branch-too-long",
    } as Parameters<Workbench["branch"]>[1]),
    /user message/,
  );

  // The bound is a setting, not a wall: under the default a prompt this test
  // just refused is accepted, which is what "operator-settable" has to mean.
  f.app.patchHarnessSettings({
    maxPromptCharacters: HARNESS_SETTINGS.maxPromptCharacters.default,
  });
  const child = await f.app.branch(session.id, {
    seq: 1,
    prompt: "x".repeat(300),
    idempotencyKey: "branch-long-enough",
  } as Parameters<Workbench["branch"]>[1]);
  assert.equal(child.status, "idle");
});

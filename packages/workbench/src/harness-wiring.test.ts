import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { Workbench } from "./index.ts";
import { HARNESS_SETTINGS } from "./harness-settings.ts";
import { keyProviderFromPkcs8 } from "../../ledger/src/sign.ts";
import type { UpstreamEvents } from "../../proxy/src/bin.ts";
import type { UpstreamProcess } from "../../proxy/src/transport/stdio.ts";
import { LocalStorage } from "./storage.ts";
import type { McpConfig } from "./mcp.ts";

type LocalHarnessTaskInput = Parameters<Workbench["runLocalHarnessTask"]>[0];

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

/**
 * Task 6, the two halves that only a real run can settle: a harness task that
 * actually crosses the inbound proxy, and the bearer that must not survive it.
 *
 * These are the tests the plan's acceptance rests on. "Cannot choose a
 * caller-supplied identity or secret" is not a property of a type signature —
 * it is a property of what is still on disk and in the prompt afterwards, so
 * both are read back and searched rather than asserted from the code.
 */

/**
 * A real registry entry, not an invented name. An unregistered tool is
 * `unknown-tool` and fails closed, so the demo would never reach the upstream
 * at all. With `bucket.versioning = Enabled` this case classifies r0, which
 * is what makes the call an allow rather than a hold.
 */
const upstreamTool = {
  name: "aws.s3.object.put",
  description: "Overwrite the demo bucket object",
  inputSchema: {
    type: "object" as const,
    properties: { key: { type: "string" }, body: { type: "string" } },
    required: ["key", "body"],
    additionalProperties: false,
  },
};

/** The scope and facts the task declares, shared by the four tests below. */
const taskScope = ["aws.s3.object.put"];
const taskFacts = { "bucket.versioning": "Enabled" };

/**
 * A disposable upstream: one tool, one answer, no external process.
 *
 * The policy body is a parameter rather than a constant so a test can change
 * the verdict without changing anything else. A fixture that always allows
 * cannot tell a policy that decides from one that is merely consulted.
 */
function demoProxy(
  directory: string,
  calls: string[],
  policy = "version: 1\nrules:\n  - match: {}\n    decision: allow\n",
): Parameters<Workbench["runLocalHarnessTask"]>[0]["proxy"] {
  return {
    upstreamCommand: ["fixture"],
    policyPath: writeProxyPolicy(directory, policy),
    posture: "fail-closed" as const,
    ledgerDir: join(directory, "ledger"),
    workspace: "demo-workspace",
    keyProvider: keyProviderFromPkcs8(
      generateKeyPairSync("ed25519").privateKey.export({
        format: "der",
        type: "pkcs8",
      }),
    ),
    upstreamSpawn(events: UpstreamEvents): UpstreamProcess {
      return {
        send(line: string) {
          const message = JSON.parse(line) as {
            id?: number | string;
            method?: string;
            params?: { name?: string };
          };
          // The bridge speaks to the upstream before it will serve a caller,
          // so a fixture that ignores `initialize` stalls every later request
          // rather than failing one.
          if (message.method === "initialize")
            events.onMessage(JSON.stringify({
              jsonrpc: "2.0",
              id: message.id,
              result: {
                protocolVersion: "2025-11-25",
                capabilities: { tools: {} },
                serverInfo: { name: "fixture", version: "1" },
              },
            }));
          else if (message.method === "tools/list")
            events.onMessage(JSON.stringify({
              jsonrpc: "2.0",
              id: message.id,
              result: { tools: [upstreamTool] },
            }));
          else if (message.method === "tools/call") {
            calls.push(message.params?.name ?? "");
            events.onMessage(JSON.stringify({
              jsonrpc: "2.0",
              id: message.id,
              result: { content: [{ type: "text", text: "demo-state" }] },
            }));
          }
        },
        close() {
          events.onClose(0, null);
        },
        onStderr() {
          return () => {};
        },
      };
    },
  };
}

/** Writes the interception policy the proxy will load, and returns its path. */
function writeProxyPolicy(directory: string, policy: string): string {
  const path = join(directory, "policy.yml");
  writeFileSync(path, policy);
  return path;
}

async function identityFixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "void-local-identity-"));
  writeProxyPolicy(
    directory,
    "version: 1\nrules:\n  - match: {}\n    decision: allow\n",
  );
  const calls: string[] = [];
  let usedUpstream = false;
  const app = new Workbench({ VOID_DATA_DIR: join(directory, "state") }, async (
    url,
    init,
  ) => {
    if (String(url).endsWith("/models")) return models();
    // The upstream tool is advertised by description, not by name: the workbench
    // renumbers tools per turn. Keying on a turn counter would couple this
    // fixture to how many sessions ran before it.
    const tools = (JSON.parse(String(init?.body)).tools ?? []) as Array<{
      function?: { name?: string; description?: string };
    }>;
    const upstreamIndex = tools.findIndex((tool) =>
      String(tool.function?.description ?? "").includes("Overwrite the demo bucket object"),
    );
    if (upstreamIndex >= 0 && !usedUpstream) {
      usedUpstream = true;
      return Response.json({
        choices: [{
          message: {
            role: "assistant",
            content: null,
            tool_calls: [{
              id: "call-1",
              type: "function",
              function: {
                name: tools[upstreamIndex]!.function!.name!,
                arguments: '{"key":"demo","body":"hello"}',
              },
            }],
          },
        }],
      });
    }
    return answer();
  });
  await app.configure({ baseUrl: "https://fixture.test/v1", apiKey: "fixture" });
  const originalFetch = globalThis.fetch;
  const seen: string[] = [];
  globalThis.fetch = (async (url: any, init?: any) => {
    seen.push(String(init?.body ?? ""));
    return originalFetch(url as never, init);
  }) as typeof fetch;
  t.after(async () => {
    globalThis.fetch = originalFetch;
    await app.shutdown();
    await rm(directory, { recursive: true, force: true });
  });
  return { app, directory, calls, seen };
}

test("one harness task runs through the inbound proxy, policy and ledger", async (t) => {
  const { app, directory, calls } = await identityFixture(t);

  const result = await app.runLocalHarnessTask({
    upstreamId: "local-demo-upstream",
    prompt: "Read the demo bucket state",
    toolScope: taskScope,
    facts: taskFacts,
    proxy: demoProxy(directory, calls),
    learning: { enabled: false },
  });

  // The run crossed the real listener: the disposable upstream saw the call.
  assert.deepEqual(calls, ["aws.s3.object.put"]);
  // The identity is the server's, bound to this run, and carries the scope the
  // task was granted rather than anything the caller supplied.
  assert.equal(result.identity.upstreamId, "local-demo-upstream");
  assert.equal(result.identity.audience, "nomo-inbound-proxy");
  assert.deepEqual([...result.identity.toolScope], taskScope);
  const taskRun = app.get(result.sessionId)!;
  assert.equal(app.list().length, 1);
  assert.equal(result.identity.runId, taskRun.runId);
  assert.equal(result.identity.workspaceId, taskRun.workspace);
  assert.match(result.identity.runId, /^[0-9a-f-]{36}$/);
  // The same evidence path as every other guarded call: policy decided and the
  // ledger recorded it, with no bypass.
  assert.ok(result.ledger.entries.length > 0);
  assert.ok(
    result.ledger.entries.some((entry) =>
      JSON.stringify(entry).includes("aws.s3.object.put"),
    ),
  );
});

test("a caller-supplied identity or secret cannot reach the grant", async (t) => {
  const { app, directory, calls } = await identityFixture(t);

  await assert.rejects(
    app.runLocalHarnessTask({
      upstreamId: "local-demo-upstream",
      prompt: "Read the demo bucket state",
      toolScope: taskScope,
    facts: taskFacts,
      // Neither of these may reach the wire. They are the two ways a caller
      // would try to act as somebody else on a shared enforcement path.
      agentId: "caller-chosen-agent",
      token: "caller-chosen-secret",
      proxy: demoProxy(directory, calls),
      learning: { enabled: false },
    } as unknown as LocalHarnessTaskInput),
    /unknown|caller|identity|token|agent/i,
  );
  assert.deepEqual(calls, []);
});

test("harness learning activation is refused on the identity path", async (t) => {
  const { app, directory, calls } = await identityFixture(t);

  // The plan keeps learning off for the demo. That has to be a refusal the
  // caller can see, not a default that a later default change could lift.
  await assert.rejects(
    app.runLocalHarnessTask({
      upstreamId: "local-demo-upstream",
      prompt: "Read the demo bucket state",
      toolScope: taskScope,
    facts: taskFacts,
      proxy: demoProxy(directory, calls),
      learning: { enabled: true },
    } as unknown as LocalHarnessTaskInput),
    /learning/i,
  );
  await assert.rejects(
    app.runLocalHarnessTask({
      upstreamId: "local-demo-upstream",
      prompt: "Read the demo bucket state",
      toolScope: taskScope,
    facts: taskFacts,
      proxy: demoProxy(directory, calls),
    } as unknown as LocalHarnessTaskInput),
    /learning/i,
  );
  assert.deepEqual(calls, []);
});

test("the granted bearer survives no prompt, catalog, snapshot or recovery context", async (t) => {
  const { app, directory, calls, seen } = await identityFixture(t);

  const result = await app.runLocalHarnessTask({
    upstreamId: "local-demo-upstream",
    prompt: "Read the demo bucket state",
    toolScope: taskScope,
    facts: taskFacts,
    proxy: demoProxy(directory, calls),
    learning: { enabled: false },
  });
  const bearer = result.grantToken;
  assert.match(bearer, /^[A-Za-z0-9_-]{43}$/);

  // Model prompts: every request body the provider was sent.
  assert.ok(seen.length > 0, "the run sent no model request to search");
  for (const body of seen) assert.doesNotMatch(body, new RegExp(bearer));
  // Tool descriptions, as the run and the API surface them.
  const catalog = JSON.stringify(app.connectionState());
  assert.doesNotMatch(catalog, new RegExp(bearer));
  // Saved settings and durable state, read back off disk rather than from the
  // in-memory object that produced it.
  const state = join(directory, "state");
  const snapshot = new LocalStorage(state).read<Record<string, unknown>>()!;
  assert.doesNotMatch(JSON.stringify(snapshot), new RegExp(bearer));
  // Recovery context: the requests that resume a run after an outage, which is
  // where a bearer would be most useful to an attacker and least expected.
  assert.deepEqual(snapshot.recoveryRequests, {});
  for (const session of (snapshot.sessions ?? []) as Array<Record<string, unknown>>)
    assert.doesNotMatch(JSON.stringify(session), new RegExp(bearer));
});

/**
 * The other half of "through the inbound proxy, policy and ledger".
 *
 * The run above proves a call crossed the proxy: the disposable upstream saw
 * it. That is not the same as proving policy decided anything. An allow-every
 * fixture cannot tell a policy that decides from one that is consulted and
 * ignored, so the only way to witness a verdict is to change it and watch the
 * run change with it.
 *
 * Hold is in the same test on purpose. At this layer a hold that expires is
 * indistinguishable from a deny — the run ends the same way and the upstream
 * sees nothing either time — so the third case asserts only what is actually
 * true, and the way it bites is the same: a proxy that ignored policy would
 * turn the hold into an allow and the upstream would see the call.
 */
test("the policy verdict decides the outcome, and the ledger records which one", async (t) => {
  const runWith = async (policy: string) => {
    const fixture = await identityFixture(t);
    const result = await fixture.app.runLocalHarnessTask({
      upstreamId: "local-demo-upstream",
      prompt: "Overwrite the demo object",
      toolScope: taskScope,
      facts: taskFacts,
      proxy: demoProxy(fixture.directory, fixture.calls, policy),
      learning: { enabled: false },
    });
    return {
      calls: fixture.calls,
      ledger: JSON.stringify(result.ledger.entries),
    };
  };

  const allowed = await runWith(
    "version: 1\nrules:\n  - match: {}\n    decision: allow\n",
  );
  const denied = await runWith(
    "version: 1\nrules:\n  - match: {}\n    decision: deny\n",
  );
  // A one second hold expires on its own, so the case costs a second instead of
  // blocking a turn until the transport gives up.
  const held = await runWith(
    "version: 1\nrules:\n  - match: {}\n    decision: hold\n    seconds: 1\n",
  );

  assert.deepEqual(allowed.calls, taskScope, "an allowed call never reached the upstream");
  assert.deepEqual(denied.calls, [], "a denied call still reached the upstream");
  assert.deepEqual(held.calls, [], "a held call was dispatched before it was released");
  assert.match(allowed.ledger, /aws\.s3\.object\.put/);
  assert.match(allowed.ledger, /execute:completed/);
  // Neither refusal is signed off as work that happened. This is the part a
  // "consult policy, then proceed anyway" regression would break while still
  // leaving the upstream call count right.
  assert.doesNotMatch(denied.ledger, /execute:completed/);
  assert.doesNotMatch(held.ledger, /execute:completed/);
  assert.match(denied.ledger, /aws\.s3\.object\.put/);
});

/**
 * A provider-owned bearer has two homes: the live connection, which holds the
 * closure that mints it, and the snapshot, which must hold neither the closure
 * nor anything derived from it. The second is the one that matters — the
 * snapshot is what a later run, a backup, or an operator reads.
 *
 * The live half is asserted too, because a test that only checked the snapshot
 * would pass on a Workbench that never had a provider connection at all.
 */
test("a session's saved connection keeps the live provider and drops the saved one", async (t) => {
  const { app, directory } = await identityFixture(t);
  const result = await app.runLocalHarnessTask({
    upstreamId: "local-demo-upstream",
    prompt: "Overwrite the demo object",
    toolScope: taskScope,
    facts: taskFacts,
    proxy: demoProxy(directory, []),
    learning: { enabled: false },
  });

  const internals = app as unknown as {
    sessions: Map<string, { connections?: Record<string, McpConfig> }>;
  };
  const live = internals.sessions.get(result.sessionId)?.connections ?? {};
  const liveEntries = Object.entries(live);
  assert.ok(liveEntries.length > 0, "the run left no connector connection to compare");
  // The live connection really does carry the provider that owns the bearer.
  for (const [, config] of liveEntries)
    assert.equal(typeof config.tokenProvider, "function");

  const snapshot = new LocalStorage(join(directory, "state"))
    .read<{ sessions?: Array<{ connections?: Record<string, Record<string, unknown>> }> }>()!;
  const stored = snapshot.sessions?.flatMap((session) =>
    Object.values(session.connections ?? {}),
  ) ?? [];
  assert.ok(stored.length > 0, "no connection was saved to compare against the live one");
  for (const connection of stored) {
    assert.equal(
      "tokenProvider" in connection,
      false,
      "a saved connection kept its token provider",
    );
    assert.equal(connection.token, undefined, "a saved connection kept a bearer");
  }
});

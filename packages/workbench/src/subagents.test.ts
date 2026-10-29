import { createServer, type Server } from "node:http";
import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { LocalStorage } from "./storage.ts";
import { assertIsolated, isolatedWorkbench } from "./test-fixture.ts";
import { Workbench } from "./index.ts";
import { subsetTools } from "./subagents.ts";
import { readLedgerFeed } from "../../ledger/src/feed.ts";

const reply = (body: unknown) =>
  new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
  });
const models = () => reply({ data: [{ id: "fixture" }] });
const answer = (content: string = "Done") =>
  reply({ choices: [{ message: { role: "assistant", content }, finish_reason: "stop" }] });
const successFetcher: typeof fetch = async (url) =>
  String(url).endsWith("/models") ? models() : answer();

async function toolCatalogServer(name: string, description = name) {
  const server: Server = createServer(async (request, response) => {
    let text = "";
    for await (const chunk of request) text += chunk;
    const message = JSON.parse(text) as { id?: string; method?: string };
    response.setHeader("content-type", "application/json");
    response.end(
      JSON.stringify({
        jsonrpc: "2.0",
        ...(message.id ? { id: message.id } : {}),
        result:
          message.method === "tools/list"
            ? { tools: [{ name, description }] }
            : {},
      }),
    );
  });
  server.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return {
    url: `http://127.0.0.1:${address.port}/mcp`,
    close: () =>
      new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

test("spawn creates a child with parentId and fresh history", async (t) => {
  const { app } = await isolatedWorkbench(t, ((u: string) => models()) as unknown as typeof fetch, {});
  // models fetcher returns models, catalog populated; workbench auto not started
  const parent = await app.start("Parent request", "fixture");
  const child = await app.spawnSubagent(parent.id, "Do the delegated task");
  assert.notEqual(child.id, parent.id);
  assert.equal(child.parentId, parent.id);
  assert.notEqual(child.workspace, parent.workspace);
  assert.equal(child.status === "queued" || child.status === "idle", true);
  const childView = app.get(child.id)!;
  // fresh history: only system + at most one pending queued user event
  assert.ok(
    childView.contextMessages === 1 ||
      childView.events.some((e) => e.kind === "user"),
  );
  assert.equal((await app.list()).find((s) => s.id === parent.id)!.parentId, undefined);
});

test("a promoted workspace profile configures a child without widening its tool set", async (t) => {
  const { app } = await isolatedWorkbench(t, successFetcher, {});
  const parent = await app.start("Parent request", "fixture");
  await app.settled();
  await app.editDocument(parent.id, {
    path: "source.md",
    content: "signed source record",
    expectedRevision: null,
  });
  const profile = {
    id: "promoted-helper",
    name: "Helper",
    systemPrompt: "Inspect only.",
    allowedTools: ["void_workspace_list"],
    policyProfile: "default",
    maxTurns: 1,
    maxContextTokens: 4096,
  };
  const evidenceSeq = (await app.ledger(parent.workspace))!.entries.at(-1)!.seq;
  const proposal = {
    summary: "bounded subagent profile",
    rationale: "delegated work needs a narrow profile",
    expectedOutcome: "the child receives only approved capabilities",
    edits: [{
      action: "create",
      kind: "subagent",
      profile,
      derivedFromSeq: [evidenceSeq],
      reason: "the signed history supports this profile",
    }],
  } as Parameters<Workbench["refineHarness"]>[1];
  const pending = await app.refineHarness(parent.id, proposal);
  await app.approveHarnessProposal(parent.id, pending.proposalDigest!);

  const child = await app.spawnSubagent(parent.id, "Inspect one record", {
    agent: profile.id,
  });
  await app.settled();
  const childSession = (app as unknown as {
    sessions: Map<string, {
      agentProfile?: typeof profile;
      messages: Array<{ role: string; content: string }>;
      tools: Array<{ name: string }>;
    }>;
  }).sessions.get(child.id)!;
  assert.equal(childSession.agentProfile?.id, profile.id);
  assert.match(
    childSession.messages[0]!.content,
    /Active agent profile \(promoted-helper\): Inspect only\./,
  );
  assert.deepEqual(childSession.tools.map((tool) => tool.name), ["void_workspace_list"]);
  assert.equal(child.agent, profile.id);
});

test("spawn refuses an unknown parent without creating a session", async (t) => {
  const { app } = await isolatedWorkbench(t, ((u: string) => models()) as unknown as typeof fetch, {});
  const before = (await app.list()).length;
  await assert.rejects(
    app.spawnSubagent("no-such-parent", "hello"),
    /Session not found\./,
  );
  assert.equal((await app.list()).length, before);
});

test("spawn refuses an empty prompt without side effects", async (t) => {
  const { app } = await isolatedWorkbench(t, ((u: string) => models()) as unknown as typeof fetch, {});
  const parent = await app.start("Parent request", "fixture");
  await assert.rejects(
    app.spawnSubagent(parent.id, "   "),
    /Enter a prompt between/,
  );
});

test("idempotent replay returns the same child, once", async (t) => {
  const { app } = await isolatedWorkbench(t, ((u: string) => models()) as unknown as typeof fetch, {});
  const parent = await app.start("Parent request", "fixture");
  const first = await app.spawnSubagent(parent.id, "Do the task", {
    idempotencyKey: "key-1",
  });
  const second = await app.spawnSubagent(parent.id, "Do the task", {
    idempotencyKey: "key-1",
  });
  assert.equal(second.id, first.id);
});
test("replayed persisted spawn mapping fails closed when its child is missing", async (t) => {
  const fixture = await isolatedWorkbench(t, successFetcher, {});
  const { app, root } = fixture;
  const parent = await app.start("Parent request", "fixture");
  await app.settled();
  const child = await app.spawnSubagent(parent.id, "Do the task", {
    idempotencyKey: "missing-child-key",
  });
  await app.settled();
  await app.shutdown();

  const storage = new LocalStorage(root);
  const snapshot = storage.read<{
    requests: Record<string, { digest: string; sessionId: string }>;
    sessions: Array<{ view: { id: string } }>;
  }>()!;
  assert.equal(snapshot.requests["missing-child-key"].sessionId, child.id);
  snapshot.sessions = snapshot.sessions.filter((session) => session.view.id !== child.id);
  storage.save(snapshot);

  const restarted = fixture.restart({ keepOpen: true });
  const before = (await restarted.ledger(parent.workspace))!.entries.length;
  await assert.rejects(
    restarted.spawnSubagent(parent.id, "Do the task", {
      idempotencyKey: "missing-child-key",
    }),
    /Idempotent spawn result is unavailable/i,
  );
  assert.equal((await restarted.list()).some((session) => session.id === child.id), false);
  assert.equal((await restarted.ledger(parent.workspace))!.entries.length, before);
});


test("idempotency key collision with a different prompt is rejected", async (t) => {
  const { app } = await isolatedWorkbench(t, ((u: string) => models()) as unknown as typeof fetch, {});
  const parent = await app.start("Parent request", "fixture");
  await app.spawnSubagent(parent.id, "first prompt", {
    idempotencyKey: "collide-key",
  });
  await assert.rejects(
    app.spawnSubagent(parent.id, "second different prompt", {
      idempotencyKey: "collide-key",
    }),
    /Idempotency key belongs to another request\./,
  );
});

test("spawn writes a void_subagent_spawn entry to the parent chain", async (t) => {
  const { app } = await isolatedWorkbench(t, ((u: string) => models()) as unknown as typeof fetch, {});
  await app.settled();
  const parent = await app.start("Parent request", "fixture");
  const child = await app.spawnSubagent(parent.id, "Delegated payload", { idempotencyKey: "lk" });
  const proof = await app.ledger(parent.workspace);
  assert.ok(proof, "ledger proof for parent workspace");
  const entries = (proof as { entries: Array<{ body: Record<string, unknown> }> }).entries;
  const entry = entries.find((e) => e.body.tool === "void_subagent_spawn");
  assert.ok(entry, "expected a void_subagent_spawn entry");
  assert.equal(entry!.body.decision, "spawn:completed");
  assert.ok(entry!.body.promptSha256, "prompt digest present");
  assert.equal(JSON.stringify(entry!.body).includes("Delegated payload"), false, "no raw prompt in ledger");
  assert.equal(child.parentId, parent.id);
});

test("spawn queues when capacity is held and fails closed at queue cap", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "nomo-spawn-cap-"));
  const fetcher: typeof fetch = async (url: unknown) => {
    if (String(url).endsWith("/models")) return models();
    await new Promise((resolve) => setTimeout(resolve, 300));
    return answer("Done");
  };
  const env = {
    NOMO_DATA_DIR: root,
    NOMO_LEDGER_DIR: join(root, "ledger"),
  } as NodeJS.ProcessEnv;
  const app = new Workbench(env, fetcher);
  assertIsolated(root, env);
  await app.configure({ baseUrl: "https://fixture.test/v1", apiKey: "fixture" });
  await app.patchHarnessSettings({ maxQueuedRuns: 1 });
  const parent = await app.start("Long parent", "fixture");
  assert.equal(parent.status, "running");
  const child1 = await app.spawnSubagent(parent.id, "Child one");
  assert.equal(child1.status, "queued");
  await assert.rejects(
    app.spawnSubagent(parent.id, "Child two"),
    /Background queue is full/,
  );
  await new Promise((resolve) => setTimeout(resolve, 400));
  await app.settled();
  app.close();
  await rm(root, { recursive: true, force: true });
});
test("result preview only accepts a successful current-run assistant completion", async (t) => {
  const { app } = await isolatedWorkbench(t, successFetcher, {});
  const parent = await app.start("Parent request", "fixture");
  await app.settled();
  const child = await app.spawnSubagent(parent.id, "Do the delegated task");
  await app.settled();
  const view = app.get(child.id)!;
  assert.equal(view.status, "idle");
  const result = await app.subagentResult(parent.id, child.id);
  assert.equal(result?.text, "Done");
  assert.equal(result?.runId, view.runId);
  const completed = view.events.find(
    (event) =>
      event.runId === view.runId &&
      event.kind === "assistant" &&
      event.type === "message.completed",
  );
  assert.equal(completed?.payload?.toolCallsPresent, false);
  assert.equal(completed?.payload?.textTruncated, false);
});

test("queued child cancellation clears its prompt and excludes it from dispatch", async (t) => {
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  let providerCalls = 0;
  const fetcher: typeof fetch = async (url) => {
    if (String(url).endsWith("/models")) return models();
    providerCalls++;
    await blocked;
    return answer();
  };
  const { app, root } = await isolatedWorkbench(t, fetcher, {}, {
    prefix: "nomo-spawn-cancel-",
    beforeShutdown: release,
  });
  const parent = await app.start("Parent request", "fixture");
  const child = await app.spawnSubagent(parent.id, "Do the delegated task");
  assert.equal(child.status, "queued");
  await app.cancelSubagent(parent.id, child.id);
  release();
  const snapshot = new LocalStorage(root).read<{
    sessions: Array<{ view: { id: string }; queuedPrompt?: string }>;
  }>()!;
  assert.equal(snapshot.sessions.find((item) => item.view.id === child.id)?.queuedPrompt, undefined);
  await app.settled();
  assert.equal(app.get(child.id)?.status, "cancelled");
  assert.equal(providerCalls, 1);
});

test("a foreign parent cannot cancel or inspect a spawned child", async (t) => {
  const { app } = await isolatedWorkbench(t, successFetcher, {});
  const parent = await app.start("Parent request", "fixture");
  await app.settled();
  const other = await app.start("Other request", "fixture");
  await app.settled();
  const child = await app.spawnSubagent(parent.id, "Do the delegated task");
  await app.settled();
  await assert.rejects(app.cancelSubagent(other.id, child.id), /not a verified child/i);
  await assert.rejects(app.subagentResult(other.id, child.id), /not a verified child/i);
  assert.equal(app.get(child.id)?.status, "idle");
});
test("result delivery is attributed, explicit, bounded, and idempotent", async (t) => {
  const { app } = await isolatedWorkbench(t, successFetcher, {});
  const parent = await app.start("Parent request", "fixture");
  await app.settled();
  const child = await app.spawnSubagent(parent.id, "Do the delegated task");
  await app.settled();
  const result = (await app.subagentResult(parent.id, child.id))!;
  const ledgerBefore = (await app.ledger(parent.workspace))!.entries.length;
  assert.equal(app.get(parent.id)?.events.some((event) => event.text.includes(child.id)), false);
  await app.deliverSubagentResult(parent.id, child.id, result.runId);
  await app.deliverSubagentResult(parent.id, child.id, result.runId);
  await app.settled();
  assert.equal(
    app.get(parent.id)?.events.filter((event) =>
      event.kind === "user" && event.text.includes(`Child: ${child.id}`),
    ).length,
    1,
  );
  assert.equal((await app.ledger(parent.workspace))!.entries.length, ledgerBefore);
});
test("branch parentId without a signed spawn record is not lifecycle authority", async (t) => {
  const { app } = await isolatedWorkbench(t, successFetcher, {});
  const parent = await app.start("Parent request", "fixture");
  await app.settled();
  const user = app.get(parent.id)!.events.find((event) => event.kind === "user")!;
  const branch = await app.branch(parent.id, {
    seq: user.seq,
    idempotencyKey: "branch-clone",
  });
  await assert.rejects(app.cancelSubagent(parent.id, branch.id), /not a verified child/i);
  await assert.rejects(app.subagentResult(parent.id, branch.id), /not a verified child/i);
  assert.equal(app.get(branch.id)?.status, "idle");
});

test("result extraction ignores delta and other-run completion events and refuses non-success states", async (t) => {
  const { app } = await isolatedWorkbench(t, successFetcher, {});
  const parent = await app.start("Parent request", "fixture");
  await app.settled();
  const child = await app.spawnSubagent(parent.id, "Do the delegated task");
  await app.settled();
  const internals = app as unknown as { sessions: Map<string, {
    view: { status: string; events: Array<Record<string, unknown>> };
  }> };
  const session = internals.sessions.get(child.id)!;
  const runId = app.get(child.id)!.runId!;
  session.view.events.push(
    { ...session.view.events.at(-1), seq: 9001, runId, kind: "assistant", type: "message.delta", text: "not final" },
    { ...session.view.events.at(-1), seq: 9002, runId: "older-run", kind: "assistant", type: "message.completed", text: "old run" },
  );
  const result = await app.subagentResult(parent.id, child.id);
  assert.equal(result?.text, "Done");
  for (const status of ["failed", "unknown", "cancelled", "queued", "paused", "running"]) {
    session.view.status = status;
    assert.equal(await app.subagentResult(parent.id, child.id), undefined, status);
    await assert.rejects(
      app.deliverSubagentResult(parent.id, child.id, runId),
      /no longer deliverable/i,
    );
  }
  session.view.status = "idle";
  await assert.rejects(
    app.cancelSubagent(parent.id, child.id),
    /not in a cancellable state/i,
  );
  assert.equal(app.get(child.id)?.status, "idle");
});

test("running child cancellation keeps capacity until settle and then derives stopped", async (t) => {
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  let calls = 0;
  const fetcher: typeof fetch = async (url) => {
    if (String(url).endsWith("/models")) return models();
    if (calls++ === 0) return answer();
    await blocked;
    return answer();
  };
  const { app } = await isolatedWorkbench(t, fetcher, {}, {
    prefix: "nomo-spawn-running-cancel-",
    beforeShutdown: release,
  });
  await app.patchHarnessSettings({ maxConcurrentRuns: 1 });
  const parent = await app.start("Parent request", "fixture");
  await app.settled();
  const child = await app.spawnSubagent(parent.id, "Do the delegated task");
  assert.equal(child.status, "running");
  await app.cancelSubagent(parent.id, child.id);
  assert.equal(app.get(child.id)?.state, "stopping");
  await assert.rejects(app.start("Must wait", "fixture"), /Concurrent run limit reached/);
  release();
  await app.settled();
  assert.equal(app.get(child.id)?.state, "stopped");
});
test("restored paused spawned child can be cancelled only with its retained prompt", async (t) => {
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  let providerCalls = 0;
  const fetcher: typeof fetch = async (url) => {
    if (String(url).endsWith("/models")) return models();
    providerCalls++;
    await blocked;
    return answer();
  };
  const f = await isolatedWorkbench(t, fetcher, {}, {
    prefix: "nomo-spawn-restored-cancel-",
    beforeShutdown: release,
  });
  const parent = await f.app.start("Parent request", "fixture");
  const child = await f.app.spawnSubagent(parent.id, "Queued delegated task");
  assert.equal(child.status, "queued");
  const storage = new LocalStorage(f.root);
  const queuedSnapshot = storage.read<Record<string, unknown>>()!;
  f.app.close();
  release();
  await f.app.settled();
  storage.read<Record<string, unknown>>();
  storage.save(queuedSnapshot);
  const restored = f.restart({ keepOpen: true });
  assert.equal(restored.get(child.id)?.status, "paused");
  await restored.cancelSubagent(parent.id, child.id);
  assert.equal(restored.get(child.id)?.status, "cancelled");
  const cancelledSnapshot = storage.read<{
    sessions: Array<{ view: { id: string }; queuedPrompt?: string }>;
  }>()!;
  assert.equal(cancelledSnapshot.sessions.find((item) => item.view.id === child.id)?.queuedPrompt, undefined);
  assert.equal(providerCalls, 1, "restored paused work was not auto-dispatched");
});

test("unknown outcome remains unknown when a spawned child is cancelled", async (t) => {
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  let calls = 0;
  const fetcher: typeof fetch = async (url) => {
    if (String(url).endsWith("/models")) return models();
    if (calls++ === 0) return answer();
    await blocked;
    return answer();
  };
  const { app } = await isolatedWorkbench(t, fetcher, {}, {
    prefix: "nomo-spawn-unknown-",
    beforeShutdown: release,
  });
  await app.patchHarnessSettings({ maxRunTimeoutMs: 1000 });
  const parent = await app.start("Parent request", "fixture");
  await app.settled();
  const child = await app.spawnSubagent(parent.id, "Do the delegated task");
  await app.settled();
  assert.equal(app.get(child.id)?.status, "unknown");
  await assert.rejects(
    app.cancelSubagent(parent.id, child.id),
    /outcome is unresolved/i,
  );
  assert.equal(app.get(child.id)?.status, "unknown");
  release();
});

test("attributed result delivery preserves busy-parent refusal", async (t) => {
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  let calls = 0;
  const fetcher: typeof fetch = async (url) => {
    if (String(url).endsWith("/models")) return models();
    if (calls++ === 2) await blocked;
    return answer();
  };
  const { app } = await isolatedWorkbench(t, fetcher, {}, {
    beforeShutdown: release,
  });
  const parent = await app.start("Parent request", "fixture");
  await app.settled();
  const child = await app.spawnSubagent(parent.id, "Do the delegated task");
  await app.settled();
  const result = (await app.subagentResult(parent.id, child.id))!;
  await app.send(parent.id, "Hold parent");
  await assert.rejects(
    app.deliverSubagentResult(parent.id, child.id, result.runId),
    /not ready/i,
  );
});

test("attributed result delivery refuses content exceeding the prompt bound", async (t) => {
  const oversizedFetcher: typeof fetch = async (url) =>
    String(url).endsWith("/models") ? models() : answer("x".repeat(200));
  const { app } = await isolatedWorkbench(t, oversizedFetcher, {});
  await app.patchHarnessSettings({ maxPromptCharacters: 256 });
  const parent = await app.start("Parent request", "fixture");
  await app.settled();
  const child = await app.spawnSubagent(parent.id, "Do the delegated task");
  await app.settled();
  const result = (await app.subagentResult(parent.id, child.id))!;
  assert.equal(result.truncated, false);
  await assert.rejects(
    app.deliverSubagentResult(parent.id, child.id, result.runId),
    /exceeds the prompt limit/i,
  );
});
test("result delivery rejects a completion that reports tool calls", async (t) => {
  const { app } = await isolatedWorkbench(t, successFetcher, {});
  const parent = await app.start("Parent request", "fixture");
  await app.settled();
  const child = await app.spawnSubagent(parent.id, "Do the delegated task");
  await app.settled();
  const view = app.get(child.id)!;
  const completion = view.events.find(
    (event) =>
      event.runId === view.runId &&
      event.kind === "assistant" &&
      event.type === "message.completed",
  )!;
  completion.payload!.toolCallsPresent = true;
  assert.equal(view.status, "idle");
  assert.equal(await app.subagentResult(parent.id, child.id), undefined);
  await assert.rejects(
    app.deliverSubagentResult(parent.id, child.id, view.runId!),
    /no longer deliverable/i,
  );
});

test("result truncation is fixed at event time even if the prompt limit later grows", async (t) => {
  let calls = 0;
  const fetcher: typeof fetch = async (url) => {
    if (String(url).endsWith("/models")) return models();
    return answer(calls++ === 0 ? "Parent done" : "x".repeat(400));
  };
  const { app } = await isolatedWorkbench(t, fetcher, {});
  await app.patchHarnessSettings({ maxPromptCharacters: 256 });
  const parent = await app.start("Parent request", "fixture");
  await app.settled();
  const child = await app.spawnSubagent(parent.id, "Do the delegated task");
  await app.settled();
  await app.patchHarnessSettings({ maxPromptCharacters: 1000 });
  const result = await app.subagentResult(parent.id, child.id);
  assert.equal(result?.truncated, true);
  await assert.rejects(
    app.deliverSubagentResult(parent.id, child.id, result!.runId),
    /may be truncated/i,
  );
});
test("legacy assistant completion without result metadata fails closed", async (t) => {
  const { app } = await isolatedWorkbench(t, successFetcher, {});
  const parent = await app.start("Parent request", "fixture");
  await app.settled();
  const child = await app.spawnSubagent(parent.id, "Do the delegated task");
  await app.settled();
  const view = app.get(child.id)!;
  const completion = view.events.find(
    (event) =>
      event.runId === view.runId &&
      event.kind === "assistant" &&
      event.type === "message.completed",
  )!;
  delete completion.payload!.toolCallsPresent;
  delete completion.payload!.textTruncated;
  assert.equal(await app.subagentResult(parent.id, child.id), undefined);
  await assert.rejects(
    app.deliverSubagentResult(parent.id, child.id, view.runId!),
    /no longer deliverable/i,
  );
});

test("same-named tools from other connectors are outside the parent's scope", () => {
  const parentTools = [
    { name: "void_workspace_read" },
    { name: "lookup", connectorId: "parent-connector" },
  ];
  const childTools = [
    parentTools[0]!,
    { name: "void_workspace_read", connectorId: "new-connector" },
    parentTools[1]!,
    { name: "lookup", connectorId: "replacement-connector" },
  ];

  assert.deepEqual(subsetTools(childTools, parentTools), [
    childTools[0],
    childTools[2],
  ]);
});

test("spawn excludes a same-named tool from a connector added after the parent", async (t) => {
  const server = await toolCatalogServer("void_workspace_read");
  t.after(() => server.close());
  const { app } = await isolatedWorkbench(t, successFetcher, {});
  const parent = await app.start("Parent request", "fixture");
  await app.settled();

  await app.addConnector({ url: server.url, name: "Late connector" });
  const connectorId = app.connectionState().connectors.at(-1)!.id;
  await app.probeConnector(connectorId);
  await app.confirmConnector(connectorId);
  const child = await app.spawnSubagent(parent.id, "Use only my tools");

  assert.equal(
    app
      .availableTools(child.id)
      .tools.some(
        (tool) =>
          tool.name === "void_workspace_read" &&
          tool.source === connectorId,
      ),
    false,
  );
});

test("spawn preserves the parent's connector snapshot after endpoint replacement", async (t) => {
  const original = await toolCatalogServer("lookup", "Original connector");
  const replacement = await toolCatalogServer("lookup", "Replacement connector");
  t.after(async () => {
    await original.close();
    await replacement.close();
  });
  const { app } = await isolatedWorkbench(t, successFetcher, {});
  await app.addConnector({ url: original.url, name: "Stable connector" });
  const connectorId = app.connectionState().connectors.at(-1)!.id;
  await app.probeConnector(connectorId);
  await app.confirmConnector(connectorId);

  const parent = await app.start("Parent request", "fixture");
  await app.settled();
  await app.updateConnector(connectorId, { url: replacement.url });
  await app.probeConnector(connectorId);
  await app.confirmConnector(connectorId);
  const child = await app.spawnSubagent(parent.id, "Use the inherited connector");

  const tool = app
    .availableTools(child.id)
    .tools.find(
      (item) => item.name === "lookup" && item.source === connectorId,
    );
  assert.equal(tool?.description, "Original connector");
});
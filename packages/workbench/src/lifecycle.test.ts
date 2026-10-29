import test from "node:test";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { isolatedWorkbench } from "./test-fixture.ts";

test("Stop does not release capacity until the original provider settles; shutdown drains it", async (t) => {
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  let calls = 0;
  const { app } = await isolatedWorkbench(t, async (url) => {
    if (String(url).endsWith("/models"))
      return Response.json({ data: [{ id: "fixture" }] });
    calls++;
    await blocked; // Transport may ignore cancellation until it finishes.
    return Response.json({ choices: [{ message: { role: "assistant", content: "Late answer" }, finish_reason: "stop" }] });
  }, {}, { prefix: "nomo-stop-", beforeShutdown: release });
  const session = await app.start("First", "fixture");
  app.cancel(session.id);
  assert.throws(() => app.send(session.id, "Second"), /not ready/);
  await assert.rejects(
    app.start("Other", "fixture"),
    /Concurrent run limit reached/,
  );
  await assert.rejects(
    app.editDocument(session.id, {
      path: "x.md",
      content: "x",
      expectedRevision: null,
    }),
    /stop/,
  );
  release();
  await app.settled();
  assert.equal(calls, 1);
  assert.equal(app.get(session.id)?.status, "cancelled");
  assert.equal(
    app.get(session.id)?.events.some((e) => e.text === "Late answer"),
    false,
  );
  app.send(session.id, "Now continue");
  await app.settled();
  assert.equal(calls, 2);
  assert.equal(app.get(session.id)?.status, "idle");
});
test("background sessions queue behind the active run and drain after settlement", async (t) => {
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  let calls = 0;
  const { app } = await isolatedWorkbench(t, async (url) => {
    if (String(url).endsWith("/models"))
      return Response.json({ data: [{ id: "fixture" }] });
    calls++;
    await blocked;
    return Response.json({ choices: [{ message: { role: "assistant", content: "Done" }, finish_reason: "stop" }] });
  }, {}, { prefix: "nomo-background-", beforeShutdown: release });
  const first = await app.start("First", "fixture");
  const queued = await app.start(
    "Queued",
    "fixture",
    undefined,
    undefined,
    undefined,
    true,
  );
  assert.equal(queued.status, "queued");
  release();
  for (
    let poll = 0;
    poll < 200 && app.get(queued.id)?.status === "queued";
    poll++
  )
    await delay(10);
  await app.settled();
  assert.equal(app.get(queued.id)?.status, "idle");
  assert.equal(calls, 2);
  assert.equal(app.get(first.id)?.status, "idle");
});

test("queued work keeps one run identity and retained prompt without restart dispatch", async (t) => {
  const { LocalStorage } = await import("./storage.ts");
  let release!: () => void,
    calls = 0;
  const requests: Array<{
    url: string;
    authorization: string | null;
    body: {
      messages: Array<{ role: string; content: string }>;
      tools: unknown[];
    };
  }> = [];
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const fetcher: typeof fetch = async (url, init) => {
    if (String(url).endsWith("/models"))
      return Response.json({ data: [{ id: "fixture" }] });
    requests.push({
      url: String(url),
      authorization: new Headers(init?.headers).get("authorization"),
      body: JSON.parse(String(init?.body)),
    });
    calls++;
    await blocked;
    return Response.json({ choices: [{ message: { role: "assistant", content: "Done" }, finish_reason: "stop" }] });
  };
  const f = await isolatedWorkbench(t, fetcher, {}, {
    prefix: "nomo-queued-history-",
    beforeShutdown: release,
  });
  const root = f.root;
  let app = f.app;
  const profile = {
    id: "queued-profile",
    name: "Queued",
    systemPrompt: "Original queued instruction",
    allowedTools: [],
    policyProfile: "default",
    maxTurns: 1,
    maxContextTokens: 20000,
  };
  app.upsertAgent(profile);
  const project = app.upsertProject({
    id: "queued-project",
    name: "Queued project",
    root: "descriptive",
  });
  await app.start("First", "fixture");
  const queued = await app.start(
    "Full queued prompt",
    "fixture",
    undefined,
    project.id,
    profile.id,
    true,
  );
  app.upsertAgent({
    ...profile,
    systemPrompt: "Changed queued instruction",
    allowedTools: ["void_workspace_list"],
  });
  await app.configure({
    baseUrl: "https://changed.test/v1",
    apiKey: "changed-key",
  });
  const queuedRun = app.runs().find((run) => run.sessionId === queued.id);
  assert.ok(queuedRun);
  assert.equal(queuedRun.state, "paused");
  assert.equal(queuedRun.status, "queued");
  assert.equal(
    app.get(queued.id)!.events.filter((event) => event.kind === "user")[0]
      ?.text,
    "Full queued prompt",
  );
  const snapshot = new LocalStorage(root).read<{
    sessions: Array<{ view: { id: string }; queuedPrompt?: string }>;
  }>()!;
  assert.equal(
    snapshot.sessions.find((session) => session.view.id === queued.id)
      ?.queuedPrompt,
    "Full queued prompt",
  );
  release();
  await app.settled();
  await app.settled();
  assert.equal(app.get(queued.id)!.runId, queuedRun.runId);
  assert.equal(
    app.get(queued.id)!.events.filter((event) => event.kind === "user").length,
    1,
  );
  assert.equal(app.get(queued.id)?.project, project.id);
  assert.equal(app.get(queued.id)?.agent, profile.id);
  assert.equal(requests[1]?.url, "https://fixture.test/v1/chat/completions");
  assert.equal(requests[1]?.authorization, "Bearer fixture");
  assert.deepEqual(requests[1]?.body.tools ?? [], []);
  assert.match(
    requests[1]!.body.messages[0]!.content,
    /Original queued instruction/,
  );
  assert.equal(
    requests[1]?.body.messages.at(-1)?.content,
    "Full queued prompt",
  );
  await app.shutdown();
  const storage = new LocalStorage(root);
  storage.read();
  storage.save(snapshot);
  const before = calls;
  // `shutdown` above already persisted and closed, so the reopen must not
  // close a second time.
  app = f.restart({ keepOpen: true });
  assert.equal(app.get(queued.id)!.status, "paused");
  assert.equal(
    app.runs().find((run) => run.sessionId === queued.id)?.state,
    "paused",
  );
  assert.equal(calls, before);
});

test("background queue is bounded and Stop removes only the selected queued session", async (t) => {
  const { capabilities } = await import("./gui.ts");
  let release!: () => void,
    calls = 0;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const { app } = await isolatedWorkbench(t, async (url) => {
    if (String(url).endsWith("/models"))
      return Response.json({ data: [{ id: "fixture" }] });
    calls++;
    await blocked;
    return Response.json({ choices: [{ message: { role: "assistant", content: "Done" }, finish_reason: "stop" }] });
  }, {}, { prefix: "nomo-queue-cap-", beforeShutdown: release });
  const active = await app.start("First", "fixture");
  const cap = (capabilities("local") as { maxQueuedRuns?: number })
    .maxQueuedRuns;
  assert.equal(cap, 20);
  const queued: Array<{ id: string }> = [];
  for (let i = 0; i < cap!; i++)
    queued.push(
      await app.start(
        `Queued ${i}`,
        "fixture",
        undefined,
        undefined,
        undefined,
        true,
      ),
    );
  await assert.rejects(
    app.start(
      "Queue overflow",
      "fixture",
      undefined,
      undefined,
      undefined,
      true,
    ),
    /queue.*full|queue.*limit/i,
  );
  assert.equal(calls, 1);
  assert.equal(app.list().filter((s) => s.status === "queued").length, cap);
  app.cancel(queued[3]!.id);
  assert.equal(app.get(queued[3]!.id)?.status, "cancelled");
  assert.equal(app.get(active.id)?.status, "running");
  assert.equal(
    app.list().filter((s) => s.status === "queued").length,
    cap! - 1,
  );
  assert.equal(
    app.runs().find((run) => run.sessionId === queued[3]!.id)?.state,
    "stopped",
  );
  assert.equal(
    (
      await app.start(
        "Replacement",
        "fixture",
        undefined,
        undefined,
        undefined,
        true,
      )
    ).status,
    "queued",
  );
  app.close();
  release();
  await app.settled();
  assert.equal(calls, 1);
});

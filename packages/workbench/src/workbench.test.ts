import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { NVIDIA_URL } from "./provider-defaults.ts";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { Workbench } from "./index.ts";
import { CompatibleProvider } from "./provider.ts";
import { LocalStorage } from "./storage.ts";
import { readLedgerFeed } from "../../ledger/src/feed.ts";
import { validateAgentProfile, validateHook } from "./agents.ts";

const secret = "fixture-provider-secret";
const reply = (body: unknown) =>
  new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
  });
const root = fileURLToPath(new URL("../../../", import.meta.url));

test("provider rejects direct OpenAI hosts and never echoes upstream error bodies", async () => {
  for (const baseUrl of [
    "https://openai.com/v1",
    "https://api.openai.com/v1",
    "https://sandbox.api.openai.com./v1",
  ])
    assert.throws(
      () => new CompatibleProvider({ baseUrl, apiKey: secret }),
      /Direct OpenAI provider URLs are not supported/,
    );
  const provider = new CompatibleProvider(
    { baseUrl: "https://provider.test/v1", apiKey: secret },
    async () => new Response(secret, { status: 401 }),
  );
  await assert.rejects(
    provider.models(),
    (error) =>
      error instanceof Error &&
      !error.message.includes(secret) &&
      error.message.includes("401"),
  );
});

test("migrates legacy generic provider state to compatible and retires the legacy default model", async () => {
  const dir = await mkdtemp(join(tmpdir(), "void-provider-migration-"));
  const bare = await mkdtemp(join(tmpdir(), "void-provider-migration-bare-"));
  const state = (catalog: Array<{ id: string; name: string }>) => ({
    preferences: { defaultModel: "muse-spark-1.3-contributor-free" },
    config: {
      baseUrl: "https://provider.test/v1",
      apiKey: secret,
      kind: "openai",
    },
    profiles: {
      "https://provider.test/v1": {
        baseUrl: "https://provider.test/v1",
        apiKey: secret,
        kind: "openai",
      },
    },
    catalog,
    connectors: [],
    documents: {},
    evidence: {},
    sessions: [],
  });
  new LocalStorage(dir).save(
    state([
      { id: "z-ai/glm-5.3-free", name: "Retired model" },
      { id: "catalog-model", name: "Catalog model" },
    ]),
  );
  new LocalStorage(bare).save(state([]));
  const workbench = new Workbench({ VOID_DATA_DIR: dir });
  assert.equal((await workbench.providerState()).kind, "compatible");
  // A retired id is replaced from the validated catalog, never by a vendor model.
  assert.equal((await workbench.providerState()).defaultModel, "catalog-model");
  workbench.close();
  const persisted = new LocalStorage(dir).read<{
    preferences: { defaultModel: string };
    config: { kind: string };
    profiles: Record<string, { kind: string }>;
  }>()!;
  assert.equal(persisted.preferences.defaultModel, "catalog-model");
  assert.equal(persisted.config.kind, "compatible");
  assert.equal(persisted.profiles["https://provider.test/v1"]?.kind, "compatible");
  assert.doesNotMatch(JSON.stringify(persisted), /"openai"/);
  // Without a catalog there is no model to re-pick, so the preference is gone.
  const empty = new Workbench({ VOID_DATA_DIR: bare });
  assert.equal((await empty.providerState()).defaultModel, null);
  empty.close();
  assert.equal(
    new LocalStorage(bare).read<{ preferences: Record<string, string> }>()!
      .preferences.defaultModel,
    undefined,
  );
  await rm(dir, { recursive: true, force: true });
  await rm(bare, { recursive: true, force: true });
});

test("model tool calls cross a real VOID proxy and produce a ledger", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "void-agent-beta-"));
  let turn = 0;
  const fetcher: typeof fetch = async (url, options) => {
    assert.equal(
      (options?.headers as Record<string, string>).authorization,
      `Bearer ${secret}`,
    );
    if (String(url).endsWith("/models"))
      return reply({ data: [{ id: "fixture-model" }] });
    const request = JSON.parse(String(options?.body));
    turn++;
    if (turn === 1) {
      const tool = request.tools.find(
        (item: { function: { description: string } }) =>
          item.function.description.startsWith("echo:"),
      );
      const document = request.tools.find(
        (item: { function: { description: string } }) =>
          item.function.description.startsWith("void_workspace_write:"),
      );
      return reply({
        choices: [
          {
            message: {
              role: "assistant",
              content: null,
              tool_calls: [
                {
                  id: "document1",
                  type: "function",
                  function: {
                    name: document.function.name,
                    arguments: JSON.stringify({
                      path: "mixed.md",
                      content: "Managed and stdio in one session.",
                    }),
                  },
                },
                {
                  id: "call1",
                  type: "function",
                  function: {
                    name: tool.function.name,
                    arguments: JSON.stringify({ text: "fixture echo" }),
                  },
                },
              ],
            },
          },
        ],
      });
    }
    assert.equal(request.messages.at(-1).role, "tool");
    return reply({
      choices: [
        { message: { role: "assistant", content: `Finished ${secret}` } },
      ],
      usage: { total_tokens: 23 },
    });
  };
  const workbench = new Workbench(
    {
      VOID_LEDGER_DIR: dir,
      VOID_UPSTREAM_COMMAND: JSON.stringify([
        process.execPath,
        join(root, "fixtures/e2e-server.mjs"),
      ]),
      VOID_POLICY_PATH: join(root, "fixtures/e2e-policy.yaml"),
    },
    fetcher,
  );
  t.after(async () => {
    workbench.close();
    await rm(dir, { recursive: true, force: true });
  });
  await workbench.configure({
    baseUrl: "https://provider.test/v1",
    apiKey: secret,
  });
  const started = await workbench.start("Test echo", "fixture-model");
  for (
    let i = 0;
    i < 200 && workbench.get(started.id)?.status === "running";
    i++
  )
    await delay(20);
  const session = workbench.get(started.id)!;
  assert.equal(session.status, "idle", JSON.stringify(session.events));
  assert.equal(turn, 2);
  assert.ok(!JSON.stringify(session).includes(secret));
  const feed = await readLedgerFeed(join(dir, `${started.workspace}.jsonl`));
  assert.ok(
    feed.records.some(
      (record) => record.tool === "echo" && record.decision.startsWith("allow"),
    ),
  );
  const managed = await workbench.ledger(started.workspace);
  assert.ok(
    managed?.entries.some(
      (e) => (e.body as { tool: string }).tool === "void_workspace_write",
    ),
  );
  assert.ok(
    managed?.entries.some((e) => {
      const b = e.body as { tool: string; source?: string; klass: string };
      return (
        b.tool === "echo" &&
        b.source === "stdio-proxy" &&
        b.klass === feed.records.find((r) => r.tool === "echo")?.klass
      );
    }),
  );
  workbench.cancel(started.id);
  assert.equal(workbench.get(started.id)?.status, "cancelled");
});

test("a destructive model call waits for an operator in its own workspace", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "void-agent-hold-"));
  let turn = 0;
  const workbench = new Workbench(
    {
      VOID_LEDGER_DIR: dir,
      VOID_UPSTREAM_COMMAND: JSON.stringify([
        process.execPath,
        join(root, "fixtures/e2e-server.mjs"),
      ]),
      VOID_POLICY_PATH: join(root, "fixtures/e2e-policy.yaml"),
    },
    async (url, options) => {
      if (String(url).endsWith("/models"))
        return reply({ data: [{ id: "fixture-model" }] });
      if (++turn > 1)
        return reply({
          choices: [
            {
              message: {
                role: "assistant",
                content: "Operator decision received.",
              },
            },
          ],
        });
      const request = JSON.parse(String(options?.body));
      const tool = request.tools.find(
        (item: { function: { description: string } }) =>
          item.function.description.startsWith("orders_delete:"),
      );
      return reply({
        choices: [
          {
            message: {
              role: "assistant",
              content: null,
              tool_calls: [
                {
                  id: "held",
                  type: "function",
                  function: {
                    name: tool.function.name,
                    arguments: '{"where":"id = 1"}',
                  },
                },
              ],
            },
          },
        ],
      });
    },
  );
  t.after(async () => {
    workbench.close();
    await rm(dir, { recursive: true, force: true });
  });
  await workbench.configure({
    baseUrl: "https://provider.test/v1",
    apiKey: secret,
  });
  const session = await workbench.start(
    "Request a destructive fixture",
    "fixture-model",
  );
  for (let i = 0; i < 100 && !workbench.pending().length; i++) await delay(20);
  const hold = workbench.pending()[0]!;
  assert.ok(hold);
  assert.equal(hold.call.workspace, session.workspace);
  assert.equal(turn, 1, "model must wait on VOID approval");
  assert.equal(
    workbench.decide(hold.holdId, { kind: "denied", by: "beta-test" }),
    true,
  );
  for (
    let i = 0;
    i < 100 && workbench.get(session.id)?.status === "running";
    i++
  )
    await delay(20);
  assert.equal(workbench.get(session.id)?.status, "idle");
  const feed = await readLedgerFeed(join(dir, `${session.workspace}.jsonl`));
  assert.ok(feed.records.some((record) => record.decision === "hold:denied"));
});

test("denial text names the rule id, the class and the approval path", async (t) => {
  const { denialText } = await import("./index.ts");
  assert.equal(
    denialText("orders_delete", "r3", {
      kind: "deny",
      ruleIndex: 2,
      rationale: "only fixture tools are allowed",
    }),
    "VOID denied orders_delete (r3) by policy rule 2. Reason: only fixture tools are allowed. Change the connector policy or ask the operator to approve this class. Do not retry with reworded arguments.",
  );
  assert.match(
    denialText("orders_delete", "r3", {
      kind: "hold",
      ruleIndex: 1,
      rationale: "destructive fixture tool requires approval",
    }),
    /by policy rule 1.*operator approval before expiry.*Do not retry/,
  );
  assert.match(
    denialText("x", "r3", { kind: "unmatched" }),
    /no matching policy rule/,
  );
});

test("long sessions keep advancing event cursors and refuse unbounded context", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "void-agent-context-"));
  const fetcher: typeof fetch = async (url) =>
    String(url).endsWith("/models")
      ? reply({ data: [{ id: "fixture-model" }] })
      : reply({
          choices: [
            { message: { role: "assistant", content: "Fixture response" } },
          ],
          usage: { total_tokens: 1 },
        });
  const workbench = new Workbench(
    {
      VOID_LEDGER_DIR: dir,
      VOID_UPSTREAM_COMMAND: JSON.stringify([
        process.execPath,
        join(root, "fixtures/e2e-server.mjs"),
      ]),
      VOID_POLICY_PATH: join(root, "fixtures/e2e-policy.yaml"),
    },
    fetcher,
  );
  t.after(async () => {
    workbench.close();
    await rm(dir, { recursive: true, force: true });
  });
  await workbench.configure({
    baseUrl: "https://provider.test/v1",
    apiKey: secret,
  });
  const started = await workbench.start("First", "fixture-model");
  for (let turn = 0; turn < 99; turn++) {
    for (
      let poll = 0;
      poll < 200 && workbench.get(started.id)?.status === "running";
      poll++
    )
      await delay(10);
    assert.equal(workbench.get(started.id)?.status, "idle");
    if (turn < 98) workbench.send(started.id, `Follow up ${turn}`);
  }
  const events = workbench.get(started.id)!.events;
  assert.equal(
    events.filter((e) => e.type !== "run.status" && e.type !== "harness.review")
      .length,
    297,
  );
  assert.equal(events.filter((e) => e.type === "harness.review").length, 99);
  assert.equal(events[0]!.seq, 1);
  assert.ok(events.at(-1)!.seq > 200);
  assert.throws(
    () => workbench.send(started.id, "Too much context"),
    /context limit/,
  );
});
test("context compaction preserves recent work and records the reduction", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "void-agent-compact-"));
  let lastMessages: Array<{ role: string; content?: string }> = [];
  const workbench = new Workbench(
    { VOID_DATA_DIR: dir },
    async (url, options) => {
      if (String(url).endsWith("/models"))
        return reply({ data: [{ id: "fixture-model" }] });
      const request = JSON.parse(String(options?.body));
      lastMessages = request.messages;
      return reply({
        choices: [
          { message: { role: "assistant", content: "Fixture response" } },
        ],
        usage: { total_tokens: 1 },
      });
    },
  );
  t.after(async () => {
    workbench.close();
    await rm(dir, { recursive: true, force: true });
  });
  await workbench.configure({
    baseUrl: "https://provider.test/v1",
    apiKey: secret,
  });
  const started = await workbench.start(
    "First",
    "fixture-model",
    undefined,
    "VOID project",
  );
  assert.equal(started.project, "VOID project");
  for (let turn = 0; turn < 5; turn++) {
    for (
      let poll = 0;
      poll < 200 && workbench.get(started.id)?.status === "running";
      poll++
    )
      await delay(10);
    assert.equal(workbench.get(started.id)?.status, "idle");
    workbench.send(started.id, `Follow up ${turn}`);
  }
  for (
    let poll = 0;
    poll < 200 && workbench.get(started.id)?.status === "running";
    poll++
  )
    await delay(10);
  const compacted = workbench.compact(started.id);
  assert.ok(compacted.omittedMessageCount > 0);
  assert.ok(compacted.retainedMessageIds.length > 0);
  assert.ok(compacted.summary.length > 0);
  assert.ok(compacted.createdAt.length > 0);
  workbench.send(started.id, "After compaction");
  for (
    let poll = 0;
    poll < 200 && workbench.get(started.id)?.status === "running";
    poll++
  )
    await delay(10);
  assert.equal(workbench.get(started.id)?.status, "idle");
  assert.ok(
    lastMessages.some((message) =>
      message.content?.includes("VOID context summary"),
    ),
  );
});
test("built-in agents change the session instruction without changing provider authority", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "void-agent-presets-"));
  let lastMessages: Array<{ role: string; content?: string }> = [];
  const workbench = new Workbench(
    { VOID_DATA_DIR: dir },
    async (url, options) => {
      if (String(url).endsWith("/models"))
        return reply({ data: [{ id: "fixture-model" }] });
      lastMessages = JSON.parse(String(options?.body)).messages;
      return reply({
        choices: [
          { message: { role: "assistant", content: "Fixture response" } },
        ],
        usage: { total_tokens: 1 },
      });
    },
  );
  t.after(async () => {
    workbench.close();
    await rm(dir, { recursive: true, force: true });
  });
  await workbench.configure({
    baseUrl: "https://provider.test/v1",
    apiKey: secret,
  });
  assert.ok(workbench.agents().agents.some((agent) => agent.id === "reviewer"));
  const started = await workbench.start(
    "Review this",
    "fixture-model",
    undefined,
    undefined,
    "reviewer",
  );
  for (
    let poll = 0;
    poll < 200 && workbench.get(started.id)?.status === "running";
    poll++
  )
    await delay(10);
  assert.equal(workbench.get(started.id)?.status, "idle");
  assert.ok(
    lastMessages.some((message) => message.content?.includes("reviewer")),
  );
});

test("chat catalog excludes embedding, image and video models", async () => {
  const provider = new CompatibleProvider(
    { baseUrl: "https://provider.test/v1", apiKey: secret },
    async () =>
      reply({
        data: [
          { id: "chat", type: "language" },
          { id: "embed", type: "embedding" },
          { id: "video", type: "video" },
          { id: "image", type: "image" },
          { id: "compatible-provider-model" },
        ],
      }),
  );
  assert.deepEqual(
    (await provider.models()).map((model) => model.id),
    ["chat", "compatible-provider-model"],
  );
});

test("NVIDIA is used when its key is in the environment, and its catalog picks the model", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "void-nvidia-env-home-"));
  const dir = await mkdtemp(join(tmpdir(), "void-nvidia-env-data-"));
  const nvidiaKey = "nvapi-fixture-key";
  let seenUrl = "";
  let seenAuth = "";
  const fetcher: typeof fetch = async (url, options) => {
    seenUrl = String(url);
    seenAuth =
      (options?.headers as Record<string, string>)?.authorization ?? "";
    return Response.json({
      data: [{ id: "nvidia-catalog-model", name: "NVIDIA catalog model" }],
    });
  };
  const workbench = new Workbench(
    { HOME: home, VOID_DATA_DIR: dir, NVIDIA_API_KEY: nvidiaKey },
    fetcher,
  );
  t.after(async () => {
    workbench.close();
    await rm(home, { recursive: true, force: true });
    await rm(dir, { recursive: true, force: true });
  });
  const state = await workbench.providerState();
  assert.equal(state.providerId, "nvidia");
  assert.equal(state.connected, true);
  // The validated catalog chooses the model. No vendor model is injected.
  assert.equal(state.defaultModel, "nvidia-catalog-model");
  assert.ok(seenUrl.startsWith(NVIDIA_URL), seenUrl);
  assert.equal(seenAuth, `Bearer ${nvidiaKey}`);
  assert.ok(!JSON.stringify(state).includes(nvidiaKey));
});

test("an unconfigured workspace has no provider and no model, whatever credentials the host holds", async () => {
  for (const env of [{ OPENCODE_ZEN_API_KEY: "legacy-key" }, {}]) {
    const home = await mkdtemp(join(tmpdir(), "void-unconfigured-home-"));
    const dir = await mkdtemp(join(tmpdir(), "void-unconfigured-data-"));
    let calls = 0;
    const fetcher: typeof fetch = async () => {
      calls++;
      throw new Error("must not dispatch anything");
    };
    const workbench = new Workbench(
      { HOME: home, VOID_DATA_DIR: dir, ...env },
      fetcher,
    );
    const state = await workbench.providerState();
    workbench.close();
    assert.equal(state.connected, false);
    assert.equal(state.providerId, null);
    assert.equal(state.defaultModel, null);
    assert.equal(state.setupRequired, true);
    assert.equal(calls, 0);
    await rm(home, { recursive: true, force: true });
    await rm(dir, { recursive: true, force: true });
  }
});

test("providerState returns status detail retryAt per contract", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "void-provider-state-"));
  const workbench = new Workbench({ VOID_DATA_DIR: dir });
  t.after(async () => {
    workbench.close();
    await rm(dir, { recursive: true, force: true });
  });
  const noKey = await workbench.providerState();
  assert.equal(noKey.status, "setup-required");
  assert.ok(noKey.detail !== null);
  assert.equal(noKey.retryAt, null);
  assert.ok(
    !Object.values(noKey).some(
      (v) => typeof v === "string" && v.includes("NVIDIA_API_KEY"),
    ),
    "no key in output",
  );
});

test("projects upsert validation and persistence", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "void-projects-"));
  let wb = new Workbench({ VOID_DATA_DIR: dir });
  t.after(async () => {
    wb.close();
    await rm(dir, { recursive: true, force: true });
  });
  assert.throws(() => wb.upsertProject({ name: "", root: "/x" }), /name/);
  assert.throws(() => wb.upsertProject({ name: "x", root: "" }), /root/);
  const p1 = wb.upsertProject({ name: "Project One", root: "/tmp/one" });
  assert.ok(p1.id);
  assert.equal(p1.name, "Project One");
  assert.equal(p1.root, "/tmp/one");
  const listed = wb.listProjects();
  assert.equal(listed.length, 1);
  assert.equal(listed[0].id, p1.id);
  wb.close();
  wb = new Workbench({ VOID_DATA_DIR: dir });
  const persisted = wb.listProjects();
  assert.equal(persisted.length, 1);
  assert.equal(persisted[0].id, p1.id);
  assert.equal(persisted[0].name, "Project One");
  const p2 = wb.upsertProject({ name: "Project Two", root: "/tmp/one" });
  assert.equal(p2.id, p1.id);
  assert.equal(p2.name, "Project Two");
  assert.equal(wb.listProjects().length, 1);
});

test("runs lists run views from activity", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "void-runs-"));
  const fetcher: typeof fetch = async (url) =>
    String(url).endsWith("/models")
      ? Response.json({ data: [{ id: "test" }] })
      : Response.json({
          choices: [{ message: { role: "assistant", content: "ok" } }],
          usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
        });
  const wb = new Workbench({ VOID_DATA_DIR: dir }, fetcher);
  t.after(async () => {
    wb.close();
    await rm(dir, { recursive: true, force: true });
  });
  await wb.configure({ baseUrl: "https://provider.test/v1", apiKey: "secret" });
  const s1 = await wb.start("First", "test");
  while (wb.get(s1.id)?.status === "running") await delay(5);
  const runs = wb.runs();
  assert.ok(runs.length >= 1);
  const r = runs.find((run) => run.sessionId === s1.id);
  assert.ok(r);
  assert.ok(
    [
      "idle",
      "running",
      "queued",
      "cancelled",
      "failed",
      "stopped",
      "unknown",
      "paused",
    ].includes(r.state),
  );
  assert.ok(typeof r.progress === "number" || r.progress === null);
  assert.ok(typeof r.reconcileRequired === "boolean");
});

test("stopRun cancels running and queued sessions", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "void-stop-run-"));
  let resolveStream: (value: Response) => void;
  const streamPromise = new Promise<Response>((r) => {
    resolveStream = r;
  });
  const fetcher: typeof fetch = async (url) => {
    if (String(url).endsWith("/models"))
      return Response.json({ data: [{ id: "test" }] });
    await streamPromise;
    return Response.json({
      choices: [{ message: { role: "assistant", content: "ok" } }],
      usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
    });
  };
  const wb = new Workbench({ VOID_DATA_DIR: dir }, fetcher);
  t.after(async () => {
    wb.close();
    await rm(dir, { recursive: true, force: true });
  });
  await wb.configure({ baseUrl: "https://provider.test/v1", apiKey: "secret" });
  const s1 = await wb.start("First", "test");
  await delay(5);
  assert.equal(wb.get(s1.id)?.status, "running");
  wb.stopRun(s1.id);
  assert.equal(wb.get(s1.id)?.status, "cancelled");
  resolveStream!(
    Response.json({
      choices: [{ message: { role: "assistant", content: "ok" } }],
      usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
    }),
  );
  assert.throws(() => wb.stopRun("nonexistent"), /not found/);
});

test("agent profile validation rejects invalid input", () => {
  assert.throws(() => validateAgentProfile(null), /not an object/);
  assert.throws(
    () =>
      validateAgentProfile({
        id: "",
        name: "x",
        systemPrompt: "p",
        allowedTools: [],
        policyProfile: "p",
        maxTurns: 1,
        maxContextTokens: 100,
      }),
    /id required/,
  );
  assert.throws(
    () =>
      validateAgentProfile({
        id: "a",
        name: "x",
        systemPrompt: "p",
        allowedTools: "not-array",
        policyProfile: "p",
        maxTurns: 1,
        maxContextTokens: 100,
      }),
    /allowedTools/,
  );
  assert.throws(
    () =>
      validateAgentProfile({
        id: "a",
        name: "x",
        systemPrompt: "p",
        allowedTools: [],
        policyProfile: "",
        maxTurns: 1,
        maxContextTokens: 100,
      }),
    /policyProfile/,
  );
  assert.throws(
    () =>
      validateAgentProfile({
        id: "a",
        name: "x",
        systemPrompt: "p",
        allowedTools: [],
        policyProfile: "p",
        maxTurns: 0,
        maxContextTokens: 100,
      }),
    /maxTurns/,
  );
  assert.throws(
    () =>
      validateAgentProfile({
        id: "a",
        name: "x",
        systemPrompt: "p",
        allowedTools: [],
        policyProfile: "p",
        maxTurns: 1,
        maxContextTokens: -1,
      }),
    /maxContextTokens/,
  );
  const ok = validateAgentProfile({
    id: "a",
    name: "Agent A",
    systemPrompt: "p",
    allowedTools: ["echo"],
    policyProfile: "strict",
    maxTurns: 10,
    maxContextTokens: 8000,
  });
  assert.equal(ok.id, "a");
  assert.equal(ok.allowedTools.length, 1);
});

test("hook validation refuses commands not on allowlist", () => {
  assert.throws(
    () =>
      validateHook({
        id: "h",
        event: "before-run",
        command: "rm -rf",
        enabled: true,
      }),
    /not on operator allowlist/,
  );
  assert.throws(
    () =>
      validateHook({
        id: "h",
        event: "invalid",
        command: "echo",
        enabled: true,
      }),
    /event must be/,
  );
  const ok = validateHook({
    id: "h",
    event: "after-tool",
    command: "echo done",
    enabled: true,
  }, ["echo done"]);
  assert.equal(ok.command, "echo done");
  assert.equal(ok.enabled, true);
});

test("compaction returns CompactionResult shape", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "void-compaction-shape-"));
  const fetcher: typeof fetch = async (url) =>
    String(url).endsWith("/models")
      ? Response.json({ data: [{ id: "test" }] })
      : Response.json({
          choices: [{ message: { role: "assistant", content: "response" } }],
          usage: { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 },
        });
  const wb = new Workbench({ VOID_DATA_DIR: dir }, fetcher);
  t.after(async () => {
    wb.close();
    await rm(dir, { recursive: true, force: true });
  });
  await wb.configure({ baseUrl: "https://provider.test/v1", apiKey: "secret" });
  const s = await wb.start("First message", "test");
  while (wb.get(s.id)?.status === "running") await delay(5);
  wb.send(s.id, "Second message");
  while (wb.get(s.id)?.status === "running") await delay(5);
  wb.send(s.id, "Third message");
  while (wb.get(s.id)?.status === "running") await delay(5);
  const result = wb.compact(s.id);
  assert.ok(typeof result.summary === "string");
  assert.ok(Array.isArray(result.retainedMessageIds));
  assert.ok(typeof result.omittedMessageCount === "number");
  assert.ok(typeof result.createdAt === "string");
  assert.ok(result.omittedMessageCount >= 0);
});

test("provider logout removes credentials from every profile and historical session", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "void-provider-logout-"));
  let afterLogout = false;
  let callsAfterLogout = 0;
  const fetcher: typeof fetch = async (url) => {
    if (afterLogout) callsAfterLogout++;
    return String(url).endsWith("/models")
      ? Response.json({ data: [{ id: "test", name: "Test" }] })
      : Response.json({ choices: [{ message: { role: "assistant", content: "ok" } }] });
  };
  const workbenches: Workbench[] = [];
  const createWorkbench = () => {
    const workbench = new Workbench({ VOID_DATA_DIR: dir }, fetcher);
    workbenches.push(workbench);
    return workbench;
  };
  t.after(async () => {
    for (const workbench of workbenches) workbench.close();
    await rm(dir, { recursive: true, force: true });
  });

  const workbench = createWorkbench();
  await workbench.configure({ baseUrl: "https://first.test/v1", apiKey: "first-fixture-key" });
  const session = await workbench.start("Keep this conversation", "test");
  while (workbench.get(session.id)?.status === "running") await delay(5);
  const activeState = new LocalStorage(dir).read<Record<string, unknown>>()!;
  assert.doesNotMatch(JSON.stringify(activeState.sessions), /first-fixture-key/);
  assert.deepEqual(
    (activeState.sessions as Array<{ config?: unknown }>)[0]?.config,
    { baseUrl: "https://first.test/v1", kind: "compatible" },
  );
  await workbench.configure({ baseUrl: "https://second.test/v1", apiKey: "second-fixture-key" });

  workbench.clearProvider();
  afterLogout = true;
  const persisted = new LocalStorage(dir).read<Record<string, unknown>>()!;
  assert.deepEqual(persisted.profiles, {});
  assert.deepEqual(
    (persisted.sessions as Array<{ config?: unknown }>)[0]?.config,
    { baseUrl: "https://first.test/v1", kind: "compatible" },
  );
  assert.doesNotMatch(JSON.stringify(persisted), /first-fixture-key|second-fixture-key/);

  let sendError: unknown;
  try {
    workbench.send(session.id, "Continue after logout");
  } catch (error) {
    sendError = error;
  }
  while (workbench.get(session.id)?.status === "running") await delay(5);
  assert.ok(sendError instanceof Error);
  assert.match(sendError.message, /provider/i);
  assert.equal(callsAfterLogout, 0);

  workbench.close();
  workbenches.splice(workbenches.indexOf(workbench), 1);
  const reopened = createWorkbench();
  let reopenedError: unknown;
  try {
    reopened.send(session.id, "Continue after restart");
  } catch (error) {
    reopenedError = error;
  }
  while (reopened.get(session.id)?.status === "running") await delay(5);
  assert.ok(reopenedError instanceof Error);
  assert.match(reopenedError.message, /provider/i);
  assert.equal(callsAfterLogout, 0);
});

test("provider reauthentication matches both endpoint and kind", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "void-provider-reauth-kind-"));
  let afterLogout = false;
  let completionsAfterLogout = 0;
  const fetcher: typeof fetch = async (url) => {
    if (!String(url).endsWith("/models")) {
      if (afterLogout) completionsAfterLogout++;
      return Response.json({ choices: [{ message: { role: "assistant", content: "ok" } }] });
    }
    return Response.json({ data: [{ id: "test", name: "Test" }] });
  };
  const workbench = new Workbench({ VOID_DATA_DIR: dir }, fetcher);
  t.after(async () => {
    workbench.close();
    await rm(dir, { recursive: true, force: true });
  });

  await workbench.configure({ baseUrl: "https://same.test/v1", kind: "compatible", apiKey: "first-fixture-key" });
  const session = await workbench.start("Keep this history", "test");
  while (workbench.get(session.id)?.status === "running") await delay(5);
  workbench.clearProvider();
  afterLogout = true;

  await workbench.configure({ baseUrl: "https://same.test/v1", kind: "anthropic", apiKey: "other-kind-fixture-key" });
  assert.throws(() => workbench.send(session.id, "Do not change protocol"), /provider/i);
  assert.equal(completionsAfterLogout, 0);

  await workbench.configure({ baseUrl: "https://same.test/v1", kind: "compatible", apiKey: "new-fixture-key" });
  workbench.send(session.id, "Resume with the matching provider");
  while (workbench.get(session.id)?.status === "running") await delay(5);
  assert.equal(completionsAfterLogout, 1);
});

test("provider logout suppresses environment reconnect until explicit login", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "void-provider-environment-logout-"));
  const env = { VOID_DATA_DIR: dir, NVIDIA_API_KEY: "nvidia-fixture-key" };
  let afterLogout = false;
  let callsAfterLogout = 0;
  const fetcher: typeof fetch = async (url) => {
    if (afterLogout) callsAfterLogout++;
    return String(url).endsWith("/models")
      ? Response.json({ data: [{ id: "test", name: "Test" }] })
      : Response.json({ choices: [{ message: { role: "assistant", content: "ok" } }] });
  };
  const workbenches: Workbench[] = [];
  const createWorkbench = () => {
    const workbench = new Workbench(env, fetcher);
    workbenches.push(workbench);
    return workbench;
  };
  t.after(async () => {
    for (const workbench of workbenches) workbench.close();
    await rm(dir, { recursive: true, force: true });
  });

  const workbench = createWorkbench();
  assert.equal((await workbench.providerState()).connected, true);
  workbench.clearProvider();
  afterLogout = true;
  const persisted = new LocalStorage(dir).read<Record<string, unknown>>()!;
  assert.equal(persisted.ignoreEnvironment, true);
  assert.equal(persisted.config, undefined);
  assert.deepEqual(persisted.profiles, {});
  workbench.close();
  workbenches.splice(workbenches.indexOf(workbench), 1);

  const reopened = createWorkbench();
  assert.equal((await reopened.providerState()).connected, false);
  assert.equal(callsAfterLogout, 0);
  assert.equal((await reopened.providerState({ reconnectEnvironment: true })).connected, true);
  assert.equal(callsAfterLogout, 1);
});

test("provider logout waits for a manual provider catalog probe", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "void-provider-pending-logout-"));
  let holdModels = false;
  let completions = 0;
  let markRequested: () => void = () => {};
  let finishModels: (response: Response) => void = () => {};
  let configuration: ReturnType<Workbench["configure"]> | undefined;
  let queuedStart: ReturnType<Workbench["start"]> | undefined;
  const requested = new Promise<void>((resolve) => { markRequested = resolve; });
  const pendingModels = new Promise<Response>((resolve) => { finishModels = resolve; });
  const fetcher: typeof fetch = async (url) => {
    if (String(url).endsWith("/models")) {
      if (holdModels) {
        markRequested();
        return pendingModels;
      }
      return Response.json({ data: [{ id: "test", name: "Test" }] });
    }
    completions++;
    return Response.json({ choices: [{ message: { role: "assistant", content: "ok" } }] });
  };
  const workbench = new Workbench({ VOID_DATA_DIR: dir }, fetcher);
  t.after(async () => {
    finishModels(Response.json({ data: [{ id: "test", name: "Test" }] }));
    await configuration?.catch(() => {});
    await queuedStart?.catch(() => {});
    workbench.close();
    await rm(dir, { recursive: true, force: true });
  });

  await workbench.configure({ baseUrl: "https://initial.test/v1", apiKey: "initial-fixture-key" });
  holdModels = true;
  configuration = workbench.configure({ baseUrl: "https://pending.test/v1", apiKey: "pending-fixture-key" });
  queuedStart = configuration.then(() => workbench.start("Start after catalog validation", "test"));
  await requested;
  await assert.rejects(workbench.start("Do not race providers", "test"), /provider setup/i);
  assert.throws(() => workbench.clearProvider(), /provider setup/i);
  finishModels(Response.json({ data: [{ id: "test", name: "Test" }] }));
  await configuration;
  const session = await queuedStart!;
  while (workbench.get(session.id)?.status === "running") await delay(5);
  assert.equal((await workbench.providerState()).connected, true);
  assert.equal(completions, 1);
  workbench.clearProvider();
  assert.equal((await workbench.providerState()).connected, false);
  const persisted = new LocalStorage(dir).read<Record<string, unknown>>()!;
  assert.equal(persisted.config, undefined);
  assert.deepEqual(persisted.profiles, {});
  assert.doesNotMatch(JSON.stringify(persisted), /pending-fixture-key/);
});

test("a failed provider catalog probe does not keep logout blocked", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "void-provider-failed-setup-"));
  const fetcher: typeof fetch = async () => { throw new Error("fixture connection failure"); };
  const workbench = new Workbench({ VOID_DATA_DIR: dir }, fetcher);
  t.after(async () => {
    workbench.close();
    await rm(dir, { recursive: true, force: true });
  });

  await assert.rejects(
    workbench.configure({ baseUrl: "https://failed.test/v1", apiKey: "failed-fixture-key" }),
    /Provider connection failed/,
  );
  assert.doesNotThrow(() => workbench.clearProvider());
  assert.equal((await workbench.providerState()).connected, false);
});

test("provider logout waits for the automatic environment catalog probe", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "void-provider-environment-race-"));
  const env = { VOID_DATA_DIR: dir, NVIDIA_API_KEY: "nvidia-race-fixture-key" };
  let markRequested: () => void = () => {};
  let finishModels: (response: Response) => void = () => {};
  const requested = new Promise<void>((resolve) => { markRequested = resolve; });
  const pendingModels = new Promise<Response>((resolve) => { finishModels = resolve; });
  const fetcher: typeof fetch = async (url) => {
    if (String(url).endsWith("/models")) {
      markRequested();
      return pendingModels;
    }
    return Response.json({ choices: [{ message: { role: "assistant", content: "ok" } }] });
  };
  const workbench = new Workbench(env, fetcher);
  t.after(async () => {
    workbench.close();
    await rm(dir, { recursive: true, force: true });
  });

  const pendingState = workbench.providerState();
  await requested;
  assert.throws(() => workbench.clearProvider(), /provider setup/i);
  finishModels(Response.json({ data: [{ id: "test", name: "Test" }] }));
  assert.equal((await pendingState).connected, true);
  workbench.clearProvider();
  assert.equal((await workbench.providerState()).connected, false);
});

test("a superseded environment probe does not mark the replacement unavailable", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "void-provider-superseded-setup-"));
  const env = { VOID_DATA_DIR: dir, NVIDIA_API_KEY: "nvidia-superseded-fixture-key" };
  let markRequested: () => void = () => {};
  let finishModels: (response: Response) => void = () => {};
  const requested = new Promise<void>((resolve) => { markRequested = resolve; });
  const pendingModels = new Promise<Response>((resolve) => { finishModels = resolve; });
  const fetcher: typeof fetch = async (url) => {
    if (String(url).startsWith("https://integrate.api.nvidia.com/v1/models")) {
      markRequested();
      return pendingModels;
    }
    return Response.json({ data: [{ id: "test", name: "Test" }] });
  };
  const workbench = new Workbench(env, fetcher);
  t.after(async () => {
    workbench.close();
    await rm(dir, { recursive: true, force: true });
  });

  const automaticState = workbench.providerState();
  await requested;
  await workbench.configure({ baseUrl: "https://replacement.test/v1", apiKey: "replacement-fixture-key" });
  finishModels(Response.json({ data: [{ id: "test", name: "Test" }] }));
  const state = await automaticState;
  assert.equal(state.connected, true);
  assert.equal(state.status, "ready");
  assert.equal(state.baseUrl, "https://replacement.test/v1");
});

test("provider logout keeps the connected state when persistence fails", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "void-provider-logout-storage-conflict-"));
  const fetcher: typeof fetch = async (url) => String(url).endsWith("/models")
    ? Response.json({ data: [{ id: "test", name: "Test" }] })
    : Response.json({ choices: [{ message: { role: "assistant", content: "ok" } }] });
  const workbench = new Workbench({ VOID_DATA_DIR: dir }, fetcher);
  t.after(async () => {
    try { workbench.close(); } catch {}
    await rm(dir, { recursive: true, force: true });
  });

  await workbench.configure({ baseUrl: "https://rollback.test/v1", apiKey: "rollback-fixture-key" });
  const externalStorage = new LocalStorage(dir);
  const saved = externalStorage.read<Record<string, unknown>>()!;
  externalStorage.save({ ...saved, externalUpdate: true });
  assert.throws(() => workbench.clearProvider(), /Workspace changed/);
  const state = await workbench.providerState();
  assert.equal(state.connected, true);
  assert.ok(state.profiles.includes("https://rollback.test/v1"));
});

test("provider logout refuses while a session is connecting its MCP tools", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "void-provider-start-"));
  const originalFetch = globalThis.fetch;
  let completions = 0;
  let holdToolsList = false;
  let failToolsList = false;
  let markToolsListStarted!: () => void;
  let releaseToolsList!: () => void;
  const toolsListStarted = new Promise<void>((resolve) => { markToolsListStarted = resolve; });
  const toolsListGate = new Promise<void>((resolve) => { releaseToolsList = resolve; });
  globalThis.fetch = async (_url, init) => {
    const request = JSON.parse(String(init?.body)) as { id?: string; method: string };
    if (request.method === "tools/list" && holdToolsList) {
      holdToolsList = false;
      markToolsListStarted();
      await toolsListGate;
    }
    if (request.method === "tools/list" && failToolsList) {
      failToolsList = false;
      return Response.json({ jsonrpc: "2.0", id: request.id, error: { code: -32000, message: "fixture" } });
    }
    return Response.json({
      jsonrpc: "2.0",
      id: request.id,
      result: request.method === "initialize"
        ? { protocolVersion: "2025-03-26", capabilities: {}, serverInfo: { name: "test", version: "1" } }
        : { tools: [] },
    });
  };
  const workbench = new Workbench({ VOID_DATA_DIR: dir }, async (url) => {
    if (String(url).endsWith("/models"))
      return Response.json({ data: [{ id: "test", name: "Test" }] });
    completions++;
    return Response.json({ choices: [{ message: { role: "assistant", content: "ok" } }] });
  });
  t.after(async () => {
    releaseToolsList();
    globalThis.fetch = originalFetch;
    workbench.close();
    await rm(dir, { recursive: true, force: true });
  });
  await workbench.configure({ baseUrl: "https://provider.test/v1", apiKey: "fixture-key" });
  await workbench.addConnector({ url: "https://mcp.test/mcp", name: "Slow catalog" });
  // A staged connector is never contacted, so this session only reaches the
  // server because the operator probed and confirmed it first.
  const connector = workbench.connectionState().connectors.at(-1)!.id;
  await workbench.probeConnector(connector);
  await workbench.confirmConnector(connector);

  holdToolsList = true;
  const starting = workbench.start("Wait for tools", "test");
  await toolsListStarted;
  assert.throws(() => workbench.clearProvider(), /startup|setup/i);
  await workbench.configure({ baseUrl: "https://replacement.test/v1", apiKey: "replacement-fixture-key" });
  releaseToolsList();
  await assert.rejects(starting, /Provider changed while connecting tools/);
  assert.equal(completions, 0);

  failToolsList = true;
  await assert.rejects(workbench.start("Reject the broken tools", "test"), /MCP request failed/);
  assert.equal(completions, 0);
  workbench.clearProvider();
});

test("provider logout refuses while a model run is active", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "void-provider-active-logout-"));
  let markRequested: () => void = () => {};
  let finishResponse: (response: Response) => void = () => {};
  const requested = new Promise<void>((resolve) => { markRequested = resolve; });
  const pendingResponse = new Promise<Response>((resolve) => { finishResponse = resolve; });
  const fetcher: typeof fetch = async (url) => {
    if (String(url).endsWith("/models")) return Response.json({ data: [{ id: "test", name: "Test" }] });
    markRequested();
    return pendingResponse;
  };
  const workbench = new Workbench({ VOID_DATA_DIR: dir }, fetcher);
  t.after(async () => {
    workbench.close();
    await rm(dir, { recursive: true, force: true });
  });

  await workbench.configure({ baseUrl: "https://active.test/v1", apiKey: "active-fixture-key" });
  const session = await workbench.start("Wait for the provider", "test");
  await requested;
  assert.throws(() => workbench.clearProvider(), /Stop active sessions/);
  assert.equal((await workbench.providerState()).connected, true);
  finishResponse(Response.json({ choices: [{ message: { role: "assistant", content: "ok" } }] }));
  while (workbench.get(session.id)?.status === "running") await delay(5);
  workbench.clearProvider();
  assert.equal((await workbench.providerState()).connected, false);
});

test("legacy history without a recognized provider kind cannot resume by guessing", async (t) => {
  const baseUrl = "https://unknown-kind.test/v1";
  let completions = 0;
  const fetcher: typeof fetch = async (url) => {
    if (String(url).endsWith("/models"))
      return Response.json({ data: [{ id: "test", name: "Test" }] });
    completions++;
    return Response.json({ choices: [{ message: { role: "assistant", content: "ok" } }] });
  };
  const legacyConfigs: Array<{ label: string; config: { baseUrl: string; kind?: string } }> = [
    { label: "missing", config: { baseUrl } },
    { label: "unknown", config: { baseUrl, kind: "future-protocol" } },
  ];

  for (const legacy of legacyConfigs) {
    const dir = await mkdtemp(join(tmpdir(), `void-provider-${legacy.label}-kind-`));
    const original = new Workbench({ VOID_DATA_DIR: dir }, fetcher);
    let originalClosed = false;
    let reopened: Workbench | undefined;
    t.after(async () => {
      if (!originalClosed) original.close();
      reopened?.close();
      await rm(dir, { recursive: true, force: true });
    });
    await original.configure({ baseUrl, kind: "compatible", apiKey: "old-fixture-key" });
    const session = await original.start("Keep the transcript", "test");
    while (original.get(session.id)?.status === "running") await delay(5);
    original.close();
    originalClosed = true;

    type StoredSession = { config?: unknown; view: Record<string, unknown> };
    const storage = new LocalStorage(dir);
    const saved = storage.read<{ sessions: StoredSession[]; [key: string]: unknown }>()!;
    saved.sessions[0].config = legacy.config;
    storage.save(saved);
    const completionsBeforeResume = completions;
    reopened = new Workbench({ VOID_DATA_DIR: dir }, fetcher);
    assert.throws(() => reopened.send(session.id, "Do not switch protocol"), /provider|protocol/i);
    assert.equal(completions, completionsBeforeResume);
  }
});


test("legacy inline provider keys are scrubbed without borrowing another provider", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "void-provider-legacy-session-"));
  let requestCount = 0;
  const fetcher: typeof fetch = async (url) => {
    requestCount++;
    return String(url).endsWith("/models")
      ? Response.json({ data: [{ id: "test", name: "Test" }] })
      : Response.json({ choices: [{ message: { role: "assistant", content: "ok" } }] });
  };
  const original = new Workbench({ VOID_DATA_DIR: dir }, fetcher);
  let originalClosed = false;
  let reopened: Workbench | undefined;
  t.after(async () => {
    if (!originalClosed) original.close();
    reopened?.close();
    await rm(dir, { recursive: true, force: true });
  });
  await original.configure({ baseUrl: "https://current.test/v1", apiKey: "current-fixture-key" });
  const session = await original.start("Preserve the history", "test");
  while (original.get(session.id)?.status === "running") await delay(5);
  original.close();
  originalClosed = true;

  type StoredSession = { config?: { baseUrl: string; apiKey: string; kind?: string }; view: Record<string, unknown> };
  const storage = new LocalStorage(dir);
  const saved = storage.read<{ sessions: StoredSession[]; [key: string]: unknown }>()!;
  for (const item of saved.sessions) {
    item.config = { baseUrl: "https://legacy.test/v1", apiKey: "legacy-fixture-key", kind: "openai" };
    item.view.provider = "https://legacy.test/v1";
  }
  storage.save(saved);
  const requestsBeforeResume = requestCount;
  reopened = new Workbench({ VOID_DATA_DIR: dir }, fetcher);
  const migrated = new LocalStorage(dir).read<{ sessions: StoredSession[] }>()!;
  assert.doesNotMatch(JSON.stringify(migrated.sessions), /legacy-fixture-key/);
  assert.deepEqual(migrated.sessions[0].config, {
    baseUrl: "https://legacy.test/v1",
    kind: "compatible",
  });
  assert.equal(migrated.sessions[0].view.provider, "https://legacy.test/v1");

  let sendError: unknown;
  try {
    reopened.send(session.id, "Do not switch providers silently");
  } catch (error) {
    sendError = error;
  }
  assert.ok(sendError instanceof Error);
  assert.match(sendError.message, /provider/i);
  assert.equal(requestCount, requestsBeforeResume);
});

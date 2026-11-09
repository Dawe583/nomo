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
import { canonicalJson, entryHash, GENESIS_PREV } from "../../ledger/src/canonical.ts";
import { signingPreimage } from "../../ledger/src/index.ts";
import type { JsonlEntry } from "../../ledger/src/store.ts";
import { devKeyProvider, sha256Hex } from "../../ledger/src/sign.ts";
import { mineLearnedRules } from "./learned-rules.ts";
import { validateAgentProfile, validateHook } from "./agents.ts";
import { assertIsolated, isolatedWorkbench } from "./test-fixture.ts";

const secret = "fixture-provider-secret";
const reply = (body: unknown) =>
  new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
  });
const root = fileURLToPath(new URL("../../../", import.meta.url));
/**
 * `Workbench` roots its store at `NOMO_DATA_DIR ?? join(NOMO_LEDGER_DIR ??
 * homedir()/".void", "workbench")`. The proxy tests below set only
 * `NOMO_LEDGER_DIR`, because that is the variable the signed JSONL chain
 * reads, so their store lands one level below the ledger directory rather
 * than at it. Asserting there is what proves the temporary tree was used
 * instead of the operator's real home.
 */
const storeDirUnder = (ledgerDir: string) => join(ledgerDir, "workbench");

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
  const dir = await mkdtemp(join(tmpdir(), "nomo-provider-migration-"));
  const bare = await mkdtemp(join(tmpdir(), "nomo-provider-migration-bare-"));
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
  const migrationEnv = { NOMO_DATA_DIR: dir };
  const workbench = new Workbench(migrationEnv);
  // Deliberately not the shared fixture: the point of this test is that a
  // workbench reads back state a hand-built `LocalStorage` wrote into this
  // same directory, so the fixture's own construction would be the assertion.
  assertIsolated(dir, migrationEnv);
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
  const bareEnv = { NOMO_DATA_DIR: bare };
  const empty = new Workbench(bareEnv);
  assertIsolated(bare, bareEnv);
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

test("model tool calls cross a real NOMO proxy and produce a ledger", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "nomo-agent-beta-"));
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
  const proxyEnv = {
    NOMO_LEDGER_DIR: dir,
    NOMO_UPSTREAM_COMMAND: JSON.stringify([
      process.execPath,
      join(root, "fixtures/e2e-server.mjs"),
    ]),
    NOMO_POLICY_PATH: join(root, "fixtures/e2e-policy.yaml"),
  };
  const workbench = new Workbench(proxyEnv, fetcher);
  // `NOMO_LEDGER_DIR`, not `NOMO_DATA_DIR`: the assertions below read the
  // signed feed at `join(dir, "<workspace>.jsonl")`, so this stays a direct
  // construction with the isolation assertion attached.
  assertIsolated(storeDirUnder(dir), proxyEnv);
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
  const dir = await mkdtemp(join(tmpdir(), "nomo-agent-hold-"));
  let turn = 0;
  const proxyEnv = {
    NOMO_LEDGER_DIR: dir,
    NOMO_UPSTREAM_COMMAND: JSON.stringify([
      process.execPath,
      join(root, "fixtures/e2e-server.mjs"),
    ]),
    NOMO_POLICY_PATH: join(root, "fixtures/e2e-policy.yaml"),
  };
  const workbench = new Workbench(
    proxyEnv,
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
  assertIsolated(storeDirUnder(dir), proxyEnv);
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
  assert.equal(turn, 1, "model must wait on NOMO approval");
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
    "NOMO denied orders_delete (r3) by policy rule 2. Reason: only fixture tools are allowed. Change the connector policy or ask the operator to approve this class. Do not retry with reworded arguments.",
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
  const dir = await mkdtemp(join(tmpdir(), "nomo-agent-context-"));
  const fetcher: typeof fetch = async (url) =>
    String(url).endsWith("/models")
      ? reply({ data: [{ id: "fixture-model" }] })
      : reply({
          choices: [
            { message: { role: "assistant", content: "Fixture response" } },
          ],
          usage: { total_tokens: 1 },
        });
  const proxyEnv = {
    NOMO_LEDGER_DIR: dir,
    NOMO_UPSTREAM_COMMAND: JSON.stringify([
      process.execPath,
      join(root, "fixtures/e2e-server.mjs"),
    ]),
    NOMO_POLICY_PATH: join(root, "fixtures/e2e-policy.yaml"),
  };
  const workbench = new Workbench(proxyEnv, fetcher);
  assertIsolated(storeDirUnder(dir), proxyEnv);
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
  let lastMessages: Array<{ role: string; content?: string }> = [];
  const f = await isolatedWorkbench(
    t,
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
    {},
    { prefix: "nomo-agent-compact-", configure: false },
  );
  const workbench = f.app;
  await workbench.configure({
    baseUrl: "https://provider.test/v1",
    apiKey: secret,
  });
  const started = await workbench.start(
    "First",
    "fixture-model",
    undefined,
    "NOMO project",
  );
  assert.equal(started.project, "NOMO project");
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
      message.content?.includes("NOMO context summary"),
    ),
  );
});
test("built-in agents change the session instruction without changing provider authority", async (t) => {
  let lastMessages: Array<{ role: string; content?: string }> = [];
  const f = await isolatedWorkbench(
    t,
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
    {},
    { prefix: "nomo-agent-presets-", configure: false },
  );
  const workbench = f.app;
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
  const home = await mkdtemp(join(tmpdir(), "nomo-nvidia-env-home-"));
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
  // `configure: false`: the assertions are about the provider the operator's
  // own environment selects, and a fixture-supplied configuration would be a
  // different provider than the one under test.
  const f = await isolatedWorkbench(
    t,
    fetcher,
    { HOME: home, NVIDIA_API_KEY: nvidiaKey },
    { prefix: "nomo-nvidia-env-data-", configure: false },
  );
  t.after(() => rm(home, { recursive: true, force: true }));
  const workbench = f.app;
  const state = await workbench.providerState();
  assert.equal(state.providerId, "nvidia");
  assert.equal(state.connected, true);
  // The validated catalog chooses the model. No vendor model is injected.
  assert.equal(state.defaultModel, "nvidia-catalog-model");
  assert.ok(seenUrl.startsWith(NVIDIA_URL), seenUrl);
  assert.equal(seenAuth, `Bearer ${nvidiaKey}`);
  assert.ok(!JSON.stringify(state).includes(nvidiaKey));
});

test("an unconfigured workspace has no provider and no model, whatever credentials the host holds", async (t) => {
  for (const env of [{ OPENCODE_ZEN_API_KEY: "legacy-key" }, {}] as Record<string, string>[]) {
    const home = await mkdtemp(join(tmpdir(), "nomo-unconfigured-home-"));
    let calls = 0;
    const fetcher: typeof fetch = async () => {
      calls++;
      throw new Error("must not dispatch anything");
    };
    const f = await isolatedWorkbench(
      t,
      fetcher,
      { HOME: home, ...env },
      { prefix: "nomo-unconfigured-data-", configure: false },
    );
    const workbench = f.app;
    const state = await workbench.providerState();
    workbench.close();
    assert.equal(state.connected, false);
    assert.equal(state.providerId, null);
    assert.equal(state.defaultModel, null);
    assert.equal(state.setupRequired, true);
    assert.equal(calls, 0);
    await rm(home, { recursive: true, force: true });
  }
});

test("providerState returns status detail retryAt per contract", async (t) => {
  const f = await isolatedWorkbench(t, undefined, {}, {
    prefix: "nomo-provider-state-",
    configure: false,
  });
  const workbench = f.app;
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
  const f = await isolatedWorkbench(t, undefined, {}, {
    prefix: "nomo-projects-",
    configure: false,
  });
  let wb = f.app;
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
  wb = f.restart({ keepOpen: true });
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
  const fetcher: typeof fetch = async (url) =>
    String(url).endsWith("/models")
      ? Response.json({ data: [{ id: "test" }] })
      : Response.json({
          choices: [{ message: { role: "assistant", content: "ok" } }],
          usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
        });
  const f = await isolatedWorkbench(t, fetcher, {}, {
    prefix: "nomo-runs-",
    configure: false,
  });
  const wb = f.app;
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
  // The run is parked on `streamPromise` until the assertions release it.
  // `shutdown` waits on live runs where the plain `close` did not, so the
  // release is repeated here: a test that fails before reaching it would
  // otherwise hang in cleanup instead of reporting its own failure.
  const f = await isolatedWorkbench(t, fetcher, {}, {
    prefix: "nomo-stop-run-",
    configure: false,
    beforeShutdown: () =>
      resolveStream!(
        Response.json({
          choices: [{ message: { role: "assistant", content: "ok" } }],
          usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
        }),
      ),
  });
  const wb = f.app;
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
  const fetcher: typeof fetch = async (url) =>
    String(url).endsWith("/models")
      ? Response.json({ data: [{ id: "test" }] })
      : Response.json({
          choices: [{ message: { role: "assistant", content: "response" } }],
          usage: { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 },
        });
  const f = await isolatedWorkbench(t, fetcher, {}, {
    prefix: "nomo-compaction-shape-",
    configure: false,
  });
  const wb = f.app;
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
  let afterLogout = false;
  let callsAfterLogout = 0;
  const fetcher: typeof fetch = async (url) => {
    if (afterLogout) callsAfterLogout++;
    return String(url).endsWith("/models")
      ? Response.json({ data: [{ id: "test", name: "Test" }] })
      : Response.json({ choices: [{ message: { role: "assistant", content: "ok" } }] });
  };
  const f = await isolatedWorkbench(t, fetcher, {}, {
    prefix: "nomo-provider-logout-",
    configure: false,
  });
  const workbench = f.app;
  await workbench.configure({ baseUrl: "https://first.test/v1", apiKey: "first-fixture-key" });
  const session = await workbench.start("Keep this conversation", "test");
  while (workbench.get(session.id)?.status === "running") await delay(5);
  const activeState = new LocalStorage(f.root).read<Record<string, unknown>>()!;
  assert.doesNotMatch(JSON.stringify(activeState.sessions), /first-fixture-key/);
  assert.deepEqual(
    (activeState.sessions as Array<{ config?: unknown }>)[0]?.config,
    { baseUrl: "https://first.test/v1", kind: "compatible" },
  );
  await workbench.configure({ baseUrl: "https://second.test/v1", apiKey: "second-fixture-key" });

  workbench.clearProvider();
  afterLogout = true;
  const persisted = new LocalStorage(f.root).read<Record<string, unknown>>()!;
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
  const reopened = f.restart({ keepOpen: true });
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
  let afterLogout = false;
  let completionsAfterLogout = 0;
  const fetcher: typeof fetch = async (url) => {
    if (!String(url).endsWith("/models")) {
      if (afterLogout) completionsAfterLogout++;
      return Response.json({ choices: [{ message: { role: "assistant", content: "ok" } }] });
    }
    return Response.json({ data: [{ id: "test", name: "Test" }] });
  };
  const f = await isolatedWorkbench(t, fetcher, {}, {
    prefix: "nomo-provider-reauth-kind-",
    configure: false,
  });
  const workbench = f.app;

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

test("compatible and Anthropic provider profiles survive restart without credential crossover", async (t) => {
  const compatibleUrl = "https://compatible.fixture/v1";
  const anthropicUrl = "https://anthropic.fixture/v1";
  const compatibleKey = "compatible-restart-fixture-key";
  const anthropicKey = "anthropic-restart-fixture-key";
  const calls: Array<{ host: string; path: string; authorization: string | null; apiKey: string | null }> = [];
  const fetcher: typeof fetch = async (input, options) => {
    const url = new URL(String(input));
    const headers = new Headers(options?.headers);
    const host = url.host;
    const authorization = headers.get("authorization");
    const apiKey = headers.get("x-api-key");
    calls.push({ host, path: url.pathname, authorization, apiKey });

    if (host === "compatible.fixture") {
      assert.equal(authorization, `Bearer ${compatibleKey}`);
      assert.equal(apiKey, null);
      if (url.pathname.endsWith("/models"))
        return reply({ data: [{ id: "compatible-model" }] });
      assert.ok(url.pathname.endsWith("/chat/completions"));
      return reply({ choices: [{ message: { role: "assistant", content: "compatible reply" }, finish_reason: "stop" }] });
    }

    assert.equal(host, "anthropic.fixture");
    assert.equal(authorization, null);
    assert.equal(apiKey, anthropicKey);
    assert.equal(headers.get("anthropic-version"), "2023-06-01");
    if (url.pathname.endsWith("/models"))
      return reply({ data: [{ id: "anthropic-model", type: "model", display_name: "Anthropic Fixture" }] });
    assert.ok(url.pathname.endsWith("/messages"));
    const events = [
      { type: "message_start", message: { content: [], usage: { input_tokens: 1 } } },
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Anthropic reply" } },
      { type: "content_block_stop", index: 0 },
      { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } },
      { type: "message_stop" },
    ];
    const body = events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join("");
    return new Response(body, { headers: { "content-type": "text/event-stream" } });
  };
  const f = await isolatedWorkbench(t, fetcher, {}, {
    prefix: "nomo-provider-profile-restart-",
    configure: false,
  });
  const workbench = f.app;

  await workbench.configure({ baseUrl: compatibleUrl, kind: "compatible", apiKey: compatibleKey });
  const compatibleSession = await workbench.start("Compatible before restart", "compatible-model");
  for (let poll = 0; poll < 200 && workbench.get(compatibleSession.id)?.status === "running"; poll++)
    await delay(5);
  assert.equal(workbench.get(compatibleSession.id)?.status, "idle");

  await workbench.configure({ baseUrl: anthropicUrl, kind: "anthropic", apiKey: anthropicKey });
  const anthropicSession = await workbench.start("Anthropic before restart", "anthropic-model");
  for (let poll = 0; poll < 200 && workbench.get(anthropicSession.id)?.status === "running"; poll++)
    await delay(5);
  assert.equal(workbench.get(anthropicSession.id)?.status, "idle");

  const callsBeforeRestart = calls.length;
  workbench.close();
  const reopened = f.restart({ keepOpen: true });
  const state = await reopened.providerState();
  assert.equal(state.connected, true);
  assert.equal(state.kind, "anthropic");
  assert.equal(state.baseUrl, anthropicUrl);
  assert.equal(state.defaultModel, "anthropic-model");
  assert.ok(state.profiles.includes(compatibleUrl));
  assert.ok(state.profiles.includes(anthropicUrl));
  assert.doesNotMatch(JSON.stringify(state), new RegExp(`${compatibleKey}|${anthropicKey}`));

  reopened.send(compatibleSession.id, "Compatible after restart");
  for (let poll = 0; poll < 200 && reopened.get(compatibleSession.id)?.status === "running"; poll++)
    await delay(5);
  assert.equal(reopened.get(compatibleSession.id)?.status, "idle");
  reopened.send(anthropicSession.id, "Anthropic after restart");
  for (let poll = 0; poll < 200 && reopened.get(anthropicSession.id)?.status === "running"; poll++)
    await delay(5);
  assert.equal(reopened.get(anthropicSession.id)?.status, "idle");

  assert.deepEqual(
    calls.slice(callsBeforeRestart).map(({ host, path, authorization, apiKey }) => ({ host, path, authorization, apiKey })),
    [
      {
        host: "compatible.fixture",
        path: "/v1/chat/completions",
        authorization: `Bearer ${compatibleKey}`,
        apiKey: null,
      },
      {
        host: "anthropic.fixture",
        path: "/v1/messages",
        authorization: null,
        apiKey: anthropicKey,
      },
    ],
  );
});

test("provider logout suppresses environment reconnect until explicit login", async (t) => {
  let afterLogout = false;
  let callsAfterLogout = 0;
  const fetcher: typeof fetch = async (url) => {
    if (afterLogout) callsAfterLogout++;
    return String(url).endsWith("/models")
      ? Response.json({ data: [{ id: "test", name: "Test" }] })
      : Response.json({ choices: [{ message: { role: "assistant", content: "ok" } }] });
  };
  const f = await isolatedWorkbench(
    t,
    fetcher,
    { NVIDIA_API_KEY: "nvidia-fixture-key" },
    { prefix: "nomo-provider-environment-logout-", configure: false },
  );
  const workbench = f.app;
  assert.equal((await workbench.providerState()).connected, true);
  workbench.clearProvider();
  afterLogout = true;
  const persisted = new LocalStorage(f.root).read<Record<string, unknown>>()!;
  assert.equal(persisted.ignoreEnvironment, true);
  assert.equal(persisted.config, undefined);
  assert.deepEqual(persisted.profiles, {});
  workbench.close();

  const reopened = f.restart({ keepOpen: true });
  assert.equal((await reopened.providerState()).connected, false);
  assert.equal(callsAfterLogout, 0);
  assert.equal((await reopened.providerState({ reconnectEnvironment: true })).connected, true);
  assert.equal(callsAfterLogout, 1);
});

test("provider logout waits for a manual provider catalog probe", async (t) => {
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
  const f = await isolatedWorkbench(t, fetcher, {}, {
    prefix: "nomo-provider-pending-logout-",
    configure: false,
    // The catalog probe is held open on `pendingModels`; releasing it and
    // draining the work it gated is what the old cleanup hook did first, and
    // `shutdown` cannot finish while the probe is still outstanding.
    beforeShutdown: async () => {
      finishModels(Response.json({ data: [{ id: "test", name: "Test" }] }));
      await configuration?.catch(() => {});
      await queuedStart?.catch(() => {});
    },
  });
  const workbench = f.app;

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
  const persisted = new LocalStorage(f.root).read<Record<string, unknown>>()!;
  assert.equal(persisted.config, undefined);
  assert.deepEqual(persisted.profiles, {});
  assert.doesNotMatch(JSON.stringify(persisted), /pending-fixture-key/);
});

test("a failed provider catalog probe does not keep logout blocked", async (t) => {
  const fetcher: typeof fetch = async () => { throw new Error("fixture connection failure"); };
  const f = await isolatedWorkbench(t, fetcher, {}, {
    prefix: "nomo-provider-failed-setup-",
    configure: false,
  });
  const workbench = f.app;

  await assert.rejects(
    workbench.configure({ baseUrl: "https://failed.test/v1", apiKey: "failed-fixture-key" }),
    /Provider connection failed/,
  );
  assert.doesNotThrow(() => workbench.clearProvider());
  assert.equal((await workbench.providerState()).connected, false);
});

test("provider logout waits for the automatic environment catalog probe", async (t) => {
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
  const f = await isolatedWorkbench(
    t,
    fetcher,
    { NVIDIA_API_KEY: "nvidia-race-fixture-key" },
    {
      prefix: "nomo-provider-environment-race-",
      configure: false,
      beforeShutdown: () =>
        finishModels(Response.json({ data: [{ id: "test", name: "Test" }] })),
    },
  );
  const workbench = f.app;

  const pendingState = workbench.providerState();
  await requested;
  assert.throws(() => workbench.clearProvider(), /provider setup/i);
  finishModels(Response.json({ data: [{ id: "test", name: "Test" }] }));
  assert.equal((await pendingState).connected, true);
  workbench.clearProvider();
  assert.equal((await workbench.providerState()).connected, false);
});

test("a superseded environment probe does not mark the replacement unavailable", async (t) => {
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
  const f = await isolatedWorkbench(
    t,
    fetcher,
    { NVIDIA_API_KEY: "nvidia-superseded-fixture-key" },
    {
      prefix: "nomo-provider-superseded-setup-",
      configure: false,
      beforeShutdown: () =>
        finishModels(Response.json({ data: [{ id: "test", name: "Test" }] })),
    },
  );
  const workbench = f.app;

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
  const dir = await mkdtemp(join(tmpdir(), "nomo-provider-logout-storage-conflict-"));
  const fetcher: typeof fetch = async (url) => String(url).endsWith("/models")
    ? Response.json({ data: [{ id: "test", name: "Test" }] })
    : Response.json({ choices: [{ message: { role: "assistant", content: "ok" } }] });
  const conflictEnv = { NOMO_DATA_DIR: dir };
  const workbench = new Workbench(conflictEnv, fetcher);
  // Left on direct construction: this test deliberately puts the store into a
  // state where `close` throws, so it keeps its own `try`/`catch` cleanup
  // rather than the fixture's unconditional `shutdown`.
  assertIsolated(dir, conflictEnv);
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
  const f = await isolatedWorkbench(
    t,
    async (url) => {
      if (String(url).endsWith("/models"))
        return Response.json({ data: [{ id: "test", name: "Test" }] });
      completions++;
      return Response.json({ choices: [{ message: { role: "assistant", content: "ok" } }] });
    },
    {},
    {
      prefix: "nomo-provider-start-",
      configure: false,
      // The `tools/list` response is held open behind `toolsListGate`, and the
      // test swapped the global fetch for the connector; both have to be put
      // back before shutdown can drain what is in flight.
      beforeShutdown: () => {
        releaseToolsList();
        globalThis.fetch = originalFetch;
      },
    },
  );
  const workbench = f.app;
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
  let markRequested: () => void = () => {};
  let finishResponse: (response: Response) => void = () => {};
  const requested = new Promise<void>((resolve) => { markRequested = resolve; });
  const pendingResponse = new Promise<Response>((resolve) => { finishResponse = resolve; });
  const fetcher: typeof fetch = async (url) => {
    if (String(url).endsWith("/models")) return Response.json({ data: [{ id: "test", name: "Test" }] });
    markRequested();
    return pendingResponse;
  };
  const f = await isolatedWorkbench(t, fetcher, {}, {
    prefix: "nomo-provider-active-logout-",
    configure: false,
    beforeShutdown: () =>
      finishResponse(
        Response.json({ choices: [{ message: { role: "assistant", content: "ok" } }] }),
      ),
  });
  const workbench = f.app;

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
    const dir = await mkdtemp(join(tmpdir(), `nomo-provider-${legacy.label}-kind-`));
    const env = { NOMO_DATA_DIR: dir };
    // Direct by design: this test rewrites the stored session config with a
    // hand-built `LocalStorage` between two constructions over one root, and
    // that hand-off is the behaviour under test.
    const original = new Workbench(env, fetcher);
    assertIsolated(dir, env);
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
    reopened = new Workbench(env, fetcher);
    assertIsolated(dir, env);
    assert.throws(() => reopened.send(session.id, "Do not switch protocol"), /provider|protocol/i);
    assert.equal(completions, completionsBeforeResume);
  }
});


test("legacy inline provider keys are scrubbed without borrowing another provider", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "nomo-provider-legacy-session-"));
  let requestCount = 0;
  const fetcher: typeof fetch = async (url) => {
    requestCount++;
    return String(url).endsWith("/models")
      ? Response.json({ data: [{ id: "test", name: "Test" }] })
      : Response.json({ choices: [{ message: { role: "assistant", content: "ok" } }] });
  };
  const env = { NOMO_DATA_DIR: dir };
  // Direct by design, as above: a hand-built `LocalStorage` rewrites the
  // stored session between the two constructions.
  const original = new Workbench(env, fetcher);
  assertIsolated(dir, env);
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
  reopened = new Workbench(env, fetcher);
  assertIsolated(dir, env);
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

/** A provider that answers one fixture tool call per user turn while the test
 * allows it, then closes. The gate lets a test seed evidence between two
 * turns: without it the first turn would decide the call before the seed
 * exists, and the test would prove timing rather than delegation. */
function gatedToolProvider(
  gate: { wantCall: boolean },
  toolPrefix: string,
  args: string,
  seen: unknown[] = [],
) {
  return async (url: unknown, options?: { body?: unknown }) => {
    if (String(url).endsWith("/models"))
      return reply({ data: [{ id: "fixture-model" }] });
    const request = JSON.parse(String(options?.body));
    seen.push(request);
    const messages = (request.messages ?? []) as { role: string }[];
    // The learned-entry digest is a system message appended after the user
    // message on a follow-up turn, so the last message is not always the one
    // the fixture should answer.
    const last = [...messages].reverse().find((message) => message.role !== "system");
    if (last?.role === "tool")
      return reply({
        choices: [{ message: { role: "assistant", content: "done" } }],
      });
    if (last?.role === "user" && gate.wantCall) {
      gate.wantCall = false;
      const tool = (request.tools as { function: { name: string; description: string } }[]).find(
        (item) => String(item.function.description ?? "").startsWith(toolPrefix),
      )!;
      return reply({
        choices: [
          {
            message: {
              role: "assistant",
              content: null,
              tool_calls: [
                {
                  id: "call1",
                  type: "function",
                  function: { name: tool.function.name, arguments: args },
                },
              ],
            },
          },
        ],
      });
    }
    return reply({
      choices: [{ message: { role: "assistant", content: "waiting" } }],
    });
  };
}

function stdioEnv(dir: string, extra: Record<string, string> = {}) {
  return {
    NOMO_LEDGER_DIR: dir,
    NOMO_UPSTREAM_COMMAND: JSON.stringify([
      process.execPath,
      join(root, "fixtures/e2e-server.mjs"),
    ]),
    NOMO_POLICY_PATH: join(root, "fixtures/e2e-policy.yaml"),
    ...extra,
  };
}

async function waitSettled(workbench: Workbench, id: string, rounds = 200) {
  for (
    let i = 0;
    i < rounds && workbench.get(id)?.status === "running";
    i++
  )
    await delay(20);
}

test("stdio delegation is recorded, not decided", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "nomo-stdio-recorded-"));
  const gate = { wantCall: true };
  const workbench = new Workbench(
    stdioEnv(dir),
    gatedToolProvider(gate, "echo:", '{"text":"fixture echo"}'),
  );
  assertIsolated(storeDirUnder(dir), stdioEnv(dir));
  t.after(async () => {
    workbench.close();
    await rm(dir, { recursive: true, force: true });
  });
  await workbench.configure({
    baseUrl: "https://provider.test/v1",
    apiKey: secret,
  });
  const started = await workbench.start("Test echo", "fixture-model");
  await waitSettled(workbench, started.id);
  const session = workbench.get(started.id)!;
  assert.equal(session.status, "idle", JSON.stringify(session.events));

  const feed = await readLedgerFeed(join(dir, `${started.workspace}.jsonl`));
  const proxyRecord = feed.records.find((record) => record.tool === "echo");
  assert.ok(proxyRecord, "the proxy recorded the call upstream");

  const chained = await workbench.ledger(started.workspace);
  const echoEntries = (chained?.entries ?? []).filter(
    (entry) => (entry.body as { tool: string }).tool === "echo",
  );
  assert.ok(echoEntries.length > 0, "the workspace chain holds the call");
  for (const entry of echoEntries) {
    const body = entry.body as Record<string, unknown>;
    assert.equal(body.source, "stdio-proxy");
    assert.match(String(body.sourceDigest ?? ""), /^[0-9a-f]{64}$/);
    // Recorded, not decided: the attribution is the proxy's own, imported
    // verbatim. A workbench decision would additionally stamp the model that
    // asked and the request that asked, which the proxy never knows, so their
    // absence proves this side computed no policy digest and no rule index.
    assert.deepEqual(body.attribution, proxyRecord.attribution);
    const stamped = body.attribution as
      | { modelId?: string; requestDigest?: string }
      | undefined;
    assert.equal(stamped?.modelId, undefined, "no locally computed model stamp");
    assert.equal(
      stamped?.requestDigest,
      undefined,
      "no locally computed request stamp",
    );
  }
});

test("unverifiable proxy ledger is unknown, not failed", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "nomo-stdio-unverified-"));
  // A key the proxy never signed with. The workbench resolves its syncStdio
  // verification key from NOMO_PROXY_KEYS without creating one, so this decoy
  // makes the imported chain fail verification exactly the way a substituted
  // proxy key would, while the upstream call itself still succeeds.
  const proxyKeys = await mkdtemp(join(tmpdir(), "nomo-stdio-decoy-keys-"));
  t.after(async () => {
    await rm(proxyKeys, { recursive: true, force: true });
  });
  await devKeyProvider({ dir: proxyKeys, env: {} });
  const gate = { wantCall: true };
  const workbench = new Workbench(
    stdioEnv(dir, { NOMO_PROXY_KEYS: proxyKeys }),
    gatedToolProvider(gate, "echo:", '{"text":"fixture echo"}'),
  );
  assertIsolated(storeDirUnder(dir), stdioEnv(dir));
  t.after(async () => {
    workbench.close();
    await rm(dir, { recursive: true, force: true });
  });
  await workbench.configure({
    baseUrl: "https://provider.test/v1",
    apiKey: secret,
  });
  const started = await workbench.start("Test echo", "fixture-model");
  await waitSettled(workbench, started.id);
  const session = workbench.get(started.id)!;
  // The upstream ran: the proxy ledger holds the call. Only the import is
  // refused, so the outcome is unknown rather than a failure of the tool.
  const feed = await readLedgerFeed(join(dir, `${started.workspace}.jsonl`));
  assert.ok(
    feed.records.some((record) => record.tool === "echo"),
    "the upstream ran the call",
  );
  assert.equal(session.status, "unknown", JSON.stringify(session.events));
  assert.ok(
    session.events.some(
      (event) => event.kind === "error" && /unknown/i.test(event.text),
    ),
    "the run reports the outcome as unknown",
  );
  const chained = await workbench.ledger(started.workspace);
  assert.ok(
    chained === undefined ||
      !chained.entries.some(
        (entry) => (entry.body as { tool: string }).tool === "echo",
      ),
    "the workspace chain gains no entry for the unverified call",
  );
});

test("stdio delegation ignores learned rules", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "nomo-stdio-learned-"));
  const gate = { wantCall: true };
  const proxyEnv = stdioEnv(dir);
  const workbench = new Workbench(
    proxyEnv,
    gatedToolProvider(gate, "echo:", '{"text":"fixture echo"}'),
  );
  assertIsolated(storeDirUnder(dir), proxyEnv);
  t.after(async () => {
    workbench.close();
    await rm(dir, { recursive: true, force: true });
  });
  await workbench.configure({
    baseUrl: "https://provider.test/v1",
    apiKey: secret,
  });
  const started = await workbench.start("Test echo", "fixture-model");
  await waitSettled(workbench, started.id);
  assert.equal(workbench.get(started.id)?.status, "idle");

  const feed = await readLedgerFeed(join(dir, `${started.workspace}.jsonl`));
  const klass = feed.records.find((record) => record.tool === "echo")?.klass;
  assert.ok(klass, "the proxy classified the call");
  // Three genuine refusals of this exact tool and class, appended as real
  // signed chain entries under the workbench's own key. Unsigned fakes would
  // break the next run, because the run verifies the workspace chain, so a
  // seed that is not a real entry turns this test into a signature failure
  // instead of a delegation proof. The miner call proves the seed mints the
  // hold rule the delegation below must ignore.
  const internals = workbench as unknown as {
    evidence: Record<string, JsonlEntry[]>;
  };
  const key = await devKeyProvider({
    dir: join(dir, "workbench", "keys"),
    env: proxyEnv,
  });
  const keyId = await key.currentKeyId();
  const current = internals.evidence[started.workspace] ?? [];
  const seed: JsonlEntry[] = [];
  for (const decision of ["deny:policy", "deny:policy", "hold:denied"]) {
    const body = { workspace: started.workspace, tool: "echo", klass, decision };
    const prev = current.at(-1)?.hash ?? GENESIS_PREV;
    const hash = await entryHash(body, prev, sha256Hex);
    current.push({
      workspace: started.workspace,
      seq: current.length + 1,
      body,
      prev_hash: prev,
      hash,
      key_id: keyId,
      alg: key.alg,
      signature: `${key.alg}:${Buffer.from(await key.sign(signingPreimage(key.alg, keyId, hash))).toString("base64")}`,
    });
    seed.push(current.at(-1)!);
  }
  internals.evidence[started.workspace] = current;
  assert.equal(
    mineLearnedRules(seed).length,
    1,
    "the seed mines the hold rule this test claims is ignored",
  );
  const checkpoint = (internals.evidence[started.workspace] ?? []).length;

  gate.wantCall = true;
  workbench.send(started.id, "Echo again");
  await waitSettled(workbench, started.id);
  assert.equal(workbench.get(started.id)?.status, "idle");

  const added = (internals.evidence[started.workspace] ?? []).slice(checkpoint);
  assert.ok(added.length > 0, "the second call left entries");
  for (const entry of added) {
    const body = entry.body as Record<string, unknown>;
    assert.equal(
      body.source,
      "stdio-proxy",
      "the only new entries are the proxy re-commits",
    );
  }
  assert.ok(
    !added.some(
      (entry) =>
        (entry.body as { tool: string }).tool === "echo" &&
        ["deny", "hold:denied"].includes(
          (entry.body as { decision: string }).decision,
        ),
    ),
    "no hold or deny derived from the seeded rule",
  );
});

test("a verified proxy denial surfaces, a receiptless one cannot", async (t) => {
  // The proxy holds orders_delete for 5 seconds under the fixture policy and
  // nobody approves, so the hold expires: the client raises the typed
  // HoldDeniedError and the proxy has already recorded the hold:expired
  // receipt this side re-commits. A typed denial with no fresh verified
  // receipt for the call's argsDigest is the forged case, and this fixture
  // cannot produce it: the honest proxy records every hold resolution before
  // answering, so any genuine HoldDeniedError arrives with its receipt. That
  // branch stays pinned by reading index.ts, and forging it would mean
  // editing the proxy ledger mid-flight, which breaks chain verification and
  // is the previous test's case instead.
  const dir = await mkdtemp(join(tmpdir(), "nomo-stdio-denied-"));
  const seen: unknown[] = [];
  const gate = { wantCall: true };
  const workbench = new Workbench(
    stdioEnv(dir),
    gatedToolProvider(gate, "orders_delete:", '{"where":"id = 1"}', seen),
  );
  assertIsolated(storeDirUnder(dir), stdioEnv(dir));
  t.after(async () => {
    workbench.close();
    await rm(dir, { recursive: true, force: true });
  });
  await workbench.configure({
    baseUrl: "https://provider.test/v1",
    apiKey: secret,
  });
  const started = await workbench.start("Delete matching orders", "fixture-model");
  await waitSettled(workbench, started.id, 600);
  const session = workbench.get(started.id)!;
  // An isError denial is an answer, not an unknown outcome and not a crash.
  assert.equal(session.status, "idle", JSON.stringify(session.events));

  const argsDigest = await sha256Hex(canonicalJson({ where: "id = 1" }));
  const chained = await workbench.ledger(started.workspace);
  const denials = (chained?.entries ?? []).filter((entry) => {
    const body = entry.body as Record<string, unknown>;
    return (
      body.tool === "orders_delete" &&
      body.source === "stdio-proxy" &&
      (body.decision === "hold:denied" || body.decision === "hold:expired")
    );
  });
  assert.ok(denials.length > 0, "the verified receipt was re-committed");
  for (const entry of denials) {
    const body = entry.body as Record<string, unknown>;
    assert.equal(
      body.argsDigest,
      argsDigest,
      "the receipt names this exact call's arguments",
    );
  }
  assert.ok(
    seen.some((request) => JSON.stringify(request).includes("Do not retry")),
    "the denial reached the model in the proxy's own words",
  );
});

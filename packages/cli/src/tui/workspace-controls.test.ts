import test from "node:test";
import { execFileSync } from "node:child_process";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Workbench } from "../../../workbench/src/index.ts";
import { assertIsolated } from "../../../workbench/src/test-fixture.ts";
import { WorkspaceTui, renderWorkspace, commandSuggestions } from "./workspace.ts";
import { stripAnsi, visibleLength } from "./layout.ts";

async function fixture(
  t: test.TestContext,
  answer = "Fixture reply",
  options: { env?: Record<string, string>; fetcher?: typeof fetch } = {},
) {
  const root = await mkdtemp(join(tmpdir(), "nomo-parity-controls-"));
  const env = { NOMO_DATA_DIR: root, ...options.env };
  const fetcher: typeof fetch = async (url) =>
    String(url).endsWith("/models")
      ? Response.json({ data: [{ id: "fixture" }] })
      : Response.json({
          choices: [
            { message: { role: "assistant", content: answer }, finish_reason: "stop" },
          ],
        });
  let app = new Workbench(env, options.fetcher ?? fetcher);
  assertIsolated(root, env);
  t.after(async () => {
    await app.shutdown();
    await rm(root, { recursive: true, force: true });
  });
  return {
    app,
    env,
    ui: new WorkspaceTui(app, env),
    restart: async () => {
      await app.shutdown();
      app = new Workbench(env);
      assertIsolated(root, env);
      return app;
    },
  };
}

test("runs navigation keeps unknown outcomes and missing progress explicit", async (t) => {
  const { app, ui } = await fixture(t);
  await app.configure({
    baseUrl: "https://fixture.invalid/v1",
    apiKey: "fixture",
  });
  const session = await app.start("Run to inspect", "fixture");
  await app.settled();
  await ui.initialize();
  await ui.command("/runs");
  assert.equal(ui.tab, "runs");
  assert.equal(ui.items().length, 1);
  assert.match(ui.items()[0]!.label, /idle/);
  assert.match(ui.items()[0]!.label, /progress not reported/);
  assert.doesNotMatch(ui.lines().join("\n"), /Completed runs/);
  const activeSession = ui.sessionId;
  await ui.openSelected();
  // The inspector names the run id it is showing instead of echoing a field
  // name the operator never sees.
  assert.match(ui.lines().join("\n"), /run id\s*:\s*[0-9a-f-]{36}/);
  assert.match(ui.lines().join("\n"), /progress\s*:\s*not reported/);
  // Inspecting a run is read-only: it never switches the active conversation.
  assert.equal(ui.sessionId, activeSession);
  assert.ok(session.id);
  // An unconfirmed runtime outcome must stay visible, never inferred complete.
  t.mock.method(app, "runs", () => [
    {
      id: "uncertain",
      runId: "uncertain",
      sessionId: session.id,
      model: "fixture",
      provider: "fixture",
      status: "unknown",
      state: "unknown",
      progress: null,
      createdAt: session.createdAt,
      updatedAt: session.createdAt,
      durationMs: null,
      steps: 0,
      legacy: false,
      reconcileRequired: true,
    },
  ]);
  await ui.command("/runs");
  assert.match(ui.items()[0]!.label, /unknown/);
  assert.match(ui.items()[0]!.label, /progress not reported/);
  // The unconfirmed outcome stays marked for reconciliation in the panel.
  assert.match(ui.lines().join("\n"), /1 need reconciliation/);
  await ui.command("/status");
  // The status panel counts the unproven outcome instead of dropping it, and
  // unrun probes stay unmeasured rather than becoming green.
  assert.match(ui.lines().join("\n"), /⚙ STATUS/);
  const runsCheck = ui.items().find((row) => row.check?.name === "runs");
  assert.match(runsCheck?.lines.join("\n") ?? "", /1 run\(s\) need reconciliation/);
  assert.match(ui.lines().join("\n"), /unmeasured/);
  for (const width of [40, 80, 120, 200]) {
    const lines = stripAnsi(renderWorkspace(ui, width, 24)).split("\n");
    assert.ok(lines.length <= 24);
    assert.ok(lines.every((line) => visibleLength(line) <= width));
  }
});

test("runs rows carry measured tokens and elapsed time without overflowing narrow frames", async (t) => {
  const { app, ui } = await fixture(t);
  await app.configure({
    baseUrl: "https://fixture.invalid/v1",
    apiKey: "fixture",
  });
  const session = await app.start("Measure this run", "fixture");
  await app.settled();
  const base = app.get(session.id)!;
  const runId = "run-measured";
  const longModel = "fixture-model-with-a-name-that-keeps-going-past-the-row-width";
  const view = {
    ...base,
    model: longModel,
    events: [
      {
        seq: 1,
        at: "2026-01-02T03:04:10.000Z",
        kind: "tool",
        type: "run.status",
        text: "idle",
        payload: { status: "idle" },
        runId,
        sessionId: session.id,
      },
      {
        seq: 2,
        at: "2026-01-02T03:04:11.000Z",
        kind: "usage",
        type: "usage.reported",
        text: "usage",
        payload: { total_tokens: 123, source: "provider" },
        runId,
        sessionId: session.id,
      },
    ],
  };
  t.mock.method(app, "allViews", () => [view]);
  await ui.initialize();
  await ui.command("/runs");
  const row = ui.items()[0]!;
  assert.match(row.label, /idle/);
  assert.match(row.label, /123 tokens/);
  assert.match(row.label, /1s/);
  assert.ok(!row.label.includes(longModel), "the compact row truncates a long model name");
  assert.match(row.lines.join("\n"), new RegExp(`Model: ${longModel}`));
  assert.match(row.lines.join("\n"), /Tokens: 123 tokens/);
  assert.match(row.lines.join("\n"), /Duration: 1s/);
  for (const width of [40, 80]) {
    const lines = stripAnsi(renderWorkspace(ui, width, 24)).split("\n");
    assert.ok(lines.every((line) => visibleLength(line) <= width));
  }
  assert.match(ui.lines().join("\n"), /Esc returns to Chat/);
});

test("status shows the agent identity binding and separates local revoke from fleet revoke", async (t) => {
  const { app, ui } = await fixture(t);
  await app.configure({
    baseUrl: "https://fixture.invalid/v1",
    apiKey: "fixture",
  });
  const session = await app.start("Run to inspect", "fixture");
  await app.settled();
  const agentId = session.agent;
  const runId = session.runId;
  assert.ok(agentId, "the session carries an agent identity");
  assert.ok(runId, "the session carries a run identity");

  await ui.initialize();
  await ui.command("/status");
  const row = ui.items().find((item) => item.id === "identity:agent revocation");
  assert.ok(row, "status carries an agent revocation row");
  assert.match(row.label, /WARN · identity · agent revocation/);
  const text = row.lines.join("\n");
  assert.ok(text.includes("principal workbench-local"), text);
  assert.ok(text.includes(`workspace ${session.workspace}`), text);
  assert.ok(text.includes(`agent ${agentId}`), text);
  assert.ok(text.includes(`run ${runId}`), text);
  assert.match(text, /local agent revoke available/i);
  assert.match(text, /fleet-wide revoke unavailable/i);
  assert.match(text, /acknowledg/i);
  for (const width of [40, 80, 120, 200]) {
    const lines = stripAnsi(renderWorkspace(ui, width, 24)).split("\n");
    assert.ok(lines.length <= 24);
    assert.ok(lines.every((line) => visibleLength(line) <= width));
  }
});

test("/revoke-agent requires confirmation and status then reports the durable local state", async (t) => {
  const { app, ui } = await fixture(t);
  await app.configure({
    baseUrl: "https://fixture.invalid/v1",
    apiKey: "fixture",
  });
  const session = await app.start("Run to revoke", "fixture");
  const agentId = session.agent;
  assert.ok(agentId, "the session carries an agent identity");
  assert.ok(
    commandSuggestions("/rev").some(([name]) => name === "/revoke-agent"),
    "the revocation command is discoverable",
  );

  await ui.initialize();
  await ui.command(`/revoke-agent ${agentId}`);
  assert.ok(ui.confirmation, "revocation requires explicit confirmation");
  assert.match(ui.confirmation.title, /LOCAL AGENT REVOKE/);
  const review = ui.confirmation.lines.join("\n");
  assert.match(review, /local Workbench/i);
  assert.match(review, /new grants|new run/i);
  assert.match(review, /fleet-wide revoke is unavailable/i);
  assert.match(review, /other node/i);

  await ui.confirm();
  assert.equal(app.isAgentRevoked(agentId), true);
  await assert.rejects(
    app.start("another run", "fixture"),
    /revoked/,
    "a revoked agent cannot start a new session",
  );
  assert.match(ui.notice, /local agent .* revoked/i);

  await ui.command("/status");
  const row = ui.items().find((item) => item.id === "identity:agent revocation");
  assert.ok(row, "status keeps the agent revocation row");
  const text = row.lines.join("\n");
  assert.ok(text.includes(`agent ${agentId}`), text);
  assert.match(text, /agent revoked/i);
  assert.match(text, /fleet-wide revoke unavailable/i);
});

test("provider status exposes setup-required without defaulting an unconfigured provider", async (t) => {
  const { app, ui } = await fixture(t);
  await ui.initialize();
  await ui.command("/status");
  ui.selected = ui.items().findIndex((row) => row.id === "runtime:provider");
  assert.notEqual(ui.selected, -1);
  await ui.openSelected();
  assert.match(ui.lines().join("\n"), /setup-required/);
  await ui.command("/connect");
  assert.match(ui.notice, /Set an API key in the host environment/);
  assert.match(ui.notice, /No key is accepted in chat/);
  // No provider is configured, so setup is required without a vendor ID.
  assert.equal((await app.providerState()).providerId, null);
  ui.provider = {
    ...ui.provider!,
    connected: true,
    status: "rate-limited",
    detail: "Provider rate limit reached.",
    retryAt: "2026-09-22T12:00:00.000Z",
  };
  await ui.command("/status");
  ui.selected = ui.items().findIndex((row) => row.id === "runtime:provider");
  assert.notEqual(ui.selected, -1);
  await ui.openSelected();
  assert.match(ui.lines().join("\n"), /rate-limited/);
  assert.match(ui.lines().join("\n"), /2026-09-\s*22T12:00:00\.000Z/);
});

test("unavailable provider preserves its failure and avoids assuming it is unconfigured", async (t) => {
  const { ui } = await fixture(t);
  await ui.initialize();
  ui.provider = {
    ...ui.provider!,
    connected: false,
    status: "unavailable",
    detail: "Configured credential was rejected by the provider endpoint.",
    retryAt: null,
  };
  await ui.command("/status");
  ui.selected = ui.items().findIndex((row) => row.id === "runtime:provider");
  assert.notEqual(ui.selected, -1);
  await ui.openSelected();
  const lines = ui.lines().join("").replace(/\s+/g, "");
  assert.match(lines, /unavailable/);
  assert.ok(
    lines.includes("Configuredcredentialwasrejectedbytheproviderendpoint"),
  );
  assert.ok(
    lines.includes(
      "Reviewtheconfiguredcredentialandendpoint;confirmprovideravailabilitybeforeretrying",
    ),
  );
  assert.ok(!lines.includes("Noproviderisconnected"));
  assert.ok(!lines.includes("Run/connecttoattachone"));
});

test("bare /connect re-reads the host environment after a refused probe", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "nomo-controls-home-"));
  t.after(async () => {
    await rm(home, { recursive: true, force: true });
  });
  let online = false;
  const { ui } = await fixture(t, "Fixture reply", {
    env: { HOME: home, NVIDIA_API_KEY: "nvidia-fixture-key" },
    fetcher: async (url) => {
      if (!online) throw new Error("fixture connection failure");
      return String(url).endsWith("/models")
        ? Response.json({ data: [{ id: "fixture" }] })
        : Response.json({
            choices: [
              {
                message: { role: "assistant", content: "Fixture reply" },
                finish_reason: "stop",
              },
            ],
          });
    },
  });
  await ui.initialize();
  // A key was present and refused, so this is not "nothing configured".
  assert.equal(ui.provider?.connected, false);
  assert.equal(ui.provider?.setupRequired, false);
  assert.equal(ui.provider?.status, "unavailable");
  online = true;
  await ui.command("/connect");
  // Bare /connect is a fresh attempt, not a replay of the earlier refusal.
  assert.equal(ui.provider?.connected, true);
  assert.equal(ui.provider?.providerId, "nvidia");
  assert.equal(ui.provider?.status, "ready");
  assert.match(ui.notice, /connected/);
});

test("bare /connect reports an unavailable provider instead of asking for a key again", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "nomo-controls-home-"));
  t.after(async () => {
    await rm(home, { recursive: true, force: true });
  });
  const { ui } = await fixture(t, "Fixture reply", {
    env: { HOME: home, NVIDIA_API_KEY: "nvidia-fixture-key" },
    fetcher: async () => {
      throw new Error("fixture connection failure");
    },
  });
  await ui.initialize();
  await ui.command("/connect");
  assert.equal(ui.provider?.connected, false);
  assert.equal(ui.provider?.setupRequired, false);
  assert.equal(ui.provider?.status, "unavailable");
  // An unconfigured workspace is told to set a key. A configured workspace
  // whose key was rejected must not be told the key is missing.
  assert.doesNotMatch(ui.notice, /Set an API key in the host environment/);
  assert.match(ui.notice, /unavailable|rejected|failed/i);
});

test("projects and preset agents apply only to new conversations and projects survive restart", async (t) => {
  const { app, env, ui, restart } = await fixture(t);
  await app.configure({
    baseUrl: "https://fixture.invalid/v1",
    apiKey: "fixture",
  });
  await ui.initialize();
  await ui.command("original");
  await app.settled();
  const original = ui.sessionId!;
  const file = join(env.NOMO_DATA_DIR, "project.json");
  await writeFile(
    file,
    JSON.stringify({ name: "Writing", root: "/descriptive/project/root" }),
  );
  await ui.command(`/project-file ${file}`);
  assert.equal(app.listProjects().length, 0, "creation waits for confirmation");
  await ui.confirm();
  const project = app.listProjects()[0]!;
  await ui.command("/projects");
  assert.match(ui.lines().join("\n"), /Writing/);
  await ui.command(`/project ${project.id}`);
  const preset = app.agents().agents[1]!;
  await ui.command(`/agent ${preset.id}`);
  assert.equal(app.get(original)!.project, undefined);
  await ui.command("/new project work");
  await app.settled();
  assert.equal(app.get(ui.sessionId!)!.project, project.id);
  assert.equal(app.get(ui.sessionId!)!.agent, preset.id);
  await assert.rejects(ui.command("/project missing-id"), /Unknown project/);
  await assert.rejects(ui.command("/agent missing-id"), /Unknown agent/);
  await ui.command("/project none");
  await ui.command("/agent default");
  assert.equal(ui.projectId, undefined);
  assert.equal(ui.agentId, "default");
  const restored = await restart();
  assert.equal(restored.listProjects()[0]!.id, project.id);
});

test("compaction requires a fresh confirmed review, changes context and preserves transcript", async (t) => {
  const { app, ui } = await fixture(t);
  await app.configure({
    baseUrl: "https://fixture.invalid/v1",
    apiKey: "fixture",
  });
  await ui.initialize();
  for (let i = 0; i < 8; i++) {
    await ui.command(`remember ${i}`);
    await app.settled();
  }
  const id = ui.sessionId!;
  const transcript = app
    .get(id)!
    .events.filter(
      (event) => event.kind === "user" || event.kind === "assistant",
    );
  const before = app.get(id)!.events.length;
  const beforeContext = app.get(id)!.contextMessages!;
  assert.equal(ui.contextNumbers().contextMessages, beforeContext);
  await ui.command("/compact");
  assert.match(ui.confirmation!.title, /COMPACT CONTEXT/);
  assert.equal(app.get(id)!.events.length, before, "review is read only");
  await ui.confirm();
  assert.equal(ui.confirmation, undefined);
  assert.match(ui.lines().join("\n"), /Omitted messages: [1-9]/);
  assert.match(ui.lines().join("\n"), /Retained message IDs:/);
  assert.equal(
    ui.contextNumbers().contextMessages,
    app.get(id)!.contextMessages,
  );
  assert.ok(ui.contextNumbers().contextMessages! < beforeContext);
  assert.deepEqual(
    app
      .get(id)!
      .events.filter(
        (event) => event.kind === "user" || event.kind === "assistant",
      ),
    transcript,
  );
  await ui.command("/context");
  assert.doesNotMatch(ui.lines().join("\n"), /199|threshold|of [0-9]/);
  assert.match(ui.lines().join("\n"), /Cumulative provider tokens: unknown/);
  // A review must not quietly compact a newer turn the operator did not see.
  await ui.command("/compact");
  app.send(id, "a newer turn");
  await app.settled();
  await assert.rejects(ui.confirm(), /changed.*compact again/i);
  assert.equal(ui.confirmation, undefined);
});

test("stale Undo clears apply authority and names the changed resource before refresh", async (t) => {
  const { app, ui } = await fixture(t);
  await app.configure({
    baseUrl: "https://fixture.invalid/v1",
    apiKey: "fixture",
  });
  const session = await app.start("Edit", "fixture");
  await app.settled();
  await app.editDocument(session.id, {
    path: "draft.md",
    content: "first",
    expectedRevision: null,
  });
  await ui.initialize();
  ui.sessionId = session.id;
  await ui.command("/document draft.md");
  await ui.prepareUndo();
  const edit = ui.editTarget();
  await app.editDocument(session.id, {
    path: "draft.md",
    content: "newer",
    expectedRevision: edit.revision,
  });
  await assert.rejects(ui.confirm(), /preview changed/i);
  assert.equal(
    ui.confirmation,
    undefined,
    "stale confirmation cannot be retried",
  );
  assert.match(ui.lines().join("\n"), /draft.md/);
  assert.match(ui.lines().join("\n"), /Refresh/);
  await ui.confirm();
  assert.equal(app.workspace(session.id).files["draft.md"], "newer");
  await ui.prepareUndo();
  await ui.confirm();
  assert.equal(app.workspace(session.id).files["draft.md"], "first");
});

test("u on a documents row previews that document's undo without opening it", async (t) => {
  const { app, ui } = await fixture(t);
  await app.configure({
    baseUrl: "https://fixture.invalid/v1",
    apiKey: "fixture",
  });
  const session = await app.start("Edit", "fixture");
  await app.settled();
  await app.editDocument(session.id, {
    path: "undo.md",
    content: "first",
    expectedRevision: null,
  });
  await ui.initialize();
  ui.choose("documents");
  const row = ui.items().findIndex((item) => item.path === "undo.md");
  assert.ok(row >= 0, "the edited document is listed");
  ui.selected = row;
  // Enter deliberately only inspects, so documentPath is still unset here:
  // the shortcut must take the target from the row, not from a document an
  // earlier command happened to open.
  await ui.prepareUndo();
  assert.match(ui.confirmation!.title, /UNDO undo\.md\?/);
  await ui.confirm();
  assert.equal(app.workspace(session.id).files["undo.md"], undefined);
});

test("custom agent files use Workbench validation and persist without broadening existing sessions", async (t) => {
  const { app, env, ui, restart } = await fixture(t);
  await app.configure({
    baseUrl: "https://fixture.invalid/v1",
    apiKey: "fixture",
  });
  await ui.initialize();
  await ui.command("original agent");
  await app.settled();
  const original = ui.sessionId!;
  const originalAgent = app.get(original)!.agent;
  const profile = {
    id: "notes-only",
    name: "Notes only",
    systemPrompt: "Summarize notes.",
    allowedTools: ["void_workspace_read"],
    policyProfile: "default",
    maxTurns: 2,
    maxContextTokens: 4000,
  };
  const file = join(env.NOMO_DATA_DIR, "profile.json");
  await writeFile(file, JSON.stringify(profile));
  await ui.command(`/agent-file ${file}`);
  assert.match(ui.confirmation!.title, /SAVE AGENT/);
  assert.equal(app.agents().profiles.length, 0);
  await ui.confirm();
  assert.deepEqual(app.agents().profiles[0], profile);
  assert.equal(app.get(original)!.agent, originalAgent);
  await ui.command("/new use notes profile");
  await app.settled();
  assert.equal(app.get(ui.sessionId!)!.agent, profile.id);
  await writeFile(
    file,
    JSON.stringify({ ...profile, policyProfile: "unrestricted" }),
  );
  await ui.command(`/agent-file ${file}`);
  await assert.rejects(ui.confirm(), /policy profile/i);
  assert.equal(ui.confirmation, undefined);
  assert.deepEqual(app.agents().profiles[0], profile);
  const restored = await restart();
  assert.deepEqual(restored.agents().profiles[0], profile);
});

test("hook capability stays visibly unsupported without an operator allowlist", async (t) => {
  const { app, ui } = await fixture(t);
  await ui.command("/hooks");
  assert.match(ui.lines().join("\n"), /unsupported/i);
  assert.match(ui.lines().join("\n"), /operator allowlist/i);
  assert.equal(ui.confirmation, undefined);
  await assert.rejects(ui.command("/hook-file missing.json"), /unsupported/i);
  assert.equal(app.agents().hooks.length, 0);
});

test("multioperation recovery previews signed order and reports durable results without replay", async (t) => {
  const { app, env, ui, restart } = await fixture(t);
  await app.configure({
    baseUrl: "https://fixture.invalid/v1",
    apiKey: "fixture",
  });
  const session = await app.start("Recover documents", "fixture");
  await app.settled();
  await app.editDocument(session.id, {
    path: "recovery.md",
    content: "first",
    expectedRevision: null,
  });
  await app.editDocument(session.id, {
    path: "recovery.md",
    content: "second",
    expectedRevision: app.document(session.id, "recovery.md").revision,
  });
  const operations = app.workspace(session.id).operations.map((op) => op.id);
  await ui.initialize();
  ui.sessionId = session.id;
  await ui.command(`/rewind ${operations.join(" ")}`);
  assert.equal(app.workspace(session.id).files["recovery.md"], "second");
  assert.match(ui.confirmation!.title, /RECOVER 2 OPERATIONS/);
  const preview = ui.lines().join("\n");
  assert.ok(
    preview.indexOf(operations[1]!) < preview.indexOf(operations[0]!),
    "server reverse order is preserved",
  );
  assert.match(preview, /recovery.md/);
  assert.match(preview, /Boundary sequence: [0-9]+/);
  assert.doesNotMatch(preview, /\[object Object\]/);
  const job = ui.lastRecoveryJob!;
  assert.ok(job.jobId);
  await ui.confirm();
  assert.equal(ui.confirmation, undefined);
  assert.match(ui.lines().join("\n"), /restored/);
  assert.equal(app.workspace(session.id).files["recovery.md"], undefined);
  const count = app.workspace(session.id).operations.length;
  await ui.confirm();
  await ui.command(`/recovery ${job.jobId}`);
  assert.equal(app.workspace(session.id).operations.length, count);
  assert.equal((await app.ledger(session.workspace))!.result.ok, true);
  const restored = await restart();
  const reopened = new WorkspaceTui(restored, env);
  await reopened.initialize();
  reopened.sessionId = session.id;
  await reopened.command(`/recovery ${job.jobId}`);
  assert.match(reopened.lines().join("\n"), /restored/);
  assert.equal(restored.workspace(session.id).operations.length, count);
});

test("recovery conflict has no remaining apply action and status refresh never retries it", async (t) => {
  const { app, ui } = await fixture(t);
  await app.configure({
    baseUrl: "https://fixture.invalid/v1",
    apiKey: "fixture",
  });
  const session = await app.start("Conflict", "fixture");
  await app.settled();
  for (const content of ["first", "second"]) {
    await app.editDocument(session.id, {
      path: "conflict.md",
      content,
      expectedRevision: app.document(session.id, "conflict.md").revision,
    });
  }
  const operations = app.workspace(session.id).operations.map((op) => op.id);
  await ui.initialize();
  ui.sessionId = session.id;
  await ui.command(`/rewind ${operations.join(" ")}`);
  await app.editDocument(session.id, {
    path: "conflict.md",
    content: "newest",
    expectedRevision: app.document(session.id, "conflict.md").revision,
  });
  await assert.rejects(ui.confirm(), /stale/);
  assert.equal(ui.confirmation, undefined);
  assert.match(ui.lines().join("\n"), /conflict.md/);
  assert.match(ui.lines().join("\n"), /No automatic retry/);
  const count = app.workspace(session.id).operations.length;
  await ui.command("/recovery");
  await ui.confirm();
  assert.equal(app.workspace(session.id).operations.length, count);
  assert.equal(app.workspace(session.id).files["conflict.md"], "newest");
});

test("unknown recovery status stays read only at every supported width", async (t) => {
  const { app, ui } = await fixture(t);
  await app.configure({
    baseUrl: "https://fixture.invalid/v1",
    apiKey: "fixture",
  });
  const session = await app.start("Unknown recovery", "fixture");
  await app.settled();
  await ui.initialize();
  ui.sessionId = session.id;
  t.mock.method(app, "recoveryJobStatus", async () => ({
    jobId: "uncertain",
    status: "unknown",
    checkpoint: 0,
    outcomes: [],
    residuals: [{ operationId: "unconfirmed-operation", status: "unknown" }],
  }));
  const apply = t.mock.method(app, "applyRecoveryJob", async () => {
    throw Error("must not apply");
  });
  await ui.command("/recovery uncertain");
  assert.equal(ui.confirmation, undefined);
  assert.match(ui.lines().join("\n"), /unknown/);
  assert.match(ui.lines().join("\n"), /require reconciliation/);
  await ui.confirm();
  assert.equal(apply.mock.callCount(), 0);
  ui.queuePrompt("retain while recovery is unknown");
  await ui.command("/recovery uncertain");
  await assert.rejects(
    ui.command("/queue resume"),
    /unknown.*reconcile|reconcile.*unknown/i,
  );
  assert.equal(ui.queuedPrompt, "retain while recovery is unknown");
  ui.queuePrompt("retain while status is unavailable");
  t.mock.method(app, "recoveryJobStatus", async () => {
    throw Error("status unavailable");
  });
  await assert.rejects(ui.command("/recovery uncertain"), /status unavailable/);
  assert.equal(ui.takeQueued(), null);
  assert.equal(ui.queuedPrompt, "retain while status is unavailable");
  for (const width of [40, 80, 120, 200]) {
    const lines = stripAnsi(renderWorkspace(ui, width, 24)).split("\n");
    assert.ok(lines.length <= 24);
    assert.ok(lines.every((line) => visibleLength(line) <= width));
  }
});

test("queued text cannot drain through a confirmation", async (t) => {
  const { ui } = await fixture(t);
  ui.queuePrompt("keep this text");
  ui.confirmation = { title: "REVIEW", lines: [], apply: async () => {} };
  assert.equal(ui.takeQueued(), null);
  assert.equal(ui.queuedPrompt, "keep this text");
  ui.confirmation = undefined;
  assert.equal(ui.takeQueued(), "keep this text");
});

test("recovery holds queued text until explicit resume and never overrides unknown or stopping", async (t) => {
  const { app, ui } = await fixture(t);
  await app.configure({
    baseUrl: "https://fixture.invalid/v1",
    apiKey: "fixture",
  });
  const session = await app.start("Queue recovery", "fixture");
  await app.settled();
  for (const path of ["first.md", "second.md"])
    await app.editDocument(session.id, {
      path,
      content: "edit",
      expectedRevision: null,
    });
  await ui.initialize();
  ui.sessionId = session.id;
  ui.queuePrompt("later follow-up");
  await ui.command(
    `/rewind ${app
      .workspace(session.id)
      .operations.map((op) => op.id)
      .join(" ")}`,
  );
  assert.equal(ui.takeQueued(), null);
  ui.reject();
  assert.equal(
    ui.takeQueued(),
    null,
    "cancelling the review does not resume old intent",
  );
  await ui.command("/queue");
  assert.match(ui.lines().join("\n"), /paused/i);
  const run = app.runs()[0]!;
  let state = "unknown";
  const runs = t.mock.method(app, "runs", () => [{ ...run, state }]);
  await assert.rejects(ui.command("/queue resume"), /runtime|reconcile/i);
  assert.equal(ui.queuedPrompt, "later follow-up");
  state = "stopping";
  await assert.rejects(ui.command("/queue resume"), /runtime|reconcile/i);
  assert.equal(ui.takeQueued(), null);
  runs.mock.restore();
  await ui.command("/queue resume");
  assert.equal(ui.takeQueued(), "later follow-up");
});

test("/hook flips a saved hook without rewriting it", async (t) => {
  // `/hooks` reports what exists and `/hook-file` writes a new one from disk.
  // Nothing could take one off, which meant a hook an operator no longer
  // wanted could only be silenced by editing a JSON file outside the TUI.
  const root = await mkdtemp(join(tmpdir(), "nomo-tui-hook-edit-"));
  const env = {
    NOMO_DATA_DIR: root,
    NOMO_HOOK_COMMANDS: JSON.stringify(["echo"]),
  };
  const app = new Workbench(env, async (url) =>
    String(url).endsWith("/models")
      ? Response.json({ data: [{ id: "fixture" }] })
      : Response.json({
          choices: [
            { message: { role: "assistant", content: "Fixture reply" } },
          ],
        }),
  );
  assertIsolated(root, env);
  t.after(async () => {
    await app.shutdown();
    await rm(root, { recursive: true, force: true });
  });
  const ui = new WorkspaceTui(app, env);
  await ui.initialize();
  app.upsertHook({ id: "h1", event: "after-tool", command: "echo", enabled: true });
  assert.equal(app.agents().hooksSupported, true, "an allowlisted command makes hooks supported");

  await ui.command("/hook disable h1");
  const off = app.agents().hooks.find((hook) => hook.id === "h1");
  assert.equal(off?.enabled, false, "disable must turn the hook off");
  // The flag is the whole edit. Rewriting command or event would silently
  // detach the hook from whatever it was written to do.
  assert.equal(off?.command, "echo", "the command must survive the edit");
  assert.equal(off?.event, "after-tool", "so must the event");

  await ui.command("/hook enable h1");
  assert.equal(
    app.agents().hooks.find((hook) => hook.id === "h1")?.enabled,
    true,
    "enable must turn it back on",
  );

  await assert.rejects(ui.command("/hook disable nope"), /Unknown hook/);
  await assert.rejects(ui.command("/hook remove h1"), /enable id/);
});

test("/agents prints the system prompt it names as a field", async (t) => {
  const { app, ui } = await fixture(t);
  await ui.initialize();
  app.upsertAgent({
    id: "writer",
    name: "Writer",
    systemPrompt: "Only claim work the tool results prove.",
    allowedTools: ["void_workspace_write"],
    policyProfile: "default",
    maxTurns: 4,
    maxContextTokens: 4096,
  });
  await ui.command("/agents");
  const text = ui.lines().join("\n");
  // The listing told the operator systemPrompt was a field it could save, and
  // never printed one. A profile's prompt is its actual voice to the model, so
  // an operator checking what a profile would say found nothing to read.
  assert.match(text, /System prompt \/ \w+ *: Only claim work the tool results prove\./);

  app.upsertAgent({
    id: "quiet",
    name: "Quiet",
    systemPrompt: "   ",
    allowedTools: [],
    policyProfile: "default",
    maxTurns: 4,
    maxContextTokens: 4096,
  });
  await ui.command("/agents");
  assert.match(ui.lines().join("\n"), /System prompt \/ \w+ *: \(empty\)/);
});
test("subagent command is discoverable and delivery requires operator confirmation", async (t) => {
  assert.ok(commandSuggestions("/sub").some(([name]) => name === "/subagent"));
  const { app, ui } = await fixture(t);
  await app.configure({ baseUrl: "https://fixture.invalid/v1", apiKey: "fixture" });
  await ui.command("/help");
  assert.match(ui.lines().join("\n"), /\/subagent/);
  const parent = await app.start("Parent", "fixture");
  await app.settled();
  const child = await app.spawnSubagent(parent.id, "Delegated task");
  await app.settled();
  await ui.command(`/open ${child.id}`);
  await ui.command("/subagent review");
  assert.match(ui.confirmation!.title, /DELIVER SUBAGENT RESULT/);
  assert.match(ui.confirmation!.lines.join("\n"), new RegExp(`Child: ${child.id}`));
  assert.match(ui.confirmation!.lines.join("\n"), /Source: latest assistant completion/);
  assert.match(ui.confirmation!.lines.join("\n"), /Parent:/);
  assert.match(ui.confirmation!.lines.join("\n"), /Run:/);
  assert.match(ui.confirmation!.lines.join("\n"), /Status: idle/);
  assert.equal(app.get(parent.id)?.events.some((event) => event.text.includes(child.id)), false);
  await ui.confirm();
  assert.equal(
    app.get(parent.id)?.events.some((event) =>
      event.kind === "user" && event.text.includes(`Child: ${child.id}`),
    ),
    true,
  );
});

test("branch clones cannot use spawned-child TUI actions", async (t) => {
  const { app, ui } = await fixture(t);
  await app.configure({ baseUrl: "https://fixture.invalid/v1", apiKey: "fixture" });
  const parent = await app.start("Parent", "fixture");
  await app.settled();
  const userEvent = app.get(parent.id)!.events.find((event) => event.kind === "user")!;
  const branch = await app.branch(parent.id, {
    seq: userEvent.seq,
    idempotencyKey: "branch-clone",
  });
  await ui.command(`/open ${branch.id}`);
  await assert.rejects(ui.command("/subagent cancel"), /not a verified child/i);
  assert.equal(ui.confirmation, undefined);
});

test("subagent preview escapes terminal controls and truncation has no accept action", async (t) => {
  const { app, ui } = await fixture(t, "\u001b[31m" + "x".repeat(256));
  await app.configure({ baseUrl: "https://fixture.invalid/v1", apiKey: "fixture" });
  await app.patchHarnessSettings({ maxPromptCharacters: 256 });
  const parent = await app.start("Parent", "fixture");
  await app.settled();
  const child = await app.spawnSubagent(parent.id, "Delegated task");
  await app.settled();
  await ui.command(`/open ${child.id}`);
  await ui.command("/subagent review");
  assert.equal(ui.confirmation, undefined);
  assert.match(ui.detail!.join("\n"), /may be incomplete/);
  assert.doesNotMatch(ui.detail!.join("\n"), /\u001b/);
  assert.match(ui.detail!.join("\n"), /\\u001b/);
  await assert.rejects(
    app.deliverSubagentResult(parent.id, child.id, child.runId!),
    /may be truncated/i,
  );
});
test("running subagent cancellation requires confirmation and preserves capacity", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "nomo-tui-subagent-stop-"));
  const env = { NOMO_DATA_DIR: root };
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  let calls = 0;
  const app = new Workbench(env, async (url) => {
    if (String(url).endsWith("/models")) return Response.json({ data: [{ id: "fixture" }] });
    if (calls++ === 0)
      return Response.json({ choices: [{ message: { role: "assistant", content: "Parent done" }, finish_reason: "stop" }] });
    await blocked;
    return Response.json({ choices: [{ message: { role: "assistant", content: "Late child output" }, finish_reason: "stop" }] });
  });
  assertIsolated(root, env);
  t.after(async () => {
    release();
    await app.shutdown();
    await rm(root, { recursive: true, force: true });
  });
  await app.configure({ baseUrl: "https://fixture.invalid/v1", apiKey: "fixture" });
  await app.patchHarnessSettings({ maxConcurrentRuns: 1 });
  const parent = await app.start("Parent", "fixture");
  await app.settled();
  const child = await app.spawnSubagent(parent.id, "Child");
  const ui = new WorkspaceTui(app, env);
  await ui.command(`/open ${child.id}`);
  await ui.command("/subagent cancel");
  assert.match(ui.confirmation!.title, /CANCEL RUNNING SUBAGENT/);
  assert.equal(app.get(child.id)?.state, "running");
  await ui.confirm();
  assert.equal(app.get(child.id)?.state, "stopping");
  release();
  await app.settled();
  assert.equal(app.get(child.id)?.state, "stopped");
  assert.equal(app.get(child.id)?.events.some((event) => event.text === "Late child output"), false);
});
test("queued spawned-child cancellation is immediate and safe in the TUI", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "nomo-tui-subagent-queue-cancel-"));
  const env = { NOMO_DATA_DIR: root };
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  let calls = 0;
  const app = new Workbench(env, async (url) => {
    if (String(url).endsWith("/models")) return Response.json({ data: [{ id: "fixture" }] });
    calls++;
    await blocked;
    return Response.json({ choices: [{ message: { role: "assistant", content: "Done" }, finish_reason: "stop" }] });
  });
  assertIsolated(root, env);
  t.after(async () => {
    release();
    await app.shutdown();
    await rm(root, { recursive: true, force: true });
  });
  await app.configure({ baseUrl: "https://fixture.invalid/v1", apiKey: "fixture" });
  const parent = await app.start("Parent", "fixture");
  const child = await app.spawnSubagent(parent.id, "Queued child");
  const ui = new WorkspaceTui(app, env);
  await ui.command(`/open ${child.id}`);
  await ui.command("/subagent cancel");
  assert.equal(ui.confirmation, undefined);
  assert.equal(app.get(child.id)?.status, "cancelled");
  release();
  await app.settled();
  assert.equal(calls, 1);
});
test("queued cancel rechecks the child after verification before choosing confirmation", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "nomo-tui-subagent-race-"));
  const env = { NOMO_DATA_DIR: root };
  let releaseParent!: () => void;
  let releaseChild!: () => void;
  let childStarted!: () => void;
  const parentBlocked = new Promise<void>((resolve) => { releaseParent = resolve; });
  const childBlocked = new Promise<void>((resolve) => { releaseChild = resolve; });
  const childRequestStarted = new Promise<void>((resolve) => { childStarted = resolve; });
  let requests = 0;
  const app = new Workbench(env, async (url) => {
    if (String(url).endsWith("/models")) return Response.json({ data: [{ id: "fixture" }] });
    if (requests++ === 0) await parentBlocked;
    else {
      childStarted();
      await childBlocked;
    }
    return Response.json({ choices: [{ message: { role: "assistant", content: "Done" } }] });
  });
  assertIsolated(root, env);
  t.after(async () => {
    releaseParent();
    releaseChild();
    await app.shutdown();
    await rm(root, { recursive: true, force: true });
  });
  await app.configure({ baseUrl: "https://fixture.invalid/v1", apiKey: "fixture" });
  await app.patchHarnessSettings({ maxConcurrentRuns: 1 });
  const parent = await app.start("Parent", "fixture");
  const child = await app.spawnSubagent(parent.id, "Queued child");
  assert.equal(child.status, "queued");
  const verify = app.verifySubagent.bind(app);
  app.verifySubagent = async (parentId, childId) => {
    releaseParent();
    await childRequestStarted;
    await verify(parentId, childId);
  };
  const ui = new WorkspaceTui(app, env);
  await ui.command(`/open ${child.id}`);
  await ui.command("/subagent cancel");
  assert.match(ui.confirmation!.title, /CANCEL RUNNING SUBAGENT/);
  assert.equal(app.get(child.id)?.status, "running");
  await ui.confirm();
  assert.equal(app.get(child.id)?.state, "stopping");
  releaseChild();
  await app.settled();
  assert.equal(app.get(child.id)?.state, "stopped");
});

test("project confirmation exposes full-project data risk and requires an explicit confirm", async (t) => {
  const { app, env } = await fixture(t);
  await app.configure({ baseUrl: "https://fixture.invalid/v1", apiKey: "fixture" });
  const root = await mkdtemp(join(tmpdir(), "nomo-project-consent-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  execFileSync("git", ["init", "--quiet", root]);
  const ui = new WorkspaceTui(app, env);
  ui.prepareProjectAccess(root, [], "unavailable: no local image");
  assert.match(ui.confirmation!.title, /ALLOW THIS PROJECT/);
  assert.match(ui.confirmation!.lines.join("\n"), /Secrets inside this project are not protected/);
  assert.match(ui.confirmation!.lines.join("\n"), /command arguments, and command output/);
  await ui.confirm();
  assert.match(ui.notice, /Project access confirmed/);
  assert.equal(ui.confirmation, undefined);
});

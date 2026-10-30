import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Workbench } from "../../../workbench/src/index.ts";
import { WorkspaceTui, renderWorkspace } from "./workspace.ts";
import { stripAnsi, visibleLength } from "./layout.ts";

async function fixture(t: test.TestContext) {
  const root = await mkdtemp(join(tmpdir(), "nomo-parity-controls-"));
  const env = { NOMO_DATA_DIR: root };
  let app = new Workbench(env, async (url) =>
    String(url).endsWith("/models")
      ? Response.json({ data: [{ id: "fixture" }] })
      : Response.json({
          choices: [
            { message: { role: "assistant", content: "Fixture reply" } },
          ],
        }),
  );
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
      return app;
    },
  };
}

test("filtering to no sessions explains the empty result", async (t) => {
  const { ui } = await fixture(t);
  await ui.initialize();
  await ui.command("/sessions nomo-filter-miss");

  assert.match(ui.lines()[0]!, /no entries match \"nomo-filter-miss\"/i);
});

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
  assert.equal(ui.tab, "overview");
  assert.equal(ui.items().length, 1);
  assert.match(ui.items()[0]!.label, /idle/);
  assert.match(ui.items()[0]!.label, /progress unknown/);
  assert.doesNotMatch(ui.lines().join("\n"), /Completed runs/);
  await ui.openSelected();
  assert.match(ui.lines().join("\n"), /runId/);
  assert.equal(ui.sessionId, session.id);
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
      createdAt: null,
      updatedAt: null,
      durationMs: null,
      steps: 0,
      legacy: false,
      reconcileRequired: true,
    },
  ]);
  await ui.command("/runs");
  assert.match(ui.items()[0]!.label, /unknown.*reconciliation required/);
  await ui.openSelected();
  assert.match(ui.lines().join("\n"), /started\s*:\s*unknown/);
  assert.match(ui.lines().join("\n"), /ended\s*:\s*unknown/);
  await ui.command("/status");
  assert.match(ui.lines().join("\n"), /Run: unknown.*reconciliation required/);
  for (const width of [40, 80, 120, 200]) {
    const lines = stripAnsi(renderWorkspace(ui, width, 24)).split("\n");
    assert.ok(lines.length <= 24);
    assert.ok(lines.every((line) => visibleLength(line) <= width));
  }
});

test("run inspector shows trusted session identity and latest event metadata", async (t) => {
  const { app, ui } = await fixture(t);
  await app.configure({
    baseUrl: "https://fixture.invalid/v1",
    apiKey: "fixture",
  });
  const agent = app.agents().agents[1]!.id;
  const session = await app.start(
    "Inspect this run",
    "fixture",
    undefined,
    undefined,
    agent,
  );
  await app.settled();
  const view = app.get(session.id)!;
  const latest = view.events.at(-1)!;

  await ui.initialize();
  await ui.command("/runs");
  await ui.openSelected();

  const detail = ui.lines().join("\n");
  assert.ok(detail.includes(view.workspace));
  assert.match(detail, /agent\s*:/);
  assert.ok(detail.includes(agent));
  assert.ok(detail.includes(`${latest.type ?? latest.kind} at ${latest.at}`));
  assert.ok(!detail.includes(latest.text));

  const runLabel = ui.items()[0]!.label;
  for (const width of [80, 119, 120, 139, 140, 159, 160]) {
    const frame = stripAnsi(renderWorkspace(ui, width, 24));
    const rows = frame.split("\n");
    assert.ok(rows.length <= 24);
    assert.ok(rows.every((line) => visibleLength(line) <= width));
    assert.ok(!frame.includes(latest.text));
    if (width < 140) {
      assert.ok(!frame.includes(runLabel));
    } else {
      assert.ok(frame.includes(runLabel));
      assert.ok(frame.includes(view.workspace.slice(0, 18)));
    }
    if (width >= 160) assert.match(frame, /›\s*overview/);
    if (width >= 160)
      assert.ok(
        frame.includes(`${latest.type ?? latest.kind} at ${latest.at}`),
      );
  }
});

test("session inspector counts events from the full Workbench view", async (t) => {
  const { app, ui } = await fixture(t);
  await app.configure({
    baseUrl: "https://fixture.invalid/v1",
    apiKey: "fixture",
  });
  const session = await app.start("Count real history", "fixture");
  await app.settled();
  const view = app.get(session.id)!;
  assert.equal(app.list()[0]!.events.length, 0);
  assert.ok(view.events.length > 0);
  const messages = view.events.filter(
    (event) =>
      event.type === "message.completed" ||
      (!event.type && (event.kind === "user" || event.kind === "assistant")),
  ).length;
  const tools = view.events.filter(
    (event) => event.type === "tool.started" || event.type === "tool.result",
  ).length;
  const errors = view.events.filter(
    (event) => event.kind === "error" || event.type === "run.error",
  ).length;

  await ui.initialize();
  await ui.command("/sessions");
  await ui.openSelected();

  const detail = ui.lines().join("\n");
  assert.ok(messages > 0);
  assert.match(detail, new RegExp(`messages\\s*:\\s*${messages}`));
  assert.match(detail, new RegExp(`tool calls\\s*:\\s*${tools}`));
  assert.match(detail, new RegExp(`errors\\s*:\\s*${errors}`));
  assert.match(
    detail,
    new RegExp(
      `last event\\s*:\\s*${view.events.at(-1)!.type} at ${view.events.at(-1)!.at}`,
    ),
  );
});

test("wide session inspector keeps the session list visible beside its detail", async (t) => {
  const { app, ui } = await fixture(t);
  await app.configure({
    baseUrl: "https://fixture.invalid/v1",
    apiKey: "fixture",
  });
  const session = await app.start("Wide session inspector", "fixture");
  await app.settled();
  await ui.initialize();
  await ui.command("/sessions");
  await ui.openSelected();

  const selected = ui.items()[0]!.label;
  const wide = stripAnsi(renderWorkspace(ui, 160, 32));
  assert.ok(wide.includes(selected));
  assert.ok(wide.includes("CONVERSATION"));
  assert.ok(wide.includes("messages"));
  assert.ok(wide.includes(session.id));

  const belowBreakpoint = stripAnsi(renderWorkspace(ui, 139, 24));
  assert.ok(!belowBreakpoint.includes(selected));
  assert.ok(belowBreakpoint.includes("CONVERSATION"));

  const medium = stripAnsi(renderWorkspace(ui, 140, 24));
  assert.ok(medium.includes(selected));
  assert.ok(medium.includes("CONVERSATION"));

  const narrow = stripAnsi(renderWorkspace(ui, 80, 24));
  assert.ok(narrow.includes("CONVERSATION"));
  assert.ok(!narrow.includes(selected));
});

test("wide document inspector keeps its list beside selected document detail", async (t) => {
  const { app, ui } = await fixture(t);
  await app.configure({
    baseUrl: "https://fixture.invalid/v1",
    apiKey: "fixture",
  });
  const session = await app.start("Wide document inspector", "fixture");
  await app.settled();
  await app.editDocument(session.id, {
    path: "notes.md",
    content: "Inspected document",
    expectedRevision: null,
  });
  await ui.initialize();
  await ui.command("/documents");
  await ui.openSelected();

  const selected = ui.items()[0]!.label;
  const wide = stripAnsi(renderWorkspace(ui, 160, 32));
  assert.ok(wide.includes(selected));
  assert.ok(wide.includes("notes.md"));
  assert.ok(wide.includes(session.id));
});

test("wide ledger inspector keeps verified entry list beside selected proof detail", async (t) => {
  const { app, ui } = await fixture(t);
  await app.configure({
    baseUrl: "https://fixture.invalid/v1",
    apiKey: "fixture",
  });
  const session = await app.start("Wide ledger inspector", "fixture");
  await app.settled();
  await app.editDocument(session.id, {
    path: "proof.md",
    content: "Verified evidence",
    expectedRevision: null,
  });
  await ui.initialize();
  await ui.command("/ledger");
  const entryIndex = ui
    .items()
    .findIndex((item) => item.id.includes(session.id));
  assert.ok(entryIndex >= 0);
  ui.selected = entryIndex;
  await ui.openSelected();

  const wide = stripAnsi(renderWorkspace(ui, 160, 32));
  assert.ok(wide.includes("MANAGED LEDGER"));
  assert.ok(wide.includes(session.id.slice(0, 8)));
  assert.ok(wide.includes("void_workspace_write"));
  assert.ok(wide.includes("verified"));
});

test("wide approval inspector keeps the hold list beside its detail", async (t) => {
  const { app, ui } = await fixture(t);
  t.mock.method(app, "approvals", () => [
    {
      holdId: "hold-fixture",
      status: "pending",
      call: { tool: "write_file", klass: "R3", reason: "review required" },
      expiresAt: Date.now() + 60_000,
    },
  ]);
  await ui.initialize();
  await ui.command("/approvals");
  await ui.openSelected();

  const selected = ui.items()[0]!.label;
  const wide = stripAnsi(renderWorkspace(ui, 160, 32));
  assert.ok(wide.includes(selected));
  assert.ok(wide.includes("review required"));
  assert.ok(wide.includes("write_file"));
});

test("wide tool inspector keeps the tool list beside its schema without executing it", async (t) => {
  const { app, ui } = await fixture(t);
  await ui.initialize();
  const before = app.list().length;
  await ui.command("/tools");
  await ui.openSelected();

  const selected = ui.items()[0]!.label;
  const selectedName = selected.split(" / ", 1)[0]!.split(" ").at(-1)!;
  const detail = ui.detail!.join("\n");
  assert.match(detail, /no input properties|PROPERTIES|INPUT SCHEMA/);
  assert.equal(app.list().length, before, "inspection does not create a run");

  const wide = stripAnsi(renderWorkspace(ui, 160, 32));
  assert.ok(wide.includes(selected));
  assert.ok(wide.includes("Scope: new conversations"));

  const narrow = stripAnsi(renderWorkspace(ui, 80, 24));
  assert.ok(narrow.includes("Scope: new conversations"));
  assert.ok(narrow.includes(selectedName));
});

test("wide usage inspector keeps the usage list beside provider token detail", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "nomo-tui-usage-wide-"));
  const env = { NOMO_DATA_DIR: root };
  const app = new Workbench(env, async (url) =>
    String(url).endsWith("/models")
      ? Response.json({ data: [{ id: "fixture" }] })
      : Response.json({
          choices: [
            { message: { role: "assistant", content: "Fixture reply" } },
          ],
          usage: { prompt_tokens: 12, completion_tokens: 7, total_tokens: 19 },
        }),
  );
  t.after(async () => {
    await app.shutdown();
    await rm(root, { recursive: true, force: true });
  });
  await app.configure({
    baseUrl: "https://fixture.invalid/v1",
    apiKey: "fixture",
  });
  const ui = new WorkspaceTui(app, env);
  await ui.initialize();
  await ui.command("start here");
  await app.settled();
  await ui.command("/usage");
  assert.ok(
    ui.items().length > 0,
    JSON.stringify(app.get(ui.sessionId!)?.events.map((event) => event.kind)),
  );
  const selected = ui.items()[0]!.label;
  await ui.openSelected();
  assert.match(ui.detail!.join("\n"), /19/);
  assert.match(ui.detail!.join("\n"), /provider/);

  const wide = stripAnsi(renderWorkspace(ui, 160, 32));
  assert.ok(wide.includes(selected));
  assert.ok(wide.includes("provider"));

  const narrow = stripAnsi(renderWorkspace(ui, 80, 24));
  assert.ok(narrow.includes("provider"));
  assert.ok(!narrow.includes(selected));
});

test("wide model inspector keeps the model list beside read-only selection detail", async (t) => {
  const { app, ui } = await fixture(t);
  await app.configure({
    baseUrl: "https://fixture.invalid/v1",
    apiKey: "fixture",
  });
  await ui.initialize();
  await ui.command("/models");
  assert.ok(ui.items().length > 0);
  const model = ui.items()[0]!.label;
  const selectedBefore = ui.model;
  await ui.openSelected();
  assert.equal(ui.model, selectedBefore);
  assert.match(ui.detail!.join("\n"), /MODEL/);

  const wide = stripAnsi(renderWorkspace(ui, 160, 32));
  assert.ok(wide.includes(model));
  assert.ok(wide.includes("MODEL"));

  const narrow = stripAnsi(renderWorkspace(ui, 80, 24));
  assert.ok(narrow.includes("MODEL"));
  assert.ok(!narrow.includes(model));
});

test("wide inspector scrolls long detail independently from its selected row", async (t) => {
  const { app, ui } = await fixture(t);
  await ui.initialize();
  await ui.command("/tools");
  await ui.openSelected();
  ui.detail = Array.from({ length: 60 }, (_, index) => `DETAIL FIELD ${index}`);

  const first = stripAnsi(renderWorkspace(ui, 160, 24));
  assert.ok(first.includes("DETAIL FIELD 0"));
  ui.scrollPage(1);
  const next = stripAnsi(renderWorkspace(ui, 160, 24));
  assert.ok(!next.includes("DETAIL FIELD 0"));
  assert.ok(next.includes("DETAIL FIELD 1"));
  assert.ok(next.includes(ui.items()[ui.selected]!.label));
});

test("wide policy inspector keeps connector list visible beside its detail", async (t) => {
  const { ui } = await fixture(t);
  await ui.initialize();
  await ui.command("/policy");
  await ui.openSelected();

  const selected = ui.items()[0]!.label;
  const wide = stripAnsi(renderWorkspace(ui, 160, 32));
  assert.ok(wide.includes(selected));
  assert.ok(wide.includes("CONSENT"));
  assert.ok(wide.includes("NOMO documents"));

  const narrow = stripAnsi(renderWorkspace(ui, 80, 24));
  assert.ok(narrow.includes("CONSENT"));
  assert.ok(!narrow.includes(selected));
});

test("provider status and setup action never hide unavailable NVIDIA behind another provider", async (t) => {
  const { app, ui } = await fixture(t);
  await ui.initialize();
  await ui.command("/status");
  assert.match(ui.lines().join("\n"), /setup-required/);
  await ui.command("/connect");
  assert.match(ui.notice, /NVIDIA_API_KEY/);
  // No provider is configured, so there is no provider id to report. The
  // decision to ship no default deletes this assertion's premise: a workspace
  // that has chosen nothing says nothing rather than naming a vendor.
  assert.equal((await app.providerState()).providerId, null);
  ui.provider = {
    ...ui.provider!,
    connected: true,
    status: "rate-limited",
    detail: "Provider rate limit reached.",
    retryAt: "2026-09-22T12:00:00.000Z",
  };
  await ui.command("/status");
  assert.match(ui.lines().join("\n"), /rate-limited/);
  assert.match(ui.lines().join("\n"), /2026-09-22T12:00:00.000Z/);
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
  t.after(async () => {
    await app.shutdown();
    await rm(root, { recursive: true, force: true });
  });
  const ui = new WorkspaceTui(app, env);
  await ui.initialize();
  app.upsertHook({
    id: "h1",
    event: "after-tool",
    command: "echo",
    enabled: true,
  });
  assert.equal(
    app.agents().hooksSupported,
    true,
    "an allowlisted command makes hooks supported",
  );

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
  assert.match(
    text,
    /System prompt \/ \w+ *: Only claim work the tool results prove\./,
  );

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

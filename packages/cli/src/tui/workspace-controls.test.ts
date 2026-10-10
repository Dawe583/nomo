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
      createdAt: session.createdAt,
      updatedAt: session.createdAt,
      durationMs: null,
      steps: 0,
      legacy: false,
      reconcileRequired: true,
    },
  ]);
  await ui.command("/runs");
  assert.match(ui.items()[0]!.label, /unknown.*reconciliation required/);
  await ui.command("/status");
  assert.match(ui.lines().join("\n"), /Run: unknown.*reconciliation required/);
  for (const width of [40, 80, 120, 200]) {
    const lines = stripAnsi(renderWorkspace(ui, width, 24)).split("\n");
    assert.ok(lines.length <= 24);
    assert.ok(lines.every((line) => visibleLength(line) <= width));
  }
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
    allowedTools: ["nomo_workspace_read"],
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
    allowedTools: ["nomo_workspace_write"],
    policyProfile: "default",
    maxTurns: 4,
    maxContextTokens: 4096,
  });
  await ui.command("/agents");
  const text = ui.lines().join("\n");
  // The listing told the operator systemPrompt was a field it could save, and
  // never printed one. A profile's prompt is its actual voice to the model, so
  // an operator checking what a profile would say found nothing to read.
  assert.match(text, /System prompt: Only claim work the tool results prove\./);

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
  assert.match(ui.lines().join("\n"), /System prompt: \(empty\)/);
});

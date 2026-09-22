import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Workbench } from "../../../workbench/src/index.ts";
import { WorkspaceTui, renderWorkspace } from "./workspace.ts";
import { stripAnsi, visibleLength } from "./layout.ts";

async function fixture(t: test.TestContext) {
  const root = await mkdtemp(join(tmpdir(), "void-parity-controls-"));
  const env = { VOID_DATA_DIR: root };
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
  assert.equal((await app.providerState()).providerId, "nvidia");
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
  const file = join(env.VOID_DATA_DIR, "project.json");
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
  await ui.command("/compact");
  assert.match(ui.confirmation!.title, /COMPACT CONTEXT/);
  assert.equal(app.get(id)!.events.length, before, "review is read only");
  await ui.confirm();
  assert.equal(ui.confirmation, undefined);
  assert.match(ui.lines().join("\n"), /Omitted messages: [1-9]/);
  assert.match(ui.lines().join("\n"), /Retained message IDs:/);
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

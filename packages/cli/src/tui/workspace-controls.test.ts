import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Workbench } from "../../../workbench/src/index.ts";
import { WorkspaceTui, renderWorkspace } from "./workspace.ts";
import { stripAnsi, visibleLength } from "./layout.ts";

async function fixture(t: test.TestContext) {
  const root = await mkdtemp(join(tmpdir(), "void-parity-controls-"));
  const env = { VOID_DATA_DIR: root };
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
  return { app, env, ui: new WorkspaceTui(app, env) };
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

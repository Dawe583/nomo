import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Workbench } from "../../../workbench/src/index.ts";
import { assertIsolated } from "../../../workbench/src/test-fixture.ts";
import {
  HARNESS_SETTINGS,
  type HarnessSettingKey,
} from "../../../workbench/src/harness-settings.ts";
import { WorkspaceTui, commandSuggestions } from "./workspace.ts";

/**
 * A limit nobody can change is a limit nobody chose. /settings is the surface
 * that makes each run bound legible and settable, so what these tests pin down
 * is what an operator is told: every limit listed with the value in force, a
 * set that names itself, and a refusal that changes nothing.
 */

const assistantFetcher = async (url: unknown) =>
  String(url).endsWith("/models")
    ? Response.json({ data: [{ id: "fixture" }] })
    : Response.json({
        choices: [{ message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
      });

async function settings(t: {
  after(fn: () => Promise<void>): void;
}): Promise<{ ui: WorkspaceTui; app: Workbench }> {
  const root = await mkdtemp(join(tmpdir(), "nomo-tui-settings-"));
  const env = { NOMO_DATA_DIR: root };
  const app = new Workbench(env, assistantFetcher);
  assertIsolated(root, env);
  await app.configure({
    baseUrl: "https://fixture.test/v1",
    apiKey: "fixture-key",
  });
  t.after(async () => {
    await app.shutdown();
    await rm(root, { recursive: true, force: true });
  });
  const ui = new WorkspaceTui(app, env);
  await ui.initialize();
  return { ui, app };
}

const keys = Object.keys(HARNESS_SETTINGS) as HarnessSettingKey[];

test("/settings with no argument lists every limit and the value in force", async (t) => {
  const { ui, app } = await settings(t);
  await ui.command("/settings");

  const shown = ui.lines().join("\n");
  for (const key of keys) {
    assert.match(shown, new RegExp(`\\b${key}\\b`), `${key} is not listed`);
    const spec = HARNESS_SETTINGS[key];
    // The range belongs on the row: a number an operator cannot bound is a
    // number they have to guess at.
    assert.match(
      shown,
      new RegExp(`\\[${spec.min}-${spec.max}\\]`),
      `${key} does not show its allowed range`,
    );
  }
  assert.match(shown, /maxTurns\s+20/, "the current value is not shown");
  // Every default agrees with a hardcoded table, so listing at defaults proves
  // nothing about the wiring. A configured value does: the row has to move
  // with the stored setting, and a table of literals would still print 20.
  app.patchHarnessSettings({ maxTurns: 7, maxRequestBytes: 2048 });
  await ui.command("/settings");
  const configured = ui.lines().join("\n");
  assert.match(configured, /maxTurns\s+7/, "the row did not follow the setting");
  assert.match(
    configured,
    /maxRequestBytes\s+2048/,
    "the row did not follow the setting",
  );
  assert.match(
    configured,
    /maxOutputTokens\s+4096/,
    "an untouched limit must still show its own value",
  );
  assert.match(configured, /maxTurns\s+7\s+\[1-20\]\s+\(changed\)/);
  assert.ok(
    commandSuggestions("/sett").some(([name]) => name === "/settings"),
    "the command is not discoverable in the palette",
  );
  // Listing is read-only: it must not have moved a limit on the way past.
  assert.equal(
    app.harnessSettings().maxQueuedRuns,
    HARNESS_SETTINGS.maxQueuedRuns.default,
  );
});

test("/settings key value changes the limit and the notice names it", async (t) => {
  const { ui, app } = await settings(t);

  await ui.command("/settings maxTurns 5");

  assert.equal(app.harnessSettings().maxTurns, 5);
  assert.match(ui.notice, /Turns per run is now 5/);
  assert.match(ui.lines().join("\n"), /maxTurns\s+5/);
  // The change is marked, so a set value reads differently from a default.
  assert.match(ui.lines().join("\n"), /\(changed\)/);

  // A second limit is independent: one patch must not move a neighbour.
  await ui.command("/settings maxQueuedRuns 3");
  assert.equal(app.harnessSettings().maxTurns, 5);
  assert.equal(app.harnessSettings().maxQueuedRuns, 3);
  assert.match(ui.notice, /Queued background runs is now 3/);
});

test("an unknown setting is refused by name and changes nothing", async (t) => {
  const { ui, app } = await settings(t);
  const before = { ...app.harnessSettings() };

  await assert.rejects(
    ui.command("/settings nonsense 5"),
    /Unknown harness setting nonsense/,
  );
  assert.deepEqual({ ...app.harnessSettings() }, before);
});

test("a non-numeric value is refused and never becomes NaN", async (t) => {
  const { ui, app } = await settings(t);
  const before = { ...app.harnessSettings() };

  await assert.rejects(
    ui.command("/settings maxTurns abc"),
    /maxTurns: abc is not a number/,
  );
  // The dangerous outcome is a NaN reaching the clamp and becoming the
  // minimum, which an operator would read as a limit they had chosen.
  assert.deepEqual({ ...app.harnessSettings() }, before);
  assert.ok(
    Object.values(app.harnessSettings()).every((value) => Number.isFinite(value)),
    "a non-finite limit was stored",
  );

  // A key with no value is a usage error, not an implicit clear.
  await assert.rejects(ui.command("/settings maxTurns"), /\/settings key value/);
  assert.deepEqual({ ...app.harnessSettings() }, before);
});

test("a value outside the range is clamped and the notice names what took effect", async (t) => {
  const { ui, app } = await settings(t);

  await ui.command("/settings maxTurns 9999");

  // Clamping upward would let a harness turn count exceed what an agent
  // profile may carry, so the ceiling wins and the notice names the ceiling.
  assert.equal(app.harnessSettings().maxTurns, HARNESS_SETTINGS.maxTurns.max);
  assert.match(ui.notice, new RegExp(`is now ${HARNESS_SETTINGS.maxTurns.max}\\b`));
});

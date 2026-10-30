import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Workbench } from "../../../workbench/src/index.ts";
import {
  HARNESS_SETTINGS,
  type HarnessSettingKey,
} from "../../../workbench/src/harness-settings.ts";
import {
  WorkspaceTui,
  commandSuggestions,
  renderWorkspace,
} from "./workspace.ts";
import { stripAnsi, visibleLength } from "./layout.ts";

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
        choices: [{ message: { role: "assistant", content: "ok" } }],
      });

async function settings(t: { after(fn: () => Promise<void>): void }): Promise<{
  ui: WorkspaceTui;
  app: Workbench;
  env: { NOMO_DATA_DIR: string };
  replaceForRestart(app: Workbench): void;
}> {
  const root = await mkdtemp(join(tmpdir(), "nomo-tui-settings-"));
  const env = { NOMO_DATA_DIR: root };
  const app = new Workbench(env, assistantFetcher);
  await app.configure({
    baseUrl: "https://fixture.test/v1",
    apiKey: "fixture-key",
  });
  let activeApp = app;
  t.after(async () => {
    await activeApp.shutdown();
    await rm(root, { recursive: true, force: true });
  });
  const ui = new WorkspaceTui(app, env);
  await ui.initialize();
  return {
    ui,
    app,
    env,
    replaceForRestart: (next: Workbench) => {
      activeApp = next;
    },
  };
}

const keys = Object.keys(HARNESS_SETTINGS) as HarnessSettingKey[];

test("/settings search finds real preference and harness values without exposing secrets", async (t) => {
  const { ui } = await settings(t);
  await ui.command("/settings search provider retry");
  const result = ui.detail?.join("\n") ?? "";
  assert.match(result, /retryAttempts/);
  assert.match(result, /Workbench effective limit/);
  assert.match(result, /default:/);
  assert.doesNotMatch(result, /fixture-key/);
  assert.doesNotMatch(result, /apiKey/);
  assert.doesNotMatch(result, /not-such-setting/);
  for (const width of [40, 80, 120]) {
    const frame = renderWorkspace(ui, width, 24, "", false, false, {
      color: false,
      motion: false,
    });
    assert.ok(frame.split("\n").every((line) => visibleLength(line) <= width));
    assert.match(stripAnsi(frame), /SETTINGS SEARCH/);
    assert.match(stripAnsi(frame), /retryAttempts/);
  }
  const colorFrame = renderWorkspace(ui, 80, 40, "", false, false, {
    color: true,
    colorDepth: 8,
    motion: false,
  });
  const colorRows = colorFrame.split("\n");
  for (const label of [
    "SETTINGS SEARCH",
    "Workspace and Storage / Provider retry attempts (retryAttempts)",
  ]) {
    const row = colorRows.find((line) => line.includes(label));
    assert.ok(row);
    assert.ok(row.includes("\x1b[1;38;5;117m"), JSON.stringify({ label, row }));
  }
});

test("/settings lists authoritative preference values, defaults, sources, and editability", async (t) => {
  const { ui } = await settings(t);
  await ui.command("/settings");
  const shown = ui.lines().join("\n");

  assert.match(shown, /APPLICATION SETTINGS/);
  for (const key of [
    "appearance",
    "defaultAgentPreset",
    "defaultModel",
    "defaultProvider",
    "locale",
    "sendBehavior",
    "toolOutput",
  ])
    assert.match(shown, new RegExp(`\\b${key}\\b`));
  assert.match(shown, /MODELS AND PROVIDERS/);
  assert.match(shown, /default: not configured/);
  assert.match(shown, /value: fixture/);
  assert.match(shown, /source:/);
  assert.match(shown, /editability:/);
  assert.equal((shown.match(/maxTurns/g) ?? []).length, 1);
  assert.doesNotMatch(shown, /fixture-key/);
  for (const width of [40, 80, 120, 160]) {
    const frame = renderWorkspace(ui, width, 10, "", false, false, {
      color: false,
      motion: false,
    });
    assert.ok(frame.split("\n").length <= 10);
    assert.ok(frame.split("\n").every((line) => visibleLength(line) <= width));
  }
  const colorFrame = renderWorkspace(ui, 80, 48, "", false, false, {
    color: true,
    colorDepth: 8,
    motion: false,
  });
  const colorRows = colorFrame.split("\n");
  for (const label of [
    "APPLICATION SETTINGS",
    "APPEARANCE",
    "CONVERSATION",
    "MODELS AND PROVIDERS",
    "Appearance (appearance)",
  ]) {
    const row = colorRows.find((line) => line.includes(label));
    assert.ok(row);
    assert.ok(row.includes("\x1b[1;38;5;117m"), JSON.stringify({ label, row }));
  }
});

test("sendBehavior setting survives restart and refuses unsupported values", async (t) => {
  const { ui, app, env, replaceForRestart } = await settings(t);
  await ui.command("/settings sendBehavior mod-enter");
  assert.equal(app.getPreferences().sendBehavior, "mod-enter");
  assert.match(ui.lines().join("\n"), /value: mod-enter/);

  await assert.rejects(
    ui.command("/settings sendBehavior anything"),
    /sendBehavior enter\|mod-enter/,
  );
  assert.equal(app.getPreferences().sendBehavior, "mod-enter");
  await assert.rejects(
    ui.command("/settings sendBehavior enter extra"),
    /sendBehavior enter\|mod-enter/,
  );
  assert.equal(app.getPreferences().sendBehavior, "mod-enter");

  await app.shutdown();
  const restored = new Workbench(env, assistantFetcher);
  replaceForRestart(restored);
  assert.equal(restored.getPreferences().sendBehavior, "mod-enter");
});

test("tool output setting reuses the current TUI preference without claiming persistence", async (t) => {
  const { ui } = await settings(t);
  assert.equal(ui.compactTools, true);
  await ui.command("/settings toolOutput full");
  assert.equal(ui.compactTools, false);
  assert.match(ui.notice, /Tool output is now full/);
  await assert.rejects(
    ui.command("/settings toolOutput verbose"),
    /compact\|full/,
  );
  assert.equal(ui.compactTools, false);
});

test("/settings search reports no matches without hiding how to exit", async (t) => {
  const { ui } = await settings(t);
  await ui.command("/settings search no-such-setting");
  const result = ui.detail?.join("\n") ?? "";
  assert.match(result, /No settings match/);
  assert.match(result, /\/settings search TEXT/);
});

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
  assert.match(
    configured,
    /maxTurns\s+7/,
    "the row did not follow the setting",
  );
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
    Object.values(app.harnessSettings()).every((value) =>
      Number.isFinite(value),
    ),
    "a non-finite limit was stored",
  );

  // A key with no value is a usage error, not an implicit clear.
  await assert.rejects(
    ui.command("/settings maxTurns"),
    /\/settings KEY VALUE/,
  );
  assert.deepEqual({ ...app.harnessSettings() }, before);
});

test("a setting rejects extra values without changing the effective limit", async (t) => {
  const { ui, app } = await settings(t);
  const before = app.harnessSettings().maxTurns;
  await assert.rejects(
    ui.command("/settings maxTurns 7 extra"),
    /\/settings KEY VALUE/,
  );
  assert.equal(app.harnessSettings().maxTurns, before);
});

test("a value outside the range is clamped and the notice names what took effect", async (t) => {
  const { ui, app } = await settings(t);

  await ui.command("/settings maxTurns 9999");

  // Clamping upward would let a harness turn count exceed what an agent
  // profile may carry, so the ceiling wins and the notice names the ceiling.
  assert.equal(app.harnessSettings().maxTurns, HARNESS_SETTINGS.maxTurns.max);
  assert.match(
    ui.notice,
    new RegExp(`is now ${HARNESS_SETTINGS.maxTurns.max}\\b`),
  );
});

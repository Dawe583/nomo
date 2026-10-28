import test from "node:test";
import assert from "node:assert/strict";
import {
  defaultHarnessSettings,
  HARNESS_SETTINGS,
} from "../../../workbench/src/harness-settings.ts";
import { buildSettingsCatalog, searchSettings } from "./settings.ts";

test("settings catalog lists only effective values with explicit source and editability", () => {
  const catalog = buildSettingsCatalog(
    {
      appearance: "dark",
      defaultAgentPreset: "reviewer",
      defaultModel: "fixture-model",
      defaultProvider: "fixture-provider",
      locale: "en",
      sendBehavior: "mod-enter",
    },
    defaultHarnessSettings(),
    "compact",
  );

  assert.equal(catalog.length, Object.keys(HARNESS_SETTINGS).length + 7);
  assert.ok(catalog.every((item) => item.source.length > 0));
  assert.ok(catalog.every((item) => item.editability.length > 0));
  assert.ok(
    catalog.some((item) => item.key === "appearance" && item.value === "dark"),
  );
  assert.equal(
    catalog.find((item) => item.key === "defaultModel")?.configured,
    true,
  );
  assert.ok(
    catalog.some(
      (item) =>
        item.key === "toolOutput" &&
        item.editability.includes("current TUI only"),
    ),
  );
  assert.ok(
    catalog.some(
      (item) => item.key === "maxTurns" && item.choices === "1 to 20",
    ),
  );
  assert.ok(!catalog.some((item) => /api.?key|secret/i.test(item.key)));
});

test("settings catalog reports absent model and provider as not configured", () => {
  const catalog = buildSettingsCatalog(
    { appearance: "system", defaultAgentPreset: "default" },
    defaultHarnessSettings(),
    "compact",
  );

  for (const key of ["defaultModel", "defaultProvider"]) {
    const entry = catalog.find((item) => item.key === key);
    assert.equal(entry?.value, "not configured");
    assert.equal(entry?.defaultValue, "not configured");
    assert.equal(entry?.configured, false);
  }
  assert.deepEqual(
    searchSettings(catalog, "model not configured").map((item) => item.key),
    ["defaultModel", "defaultProvider"],
  );
  assert.deepEqual(
    searchSettings(catalog, "provider not configured").map((item) => item.key),
    ["defaultModel", "defaultProvider"],
  );
});

test("settings search matches key, category, help text, value, and allowed choices", () => {
  const catalog = buildSettingsCatalog(
    { appearance: "dark", locale: "en", sendBehavior: "enter" },
    defaultHarnessSettings(),
    "compact",
  );

  assert.ok(
    searchSettings(catalog, "maxTurns").some((item) => item.key === "maxTurns"),
  );
  assert.ok(
    searchSettings(catalog, "appearance").some(
      (item) => item.key === "appearance",
    ),
  );
  assert.ok(
    searchSettings(catalog, "transient provider").some(
      (item) => item.key === "retryAttempts",
    ),
  );
  assert.ok(
    searchSettings(catalog, "dark").some((item) => item.key === "appearance"),
  );
  assert.ok(
    searchSettings(catalog, "mod-enter").some(
      (item) => item.key === "sendBehavior",
    ),
  );
  assert.deepEqual(searchSettings(catalog, "no-such-setting"), []);
});

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  HARNESS_SETTINGS,
  clampHarnessSetting,
  defaultHarnessSettings,
  harnessSettingsPatch,
  harnessSettingsView,
  resolveHarnessSettings,
  type HarnessSettingKey,
} from "./harness-settings.ts";
import { HOOK_TIMEOUT_BOUNDS, HOOK_TIMEOUT_MS } from "./agents.ts";

/**
 * The harness settings table is the operator's contract with the run path, so
 * these tests are about the properties a caller depends on rather than about
 * the shape of any one row: a clamp that does not clamp, a load that accepts a
 * hand-edited value, or a knob whose bound disagrees with the code it governs.
 */

/** The package files a spec may name as its consumer file. Static and
 * string-keyed, so it is a plain record rather than a map. */
const CONSUMER_FILES = [
  "index.ts",
  "provider.ts",
  "gui.ts",
  "agents.ts",
] as const;

const consumerSource = (file: (typeof CONSUMER_FILES)[number]) =>
  readFileSync(new URL(file, import.meta.url), "utf8");

test("every setting names a consumer, so no knob is decorative", () => {
  for (const [key, spec] of Object.entries(HARNESS_SETTINGS)) {
    assert.ok(spec.consumers.length > 0, `${key} has no consumer`);
    assert.ok(
      CONSUMER_FILES.includes(spec.consumerFile),
      `${key} names an unknown file`,
    );
    assert.ok(spec.label.length > 0, `${key} has no label`);
    assert.ok(spec.description.length > 0, `${key} has no description`);
    assert.ok(
      spec.min <= spec.default && spec.default <= spec.max,
      `${key} default ${spec.default} is outside ${spec.min}..${spec.max}`,
    );
    // Some settings use 0 to mean "unlimited/off" (e.g. maxContinuations,
    // maxRunTokens, contextEntryLimit). For all others the floor is 1.
    const zeroMeansUnlimited = [
      "maxContinuations",
      "maxRunTokens",
      "contextEntryLimit",
      "refinementEnabled",
      "refinementCooldownMs",
    ];
    if (!zeroMeansUnlimited.includes(key)) {
      assert.ok(spec.min > 0, `${key} allows zero or negative`);
    }
  }
});

test("every declared consumer names a symbol the named file actually defines", () => {
  // A consumer that names a function this package does not define is a
  // documentation claim, not a contract. Reading the named file is what makes
  // the table falsifiable: rename or delete a consumer and this fails.
  for (const [key, spec] of Object.entries(HARNESS_SETTINGS)) {
    const source = consumerSource(spec.consumerFile);
    for (const symbol of spec.consumers)
      assert.ok(
        new RegExp(`\\b${symbol}\\s*[(<]|\\b${symbol}\\s*[:=]`).test(source),
        `${key} names consumer ${symbol}, which is not defined in ${spec.consumerFile}`,
      );
  }
});

test("the hook timeout bounds are the ones runHook actually enforces", () => {
  // The table restates these numbers so it can be read as the operator's
  // contract. If runHook's real bounds move, this is the test that says so
  // instead of letting the table promise a limit the runner will not keep.
  assert.equal(HARNESS_SETTINGS.hookTimeoutMs.default, HOOK_TIMEOUT_MS);
  assert.equal(HARNESS_SETTINGS.hookTimeoutMs.min, HOOK_TIMEOUT_BOUNDS.min);
  assert.equal(HARNESS_SETTINGS.hookTimeoutMs.max, HOOK_TIMEOUT_BOUNDS.max);
});

test("a value outside the bounds is clamped, not refused", () => {
  assert.equal(clampHarnessSetting("maxQueuedRuns", 5), 5);
  assert.equal(clampHarnessSetting("maxQueuedRuns", 0), 1);
  assert.equal(clampHarnessSetting("maxQueuedRuns", 1e9), 1000);
  assert.equal(clampHarnessSetting("maxRunTimeoutMs", -1), 1000);
});

test("a value that is not a limit falls back to the default", () => {
  // "Not a number" is not a limit an operator chose, and picking the nearest
  // number would invent a choice they never made.
  for (const bad of ["20", null, undefined, NaN, Infinity, {}, []]) {
    assert.equal(
      clampHarnessSetting("maxTurns", bad),
      HARNESS_SETTINGS.maxTurns.default,
      `${String(bad)} did not fall back to the default`,
    );
  }
});

test("a fractional value is rounded, because a turn count cannot be 20.5", () => {
  assert.equal(clampHarnessSetting("maxTurns", 20.4), 20);
  assert.equal(clampHarnessSetting("maxTurns", 7.6), 8);
});

test("a stored state file cannot widen a limit past its bound", () => {
  // A hand-edited or truncated state file must not be able to put the run
  // path in range of a limit nobody chose through the settings surface.
  const resolved = resolveHarnessSettings({
    maxQueuedRuns: 100000,
    maxRunTimeoutMs: 0,
    maxTurns: "500",
  });
  assert.equal(resolved.maxQueuedRuns, 1000);
  assert.equal(resolved.maxRunTimeoutMs, 1000);
  assert.equal(resolved.maxTurns, HARNESS_SETTINGS.maxTurns.default);
});

test("a workspace with no stored settings gets a complete in-range set", () => {
  const resolved = resolveHarnessSettings(undefined);
  assert.deepEqual(resolved, defaultHarnessSettings());
  for (const key of Object.keys(HARNESS_SETTINGS) as HarnessSettingKey[])
    assert.ok(
      resolved[key] >= HARNESS_SETTINGS[key].min &&
        resolved[key] <= HARNESS_SETTINGS[key].max,
      `${key} default is out of range`,
    );
});

test("an unknown key is refused by name, never silently dropped", () => {
  // A misspelled limit that returns 200 looks applied to the operator while
  // changing nothing, which is the failure this refuses.
  assert.throws(
    () => harnessSettingsPatch({ maxTurn: 5 }),
    /Unknown harness setting maxTurn\./,
  );
  assert.throws(
    () => harnessSettingsPatch({ permissionMode: "normal" }),
    /Unknown harness setting permissionMode\./,
  );
});

test("a non-numeric patch value is refused rather than clamped to a default", () => {
  // Clamping is for a number that is out of range. A string is a wrong type,
  // and quietly substituting the default would report success for a change
  // that was never applied.
  assert.throws(
    () => harnessSettingsPatch({ maxTurns: "5" }),
    /expected a number/,
  );
  assert.throws(
    () => harnessSettingsPatch({ maxTurns: null }),
    /expected a number/,
  );
});

test("a valid patch is clamped on the way in", () => {
  assert.deepEqual(harnessSettingsPatch({ maxQueuedRuns: 0 }), {
    maxQueuedRuns: 1,
  });
  assert.deepEqual(harnessSettingsPatch({ maxTurns: 8 }), { maxTurns: 8 });
  assert.deepEqual(harnessSettingsPatch({}), {});
});

test("the view names the consumer and marks a value that is not the default", () => {
  const view = harnessSettingsView({
    ...defaultHarnessSettings(),
    maxQueuedRuns: 5,
  });
  const queued = view.find((row) => row.key === "maxQueuedRuns");
  assert.ok(queued);
  assert.equal(queued.value, 5);
  assert.equal(queued.changed, true);
  assert.match(queued.consumer, /startSession/);
  const turns = view.find((row) => row.key === "maxTurns");
  assert.equal(turns?.changed, false);
});

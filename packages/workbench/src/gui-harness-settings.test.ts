import test from "node:test";
import assert from "node:assert/strict";
import { capabilities } from "./gui.ts";
import { defaultHarnessSettings, HARNESS_SETTINGS } from "./harness-settings.ts";

/**
 * `capabilities` is the answer a client sizes itself against. If it reports the
 * shipped constants while the run path enforces the operator's configured
 * limits, every consumer of this endpoint is wrong in the one way that is
 * hardest to notice: nothing fails, the limit is simply not the one that bites.
 */

test("capabilities advertises the configured limits rather than the shipped defaults", () => {
  const defaults = defaultHarnessSettings();
  // Deliberately different from both defaults, so a revert to the constants
  // fails this assertion instead of accidentally agreeing with it.
  const configured = { ...defaults, maxQueuedRuns: 3, maxRequestBytes: 131072 };

  const reported = capabilities("local", "normal", configured);

  assert.equal(reported.maxQueuedRuns, 3);
  assert.equal(reported.maxRequestBytes, 131072);
});

test("capabilities falls back to the defaults when a caller passes no settings", () => {
  const defaults = defaultHarnessSettings();

  const reported = capabilities("local");

  // The parameter is optional so the two call sites that have no workbench in
  // hand keep working; the fallback has to be the documented defaults, not
  // undefined at a limit a client is about to compare against.
  assert.equal(reported.maxQueuedRuns, defaults.maxQueuedRuns);
  assert.equal(reported.maxRequestBytes, defaults.maxRequestBytes);
  assert.equal(reported.maxQueuedRuns, 20);
  assert.equal(reported.maxRequestBytes, 65536);
});

test("a cloud host reports the configured request ceiling but queues no local runs", () => {
  const configured = { ...defaultHarnessSettings(), maxRequestBytes: 262144 };

  const reported = capabilities("cloud", "read-only", configured);

  assert.equal(reported.maxRequestBytes, 262144);
  // The cloud runtime has no background queue to size, so the key stays absent
  // rather than appearing with a number nothing enforces.
  assert.equal("maxQueuedRuns" in reported, false);
});

test("passing settings does not disturb the limits capabilities has always reported", () => {
  const defaults = defaultHarnessSettings();
  // maxPromptCharacters is excluded on purpose: it now follows the setting,
  // because an operator may raise it to 200000 and a capabilities object still
  // advertising 32000 would tell the web to refuse prompts the runtime
  // accepts. maxQueuedRuns and maxRequestBytes are covered by their own tests.
  const configured = { ...defaults, maxQueuedRuns: 3, maxRequestBytes: 131072 };

  const before = capabilities("local", "normal");
  const after = capabilities("local", "normal", configured);

  for (const key of ["maxActiveRuns", "backgroundQueue", "projects", "customAgents", "hooks", "contextCompaction", "recoveryJobs", "streaming", "textAttachments", "binaryAttachments", "historicalEvents"] as const)
    assert.deepEqual(after[key], before[key], `${key} changed`);
  assert.deepEqual(after.limitations, before.limitations);
  assert.equal(after.permissionMode, before.permissionMode);
  assert.equal(after.permissionModeAuthority, before.permissionModeAuthority);
});

test("the reported prompt ceiling is the configured one, not the shipped default", () => {
  // The web reads this to decide whether to accept a paste. A hardcoded 32000
  // here would make a raised limit invisible to every surface but the runtime.
  const configured = { ...defaultHarnessSettings(), maxPromptCharacters: 100000 };
  assert.equal(capabilities("local", "normal", configured).maxPromptCharacters, 100000);
  assert.equal(
    capabilities("local", "normal").maxPromptCharacters,
    HARNESS_SETTINGS.maxPromptCharacters.default,
  );
});

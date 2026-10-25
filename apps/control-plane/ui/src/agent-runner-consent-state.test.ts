import assert from "node:assert/strict";
import test from "node:test";
import { agentRunnerConsentView, canStartAgentRun } from "./agent-runner-consent-state.ts";

test("runner consent view fails closed through loading, errors and empty configurations", () => {
  assert.equal(agentRunnerConsentView({ enabled: false, loading: false, error: false, runnerCount: 0, profileCount: 0 }), "disabled");
  assert.equal(agentRunnerConsentView({ enabled: true, loading: true, error: false, runnerCount: 0, profileCount: 0 }), "loading");
  assert.equal(agentRunnerConsentView({ enabled: true, loading: false, error: true, runnerCount: 1, profileCount: 1 }), "error");
  assert.equal(agentRunnerConsentView({ enabled: true, loading: false, error: false, runnerCount: 0, profileCount: 1 }), "no-runner");
  assert.equal(agentRunnerConsentView({ enabled: true, loading: false, error: false, runnerCount: 1, profileCount: 0 }), "no-profile");
  assert.equal(agentRunnerConsentView({ enabled: true, loading: false, error: false, runnerCount: 1, profileCount: 1 }), "ready");
});

test("start requires a current exact preview, explicit acceptance and an idle UI", () => {
  const valid = { id: "consent", consentDigest: "sha256:" + "a".repeat(64) };
  assert.equal(canStartAgentRun(null, true, false), false);
  assert.equal(canStartAgentRun({ id: "consent", consentDigest: "invalid" }, true, false), false);
  assert.equal(canStartAgentRun(valid, false, false), false);
  assert.equal(canStartAgentRun(valid, true, true), false);
  assert.equal(canStartAgentRun(valid, true, false), true);
});

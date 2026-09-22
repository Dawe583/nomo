import test from "node:test";
import assert from "node:assert/strict";
import {
  providerStatus,
  runState,
  runCanStop,
  runBlocksInput,
  compactionResult,
} from "./workspace-state.ts";

test("provider status uses observed state instead of the connected flag", () => {
  for (const status of [
    "ready",
    "setup-required",
    "rate-limited",
    "unavailable",
  ] as const) {
    assert.equal(providerStatus({ status, connected: true }), status);
  }
  assert.equal(providerStatus({ connected: true }), "ready");
  assert.equal(providerStatus({ setupRequired: true }), "setup-required");
  assert.equal(providerStatus(undefined), "unavailable");
});

test("run state preserves unknown outcomes and authoritative lifecycle states", () => {
  assert.equal(runState({ state: "unknown", status: "completed" }), "unknown");
  assert.equal(
    runState({ state: "awaiting-approval", status: "running" }),
    "awaiting-approval",
  );
  assert.equal(runState({ status: "cancelled" }), "stopped");
  assert.equal(runState({ status: "cancelling" }), "stopping");
  assert.equal(runState({ status: "queued" }), "paused");
  assert.equal(runState({ status: "unexpected" }), "unknown");
  assert.equal(
    runState({ status: "idle", reconcileRequired: true }),
    "unknown",
  );
});

test("unknown and stopping runs cannot dispatch input or duplicate stop requests", () => {
  for (const state of [
    "unknown",
    "stopping",
    "paused",
    "awaiting-approval",
    "running",
  ]) {
    assert.equal(runBlocksInput({ state }), true);
  }
  assert.equal(runCanStop({ state: "unknown" }), false);
  assert.equal(runCanStop({ state: "stopping" }), false);
  assert.equal(runCanStop({ state: "running" }), true);
  assert.equal(runCanStop({ state: "awaiting-approval" }), true);
  assert.equal(runCanStop({ status: "queued" }), true);
  assert.equal(runBlocksInput({ state: "idle" }), false);
  assert.equal(runBlocksInput(undefined), false);
});

test("compaction reads actual metadata and rejects missing or malformed results", () => {
  const value = {
    summary: "retained context",
    retainedMessageIds: ["s:1"],
    omittedMessageCount: 4,
    createdAt: "2026-09-22T00:00:00.000Z",
  };
  assert.deepEqual(compactionResult({ compaction: value }), value);
  assert.deepEqual(compactionResult({ session: value }), value);
  assert.deepEqual(compactionResult(value), value);
  assert.equal(compactionResult({}), null);
  assert.equal(compactionResult({ ...value, omittedMessageCount: -1 }), null);
  assert.equal(compactionResult({ ...value, retainedMessageIds: [1] }), null);
});

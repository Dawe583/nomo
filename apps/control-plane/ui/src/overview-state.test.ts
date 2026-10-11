import test from "node:test";
import assert from "node:assert/strict";
import { overviewState } from "./overview-state.ts";
import type { Row } from "./api.ts";

test("pending decisions take priority over active work", () => {
  assert.deepEqual(
    overviewState({ pendingApprovals: 2, running: 1, failed: 0 }),
    { tone: "attention", count: 2, kind: "decisions", agentId: undefined, runState: undefined, stopAck: "unknown", inFlight: undefined },
  );
});

test("failures remain attention states and running work is active", () => {
  assert.deepEqual(overviewState({ pendingApprovals: 0, failed: 1, running: 2 }), {
    tone: "attention",
    count: 1,
    kind: "failures",
    agentId: undefined,
    runState: undefined,
    stopAck: "unknown",
    inFlight: undefined,
  });
  assert.deepEqual(overviewState({ pendingApprovals: 0, failed: 0, running: 2 }), {
    tone: "active",
    count: 2,
    kind: "running",
    agentId: undefined,
    runState: undefined,
    stopAck: "unknown",
    inFlight: undefined,
  });
});

test("overview reports clear only when the server supplied every decision count", () => {
  assert.deepEqual(overviewState({ pendingApprovals: 0, failed: 0, running: 0 }), {
    tone: "clear",
    count: 0,
    kind: "clear",
    agentId: undefined,
    runState: undefined,
    stopAck: "unknown",
    inFlight: undefined,
  });
  assert.deepEqual(overviewState({ pendingApprovals: 0, running: 0 }), {
    tone: "unknown",
    count: undefined,
    kind: "unknown",
    agentId: undefined,
    runState: undefined,
    stopAck: "unknown",
    inFlight: undefined,
  });
});

test("invalid or fractional counts never masquerade as real work", () => {
  const values = { pendingApprovals: -1, failed: Number.NaN, running: 1.5 };
  assert.deepEqual(overviewState(values), {
    tone: "unknown",
    count: undefined,
    kind: "unknown",
    agentId: undefined,
    runState: undefined,
    stopAck: "unknown",
    inFlight: undefined,
  });
  const source: Row = { overview: { ...values, pendingApprovals: 0 } };
  assert.equal(overviewState(source.overview).tone, "unknown");
});

test("fleet fields carry the agent, its run state and the local stop ack", () => {
  const row = {
    pendingApprovals: 0,
    failed: 0,
    running: 1,
    agentId: "registered-agent",
    runState: "running",
    stopAck: "pending",
    inFlight: 1,
  };
  assert.deepEqual(overviewState(row), {
    tone: "active",
    count: 1,
    kind: "running",
    agentId: "registered-agent",
    runState: "running",
    stopAck: "pending",
    inFlight: 1,
  });
});

test("a stop that this process acknowledged is not success for in-flight work", () => {
  const row = {
    pendingApprovals: 0,
    failed: 0,
    running: 0,
    agentId: "registered-agent",
    runState: "stopped",
    stopAck: "acknowledged",
    inFlight: 1,
  };
  const state = overviewState(row);
  assert.equal(state.stopAck, "acknowledged");
  // An unconfirmed dispatched call stays visible as unknown, never as success.
  assert.equal(state.inFlight, 1);
});

test("unrecognized ack values and free-text run states degrade to unknown", () => {
  const row = { pendingApprovals: 0, failed: 0, running: 0, agentId: "  ", runState: 7, stopAck: "maybe", inFlight: 0.5 };
  const state = overviewState(row);
  assert.equal(state.agentId, undefined, "blank labels are not an agent identity");
  assert.equal(state.runState, undefined, "a numeric run state is not a state");
  assert.equal(state.stopAck, "unknown");
  assert.equal(state.inFlight, undefined, "a fractional in-flight count is not evidence");
});

test("an overview without fleet fields stays shape-compatible with the old UI", () => {
  assert.deepEqual(overviewState({ pendingApprovals: 0, failed: 0, running: 0 }), {
    tone: "clear",
    count: 0,
    kind: "clear",
    agentId: undefined,
    runState: undefined,
    stopAck: "unknown",
    inFlight: undefined,
  });
});

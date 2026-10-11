import test from "node:test";
import assert from "node:assert/strict";
import { FleetEventStore } from "./fleet-events.ts";

test("records carry a monotonic sequence and an ISO timestamp", () => {
  const store = new FleetEventStore();
  const first = store.record({ kind: "run_started", agentId: "a1", label: "run" });
  const second = store.record({ kind: "tool_decision", agentId: "a1", label: "d", verdict: "allow" });
  assert.ok(second.seq > first.seq);
  assert.doesNotThrow(() => new Date(first.at).toISOString());
});

test("after() returns only events newer than the cursor", () => {
  const store = new FleetEventStore();
  store.record({ kind: "run_started", agentId: "a", label: "1" });
  const cut = store.record({ kind: "tool_decision", agentId: "a", label: "2", verdict: "deny" }).seq;
  store.record({ kind: "dispatch_result", agentId: "a", label: "3" });
  assert.deepEqual(store.after(cut).map((e) => e.label), ["3"]);
  assert.equal(store.after(0).length, 3);
});

test("stop acknowledgement is keyed by session rather than agent ID", () => {
  const store = new FleetEventStore();
  const sessionId = "session-1";
  assert.equal(store.stopAck(sessionId), "unknown");
  store.record({ kind: "stop_requested", agentId: "agent-1", sessionId, label: "stop" });
  assert.equal(store.stopAck(sessionId), "pending");
  store.record({ kind: "stop_acknowledged", agentId: "agent-1", sessionId, label: "ack" });
  assert.equal(store.stopAck(sessionId), "acknowledged");
  assert.equal(store.stopAck(undefined), "unknown");
});

test("events carry explicit fields but do not sanitize caller strings", () => {
  const store = new FleetEventStore();
  const event = store.record({
    kind: "approval",
    holdId: "hold-1",
    label: "hold approved",
    verdict: "approved",
  });
  assert.deepEqual(Object.keys(event).sort(), ["at", "holdId", "kind", "label", "seq", "verdict"]);
  assert.equal(event.label, "hold approved");
});

test("the store keeps a bounded window instead of growing without limit", () => {
  const store = new FleetEventStore();
  for (let i = 0; i < 700; i += 1)
    store.record({ kind: "tool_decision", agentId: "a", label: `e${i}`, verdict: "allow" });
  assert.ok(store.after(0).length <= 600, "the window must stay bounded");
  const last = store.after(0).at(-1)!;
  assert.equal(last.label, "e699", "the newest event must survive truncation");
});

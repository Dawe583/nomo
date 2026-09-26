import test from "node:test";
import assert from "node:assert/strict";
import { formatDuration, streamPhase, toolDuration, toolTimings } from "./chat-stream.ts";
import type { Row } from "./api.ts";

test("a run of message deltas stays provisional until the message completes", () => {
  const deltas: Row[] = [
    { type: "message.delta", seq: 1, at: "2026-09-26T10:00:00Z", payload: { text: "První " } },
    { type: "message.delta", seq: 2, at: "2026-09-26T10:00:01Z", payload: { text: "věta" } },
  ];
  assert.deepEqual(streamPhase(deltas), {
    streaming: true,
    seq: "2",
    at: "2026-09-26T10:00:01Z",
  });
  assert.equal(
    streamPhase([...deltas, { type: "message.completed", seq: 3, at: "2026-09-26T10:00:02Z" }]).streaming,
    false,
  );
  assert.equal(streamPhase([]).streaming, false);
});

test("a tool call between deltas does not settle an unfinished message", () => {
  const phase = streamPhase([
    { type: "message.delta", seq: 1, at: "2026-09-26T10:00:00Z", payload: { text: "Pracuji" } },
    { type: "tool.started", seq: 2, at: "2026-09-26T10:00:01Z", payload: { callId: "c1" } },
    { type: "run.status", seq: 3, at: "2026-09-26T10:00:02Z", payload: { status: "running" } },
  ]);
  assert.equal(phase.streaming, true, "a run that still accepts input has not settled the text");
  assert.equal(phase.seq, "1");
});

test("a stopped run settles the text, so Stop cannot strand a badged answer", () => {
  // The server emits run.status "cancelled" from the stop request and again
  // from the run's finally block. Either one has to close the open delta run,
  // or the last answer stays badged "arriving" with its actions suppressed.
  for (const status of ["cancelled", "stopped", "stopping"]) {
    const phase = streamPhase([
      { type: "message.delta", seq: 1, at: "2026-09-26T10:00:00Z", payload: { text: "Rozpracovaná odpověď" } },
      { type: "run.status", seq: 2, at: "2026-09-26T10:00:01Z", payload: { status } },
    ]);
    assert.equal(phase.streaming, false, `run.status ${status} left the answer provisional`);
  }
  // A run that is still accepting input must not settle it.
  for (const status of ["running", "queued", "awaiting-approval", "paused"]) {
    assert.equal(
      streamPhase([
        { type: "message.delta", seq: 1, at: "2026-09-26T10:00:00Z", payload: { text: "Pracuji" } },
        { type: "run.status", seq: 2, at: "2026-09-26T10:00:01Z", payload: { status } },
      ]).streaming,
      true,
      `run.status ${status} settled a run that is still live`,
    );
  }
});

test("a failed run settles the text", () => {
  assert.equal(
    streamPhase([
      { type: "message.delta", seq: 1, at: "2026-09-26T10:00:00Z", payload: { text: "Napůl" } },
      { type: "run.error", seq: 2, at: "2026-09-26T10:00:01Z", payload: { error: "provider" } },
    ]).streaming,
    false,
    "run.error left the answer provisional",
  );
  assert.equal(
    streamPhase([
      { type: "message.delta", seq: 1, at: "2026-09-26T10:00:00Z", payload: { text: "Napůl" } },
      { type: "run.status", seq: 2, at: "2026-09-26T10:00:01Z", payload: { status: "failed" } },
    ]).streaming,
    false,
    "a failed run.status left the answer provisional",
  );
});

test("a run status the client cannot read stays open, because unknown is not finished", () => {
  for (const status of [undefined, "", "something-new"]) {
    assert.equal(
      streamPhase([
        { type: "message.delta", seq: 1, at: "2026-09-26T10:00:00Z", payload: { text: "Pracuji" } },
        { type: "run.status", seq: 2, at: "2026-09-26T10:00:01Z", payload: { status } },
      ]).streaming,
      true,
      `run.status ${JSON.stringify(status)} was read as a settled run`,
    );
  }
});

test("a second message restarts the open run", () => {
  const phase = streamPhase([
    { type: "message.delta", seq: 1, at: "2026-09-26T10:00:00Z", payload: { text: "první" } },
    { type: "message.completed", seq: 2, at: "2026-09-26T10:00:01Z" },
    { type: "message.delta", seq: 3, at: "2026-09-26T10:00:02Z", payload: { text: "druhá" } },
  ]);
  assert.equal(phase.streaming, true);
  assert.equal(phase.seq, "3");
});

test("tool duration comes from the real start and result timestamps", () => {
  const timings = toolTimings([
    { type: "tool.started", seq: 1, at: "2026-09-26T10:00:00.000Z", payload: { callId: "c1" } },
    { type: "tool.result", seq: 2, at: "2026-09-26T10:00:02.500Z", payload: { callId: "c1" } },
  ]);
  assert.equal(toolDuration(timings.get("c1")), 2500);
  assert.deepEqual(timings.get("c1"), {
    callId: "c1",
    startedAt: Date.parse("2026-09-26T10:00:00.000Z"),
    endedAt: Date.parse("2026-09-26T10:00:02.500Z"),
  });
});

test("an unfinished or untimestamped tool call has no duration, not a zero", () => {
  const started = toolTimings([
    { type: "tool.started", seq: 1, at: "2026-09-26T10:00:00.000Z", payload: { callId: "c1" } },
  ]);
  assert.equal(toolDuration(started.get("c1")), null);
  const undated = toolTimings([{ type: "tool.started", seq: 1, payload: { callId: "c2" } }]);
  assert.equal(toolDuration(undated.get("c2")), null);
  assert.equal(toolDuration(undefined), null);
  // A reversed pair is a clock problem, not negative work.
  const reversed = toolTimings([
    { type: "tool.started", seq: 2, at: "2026-09-26T10:00:05.000Z", payload: { callId: "c3" } },
    { type: "tool.result", seq: 1, at: "2026-09-26T10:00:00.000Z", payload: { callId: "c3" } },
  ]);
  assert.equal(toolDuration(reversed.get("c3")), 0);
});

test("duration is omitted below a second and never invents a precision", () => {
  assert.equal(formatDuration(null), null);
  assert.equal(formatDuration(0), null);
  assert.equal(formatDuration(999), null);
  assert.equal(formatDuration(1000), "1.0 s");
  assert.equal(formatDuration(2500), "2.5 s");
  assert.equal(formatDuration(15000), "15 s");
  assert.equal(formatDuration(65000), "1 min 5 s");
});

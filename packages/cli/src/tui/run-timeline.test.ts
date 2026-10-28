import test from "node:test";
import assert from "node:assert/strict";
import { buildTimeline, renderTimeline } from "./run-timeline.ts";

test("timeline renders the supported Workbench event shapes as run phases", () => {
  const state = buildTimeline([
    { kind: "user", type: "message.completed", text: "A prompt" },
    {
      kind: "tool",
      type: "run.status",
      payload: { status: "queued" },
    },
    {
      kind: "tool",
      type: "run.status",
      payload: { status: "running" },
    },
    { kind: "assistant", type: "message.delta", text: "A partial reply" },
    { kind: "assistant", type: "message.completed", text: "A final reply" },
    { kind: "tool", type: "tool.started", payload: { tool: "read_file" } },
    { kind: "tool", type: "tool.result", text: "result received" },
    { kind: "tool", type: "run.status", payload: { status: "idle" } },
    { kind: "tool", type: "harness.review", payload: { outcome: "not-run" } },
    { kind: "usage", type: "usage.reported", payload: { total_tokens: 10 } },
    { kind: "error", type: "run.error", text: "failed" },
  ]);

  assert.deepEqual(
    state.steps.map((step) => step.phase),
    [
      "queued",
      "starting",
      "writing",
      "tool",
      "tool",
      "done",
      "failed",
    ],
  );
  const rows = renderTimeline(state, 120, 8).join("\n");
  for (const label of [
    "queued",
    "starting",
    "writing",
    "tool",
    "done",
    "failed",
  ]) {
    assert.ok(rows.includes(label), `rendered timeline includes ${label}`);
  }
  assert.ok(!rows.includes("? unknown "));
});

test("timeline names paused and cancelled run statuses", () => {
  const state = buildTimeline([
    { kind: "tool", type: "run.status", payload: { status: "paused" } },
    { kind: "tool", type: "run.status", payload: { status: "cancelled" } },
  ]);

  assert.deepEqual(
    state.steps.map((step) => step.phase),
    ["paused", "cancelled"],
  );
  const rows = renderTimeline(state, 80, 4).join("\n");
  assert.ok(rows.includes("paused"));
  assert.ok(rows.includes("cancelled"));
});

test("timeline keeps unknown future event types visible as unknown", () => {
  const state = buildTimeline([
    { kind: "tool", type: "future.event", text: "unrecognized" },
    { kind: "tool", type: "run.status", payload: { status: "unknown" } },
  ]);

  assert.deepEqual(
    state.steps.map((step) => step.phase),
    ["unknown", "unknown"],
  );
  assert.ok(renderTimeline(state, 80, 4).join("\n").includes("unknown"));
});

test("timeline derives durations from Workbench ISO timestamps", () => {
  const state = buildTimeline([
    {
      kind: "tool",
      type: "run.status",
      payload: { status: "running" },
      at: "2026-10-23T22:00:00.000Z",
    },
    {
      kind: "assistant",
      type: "message.delta",
      at: "2026-10-23T22:00:01.000Z",
    },
  ]);

  assert.equal(state.steps[0]?.ms, 1000);
  assert.equal(state.steps[1]?.ms, undefined);
  const rows = renderTimeline(state, 80, 4);
  assert.ok(rows.some((row) => row.includes("starting 1s")));
  assert.ok(rows.some((row) => row.includes("writing time unknown")));
});

test("timeline keeps streaming text as one writing phase", () => {
  const state = buildTimeline([
    {
      kind: "tool",
      type: "run.status",
      payload: { status: "running" },
      at: "2026-10-23T22:00:00.000Z",
    },
    {
      kind: "assistant",
      type: "message.delta",
      at: "2026-10-23T22:00:01.000Z",
    },
    {
      kind: "assistant",
      type: "message.delta",
      at: "2026-10-23T22:00:02.000Z",
    },
    {
      kind: "assistant",
      type: "message.completed",
      at: "2026-10-23T22:00:03.000Z",
    },
    {
      kind: "tool",
      type: "run.status",
      payload: { status: "idle" },
      at: "2026-10-23T22:00:04.000Z",
    },
  ]);

  assert.deepEqual(
    state.steps.map((step) => step.phase),
    ["starting", "writing", "done"],
  );
  assert.equal(state.steps[1]?.ms, 3000);
});

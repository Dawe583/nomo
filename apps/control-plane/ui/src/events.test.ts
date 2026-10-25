import { test } from "node:test";
import assert from "node:assert/strict";
import { lastUserMessage, transcriptEvents, usageSummary } from "./events.ts";
import * as eventHelpers from "./events.ts";

test("truncation helper recognizes only an explicit true flag", () => {
  assert.equal(typeof eventHelpers.isTextTruncated, "function");
  if (typeof eventHelpers.isTextTruncated !== "function") return;
  assert.equal(eventHelpers.isTextTruncated({ payload: { textTruncated: true } }), true);
  assert.equal(eventHelpers.isTextTruncated({ payload: { textTruncated: false } }), false);
  assert.equal(eventHelpers.isTextTruncated({ payload: { textTruncated: "true" } }), false);
});
test("stream fragments render once and reconcile with authoritative completion", () => {
  const deltas = [
    { seq: 1, type: "message.delta", payload: { text: "Hello " }, at: "a" },
    { seq: 2, type: "message.delta", payload: { text: "world" }, at: "b" },
  ];
  assert.equal(transcriptEvents(deltas)[0].text, "Hello world");
  const final = {
    seq: 3,
    type: "message.completed",
    kind: "assistant",
    text: "Hello world!",
    at: "c",
  };
  assert.deepEqual(transcriptEvents([...deltas, final]), [final]);
  assert.deepEqual(
    transcriptEvents([{ type: "run.status" }, { type: "usage.reported" }]),
    [],
  );
});
test("tool start and result share one card without losing arguments", () => {
  const events = transcriptEvents([
    {
      id: "start",
      seq: 1,
      type: "tool.started",
      kind: "tool",
      payload: { callId: "a", tool: "write", arguments: { path: "plan.md" } },
    },
    {
      id: "end",
      seq: 2,
      type: "tool.result",
      kind: "tool",
      payload: { callId: "a", result: { isError: false, content: [] } },
    },
  ]);
  assert.equal(events.length, 1);
  assert.equal(events[0].id, "start");
  assert.equal(events[0].payload.status, "completed");
  assert.deepEqual(events[0].payload.arguments, { path: "plan.md" });
});

test("usage summary reports provider values and preserves unknowns", () => {
  assert.deepEqual(usageSummary([]), {
    inputTokens: null,
    outputTokens: null,
    totalTokens: null,
    cost: null,
  });
  assert.deepEqual(
    usageSummary([
      {
        type: "usage.reported",
        payload: {
          prompt_tokens: 120,
          completion_tokens: 30,
          total_tokens: 150,
        },
      },
    ]),
    { inputTokens: 120, outputTokens: 30, totalTokens: 150, cost: null },
  );
  assert.equal(
    usageSummary([{ type: "usage.reported", payload: { total_tokens: "150" } }])
      .totalTokens,
    null,
  );
});

test("last user message selects the latest completed prompt", () => {
  const first = { seq: 1, kind: "user", text: "first" };
  const last = {
    seq: 3,
    kind: "user",
    text: "last",
    type: "message.completed",
  };
  assert.equal(
    lastUserMessage([
      first,
      { seq: 2, kind: "assistant", text: "reply" },
      last,
    ]),
    last,
  );
  assert.equal(
    lastUserMessage([{ type: "message.delta", kind: "user" }]),
    undefined,
  );
});

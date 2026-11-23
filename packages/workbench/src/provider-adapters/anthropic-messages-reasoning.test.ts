import test from "node:test";
import assert from "node:assert/strict";

import { defaultHarnessSettings } from "../harness-settings.ts";
import { AnthropicMessagesAdapter } from "./anthropic-messages.ts";

/**
 * Anthropic `thinking` blocks are the only place this transport emits
 * provider-native reasoning. These tests pin the three properties that keep
 * reasoning honest: it is surfaced only when the provider sends it, it is
 * redacted like answer text, and it never becomes the answer or a tool call.
 */
const secret = "fixture-secret";

const sse = (events: readonly Record<string, unknown>[]) =>
  new Response(
    events
      .map(
        (event) =>
          `event: ${String(event.type)}\ndata: ${JSON.stringify(event)}\n\n`,
      )
      .join(""),
    { headers: { "content-type": "text/event-stream" } },
  );

const adapterFor = (events: readonly Record<string, unknown>[]) =>
  new AnthropicMessagesAdapter({
    send: async () => {
      throw new Error("a streaming turn must not use the JSON send path");
    },
    stream: async () => sse(events),
    redact: (text) => text.split(secret).join("[redacted]"),
    apiKey: secret,
    resolveSettings: () => defaultHarnessSettings(),
  });

const start = {
  type: "message_start",
  message: { content: [], usage: { input_tokens: 4, output_tokens: 0 } },
};

test("Anthropic thinking deltas surface as reasoning and never as answer text", async () => {
  const order: string[] = [];
  const answers: string[] = [];
  const reasoning: string[] = [];
  const result = await adapterFor([
    start,
    { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } },
    // The secret is split across two deltas: the hold-back buffer has to
    // redact it instead of printing the halves.
    { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "Let me think: fixture-se" } },
    { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "cret done" } },
    { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "signed" } },
    { type: "content_block_stop", index: 0 },
    { type: "content_block_start", index: 1, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "Answer." } },
    { type: "content_block_stop", index: 1 },
    { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 3 } },
    { type: "message_stop" },
  ]).complete(
    "claude-fixture",
    [{ role: "user", content: "Think, then answer." }],
    [],
    new AbortController().signal,
    (text) => {
      order.push("answer");
      answers.push(text);
    },
    (text) => {
      order.push("reasoning");
      reasoning.push(text);
    },
  );

  assert.equal(answers.join(""), "Answer.");
  assert.equal(reasoning.join(""), "Let me think: [redacted] done");
  assert.deepEqual(order, ["reasoning", "reasoning", "answer"]);
  assert.equal(result.message.content, "Answer.");
  assert.equal(result.message.tool_calls, undefined);
  assert.deepEqual(result.usage, { prompt_tokens: 4, completion_tokens: 3, total_tokens: 7 });
});

test("Anthropic reasoning alone is neither an answer nor a tool call", async () => {
  const reasoning: string[] = [];
  const answers: string[] = [];
  const result = await adapterFor([
    start,
    { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "Only thinking." } },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 2 } },
    { type: "message_stop" },
  ]).complete(
    "claude-fixture",
    [{ role: "user", content: "Think." }],
    [],
    new AbortController().signal,
    (text) => {
      answers.push(text);
    },
    (text) => {
      reasoning.push(text);
    },
  );

  assert.deepEqual(reasoning, ["Only thinking."]);
  assert.deepEqual(answers, []);
  assert.equal(result.message.content, "");
  assert.equal(result.message.tool_calls, undefined);
});

test("An Anthropic stream without a thinking block never calls onReasoning", async () => {
  const reasoning: string[] = [];
  const answers: string[] = [];
  const result = await adapterFor([
    start,
    { type: "content_block_start", index: 0, content_block: { type: "redacted_thinking", data: "provider-redacted" } },
    { type: "content_block_stop", index: 0 },
    { type: "content_block_start", index: 1, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "Answer." } },
    { type: "content_block_stop", index: 1 },
    { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } },
    { type: "message_stop" },
  ]).complete(
    "claude-fixture",
    [{ role: "user", content: "Answer." }],
    [],
    new AbortController().signal,
    (text) => {
      answers.push(text);
    },
    (text) => {
      reasoning.push(text);
    },
  );

  assert.deepEqual(reasoning, []);
  assert.equal(answers.join(""), "Answer.");
  assert.equal(result.message.content, "Answer.");
});

test("a five-argument Anthropic call keeps its previous streaming behaviour", async () => {
  const answers: string[] = [];
  const result = await adapterFor([
    start,
    { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "ignored without a reasoning sink" } },
    { type: "content_block_stop", index: 0 },
    { type: "content_block_start", index: 1, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "Answer." } },
    { type: "content_block_stop", index: 1 },
    { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } },
    { type: "message_stop" },
  ]).complete(
    "claude-fixture",
    [{ role: "user", content: "Answer." }],
    [],
    new AbortController().signal,
    (text) => {
      answers.push(text);
    },
  );

  assert.equal(answers.join(""), "Answer.");
  assert.equal(result.message.content, "Answer.");
});

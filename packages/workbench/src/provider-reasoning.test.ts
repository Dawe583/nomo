import { test } from "node:test";
import assert from "node:assert/strict";

import { CompatibleProvider } from "./provider.ts";

/**
 * Chat Completions reasoning arrives on the same delta object as the answer,
 * so the wire reader is the only place that can keep the two channels apart.
 * These tests pin the properties the rest of the turn depends on: reasoning is
 * surfaced only when the provider sends it, it is redacted with the same
 * split-secret hold-back as answer text, it is ordered before the answer it
 * precedes, it never becomes answer text or a tool call, and a reasoning-only
 * turn still fails as "no answer".
 */
const config = {
  baseUrl: "https://api.tokenrouter.com/v1",
  apiKey: "fixture-secret",
};
const frame = (value: unknown) => `data: ${JSON.stringify(value)}\r\n\r\n`;
const done = "data: [DONE]\r\n\r\n";
function stream(text: string) {
  const bytes = new TextEncoder().encode(text);
  return new Response(
    new ReadableStream({
      start(c) {
        for (let i = 0; i < bytes.length; i += 3)
          c.enqueue(bytes.slice(i, i + 3));
        c.close();
      },
    }),
    { headers: { "content-type": "text/event-stream" } },
  );
}
const providerFor = (text: string) =>
  new CompatibleProvider(config, async () => stream(text));

const anthropicSse = (events: readonly Record<string, unknown>[]) =>
  new Response(
    events
      .map(
        (event) =>
          `event: ${String(event.type)}\ndata: ${JSON.stringify(event)}\n\n`,
      )
      .join(""),
    { headers: { "content-type": "text/event-stream" } },
  );
const anthropicProviderFor = (events: readonly Record<string, unknown>[]) =>
  new CompatibleProvider(
    { baseUrl: "https://api.anthropic.com/v1", apiKey: config.apiKey, kind: "anthropic" },
    async () => anthropicSse(events),
  );
const anthropicStart = {
  type: "message_start",
  message: { content: [], usage: { input_tokens: 4, output_tokens: 0 } },
};

test("reasoning_content is redacted across split chunks and ordered before the answer", async () => {
  const text =
    frame({ choices: [{ delta: { reasoning_content: "Let me check fixture-se" } }] }) +
    frame({ choices: [{ delta: { reasoning_content: "cret first" } }] }) +
    frame({ choices: [{ delta: { content: "Answer." }, finish_reason: "stop" }] }) +
    done;
  const order: string[] = [];
  const answers: string[] = [];
  const reasoning: string[] = [];
  const reply = await providerFor(text).complete(
    "m",
    [],
    [],
    new AbortController().signal,
    (delta) => {
      order.push("answer");
      answers.push(delta);
    },
    (delta) => {
      order.push("reasoning");
      reasoning.push(delta);
    },
  );

  assert.equal(reasoning.join(""), "Let me check [redacted] first");
  assert.equal(answers.join(""), "Answer.");
  assert.deepEqual(order, ["reasoning", "reasoning", "answer"]);
  assert.equal(reply.message.content, "Answer.");
  assert.equal(reply.message.tool_calls, undefined);
});

test("both reasoning spellings stay off the answer channel", async () => {
  const text =
    frame({ choices: [{ delta: { reasoning: "Plan. " } }] }) +
    frame({ choices: [{ delta: { reasoning_content: "Check. " } }] }) +
    frame({ choices: [{ delta: { content: "Answer." }, finish_reason: "stop" }] }) +
    done;
  const answers: string[] = [];
  const reasoning: string[] = [];
  const reply = await providerFor(text).complete(
    "m",
    [],
    [],
    new AbortController().signal,
    (delta) => {
      answers.push(delta);
    },
    (delta) => {
      reasoning.push(delta);
    },
  );

  assert.equal(reasoning.join(""), "Plan. Check. ");
  assert.equal(answers.join(""), "Answer.");
  assert.equal(reply.message.content, "Answer.");
});

test("a reasoning-only stream fails as no answer and dispatches nothing", async () => {
  const text =
    frame({ choices: [{ delta: { reasoning_content: "Only thinking." } }] }) +
    frame({ choices: [{ delta: {}, finish_reason: "stop" }] }) +
    done;
  const answers: string[] = [];
  const reasoning: string[] = [];
  const provider = providerFor(text);

  await assert.rejects(
    provider.complete(
      "m",
      [],
      [],
      new AbortController().signal,
      (delta) => {
        answers.push(delta);
      },
      (delta) => {
        reasoning.push(delta);
      },
    ),
    /no answer/i,
  );
  assert.deepEqual(reasoning, ["Only thinking."]);
  assert.deepEqual(answers, []);
});

test("reasoning alongside a tool call never becomes answer text", async () => {
  const text =
    frame({ choices: [{ delta: { reasoning_content: "Pick the tool." } }] }) +
    frame({
      choices: [
        {
          delta: {
            tool_calls: [
              { index: 0, id: "call-1", function: { name: "write", arguments: "{}" } },
            ],
          },
          finish_reason: "tool_calls",
        },
      ],
    }) +
    done;
  const answers: string[] = [];
  const reasoning: string[] = [];
  const reply = await providerFor(text).complete(
    "m",
    [],
    [],
    new AbortController().signal,
    (delta) => {
      answers.push(delta);
    },
    (delta) => {
      reasoning.push(delta);
    },
  );

  assert.deepEqual(reasoning, ["Pick the tool."]);
  assert.deepEqual(answers, []);
  assert.equal(reply.message.content, null);
  assert.equal(reply.message.tool_calls?.[0]?.function.name, "write");
});

test("a five-argument compatible call keeps its previous streaming behaviour", async () => {
  const text =
    frame({ choices: [{ delta: { reasoning_content: "ignored without a reasoning sink" } }] }) +
    frame({ choices: [{ delta: { content: "Answer." }, finish_reason: "stop" }] }) +
    done;
  const answers: string[] = [];
  const reply = await providerFor(text).complete(
    "m",
    [],
    [],
    new AbortController().signal,
    (delta) => {
      answers.push(delta);
    },
  );

  assert.equal(answers.join(""), "Answer.");
  assert.equal(reply.message.content, "Answer.");
});

test("the sixth argument is forwarded to the Anthropic transport", async () => {
  const events = [
    anthropicStart,
    { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "Think." } },
    { type: "content_block_stop", index: 0 },
    { type: "content_block_start", index: 1, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "Answer." } },
    { type: "content_block_stop", index: 1 },
    { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 3 } },
    { type: "message_stop" },
  ];
  const reasoning: string[] = [];
  const reply = await anthropicProviderFor(events).complete(
    "claude-fixture",
    [{ role: "user", content: "Think, then answer." }],
    [],
    new AbortController().signal,
    () => {},
    (delta) => {
      reasoning.push(delta);
    },
  );

  assert.deepEqual(reasoning, ["Think."]);
  assert.equal(reply.message.content, "Answer.");
});

test("a five-argument Anthropic call keeps its previous streaming behaviour", async () => {
  const events = [
    anthropicStart,
    { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "ignored" } },
    { type: "content_block_stop", index: 0 },
    { type: "content_block_start", index: 1, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "Answer." } },
    { type: "content_block_stop", index: 1 },
    { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } },
    { type: "message_stop" },
  ];
  const answers: string[] = [];
  const reply = await anthropicProviderFor(events).complete(
    "claude-fixture",
    [{ role: "user", content: "Answer." }],
    [],
    new AbortController().signal,
    (delta) => {
      answers.push(delta);
    },
  );

  assert.equal(answers.join(""), "Answer.");
  assert.equal(reply.message.content, "Answer.");
});

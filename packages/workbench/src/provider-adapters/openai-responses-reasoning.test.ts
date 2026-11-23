import test from "node:test";
import assert from "node:assert/strict";

import { OpenAIResponsesAdapter } from "./openai-responses.ts";
import type { ProviderAdapterConfig } from "./types.ts";

/**
 * The Responses transport has two reasoning channels: a summarized one most
 * accounts receive and a raw one some organizations are allowed to stream.
 * Both are reasoning, neither is answer text.
 */
const secret = "fixture-secret";

const config: ProviderAdapterConfig = {
  providerId: "openai",
  transport: "openai-responses",
  baseUrl: "https://api.openai.com/v1",
  auth: { kind: "api-key", apiKey: secret },
  model: "gpt-4.1",
};

const sse = (events: readonly unknown[]) =>
  new Response(
    events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""),
    { headers: { "content-type": "text/event-stream" } },
  );

const completed = (text: string) => ({
  type: "response.completed",
  response: {
    id: "resp_fixture",
    status: "completed",
    output: text
      ? [{ type: "message", content: [{ type: "output_text", text }] }]
      : [],
    usage: { input_tokens: 5, output_tokens: 2, total_tokens: 7 },
  },
});

const adapterFor = (events: readonly unknown[]) =>
  new OpenAIResponsesAdapter(config, async () => sse(events));

test("Responses reasoning deltas surface as reasoning and never as answer text", async () => {
  const order: string[] = [];
  const answers: string[] = [];
  const reasoning: string[] = [];
  const result = await adapterFor([
    { type: "response.reasoning_summary_text.delta", delta: "Check the plan. " },
    // Split secret across two raw reasoning deltas.
    { type: "response.reasoning_text.delta", delta: "raw fixture-se" },
    { type: "response.reasoning_text.delta", delta: "cret detail" },
    { type: "response.output_text.delta", delta: "Answer." },
    completed("Answer."),
  ]).complete(
    "gpt-4.1",
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
  assert.equal(reasoning.join(""), "Check the plan. raw [redacted] detail");
  assert.deepEqual(order, ["reasoning", "reasoning", "reasoning", "answer"]);
  assert.equal(result.message.content, "Answer.");
  assert.equal(result.message.tool_calls, undefined);
  assert.deepEqual(result.usage, { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 });
});

test("Responses reasoning alone is not an answer and completes no turn", async () => {
  const reasoning: string[] = [];
  await assert.rejects(
    adapterFor([
      { type: "response.reasoning_summary_text.delta", delta: "Only thinking." },
      completed(""),
    ]).complete(
      "gpt-4.1",
      [{ role: "user", content: "Think." }],
      [],
      new AbortController().signal,
      () => {},
      (text) => {
        reasoning.push(text);
      },
    ),
    /no answer/i,
  );
  assert.deepEqual(reasoning, ["Only thinking."]);
});

test("a Responses stream without reasoning deltas never calls onReasoning", async () => {
  const reasoning: string[] = [];
  const answers: string[] = [];
  const result = await adapterFor([
    { type: "response.output_text.delta", delta: "Answer." },
    completed("Answer."),
  ]).complete(
    "gpt-4.1",
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

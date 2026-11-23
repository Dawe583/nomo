import test from "node:test";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";

import { isolatedWorkbench, type WorkbenchFixture } from "./test-fixture.ts";
import type { ProviderAdapterConfig } from "./provider-adapters/types.ts";

/**
 * Provider reasoning reaches the transcript as its own `reasoning.delta`
 * event. These tests use a Responses descriptor because that transport parses
 * its reasoning channel in this package; the assertions are about the
 * workbench contract: a separate event, the same redaction as answer text, no
 * tool dispatch and no completion from reasoning alone.
 */
const secret = "fixture-provider-secret";
const descriptor: ProviderAdapterConfig = {
  providerId: "openai",
  transport: "openai-responses",
  baseUrl: "https://api.openai.com/v1",
  auth: { kind: "api-key", apiKey: secret },
  model: "gpt-4.1",
};

const sse = (events: readonly unknown[]) =>
  new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), {
    headers: { "content-type": "text/event-stream" },
  });

const completed = (text: string) => ({
  type: "response.completed",
  response: {
    id: "resp_fixture",
    status: "completed",
    output: text
      ? [{ type: "message", content: [{ type: "output_text", text }] }]
      : [],
    usage: { input_tokens: 3, output_tokens: 2, total_tokens: 5 },
  },
});

const settle = async (fixture: WorkbenchFixture, id: string) => {
  for (let poll = 0; poll < 400 && fixture.app.get(id)?.status === "running"; poll++)
    await delay(10);
  return fixture.app.get(id)!;
};

const configure = async (fixture: WorkbenchFixture) => {
  await fixture.app.configure(descriptor);
};

test("provider reasoning is recorded as reasoning.delta, apart from the answer", async (t) => {
  let providerRequests = 0;
  const fetcher: typeof fetch = async (url) => {
    if (String(url).endsWith("/models")) return Response.json({ data: [{ id: "gpt-4.1" }] });
    providerRequests++;
    return sse([
      { type: "response.reasoning_summary_text.delta", delta: "Weigh fixture-provider-secret options. " },
      { type: "response.reasoning_summary_text.delta", delta: "Then answer." },
      { type: "response.output_text.delta", delta: "Answer." },
      completed("Answer."),
    ]);
  };
  const fixture = await isolatedWorkbench(t, fetcher, {}, {
    configure: false,
    prefix: "nomo-reasoning-",
  });
  await configure(fixture);
  const started = await fixture.app.start("Question.", "gpt-4.1");
  const session = await settle(fixture, started.id);

  assert.equal(session.status, "idle");
  const events = session.events;
  const reasoning = events.filter((event) => event.type === "reasoning.delta");
  assert.ok(reasoning.length > 0, "expected at least one reasoning.delta event");
  for (const event of reasoning) {
    assert.equal(event.kind, "assistant");
    assert.deepEqual(event.payload, { text: event.text });
  }
  const reasoningText = reasoning.map((event) => event.text).join("");
  assert.equal(reasoningText, "Weigh [redacted] options. Then answer.");

  const answer = events.find(
    (event) => event.kind === "assistant" && event.type === "message.completed",
  );
  assert.ok(answer);
  assert.equal(answer.text, "Answer.");
  assert.ok(
    !answer.text.includes("Weigh") && !answer.text.includes("Then answer"),
    "reasoning must not be presented as the answer",
  );
  // Ordering: every reasoning delta precedes the answer, which precedes the
  // run settling.
  const answerIndex = events.indexOf(answer);
  assert.ok(events.lastIndexOf(reasoning.at(-1)!) < answerIndex);

  // Reasoning alone dispatches no tools and makes exactly one provider call.
  assert.deepEqual(events.filter((event) => event.type === "tool.started"), []);
  assert.equal(providerRequests, 1);
});

test("reasoning-only output fails the run instead of completing it", async (t) => {
  const fetcher: typeof fetch = async (url) => {
    if (String(url).endsWith("/models")) return Response.json({ data: [{ id: "gpt-4.1" }] });
    return sse([
      { type: "response.reasoning_summary_text.delta", delta: "Only thinking." },
      completed(""),
    ]);
  };
  const fixture = await isolatedWorkbench(t, fetcher, {}, {
    configure: false,
    prefix: "nomo-reasoning-only-",
  });
  await configure(fixture);
  const started = await fixture.app.start("Question.", "gpt-4.1");
  const session = await settle(fixture, started.id);

  assert.equal(session.status, "failed");
  const events = session.events;
  assert.deepEqual(
    events.filter((event) => event.type === "reasoning.delta").map((event) => event.text),
    ["Only thinking."],
  );
  assert.deepEqual(
    events.filter(
      (event) => event.kind === "assistant" && event.type === "message.completed",
    ),
    [],
  );
  assert.deepEqual(events.filter((event) => event.type === "tool.started"), []);
  const error = events.find((event) => event.kind === "error");
  assert.ok(error);
  assert.match(error.text, /no answer/i);
});

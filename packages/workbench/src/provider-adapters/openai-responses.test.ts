import test from "node:test";
import assert from "node:assert/strict";
import { createProviderClient } from "./factory.ts";
import type { ModelReply } from "../provider.ts";
import type { ProviderAdapterConfig } from "./types.ts";

const config: ProviderAdapterConfig = {
  providerId: "openai",
  transport: "openai-responses",
  baseUrl: "https://api.openai.com/v1",
  auth: { kind: "api-key", apiKey: "fixture-secret" },
};

test("Responses adapter maps chat messages and function tools to the Responses request contract", async () => {
  let requestBody: Record<string, unknown> | undefined;
  const client = createProviderClient(config, async (input, init) => {
    assert.equal(String(input), "https://api.openai.com/v1/responses");
    assert.equal((init?.headers as Record<string, string>).authorization, "Bearer fixture-secret");
    requestBody = JSON.parse(String(init?.body));
    return Response.json({
      id: "resp-fixture",
      output: [{ id: "msg-fixture", type: "message", role: "assistant", content: [{ type: "output_text", text: "ready" }] }],
      usage: { input_tokens: 3, output_tokens: 2, total_tokens: 5 },
    });
  });

  const reply = await client.complete(
    "gpt-fixture",
    [
      { role: "system", content: "Be concise" },
      { role: "user", content: "go" },
      { role: "assistant", content: null, tool_calls: [{ id: "call-1", type: "function", function: { name: "inspect", arguments: "{}" } }] },
      { role: "tool", content: "done", tool_call_id: "call-1" },
    ],
    [{ type: "function", function: { name: "inspect", description: "Inspect", parameters: { type: "object" } } }],
    new AbortController().signal,
  );
  assert.equal(requestBody?.model, "gpt-fixture");
  assert.equal(requestBody?.instructions, "Be concise");
  assert.deepEqual(requestBody?.input, [
    { role: "user", content: [{ type: "input_text", text: "go" }] },
    { type: "function_call", call_id: "call-1", name: "inspect", arguments: "{}" },
    { type: "function_call_output", call_id: "call-1", output: "done" },
  ]);
  assert.deepEqual(requestBody?.tools, [{ type: "function", name: "inspect", description: "Inspect", parameters: { type: "object" }, strict: false }]);
  assert.equal(reply.message.content, "ready");
  assert.equal(reply.usage?.total_tokens, 5);
  assert.equal(reply.response_id, "resp-fixture");
});

test("Responses streaming decodes output text deltas and refuses incomplete streams", async () => {
  const client = createProviderClient(config, async () => new Response(
    [
      'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"A"}\n\n',
      'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"B"}\n\n',
      'event: response.completed\ndata: {"type":"response.completed","response":{"id":"resp-1","status":"completed","output":[{"type":"message","role":"assistant","content":[{"type":"output_text","text":"AB"}]}],"usage":{"input_tokens":1,"output_tokens":2,"total_tokens":3}}}\n\n',
    ].join("").replaceAll("\n", "\r\n"),
    { headers: { "content-type": "text/event-stream" } },
  ));
  const deltas: string[] = [];
  const reply = await client.complete("gpt-fixture", [{ role: "user", content: "go" }], [], new AbortController().signal, value => { deltas.push(value); });
  assert.deepEqual(deltas, ["A", "B"]);
  assert.equal(reply.message.content, "AB");
  assert.equal(reply.usage?.total_tokens, 3);
  const incomplete = createProviderClient(config, async () => new Response(
    'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"partial"}\n\n',
    { headers: { "content-type": "text/event-stream" } },
  ));
  await assert.rejects(
    incomplete.complete("gpt-fixture", [{ role: "user", content: "go" }], [], new AbortController().signal, () => {}),
    /ended before completion/,
  );
});

test("OpenAI Responses rejects custom hosts instead of sending credentials to an untrusted endpoint", () => {
  assert.throws(
    () => createProviderClient({ ...config, baseUrl: "https://api.attacker.test/v1" }, async () => {
      throw new Error("request must not run");
    }),
    /official HTTPS API endpoint/,
  );
});
test("typed OpenAI descriptor routes to Responses with host-bound Bearer auth", async () => {
  let requestUrl = "";
  let requestInit: RequestInit | undefined;
  const client = createProviderClient(config, async (input, init) => {
    requestUrl = String(input);
    requestInit = init;
    return Response.json({
      status: "completed",
      output: [{ type: "message", content: [{ type: "output_text", text: "ok" }] }],
    });
  });
  const reply = await client.complete("gpt-fixture", [{ role: "user", content: "hello" }], [], new AbortController().signal);
  assert.equal(requestUrl, "https://api.openai.com/v1/responses");
  assert.equal(requestInit?.method, "POST");
  assert.equal((requestInit?.headers as Record<string, string>).authorization, "Bearer fixture-secret");
  assert.equal(requestInit?.redirect, "error");
  assert.equal(reply.message.content, "ok");
});

test("Responses streaming returns multiple ordered function calls, arguments and usage", async () => {
  const events = [
    { type: "response.output_item.added", output_index: 0, item: { id: "item-a", type: "function_call", call_id: "call-a", name: "first", arguments: "" } },
    { type: "response.output_item.added", output_index: 1, item: { id: "item-b", type: "function_call", call_id: "call-b", name: "second", arguments: "" } },
    { type: "response.function_call_arguments.delta", output_index: 0, item_id: "item-a", delta: '{"value":' },
    { type: "response.function_call_arguments.delta", output_index: 1, item_id: "item-b", delta: '{"value":' },
    { type: "response.function_call_arguments.delta", output_index: 0, item_id: "item-a", delta: '"a"}' },
    { type: "response.function_call_arguments.delta", output_index: 1, item_id: "item-b", delta: '"b"}' },
    { type: "response.function_call_arguments.done", output_index: 0, item_id: "item-a", arguments: '{"value":"a"}' },
    { type: "response.function_call_arguments.done", output_index: 1, item_id: "item-b", arguments: '{"value":"b"}' },
    { type: "response.output_item.done", output_index: 0, item: { id: "item-a", type: "function_call", call_id: "call-a", name: "first", arguments: '{"value":"a"}' } },
    { type: "response.output_item.done", output_index: 1, item: { id: "item-b", type: "function_call", call_id: "call-b", name: "second", arguments: '{"value":"b"}' } },
    {
      type: "response.completed",
      response: {
        id: "resp-tools",
        status: "completed",
        output: [
          { id: "item-a", type: "function_call", call_id: "call-a", name: "first", arguments: '{"value":"a"}' },
          { id: "item-b", type: "function_call", call_id: "call-b", name: "second", arguments: '{"value":"b"}' },
        ],
        usage: { input_tokens: 11, output_tokens: 7, total_tokens: 18 },
      },
    },
  ];
  const response = new Response(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""), {
    headers: { "content-type": "text/event-stream" },
  });
  const client = createProviderClient(config, async () => response);
  const reply = await client.complete("gpt-fixture", [{ role: "user", content: "run tools" }], [], new AbortController().signal, () => {});
  assert.deepEqual(reply.message.tool_calls?.map(call => [call.id, call.function.name, call.function.arguments]), [
    ["call-a", "first", '{"value":"a"}'],
    ["call-b", "second", '{"value":"b"}'],
  ]);
  assert.deepEqual(reply.usage, { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 });
  assert.equal(reply.response_id, "resp-tools");
});

test("Responses streaming refuses incomplete, malformed, truncated, and failed tool streams", async () => {
  const responseFor = (events: readonly unknown[]) => new Response(
    events.map(event => `data: ${typeof event === "string" ? event : JSON.stringify(event)}\n\n`).join(""),
    { headers: { "content-type": "text/event-stream" } },
  );
  const clientFor = (events: readonly unknown[]) => createProviderClient(config, async () => responseFor(events));
  const input = [{ role: "user" as const, content: "go" }];
  const signal = new AbortController().signal;

  await assert.rejects(
    clientFor([{ type: "response.incomplete", response: { status: "incomplete", incomplete_details: { reason: "max_output_tokens" }, output: [] } }])
      .complete("gpt-fixture", input, [], signal, () => {}),
    /did not complete/,
  );
  await assert.rejects(
    clientFor([{ type: "response.completed", response: { status: "incomplete", output: [] } }])
      .complete("gpt-fixture", input, [], signal, () => {}),
    /did not complete/,
  );
  await assert.rejects(
    clientFor([{ type: "response.completed", response: { status: "completed", output: [{ type: "function_call", call_id: "call-1", name: "broken", arguments: "{" }] } }])
      .complete("gpt-fixture", input, [], signal, () => {}),
    /invalid tool arguments/,
  );
  let prematureReply: ModelReply | undefined;
  const toolDeltas: string[] = [];
  const interrupted = clientFor([
    { type: "response.output_item.added", output_index: 0, item: { id: "item-truncated", type: "function_call", call_id: "call-truncated", name: "run", arguments: "" } },
    { type: "response.function_call_arguments.delta", output_index: 0, item_id: "item-truncated", delta: '{"unsafe":true}' },
    { type: "response.function_call_arguments.done", output_index: 0, item_id: "item-truncated", arguments: '{"unsafe":true}' },
    { type: "response.output_item.done", output_index: 0, item: { id: "item-truncated", type: "function_call", call_id: "call-truncated", name: "run", arguments: '{"unsafe":true}' } },
    "[DONE]",
  ]).complete("gpt-fixture", input, [], signal, delta => { toolDeltas.push(delta); })
    .then(reply => { prematureReply = reply; return reply; });
  await assert.rejects(interrupted, /ended before completion/);
  assert.equal(prematureReply, undefined);
  assert.deepEqual(toolDeltas, []);
  await assert.rejects(
    clientFor([{ type: "response.failed", response: { status: "failed" } }])
      .complete("gpt-fixture", input, [], signal, () => {}),
    /Responses stream error/,
  );
});

test("Responses stream stops reading after terminal completion and cancels the body", async () => {
  const controller = new AbortController();
  let bodyController!: ReadableStreamDefaultController<Uint8Array>;
  let canceled = false;
  const streamBody = new ReadableStream<Uint8Array>({
    start(stream) {
      bodyController = stream;
      const event = {
        type: "response.completed",
        response: { status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: "done" }] }] },
      };
      stream.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`));
    },
    cancel() { canceled = true; },
  });
  const client = createProviderClient(config, async (_input, init) => {
    (init?.signal as AbortSignal).addEventListener("abort", () => {
      try { bodyController.error(new DOMException("aborted", "AbortError")); } catch {}
    }, { once: true });
    return new Response(streamBody, { headers: { "content-type": "text/event-stream" } });
  });
  const abortTimer = setTimeout(() => controller.abort(), 100);
  try {
    const reply = await client.complete("gpt-fixture", [{ role: "user", content: "go" }], [], controller.signal, () => {});
    assert.equal(reply.message.content, "done");
    assert.equal(canceled, true);
  } finally {
    clearTimeout(abortTimer);
  }
});
test("Responses stream propagates an in-flight cancellation", async () => {
  const controller = new AbortController();
  let bodyController!: ReadableStreamDefaultController<Uint8Array>;
  const streamBody = new ReadableStream<Uint8Array>({
    start(stream) {
      bodyController = stream;
      stream.enqueue(new TextEncoder().encode('data: {"type":"response.output_text.delta","delta":"partial"}\n\n'));
    },
  });
  const client = createProviderClient(config, async (_input, init) => {
    (init?.signal as AbortSignal).addEventListener("abort", () => {
      try { bodyController.error(new DOMException("aborted", "AbortError")); } catch {}
    }, { once: true });
    return new Response(streamBody, { headers: { "content-type": "text/event-stream" } });
  });
  const deltas: string[] = [];
  const pending = client.complete("gpt-fixture", [{ role: "user", content: "go" }], [], controller.signal, delta => { deltas.push(delta); });
  const abortTimer = setTimeout(() => controller.abort(), 10);
  try {
    await assert.rejects(pending, error => (error as Error).name === "AbortError");
  } finally {
    clearTimeout(abortTimer);
  }
  assert.deepEqual(deltas, ["partial"]);
});

test("Responses HTTP errors preserve status without exposing response bodies", async () => {
  const client = createProviderClient(config, async () => new Response("fixture-secret raw provider error", { status: 429 }));
  await assert.rejects(
    client.complete("gpt-fixture", [{ role: "user", content: "go" }], [], new AbortController().signal),
    error => {
      assert.equal((error as { status?: number }).status, 429);
      assert.equal((error as Error).message.includes("fixture-secret"), false);
      return true;
    },
  );
});
test("Responses onDelta redacts an API key split across events without changing tool data", async () => {
  const events = [
    { type: "response.output_text.delta", delta: "Echo fixture-" },
    { type: "response.output_text.delta", delta: "secret suffix" },
    { type: "response.output_item.added", output_index: 1, item: { id: "item-safe", type: "function_call", call_id: "call-safe", name: "echo", arguments: "" } },
    { type: "response.function_call_arguments.delta", output_index: 1, item_id: "item-safe", delta: '{"value":"fixture-secret"}' },
    { type: "response.function_call_arguments.done", output_index: 1, item_id: "item-safe", arguments: '{"value":"fixture-secret"}' },
    { type: "response.output_item.done", output_index: 1, item: { id: "item-safe", type: "function_call", call_id: "call-safe", name: "echo", arguments: '{"value":"fixture-secret"}' } },
    {
      type: "response.completed",
      response: {
        id: "resp-redaction",
        status: "completed",
        output: [
          { type: "message", content: [{ type: "output_text", text: "Echo fixture-secret suffix" }] },
          { id: "item-safe", type: "function_call", call_id: "call-safe", name: "echo", arguments: '{"value":"fixture-secret"}' },
        ],
        usage: { input_tokens: 4, output_tokens: 3, total_tokens: 7 },
      },
    },
  ];
  const response = new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(""), {
    headers: { "content-type": "text/event-stream" },
  });
  const client = createProviderClient(config, async () => response);
  const visibleDeltas: string[] = [];
  const reply = await client.complete("gpt-fixture", [{ role: "user", content: "go" }], [], new AbortController().signal, delta => {
    visibleDeltas.push(delta);
  });
  assert.equal(visibleDeltas.join(""), "Echo [redacted] suffix");
  assert.equal(visibleDeltas.join("").includes("fixture-secret"), false);
  assert.deepEqual(reply.message.tool_calls?.map(call => [call.id, call.function.name, call.function.arguments]), [
    ["call-safe", "echo", '{"value":"fixture-secret"}'],
  ]);
  assert.deepEqual(reply.usage, { prompt_tokens: 4, completion_tokens: 3, total_tokens: 7 });
});

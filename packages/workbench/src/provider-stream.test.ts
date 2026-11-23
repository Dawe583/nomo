import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { CompatibleProvider, ProviderRequestError } from "./provider.ts";
const config = {
  baseUrl: "https://api.tokenrouter.com/v1",
  apiKey: "fixture-secret",
};
const frame = (value: unknown) => `data: ${JSON.stringify(value)}\r\n\r\n`;
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
test("stream preserves split UTF-8 and CRLF frames, text, tools and final usage", async () => {
  const text =
    frame({ choices: [{ delta: { content: "Příliš žluťoučký" } }] }) +
    frame({
      choices: [
        {
          delta: {
            tool_calls: [
              {
                index: 0,
                id: "call-1",
                function: { name: "write", arguments: '{"path":' },
              },
            ],
          },
        },
      ],
    }) +
    frame({
      choices: [
        {
          delta: {
            tool_calls: [{ index: 0, function: { arguments: '"plan.md"}' } }],
          },
          finish_reason: "tool_calls",
        },
      ],
    }) +
    frame({
      choices: [],
      usage: { prompt_tokens: 12, completion_tokens: 8, total_tokens: 20 },
    }) +
    "data: [DONE]\r\n\r\n";
  const provider = new CompatibleProvider(config, async (_url, init) => {
    assert.equal(JSON.parse(String(init?.body)).model, "z-ai/glm-5.3-free");
    assert.equal(JSON.parse(String(init?.body)).stream, true);
    return stream(text);
  });
  const deltas: string[] = [];
  const result = await provider.complete(
    "z-ai/glm-5.3-free",
    [],
    [],
    new AbortController().signal,
    (t) => {
      deltas.push(t);
    },
  );
  assert.equal(deltas.join(""), "Příliš žluťoučký");
  assert.equal(
    result.message.tool_calls?.[0]?.function.arguments,
    '{"path":"plan.md"}',
  );
  assert.equal(result.usage?.total_tokens, 20);
});
test("partial tool stream never returns executable tools", async () => {
  const provider = new CompatibleProvider(config, async () =>
    stream(
      frame({
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: "x",
                  function: { name: "write", arguments: "{" },
                },
              ],
            },
          },
        ],
      }),
    ),
  );
  await assert.rejects(
    provider.complete("m", [], [], new AbortController().signal, () => {}),
    /ended before completion/,
  );
});
test("JSON-only compatible providers remain supported without a second request", async () => {
  let calls = 0;
  const provider = new CompatibleProvider(config, async () => {
    calls++;
    return Response.json({ choices: [{ message: { role: "assistant", content: "Done" }, finish_reason: "stop" }] });
  });
  assert.equal(
    (
      await provider.complete(
        "m",
        [],
        [],
        new AbortController().signal,
        () => {},
      )
    ).message.content,
    "Done",
  );
  assert.equal(calls, 1);
});
test("rate limit exposes retry interval without leaking provider error body", async () => {
  const provider = new CompatibleProvider(
    config,
    async () =>
      new Response("fixture-secret", {
        status: 429,
        headers: { "retry-after": "12" },
      }),
  );
  await assert.rejects(
    provider.models(),
    (e: unknown) =>
      e instanceof ProviderRequestError &&
      e.retryAfter === 12 &&
      !e.message.includes("fixture-secret"),
  );
});
test("stream redacts a secret split across provider chunks", async () => {
  const text =
    frame({ choices: [{ delta: { content: "Result fixture-" } }] }) +
    frame({
      choices: [{ delta: { content: "secret end" }, finish_reason: "stop" }],
    }) +
    "data: [DONE]\n\n";
  const p = new CompatibleProvider(config, async () => stream(text));
  let output = "";
  await p.complete("m", [], [], new AbortController().signal, (t) => {
    output += t;
  });
  assert.equal(output, "Result [redacted] end");
});
test("stream keeps reasoning off the answer channel and redacts it", async () => {
  const text =
    frame({ choices: [{ delta: { content: "Answer " } }] }) +
    frame({ choices: [{ delta: { reasoning_content: "checking fixture-" } }] }) +
    frame({ choices: [{ delta: { reasoning: "secret now" } }] }) +
    frame({ choices: [{ delta: { content: "done." }, finish_reason: "stop" }] }) +
    "data: [DONE]\n\n";
  const provider = new CompatibleProvider(config, async () => stream(text));
  const answers: string[] = [];
  const reasoning: string[] = [];
  const reply = await provider.complete(
    "m",
    [],
    [],
    new AbortController().signal,
    (delta) => { answers.push(delta); },
    (delta) => { reasoning.push(delta); },
  );

  assert.equal(answers.join(""), "Answer done.");
  assert.equal(reasoning.join(""), "checking [redacted] now");
  assert.equal(reply.message.content, "Answer done.");
});
test("stream maps refusal deltas to assistant content and onDelta", async () => {
  const refusal = "I cannot help with that request.";
  const text =
    frame({ choices: [{ delta: { refusal: "I cannot help " }, finish_reason: null }] }) +
    frame({ choices: [{ delta: { refusal: "with that request." }, finish_reason: "stop" }] }) +
    "data: [DONE]\n\n";
  const provider = new CompatibleProvider(config, async () => stream(text));
  const deltas: string[] = [];
  const reply = await provider.complete(
    "m",
    [],
    [],
    new AbortController().signal,
    (delta) => { deltas.push(delta); },
  );
  assert.equal(reply.message.content, refusal);
  assert.equal(deltas.join(""), refusal);
});
test("stream normalizes legacy function_call deltas to a replayable tool call", async () => {
  const text =
    frame({
      choices: [{
        delta: { function_call: { name: "lookup", arguments: '{"key":' } },
        finish_reason: null,
      }],
    }) +
    frame({
      choices: [{
        delta: { function_call: { arguments: '"x"}' } },
        finish_reason: "function_call",
      }],
    }) +
    "data: [DONE]\n\n";
  const provider = new CompatibleProvider(config, async () => stream(text));
  const reply = await provider.complete(
    "m",
    [],
    [],
    new AbortController().signal,
    () => {},
  );
  const call = reply.message.tool_calls?.[0];
  assert.ok(call);
  assert.ok(call.id);
  assert.equal(call.function.name, "lookup");
  assert.equal(call.function.arguments, '{"key":"x"}');
});
test("stream rejects malformed and mixed legacy/modern function calls", async () => {
  for (const delta of [
    {
      function_call: { name: "lookup", arguments: 5 },
    },
    {
      function_call: { name: "lookup", arguments: "{}" },
      tool_calls: [{
        index: 0,
        id: "modern",
        function: { name: "lookup", arguments: "{}" },
      }],
    },
  ]) {
    const provider = new CompatibleProvider(config, async () => stream(
      frame({ choices: [{ delta, finish_reason: "function_call" }] }) + "data: [DONE]\n\n",
    ));
    await assert.rejects(
      provider.complete("m", [], [], new AbortController().signal, () => {}),
      /invalid tool stream data/i,
    );
  }
});

test("truncated model output is never accepted as a tool action", async () => {
  const text = frame({
    choices: [
      {
        delta: {
          tool_calls: [
            { index: 0, id: "x", function: { name: "write", arguments: "{}" } },
          ],
        },
        finish_reason: "length",
      },
    ],
  });
  const p = new CompatibleProvider(config, async () => stream(text));
  await assert.rejects(
    p.complete("m", [], [], new AbortController().signal, () => {}),
    /truncated/,
  );
});
test("OpenAI-compatible stream rejects an unknown terminal finish reason", async () => {
  const provider = new CompatibleProvider(config, async () => stream(
    frame({
      choices: [{ delta: { content: "partial" }, finish_reason: "future_stop" }],
    }) + "data: [DONE]\n\n",
  ));
  await assert.rejects(
    provider.complete("m", [], [], new AbortController().signal, () => {}),
    /invalid completion status/i,
  );
});

test("OpenAI-compatible stream rejects [DONE] without a finish reason", async () => {
  const provider = new CompatibleProvider(config, async () => stream(
    frame({ choices: [{ delta: { content: "partial" } }] }) + "data: [DONE]\n\n",
  ));
  await assert.rejects(
    provider.complete("m", [], [], new AbortController().signal, () => {}),
    /finish reason/i,
  );
});

test("OpenAI-compatible stream rejects content after finish_reason", async () => {
  const provider = new CompatibleProvider(config, async () => stream(
    frame({ choices: [{ delta: { content: "complete" }, finish_reason: "stop" }] }) +
      frame({ choices: [{ delta: { content: "late" } }] }) +
      "data: [DONE]\n\n",
  ));
  const deltas: string[] = [];

  await assert.rejects(
    provider.complete("m", [], [], new AbortController().signal, delta => { deltas.push(delta); }),
    /data after completion/i,
  );
  assert.deepEqual(deltas, ["complete"]);
});

test("OpenAI-compatible stream rejects content after [DONE]", async () => {
  const text =
    frame({ choices: [{ delta: { content: "before" } }] }) +
    "data: [DONE]\n\n" +
    frame({ choices: [{ delta: { content: "late" }, finish_reason: "stop" }] });
  const provider = new CompatibleProvider(config, async () => new Response(text, {
    headers: { "content-type": "text/event-stream" },
  }));
  const deltas: string[] = [];

  await assert.rejects(
    provider.complete("m", [], [], new AbortController().signal, delta => { deltas.push(delta); }),
    /data after completion/i,
  );
  assert.deepEqual(deltas, ["before"]);
});


test("completed empty stream is reported as failure instead of a successful blank answer", async () => {
  const provider = new CompatibleProvider(config, async () => stream(
    frame({ choices: [{ delta: {}, finish_reason: "stop" }] }) + "data: [DONE]\n\n",
  ));
  await assert.rejects(provider.complete("m", [], [], new AbortController().signal, () => {}), /no answer/);
});

test("Compatible and Anthropic JSON completions preserve cancellation during body decoding", async (t) => {
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.write('{"content":[');
    const fallbackTimer = setTimeout(() => response.end("]}"), 500);
    response.on("close", () => clearTimeout(fallbackTimer));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("fixture did not bind");

  const baseUrl = `http://127.0.0.1:${address.port}/v1`;
  for (const kind of ["anthropic", "compatible"] as const) {
    let resolveHeaders!: () => void;
    const headersReady = new Promise<void>(resolve => { resolveHeaders = resolve; });
    const request: typeof fetch = async (input, init) => {
      const response = await fetch(input, init);
      resolveHeaders();
      return response;
    };
    const provider = new CompatibleProvider({ baseUrl, apiKey: "fixture-secret", kind }, request);
    const controller = new AbortController();
    const pending = provider.complete("fixture-model", [{ role: "user", content: "stop" }], [], controller.signal);

    await headersReady;
    controller.abort();
    await assert.rejects(pending, /Session cancelled\./);
  }
});

test("OpenAI-compatible stream abort rejects before accepting later output", async () => {
  const controller = new AbortController();
  const encoder = new TextEncoder();
  let canceled = false;
  let terminalQueued = false;
  const body = new ReadableStream<Uint8Array>({
    start(stream) {
      stream.enqueue(encoder.encode(frame({ choices: [{ delta: { content: "partial" } }] })));
    },
    pull(stream) {
      if (terminalQueued) {
        stream.close();
        return;
      }
      terminalQueued = true;
      stream.enqueue(encoder.encode(
        frame({ choices: [{ delta: { content: "after cancel" }, finish_reason: "stop" }] }) +
          "data: [DONE]\n\n",
      ));
    },
    cancel() { canceled = true; },
  });
  const provider = new CompatibleProvider(config, async () => new Response(body, {
    headers: { "content-type": "text/event-stream" },
  }));
  const deltas: string[] = [];

  await assert.rejects(
    provider.complete("fixture-model", [], [], controller.signal, delta => {
      deltas.push(delta);
      controller.abort();
    }),
    error => error instanceof Error && error.name === "AbortError",
  );
  assert.deepEqual(deltas, ["partial"]);
  assert.equal(canceled, true);
});

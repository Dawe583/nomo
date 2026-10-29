import test from "node:test";
import assert from "node:assert/strict";
import { createProviderClient } from "./factory.ts";

const config = {
  providerId: "google",
  transport: "google-generative-ai" as const,
  baseUrl: "https://generativelanguage.googleapis.com/v1beta",
  auth: { kind: "api-key" as const, apiKey: "fixture-secret" },
};

test("Google GenAI maps system, chat, tools and usage to GenerateContent SSE", async () => {
  let requestBody: Record<string, unknown> | undefined;
  const client = createProviderClient(config, async (input, init) => {
    assert.equal(String(input), "https://generativelanguage.googleapis.com/v1beta/models/gemini-fixture:streamGenerateContent?alt=sse");
    assert.equal((init?.headers as Record<string, string>)["x-goog-api-key"], "fixture-secret");
    requestBody = JSON.parse(String(init?.body));
    return new Response([
      'data: {"candidates":[{"content":{"role":"model","parts":[{"text":"Hello"}]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":4,"candidatesTokenCount":2,"totalTokenCount":6}}\n\n',
    ].join(""), { headers: { "content-type": "text/event-stream" } });
  }, { maxOutputTokens: 24 });
  const reply = await client.complete(
    "gemini-fixture",
    [{ role: "system", content: "Be safe" }, { role: "user", content: "Hi" }],
    [{ type: "function", function: { name: "lookup", description: "Look up", parameters: { type: "object" } } }],
    new AbortController().signal,
  );
  assert.deepEqual(requestBody?.systemInstruction, { parts: [{ text: "Be safe" }] });
  assert.deepEqual(requestBody?.contents, [{ role: "user", parts: [{ text: "Hi" }] }]);
  assert.deepEqual(requestBody?.tools, [{ functionDeclarations: [{ name: "lookup", description: "Look up", parameters: { type: "object" } }] }]);
  assert.equal((requestBody?.generationConfig as { maxOutputTokens?: number }).maxOutputTokens, 24);
  assert.equal(reply.message.content, "Hello");
  assert.equal(reply.usage?.total_tokens, 6);
});
test("Google GenAI sends user images inline after text without serializing attachment IDs", async () => {
  let requestBody: Record<string, unknown> | undefined;
  const client = createProviderClient(config, async (_input, init) => {
    requestBody = JSON.parse(String(init?.body));
    return new Response(
      'data: {"candidates":[{"content":{"role":"model","parts":[{"text":"Seen"}]},"finishReason":"STOP"}]}\n\n',
      { headers: { "content-type": "text/event-stream" } },
    );
  });

  await client.complete(
    "gemini-fixture",
    [{
      role: "user",
      content: "What is this?",
      images: [{ id: "harness-image-id", mimeType: "image/png", data: "cG5nLWZpeHR1cmU=" }],
    }],
    [],
    new AbortController().signal,
  );

  assert.deepEqual(requestBody?.contents, [{
    role: "user",
    parts: [
      { text: "What is this?" },
      { inlineData: { mimeType: "image/png", data: "cG5nLWZpeHR1cmU=" } },
    ],
  }]);
  assert.equal(JSON.stringify(requestBody).includes("harness-image-id"), false);
});

test("Google GenAI rejects images on non-user messages before requesting", async () => {
  let requestCount = 0;
  const client = createProviderClient(config, async () => {
    requestCount += 1;
    throw new Error("request must not run");
  });

  await assert.rejects(
    client.complete(
      "gemini-fixture",
      [{ role: "assistant", content: "not a user turn", images: [{ id: "image-id", mimeType: "image/png", data: "cG5n" }] }],
      [],
      new AbortController().signal,
    ),
    /images are supported only on user messages/,
  );
  assert.equal(requestCount, 0);
});


test("Google model discovery keeps only generation-capable models with nonblank IDs", async () => {
  const requests: string[] = [];
  const client = createProviderClient(config, async input => {
    const url = new URL(String(input));
    requests.push(url.href);
    if (url.href === "https://generativelanguage.googleapis.com/v1beta/models") {
      return Response.json({
        models: [
          { name: "models/gemini-fixture", displayName: "Gemini fixture", supportedGenerationMethods: ["generateContent"] },
          { name: "models/embed-fixture", supportedGenerationMethods: ["embedContent"] },
          { name: "models/malformed-method-string", supportedGenerationMethods: "generateContent" },
          { name: "models/malformed-method-entry", supportedGenerationMethods: ["generateContent", 1] },
          { name: "models/ ", supportedGenerationMethods: ["generateContent"] },
        ],
        nextPageToken: "next-page-token",
      });
    }
    if (url.href === "https://generativelanguage.googleapis.com/v1beta/models?pageToken=next-page-token") {
      return Response.json({
        models: [
          { name: "models/gemini-second-page", displayName: "Gemini second page", supportedGenerationMethods: ["generateContent"] },
        ],
      });
    }
    assert.fail(`Unexpected Google models URL: ${url.href}`);
  });
  assert.deepEqual(await client.models(), [
    { id: "gemini-fixture", name: "Gemini fixture" },
    { id: "gemini-second-page", name: "Gemini second page" },
  ]);
  assert.deepEqual(requests, [
    "https://generativelanguage.googleapis.com/v1beta/models",
    "https://generativelanguage.googleapis.com/v1beta/models?pageToken=next-page-token",
  ]);
});
test("Google model discovery rejects repeated page tokens", async () => {
  const requests: string[] = [];
  const client = createProviderClient(config, async input => {
    const url = new URL(String(input));
    requests.push(url.href);
    if (url.href === "https://generativelanguage.googleapis.com/v1beta/models")
      return Response.json({ models: [], nextPageToken: "repeat-token" });
    if (url.href === "https://generativelanguage.googleapis.com/v1beta/models?pageToken=repeat-token")
      return Response.json({ models: [], nextPageToken: "repeat-token" });
    assert.fail(`Unexpected Google models URL: ${url.href}`);
  });
  await assert.rejects(client.models(), /invalid model catalog/);
  assert.deepEqual(requests, [
    "https://generativelanguage.googleapis.com/v1beta/models",
    "https://generativelanguage.googleapis.com/v1beta/models?pageToken=repeat-token",
  ]);
});

test("Google GenAI rejects a custom host before sending the API key", () => {
  assert.throws(
    () => createProviderClient({ ...config, baseUrl: "https://attacker.example/v1" }, async () => {
      throw new Error("request must not run");
    }),
    /official HTTPS API endpoint/,
  );
});

test("Google function calls become tool calls with replayable function responses", async () => {
  const client = createProviderClient(config, async (_input, init) => {
    const body = JSON.parse(String(init?.body));
    assert.deepEqual(body.contents, [
      { role: "user", parts: [{ text: "find" }] },
      { role: "model", parts: [{ functionCall: { id: "provider-call-id", name: "lookup", args: { key: "x" } } }] },
      { role: "user", parts: [{ functionResponse: { id: "provider-call-id", name: "lookup", response: { result: "found" } } }] },
    ]);
    return new Response(
      'data: {"candidates":[{"content":{"role":"model","parts":[{"functionCall":{"id":"provider-call-id","name":"lookup","args":{"key":"x"}}}]},"finishReason":"STOP"}]}\n\n',
      { headers: { "content-type": "text/event-stream" } },
    );
  });
  const reply = await client.complete(
    "gemini-fixture",
    [
      { role: "user", content: "find" },
      { role: "assistant", content: null, tool_calls: [{ id: "provider-call-id", type: "function", function: { name: "lookup", arguments: "{\"key\":\"x\"}" } }] },
      { role: "tool", content: "found", tool_call_id: "provider-call-id" },
    ],
    [],
    new AbortController().signal,
  );
  assert.deepEqual(reply.message.tool_calls, [
    { id: "provider-call-id", type: "function", function: { name: "lookup", arguments: "{\"key\":\"x\"}" } },
  ]);
});
test("Google function calls without provider IDs use synthetic IDs", async () => {
  const client = createProviderClient(config, async () => new Response(
    'data: {"candidates":[{"content":{"role":"model","parts":[{"functionCall":{"name":"lookup","args":{"key":"x"}}}]},"finishReason":"STOP"}]}\n\n',
    { headers: { "content-type": "text/event-stream" } },
  ));
  const reply = await client.complete(
    "gemini-fixture",
    [{ role: "user", content: "find" }],
    [],
    new AbortController().signal,
  );
  assert.equal(reply.message.tool_calls?.[0]?.id, "google-call-0");
});

test("Google truncation is rejected before partial content can be accepted", async () => {
  const client = createProviderClient(config, async () => new Response(
    'data: {"candidates":[{"content":{"role":"model","parts":[{"text":"partial"}]},"finishReason":"MAX_TOKENS"}]}\n\n',
    { headers: { "content-type": "text/event-stream" } },
  ));
  await assert.rejects(
    client.complete("gemini-fixture", [{ role: "user", content: "Hi" }], [], new AbortController().signal),
    /truncated/,
  );
});
test("Google GenAI accepts usage metadata without candidate content after STOP", async () => {
  const frames = [
    { candidates: [{ content: { role: "model", parts: [{ text: "done" }] }, finishReason: "STOP" }] },
    { usageMetadata: { promptTokenCount: 4, candidatesTokenCount: 2, totalTokenCount: 6 } },
  ];
  const client = createProviderClient(config, async () => new Response(
    frames.map(frame => `data: ${JSON.stringify(frame)}\n\n`).join(""),
    { headers: { "content-type": "text/event-stream" } },
  ));
  const reply = await client.complete(
    "gemini-fixture",
    [{ role: "user", content: "Hi" }],
    [],
    new AbortController().signal,
  );
  assert.equal(reply.message.content, "done");
  assert.deepEqual(reply.usage, { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 });
});

test("Google GenAI rejects candidate content delivered after STOP", async () => {
  const frames = [
    { candidates: [{ content: { role: "model", parts: [{ text: "done" }] }, finishReason: "STOP" }] },
    { candidates: [{ content: { role: "model", parts: [
      { text: "late" },
      { functionCall: { name: "lookup", args: { key: "x" } } },
    ] } }] },
  ];
  const client = createProviderClient(config, async () => new Response(
    frames.map(frame => `data: ${JSON.stringify(frame)}\n\n`).join(""),
    { headers: { "content-type": "text/event-stream" } },
  ));
  const deltas: string[] = [];
  await assert.rejects(
    client.complete(
      "gemini-fixture",
      [{ role: "user", content: "Hi" }],
      [],
      new AbortController().signal,
      delta => { deltas.push(delta); },
    ),
    /after completion/,
  );
  assert.deepEqual(deltas, ["done"]);
});

test("Google GenAI rejects more candidates than its default single-candidate request", async () => {
  const frames = [{
    candidates: [
      { index: 0, content: { role: "model", parts: [{ text: "first answer" }] }, finishReason: "STOP" },
      { index: 1, content: { role: "model", parts: [{ text: "alternate answer" }] }, finishReason: "STOP" },
    ],
  }];
  const client = createProviderClient(config, async () => new Response(
    frames.map(frame => `data: ${JSON.stringify(frame)}\n\n`).join(""),
    { headers: { "content-type": "text/event-stream" } },
  ));
  const deltas: string[] = [];
  await assert.rejects(
    client.complete("gemini-fixture", [{ role: "user", content: "Hi" }], [], new AbortController().signal, delta => {
      deltas.push(delta);
    }),
    /unexpected candidate/,
  );
  assert.deepEqual(deltas, []);
});

test("Google GenAI rejects a candidate index outside its default single-candidate request", async () => {
  const client = createProviderClient(config, async () => new Response(
    'data: {"candidates":[{"index":1,"content":{"role":"model","parts":[{"text":"alternate answer"}]},"finishReason":"STOP"}]}\n\n',
    { headers: { "content-type": "text/event-stream" } },
  ));
  const deltas: string[] = [];
  await assert.rejects(
    client.complete("gemini-fixture", [{ role: "user", content: "Hi" }], [], new AbortController().signal, delta => {
      deltas.push(delta);
    }),
    /unexpected candidate/,
  );
  assert.deepEqual(deltas, []);
});

test("Google GenAI aborts an in-flight stream without accepting partial output", async () => {
  const controller = new AbortController();
  const encoder = new TextEncoder();
  let canceled = false;
  let terminalQueued = false;
  const body = new ReadableStream<Uint8Array>({
    start(stream) {
      stream.enqueue(encoder.encode('data: {"candidates":[{"content":{"role":"model","parts":[{"text":"partial"}]}}]}\n\n'));
    },
    pull(stream) {
      if (terminalQueued) {
        stream.close();
        return;
      }
      terminalQueued = true;
      stream.enqueue(encoder.encode('data: {"candidates":[{"content":{"role":"model","parts":[{"text":"after cancel"}]},"finishReason":"STOP"}]}\n\n'));
    },
    cancel() { canceled = true; },
  });
  const client = createProviderClient(config, async () => new Response(body, {
    headers: { "content-type": "text/event-stream" },
  }));
  const deltas: string[] = [];

  await assert.rejects(
    client.complete("gemini-fixture", [{ role: "user", content: "Hi" }], [], controller.signal, value => {
      deltas.push(value);
      controller.abort();
    }),
    error => error instanceof Error && error.name === "AbortError",
  );
  assert.deepEqual(deltas, ["partial"]);
  assert.equal(canceled, true);
});

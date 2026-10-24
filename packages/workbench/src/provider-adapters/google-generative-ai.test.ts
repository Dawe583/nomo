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

test("Google model discovery keeps only generation-capable models", async () => {
  const client = createProviderClient(config, async input => {
    assert.equal(String(input), "https://generativelanguage.googleapis.com/v1beta/models");
    return Response.json({
      models: [
        { name: "models/gemini-fixture", displayName: "Gemini fixture", supportedGenerationMethods: ["generateContent"] },
        { name: "models/embed-fixture", supportedGenerationMethods: ["embedContent"] },
      ],
    });
  });
  assert.deepEqual(await client.models(), [{ id: "gemini-fixture", name: "Gemini fixture" }]);
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
      { role: "model", parts: [{ functionCall: { name: "lookup", args: { key: "x" } } }] },
      { role: "user", parts: [{ functionResponse: { name: "lookup", response: { result: "found" } } }] },
    ]);
    return new Response(
      'data: {"candidates":[{"content":{"role":"model","parts":[{"functionCall":{"name":"lookup","args":{"key":"x"}}}]},"finishReason":"STOP"}]}\n\n',
      { headers: { "content-type": "text/event-stream" } },
    );
  });
  const reply = await client.complete(
    "gemini-fixture",
    [
      { role: "user", content: "find" },
      { role: "assistant", content: null, tool_calls: [{ id: "call-1", type: "function", function: { name: "lookup", arguments: "{\"key\":\"x\"}" } }] },
      { role: "tool", content: "found", tool_call_id: "call-1" },
    ],
    [],
    new AbortController().signal,
  );
  assert.deepEqual(reply.message.tool_calls, [
    { id: "google-call-0", type: "function", function: { name: "lookup", arguments: "{\"key\":\"x\"}" } },
  ]);
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

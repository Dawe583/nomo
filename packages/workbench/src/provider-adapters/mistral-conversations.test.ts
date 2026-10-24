import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import test from "node:test";
import { createProviderClient } from "./factory.ts";
import { ProviderRequestError } from "../provider.ts";

const config = {
  providerId: "mistral",
  transport: "mistral-conversations" as const,
  baseUrl: "https://api.mistral.ai",
  auth: { kind: "api-key" as const, apiKey: "mistral-fixture-secret" },
};

function listen(handler: (request: import("node:http").IncomingMessage, response: import("node:http").ServerResponse) => void): Promise<{ server: Server; url: string }> {
  const server = createServer(handler);
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") return reject(new Error("fixture did not bind"));
      resolve({ server, url: `http://127.0.0.1:${address.port}` });
    });
  });
}

async function readBody(request: import("node:http").IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

test("Mistral typed transport lists models and streams text, incremental tools, and usage", async (t) => {
  let modelRequest = false;
  let completionBody: Record<string, unknown> | undefined;
  let fixtureError: unknown;
  const fixture = await listen((request, response) => {
    void (async () => {
      try {
        assert.equal(request.headers.authorization, "Bearer mistral-fixture-secret");
        if (request.url === "/v1/models") {
          modelRequest = true;
          assert.equal(request.method, "GET");
          response.setHeader("content-type", "application/json");
          response.end(JSON.stringify({ data: [{ id: "mistral-small-latest", name: "Mistral Small" }] }));
          return;
        }
        assert.equal(request.url, "/v1/chat/completions");
        assert.equal(request.method, "POST");
        assert.equal(request.headers.accept, "text/event-stream");
        completionBody = JSON.parse(await readBody(request));
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.end([
          'data: {"choices":[{"index":0,"delta":{"content":"hello "},"finish_reason":null}]}\n\n',
          'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call-1","type":"function","function":{"name":"inspect","arguments":"{\\"x\\":"}}]},"finish_reason":null}]}\n\n',
          'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"1}"}}]},"finish_reason":null}]}\n\n',
          'data: {"choices":[],"usage":{"prompt_tokens":4,"completion_tokens":2,"total_tokens":6}}\n\n',
          'data: {"choices":[{"index":0,"delta":{"content":"world"},"finish_reason":"tool_calls"}]}\n\n',
          "data: [DONE]\n\n",
        ].join(""));
      } catch (error) {
        fixtureError = error;
        response.writeHead(500);
        response.end("fixture failure");
      }
    })();
  });
  t.after(() => new Promise<void>(resolve => fixture.server.close(() => resolve())));

  const client = createProviderClient({ ...config, baseUrl: fixture.url });
  assert.deepEqual(await client.models(), [{ id: "mistral-small-latest", name: "Mistral Small" }]);
  const deltas: string[] = [];
  const reply = await client.complete(
    "mistral-small-latest",
    [
      { role: "system", content: "Be concise" },
      { role: "user", content: "inspect" },
      { role: "assistant", content: null, tool_calls: [{ id: "prior", type: "function", function: { name: "inspect", arguments: "{}" } }] },
      { role: "tool", content: "prior result", tool_call_id: "prior" },
    ],
    [{ type: "function", function: { name: "inspect", description: "Inspect", parameters: { type: "object" } } }],
    new AbortController().signal,
    delta => { deltas.push(delta); },
  );
  assert.equal(fixtureError, undefined);
  assert.equal(modelRequest, true);
  assert.equal(completionBody?.model, "mistral-small-latest");
  assert.equal(completionBody?.stream, true);
  assert.equal(completionBody?.max_tokens, 4096);
  assert.deepEqual(completionBody?.messages, [
    { role: "system", content: "Be concise" },
    { role: "user", content: "inspect" },
    { role: "assistant", content: null, tool_calls: [{ id: "prior", type: "function", function: { name: "inspect", arguments: "{}" } }] },
    { role: "tool", content: "prior result", tool_call_id: "prior" },
  ]);
  assert.equal(reply.message.content, "hello world");
  assert.deepEqual(reply.message.tool_calls, [{ id: "call-1", type: "function", function: { name: "inspect", arguments: "{\"x\":1}" } }]);
  assert.deepEqual(reply.usage, { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 });
  assert.deepEqual(deltas, ["hello ", "world"]);
});

test("Mistral transport refuses an untrusted host before sending its API key", () => {
  assert.throws(
    () => createProviderClient({ ...config, baseUrl: "https://attacker.invalid" }, async () => { throw new Error("must not request"); }),
    /official Mistral HTTPS endpoint/,
  );
});

test("Mistral transport requires its typed API-key auth profile", () => {
  assert.throws(
    () => createProviderClient({ ...config, auth: { kind: "none" } as const }),
    /API-key authentication profile/,
  );
});

test("Mistral rejects an unterminated or length-finished completion", async (t) => {
  const fixture = await listen((_request, response) => {
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end('data: {"choices":[{"delta":{"content":"partial"},"finish_reason":"length"}]}\n\n');
  });
  t.after(() => new Promise<void>(resolve => fixture.server.close(() => resolve())));
  const client = createProviderClient({ ...config, baseUrl: fixture.url });
  await assert.rejects(
    client.complete("mistral-small-latest", [{ role: "user", content: "go" }], [], new AbortController().signal),
    /truncated|ended before completion/i,
  );
});

test("Mistral refuses a clean SSE event stream that omits [DONE]", async (t) => {
  const fixture = await listen((_request, response) => {
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end('data: {"choices":[{"delta":{"content":"partial"},"finish_reason":"stop"}]}\n\n');
  });
  t.after(() => new Promise<void>(resolve => fixture.server.close(() => resolve())));
  const client = createProviderClient({ ...config, baseUrl: fixture.url });
  await assert.rejects(
    client.complete("mistral-small-latest", [{ role: "user", content: "go" }], [], new AbortController().signal),
    /ended before completion/i,
  );
});

test("Mistral non-success responses expose status without the provider error body", async (t) => {
  const fixture = await listen((_request, response) => {
    response.writeHead(429, { "content-type": "application/json" });
    response.end(JSON.stringify({ message: "fixture private response body" }));
  });
  t.after(() => new Promise<void>(resolve => fixture.server.close(() => resolve())));
  const client = createProviderClient({ ...config, baseUrl: fixture.url });
  await assert.rejects(
    client.complete("mistral-small-latest", [{ role: "user", content: "go" }], [], new AbortController().signal),
    error => error instanceof ProviderRequestError && error.status === 429 && !error.message.includes("fixture private response body"),
  );
});

test("Mistral redacts an API key split across content deltas", async (t) => {
  const fixture = await listen((_request, response) => {
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end([
      `data: ${JSON.stringify({ choices: [{ delta: { content: "prefix mistral-fixture-" }, finish_reason: null }] })}\n\n`,
      `data: ${JSON.stringify({ choices: [{ delta: { content: "secret suffix" }, finish_reason: "stop" }] })}\n\n`,
      "data: [DONE]\n\n",
    ].join(""));
  });
  t.after(() => new Promise<void>(resolve => fixture.server.close(() => resolve())));
  const client = createProviderClient({ ...config, baseUrl: fixture.url });
  const deltas: string[] = [];
  await client.complete("mistral-small-latest", [{ role: "user", content: "repeat the key" }], [], new AbortController().signal, value => { deltas.push(value); });
  assert.deepEqual(deltas, ["prefix ", "[redacted] suffix"]);
  assert.equal(deltas.join("").includes(config.auth.apiKey), false);
});

test("Mistral rejects an oversized SSE frame", async (t) => {
  const fixture = await listen((_request, response) => {
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end(`data: ${JSON.stringify({ choices: [{ delta: { content: "x".repeat(2_000_001) }, finish_reason: "stop" }] })}\n\n`);
  });
  t.after(() => new Promise<void>(resolve => fixture.server.close(() => resolve())));
  const client = createProviderClient({ ...config, baseUrl: fixture.url });
  await assert.rejects(
    client.complete("mistral-small-latest", [{ role: "user", content: "go" }], [], new AbortController().signal),
    /Provider stream exceeded the supported size/i,
  );
});

test("Mistral caps cumulative response text across bounded SSE frames", async (t) => {
  let releaseSecond!: () => void;
  const firstFrameConsumed = new Promise<void>(resolve => { releaseSecond = resolve; });
  const fixture = await listen((_request, response) => {
    response.writeHead(200, { "content-type": "text/event-stream" });
    void (async () => {
      response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "x".repeat(1_100_000) }, finish_reason: null }] })}\n\n`);
      await firstFrameConsumed;
      response.end([
        `data: ${JSON.stringify({ choices: [{ delta: { content: "y".repeat(1_000_001) }, finish_reason: "stop" }] })}\n\n`,
        "data: [DONE]\n\n",
      ].join(""));
    })();
  });
  t.after(() => new Promise<void>(resolve => fixture.server.close(() => resolve())));
  const client = createProviderClient({ ...config, baseUrl: fixture.url });
  let released = false;
  await assert.rejects(
    client.complete("mistral-small-latest", [{ role: "user", content: "go" }], [], new AbortController().signal, () => {
      if (!released) { released = true; releaseSecond(); }
    }),
    /Provider response exceeded the supported size/i,
  );
});

test("Mistral bounds cumulative streamed tool arguments", async (t) => {
  const argumentsText = JSON.stringify({ value: "x".repeat(1_000_001) });
  const fixture = await listen((_request, response) => {
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end(`data: ${JSON.stringify({
      choices: [{
        delta: { tool_calls: [{ index: 0, id: "call-1", type: "function", function: { name: "inspect", arguments: argumentsText } }] },
        finish_reason: null,
      }],
    })}\n\n`);
  });
  t.after(() => new Promise<void>(resolve => fixture.server.close(() => resolve())));
  const client = createProviderClient({ ...config, baseUrl: fixture.url });
  await assert.rejects(
    client.complete("mistral-small-latest", [{ role: "user", content: "go" }], [], new AbortController().signal),
    /tool arguments exceeded the supported size/i,
  );
});

test("Mistral rejects an empty completed assistant reply", async (t) => {
  const fixture = await listen((_request, response) => {
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end([
      `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}\n\n`,
      "data: [DONE]\n\n",
    ].join(""));
  });
  t.after(() => new Promise<void>(resolve => fixture.server.close(() => resolve())));
  const client = createProviderClient({ ...config, baseUrl: fixture.url });
  await assert.rejects(
    client.complete("mistral-small-latest", [{ role: "user", content: "go" }], [], new AbortController().signal),
    /no answer/i,
  );
});

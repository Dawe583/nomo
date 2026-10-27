import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import test from "node:test";
import { createProviderClient } from "./factory.ts";

function listen(handler: (request: IncomingMessage, response: ServerResponse) => void): Promise<{ server: Server; url: string }> {
  const server = createServer(handler);
  const listening = once(server, "listening");
  server.listen(0, "127.0.0.1");
  return listening.then(() => {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("fixture did not bind");
    return { server, url: `http://127.0.0.1:${address.port}` };
  });
}

async function close(server: Server): Promise<void> {
  const closed = once(server, "close");
  server.close();
  await closed;
}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

test("Ollama native chat lists local tags and handles NDJSON tool/usage events without auth", async (t) => {
  let chatBody: Record<string, unknown> | undefined;
  let fixtureError: unknown;
  const fixture = await listen((request, response) => {
    void (async () => {
      try {
        assert.equal(request.headers.authorization, undefined);
        if (request.url === "/api/tags") {
          assert.equal(request.method, "GET");
          response.setHeader("content-type", "application/json");
          response.end(JSON.stringify({ models: [
            { name: "qwen3:8b", model: "qwen3:8b", details: { family: "qwen3" } },
            { name: "nomic-embed-text", model: "nomic-embed-text", details: { family: "nomic" } },
            { name: 123, model: 123 },
          ] }));
          return;
        }
        assert.equal(request.url, "/api/chat");
        assert.equal(request.method, "POST");
        assert.match(request.headers.accept ?? "", /application\/(?:x-ndjson|json)/);
        chatBody = JSON.parse(await readBody(request));
        response.writeHead(200, { "content-type": "application/x-ndjson" });
        response.end([
          JSON.stringify({ message: { role: "assistant", content: "checking " }, done: false }),
          JSON.stringify({ message: { role: "assistant", tool_calls: [{ function: { name: "inspect", arguments: { path: "src" } } }] }, done: false }),
          JSON.stringify({ message: { role: "assistant", content: "ready" }, done: true, done_reason: "stop", prompt_eval_count: 3, eval_count: 4 }),
        ].join("\n") + "\n");
      } catch (error) {
        fixtureError = error;
        response.writeHead(500);
        response.end("fixture failure");
      }
    })();
  });
  t.after(() => close(fixture.server));

  const client = createProviderClient({
    providerId: "ollama",
    transport: "ollama-chat",
    baseUrl: fixture.url,
    auth: { kind: "none" },
  });
  assert.deepEqual(await client.models(), [
    { id: "qwen3:8b", name: "qwen3:8b" },
    { id: "nomic-embed-text", name: "nomic-embed-text" },
  ]);
  const deltas: string[] = [];
  const reply = await client.complete(
    "qwen3:8b",
    [
      { role: "system", content: "Be concise" },
      { role: "user", content: "inspect" },
      { role: "assistant", content: null, tool_calls: [{ id: "prior-call", type: "function", function: { name: "inspect", arguments: "{\"path\":\"src\"}" } }] },
      { role: "tool", content: "prior result", tool_call_id: "prior-call" },
    ],
    [{ type: "function", function: { name: "inspect", description: "Inspect files", parameters: { type: "object" } } }],
    new AbortController().signal,
    delta => { deltas.push(delta); },
  );
  assert.equal(fixtureError, undefined);
  assert.equal(chatBody?.model, "qwen3:8b");
  assert.equal(chatBody?.stream, true);
  assert.deepEqual(chatBody?.messages, [
    { role: "system", content: "Be concise" },
    { role: "user", content: "inspect" },
    { role: "assistant", content: "", tool_calls: [{ function: { name: "inspect", arguments: { path: "src" } } }] },
    { role: "tool", content: "prior result", tool_name: "inspect" },
  ]);
  assert.deepEqual(reply.message.tool_calls, [{ id: "call_0", type: "function", function: { name: "inspect", arguments: "{\"path\":\"src\"}" } }]);
  assert.equal(reply.message.content, "checking ready");
  assert.deepEqual(reply.usage, { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 });
  assert.deepEqual(deltas, ["checking ", "ready"]);
});
test("Ollama Cloud sends its API key to the hosted native API", async () => {
  const requests: Array<{ url: string; authorization: string | undefined }> = [];
  const client = createProviderClient(
    {
      providerId: "ollama-cloud",
      transport: "ollama-chat",
      baseUrl: "https://ollama.com",
      auth: { kind: "api-key", apiKey: "fixture-cloud-secret" },
      model: "gpt-oss:120b",
    },
    async (input, init) => {
      requests.push({
        url: String(input),
        authorization: new Headers(init?.headers).get("authorization") ?? undefined,
      });
      assert.equal(String(input), "https://ollama.com/api/chat");
      return new Response(
        [
          { message: { role: "assistant", content: "fixture-" }, done: false },
          { message: { role: "assistant", content: "cloud-secret" }, done: false },
          { message: { role: "assistant", content: "ready" }, done: true, done_reason: "stop" },
        ].map((event) => JSON.stringify(event)).join("\n") + "\n",
        { headers: { "content-type": "application/x-ndjson" } },
      );
    },
  );

  assert.deepEqual(await client.models(), [
    { id: "gpt-oss:120b", name: "gpt-oss:120b" },
  ]);
  const deltas: string[] = [];
  const reply = await client.complete(
    "gpt-oss:120b",
    [{ role: "user", content: "check" }],
    [],
    new AbortController().signal,
    (delta) => { deltas.push(delta); },
  );
  assert.equal(reply.message.content, "fixture-cloud-secretready");
  assert.deepEqual(deltas, ["[redacted]", "ready"]);
  assert.equal(client.redact("error: fixture-cloud-secret"), "error: [redacted]");
  assert.deepEqual(requests, [
    {
      url: "https://ollama.com/api/chat",
      authorization: "Bearer fixture-cloud-secret",
    },
  ]);
});

test("Ollama Cloud refuses noncanonical endpoints", () => {
  for (const baseUrl of [
    "https://ollama.evil",
    "https://user:pass@ollama.com",
    "https://ollama.com/other",
    "http://127.0.0.1:11434",
  ]) {
    assert.throws(
      () => createProviderClient({
        providerId: "ollama-cloud",
        transport: "ollama-chat",
        baseUrl,
        auth: { kind: "api-key", apiKey: "fixture-cloud-secret" },
      }, async () => { throw new Error("must not request"); }),
      /Ollama Cloud requires the hosted HTTPS endpoint/,
    );
  }
});

test("Ollama refuses streams without a final done event", async (t) => {
  const fixture = await listen((_request, response) => {
    response.writeHead(200, { "content-type": "application/x-ndjson" });
    response.end(`${JSON.stringify({ message: { role: "assistant", content: "partial" }, done: false })}\n`);
  });
  t.after(() => close(fixture.server));
  const client = createProviderClient({
    providerId: "ollama",
    transport: "ollama-chat",
    baseUrl: fixture.url,
    auth: { kind: "none" },
  });
  await assert.rejects(
    client.complete("qwen3:8b", [{ role: "user", content: "go" }], [], new AbortController().signal),
    /ended before completion|truncated/i,
  );
});

test("Ollama rejects malformed streamed tool calls before returning them", async (t) => {
  const fixture = await listen((_request, response) => {
    response.writeHead(200, { "content-type": "application/x-ndjson" });
    response.end(`${JSON.stringify({
      message: { role: "assistant", tool_calls: [{ function: { arguments: { path: "src" } } }] },
      done: true,
      done_reason: "stop",
    })}\n`);
  });
  t.after(() => close(fixture.server));
  const client = createProviderClient({
    providerId: "ollama",
    transport: "ollama-chat",
    baseUrl: fixture.url,
    auth: { kind: "none" },
  });
  await assert.rejects(
    client.complete("qwen3:8b", [{ role: "user", content: "go" }], [], new AbortController().signal),
    /invalid tool call/i,
  );
});

test("Ollama rejects an incomplete final NDJSON record", async (t) => {
  const fixture = await listen((_request, response) => {
    response.writeHead(200, { "content-type": "application/x-ndjson" });
    response.end('{"message":');
  });
  t.after(() => close(fixture.server));
  const client = createProviderClient({
    providerId: "ollama",
    transport: "ollama-chat",
    baseUrl: fixture.url,
    auth: { kind: "none" },
  });
  await assert.rejects(
    client.complete("qwen3:8b", [{ role: "user", content: "go" }], [], new AbortController().signal),
    /incomplete NDJSON|invalid NDJSON stream/i,
  );
});

test("Ollama rejects public and HTTPS endpoints rather than sending a no-key request off loopback", () => {
  const config = { providerId: "ollama", transport: "ollama-chat" as const, auth: { kind: "none" as const } };
  for (const baseUrl of ["https://localhost:11434", "http://ollama.local:11434", "http://192.0.2.10:11434"]) {
    assert.throws(
      () => createProviderClient({ ...config, baseUrl }, async () => { throw new Error("must not request"); }),
      /loopback HTTP endpoint/,
    );
  }
  assert.throws(
    () => createProviderClient({
      providerId: "ollama",
      transport: "ollama-chat",
      baseUrl: "http://localhost:11434",
      auth: { kind: "api-key", apiKey: "unused-fixture-key" },
    }),
    /no authentication/,
  );
});

test("Ollama forwards cancellation to the local chat request", async (t) => {
  const controller = new AbortController();
  const fixture = await listen((request) => {
    void readBody(request).then(() => controller.abort());
  });
  t.after(() => close(fixture.server));
  const client = createProviderClient({
    providerId: "ollama",
    transport: "ollama-chat",
    baseUrl: fixture.url,
    auth: { kind: "none" },
  });
  await assert.rejects(
    client.complete("qwen3:8b", [{ role: "user", content: "stop" }], [], controller.signal),
    /cancel|aborted/i,
  );
});

test("Ollama rejects an oversized NDJSON frame", async (t) => {
  const fixture = await listen((_request, response) => {
    response.writeHead(200, { "content-type": "application/x-ndjson" });
    response.end(`${JSON.stringify({ message: { role: "assistant", content: "x".repeat(2_000_001) }, done: false })}\n`);
  });
  t.after(() => close(fixture.server));
  const client = createProviderClient({
    providerId: "ollama",
    transport: "ollama-chat",
    baseUrl: fixture.url,
    auth: { kind: "none" },
  });
  await assert.rejects(
    client.complete("qwen3:8b", [{ role: "user", content: "go" }], [], new AbortController().signal),
    /Provider stream exceeded the supported size/i,
  );
});

test("Ollama caps cumulative response text across bounded NDJSON records", async (t) => {
  let releaseSecond!: () => void;
  const firstRecordConsumed = new Promise<void>(resolve => { releaseSecond = resolve; });
  const fixture = await listen((_request, response) => {
    response.writeHead(200, { "content-type": "application/x-ndjson" });
    void (async () => {
      response.write(`${JSON.stringify({ message: { role: "assistant", content: "x".repeat(1_100_000) }, done: false })}\n`);
      await firstRecordConsumed;
      response.end(`${JSON.stringify({ message: { role: "assistant", content: "y".repeat(1_000_001) }, done: true, done_reason: "stop" })}\n`);
    })();
  });
  t.after(() => close(fixture.server));
  const client = createProviderClient({
    providerId: "ollama",
    transport: "ollama-chat",
    baseUrl: fixture.url,
    auth: { kind: "none" },
  });
  let released = false;
  await assert.rejects(
    client.complete("qwen3:8b", [{ role: "user", content: "go" }], [], new AbortController().signal, () => {
      if (!released) { released = true; releaseSecond(); }
    }),
    /Provider response exceeded the supported size/i,
  );
});

test("Ollama bounds cumulative streamed tool arguments", async (t) => {
  const fixture = await listen((_request, response) => {
    response.writeHead(200, { "content-type": "application/x-ndjson" });
    response.end(`${JSON.stringify({
      message: { role: "assistant", tool_calls: [{ function: { name: "inspect", arguments: { value: "x".repeat(1_000_001) } } }] },
      done: true,
      done_reason: "tool_calls",
    })}\n`);
  });
  t.after(() => close(fixture.server));
  const client = createProviderClient({
    providerId: "ollama",
    transport: "ollama-chat",
    baseUrl: fixture.url,
    auth: { kind: "none" },
  });
  await assert.rejects(
    client.complete("qwen3:8b", [{ role: "user", content: "go" }], [], new AbortController().signal),
    /tool arguments exceeded the supported size/i,
  );
});

test("Ollama preserves prototype-like tool arguments as safe own properties", async (t) => {
  const args = JSON.parse('{"__proto__":{"polluted":true},"value":"ok"}') as Record<string, unknown>;
  const fixture = await listen((_request, response) => {
    response.writeHead(200, { "content-type": "application/x-ndjson" });
    response.end(`${JSON.stringify({
      message: { role: "assistant", tool_calls: [{ function: { name: "inspect", arguments: args } }] },
      done: true,
      done_reason: "tool_calls",
    })}\n`);
  });
  t.after(() => close(fixture.server));
  const client = createProviderClient({
    providerId: "ollama",
    transport: "ollama-chat",
    baseUrl: fixture.url,
    auth: { kind: "none" },
  });
  const reply = await client.complete("qwen3:8b", [{ role: "user", content: "go" }], [], new AbortController().signal);
  const result = JSON.parse(reply.message.tool_calls?.[0]?.function.arguments ?? "{}") as Record<string, unknown>;
  assert.equal(Object.hasOwn(result, "__proto__"), true);
  assert.equal(Object.getPrototypeOf(result), Object.prototype);
  assert.deepEqual(result, args);
});

test("Ollama rejects an empty completed assistant reply", async (t) => {
  const fixture = await listen((_request, response) => {
    response.writeHead(200, { "content-type": "application/x-ndjson" });
    response.end(`${JSON.stringify({ message: { role: "assistant", content: "" }, done: true, done_reason: "stop" })}\n`);
  });
  t.after(() => close(fixture.server));
  const client = createProviderClient({
    providerId: "ollama",
    transport: "ollama-chat",
    baseUrl: fixture.url,
    auth: { kind: "none" },
  });
  await assert.rejects(
    client.complete("qwen3:8b", [{ role: "user", content: "go" }], [], new AbortController().signal),
    /no answer/i,
  );
});

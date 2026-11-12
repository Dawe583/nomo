import test from "node:test";
import assert from "node:assert/strict";
import { createProviderClient } from "./factory.ts";
import { catalogFor } from "../provider.ts";
import type { ProviderAdapterConfig } from "./types.ts";
import { assertProviderDescriptorInManifest } from "../provider-catalog.ts";

test("legacy compatible configuration keeps catalog and completion behavior through the factory", async () => {
  const calls: string[] = [];
  const client = createProviderClient(
    { baseUrl: "https://provider.test/v1", apiKey: "fixture-secret" },
    async (input) => {
      const url = String(input);
      calls.push(url);
      if (url.endsWith("/models")) return Response.json({ data: [{ id: "fixture-model" }] });
      return Response.json({ choices: [{ message: { role: "assistant", content: "ok" }, finish_reason: "stop" }] });
    },
  );

  assert.deepEqual(await client.models(), [{ id: "fixture-model", name: "fixture-model" }]);
  const reply = await client.complete("fixture-model", [], [], new AbortController().signal);
  assert.equal(reply.message.content, "ok");
  assert.deepEqual(calls, ["https://provider.test/v1/models", "https://provider.test/v1/chat/completions"]);
});

test("legacy compatible discovery excludes blank model IDs", async () => {
  const client = createProviderClient(
    { baseUrl: "https://provider.test/v1", apiKey: "fixture-secret" },
    async () => Response.json({
      data: [
        { id: "fixture-model" },
        { id: "" },
        { id: " " },
      ],
    }),
  );
  assert.deepEqual(await client.models(), [
    { id: "fixture-model", name: "fixture-model" },
  ]);
});

test("anthropic legacy configuration keeps Anthropic Messages auth through the factory", async () => {
  const client = createProviderClient(
    { baseUrl: "https://api.anthropic.com/v1", apiKey: "fixture-secret", kind: "anthropic" },
    async (input, init) => {
      const url = new URL(String(input));
      assert.equal(url.pathname, "/v1/models");
      assert.equal(url.searchParams.get("limit"), "1000");
      assert.equal((init?.headers as Record<string, string>)?.["x-api-key"], "fixture-secret");
      return Response.json({ data: [{ id: "claude-fixture", type: "model" }], has_more: false, last_id: "claude-fixture" });
    },
  );
  assert.deepEqual(await client.models(), [{ id: "claude-fixture", name: "claude-fixture" }]);
});
test("Anthropic model discovery follows the documented cursor through every catalog page", async () => {
  const requests: URL[] = [];
  const client = createProviderClient(
    { baseUrl: "https://api.anthropic.com/v1", apiKey: "fixture-secret", kind: "anthropic" },
    async input => {
      const url = new URL(String(input));
      requests.push(url);
      if (url.searchParams.get("after_id") === "claude-first")
        return Response.json({
          data: [{ id: "claude-second", type: "model" }],
          has_more: false,
          last_id: "claude-second",
        });
      return Response.json({
        data: [{ id: "claude-first", type: "model" }],
        has_more: true,
        last_id: "claude-first",
      });
    },
  );
  assert.deepEqual(await client.models(), [
    { id: "claude-first", name: "claude-first" },
    { id: "claude-second", name: "claude-second" },
  ]);
  assert.deepEqual(requests.map(url => url.href), [
    "https://api.anthropic.com/v1/models?limit=1000",
    "https://api.anthropic.com/v1/models?limit=1000&after_id=claude-first",
  ]);
});
test("Anthropic model discovery rejects missing pagination metadata", async () => {
  const client = createProviderClient(
    { baseUrl: "https://api.anthropic.com/v1", apiKey: "fixture-secret", kind: "anthropic" },
    async () => Response.json({ data: [{ id: "claude-fixture", type: "model" }] }),
  );
  await assert.rejects(client.models(), /invalid model catalog/i);
});

test("Anthropic model discovery rejects a repeated page cursor", async () => {
  let requests = 0;
  const client = createProviderClient(
    { baseUrl: "https://api.anthropic.com/v1", apiKey: "fixture-secret", kind: "anthropic" },
    async () => {
      requests++;
      return Response.json({
        data: [{ id: `claude-${requests}`, type: "model" }],
        has_more: true,
        last_id: "same-cursor",
      });
    },
  );
  await assert.rejects(client.models(), /invalid model catalog/i);
  assert.equal(requests, 2);
});

test("Anthropic custom paths retain single-page catalog behavior", async () => {
  let requestUrl: URL | undefined;
  const client = createProviderClient(
    {
      baseUrl: "https://api.anthropic.com/gateway/v1",
      apiKey: "fixture-secret",
      kind: "anthropic",
    },
    async input => {
      requestUrl = new URL(String(input));
      return Response.json({ data: [{ id: "claude-fixture", type: "model" }] });
    },
  );
  assert.deepEqual(await client.models(), [
    { id: "claude-fixture", name: "claude-fixture" },
  ]);
  assert.equal(
    requestUrl?.href,
    "https://api.anthropic.com/gateway/v1/models",
  );
});

test("factory rejects unknown explicit transport instead of falling back to chat completions", () => {
  assert.throws(
    () => createProviderClient({ baseUrl: "https://provider.test/v1", apiKey: "fixture-secret", api: "unknown-wire" }),
    /Unsupported provider transport/,
  );
});

test("Google Gemini CLI cannot fall back to a generic API-key transport", () => {
  const requests: string[] = [];
  const request: typeof fetch = async (input) => {
    requests.push(String(input));
    return Response.json({});
  };
  assert.throws(
    () => createProviderClient({
      providerId: "google-gemini-cli",
      transport: "openai-completions",
      baseUrl: "https://cloudcode-pa.googleapis.com",
      auth: { kind: "api-key", apiKey: "fixture-key" },
    }, request),
    /Provider API google-gemini-cli is unavailable:.*first-party.*OAuth/i,
  );
  assert.throws(
    () => createProviderClient({
      providerId: "google",
      transport: "google-gemini-cli",
      baseUrl: "https://cloudcode-pa.googleapis.com",
      auth: { kind: "api-key", apiKey: "fixture-key" },
    }, request),
    /Provider API google-gemini-cli is unavailable:.*first-party.*OAuth/i,
  );
  assert.throws(
    () => createProviderClient({
      providerId: "google-gemini-cli",
      baseUrl: "https://cloudcode-pa.googleapis.com",
      apiKey: "fixture-key",
    }, request),
    /Provider API google-gemini-cli is unavailable:.*first-party.*OAuth/i,
  );
  assert.deepEqual(requests, []);
});

const agentApiCases = [
  {
    providerId: "cursor",
    transport: "cursor-agent",
    baseUrl: "https://api2.cursor.sh",
    auth: { kind: "api-key", apiKey: "fixture-cursor-key" },
    expected: /Cursor Connect\/protobuf agent transport and OAuth lifecycle are not implemented/,
  },
  {
    providerId: "factory-droid",
    transport: "factory-droid-agent",
    baseUrl: "https://api.factory.ai",
    auth: { kind: "api-key", apiKey: "fixture-factory-key" },
    expected: /Factory LLM proxy requires WorkOS device-code auth and identity headers; Factory API keys are rejected/,
  },
  {
    providerId: "gitlab-duo-agent",
    transport: "gitlab-duo-agent",
    baseUrl: "https://gitlab.com",
    auth: { kind: "api-key", apiKey: "fixture-gitlab-token" },
    expected: /GitLab Duo Workflow protocol .*not implemented/,
  },
  {
    providerId: "devin",
    transport: "devin-agent",
    baseUrl: "https://server.codeium.com",
    auth: { kind: "api-key", apiKey: "fixture-devin-token" },
    expected: /Devin Cascade Connect\/protobuf transport and OAuth session-token exchange are not implemented/,
  },
  {
    providerId: "apple",
    transport: "apple-foundation-models",
    baseUrl: "local://apple-foundation-models",
    auth: { kind: "none" },
    expected: /Apple Foundation Models native pi-natives bridge is not linked/,
  },
  {
    providerId: "openai-codex",
    transport: "openai-codex-responses",
    baseUrl: "https://chatgpt.com/backend-api",
    auth: { kind: "api-key", apiKey: "fixture-api-key-is-not-oauth" },
    expected: /Codex Responses requires ChatGPT account sign-in; the private backend route and Workbench OAuth lifecycle\/app-server bridge are unavailable/,
  },
] satisfies readonly (ProviderAdapterConfig & { expected: RegExp })[];

test("pinned provider APIs fail closed with specific reasons before any request", () => {
  let requests = 0;
  const request: typeof fetch = async () => {
    requests++;
    throw new Error("blocked APIs must not call a provider");
  };
  for (const { expected, ...config } of agentApiCases) {
    assert.throws(() => createProviderClient(config, request), expected);
  }
  assert.equal(requests, 0);
});

test("agent provider IDs cannot fall back to generic completions without an explicit API", () => {
  for (const { providerId, expected } of agentApiCases) {
    assert.throws(
      () => createProviderClient({ providerId, baseUrl: "https://provider.test/v1", apiKey: "fixture-key" }),
      expected,
    );
  }
});
test("Codex identity cannot select generic Completions or Responses transports", () => {
  const expected = /Codex Responses requires ChatGPT account sign-in; the private backend route and Workbench OAuth lifecycle\/app-server bridge are unavailable/;
  for (const transport of ["openai-completions", "openai-responses"] as const) {
    assert.throws(
      () => createProviderClient({
        providerId: "openai-codex",
        transport,
        baseUrl: "https://chatgpt.com/backend-api",
        auth: { kind: "api-key", apiKey: "fixture-api-key-is-not-oauth" },
      }),
      expected,
    );
  }
});

test("generic Completions and Responses cannot target the Codex backend host", () => {
  const expected = /Codex Responses requires ChatGPT account sign-in; the private backend route and Workbench OAuth lifecycle\/app-server bridge are unavailable/;
  for (const baseUrl of [
    "https://chatgpt.com/backend-api",
    "https://chatgpt.com/backend-api/codex",
    "https://chatgpt.com/codex",
  ]) {
    assert.throws(
      () => createProviderClient({
        providerId: "openai",
        transport: "openai-responses",
        baseUrl,
        auth: { kind: "api-key", apiKey: "fixture-api-key-is-not-oauth" },
      }),
      expected,
    );
    assert.throws(
      () => createProviderClient({
        baseUrl,
        apiKey: "fixture-api-key-is-not-oauth",
        api: "openai-completions",
      }),
      expected,
    );
  }
});

test("typed provider identity and discriminated API-key profile select the declared transport", async () => {
  const client = createProviderClient(
    {
      providerId: "minimax-cn",
      transport: "anthropic-messages",
      baseUrl: "https://api.minimaxi.com/anthropic",
      auth: { kind: "api-key", apiKey: "fixture-secret" },
    },
    async (input, init) => {
      assert.equal(String(input), "https://api.minimaxi.com/anthropic/models");
      assert.equal((init?.headers as Record<string, string>)?.["x-api-key"], "fixture-secret");
      return Response.json({ data: [{ id: "MiniMax-M3", type: "model" }] });
    },
  );
  assert.deepEqual(await client.models(), [{ id: "MiniMax-M3", name: "MiniMax-M3" }]);
  assert.equal(client.redact("provider error: fixture-secret"), "provider error: [redacted]");
});
test("Prime Inference uses the official OpenAI-compatible route and Prime catalog entitlement", async () => {
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  const client = createProviderClient(
    {
      providerId: "prime-inference",
      transport: "openai-completions",
      baseUrl: "https://api.pinference.ai/api/v1",
      auth: { kind: "api-key", apiKey: "fixture-prime-key" },
      model: "stale-model",
    },
    async (input, init) => {
      const url = String(input);
      requests.push({ url, init });
      if (url.endsWith("/models"))
        return Response.json({
          object: "list",
          data: [{ id: "z-ai/glm-5.3", object: "model" }],
        });
      return new Response(
        [
          'data: {"choices":[{"delta":{"content":"fixture answer"}}]}',
          'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}',
          'data: {"choices":[],"usage":{"prompt_tokens":1,"completion_tokens":2,"total_tokens":3}}',
          "data: [DONE]",
          "",
          "",
        ].join("\n\n"),
        { headers: { "content-type": "text/event-stream" } },
      );
    },
  );
  await assert.rejects(
    client.complete("z-ai/glm-5.3", [], [], new AbortController().signal),
    /not present in the Prime Inference model catalog/,
  );
  assert.equal(requests.length, 0);

  assert.deepEqual(await client.models(), [{ id: "z-ai/glm-5.3", name: "z-ai/glm-5.3" }]);
  const deltas: string[] = [];
  const reply = await client.complete(
    "z-ai/glm-5.3",
    [],
    [],
    new AbortController().signal,
    text => {
      if (text) deltas.push(text);
    },
  );
  assert.equal(reply.message.content, "fixture answer");
  assert.deepEqual(deltas, ["fixture answer"]);
  assert.deepEqual(reply.usage, {
    prompt_tokens: 1,
    completion_tokens: 2,
    total_tokens: 3,
  });
  const modelsRequest = requests[0]!;
  assert.equal(modelsRequest.url, "https://api.pinference.ai/api/v1/models");
  assert.equal(modelsRequest.init?.method, "GET");
  assert.equal(
    (modelsRequest.init?.headers as Record<string, string>).authorization,
    "Bearer fixture-prime-key",
  );
  const completionRequest = requests[1]!;
  assert.equal(
    completionRequest.url,
    "https://api.pinference.ai/api/v1/chat/completions",
  );
  assert.equal(
    (completionRequest.init?.headers as Record<string, string>).authorization,
    "Bearer fixture-prime-key",
  );
  const completionBody = JSON.parse(String(completionRequest.init?.body));
  assert.deepEqual(completionBody.usage, { include: true });
  assert.equal("stream_options" in completionBody, false);

  const requestCount = requests.length;
  await assert.rejects(
    client.complete("stale-model", [], [], new AbortController().signal),
    /not present in the Prime Inference model catalog/,
  );
  assert.equal(requests.length, requestCount);
});
test("OpenAI-compatible streaming requests and returns final usage", async () => {
  const client = createProviderClient(
    {
      providerId: "aiand",
      transport: "openai-completions",
      baseUrl: "https://api.aiand.com/v1",
      auth: { kind: "api-key", apiKey: "fixture-secret" },
    },
    async (_input, init) => {
      const body = JSON.parse(String(init?.body));
      assert.deepEqual(body.stream_options, { include_usage: true });
      return new Response(
        [
          'data: {"choices":[{"delta":{"content":"fixture answer"}}]}',
          'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}',
          'data: {"choices":[],"usage":{"prompt_tokens":3,"completion_tokens":2,"total_tokens":5}}',
          "data: [DONE]",
          "",
          "",
        ].join("\n\n"),
        { headers: { "content-type": "text/event-stream" } },
      );
    },
  );
  const reply = await client.complete(
    "deepseek-ai/deepseek-v4-flash",
    [],
    [],
    new AbortController().signal,
    () => {},
  );
  assert.equal(reply.message.content, "fixture answer");
  assert.deepEqual(reply.usage, {
    prompt_tokens: 3,
    completion_tokens: 2,
    total_tokens: 5,
  });
});
test("OpenAI-compatible content-filtered completions are not reported as truncated", async () => {
  const client = createProviderClient(
    {
      providerId: "aiand",
      transport: "openai-completions",
      baseUrl: "https://api.aiand.com/v1",
      auth: { kind: "api-key", apiKey: "fixture-secret" },
    },
    async () => Response.json({
      choices: [{
        finish_reason: "content_filter",
        message: {
          role: "assistant",
          content: "filtered partial content",
          tool_calls: [{
            id: "call-filtered",
            type: "function",
            function: { name: "write", arguments: "{\"path\":\"partial\"}" },
          }],
        },
      }],
    }),
  );
  await assert.rejects(
    client.complete(
      "deepseek-ai/deepseek-v4-flash",
      [],
      [],
      new AbortController().signal,
    ),
    /content filter/i,
  );
});
test("OpenAI-compatible completions preserve every ordered tool call", async () => {
  const toolCalls = [
    {
      id: "call-first",
      type: "function",
      function: { name: "read_file", arguments: "{\"path\":\"a.ts\"}" },
    },
    {
      id: "call-second",
      type: "function",
      function: { name: "search", arguments: "{\"query\":\"TODO\"}" },
    },
  ];
  const client = createProviderClient(
    {
      providerId: "aiand",
      transport: "openai-completions",
      baseUrl: "https://api.aiand.com/v1",
      auth: { kind: "api-key", apiKey: "fixture-secret" },
    },
    async () => Response.json({
      choices: [{
        finish_reason: "tool_calls",
        message: {
          role: "assistant",
          content: "I will inspect both files.",
          tool_calls: toolCalls,
        },
      }],
    }),
  );
  const reply = await client.complete(
    "deepseek-ai/deepseek-v4-flash",
    [],
    [ { type: "function", function: { name: "read_file", parameters: {} } } ],
    new AbortController().signal,
  );
  assert.deepEqual(reply.message, {
    role: "assistant",
    content: "I will inspect both files.",
    tool_calls: toolCalls,
  });
});
test("OpenAI-compatible legacy function_call becomes one canonical tool call", async () => {
  const client = createProviderClient(
    {
      providerId: "aiand",
      transport: "openai-completions",
      baseUrl: "https://api.aiand.com/v1",
      auth: { kind: "api-key", apiKey: "fixture-secret" },
    },
    async () => Response.json({
      choices: [{
        finish_reason: "function_call",
        message: {
          role: "assistant",
          content: null,
          function_call: { name: "read_file", arguments: "{\"path\":\"a.ts\"}" },
        },
      }],
    }),
  );

  const reply = await client.complete(
    "deepseek-ai/deepseek-v4-flash",
    [],
    [],
    new AbortController().signal,
  );
  assert.equal(reply.message.role, "assistant");
  assert.equal(reply.message.content, null);
  assert.equal(reply.message.tool_calls?.length, 1);
  const call = reply.message.tool_calls?.[0];
  assert.ok(call?.id.startsWith("call_"));
  assert.deepEqual(call?.function, {
    name: "read_file",
    arguments: "{\"path\":\"a.ts\"}",
  });
});
test("OpenAI-compatible streamed content filtering is not reported as truncation", async () => {
  const client = createProviderClient(
    {
      providerId: "aiand",
      transport: "openai-completions",
      baseUrl: "https://api.aiand.com/v1",
      auth: { kind: "api-key", apiKey: "fixture-secret" },
    },
    async () => new Response(
      [
        'data: {"choices":[{"delta":{"content":"filtered partial content"},"finish_reason":"content_filter"}]}',
        "data: [DONE]",
        "",
        "",
      ].join("\n\n"),
      { headers: { "content-type": "text/event-stream" } },
    ),
  );
  await assert.rejects(
    client.complete(
      "deepseek-ai/deepseek-v4-flash",
      [],
      [],
      new AbortController().signal,
      () => {},
    ),
    /content filter/i,
  );
});

test("Prime Inference refuses empty catalogs and non-Prime endpoint overrides", async () => {
  const emptyCatalog = createProviderClient(
    {
      providerId: "prime-inference",
      baseUrl: "https://api.pinference.ai/api/v1",
      apiKey: "fixture-prime-key",
      model: "operator-model",
    },
    async () => Response.json({ object: "list", data: [] }),
  );
  await assert.rejects(emptyCatalog.models(), /Prime Inference returned no available models/);
  const missingCatalog = createProviderClient(
    {
      providerId: "prime-inference",
      baseUrl: "https://api.pinference.ai/api/v1",
      apiKey: "fixture-prime-key",
      model: "operator-model",
    },
    async () => Response.json({ error: "unavailable" }, { status: 404 }),
  );
  await assert.rejects(
    catalogFor(missingCatalog, {
      providerId: "prime-inference",
      baseUrl: "https://api.pinference.ai/api/v1",
      apiKey: "fixture-prime-key",
      model: "operator-model",
    }),
    /Prime Inference model catalog is unavailable/,
  );

  assert.throws(
    () =>
      createProviderClient({
        providerId: "prime-inference",
        baseUrl: "https://attacker.example/api/v1",
        apiKey: "fixture-prime-key",
      }),
    /Prime Inference requires the official HTTPS endpoint/,
  );
});

test("Prime Inference rejects missing credentials and a different transport", () => {
  assert.throws(
    () =>
      createProviderClient({
        providerId: "prime-inference",
        transport: "openai-completions",
        baseUrl: "https://api.pinference.ai/api/v1",
        auth: { kind: "api-key", apiKey: " " },
      }),
    /Prime Inference requires an explicitly configured API key/,
  );
  assert.throws(
    () =>
      createProviderClient({
        providerId: "prime-inference",
        transport: "anthropic-messages",
        baseUrl: "https://api.pinference.ai/api/v1",
        auth: { kind: "api-key", apiKey: "fixture-prime-key" },
      }),
    /Prime Inference requires the OpenAI Chat Completions transport/,
  );
});

test("Prime Inference catalog enforces the pinned 2 MiB response limit", async () => {
  const model = { id: "bounded-model" };
  const prefix = JSON.stringify({ object: "list", data: [model] });
  const makeBody = (byteLength: number) => {
    const padding = byteLength - Buffer.byteLength(prefix) - 1;
    assert.ok(padding >= 0);
    return `${prefix}${" ".repeat(padding)}\n`;
  };
  const makeClient = (byteLength: number) =>
    createProviderClient(
      {
        providerId: "prime-inference",
        baseUrl: "https://api.pinference.ai/api/v1",
        apiKey: "fixture-prime-key",
      },
      async () =>
        new Response(makeBody(byteLength), {
          headers: { "content-type": "application/json" },
        }),
    );

  assert.deepEqual(await makeClient(2 * 1024 * 1024).models(), [
    { id: "bounded-model", name: "bounded-model" },
  ]);
  await assert.rejects(
    makeClient(2 * 1024 * 1024 + 1).models(),
    /Prime Inference model catalog response is too large/,
  );
});

test("Prime Inference rejects malformed live catalog rows instead of silently filtering them", async () => {
  let requests = 0;
  const client = createProviderClient(
    {
      providerId: "prime-inference",
      baseUrl: "https://api.pinference.ai/api/v1",
      apiKey: "fixture-prime-key",
    },
    async () => {
      requests++;
      return Response.json({
        object: "list",
        data: [{ id: "available-model" }, null],
      });
    },
  );
  await assert.rejects(client.models(), /Prime Inference returned an invalid model catalog/);
  await assert.rejects(
    client.complete("available-model", [], [], new AbortController().signal),
    /not present in the Prime Inference model catalog/,
  );
  assert.equal(requests, 1);
});

test("Prime-only request semantics do not apply to custom compatible endpoints", async () => {
  let body: Record<string, unknown> | undefined;
  const client = createProviderClient(
    {
      baseUrl: "https://api.pinference.ai/api/v1",
      apiKey: "fixture-custom-key",
    },
    async (_input, init) => {
      body = JSON.parse(String(init?.body));
      return Response.json({ choices: [{ message: { role: "assistant", content: "custom fixture" }, finish_reason: "stop" }] });
    },
  );
  await client.complete("fixture-model", [], [], new AbortController().signal);
  assert.equal(body?.usage, undefined);
});

test("Cloudflare Workers AI uses its pinned Prime model and account-scoped completions route", async () => {
  const model = "@cf/deepseek-ai/deepseek-v4-flash-0731";
  const baseUrl = `https://api.cloudflare.com/client/v4/accounts/${"a".repeat(32)}/ai/v1`;
  const config = {
    providerId: "cloudflare-workers-ai",
    transport: "openai-completions",
    baseUrl,
    model,
    auth: { kind: "api-key", apiKey: "fixture-cloudflare-key" },
  } satisfies ProviderAdapterConfig;
  assert.doesNotThrow(() => assertProviderDescriptorInManifest(config));
  for (const invalidBaseUrl of [
    `http://api.cloudflare.com/client/v4/accounts/${"a".repeat(32)}/ai/v1`,
    `https://attacker.example/client/v4/accounts/${"a".repeat(32)}/ai/v1`,
    `${baseUrl}?next=https://attacker.example`,
    `${baseUrl}/extra`,
    `https://api.cloudflare.com/client/v4/accounts/${"a".repeat(31)}%2Fother/ai/v1`,
  ]) {
    assert.throws(
      () => assertProviderDescriptorInManifest({ ...config, baseUrl: invalidBaseUrl }),
      /endpoint/i,
    );
  }
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  const client = createProviderClient(config, async (input, init) => {
    requests.push({ url: String(input), init });
    return Response.json({
      choices: [{
        message: { role: "assistant", content: "fixture answer" },
        finish_reason: "stop",
      }],
    });
  });
  assert.deepEqual((await client.models()).map(({ id }) => id), [model]);
  assert.equal(requests.length, 0);
  const reply = await client.complete(model, [], [], new AbortController().signal);
  assert.equal(reply.message.content, "fixture answer");
  assert.deepEqual(requests.map(({ url }) => url), [`${baseUrl}/chat/completions`]);
  const request = requests[0]!;
  assert.equal(request.init?.method, "POST");
  assert.equal(
    new Headers(request.init?.headers).get("authorization"),
    "Bearer fixture-cloudflare-key",
  );
  assert.equal(
    JSON.parse(String(request.init?.body)).model,
    model,
  );
  assert.equal(client.redact("failed: fixture-cloudflare-key"), "failed: [redacted]");
});

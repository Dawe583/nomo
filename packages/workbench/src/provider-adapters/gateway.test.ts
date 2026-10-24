import test from "node:test";
import assert from "node:assert/strict";
import { createProviderClient } from "./factory.ts";
import type { ProviderAdapterConfig } from "./types.ts";

function fixtureFetch(calls: Array<{ url: string; init?: RequestInit }>): typeof fetch {
  return async (input, init) => {
    const url = String(input);
    calls.push({ url, init });
    if (url.endsWith("/models")) {
      return Response.json({ data: [
        { id: "ai21/jamba-large-1.7" },
        { id: "~anthropic/claude-fable-latest" },
        { id: "alibaba/qwen-3-14b" },
        { id: "fixture-embedding" },
      ] });
    }
    if (url.endsWith("/messages")) {
      return Response.json({ content: [{ type: "text", text: "ok" }], usage: { input_tokens: 1, output_tokens: 1 } });
    }
    if (url.endsWith("/responses")) {
      return Response.json({ status: "completed", output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "ok" }] }] });
    }
    return Response.json({ choices: [{ message: { role: "assistant", content: "ok" } }] });
  };
}

test("OpenRouter uses host-bound Chat Completions, attribution, and routing metadata", async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const config: ProviderAdapterConfig = {
    providerId: "openrouter",
    transport: "openrouter",
    baseUrl: "https://openrouter.ai/api/v1",
    auth: { kind: "api-key", apiKey: "fixture-openrouter-key" },
    model: "ai21/jamba-large-1.7",
    gatewayOptions: {
      openrouter: {
        referer: "https://app.example",
        title: "Fixture",
        categories: ["cli-agent"],
        provider: {
          order: ["anthropic"],
          allow_fallbacks: false,
          require_parameters: true,
          sort: { by: "throughput", partition: "none" },
          max_price: { prompt: "0.2" },
          preferred_min_throughput: { p50: 40 },
        },
      },
    },
  };
  const client = createProviderClient(config, fixtureFetch(calls));
  const models = await client.models();
  assert.ok(models.some(model => model.id === "ai21/jamba-large-1.7"));
  assert.equal(models.filter(model => model.id === "~anthropic/claude-fable-latest").length, 1);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://openrouter.ai/api/v1/models");
  const reply = await client.complete(config.model!, [], [], new AbortController().signal);
  assert.equal(reply.message.content, "ok");
  assert.equal(calls.length, 2);
  assert.equal(calls[1].url, "https://openrouter.ai/api/v1/chat/completions");
  const headers = new Headers(calls[1].init?.headers);
  assert.equal(headers.get("authorization"), "Bearer fixture-openrouter-key");
  assert.equal(headers.get("http-referer"), "https://app.example");
  assert.equal(headers.get("x-openrouter-title"), "Fixture");
  assert.equal(headers.get("x-openrouter-categories"), "cli-agent");
  assert.equal(headers.has("cf-aig-authorization"), false);
  const body = JSON.parse(String(calls[1].init?.body));
  assert.equal(body.model, "ai21/jamba-large-1.7");
  assert.equal(body.stream, false);
  assert.deepEqual(body.provider, {
    order: ["anthropic"],
    allow_fallbacks: false,
    require_parameters: true,
    sort: { by: "throughput", partition: "none" },
    max_price: { prompt: "0.2" },
    preferred_min_throughput: { p50: 40 },
  });
  assert.deepEqual(models.find(model => model.id === "ai21/jamba-large-1.7")?.capabilities, ["text", "tools"]);
  assert.equal(models.some(model => model.id.includes("embedding")), false);
});

test("Prime OpenRouter config stays on Chat Completions and exposes its pinned model row", async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const client = createProviderClient({
    providerId: "openrouter",
    api: "openai-completions",
    baseUrl: "https://openrouter.ai/api/v1",
    apiKey: "fixture-openrouter-key",
    model: "~anthropic/claude-fable-latest",
  }, fixtureFetch(calls));
  const models = await client.models();
  assert.ok(models.some(model => model.id === "~anthropic/claude-fable-latest"));
  assert.equal(calls[0].url, "https://openrouter.ai/api/v1/models");
  await client.complete("~anthropic/claude-fable-latest", [], [], new AbortController().signal);
  assert.equal(calls[1].url, "https://openrouter.ai/api/v1/chat/completions");
  assert.equal(new Headers(calls[1].init?.headers).get("authorization"), "Bearer fixture-openrouter-key");
  assert.equal(JSON.parse(String(calls[1].init?.body)).model, "~anthropic/claude-fable-latest");
});

test("Cloudflare Anthropic gateway sends only its gateway credential to its Anthropic route", async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const config: ProviderAdapterConfig = {
    providerId: "cloudflare-ai-gateway",
    transport: "anthropic-messages",
    baseUrl: "https://gateway.ai.cloudflare.com/v1/account/gateway/anthropic",
    auth: { kind: "api-key", apiKey: "fixture-cf-token" },
    model: "alibaba/qwen3-max",
  };
  const client = createProviderClient(config, fixtureFetch(calls));
  const models = await client.models();
  assert.ok(models.some(model => model.id === config.model));
  assert.equal(calls.length, 0);
  await client.complete(config.model!, [], [], new AbortController().signal);
  assert.equal(calls[0].url, "https://gateway.ai.cloudflare.com/v1/account/gateway/anthropic/v1/messages");
  const headers = new Headers(calls[0].init?.headers);
  assert.equal(headers.get("cf-aig-authorization"), "Bearer fixture-cf-token");
  assert.equal(headers.get("accept"), "application/json");
  assert.equal(headers.get("anthropic-dangerous-direct-browser-access"), "true");
  assert.equal(headers.has("authorization"), false);
  assert.equal(headers.has("x-api-key"), false);
});

test("Cloudflare OpenAI-compatible routes preserve model names and provider-specific auth", async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const completions = createProviderClient({
    providerId: "cloudflare-ai-gateway",
    transport: "openai-completions",
    baseUrl: "https://gateway.ai.cloudflare.com/v1/account/gateway/compat",
    auth: { kind: "api-key", apiKey: "fixture-cf-token" },
    model: "anthropic/claude-sonnet-4-0",
  }, fixtureFetch(calls));
  await completions.complete("anthropic/claude-sonnet-4-0", [], [], new AbortController().signal);
  assert.equal(calls[0].url, "https://gateway.ai.cloudflare.com/v1/account/gateway/compat/chat/completions");
  assert.equal(JSON.parse(String(calls[0].init?.body)).model, "anthropic/claude-sonnet-4-0");
  assert.equal(new Headers(calls[0].init?.headers).get("cf-aig-authorization"), "Bearer fixture-cf-token");
  assert.equal(new Headers(calls[0].init?.headers).has("authorization"), false);
  assert.equal(new Headers(calls[0].init?.headers).has("x-api-key"), false);

  const responses = createProviderClient({
    providerId: "cloudflare-ai-gateway",
    transport: "openai-responses",
    baseUrl: "https://gateway.ai.cloudflare.com/v1/account/gateway/openai",
    auth: { kind: "api-key", apiKey: "fixture-cf-token" },
    model: "openai/gpt-4.1",
  }, fixtureFetch(calls));
  assert.equal((await responses.complete("openai/gpt-4.1", [], [], new AbortController().signal)).message.content, "ok");
  assert.equal(calls[1].url, "https://gateway.ai.cloudflare.com/v1/account/gateway/openai/responses");
  assert.equal(new Headers(calls[1].init?.headers).get("cf-aig-authorization"), "Bearer fixture-cf-token");
  assert.equal(new Headers(calls[1].init?.headers).has("authorization"), false);
  assert.equal(new Headers(calls[1].init?.headers).has("x-api-key"), false);
});

test("Vercel Anthropic gateway keeps attribution on its host and retains model capabilities", async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const config: ProviderAdapterConfig = {
    providerId: "vercel-ai-gateway",
    transport: "anthropic-messages",
    baseUrl: "https://ai-gateway.vercel.sh",
    auth: { kind: "api-key", apiKey: "fixture-vercel-key" },
    model: "alibaba/qwen-3-14b",
    gatewayOptions: { vercel: { referer: "https://app.example", title: "Fixture" } },
  };
  const client = createProviderClient(config, fixtureFetch(calls));
  const models = await client.models();
  const model = models.find(item => item.id === config.model);
  assert.equal(models.filter(item => item.id === "alibaba/qwen-3-14b").length, 1);
  assert.deepEqual(model?.capabilities, ["text", "reasoning"]);
  assert.equal(model?.contextWindow, 40960);
  assert.equal(model?.maxTokens, 16384);
  assert.equal(calls[0].url, "https://ai-gateway.vercel.sh/v1/models");
  await client.complete(config.model!, [], [], new AbortController().signal);
  assert.equal(calls[1].url, "https://ai-gateway.vercel.sh/v1/messages");
  const headers = new Headers(calls[1].init?.headers);
  assert.equal(headers.get("http-referer"), "https://app.example");
  assert.equal(headers.get("x-title"), "Fixture");
  assert.equal(headers.get("x-api-key"), "fixture-vercel-key");
  assert.equal(headers.has("x-openrouter-title"), false);
  assert.equal(headers.has("cf-aig-authorization"), false);
});

test("gateway identity cannot send credentials to a caller-selected host", () => {
  assert.throws(() => createProviderClient({
    providerId: "openrouter",
    transport: "openrouter",
    baseUrl: "https://attacker.example/api/v1",
    auth: { kind: "api-key", apiKey: "fixture-secret" },
  }), /official HTTPS endpoint and a supported Chat Completions transport/);
  assert.throws(() => createProviderClient({
    providerId: "cloudflare-ai-gateway",
    transport: "openai-completions",
    baseUrl: "https://gateway.ai.cloudflare.com/v1/account/gateway/openai",
    auth: { kind: "api-key", apiKey: "fixture-secret" },
  }), /route conflicts/);
});

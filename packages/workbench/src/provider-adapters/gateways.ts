import {
  CompatibleProvider,
  normalizeProviderConfig,
  type Model,
} from "../provider.ts";
import { PROVIDER_MODEL_MANIFEST } from "../provider-catalog.ts";
import type { HarnessSettings } from "../harness-settings.ts";
import type { ProviderAdapterConfig, ProviderClient } from "./types.ts";
import { OpenAIResponsesAdapter } from "./openai-responses.ts";

const GATEWAYS: Readonly<Record<string, true>> = {
  openrouter: true,
  "cloudflare-ai-gateway": true,
  "vercel-ai-gateway": true,
};

export function isGatewayProvider(providerId: string): boolean {
  return Object.hasOwn(GATEWAYS, providerId);
}

export function createGatewayProvider(
  config: ProviderAdapterConfig,
  request: typeof fetch,
  settings: Partial<HarnessSettings> | (() => HarnessSettings),
): ProviderClient {
  if (config.auth.kind !== "api-key") throw new Error("Gateway providers require an API-key profile.");
  const baseUrl = validateGatewayEndpoint(config);
  const gatewayRequest = createGatewayFetch(config, request);
  const delegate = config.transport === "openai-responses"
    ? new OpenAIResponsesAdapter({ ...config, baseUrl }, gatewayRequest, settings)
    : new CompatibleProvider(
        normalizeProviderConfig({
          baseUrl,
          apiKey: config.auth.apiKey,
          providerId: config.providerId,
          api: config.transport === "openrouter" ? "openai-completions" : config.transport,
          kind: config.transport === "anthropic-messages" ? "anthropic" : "compatible",
          model: config.model,
        }),
        gatewayRequest,
        settings,
      );
  return {
    models: async () => {
      if (config.providerId !== "cloudflare-ai-gateway") await delegate.models();
      return pinnedModels(config);
    },
    complete: (...args) => delegate.complete(...args),
    redact: text => delegate.redact(text),
  };
}

function validateGatewayEndpoint(config: ProviderAdapterConfig): string {
  let url: URL;
  try {
    url = new URL(config.baseUrl);
  } catch {
    throw new Error("Gateway endpoint must be an absolute HTTPS URL.");
  }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
    throw new Error("Gateway endpoint must use HTTPS without credentials or query parameters.");
  }
  const path = url.pathname.replace(/\/$/, "");
  if (config.providerId === "openrouter") {
    if (!["openrouter", "openai-completions"].includes(config.transport) || url.hostname !== "openrouter.ai" || path !== "/api/v1") {
      throw new Error("OpenRouter requires its official HTTPS endpoint and a supported Chat Completions transport.");
    }
    return "https://openrouter.ai/api/v1";
  }
  if (config.providerId === "cloudflare-ai-gateway") {
    if (url.hostname !== "gateway.ai.cloudflare.com") throw new Error("Cloudflare AI Gateway requires its official HTTPS endpoint.");
    const match = /^\/v1\/([^/]+)\/([^/]+)\/(anthropic|compat|openai)(?:\/v1)?$/.exec(path);
    if (!match || /[<>]/.test(decodeURIComponent(`${match[1]}${match[2]}`))) {
      throw new Error("Cloudflare AI Gateway endpoint must include resolved account, gateway, and route IDs.");
    }
    const route = match[3];
    const expected = config.transport === "anthropic-messages" ? "anthropic"
      : config.transport === "openai-completions" ? "compat"
      : config.transport === "openai-responses" ? "openai" : "";
    if (!expected || route !== expected || (route !== "anthropic" && path.endsWith("/v1"))) {
      throw new Error("Cloudflare route conflicts with the declared provider transport.");
    }
    return `https://gateway.ai.cloudflare.com${path}${route === "anthropic" && !path.endsWith("/v1") ? "/v1" : ""}`;
  }
  if (config.providerId === "vercel-ai-gateway") {
    if (config.transport !== "anthropic-messages" || url.hostname !== "ai-gateway.vercel.sh" || !["", "/v1"].includes(path)) {
      throw new Error("Vercel AI Gateway supports its official Anthropic Messages endpoint in this manifest.");
    }
    return "https://ai-gateway.vercel.sh/v1";
  }
  throw new Error("Unsupported gateway provider.");
}

function createGatewayFetch(config: ProviderAdapterConfig, request: typeof fetch): typeof fetch {
  const options = config.gatewayOptions;
  const endpoint = new URL(validateGatewayEndpoint(config));
  const gatewayPath = endpoint.pathname;
  const expectedPath = config.providerId === "openrouter"
    ? `${gatewayPath}/chat/completions`
    : config.providerId === "vercel-ai-gateway"
      ? `${gatewayPath}/messages`
      : config.transport === "anthropic-messages"
        ? `${gatewayPath}/messages`
        : config.transport === "openai-responses"
          ? `${gatewayPath}/responses`
          : `${gatewayPath}/chat/completions`;
  return async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const modelListing = config.providerId !== "cloudflare-ai-gateway" &&
      init?.method === "GET" &&
      url.origin === endpoint.origin &&
      url.pathname === `${gatewayPath}/models`;
    if (!modelListing && (url.origin !== endpoint.origin || url.pathname !== expectedPath || init?.method !== "POST")) {
      throw new Error("Gateway request escaped its declared provider route.");
    }
    const headers = new Headers(init?.headers);
    let body = init?.body;
    if (config.providerId === "cloudflare-ai-gateway") {
      headers.delete("authorization");
      headers.delete("x-api-key");
      headers.set("cf-aig-authorization", `Bearer ${config.auth.kind === "api-key" ? config.auth.apiKey : ""}`);
      if (config.transport === "anthropic-messages") {
        headers.set("accept", "application/json");
        headers.set("anthropic-dangerous-direct-browser-access", "true");
      }
    }
    if (config.providerId === "openrouter") {
      const gateway = options?.openrouter;
      if (gateway?.referer) headers.set("http-referer", gateway.referer);
      if (gateway?.title) headers.set("x-openrouter-title", gateway.title);
      if (gateway?.categories?.length) headers.set("x-openrouter-categories", gateway.categories.join(","));
      if (gateway?.provider && typeof body === "string") {
        const parsed = JSON.parse(body) as Record<string, unknown>;
        parsed.provider = { ...(typeof parsed.provider === "object" && parsed.provider !== null ? parsed.provider : {}), ...gateway.provider };
        body = JSON.stringify(parsed);
      }
    }
    if (config.providerId === "vercel-ai-gateway") {
      if (options?.vercel?.referer) headers.set("http-referer", options.vercel.referer);
      if (options?.vercel?.title) headers.set("x-title", options.vercel.title);
    }
    return request(input, { ...init, headers, ...(body === undefined ? {} : { body }) });
  };
}

function pinnedModels(config: ProviderAdapterConfig): readonly Model[] {
  const rows = PROVIDER_MODEL_MANIFEST.providers
    .filter(provider => provider.status === "in-scope" && provider.providerId === config.providerId)
    .flatMap(provider => provider.models.filter(model => model.kind === "chat" && (
      model.transport === config.transport ||
      (config.providerId === "openrouter" && provider.source === "prime" && model.transport === "openai-completions")
    )));
  const models: Model[] = [];
  const seen = new Set<string>();
  for (const model of rows) {
    if (seen.has(model.id)) continue;
    seen.add(model.id);
    models.push({
      id: model.id,
      name: model.name,
      ...(model.capabilities.contextWindow === null ? {} : { contextWindow: model.capabilities.contextWindow }),
      ...(model.capabilities.maxTokens === null ? {} : { maxTokens: model.capabilities.maxTokens }),
      capabilities: [
        ...model.capabilities.input,
        ...(model.capabilities.reasoning ? ["reasoning"] : []),
        ...(model.capabilities.tools === true ? ["tools"] : []),
      ],
    });
  }
  if (config.model && !models.some(model => model.id === config.model)) {
    return [...models, { id: config.model, name: config.model }];
  }
  return models;
}

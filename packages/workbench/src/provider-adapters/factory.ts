import {
  CompatibleProvider,
  normalizeProviderConfig,
  type ProviderConfig,
} from "../provider.ts";
import type {
  ProviderAdapterConfig,
  ProviderAdapterDependencies,
  ProviderClient,
  ProviderTransport,
} from "./types.ts";
import { OpenAIResponsesAdapter } from "./openai-responses.ts";
import { AzureOpenAIResponsesAdapter } from "./openai-responses.ts";
import { GoogleGenerativeAIAdapter } from "./google-generative-ai.ts";
import { BedrockConverseStreamAdapter } from "./bedrock-converse-stream.ts";
import { BedrockMantleResponsesAdapter } from "./bedrock-mantle-responses.ts";
import { MistralConversationsAdapter } from "./mistral-conversations.ts";
import { OllamaChatAdapter } from "./ollama-chat.ts";
import { createGatewayProvider, isGatewayProvider } from "./gateways.ts";
import { PrimeInferenceProvider } from "./prime-inference.ts";
import {
  BLOCKED_PROVIDER_APIS_BY_PROVIDER,
  PROVIDER_API_BLOCKERS,
  type BlockedProviderApi,
} from "./types.ts";
import type { HarnessSettings } from "../harness-settings.ts";

function blockedProviderApi(config: ProviderConfig | ProviderAdapterConfig): BlockedProviderApi | undefined {
  const transport = "auth" in config ? config.transport : config.api;
  if (typeof transport === "string" && Object.hasOwn(PROVIDER_API_BLOCKERS, transport)) {
    return transport as BlockedProviderApi;
  }
  if (config.providerId && BLOCKED_PROVIDER_APIS_BY_PROVIDER[config.providerId]) {
    return BLOCKED_PROVIDER_APIS_BY_PROVIDER[config.providerId];
  }
  try {
    const endpoint = new URL(config.baseUrl);
    const hostname = endpoint.hostname.toLowerCase().replace(/\.$/, "");
    const path = endpoint.pathname.toLowerCase();
    if (
      hostname === "chatgpt.com" &&
      (/^\/backend-api(?:\/|$)/.test(path) || /^\/codex(?:\/|$)/.test(path))
    ) return "openai-codex-responses";
  } catch {
    // Let the provider constructor report malformed URLs.
  }
  return undefined;
}




export function createProviderClient(
  config: ProviderConfig | ProviderAdapterConfig,
  request: typeof fetch = fetch,
  settings: Partial<HarnessSettings> | (() => HarnessSettings) = {},
  dependencies: ProviderAdapterDependencies = {},
): ProviderClient {
  const blockedApi = blockedProviderApi(config);
  if (blockedApi) {
    throw new Error(`Provider API ${blockedApi} is unavailable: ${PROVIDER_API_BLOCKERS[blockedApi].reason}`);
  }
  const requestedTransport = "auth" in config ? config.transport : config.api;
  if (config.providerId === "google-vertex" && requestedTransport !== "google-vertex")
    throw new Error("Google Vertex requires its explicit transport.");

  const adapterConfig = "auth" in config;
  if (!adapterConfig && config.providerId && isGatewayProvider(config.providerId)) {
    if (!config.api) throw new Error("Gateway provider requires an explicit transport.");
    return createGatewayProvider({
      providerId: config.providerId,
      transport: config.api as ProviderTransport,
      baseUrl: config.baseUrl,
      auth: { kind: "api-key", apiKey: config.apiKey },
      model: config.model,
    }, request, settings);
  }
  if (adapterConfig && isGatewayProvider(config.providerId)) {
    return createGatewayProvider(config, request, settings);
  }
  if (adapterConfig && config.auth.kind === "openai-chatgpt-account") {
    if (config.transport !== "openai-responses" || config.providerId !== "openai")
      throw new Error("ChatGPT account auth is supported only by OpenAI Responses.");
    return new OpenAIResponsesAdapter(config, request, settings, dependencies);
  }
  if (adapterConfig && config.transport === "bedrock-converse-stream") {
    return new BedrockConverseStreamAdapter(
      config,
      request,
      undefined,
      settings,
      dependencies.awsCredentialProvider,
    );
  }
  if (adapterConfig && config.providerId === "bedrock-mantle" && config.transport === "openai-responses" && config.auth.kind === "aws-credential-chain") {
    return new BedrockMantleResponsesAdapter(config, request, settings, dependencies.awsCredentialProvider);
  }
  if (adapterConfig && config.transport === "mistral-conversations") {
    if (config.auth.kind !== "api-key") throw new Error("Mistral Conversations requires an API-key authentication profile.");
    return new MistralConversationsAdapter(config, request, settings);
  }
  if (adapterConfig && config.transport === "ollama-chat") {
    return new OllamaChatAdapter(config, request, settings);
  }
  if ("auth" in config && config.auth.kind !== "api-key") {
    throw new Error("This provider transport requires a different authentication profile.");
  }
  const normalized = adapterConfig
    ? normalizeProviderConfig({
        baseUrl: config.baseUrl,
        apiKey: config.auth.kind === "api-key" ? config.auth.apiKey : "",
        providerId: config.providerId,
        api: config.transport,
        kind: config.transport === "anthropic-messages" ? "anthropic" : "compatible",
        model: config.model,
      })
    : normalizeProviderConfig(config);
  const transport: string = adapterConfig
    ? config.transport
    : normalized.api ??
      (normalized.kind === "anthropic" ? "anthropic-messages" : "openai-completions");
  if (normalized.providerId !== undefined && !normalized.providerId.trim()) {
    throw new Error("Provider ID cannot be empty.");
  }
  if (normalized.providerId === "prime-inference") {
    if (transport !== "openai-completions")
      throw new Error("Prime Inference requires the OpenAI Chat Completions transport.");
    return new PrimeInferenceProvider(normalized, request, settings);
  }
  switch (transport as ProviderTransport) {
    case "openai-completions":
      if (normalized.kind === "anthropic") {
        throw new Error("Provider transport conflicts with configured provider kind.");
      }
      return new CompatibleProvider(normalized, request, settings);
    case "openai-responses":
      if (!adapterConfig) throw new Error("OpenAI Responses requires a typed provider descriptor.");
      return new OpenAIResponsesAdapter(config as ProviderAdapterConfig, request, settings, dependencies);
    case "azure-openai-responses":
      if (!adapterConfig) throw new Error("Azure OpenAI Responses requires a typed provider descriptor.");
      return new AzureOpenAIResponsesAdapter(config as ProviderAdapterConfig, request, settings);
    case "anthropic-messages":
      return new CompatibleProvider({ ...normalized, kind: "anthropic" }, request, settings);
    case "google-generative-ai":
      if (!adapterConfig) throw new Error("Google Generative AI requires a typed provider descriptor.");
      return new GoogleGenerativeAIAdapter(config as ProviderAdapterConfig, request, settings);
    case "google-vertex":
      if (!adapterConfig) throw new Error("Google Vertex requires a typed provider descriptor.");
      return new GoogleGenerativeAIAdapter(config as ProviderAdapterConfig, request, settings);
    default:
      throw new Error(`Unsupported provider transport: ${transport}`);
  }
}

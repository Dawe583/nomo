import type {
  ImplementedProviderTransport,
  ProviderAdapterConfig,
  ProviderApiAvailability,
  ProviderAuthProfile,
} from "./provider-adapters/types.ts";

import { readFileSync } from "node:fs";

/** Source declarations pinned by the approved provider-coverage contract. */
export const PROVIDER_SOURCE_BASELINE = {
  omp: "18.6.2",
  prime: "0.10.1",
} as const;

/** Exact chat-model provider identifiers from each pinned source declaration. */
export const PROVIDER_SOURCE_ROSTER = {
  omp: [
    "abliteration", "aiand", "aimlapi", "alibaba-coding-plan", "alibaba-token-plan",
    "amazon-bedrock", "anthropic", "apple", "azure", "baseten", "bedrock-mantle",
    "cerebras", "charm-hyper", "cline-pass", "cloudflare-ai-gateway", "commandcode",
    "coreweave", "cursor", "deepinfra", "deepseek", "devin", "factory-droid",
    "firepass", "fireworks", "github-copilot", "gitlab-duo", "gitlab-duo-agent",
    "gmi-cloud", "google", "google-antigravity", "google-gemini-cli", "google-vertex",
    "groq", "helmcode", "huggingface", "kilo", "kimi-code", "litellm", "lm-studio",
    "local", "meta", "minimax", "minimax-code", "minimax-code-cn", "mistral",
    "moonshot", "muse-code", "nanogpt", "novita", "nvidia", "ollama", "ollama-cloud",
    "openai", "openai-codex", "opencode-go", "opencode-zen", "openrouter", "qianfan",
    "qwen-portal", "sakana", "siliconflow", "siliconflow-cn", "singularityapi-dev",
    "singularityapi-tech", "stepfun", "synthetic", "together", "typesafe", "umans",
    "venice", "vercel-ai-gateway", "vllm", "wafer-serverless", "web", "xai", "xai-oauth",
    "xiaomi", "xiaomi-token-plan-ams", "xiaomi-token-plan-cn", "xiaomi-token-plan-sgp",
    "yolo-auto", "zai", "zenmux", "zhipu-coding-plan",
  ],
  prime: [
    "amazon-bedrock", "anthropic", "azure-openai-responses", "cerebras",
    "cloudflare-ai-gateway", "cloudflare-workers-ai", "deepseek", "fireworks",
    "github-copilot", "google", "google-vertex", "groq", "huggingface", "kimi-coding",
    "minimax", "minimax-cn", "mistral", "moonshotai", "moonshotai-cn", "openai",
    "openai-codex", "opencode", "opencode-go", "openrouter", "prime-inference",
    "vercel-ai-gateway", "xai", "xiaomi", "xiaomi-token-plan-ams",
    "xiaomi-token-plan-cn", "xiaomi-token-plan-sgp", "zai",
  ],
} as const;

/** Includes compiled model-catalog providers absent from the source KnownProvider enum. */
export const PROVIDER_MODEL_PROVIDER_ROSTER = {
  omp: [...PROVIDER_SOURCE_ROSTER.omp, "minimax-cn"],
  prime: PROVIDER_SOURCE_ROSTER.prime,
} as const;

/** API enums are source truth; adapter inventory must explicitly classify all of them. */
export const PROVIDER_API_ROSTER = {
  omp: [
    "openai-completions", "openai-responses", "openrouter", "openai-codex-responses",
    "azure-openai-responses", "anthropic-messages", "bedrock-converse-stream",
    "google-generative-ai", "google-gemini-cli", "google-vertex", "ollama-chat",
    "cursor-agent", "factory-droid-agent", "gitlab-duo-agent", "devin-agent",
    "apple-foundation-models",
  ],
  prime: [
    "openai-completions", "mistral-conversations", "openai-responses",
    "azure-openai-responses", "openai-codex-responses", "anthropic-messages",
    "bedrock-converse-stream", "google-generative-ai", "google-vertex",
  ],
} as const;

export type ProviderSource = keyof typeof PROVIDER_SOURCE_ROSTER;

export type ProviderModelManifest = {
  readonly schemaVersion: 1;
  readonly apiTransports: readonly {
    readonly source: ProviderSource;
    readonly apiId: string;
    readonly name: string;
    readonly status: ProviderApiAvailability;
    readonly reason: string;
    readonly evidence: string;
  }[];
  readonly sources: Readonly<Record<ProviderSource, {
    readonly version: string;
    readonly providerIds: readonly string[];
    readonly modelProviderIds: readonly string[];
    readonly apiIds: readonly string[];
  }>>;
  readonly providers: readonly {
    readonly source: ProviderSource;
    readonly providerId: string;
    readonly unlistedModelProvider?: boolean;
    readonly status: "in-scope" | "excluded";
    readonly exclusionReason?: string;
    readonly defaultModel: string | null;
    readonly discovery: {
      readonly source: string;
      readonly mode: string;
      readonly descriptor: string | null;
    };
    readonly authentication: {
      readonly source: string;
      readonly methods: readonly string[];
      readonly envVars: readonly string[];
      readonly nativeAuthApis?: readonly string[];
    };
    readonly models: readonly {
      readonly id: string;
      readonly name: string;
      readonly kind: "chat" | "tiny";
      readonly transport: string;
      readonly endpoint: string | null;
      readonly endpointRule: string | null;
      readonly capabilities: {
        readonly input: readonly string[];
        readonly reasoning: boolean;
        readonly tools: boolean | null;
        readonly contextWindow: number | null;
        readonly maxTokens: number | null;
      };
      readonly evidence: string;
    }[];
  }[];
  readonly excludedModels: readonly {
    readonly source: string;
    readonly providerId: string;
    readonly modelId: string;
    readonly kind: string;
    readonly transport: string;
    readonly reason: string;
    readonly evidence: string;
  }[];
};

export const PROVIDER_MODEL_MANIFEST = JSON.parse(
  readFileSync(new URL("./provider-manifest.json", import.meta.url), "utf8"),
) as ProviderModelManifest;

export type ConfigurableProviderDescriptor = {
  readonly id: string;
  readonly providerId: string;
  readonly transport: ImplementedProviderTransport;
  readonly endpoint: string | null;
  readonly endpointRule: string | null;
  readonly model: string;
  readonly models: readonly string[];
  readonly authKind: ProviderAuthProfile["kind"];
};

function authKindForTransport(
  transport: ImplementedProviderTransport,
): ProviderAuthProfile["kind"] {
  if (transport === "bedrock-converse-stream") return "aws-credentials";
  if (transport === "ollama-chat") return "none";
  return "api-key";
}
function supportsManifestAuth(
  provider: ProviderModelManifest["providers"][number],
  transport: ImplementedProviderTransport,
  authKind: ProviderAuthProfile["kind"],
): boolean {
  const methods = provider.authentication.methods;
  if (authKind === "api-key")
    return methods.includes("api-key") || methods.includes("optional-api-key");
  if (authKind === "aws-credentials") {
    // Static AWS keys are not the manifest's native, host, or credential-chain auth.
    return (
      provider.providerId === "amazon-bedrock" &&
      transport === "bedrock-converse-stream" &&
      methods.includes("aws-credentials")
    );
  }
  return methods.includes("none") || methods.includes("optional-api-key");
}


const IMPLEMENTED_TRANSPORTS = new Set(
  PROVIDER_MODEL_MANIFEST.apiTransports
    .filter((api) => api.status === "implemented")
    .map((api) => api.apiId),
);

const descriptorMap = new Map<
  string,
  ConfigurableProviderDescriptor & { models: string[] }
>();
for (const provider of PROVIDER_MODEL_MANIFEST.providers) {
  if (provider.status !== "in-scope") continue;
  for (const model of provider.models) {
    if (model.kind !== "chat" || !IMPLEMENTED_TRANSPORTS.has(model.transport))
      continue;
    const transport = model.transport as ImplementedProviderTransport;
    if (
      !supportsManifestAuth(
        provider,
        transport,
        authKindForTransport(transport),
      ) ||
      (typeof model.endpoint === "string" && /[<>{}]/.test(model.endpoint)) ||
      (model.endpoint === null && !model.endpointRule)
    )
      continue;
    const id = JSON.stringify([
      provider.providerId,
      transport,
      model.endpoint,
      model.endpointRule,
    ]);
    const existing = descriptorMap.get(id);
    if (existing) {
      if (!existing.models.includes(model.id)) existing.models.push(model.id);
      continue;
    }
    const defaultModel = provider.models.find(
      (candidate) =>
        candidate.id === provider.defaultModel &&
        candidate.kind === "chat" &&
        candidate.transport === transport &&
        candidate.endpoint === model.endpoint &&
        candidate.endpointRule === model.endpointRule,
    )?.id ?? model.id;
    descriptorMap.set(id, {
      id,
      providerId: provider.providerId,
      transport,
      endpoint: model.endpoint,
      endpointRule: model.endpointRule,
      model: defaultModel,
      models: [model.id],
      authKind: authKindForTransport(transport),
    });
  }
}
export const CONFIGURABLE_PROVIDER_DESCRIPTORS:
  readonly ConfigurableProviderDescriptor[] = Object.freeze(
    [...descriptorMap.values()]
      .sort(
        (left, right) =>
          left.providerId.localeCompare(right.providerId) ||
          left.transport.localeCompare(right.transport) ||
          (left.endpoint ?? "").localeCompare(right.endpoint ?? ""),
      )
      .map((descriptor) =>
        Object.freeze({
          ...descriptor,
          models: Object.freeze([...descriptor.models]),
        }),
      ),
  );

function matchesDynamicEndpointRule(
  model: ProviderModelManifest["providers"][number]["models"][number],
  transport: ImplementedProviderTransport,
  baseUrl: string,
): boolean {
  if (model.endpoint !== null || model.endpointRule === null) return false;
  // Endpoint rules are source-backed prose. Support only the dynamic rule with
  // a transport-level host contract; unknown rules stay unavailable.
  if (transport !== "azure-openai-responses") return false;
  try {
    const endpoint = new URL(baseUrl);
    const path = endpoint.pathname.replace(/\/$/, "");
    return (
      endpoint.protocol === "https:" &&
      /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.openai\.azure\.com$/i.test(endpoint.hostname) &&
      !endpoint.username &&
      !endpoint.password &&
      !endpoint.port &&
      !endpoint.search &&
      !endpoint.hash &&
      ["", "/openai", "/openai/v1"].includes(path)
    );
  } catch {
    return false;
  }
}

function matchesManifestEndpoint(
  model: ProviderModelManifest["providers"][number]["models"][number],
  transport: ImplementedProviderTransport,
  baseUrl: string,
): boolean {
  return (
    model.endpoint === baseUrl ||
    matchesDynamicEndpointRule(model, transport, baseUrl)
  );
}

export function assertProviderDescriptorInManifest(
  config: ProviderAdapterConfig,
): void {
  if (!IMPLEMENTED_TRANSPORTS.has(config.transport))
    throw new Error(`Provider transport ${config.transport} is not implemented.`);
  const transport = config.transport as ImplementedProviderTransport;
  const authKind = authKindForTransport(transport);
  if (config.auth.kind !== authKind)
    throw new Error(`Provider transport ${transport} requires ${authKind} authentication.`);
  if (
    typeof config.model !== "string" ||
    config.model.trim().length === 0 ||
    config.model !== config.model.trim()
  )
    throw new Error("A manifest model is required.");

  const providers = PROVIDER_MODEL_MANIFEST.providers.filter(
    (provider) =>
      provider.status === "in-scope" &&
      provider.providerId === config.providerId,
  );
  const modelMatches = (
    model: ProviderModelManifest["providers"][number]["models"][number],
  ) =>
    model.kind === "chat" &&
    model.transport === transport &&
    model.id === config.model;
  const matchingProviders = providers.filter((provider) =>
    provider.models.some(modelMatches),
  );
  if (!matchingProviders.length)
    throw new Error("Provider, transport and model do not match the manifest.");
  const authProviders = matchingProviders.filter((provider) =>
    supportsManifestAuth(provider, transport, authKind),
  );
  if (!authProviders.length)
    throw new Error("Provider authentication is not supported by this setup.");
  const models = authProviders.flatMap((provider) =>
    provider.models.filter(modelMatches),
  );

  const endpointMatches = models.some((model) =>
    matchesManifestEndpoint(model, transport, config.baseUrl),
  );
  const bedrockRegionEndpoint =
    transport === "bedrock-converse-stream" &&
    (() => {
      try {
        const endpoint = new URL(config.baseUrl);
        return (
          endpoint.protocol === "https:" &&
          !endpoint.username &&
          !endpoint.password &&
          !endpoint.port &&
          !endpoint.search &&
          !endpoint.hash &&
          endpoint.pathname === "/" &&
          /^bedrock-runtime\.[a-z0-9-]+\.amazonaws\.com$/i.test(endpoint.hostname)
        );
      } catch {
        return false;
      }
    })();
  if (!endpointMatches && !bedrockRegionEndpoint)
    throw new Error("Provider endpoint does not match the manifest.");
}

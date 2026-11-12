import type {
  ImplementedProviderTransport,
  ProviderAdapterConfig,
  ProviderApiAvailability,
  ProviderAuthProfile,
} from "./provider-adapters/types.ts";
import { PROVIDER_MODEL_TRANSPORT_BLOCKERS } from "./provider-adapters/types.ts";
import { isStandardVertexOptions, standardVertexBaseUrl } from "./provider-adapters/google-vertex-config.ts";
import { isBedrockMantleBaseUrl } from "./provider-adapters/bedrock-mantle-config.ts";
import {
  cloudflareAiGatewayRouteForTransport,
  normalizeCloudflareAiGatewayEndpoint,
} from "./provider-adapters/cloudflare-ai-gateway-config.ts";
import { normalizeCloudflareWorkersAiEndpoint } from "./provider-adapters/cloudflare-workers-ai-config.ts";

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

export const UNAVAILABLE_PROVIDER_MODEL_TRANSPORTS = Object.entries(
  PROVIDER_MODEL_TRANSPORT_BLOCKERS,
).map(([transportId, blocker]) => {
  const models = PROVIDER_MODEL_MANIFEST.providers
    .filter(
      (provider) =>
        provider.source === blocker.source &&
        provider.providerId === blocker.providerId,
    )
    .flatMap((provider) =>
      provider.models.filter((model) => model.transport === transportId),
    );
  if (!models.length || models.some((model) => model.kind !== "tiny"))
    throw new Error(`Blocked provider model transport is absent or not tiny: ${transportId}`);
  return {
    ...blocker,
    transportId,
    modelIds: models.map((model) => model.id).sort(),
    disabled: true as const,
  };
});

/** Provider/model combinations whose pinned contracts are not configurable in Workbench. */
const DOCUMENTED_KIMI_CODE_MODEL_IDS = new Set([
  "k3",
  "k3-256k",
  "kimi-for-coding",
  "kimi-for-coding-highspeed",
]);

type ProviderModelBlocker = {
  readonly source: string;
  readonly providerId: string;
  readonly transportId: string;
  readonly modelIds?: readonly string[];
  readonly reason: string;
  readonly evidence: string;
};

const PROVIDER_MODEL_BLOCKERS: readonly ProviderModelBlocker[] = [
  {
    source: "omp",
    providerId: "google-vertex",
    transportId: "anthropic-messages",
    reason: "OMP Vertex Anthropic rows require project/location placeholders, streamRawPredict routing, and host credentials; Workbench only describes its separate standard Vertex API-key route.",
    evidence: "OMP 18.6.2 packages/catalog/src/compat/rules.json:auth.providers and catalog/models.json; Workbench google-vertex-config.ts supports only the standard Vertex endpoint rule.",
  },
  {
    source: "omp",
    providerId: "google-vertex",
    transportId: "openai-completions",
    reason: "OMP Vertex OpenAI rows require project/location placeholders and host credentials; Workbench only describes its separate standard Vertex API-key route.",
    evidence: "OMP 18.6.2 packages/catalog/src/compat/rules.json:auth.providers and catalog/models.json; Workbench google-vertex-config.ts supports only the standard Vertex endpoint rule.",
  },
  {
    source: "omp",
    providerId: "kimi-code",
    transportId: "openai-completions",
    modelIds: ["kimi-k2", "kimi-k2-turbo-preview", "kimi-k2.5"],
    reason: "These Kimi Code model IDs are absent from its current official third-party model list; Workbench does not infer that old catalog rows remain routable.",
    evidence: "https://www.kimi.com/code/docs/en/models.html (model overview); OMP 18.6.2 catalog/models.json",
  },
  {
    source: "omp",
    providerId: "muse-code",
    transportId: "openai-responses",
    reason: "Muse Code declares device-code authentication, which Workbench does not implement.",
    evidence: "OMP 18.6.2 packages/catalog/src/compat/rules.json:auth.providers; Workbench has no device-code authentication profile.",
  },
] as const;

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
  providerId: string,
  transport: ImplementedProviderTransport,
): ProviderAuthProfile["kind"] {
  if (transport === "bedrock-converse-stream") return "aws-credential-chain";
  if (transport === "ollama-chat")
    return providerId === "ollama-cloud" ? "api-key" : "none";
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
  if (authKind === "aws-credential-chain") {
    // OMP's host-credential declaration maps to the existing SDK chain, not its bearer-token path.
    const sourceDeclaresHostCredentialChain =
      provider.source === "omp" &&
      methods.includes("native-auth") &&
      methods.includes("host-credential");
    const bedrockHostCredentialTransport =
      (provider.providerId === "amazon-bedrock" &&
        transport === "bedrock-converse-stream") ||
      (provider.providerId === "bedrock-mantle" &&
        transport === "openai-responses");
    return (
      bedrockHostCredentialTransport &&
      (methods.includes("aws-credential-chain") ||
        sourceDeclaresHostCredentialChain)
    );
  }
  return methods.includes("none") || methods.includes("optional-api-key");
}


const IMPLEMENTED_TRANSPORTS = new Set(
  PROVIDER_MODEL_MANIFEST.apiTransports
    .filter((api) => api.status === "implemented")
    .map((api) => api.apiId),
);

function isCloudflareAiGatewayManifestEndpoint(
  providerId: string,
  endpoint: string | null,
  transport: ImplementedProviderTransport,
): boolean {
  const route = cloudflareAiGatewayRouteForTransport(transport);
  if (providerId !== "cloudflare-ai-gateway" || route === null) return false;
  return (
    endpoint === `https://gateway.ai.cloudflare.com/v1/<account>/<gateway>/${route}` ||
    endpoint === `https://gateway.ai.cloudflare.com/v1/{CLOUDFLARE_ACCOUNT_ID}/{CLOUDFLARE_GATEWAY_ID}/${route}`
  );
}
function isCloudflareWorkersAiManifestEndpoint(
  providerId: string,
  endpoint: string | null,
  transport: ImplementedProviderTransport,
): boolean {
  return (
    providerId === "cloudflare-workers-ai" &&
    transport === "openai-completions" &&
    endpoint === "https://api.cloudflare.com/client/v4/accounts/{CLOUDFLARE_ACCOUNT_ID}/ai/v1"
  );
}

const descriptorMap = new Map<
  string,
  ConfigurableProviderDescriptor & { models: string[] }
>();
for (const provider of PROVIDER_MODEL_MANIFEST.providers) {
  if (provider.status !== "in-scope") continue;
  for (const model of provider.models) {
    if (model.kind !== "chat" || !IMPLEMENTED_TRANSPORTS.has(model.transport))
      continue;
    if (
      provider.source === "omp" &&
      provider.providerId === "kimi-code" &&
      !DOCUMENTED_KIMI_CODE_MODEL_IDS.has(model.id)
    ) continue;
    const transport = model.transport as ImplementedProviderTransport;
    const vertexDynamic =
      transport === "google-vertex" &&
      model.endpoint === "https://{location}-aiplatform.googleapis.com";
    const cloudflareDynamic = isCloudflareAiGatewayManifestEndpoint(
      provider.providerId,
      model.endpoint,
      transport,
    );
    const cloudflareWorkersAiDynamic = isCloudflareWorkersAiManifestEndpoint(
      provider.providerId,
      model.endpoint,
      transport,
    );
    const bedrockMantleDynamic =
      provider.providerId === "bedrock-mantle" &&
      transport === "openai-responses" &&
      model.endpoint === "https://bedrock-mantle.{region}.api.aws/openai/v1";
    if (
      !supportsManifestAuth(
        provider,
        transport,
        authKindForTransport(provider.providerId, transport),
      ) ||
      (typeof model.endpoint === "string" &&
        /[<>{}]/.test(model.endpoint) &&
        !vertexDynamic &&
        !bedrockMantleDynamic &&
        !cloudflareDynamic &&
        !cloudflareWorkersAiDynamic) ||
      (model.endpoint === null && !model.endpointRule)
    )
      continue;
    const id = JSON.stringify([
      provider.providerId,
      transport,
      bedrockMantleDynamic || cloudflareDynamic || cloudflareWorkersAiDynamic
        ? null
        : model.endpoint,
      bedrockMantleDynamic
        ? "aws-bedrock-mantle"
        : cloudflareDynamic
          ? "cloudflare-ai-gateway"
          : cloudflareWorkersAiDynamic
            ? "cloudflare-workers-ai"
            : model.endpointRule,
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
      endpoint:
        vertexDynamic || bedrockMantleDynamic || cloudflareDynamic || cloudflareWorkersAiDynamic
          ? null
          : model.endpoint,
      endpointRule: vertexDynamic
        ? "google-vertex-standard"
        : bedrockMantleDynamic
          ? "aws-bedrock-mantle"
          : cloudflareDynamic
            ? "cloudflare-ai-gateway"
            : cloudflareWorkersAiDynamic
              ? "cloudflare-workers-ai"
              : model.endpointRule,
      model: defaultModel,
      models: [model.id],
      authKind: authKindForTransport(provider.providerId, transport),
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

const providerModelBlockerKeys = new Set<string>();
export const UNAVAILABLE_PROVIDER_MODELS = Object.freeze(
  PROVIDER_MODEL_BLOCKERS.map((blocker) => {
    const key = JSON.stringify([
      blocker.source,
      blocker.providerId,
      blocker.transportId,
      blocker.modelIds ?? null,
    ]);
    if (providerModelBlockerKeys.has(key))
      throw new Error(`Duplicate provider model blocker: ${key}`);
    providerModelBlockerKeys.add(key);
    const providers = PROVIDER_MODEL_MANIFEST.providers.filter(
      (provider) =>
        provider.source === blocker.source &&
        provider.providerId === blocker.providerId &&
        provider.status === "in-scope",
    );
    if (providers.length !== 1)
      throw new Error(`Provider model blocker does not match one in-scope provider: ${key}`);
    const models = providers[0].models.filter(
      (model) =>
        model.kind === "chat" &&
        model.transport === blocker.transportId &&
        (!blocker.modelIds || new Set<string>(blocker.modelIds).has(model.id)),
    );
    if (
      !models.length ||
      models.some((model) =>
        CONFIGURABLE_PROVIDER_DESCRIPTORS.some(
          (descriptor) =>
            descriptor.providerId === blocker.providerId &&
            descriptor.transport === blocker.transportId &&
            descriptor.models.includes(model.id),
        ),
      )
    )
      throw new Error(`Provider model blocker overlaps or misses its source rows: ${key}`);
    return Object.freeze({
      ...blocker,
      status: "blocked" as const,
      modelIds: Object.freeze(models.map((model) => model.id).sort()),
      disabled: true as const,
    });
  }),
);

export type ModelCapabilityDisclosure =
  | {
      readonly status: "known";
      readonly modelId: string;
      readonly input: readonly string[];
      readonly reasoning: boolean;
      readonly tools: boolean | null;
      readonly contextWindow: number | null;
      readonly maxTokens: number | null;
    }
  | {
      readonly status: "conflict";
      readonly modelId: string;
    };

type ModelCapabilities =
  ProviderModelManifest["providers"][number]["models"][number]["capabilities"];

function sameCapabilities(left: ModelCapabilities, right: ModelCapabilities): boolean {
  if (
    left.input.length !== right.input.length ||
    left.reasoning !== right.reasoning ||
    left.tools !== right.tools ||
    left.contextWindow !== right.contextWindow ||
    left.maxTokens !== right.maxTokens
  )
    return false;
  for (const input of left.input) {
    let leftCount = 0;
    let rightCount = 0;
    for (const candidate of left.input)
      if (candidate === input) leftCount++;
    for (const candidate of right.input)
      if (candidate === input) rightCount++;
    if (leftCount !== rightCount) return false;
  }
  return true;
}

export function modelCapabilityDisclosure(
  descriptorId: string,
  modelId: string,
): ModelCapabilityDisclosure | undefined {
  const descriptor = CONFIGURABLE_PROVIDER_DESCRIPTORS.find(
    candidate => candidate.id === descriptorId,
  );
  if (!descriptor || !descriptor.models.includes(modelId)) return undefined;

  let first: ModelCapabilities | undefined;
  for (const provider of PROVIDER_MODEL_MANIFEST.providers) {
    if (
      provider.status !== "in-scope" ||
      provider.providerId !== descriptor.providerId
    )
      continue;
    for (const model of provider.models) {
      if (
        model.kind !== "chat" ||
        model.id !== modelId ||
        model.transport !== descriptor.transport ||
        model.endpoint !== descriptor.endpoint ||
        model.endpointRule !== descriptor.endpointRule
      )
        continue;
      if (first && !sameCapabilities(first, model.capabilities))
        return { status: "conflict", modelId };
      first ??= model.capabilities;
    }
  }
  if (!first) return undefined;

  return {
    status: "known",
    modelId,
    input: [...first.input],
    reasoning: first.reasoning,
    tools: first.tools,
    contextWindow: first.contextWindow,
    maxTokens: first.maxTokens,
  };
}

function matchesDynamicEndpointRule(
  model: ProviderModelManifest["providers"][number]["models"][number],
  transport: ImplementedProviderTransport,
  baseUrl: string,
): boolean {
  if (
    isCloudflareAiGatewayManifestEndpoint(
      "cloudflare-ai-gateway",
      model.endpoint,
      transport,
    )
  ) {
    try {
      return normalizeCloudflareAiGatewayEndpoint(new URL(baseUrl), transport) !== null;
    } catch {
      return false;
    }
  }
  if (
    model.endpoint ===
      "https://api.cloudflare.com/client/v4/accounts/{CLOUDFLARE_ACCOUNT_ID}/ai/v1" &&
    transport === "openai-completions"
  ) {
    try {
      return normalizeCloudflareWorkersAiEndpoint(new URL(baseUrl)) !== null;
    } catch {
      return false;
    }
  }
  if (
    model.endpoint === "https://bedrock-mantle.{region}.api.aws/openai/v1" &&
    transport === "openai-responses"
  ) return isBedrockMantleBaseUrl(baseUrl);
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
  vertexOptions?: ProviderAdapterConfig["vertexOptions"],
): boolean {
  return (
    model.endpoint === baseUrl ||
    matchesDynamicEndpointRule(model, transport, baseUrl) ||
    (transport === "google-vertex" &&
      model.endpoint === "https://{location}-aiplatform.googleapis.com" &&
      isStandardVertexOptions(vertexOptions) &&
      standardVertexBaseUrl(vertexOptions.location) === baseUrl)
  );
}

export function assertProviderDescriptorInManifest(
  config: ProviderAdapterConfig,
): void {
  if (!IMPLEMENTED_TRANSPORTS.has(config.transport))
    throw new Error(`Provider transport ${config.transport} is not implemented.`);
  const transport = config.transport as ImplementedProviderTransport;
  if (config.auth.kind === "openai-chatgpt-account") {
    if (
      config.providerId !== "openai" || transport !== "openai-responses" ||
      config.baseUrl !== "https://api.openai.com/v1" ||
      !config.auth.accountId.trim() || typeof config.model !== "string" ||
      !config.model.trim() || config.model !== config.model.trim() ||
      config.azureOptions !== undefined || config.vertexOptions !== undefined ||
      config.gatewayOptions !== undefined
    ) throw new Error("ChatGPT account profiles require an account-bound OpenAI Responses model.");
    return;
  }
  const authKind = authKindForTransport(config.providerId, transport);
  const alternateMantleHostCredential =
    config.providerId === "bedrock-mantle" &&
    transport === "openai-responses" &&
    config.auth.kind === "aws-credential-chain";
  if (config.auth.kind !== authKind && !alternateMantleHostCredential)
    throw new Error(`Provider transport ${transport} requires ${authKind} authentication.`);
  if (transport === "google-vertex") {
    if (
      config.providerId !== "google-vertex" ||
      !isStandardVertexOptions(config.vertexOptions)
    )
      throw new Error("Google Vertex requires Standard mode, project ID and location.");
  } else if (config.vertexOptions !== undefined) {
    throw new Error("Vertex options are valid only for Google Vertex.");
  }
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
    supportsManifestAuth(provider, transport, config.auth.kind),
  );
  if (!authProviders.length)
    throw new Error("Provider authentication is not supported by this setup.");
  const models = authProviders.flatMap((provider) =>
    provider.models.filter(modelMatches),
  );

  const endpointMatches = models.some((model) =>
    matchesManifestEndpoint(model, transport, config.baseUrl, config.vertexOptions),
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

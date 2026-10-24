import type { ProviderApiAvailability } from "./provider-adapters/types.ts";

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

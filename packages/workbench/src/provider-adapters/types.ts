import type { Model, ModelMessage, ModelReply } from "../provider.ts";

/**
 * Pinned provider APIs not implemented by Workbench. These names remain
 * typeable so callers receive a specific fail-closed explanation, not a
 * generic unknown-transport error or a protocol fallback.
 */
export const IMPLEMENTED_PROVIDER_TRANSPORTS = [
  "openai-completions",
  "openai-responses",
  "azure-openai-responses",
  "anthropic-messages",
  "google-generative-ai",
  "google-vertex",
  "bedrock-converse-stream",
  "mistral-conversations",
  "ollama-chat",
  "openrouter",
] as const;

export type ImplementedProviderTransport = typeof IMPLEMENTED_PROVIDER_TRANSPORTS[number];
export type ProviderApiAvailability = "implemented" | "blocked" | "platform-unavailable";

/** Source-backed provider APIs that must not fall through to a different wire. */
export const PROVIDER_API_BLOCKERS = {
  "google-gemini-cli": {
    providerId: "google-gemini-cli",
    name: "Google Gemini CLI / Cloud Code Assist",
    status: "blocked",
    reason: "Google Gemini CLI Cloud Code OAuth/SSE is a first-party CLI path with no documented third-party Cloud Code contract; Workbench has no OAuth lifecycle. Free/AI Pro/Ultra consumer Gemini CLI service access retired on June 18, 2026; enterprise/API-key access remains a first-party CLI path. Do not read or reuse CLI credentials; Google Generative AI API-key auth remains separate.",
    evidence: "OMP 18.6.2 packages/ai/src/providers/google-gemini-cli.ts:315,507-515,584-595,934-944; packages/ai/src/registry/oauth/google-gemini-cli.ts:12,61-79,101-130,181-230,234-263. Prime 0.10.1 has no google-gemini-cli API ID; its Google provider is google-generative-ai (crates/pa-ai/src/providers/google.rs:1-3,240-263). Official https://geminicli.com/docs/get-started/authentication/ and https://developers.googleblog.com/an-important-update-transitioning-gemini-cli-to-antigravity-cli/.",
  },
  "openai-codex-responses": {
    providerId: "openai-codex",
    name: "OpenAI Codex Responses",
    status: "blocked",
    reason: "Codex Responses requires ChatGPT account sign-in; the private backend route and Workbench OAuth lifecycle/app-server bridge are unavailable. API keys are not OAuth credentials.",
    evidence: "OMP 18.6.2 packages/ai/src/registry/oauth/openai-codex.ts:130-151,207-297; packages/ai/src/providers/openai-codex-responses.ts:1431-1439,4813-4820,4915-4921; Prime 0.10.1 crates/pa-ai/src/oauth/openai_codex.rs:69-95; crates/pa-ai/src/providers/openai_codex_responses/request.rs:11-27,66-91; official https://developers.openai.com/codex/auth/ and https://learn.chatgpt.com/docs/app-server.",
  },
  "cursor-agent": {
    providerId: "cursor",
    name: "Cursor Agent",
    status: "blocked",
    reason: "Cursor Connect/protobuf agent transport and OAuth lifecycle are not implemented.",
    evidence: "OMP 18.6.2 packages/ai/src/providers/cursor.ts:1165-1189,1202-1225; packages/ai/src/registry/oauth/cursor.ts:5-7,21-34,37-64,89-149.",
  },
  "factory-droid-agent": {
    providerId: "factory-droid",
    name: "Factory Droid",
    status: "blocked",
    reason: "Factory LLM proxy requires WorkOS device-code auth and identity headers; Factory API keys are rejected.",
    evidence: "OMP 18.6.2 packages/ai/src/providers/factory-droid.ts:31-56; packages/catalog/src/compat/rules/auth/factory-droid.kdl:1-27.",
  },
  "gitlab-duo-agent": {
    providerId: "gitlab-duo-agent",
    name: "GitLab Duo Agent",
    status: "blocked",
    reason: "GitLab Duo Workflow protocol and its remote workflow setup are not implemented.",
    evidence: "OMP 18.6.2 packages/ai/src/providers/gitlab-duo-workflow.ts:482-527,979-982; packages/ai/src/stream.ts:1015-1023; packages/catalog/src/compat/rules/auth/gitlab-duo-agent.kdl:1-22.",
  },
  "devin-agent": {
    providerId: "devin",
    name: "Devin Agent",
    status: "blocked",
    reason: "Devin Cascade Connect/protobuf transport and OAuth session-token exchange are not implemented.",
    evidence: "OMP 18.6.2 packages/ai/src/providers/devin.ts:220-265,544-595; packages/ai/src/registry/oauth/devin.ts; packages/catalog/src/wire/devin.ts:8-30,47-68.",
  },
  "apple-foundation-models": {
    providerId: "apple",
    name: "Apple Foundation Models",
    status: "platform-unavailable",
    reason: "Apple Foundation Models native pi-natives bridge is not linked in Workbench; upstream requires a built bridge on macOS 27+ and an Apple Intelligence-eligible device.",
    evidence: "OMP 18.6.2 packages/ai/src/providers/apple-foundation-models.ts:1-13; packages/coding-agent/src/config/model-discovery.ts:449-470; crates/pi-natives/src/applefm/mod.rs:75-109.",
  },
} as const;

/** Model transports intentionally unavailable in the dependency-free Harness. */
export const PROVIDER_MODEL_TRANSPORT_BLOCKERS = {
  "local-inference": {
    source: "omp",
    providerId: "local",
    name: "OMP Local Inference",
    status: "blocked",
    reason: "NOMO keeps the default Harness dependency-free; the OMP local-inference transport requires an ONNX/MLX worker and downloaded model weights, not a generic HTTP API.",
    evidence: "https://raw.githubusercontent.com/can1357/oh-my-pi/v18.6.2/packages/catalog/src/compat/rules/providers/local.kdl; https://raw.githubusercontent.com/can1357/oh-my-pi/v18.6.2/docs/local-models.md",
  },
} as const;


export type BlockedProviderApi = keyof typeof PROVIDER_API_BLOCKERS;

export const BLOCKED_PROVIDER_APIS_BY_PROVIDER: Readonly<Record<string, BlockedProviderApi>> = {
  "google-gemini-cli": "google-gemini-cli",
  "openai-codex": "openai-codex-responses",
  cursor: "cursor-agent",
  "factory-droid": "factory-droid-agent",
  "gitlab-duo-agent": "gitlab-duo-agent",
  devin: "devin-agent",
  apple: "apple-foundation-models",
};

export type ProviderTransport = ImplementedProviderTransport | BlockedProviderApi;

export type OpenRouterSort =
  | string
  | { readonly by?: string; readonly partition?: string };
export type OpenRouterThreshold =
  | number
  | { readonly p50?: number; readonly p75?: number; readonly p90?: number; readonly p99?: number };
export type OpenRouterMaxPrice = {
  readonly prompt?: number | string;
  readonly completion?: number | string;
  readonly image?: number | string;
  readonly audio?: number | string;
  readonly request?: number | string;
};
export type OpenRouterProviderPreferences = {
  readonly order?: readonly string[];
  readonly allow_fallbacks?: boolean;
  readonly require_parameters?: boolean;
  readonly data_collection?: "allow" | "deny";
  readonly zdr?: boolean;
  readonly enforce_distillable_text?: boolean;
  readonly only?: readonly string[];
  readonly ignore?: readonly string[];
  readonly quantizations?: readonly string[];
  readonly sort?: OpenRouterSort;
  readonly preferred_min_throughput?: OpenRouterThreshold;
  readonly preferred_max_latency?: OpenRouterThreshold;
  readonly max_price?: OpenRouterMaxPrice;
};
export type ProviderGatewayOptions = {
  readonly openrouter?: {
    readonly referer?: string;
    readonly title?: string;
    readonly categories?: readonly string[];
    readonly provider?: OpenRouterProviderPreferences;
  };
  readonly vercel?: {
    readonly referer?: string;
    readonly title?: string;
  };
};
export type ProviderAzureOptions = {
  readonly apiVersion?: "v1" | "preview";
};

export type ProviderVertexOptions = {
  readonly mode: "standard";
  readonly projectId: string;
  readonly location: string;
};

export type ProviderAuthProfile =
  | {
      readonly kind: "api-key";
      readonly apiKey: string;
    }
  | {
      readonly kind: "aws-credential-chain";
    }
  | {
      readonly kind: "none";
    };
export type AwsCredentialProvider = () => Promise<{
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly sessionToken?: string;
}>;
export type ProviderAdapterDependencies = {
  readonly awsCredentialProvider?: AwsCredentialProvider;
};

export type ProviderAdapterConfig = {
  readonly providerId: string;
  readonly transport: ProviderTransport;
  readonly baseUrl: string;
  readonly auth: ProviderAuthProfile;
  readonly model?: string;
  readonly gatewayOptions?: ProviderGatewayOptions;
  readonly azureOptions?: ProviderAzureOptions;
  readonly vertexOptions?: ProviderVertexOptions;
};


export interface ProviderClient {
  models(): Promise<readonly Model[]>;
  complete(
    model: string,
    messages: readonly ModelMessage[],
    tools: readonly unknown[],
    signal: AbortSignal,
    onDelta?: (text: string) => void | Promise<void>,
  ): Promise<ModelReply>;
  redact(text: string): string;
}

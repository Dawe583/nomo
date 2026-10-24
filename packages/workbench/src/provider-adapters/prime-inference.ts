import {
  CompatibleProvider,
  ProviderRequestError,
  type Model,
  type ModelMessage,
  type ModelReply,
  type ProviderConfig,
} from "../provider.ts";
import { PROVIDER_MODEL_MANIFEST } from "../provider-catalog.ts";
import type { HarnessSettings } from "../harness-settings.ts";
import type { ProviderClient } from "./types.ts";

const PRIME_ENDPOINT = "https://api.pinference.ai/api/v1";

function validateStaticContract(): void {
  const provider = PROVIDER_MODEL_MANIFEST.providers.find(
    entry => entry.source === "prime" && entry.providerId === "prime-inference",
  );
  const api = PROVIDER_MODEL_MANIFEST.apiTransports.find(
    entry => entry.source === "prime" && entry.apiId === "openai-completions",
  );
  if (
    !provider ||
    !api ||
    api.status !== "implemented" ||
    provider.status !== "in-scope" ||
    provider.models.length === 0 ||
    provider.models.some(
      model => model.transport !== "openai-completions" || model.endpoint !== PRIME_ENDPOINT,
    )
  )
    throw new Error("Prime Inference static catalog contract is invalid.");
}

function validateEndpoint(config: ProviderConfig): void {
  let endpoint: URL;
  try {
    endpoint = new URL(config.baseUrl);
  } catch {
    throw new Error("Prime Inference requires the official HTTPS endpoint.");
  }
  if (
    endpoint.origin !== "https://api.pinference.ai" ||
    endpoint.pathname.replace(/\/$/, "") !== "/api/v1" ||
    endpoint.search ||
    endpoint.hash ||
    endpoint.username ||
    endpoint.password
  )
    throw new Error("Prime Inference requires the official HTTPS endpoint.");
  if (!config.apiKey.trim())
    throw new Error("Prime Inference requires an explicitly configured API key.");
}

/** Prime Inference uses the shared OpenAI Chat Completions wire; this wrapper
 * adds only Prime's pinned endpoint, live entitlement catalog, and auth rules.
 * Contracts: https://docs.primeintellect.ai/api-reference/inference-chat-completions
 * and https://docs.primeintellect.ai/api-reference/inference-models. */
export class PrimeInferenceProvider implements ProviderClient {
  private readonly provider: CompatibleProvider;
  private readonly request: typeof fetch;
  private readonly apiKey: string;
  private availableModels = new Set<string>();

  constructor(
    config: ProviderConfig,
    request: typeof fetch = fetch,
    settings: Partial<HarnessSettings> | (() => HarnessSettings) = {},
  ) {
    validateStaticContract();
    validateEndpoint(config);
    this.apiKey = config.apiKey;
    this.request = request;
    this.provider = new CompatibleProvider(config, request, settings);
  }

  async models(): Promise<readonly Model[]> {
    this.availableModels = new Set();
    let response: Response;
    try {
      response = await this.request(new URL("models", `${PRIME_ENDPOINT}/`), {
        method: "GET",
        headers: { authorization: `Bearer ${this.apiKey}` },
        redirect: "error",
        signal: AbortSignal.timeout(15_000),
      });
    } catch {
      throw new Error("Prime Inference model catalog request failed.");
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      if (response.status === 404)
        throw new Error("Prime Inference model catalog is unavailable.");
      throw new ProviderRequestError(response.status);
    }
    let catalog: unknown;
    try {
      catalog = await response.json();
    } catch {
      throw new Error("Prime Inference returned an invalid model catalog.");
    }
    if (
      typeof catalog !== "object" ||
      catalog === null ||
      !("data" in catalog) ||
      !Array.isArray(catalog.data)
    )
      throw new Error("Prime Inference returned an invalid model catalog.");
    const availableModels = new Set<string>();
    const models: Model[] = [];
    for (const entry of catalog.data) {
      if (
        typeof entry !== "object" ||
        entry === null ||
        !("id" in entry) ||
        typeof entry.id !== "string" ||
        !entry.id.trim() ||
        availableModels.has(entry.id)
      )
        throw new Error("Prime Inference returned an invalid model catalog.");
      availableModels.add(entry.id);
      models.push({
        id: entry.id,
        name:
          ("display_name" in entry && typeof entry.display_name === "string"
            ? entry.display_name
            : "name" in entry && typeof entry.name === "string"
              ? entry.name
              : entry.id),
      });
    }
    if (!models.length)
      throw new Error("Prime Inference returned no available models.");
    this.availableModels = availableModels;
    return models;
  }

  async complete(
    model: string,
    messages: readonly ModelMessage[],
    tools: readonly unknown[],
    signal: AbortSignal,
    onDelta?: (text: string) => void | Promise<void>,
  ): Promise<ModelReply> {
    if (!this.availableModels.has(model))
      throw new Error("Requested model is not present in the Prime Inference model catalog.");
    return this.provider.complete(model, messages, tools, signal, onDelta);
  }

  redact(text: string): string {
    return this.provider.redact(text);
  }
}

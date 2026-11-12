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
const MAX_CATALOG_BYTES = 2 * 1024 * 1024;

async function readCatalogResponse(response: Response): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader)
    throw new Error("Prime Inference returned an invalid model catalog.");
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let body = "";
  let byteLength = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        body += decoder.decode();
        break;
      }
      byteLength += value.byteLength;
      if (byteLength > MAX_CATALOG_BYTES) {
        await reader.cancel().catch(() => {});
        throw new Error("Prime Inference model catalog response is too large.");
      }
      body += decoder.decode(value, { stream: true });
    }
  } catch (error) {
    if (
      error instanceof Error &&
      error.message === "Prime Inference model catalog response is too large."
    )
      throw error;
    throw new Error("Prime Inference returned an invalid model catalog.");
  }
  try {
    return JSON.parse(body);
  } catch {
    throw new Error("Prime Inference returned an invalid model catalog.");
  }
}

function validateStaticContract(): void {
  const provider = PROVIDER_MODEL_MANIFEST.providers.find(
    (entry) =>
      entry.source === "prime" && entry.providerId === "prime-inference",
  );
  const api = PROVIDER_MODEL_MANIFEST.apiTransports.find(
    (entry) => entry.source === "prime" && entry.apiId === "openai-completions",
  );
  if (
    !provider ||
    !api ||
    api.status !== "implemented" ||
    provider.status !== "in-scope" ||
    provider.models.length === 0 ||
    provider.models.some(
      (model) =>
        model.transport !== "openai-completions" ||
        model.endpoint !== PRIME_ENDPOINT,
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
    throw new Error(
      "Prime Inference requires an explicitly configured API key.",
    );
}

function sanitizeCatalogName(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const name = value.replace(/[\u0000-\u001f\u007f-\u009f]/g, "").trim();
  return name || undefined;
}

function isValidPrimeModelId(id: string): boolean {
  let characterCount = 0;
  for (let offset = 0; offset < id.length;) {
    const codePoint = id.codePointAt(offset)!;
    if (
      codePoint <= 0x1f ||
      (codePoint >= 0x7f && codePoint <= 0x9f) ||
      ++characterCount > 1_024
    )
      return false;
    offset += codePoint > 0xffff ? 2 : 1;
  }
  return true;
}

// Prime's text adapter cannot represent evaluation or non-text-only outputs.
function isUnsupportedPrimeChatOutput(specs: unknown): boolean {
  if (
    typeof specs !== "object" ||
    specs === null ||
    !("modalities" in specs) ||
    typeof specs.modalities !== "object" ||
    specs.modalities === null ||
    !("output" in specs.modalities) ||
    !Array.isArray(specs.modalities.output)
  )
    return false;
  const output = specs.modalities.output;
  return (
    output.includes("decisions") ||
    (output.length > 0 &&
      output.every((modality) => typeof modality === "string") &&
      !output.includes("text"))
  );
}

function primeModelMetadata(
  specs: unknown,
  supportsTools: boolean,
): Pick<Model, "contextWindow" | "maxTokens" | "capabilities"> | undefined {
  const fallback = supportsTools ? { capabilities: ["tools"] } : undefined;
  if (typeof specs !== "object" || specs === null) return fallback;
  if (
    !("context_window" in specs) ||
    typeof specs.context_window !== "number" ||
    !Number.isSafeInteger(specs.context_window) ||
    specs.context_window <= 0 ||
    !("max_output_tokens" in specs) ||
    typeof specs.max_output_tokens !== "number" ||
    !Number.isSafeInteger(specs.max_output_tokens) ||
    specs.max_output_tokens <= 0 ||
    !("supports_reasoning" in specs) ||
    typeof specs.supports_reasoning !== "boolean" ||
    !("modalities" in specs) ||
    typeof specs.modalities !== "object" ||
    specs.modalities === null ||
    !("input" in specs.modalities) ||
    !Array.isArray(specs.modalities.input) ||
    specs.modalities.input.length === 0 ||
    !specs.modalities.input.every((modality) => typeof modality === "string") ||
    !("output" in specs.modalities) ||
    !Array.isArray(specs.modalities.output) ||
    specs.modalities.output.length === 0 ||
    !specs.modalities.output.every((modality) => typeof modality === "string")
  )
    return fallback;

  const capabilities = ["text"];
  if (specs.modalities.input.includes("image")) capabilities.push("image");
  if (specs.supports_reasoning) capabilities.push("reasoning");
  if (supportsTools) capabilities.push("tools");
  return {
    contextWindow: specs.context_window,
    maxTokens: Math.min(specs.max_output_tokens, specs.context_window),
    capabilities,
  };
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
    const catalog = await readCatalogResponse(response);
    if (
      typeof catalog !== "object" ||
      catalog === null ||
      !("data" in catalog) ||
      !Array.isArray(catalog.data)
    )
      throw new Error("Prime Inference returned an invalid model catalog.");
    const availableModels = new Set<string>();
    const seenModels = new Set<string>();
    const models: Model[] = [];
    for (const entry of catalog.data) {
      if (
        typeof entry !== "object" ||
        entry === null ||
        !("id" in entry) ||
        typeof entry.id !== "string" ||
        !entry.id.trim() ||
        !isValidPrimeModelId(entry.id) ||
        seenModels.has(entry.id)
      )
        throw new Error("Prime Inference returned an invalid model catalog.");
      seenModels.add(entry.id);
      let reportsParameters = false;
      let supportsTools = false;
      if (
        "supported_parameters" in entry &&
        Array.isArray(entry.supported_parameters)
      ) {
        for (const parameter of entry.supported_parameters) {
          if (typeof parameter === "string" && parameter.length > 0) {
            reportsParameters = true;
            if (parameter === "tools") supportsTools = true;
          }
        }
      }
      if (reportsParameters && !supportsTools) continue;
      const specs = "specs" in entry ? entry.specs : undefined;
      if (isUnsupportedPrimeChatOutput(specs)) continue;
      availableModels.add(entry.id);
      const name =
        sanitizeCatalogName(
          "display_name" in entry ? entry.display_name : undefined,
        ) ??
        sanitizeCatalogName("name" in entry ? entry.name : undefined) ??
        entry.id;
      const metadata = primeModelMetadata(specs, supportsTools);
      models.push({ id: entry.id, name, ...metadata });
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
      throw new Error(
        "Requested model is not present in the Prime Inference model catalog.",
      );
    return this.provider.complete(model, messages, tools, signal, onDelta);
  }

  redact(text: string): string {
    return this.provider.redact(text);
  }
}

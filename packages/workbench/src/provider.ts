import { randomUUID } from "node:crypto";
import type {
  ProviderAdapterConfig,
  ProviderClient,
} from "./provider-adapters/types.ts";
import { OpenAICompletionsAdapter } from "./provider-adapters/openai-completions.ts";
import { AnthropicMessagesAdapter } from "./provider-adapters/anthropic-messages.ts";
import { isRecord } from "./provider-adapters/guards.ts";
import {
  defaultHarnessSettings,
  type HarnessSettings,
} from "./harness-settings.ts";
export class ProviderRequestError extends Error {
  readonly status: number;
  readonly code: string | undefined;
  readonly retryAfter: number | undefined;
  constructor(status: number, code?: string, retryAfter?: number) {
    super(
      code === "email_verification_required"
        ? "Token Harbor requires email verification. Open your confirmation email or request a new one at https://tokenharbor.ai/dashboard, then reconnect."
        : code === "customer_verification_required"
          ? "Vercel AI Gateway requires account verification. Add a card in Vercel AI Gateway settings or connect your own provider key."
          : status === 503
            ? `Provider service unavailable (HTTP 503).${retryAfter === undefined ? " Try again later." : ` Retry after ${retryAfter}s.`}`
            : `Provider request failed (HTTP ${status}). Check credentials, model access or rate limits.`,
    );
    this.status = status;
    this.code = code;
    this.retryAfter = retryAfter;
  }
}

export function parseRetryAfter(
  value: string | null,
  now = Date.now(),
): number | undefined {
  const header = value?.trim();
  if (!header) return undefined;
  if (/^\d+$/.test(header)) {
    const seconds = Number(header);
    return Number.isSafeInteger(seconds) ? seconds : undefined;
  }
  if (/^[+-]?\d/.test(header)) return undefined;
  const timestamp = Date.parse(header);
  if (!Number.isFinite(timestamp)) return undefined;
  const seconds = Math.max(0, Math.ceil((timestamp - now) / 1000));
  return Number.isSafeInteger(seconds) ? seconds : undefined;
}

/**
 * OpenRouter's Chat Completions usage frame repeats the terminal finish reason
 * with an empty assistant delta. Treat that accounting frame as metadata, but
 * keep rejecting any new content or tool data after completion.
 */
function isRepeatedUsageAccountingFrame(
  value: unknown,
  finishReason: string | undefined,
): boolean {
  if (!finishReason || !isRecord(value) || !isRecord(value.usage)) return false;
  const choices = value.choices;
  if (!Array.isArray(choices) || choices.length !== 1) return false;
  const choice = choices[0];
  if (
    !isRecord(choice) ||
    (choice.index !== undefined && choice.index !== 0) ||
    choice.finish_reason !== finishReason ||
    (choice.native_finish_reason !== undefined &&
      typeof choice.native_finish_reason !== "string")
  )
    return false;
  const delta = choice.delta;
  if (!isRecord(delta)) return false;
  if (
    (delta.role !== undefined && delta.role !== "assistant") ||
    (delta.content !== undefined &&
      delta.content !== "" &&
      delta.content !== null) ||
    Object.keys(delta).some((key) => key !== "role" && key !== "content") ||
    (choice.function_call !== undefined && choice.function_call !== null) ||
    choice.tool_calls !== undefined ||
    choice.refusal !== undefined
  )
    return false;
  return true;
}

export type ProviderKind = "compatible" | "anthropic";
export type ProviderConfig = {
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly kind?: ProviderKind;
  readonly providerId?: string;
  readonly api?: string;
  /** A model to use when the provider cannot list one.
   *
   * Some OpenAI-compatible endpoints serve chat completions and answer the
   * model catalog with 404, Puter's does exactly that. An operator who names
   * the model has already made the choice a catalog would have offered, so the
   * name stands in for the list rather than the configuration being refused. */
  readonly model?: string;
};
export function normalizeProviderConfig(config: {
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly kind?: string;
  readonly providerId?: string;
  readonly api?: string;
  readonly model?: string;
}): ProviderConfig {
  return {
    baseUrl: config.baseUrl,
    apiKey: config.apiKey,
    kind: config.kind === "anthropic" ? "anthropic" : "compatible",
    ...(config.providerId ? { providerId: config.providerId } : {}),
    ...(config.api ? { api: config.api } : {}),
    ...(config.model ? { model: config.model } : {}),
  };
}

function hasOpenRouterCatalogMetadata(config: ProviderConfig): boolean {
  if (config.providerId === "openrouter") return true;
  try {
    const endpoint = new URL(config.baseUrl);
    return (
      endpoint.protocol === "https:" &&
      endpoint.hostname === "openrouter.ai" &&
      endpoint.port === "" &&
      endpoint.username === "" &&
      endpoint.password === "" &&
      endpoint.pathname.replace(/\/$/, "") === "/api/v1" &&
      endpoint.search === "" &&
      endpoint.hash === ""
    );
  } catch {
    return false;
  }
}
/**
 * Resolve the model catalog for a configured provider.
 *
 * Some OpenAI-compatible endpoints answer `/models` with a real catalog; others
 * answer 404, because they only route named models to completions, and some
 * answer 200 with an empty list. All three must produce a usable list when the
 * operator named a model, or `configure` refuses a provider that works: an
 * operator who typed a model has already made the choice a catalog would have
 * offered, so the name stands in for the list.
 *
 * Only a 404 and an empty catalog fall back. Every other probe failure, a
 * refused connection, a rejected credential, a server error, a body that is
 * not a JSON object with a `data` array, is a real failure and surfaces as
 * itself. Swallowing those would report a provider as configured while its
 * endpoint is unreachable, which is the kind of honest-error boundary this
 * package keeps.
 *
 * A 200 whose entries all fail the shape filter arrives here as the same `[]`
 * as an endpoint that lists only embedding models, because the filter in
 * `models()` runs before the length check. The fallback then serves the name
 * the operator typed, and a name the endpoint cannot serve fails on first
 * use. Distinguishing the two would need a guess about the provider's
 * intentions while changing nothing an operator can act on, so it stays.
 */
export async function catalogFor(
  provider: ProviderClient,
  config: ProviderConfig | ProviderAdapterConfig,
): Promise<readonly Model[]> {
  try {
    const models = await provider.models();
    if (models.length) return models;
  } catch (error) {
    // A 404 is the provider saying it has no catalog route: a shape, not a
    // rejection. Anything else is the provider failing and must surface.
    if (!(error instanceof ProviderRequestError && error.status === 404))
      throw error;
  }
  return config.model ? [{ id: config.model, name: config.model }] : [];
}
export type Model = {
  readonly id: string;
  readonly name: string;
  readonly contextWindow?: number;
  readonly inputPrice?: string;
  readonly outputPrice?: string;
  readonly capabilities?: readonly string[];
  readonly maxTokens?: number;
};
export type ImageMimeType = "image/jpeg" | "image/png" | "image/webp";
export type ModelImageInput = {
  readonly mimeType: ImageMimeType;
  /** Canonical standard-base64 image bytes; persisted inside encrypted workspace state. */
  readonly data: string;
};
export type ModelImage = ModelImageInput & { readonly id: string };

export type ModelMessage = {
  readonly role: "system" | "user" | "assistant" | "tool";
  readonly content: string | null;
  /** Images are accepted on user messages only and are not copied into events. */
  readonly images?: readonly ModelImage[];
  readonly tool_calls?: readonly ToolCall[];
  readonly tool_call_id?: string;
};
export type ToolCall = {
  readonly id: string;
  readonly type: "function";
  readonly function: { readonly name: string; readonly arguments: string };
};
export type ModelReply = {
  readonly message: ModelMessage;
  readonly response_id?: string;
  readonly usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
    /** What the provider says the call cost, when it reports it. Absent on
     * most endpoints, so a cost metric is unmeasured rather than zero. */
    cost_usd?: number;
  };
};

export class CompatibleProvider implements ProviderClient {
  private readonly base: URL;
  private readonly config: ProviderConfig;
  private readonly request: typeof fetch;
  /** The operator-settled limits this provider honours. Read through a resolver
   * rather than snapshotted: a provider outlives many `patchHarnessSettings`
   * calls, and an operator who lowers `maxOutputTokens` expects the next
   * request to honour it, not the one that happened to be in flight when they
   * patched. A partial merges over the defaults so a caller with no resolved
   * settings still gets NOMO's conservative ones. */
  private readonly resolveSettings: () => HarnessSettings;
  private readonly completions: OpenAICompletionsAdapter;
  private readonly anthropic: AnthropicMessagesAdapter;
  constructor(
    config: ProviderConfig,
    request: typeof fetch = fetch,
    settings: Partial<HarnessSettings> | (() => HarnessSettings) = {},
  ) {
    this.config = normalizeProviderConfig(config);
    this.request = request;
    this.resolveSettings =
      typeof settings === "function"
        ? settings
        : () => ({ ...defaultHarnessSettings(), ...settings });
    this.base = new URL(
      this.config.baseUrl.endsWith("/")
        ? this.config.baseUrl
        : `${this.config.baseUrl}/`,
    );
    const hostname = this.base.hostname.replace(/\.+$/, "").toLowerCase();
    if (hostname === "openai.com" || hostname.endsWith(".openai.com"))
      throw new Error("Direct OpenAI provider URLs are not supported.");
    if (
      this.base.protocol !== "https:" &&
      !(
        this.base.protocol === "http:" &&
        ["127.0.0.1", "localhost", "[::1]"].includes(this.base.hostname)
      )
    )
      throw new Error(
        "Providers require HTTPS, or loopback HTTP for a local model.",
      );
    if (
      this.base.username ||
      this.base.password ||
      this.base.search ||
      this.base.hash
    )
      throw new Error(
        "Provider URL cannot contain credentials or query parameters.",
      );
    this.completions = new OpenAICompletionsAdapter({
      origin: this.base.origin,
      primeInferenceUsage: this.config.providerId === "prime-inference",
      resolveSettings: this.resolveSettings,
      response: (path, body, signal) => this.response(path, body, signal),
      decode: (response, signal) => this.decode(response, signal),
      streamReply: (response, signal, onDelta, onReasoning) =>
        this.streamReply(response, signal, onDelta, onReasoning),
    });
    this.anthropic = new AnthropicMessagesAdapter({
      send: (body, signal) => this.json("messages", body, signal),
      stream: (body, signal) =>
        this.response("messages", body, signal, "text/event-stream"),
      redact: (text) => this.redact(text),
      apiKey: this.config.apiKey,
      resolveSettings: this.resolveSettings,
    });
  }
  async models(): Promise<readonly Model[]> {
    const anthropicModelsEndpoint =
      this.config.kind === "anthropic" &&
      this.base.origin === "https://api.anthropic.com" &&
      this.base.pathname === "/v1/";
    const catalog: unknown[] = [];
    const cursors = new Set<string>();
    let afterId: string | undefined;
    for (;;) {
      let path = "models";
      if (anthropicModelsEndpoint) {
        const query = new URLSearchParams({ limit: "1000" });
        if (afterId) query.set("after_id", afterId);
        path += `?${query}`;
      }
      const body = await this.json(path);
      if (!Array.isArray(body.data))
        throw new Error("Provider returned an invalid model catalog.");
      if (!anthropicModelsEndpoint) return this.modelsFrom(body.data);
      for (const model of body.data) catalog.push(model);
      if (typeof body.has_more !== "boolean")
        throw new Error("Provider returned an invalid model catalog.");
      if (!body.has_more) break;
      const lastId = body.last_id;
      if (typeof lastId !== "string" || !lastId.trim() || cursors.has(lastId))
        throw new Error("Provider returned an invalid model catalog.");
      cursors.add(lastId);
      afterId = lastId;
    }
    return this.modelsFrom(catalog);
  }
  private modelsFrom(data: readonly unknown[]): readonly Model[] {
    const openRouterCatalog = hasOpenRouterCatalogMetadata(this.config);
    return data
      .filter(
        (
          model: unknown,
        ): model is {
          id: string;
          name?: string;
          display_name?: string;
          context_length?: unknown;
          contextWindow?: unknown;
          maxTokens?: unknown;
          capabilities?: unknown;
          inputPrice?: unknown;
          outputPrice?: unknown;
          top_provider?: { context_length?: unknown };
        } =>
          typeof model === "object" &&
          model !== null &&
          "id" in model &&
          typeof model.id === "string" &&
          model.id.trim().length > 0 &&
          (!("type" in model) ||
            model.type === "language" ||
            (this.config.kind === "anthropic" && model.type === "model")),
      )
      .map((model) => {
        const reportedContextWindow =
          model.context_length ?? model.top_provider?.context_length;
        const contextWindow =
          openRouterCatalog &&
          typeof reportedContextWindow === "number" &&
          Number.isSafeInteger(reportedContextWindow) &&
          reportedContextWindow > 0
            ? reportedContextWindow
            : undefined;
        const directContextWindow =
          typeof model.contextWindow === "number" &&
          Number.isSafeInteger(model.contextWindow) &&
          model.contextWindow > 0
            ? model.contextWindow
            : undefined;
        const maxTokens =
          typeof model.maxTokens === "number" &&
          Number.isSafeInteger(model.maxTokens) &&
          model.maxTokens > 0
            ? model.maxTokens
            : undefined;
        const capabilities = Array.isArray(model.capabilities)
          ? model.capabilities.filter(
              (capability): capability is string =>
                typeof capability === "string" && capability.trim().length > 0,
            )
          : [];
        const inputPrice =
          typeof model.inputPrice === "string" && model.inputPrice.trim()
            ? model.inputPrice
            : undefined;
        const outputPrice =
          typeof model.outputPrice === "string" && model.outputPrice.trim()
            ? model.outputPrice
            : undefined;
        return {
          id: model.id,
          name:
            model.display_name ??
            (typeof model.name === "string" ? model.name : model.id),
          ...(contextWindow === undefined && directContextWindow === undefined
            ? {}
            : { contextWindow: contextWindow ?? directContextWindow }),
          ...(maxTokens === undefined ? {} : { maxTokens }),
          ...(capabilities.length ? { capabilities } : {}),
          ...(inputPrice === undefined ? {} : { inputPrice }),
          ...(outputPrice === undefined ? {} : { outputPrice }),
        };
      });
  }
  async complete(
    model: string,
    messages: readonly ModelMessage[],
    tools: readonly unknown[],
    signal: AbortSignal,
    onDelta?: (text: string) => void | Promise<void>,
    onReasoning?: (text: string) => void | Promise<void>,
  ): Promise<ModelReply> {
    if (this.config.kind === "anthropic")
      return this.anthropic.complete(
        model,
        messages,
        tools,
        signal,
        onDelta,
        onReasoning,
      );
    return this.completions.complete(
      model,
      messages,
      tools,
      signal,
      onDelta,
      onReasoning,
    );
  }
  redact(text: string): string {
    return this.config.apiKey
      ? text.split(this.config.apiKey).join("[redacted]")
      : text;
  }
  private async streamReply(
    response: Response,
    signal: AbortSignal,
    onDelta?: (text: string) => void | Promise<void>,
    onReasoning?: (text: string) => void | Promise<void>,
  ): Promise<ModelReply> {
    if (!response.body) throw new Error("Provider returned an empty stream.");
    const reader = response.body.getReader(),
      decoder = new TextDecoder();
    let pending = "",
      content = "",
      terminal = false,
      finish = false;
    /**
     * One redacting emitter per channel. Answer text and reasoning each hold
     * back a trailing fragment that could be the start of the API key, so a
     * secret split across two deltas is redacted rather than printed in
     * halves. Separate buffers keep one channel's held fragment from leaking
     * into the other.
     */
    const createEmitter = (
      sink: ((text: string) => void | Promise<void>) | undefined,
    ) => {
      let emission = "";
      return async (text: string, flush = false) => {
        emission = this.redact(emission + text);
        let hold = 0;
        if (!flush)
          for (let i = 1; i < this.config.apiKey.length; i++)
            if (emission.endsWith(this.config.apiKey.slice(0, i))) hold = i;
        const visible = emission.slice(0, emission.length - hold);
        emission = hold ? emission.slice(-hold) : "";
        if (visible) await sink?.(visible);
      };
    };
    const emit = createEmitter(onDelta);
    const emitReasoning = createEmitter(onReasoning);
    const appendContent = async (text: string) => {
      content += text;
      if (content.length > 2_000_000)
        throw new Error("Provider response exceeded the supported size.");
      await emit(text);
    };
    let legacyFunctionCall = false;
    let finishReason: string | undefined;
    let usage: ModelReply["usage"];
    const calls = new Map<number, ToolCall>();
    const consume = async (frame: string) => {
      const raw = frame
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trimStart())
        .join("\n");
      if (!raw) return;
      if (terminal) throw new Error("Provider returned data after completion.");
      if (raw === "[DONE]") {
        terminal = true;
        return;
      }
      let chunk;
      try {
        chunk = JSON.parse(raw);
      } catch {
        throw new Error("Provider returned malformed stream data.");
      }
      if (chunk.error) throw new Error("Provider reported a streaming error.");
      // The streamed usage frame carries the same cost field the buffered one
      // does, and the harness always streams, so mapping it only in the
      // buffered path would leave the metric unmeasured where it matters.
      if (chunk.usage)
        usage = {
          ...chunk.usage,
          ...(Number.isFinite((chunk.usage as { cost?: unknown }).cost)
            ? { cost_usd: (chunk.usage as { cost: number }).cost }
            : {}),
        };
      const choice = chunk.choices?.find(
        (item: { index?: number }) => (item.index ?? 0) === 0,
      );
      if (!choice) return;
      if (finish) {
        if (isRepeatedUsageAccountingFrame(chunk, finishReason)) return;
        throw new Error("Provider returned data after completion.");
      }
      const chunkFinishReason = choice.finish_reason;
      if (
        chunkFinishReason === "length" ||
        chunkFinishReason === "content_filter"
      )
        throw new Error(
          chunkFinishReason === "content_filter"
            ? "Provider response was blocked by the content filter; no answer or tools were returned."
            : "Provider response was truncated. No tools were executed.",
        );
      if (chunkFinishReason !== undefined && chunkFinishReason !== null) {
        if (
          chunkFinishReason !== "stop" &&
          chunkFinishReason !== "tool_calls" &&
          chunkFinishReason !== "function_call"
        )
          throw new Error("Provider returned an invalid completion status.");
        finish = true;
        finishReason = chunkFinishReason;
      }
      const delta = choice.delta;
      if (!delta) return;
      // Provider-native reasoning rides the same delta object as the answer
      // but is a separate channel: it never enters `content`, never becomes a
      // tool call and never satisfies the no-answer check below. A delta
      // without a reasoning channel simply never calls `onReasoning`.
      if (typeof delta.reasoning_content === "string")
        await emitReasoning(delta.reasoning_content);
      if (typeof delta.reasoning === "string")
        await emitReasoning(delta.reasoning);
      if (typeof delta.content === "string") await appendContent(delta.content);
      if (typeof delta.refusal === "string") await appendContent(delta.refusal);
      const functionDelta = delta.function_call;
      if (functionDelta !== undefined && functionDelta !== null) {
        if (
          typeof functionDelta !== "object" ||
          Array.isArray(functionDelta) ||
          (functionDelta.name !== undefined &&
            typeof functionDelta.name !== "string") ||
          (functionDelta.arguments !== undefined &&
            typeof functionDelta.arguments !== "string") ||
          (calls.size > 0 && !legacyFunctionCall)
        )
          throw new Error("Provider returned invalid tool stream data.");
        const previous = calls.get(0);
        const args =
          (previous?.function.arguments ?? "") +
          (functionDelta.arguments ?? "");
        if (args.length > 1_000_000)
          throw new Error("Provider returned invalid tool stream data.");
        calls.set(0, {
          id: previous?.id ?? `call_${randomUUID()}`,
          type: "function",
          function: {
            name: (previous?.function.name ?? "") + (functionDelta.name ?? ""),
            arguments: args,
          },
        });
        legacyFunctionCall = true;
      }
      for (const part of delta.tool_calls ?? []) {
        if (legacyFunctionCall)
          throw new Error("Provider returned invalid tool stream data.");
        if (!Number.isInteger(part.index) || part.index < 0 || part.index > 31)
          throw new Error("Provider returned invalid tool stream index.");
        const previous = calls.get(part.index);
        const id = part.id ?? previous?.id ?? "";
        const name =
          (previous?.function.name ?? "") + (part.function?.name ?? "");
        const args =
          (previous?.function.arguments ?? "") +
          (part.function?.arguments ?? "");
        if (
          typeof id !== "string" ||
          typeof name !== "string" ||
          typeof args !== "string" ||
          args.length > 1_000_000
        )
          throw new Error("Provider returned invalid tool stream data.");
        calls.set(part.index, {
          id,
          type: "function",
          function: { name, arguments: args },
        });
      }
    };
    try {
      while (true) {
        signal.throwIfAborted();
        let value: Uint8Array | undefined;
        let done: boolean;
        try {
          const result = await reader.read();
          value = result.value;
          done = result.done;
        } catch (error) {
          if (error instanceof DOMException && error.name === "TimeoutError")
            throw new Error("Provider request timed out.");
          throw error;
        }
        pending += decoder.decode(value, { stream: !done });
        pending = pending.replace(/\r\n/g, "\n");
        if (pending.length > 2_000_000)
          throw new Error("Provider stream frame exceeded the supported size.");
        let boundary;
        while ((boundary = pending.indexOf("\n\n")) !== -1) {
          const frame = pending.slice(0, boundary);
          pending = pending.slice(boundary + 2);
          await consume(frame);
        }
        if (terminal || done) break;
      }
      if (pending.trim() && !terminal) await consume(pending);
      if (!terminal && !finish)
        throw new Error(
          "Provider stream ended before completion. Retry the response.",
        );
      if (legacyFunctionCall && finishReason !== "function_call")
        throw new Error("Provider returned an invalid completion status.");
      if (!finish)
        throw new Error("Provider stream ended without a finish reason.");
      const toolCalls = [...calls.entries()]
        .sort(([a], [b]) => a - b)
        .map(([, call]) => {
          if (!call.id || !call.function.name)
            throw new Error("Provider returned an incomplete tool call.");
          try {
            const args = JSON.parse(call.function.arguments);
            if (!args || typeof args !== "object" || Array.isArray(args))
              throw new Error();
          } catch {
            throw new Error("Provider returned invalid tool arguments.");
          }
          return call;
        });
      if (!content.trim() && !toolCalls.length)
        throw new Error("Provider returned no answer. Retry the response.");
      await emitReasoning("", true);
      await emit("", true);
      return {
        message: {
          role: "assistant",
          content: content || null,
          ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
        },
        usage,
      };
    } finally {
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
  }
  private async response(
    path: string,
    body?: unknown,
    signal?: AbortSignal,
    accept?: string,
  ) {
    let response: Response;
    try {
      response = await this.request(new URL(path, this.base), {
        method: body === undefined ? "GET" : "POST",
        headers: {
          ...(this.config.kind === "anthropic"
            ? {
                "x-api-key": this.config.apiKey,
                "anthropic-version": "2023-06-01",
              }
            : this.config.apiKey
              ? { authorization: `Bearer ${this.config.apiKey}` }
              : {}),
          "content-type": "application/json",
          ...(accept ? { accept } : {}),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        redirect: "error",
        signal: signal
          ? AbortSignal.any([signal, AbortSignal.timeout(60000)])
          : AbortSignal.timeout(15000),
      });
    } catch (error) {
      if (signal?.aborted) {
        if (
          signal.reason instanceof DOMException &&
          signal.reason.name === "TimeoutError"
        )
          throw new Error("Provider request timed out.");
        throw new Error("Session cancelled.");
      }
      if (error instanceof DOMException && error.name === "TimeoutError")
        throw new Error("Provider request timed out.");
      throw new Error(
        "Provider connection failed. Check its endpoint and availability.",
      );
    }
    if (!response.ok) {
      let code: string | undefined;
      if (response.status === 403) {
        try {
          const error = (await response.json()) as {
            error?: { type?: string };
          };
          if (
            error.error?.type === "customer_verification_required" ||
            (this.base.origin === "https://tokenharbor.ai" &&
              error.error?.type === "email_verification_required")
          )
            code = error.error.type;
        } catch {}
      }
      const retryAfter = parseRetryAfter(response.headers.get("retry-after"));
      await response.body?.cancel().catch(() => {});
      throw new ProviderRequestError(response.status, code, retryAfter);
    }
    return response;
  }
  private async json(path: string, body?: unknown, signal?: AbortSignal) {
    return this.decode(await this.response(path, body, signal), signal);
  }
  private async decode(response: Response, signal?: AbortSignal) {
    // Provider JSON is untrusted. Runtime validation below narrows the fields
    // consumed by the workbench without exposing provider error payloads.
    try {
      return (await response.json()) as {
        data?: unknown;
        has_more?: unknown;
        last_id?: unknown;
        choices?: Array<{ message?: ModelMessage; finish_reason?: string }>;
        usage?: ModelReply["usage"];
      };
    } catch (error) {
      if (signal?.aborted) {
        if (
          signal.reason instanceof DOMException &&
          signal.reason.name === "TimeoutError"
        )
          throw new Error("Provider request timed out.");
        throw new Error("Session cancelled.");
      }
      if (error instanceof DOMException && error.name === "TimeoutError")
        throw new Error("Provider request timed out.");
      throw new Error("Provider returned invalid JSON.");
    }
  }
}

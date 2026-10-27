import { randomUUID } from "node:crypto";
import type {
  ProviderAdapterConfig,
  ProviderClient,
} from "./provider-adapters/types.ts";
import { OpenAICompletionsAdapter } from "./provider-adapters/openai-completions.ts";
import { AnthropicMessagesAdapter } from "./provider-adapters/anthropic-messages.ts";
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
          : `Provider request failed (HTTP ${status}). Check credentials, model access or rate limits.`,
    );
    this.status = status;
    this.code = code;
    this.retryAfter = retryAfter;
  }
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
  return config.model
    ? [{ id: config.model, name: config.model }]
    : [];
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
      streamReply: (response, signal, onDelta) => this.streamReply(response, signal, onDelta),
    });
    this.anthropic = new AnthropicMessagesAdapter({
      send: (body, signal) => this.json("messages", body, signal),
      stream: (body, signal) => this.response("messages", body, signal, "text/event-stream"),
      redact: text => this.redact(text),
      apiKey: this.config.apiKey,
      resolveSettings: this.resolveSettings,
    });
  }
  async models(): Promise<readonly Model[]> {
    const body = await this.json("models");
    if (!Array.isArray(body.data))
      throw new Error("Provider returned an invalid model catalog.");
    return body.data
      .filter(
        (
          model: unknown,
        ): model is { id: string; name?: string; display_name?: string } =>
          typeof model === "object" &&
          model !== null &&
          "id" in model &&
          typeof model.id === "string" &&
          (!("type" in model) ||
            model.type === "language" ||
            (this.config.kind === "anthropic" && model.type === "model")),
      )
      .map((model: { id: string; name?: string; display_name?: string }) => ({
        id: model.id,
        name:
          model.display_name ??
          (typeof model.name === "string" ? model.name : model.id),
      }));
  }
  async complete(
    model: string,
    messages: readonly ModelMessage[],
    tools: readonly unknown[],
    signal: AbortSignal,
    onDelta?: (text: string) => void | Promise<void>,
  ): Promise<ModelReply> {
    if (this.config.kind === "anthropic")
      return this.anthropic.complete(model, messages, tools, signal, onDelta);
    return this.completions.complete(model, messages, tools, signal, onDelta);
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
  ): Promise<ModelReply> {
    if (!response.body) throw new Error("Provider returned an empty stream.");
    const reader = response.body.getReader(),
      decoder = new TextDecoder();
    let pending = "",
      content = "",
      terminal = false,
      finish = false,
      emission = "";
    const emit = async (text: string, flush = false) => {
      emission = this.redact(emission + text);
      let hold = 0;
      if (!flush)
        for (let i = 1; i < this.config.apiKey.length; i++)
          if (emission.endsWith(this.config.apiKey.slice(0, i))) hold = i;
      const visible = emission.slice(0, emission.length - hold);
      emission = hold ? emission.slice(-hold) : "";
      if (visible) await onDelta?.(visible);
    };
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
      if (chunk.usage) usage = chunk.usage;
      const choice = chunk.choices?.find(
        (item: { index?: number }) => (item.index ?? 0) === 0,
      );
      if (!choice) return;
      if (finish) throw new Error("Provider returned data after completion.");
      const chunkFinishReason = choice.finish_reason;
      if (chunkFinishReason === "length" || chunkFinishReason === "content_filter")
        throw new Error(
          "Provider response was truncated. No tools were executed.",
        );
      if (chunkFinishReason !== undefined && chunkFinishReason !== null) {
        if (
          chunkFinishReason !== "stop" &&
          chunkFinishReason !== "tool_calls" &&
          chunkFinishReason !== "function_call"
        ) throw new Error("Provider returned an invalid completion status.");
        finish = true;
        finishReason = chunkFinishReason;
      }
      const delta = choice.delta;
      if (!delta) return;
      if (typeof delta.content === "string") await appendContent(delta.content);
      if (typeof delta.refusal === "string") await appendContent(delta.refusal);
      const functionDelta = delta.function_call;
      if (functionDelta !== undefined && functionDelta !== null) {
        if (
          typeof functionDelta !== "object" ||
          Array.isArray(functionDelta) ||
          (functionDelta.name !== undefined && typeof functionDelta.name !== "string") ||
          (functionDelta.arguments !== undefined && typeof functionDelta.arguments !== "string") ||
          (calls.size > 0 && !legacyFunctionCall)
        ) throw new Error("Provider returned invalid tool stream data.");
        const previous = calls.get(0);
        const args = (previous?.function.arguments ?? "") + (functionDelta.arguments ?? "");
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
        if (legacyFunctionCall) throw new Error("Provider returned invalid tool stream data.");
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
        const { value, done } = await reader.read();
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
  private async response(path: string, body?: unknown, signal?: AbortSignal, accept?: string) {
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
    } catch {
      throw new Error(
        signal?.aborted
          ? "Session cancelled."
          : "Provider connection failed. Check its endpoint and availability.",
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
      const rawRetry = response.headers.get("retry-after");
      const retryAfter = rawRetry
        ? /^\d+$/.test(rawRetry)
          ? Number(rawRetry)
          : Math.max(0, Math.ceil((Date.parse(rawRetry) - Date.now()) / 1000))
        : undefined;
      await response.body?.cancel().catch(() => {});
      throw new ProviderRequestError(
        response.status,
        code,
        Number.isFinite(retryAfter) ? retryAfter : undefined,
      );
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
        choices?: Array<{ message?: ModelMessage; finish_reason?: string }>;
        usage?: ModelReply["usage"];
      };
    } catch {
      if (signal?.aborted) throw new Error("Session cancelled.");
      throw new Error("Provider returned invalid JSON.");
    }
  }
}

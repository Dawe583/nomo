import { setTimeout as delay } from "node:timers/promises";
import { FREE_MODEL_BY_ORIGIN } from "../provider-defaults.ts";
import { ProviderRequestError, type ModelMessage, type ModelReply, type ToolCall } from "../provider.ts";
import type { HarnessSettings } from "../harness-settings.ts";

export type OpenAICompletionsDependencies = {
  readonly origin: string;
  readonly primeInferenceUsage?: boolean;
  readonly resolveSettings: () => HarnessSettings;
  readonly response: (path: string, body?: unknown, signal?: AbortSignal) => Promise<Response>;
  readonly decode: (response: Response) => Promise<{
    choices?: Array<{ message?: ModelMessage; finish_reason?: string }>;
    usage?: ModelReply["usage"];
  }>;
  readonly streamReply: (
    response: Response,
    signal: AbortSignal,
    onDelta?: (text: string) => void | Promise<void>,
  ) => Promise<ModelReply>;
};

export class OpenAICompletionsAdapter {
  private readonly dependencies: OpenAICompletionsDependencies;

  constructor(dependencies: OpenAICompletionsDependencies) {
    this.dependencies = dependencies;
  }

  async complete(
    model: string,
    messages: readonly ModelMessage[],
    tools: readonly unknown[],
    signal: AbortSignal,
    onDelta?: (text: string) => void | Promise<void>,
  ): Promise<ModelReply> {
    const settings = this.dependencies.resolveSettings();
    const body = {
      model,
      messages,
      ...(tools.length ? { tools } : {}),
      max_tokens: settings.maxOutputTokens,
      stream: !!onDelta,
      ...(this.dependencies.primeInferenceUsage
        ? { usage: { include: true } }
        : onDelta
          ? { stream_options: { include_usage: true } }
          : {}),
    };
    let response: Response;
    for (let attempt = 0; ; attempt++) {
      try {
        response = await this.dependencies.response("chat/completions", body, signal);
        break;
      } catch (error) {
        if (
          FREE_MODEL_BY_ORIGIN[this.dependencies.origin] !== model ||
          attempt >= settings.retryAttempts - 1 ||
          signal.aborted ||
          !(error instanceof ProviderRequestError) ||
          ![429, 502, 503, 504].includes(error.status) ||
          (error.retryAfter ?? 0) > 5
        ) throw error;
        await delay(
          Math.min(
            (error.retryAfter ?? attempt + 1) * settings.retryBaseDelayMs,
            settings.retryMaxDelayMs,
          ),
          undefined,
          { signal },
        );
      }
    }
    if (response.headers.get("content-type")?.includes("text/event-stream")) {
      return this.dependencies.streamReply(response, signal, onDelta);
    }
    const decoded = await this.dependencies.decode(response);
    const choice = decoded.choices?.[0];
    if (choice?.finish_reason === "length" || choice?.finish_reason === "content_filter") {
      throw new Error("Provider response was truncated. No tools were executed.");
    }
    const message = choice?.message;
    if (
      message?.role !== "assistant" ||
      (message.content !== null && typeof message.content !== "string" && message.content !== undefined)
    ) throw new Error("Provider returned an invalid response.");
    if (
      message.tool_calls !== undefined &&
      (!Array.isArray(message.tool_calls) || !message.tool_calls.every((call: ToolCall) =>
        typeof call.id === "string" &&
        call.type === "function" &&
        typeof call.function?.name === "string" &&
        typeof call.function?.arguments === "string"))
    ) throw new Error("Provider returned invalid tool calls.");
    if (!message.content?.trim() && !message.tool_calls?.length) {
      throw new Error("Provider returned no answer. Retry the response.");
    }
    return {
      message: {
        role: "assistant",
        content: message.content ?? null,
        ...(message.tool_calls ? { tool_calls: message.tool_calls } : {}),
      },
      usage: decoded.usage,
    };
  }
}

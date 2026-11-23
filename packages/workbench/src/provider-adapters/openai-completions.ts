import { setTimeout as delay } from "node:timers/promises";
import { randomUUID } from "node:crypto";
import { FREE_MODEL_BY_ORIGIN } from "../provider-defaults.ts";
import { ProviderRequestError, type ModelMessage, type ModelReply, type ToolCall } from "../provider.ts";
import type { HarnessSettings } from "../harness-settings.ts";

type OpenAICompletionMessage = {
  readonly role?: string;
  readonly content?: string | null | readonly {
    readonly type?: string;
    readonly text?: string;
    readonly refusal?: string;
  }[];
  readonly refusal?: string | null;
  readonly tool_calls?: readonly ToolCall[];
  readonly function_call?: { readonly name?: string; readonly arguments?: string } | null;
};

export type OpenAICompletionsDependencies = {
  readonly origin: string;
  readonly primeInferenceUsage?: boolean;
  readonly resolveSettings: () => HarnessSettings;
  readonly response: (path: string, body?: unknown, signal?: AbortSignal) => Promise<Response>;
  readonly decode: (response: Response, signal: AbortSignal) => Promise<{
    choices?: Array<{ message?: OpenAICompletionMessage; finish_reason?: string }>;
    usage?: ModelReply["usage"];
  }>;
  readonly streamReply: (
    response: Response,
    signal: AbortSignal,
    onDelta?: (text: string) => void | Promise<void>,
    onReasoning?: (text: string) => void | Promise<void>,
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
    onReasoning?: (text: string) => void | Promise<void>,
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
      // The stream reader is injected: it owns frame parsing, so it is also
      // where `choices[].delta.reasoning_content` / `reasoning` is separated
      // from answer text. A reader without that channel simply never calls
      // `onReasoning`, and the caller sees no reasoning rather than invented
      // reasoning.
      return this.dependencies.streamReply(response, signal, onDelta, onReasoning);
    }
    const decoded = await this.dependencies.decode(response, signal);
    const choice = decoded.choices?.[0];
    if (choice?.finish_reason === "length") {
      throw new Error("Provider response was truncated. No tools were executed.");
    }
    if (choice?.finish_reason === "content_filter") {
      throw new Error("Provider response was blocked by the content filter; no answer or tools were returned.");
    }
    if (
      choice?.finish_reason !== "stop" &&
      choice?.finish_reason !== "tool_calls" &&
      choice?.finish_reason !== "function_call"
    ) throw new Error("Provider returned an invalid completion status.");
    const message = choice?.message;
    if (
      message?.role !== "assistant" ||
      (message.content !== null && typeof message.content !== "string" &&
        !Array.isArray(message.content) && message.content !== undefined)
    ) throw new Error("Provider returned an invalid response.");
    if (
      message.refusal !== undefined &&
      message.refusal !== null &&
      typeof message.refusal !== "string"
    ) throw new Error("Provider returned an invalid response.");
    let content = typeof message.content === "string" ? message.content : null;
    if (Array.isArray(message.content)) {
      const parts: string[] = [];
      for (const part of message.content) {
        if (!part || typeof part !== "object") throw new Error("Provider returned an invalid response.");
        if (part.type === "text" && typeof part.text === "string") parts.push(part.text);
        else if (part.type === "refusal" && typeof part.refusal === "string") parts.push(part.refusal);
        else throw new Error("Provider returned an invalid response.");
      }
      content = parts.join("");
    }
    if (!content?.trim() && message.refusal?.trim()) content = message.refusal;
    if (
      message.tool_calls !== undefined &&
      (!Array.isArray(message.tool_calls) || !message.tool_calls.every((call: ToolCall) =>
        typeof call.id === "string" &&
        call.type === "function" &&
        typeof call.function?.name === "string" &&
        typeof call.function?.arguments === "string"))
    ) throw new Error("Provider returned invalid tool calls.");
    let toolCalls = message.tool_calls;
    if (message.function_call !== undefined && message.function_call !== null) {
      if (
        choice?.finish_reason !== "function_call" ||
        typeof message.function_call.name !== "string" ||
        typeof message.function_call.arguments !== "string" ||
        toolCalls?.length
      ) throw new Error("Provider returned invalid tool calls.");
      toolCalls = [{
        id: `call_${randomUUID()}`,
        type: "function",
        function: {
          name: message.function_call.name,
          arguments: message.function_call.arguments,
        },
      }];
    }
    if (!content?.trim() && !toolCalls?.length) {
      throw new Error("Provider returned no answer. Retry the response.");
    }
    return {
      message: {
        role: "assistant",
        content,
        ...(toolCalls ? { tool_calls: toolCalls } : {}),
      },
      usage: decoded.usage,
    };
  }
}

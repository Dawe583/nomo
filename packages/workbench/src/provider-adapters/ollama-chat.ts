import type { Model, ModelMessage, ModelReply, ToolCall } from "../provider.ts";
import { ProviderRequestError } from "../provider.ts";
import { defaultHarnessSettings, type HarnessSettings } from "../harness-settings.ts";
import type { ProviderAdapterConfig, ProviderClient } from "./types.ts";
import { isLoopbackHostname, isRecord } from "./guards.ts";

type StreamTool = { function?: { name?: unknown; arguments?: unknown } };
const MAX_STREAM_CHARS = 2_000_000;
const MAX_TOOL_ARGUMENT_CHARS = 1_000_000;

export class OllamaChatAdapter implements ProviderClient {
  private readonly base: URL;
  private readonly request: typeof fetch;
  private readonly resolveSettings: () => HarnessSettings;

  constructor(config: ProviderAdapterConfig, request: typeof fetch = fetch, settings: Partial<HarnessSettings> | (() => HarnessSettings) = {}) {
    if (config.providerId !== "ollama" || config.transport !== "ollama-chat" || config.auth.kind !== "none") {
      throw new Error("Ollama Chat requires an explicit no-auth provider descriptor.");
    }
    let base: URL;
    try { base = new URL(config.baseUrl); }
    catch { throw new Error("Ollama Chat requires a loopback HTTP endpoint."); }
    if (base.protocol !== "http:" || !isLoopbackHostname(base.hostname) || base.username || base.password || base.search || base.hash || base.pathname !== "/") {
      throw new Error("Ollama Chat requires a loopback HTTP endpoint.");
    }
    this.base = base;
    this.request = request;
    this.resolveSettings = typeof settings === "function" ? settings : () => ({ ...defaultHarnessSettings(), ...settings });
  }

  async models(): Promise<readonly Model[]> {
    const body = await this.json("tags");
    if (!Array.isArray(body.models)) throw new Error("Ollama returned an invalid model catalog.");
    const seen = new Set<string>();
    return body.models.flatMap((item: unknown) => {
      if (!isRecord(item)) return [];
      const id = typeof item.name === "string" && item.name ? item.name : typeof item.model === "string" && item.model ? item.model : "";
      if (!id || seen.has(id)) return [];
      seen.add(id);
      return [{ id, name: id }];
    });
  }

  async complete(model: string, messages: readonly ModelMessage[], tools: readonly unknown[], signal: AbortSignal, onDelta?: (text: string) => void | Promise<void>): Promise<ModelReply> {
    const body = {
      model,
      messages: toOllamaMessages(messages),
      ...(tools.length ? { tools } : {}),
      stream: true,
      options: { num_predict: this.resolveSettings().maxOutputTokens },
    };
    const response = await this.fetch("chat", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/x-ndjson" },
      body: JSON.stringify(body),
      signal,
    });
    if (!response.ok) { await response.body?.cancel(); throw new ProviderRequestError(response.status); }
    if (!response.body) throw new Error("Ollama returned an empty stream.");
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let done = false;
    let doneReason: string | undefined;
    let text = "";
    let promptTokens: number | undefined;
    let completionTokens: number | undefined;
    const calls = new Map<number, { name: string; arguments: Record<string, unknown> }>();
    const processLine = async (line: string): Promise<void> => {
      if (!line.trim()) return;
      if (done) throw new Error("Ollama returned data after completion.");
      let event: unknown;
      try { event = JSON.parse(line); } catch { throw new Error("Ollama returned an invalid NDJSON stream."); }
      if (!isRecord(event)) throw new Error("Ollama returned an invalid NDJSON stream.");
      if (event.message !== undefined) {
        if (!isRecord(event.message) || (event.message.role !== undefined && event.message.role !== "assistant")) throw new Error("Ollama returned an invalid chat event.");
        if (event.message.content !== undefined) {
          if (typeof event.message.content !== "string") throw new Error("Ollama returned an invalid chat event.");
          text += event.message.content;
          if (text.length > MAX_STREAM_CHARS) throw new Error("Provider response exceeded the supported size.");
          if (event.message.content && onDelta) await onDelta(event.message.content);
        }
        if (event.message.tool_calls !== undefined) {
          if (!Array.isArray(event.message.tool_calls) || event.message.tool_calls.length > 32) throw new Error("Ollama returned an invalid tool-call stream.");
          for (let index = 0; index < event.message.tool_calls.length; index++) {
            const rawCall = event.message.tool_calls[index] as StreamTool;
            if (!isRecord(rawCall) || !isRecord(rawCall.function)) throw new Error("Ollama returned an invalid tool-call stream.");
            const previous = calls.get(index) ?? { name: "", arguments: {} };
            if (rawCall.function.name !== undefined) {
              if (typeof rawCall.function.name !== "string") throw new Error("Ollama returned an invalid tool-call stream.");
              previous.name += rawCall.function.name;
            }
            if (rawCall.function.arguments !== undefined) {
              if (!isRecord(rawCall.function.arguments)) throw new Error("Ollama returned an invalid tool-call stream.");
              previous.arguments = { ...previous.arguments, ...rawCall.function.arguments };
            }
            calls.set(index, previous);
          }
          const totalToolArgumentLength = [...calls.values()].reduce((total, call) => total + JSON.stringify(call.arguments).length, 0);
          if (totalToolArgumentLength > MAX_TOOL_ARGUMENT_CHARS) throw new Error("Ollama tool arguments exceeded the supported size.");
        }
      }
      if (event.prompt_eval_count !== undefined) promptTokens = tokenCount(event.prompt_eval_count);
      if (event.eval_count !== undefined) completionTokens = tokenCount(event.eval_count);
      if (event.done === true) {
        done = true;
        if (event.done_reason !== undefined && typeof event.done_reason !== "string") throw new Error("Ollama returned an invalid completion status.");
        doneReason = event.done_reason;
        if (doneReason === "length") throw new Error("Ollama completion was truncated.");
        if (doneReason && doneReason !== "stop" && doneReason !== "tool_calls") throw new Error("Ollama completion did not finish successfully.");
      } else if (event.done !== false) throw new Error("Ollama returned an invalid completion status.");
    };
    try {
      while (true) {
        const { value, done: ended } = await reader.read();
        buffer += decoder.decode(value, { stream: !ended });
        if (buffer.length > MAX_STREAM_CHARS) throw new Error("Provider stream exceeded the supported size.");
        let newline: number;
        while ((newline = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, newline).replace(/\r$/, "");
          buffer = buffer.slice(newline + 1);
          await processLine(line);
        }
        if (ended) {
          if (buffer.trim()) throw new Error("Ollama returned an incomplete NDJSON stream.");
          break;
        }
      }
    } finally {
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
    if (!done) throw new Error("Ollama stream ended before completion.");
    const toolCalls: ToolCall[] = [...calls.entries()].sort(([a], [b]) => a - b).map(([index, call]) => {
      if (!call.name || !isRecord(call.arguments)) throw new Error("Ollama returned an invalid tool call.");
      return { id: `call_${index}`, type: "function", function: { name: call.name, arguments: JSON.stringify(call.arguments) } };
    });
    const usage = promptTokens !== undefined || completionTokens !== undefined ? {
      ...(promptTokens !== undefined ? { prompt_tokens: promptTokens } : {}),
      ...(completionTokens !== undefined ? { completion_tokens: completionTokens } : {}),
      ...(promptTokens !== undefined && completionTokens !== undefined ? { total_tokens: promptTokens + completionTokens } : {}),
    } : undefined;
    if (!text.trim() && !toolCalls.length) throw new Error("Ollama returned no answer.");
    return { message: { role: "assistant", content: text, ...(toolCalls.length ? { tool_calls: toolCalls } : {}) }, ...(usage ? { usage } : {}) };
  }

  redact(text: string): string { return text; }

  private async json(path: string): Promise<Record<string, unknown>> {
    const response = await this.fetch(path, { headers: { accept: "application/json" } });
    if (!response.ok) { await response.body?.cancel(); throw new ProviderRequestError(response.status); }
    let body: unknown;
    try { body = await response.json(); } catch { throw new Error("Ollama returned invalid JSON."); }
    if (!isRecord(body)) throw new Error("Ollama returned an invalid response.");
    return body;
  }

  private async fetch(path: string, init: RequestInit): Promise<Response> {
    try { return await this.request(new URL(`/api/${path}`, this.base), { ...init, redirect: "error" }); }
    catch (error) {
      if (init.signal?.aborted) throw new Error("Provider request cancelled.");
      throw new Error("Provider connection failed.", { cause: error });
    }
  }
}

function toOllamaMessages(messages: readonly ModelMessage[]): Record<string, unknown>[] {
  const toolNames = new Map<string, string>();
  return messages.map(message => {
    const result = toOllamaMessage(message, toolNames);
    if (message.role === "assistant") {
      for (const call of message.tool_calls ?? []) toolNames.set(call.id, call.function.name);
    }
    return result;
  });
}

function toOllamaMessage(message: ModelMessage, toolNames: ReadonlyMap<string, string>): Record<string, unknown> {
  const result: Record<string, unknown> = { role: message.role, content: message.content ?? "" };
  if (message.role === "tool" && message.tool_call_id) {
    const name = toolNames.get(message.tool_call_id);
    if (name) result.tool_name = name;
  }
  if (message.role === "assistant" && message.tool_calls?.length) {
    result.tool_calls = message.tool_calls.map(call => {
      let args: unknown;
      try { args = JSON.parse(call.function.arguments); } catch { throw new Error("Ollama tool history contains invalid arguments."); }
      if (!isRecord(args)) throw new Error("Ollama tool history contains invalid arguments.");
      return { function: { name: call.function.name, arguments: args } };
    });
  }
  return result;
}
function tokenCount(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new Error("Ollama returned invalid token usage.");
  return value;
}

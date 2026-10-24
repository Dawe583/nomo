import type { Model, ModelMessage, ModelReply, ToolCall } from "../provider.ts";
import { ProviderRequestError } from "../provider.ts";
import { defaultHarnessSettings, type HarnessSettings } from "../harness-settings.ts";
import type { ProviderAdapterConfig, ProviderClient } from "./types.ts";
import { isLoopbackHostname, isRecord } from "./guards.ts";

type MistralDelta = { content?: unknown; tool_calls?: unknown };
type ToolDelta = { index?: unknown; id?: unknown; type?: unknown; function?: { name?: unknown; arguments?: unknown } };
const MAX_STREAM_CHARS = 2_000_000;
const MAX_TOOL_ARGUMENT_CHARS = 1_000_000;

export class MistralConversationsAdapter implements ProviderClient {
  private readonly base: URL;
  private readonly apiKey: string;
  private readonly request: typeof fetch;
  private readonly resolveSettings: () => HarnessSettings;

  constructor(config: ProviderAdapterConfig, request: typeof fetch = fetch, settings: Partial<HarnessSettings> | (() => HarnessSettings) = {}) {
    if (config.providerId !== "mistral" || config.transport !== "mistral-conversations" || config.auth.kind !== "api-key" || !config.auth.apiKey) {
      throw new Error("Mistral Conversations requires its explicit API-key provider descriptor.");
    }
    let base: URL;
    try { base = new URL(config.baseUrl); }
    catch { throw new Error("Mistral Conversations requires the official HTTPS API endpoint."); }
    const official = base.protocol === "https:" && base.hostname.toLowerCase() === "api.mistral.ai" && !base.port;
    const loopbackFixture = base.protocol === "http:" && isLoopbackHostname(base.hostname);
    if ((!official && !loopbackFixture) || base.username || base.password || base.search || base.hash || !["", "/", "/v1"].includes(base.pathname)) {
      throw new Error("Mistral Conversations requires the official Mistral HTTPS endpoint.");
    }
    this.base = base;
    this.apiKey = config.auth.apiKey;
    this.request = request;
    this.resolveSettings = typeof settings === "function" ? settings : () => ({ ...defaultHarnessSettings(), ...settings });
  }

  async models(): Promise<readonly Model[]> {
    const body = await this.json();
    if (!Array.isArray(body.data)) throw new Error("Provider returned an invalid model catalog.");
    return body.data.flatMap((item: unknown) => {
      if (!isRecord(item) || typeof item.id !== "string" || !item.id) return [];
      return [{ id: item.id, name: typeof item.name === "string" && item.name ? item.name : item.id }];
    });
  }

  async complete(model: string, messages: readonly ModelMessage[], tools: readonly unknown[], signal: AbortSignal, onDelta?: (text: string) => void | Promise<void>): Promise<ModelReply> {
    const body = {
      model,
      messages,
      ...(tools.length ? { tools } : {}),
      max_tokens: this.resolveSettings().maxOutputTokens,
      stream: true,
    };
    const response = await this.fetch("/v1/chat/completions", {
      method: "POST",
      headers: { authorization: `Bearer ${this.apiKey}`, "content-type": "application/json", accept: "text/event-stream" },
      body: JSON.stringify(body),
      signal,
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new ProviderRequestError(response.status);
    }
    if (!response.headers.get("content-type")?.toLowerCase().includes("text/event-stream") || !response.body) {
      await response.body?.cancel();
      throw new Error("Mistral returned an invalid event stream.");
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let dataLines: string[] = [];
    let dataLength = 0;
    let emission = "";
    let done = false;
    let text = "";
    let finishReason: string | undefined;
    let usage: ModelReply["usage"];
    const toolDeltas = new Map<number, { id: string; name: string; arguments: string }>();
    let totalToolArgumentLength = 0;
    const emit = async (value: string, flush = false): Promise<void> => {
      if (!onDelta) return;
      emission = this.redact(emission + value);
      let hold = 0;
      if (!flush) {
        for (let index = 1; index < this.apiKey.length; index++) {
          if (emission.endsWith(this.apiKey.slice(0, index))) hold = index;
        }
      }
      const visible = emission.slice(0, emission.length - hold);
      emission = hold ? emission.slice(-hold) : "";
      if (visible) await onDelta(visible);
    };
    const consumeData = async (): Promise<void> => {
      if (!dataLines.length || done) { dataLines = []; return; }
      const data = dataLines.join("\n");
      dataLines = [];
      dataLength = 0;
      if (data === "[DONE]") { done = true; return; }
      let event: unknown;
      try { event = JSON.parse(data); } catch { throw new Error("Mistral returned an invalid event stream."); }
      if (!isRecord(event)) throw new Error("Mistral returned an invalid event stream.");
      if (isRecord(event.usage)) usage = usageFrom(event.usage);
      if (event.choices === undefined && event.usage !== undefined) return;
      if (!Array.isArray(event.choices)) throw new Error("Mistral returned an invalid event stream.");
      for (const choice of event.choices) {
        if (!isRecord(choice) || !isRecord(choice.delta)) throw new Error("Mistral returned an invalid event stream.");
        const delta = choice.delta as MistralDelta;
        if (delta.content !== undefined) {
          if (typeof delta.content !== "string") throw new Error("Mistral returned an invalid event stream.");
          text += delta.content;
          if (text.length > MAX_STREAM_CHARS) throw new Error("Provider response exceeded the supported size.");
          await emit(delta.content);
        }
        if (delta.tool_calls !== undefined) {
          if (!Array.isArray(delta.tool_calls)) throw new Error("Mistral returned an invalid tool-call stream.");
          for (const rawTool of delta.tool_calls) {
            if (!isRecord(rawTool)) throw new Error("Mistral returned an invalid tool-call stream.");
            const tool = rawTool as ToolDelta;
            if (typeof tool.index !== "number" || !Number.isInteger(tool.index) || tool.index < 0 || tool.index > 31) {
              throw new Error("Mistral returned an invalid tool-call stream.");
            }
            const index = tool.index;
            const prior = toolDeltas.get(index) ?? { id: "", name: "", arguments: "" };
            if (tool.id !== undefined) {
              if (typeof tool.id !== "string") throw new Error("Mistral returned an invalid tool-call stream.");
              prior.id = tool.id;
            }
            if (tool.type !== undefined && tool.type !== "function") throw new Error("Mistral returned an invalid tool-call stream.");
            if (tool.function?.name !== undefined) {
              if (typeof tool.function.name !== "string") throw new Error("Mistral returned an invalid tool-call stream.");
              prior.name += tool.function.name;
            }
            if (tool.function?.arguments !== undefined) {
              if (typeof tool.function.arguments !== "string") throw new Error("Mistral returned an invalid tool-call stream.");
              totalToolArgumentLength += tool.function.arguments.length;
              if (totalToolArgumentLength > MAX_TOOL_ARGUMENT_CHARS) throw new Error("Mistral tool arguments exceeded the supported size.");
              prior.arguments += tool.function.arguments;
            }
            toolDeltas.set(index, prior);
          }
        }
        if (choice.finish_reason !== undefined && choice.finish_reason !== null) {
          if (typeof choice.finish_reason !== "string") throw new Error("Mistral returned an invalid completion status.");
          if (choice.finish_reason === "length") throw new Error("Mistral completion was truncated.");
          if (choice.finish_reason !== "stop" && choice.finish_reason !== "tool_calls") throw new Error("Mistral completion did not finish successfully.");
          finishReason = choice.finish_reason;
        }
      }
    };
    try {
      while (!done) {
        const { value, done: ended } = await reader.read();
        buffer += decoder.decode(value, { stream: !ended });
        if (buffer.length > MAX_STREAM_CHARS) throw new Error("Provider stream exceeded the supported size.");
        let newline: number;
        while ((newline = buffer.indexOf("\n")) >= 0) {
          let line = buffer.slice(0, newline);
          buffer = buffer.slice(newline + 1);
          if (line.endsWith("\r")) line = line.slice(0, -1);
          if (!line && dataLines.length) await consumeData();
          else if (line.startsWith("data:")) {
            const dataLine = line.slice(5).replace(/^ /, "");
            dataLength += dataLine.length + (dataLines.length ? 1 : 0);
            if (dataLength > MAX_STREAM_CHARS) throw new Error("Provider stream exceeded the supported size.");
            dataLines.push(dataLine);
          }
        }
        if (ended) break;
      }
    } finally {
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
    if (!done || !finishReason || dataLines.length || buffer.trim()) throw new Error("Mistral stream ended before completion.");
    const toolCalls: ToolCall[] = [...toolDeltas.entries()].sort(([a], [b]) => a - b).map(([index, call]) => {
      if (!call.id || !call.name) throw new Error("Mistral returned an invalid tool-call stream.");
      const args = call.arguments || "{}";
      try { if (!isRecord(JSON.parse(args))) throw new Error(); }
      catch { throw new Error("Mistral returned an invalid tool-call stream."); }
      return { id: call.id, type: "function", function: { name: call.name, arguments: args } };
    });
    if (!text.trim() && !toolCalls.length) throw new Error("Mistral returned no answer.");
    await emit("", true);
    return { message: { role: "assistant", content: text, ...(toolCalls.length ? { tool_calls: toolCalls } : {}) }, ...(usage ? { usage } : {}) };
  }

  redact(text: string): string { return this.apiKey ? text.split(this.apiKey).join("[redacted]") : text; }

  private async json(): Promise<Record<string, unknown>> {
    const response = await this.fetch("/v1/models", { headers: { authorization: `Bearer ${this.apiKey}`, accept: "application/json" } });
    if (!response.ok) { await response.body?.cancel(); throw new ProviderRequestError(response.status); }
    let body: unknown;
    try { body = await response.json(); } catch { throw new Error("Provider returned invalid JSON."); }
    if (!isRecord(body)) throw new Error("Provider returned an invalid response.");
    return body;
  }

  private async fetch(path: string, init: RequestInit): Promise<Response> {
    try { return await this.request(new URL(path, ensureSlash(this.base)), { ...init, redirect: "error" }); }
    catch (error) {
      if (init.signal?.aborted) throw new Error("Provider request cancelled.");
      throw new Error("Provider connection failed.", { cause: error });
    }
  }
}

function ensureSlash(url: URL): URL { const base = new URL(url); if (!base.pathname.endsWith("/")) base.pathname += "/"; return base; }
function usageFrom(value: Record<string, unknown>): ModelReply["usage"] {
  const prompt = typeof value.prompt_tokens === "number" && Number.isFinite(value.prompt_tokens) ? value.prompt_tokens : undefined;
  const completion = typeof value.completion_tokens === "number" && Number.isFinite(value.completion_tokens) ? value.completion_tokens : undefined;
  const total = typeof value.total_tokens === "number" && Number.isFinite(value.total_tokens) ? value.total_tokens : prompt !== undefined && completion !== undefined ? prompt + completion : undefined;
  return prompt !== undefined || completion !== undefined || total !== undefined ? { ...(prompt !== undefined ? { prompt_tokens: prompt } : {}), ...(completion !== undefined ? { completion_tokens: completion } : {}), ...(total !== undefined ? { total_tokens: total } : {}) } : undefined;
}

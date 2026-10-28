import type { Model, ModelMessage, ModelReply, ToolCall } from "../provider.ts";
import { ProviderRequestError } from "../provider.ts";
import { defaultHarnessSettings, type HarnessSettings } from "../harness-settings.ts";
import type { ProviderAdapterConfig, ProviderClient } from "./types.ts";
import { isLoopbackHostname, isRecord } from "./guards.ts";

type MistralInput =
  | { role: "system" | "user" | "assistant"; content: string }
  | { type: "function.call"; tool_call_id: string; name: string; arguments: Record<string, unknown> }
  | { type: "function.result"; tool_call_id: string; result: string };
type FunctionCallDelta = { id?: unknown; name?: unknown; tool_call_id?: unknown; arguments?: unknown };
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
      inputs: inputsFrom(messages),
      ...(tools.length ? { tools } : {}),
      completion_args: { max_tokens: this.resolveSettings().maxOutputTokens },
      stream: true,
    };
    const response = await this.fetch("/v1/conversations", {
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
    let eventName = "";
    let emission = "";
    let done = false;
    let text = "";
    let usage: ModelReply["usage"];
    const toolDeltas = new Map<string, { name: string; arguments: string }>();
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
      if (!dataLines.length) {
        eventName = "";
        return;
      }
      if (done) throw new Error("Mistral returned data after completion.");
      const data = dataLines.join("\n");
      const sourceEventName = eventName;
      dataLines = [];
      dataLength = 0;
      eventName = "";
      let event: unknown;
      try { event = JSON.parse(data); } catch { throw new Error("Mistral returned an invalid event stream."); }
      if (!isRecord(event) || typeof event.type !== "string" || (sourceEventName && sourceEventName !== event.type)) {
        throw new Error("Mistral returned an invalid event stream.");
      }
      switch (event.type) {
        case "message.output.delta": {
          if (typeof event.id !== "string" || !event.id || event.role !== undefined && event.role !== "assistant") {
            throw new Error("Mistral returned an invalid event stream.");
          }
          const content = event.content;
          let value: string;
          if (typeof content === "string") value = content;
          else if (isRecord(content) && typeof content.text === "string") value = content.text;
          else throw new Error("Mistral returned unsupported output content.");
          text += value;
          if (text.length > MAX_STREAM_CHARS) throw new Error("Provider response exceeded the supported size.");
          await emit(value);
          break;
        }
        case "function.call.delta": {
          const delta = event as FunctionCallDelta;
          if (typeof delta.id !== "string" || !delta.id || typeof delta.name !== "string" || !delta.name ||
              typeof delta.tool_call_id !== "string" || !delta.tool_call_id || typeof delta.arguments !== "string") {
            throw new Error("Mistral returned an invalid tool-call stream.");
          }
          const prior = toolDeltas.get(delta.tool_call_id) ?? { name: "", arguments: "" };
          prior.name = delta.name;
          totalToolArgumentLength += delta.arguments.length;
          if (totalToolArgumentLength > MAX_TOOL_ARGUMENT_CHARS) throw new Error("Mistral tool arguments exceeded the supported size.");
          prior.arguments += delta.arguments;
          toolDeltas.set(delta.tool_call_id, prior);
          break;
        }
        case "conversation.response.done":
          if (!isRecord(event.usage)) throw new Error("Mistral returned an invalid completion status.");
          usage = usageFrom(event.usage);
          done = true;
          break;
        case "conversation.response.error":
          throw new Error("Mistral returned an error event.");
        case "conversation.response.started":
          break;
        default:
          throw new Error("Mistral returned an unsupported response event.");
      }
    };
    try {
      while (!done) {
        let value: Uint8Array | undefined;
        let ended: boolean;
        try {
          const result = await reader.read();
          value = result.value;
          ended = result.done;
        } catch (error) {
          if (error instanceof DOMException && error.name === "TimeoutError")
            throw new Error("Provider request timed out.");
          throw error;
        }
        buffer += decoder.decode(value, { stream: !ended });
        if (buffer.length > MAX_STREAM_CHARS) throw new Error("Provider stream exceeded the supported size.");
        let newline: number;
        while ((newline = buffer.indexOf("\n")) >= 0) {
          let line = buffer.slice(0, newline);
          buffer = buffer.slice(newline + 1);
          if (line.endsWith("\r")) line = line.slice(0, -1);
          if (!line) await consumeData();
          else if (line.startsWith("event:")) eventName = line.slice(6).trim();
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
    if (!done || dataLines.length || buffer.trim()) throw new Error("Mistral stream ended before completion.");
    const toolCalls: ToolCall[] = [...toolDeltas.entries()].map(([id, call]) => {
      if (!call.name) throw new Error("Mistral returned an invalid tool-call stream.");
      const args = call.arguments || "{}";
      try { if (!isRecord(JSON.parse(args))) throw new Error(); }
      catch { throw new Error("Mistral returned an invalid tool-call stream."); }
      return { id, type: "function", function: { name: call.name, arguments: args } };
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

function inputsFrom(messages: readonly ModelMessage[]): MistralInput[] {
  const inputs: MistralInput[] = [];
  for (const message of messages) {
    if (message.role === "tool") {
      if (typeof message.tool_call_id !== "string" || !message.tool_call_id) throw new Error("Mistral received invalid tool history.");
      inputs.push({ type: "function.result", tool_call_id: message.tool_call_id, result: message.content ?? "" });
      continue;
    }
    if (message.content !== null) inputs.push({ role: message.role, content: message.content });
    for (const call of message.tool_calls ?? []) {
      if (!call.id || !call.function.name) throw new Error("Mistral received invalid tool-call history.");
      let argumentsValue: unknown;
      try { argumentsValue = JSON.parse(call.function.arguments); }
      catch { throw new Error("Mistral received invalid tool-call history."); }
      if (!isRecord(argumentsValue)) throw new Error("Mistral received invalid tool-call history.");
      inputs.push({ type: "function.call", tool_call_id: call.id, name: call.function.name, arguments: argumentsValue });
    }
  }
  return inputs;
}

function ensureSlash(url: URL): URL { const base = new URL(url); if (!base.pathname.endsWith("/")) base.pathname += "/"; return base; }
function usageFrom(value: Record<string, unknown>): ModelReply["usage"] {
  const prompt = typeof value.prompt_tokens === "number" && Number.isFinite(value.prompt_tokens) ? value.prompt_tokens : undefined;
  const completion = typeof value.completion_tokens === "number" && Number.isFinite(value.completion_tokens) ? value.completion_tokens : undefined;
  const total = typeof value.total_tokens === "number" && Number.isFinite(value.total_tokens) ? value.total_tokens : prompt !== undefined && completion !== undefined ? prompt + completion : undefined;
  return prompt !== undefined || completion !== undefined || total !== undefined ? { ...(prompt !== undefined ? { prompt_tokens: prompt } : {}), ...(completion !== undefined ? { completion_tokens: completion } : {}), ...(total !== undefined ? { total_tokens: total } : {}) } : undefined;
}

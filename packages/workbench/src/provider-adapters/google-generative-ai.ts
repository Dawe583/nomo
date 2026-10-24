import type { Model, ModelMessage, ModelReply, ToolCall } from "../provider.ts";
import { ProviderRequestError } from "../provider.ts";
import { defaultHarnessSettings, type HarnessSettings } from "../harness-settings.ts";
import type { ProviderAdapterConfig, ProviderClient } from "./types.ts";

type GooglePart = { text?: string; functionCall?: { name?: string; args?: unknown } };
type GoogleChunk = {
  candidates?: Array<{ content?: { parts?: GooglePart[] }; finishReason?: string }>;
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; totalTokenCount?: number };
};

export class GoogleGenerativeAIAdapter implements ProviderClient {
  private readonly base: URL;
  private readonly apiKey: string;
  private readonly request: typeof fetch;
  private readonly resolveSettings: () => HarnessSettings;

  constructor(
    config: ProviderAdapterConfig,
    request: typeof fetch = fetch,
    settings: Partial<HarnessSettings> | (() => HarnessSettings) = {},
  ) {
    if (config.providerId !== "google" || config.transport !== "google-generative-ai" || config.auth.kind !== "api-key") {
      throw new Error("Google Generative AI requires its explicit provider descriptor.");
    }
    this.base = new URL(config.baseUrl.endsWith("/") ? config.baseUrl : `${config.baseUrl}/`);
    if (
      this.base.protocol !== "https:" ||
      this.base.hostname.toLowerCase() !== "generativelanguage.googleapis.com" ||
      this.base.username || this.base.password || this.base.search || this.base.hash
    ) throw new Error("Google Generative AI requires the official HTTPS API endpoint.");
    this.apiKey = config.auth.apiKey;
    this.request = request;
    this.resolveSettings =
      typeof settings === "function"
        ? settings
        : () => ({ ...defaultHarnessSettings(), ...settings });
  }

  async models(): Promise<readonly Model[]> {
    const response = await this.fetch(new URL("models", this.base), undefined, AbortSignal.timeout(15000));
    let body: { models?: unknown };
    try { body = await response.json() as typeof body; }
    catch { throw new Error("Provider returned invalid JSON."); }
    if (!Array.isArray(body.models)) throw new Error("Provider returned an invalid model catalog.");
    return body.models.flatMap((item: unknown) => {
      if (!item || typeof item !== "object" || !("name" in item) || typeof item.name !== "string") return [];
      const id = item.name.startsWith("models/") ? item.name.slice("models/".length) : item.name;
      if (!id || ("supportedGenerationMethods" in item && Array.isArray(item.supportedGenerationMethods) && !item.supportedGenerationMethods.includes("generateContent"))) return [];
      return [{ id, name: "displayName" in item && typeof item.displayName === "string" ? item.displayName : id }];
    });
  }

  async complete(
    model: string,
    messages: readonly ModelMessage[],
    tools: readonly unknown[],
    signal: AbortSignal,
    onDelta?: (text: string) => void | Promise<void>,
  ): Promise<ModelReply> {
    const system = messages.filter(message => message.role === "system").map(message => message.content ?? "").join("\n\n");
    const toolNames = new Map<string, string>();
    for (const message of messages) for (const call of message.tool_calls ?? []) toolNames.set(call.id, call.function.name);
    const contents: Array<{ role: "user" | "model"; parts: unknown[] }> = [];
    for (const message of messages) {
      if (message.role === "system") continue;
      if (message.role === "tool") {
        if (!message.tool_call_id) throw new Error("Google function response is missing its call ID.");
        const name = toolNames.get(message.tool_call_id);
        if (!name) throw new Error("Google function response has no matching prior tool call.");
        const previous = contents.at(-1);
        const part = { functionResponse: { name, response: { result: message.content ?? "" } } };
        if (previous?.role === "user") previous.parts.push(part);
        else contents.push({ role: "user", parts: [part] });
      } else if (message.role === "assistant" && message.tool_calls?.length) {
        const parts: unknown[] = [];
        if (message.content?.trim()) parts.push({ text: message.content });
        for (const call of message.tool_calls) {
          let args: unknown;
          try { args = JSON.parse(call.function.arguments); }
          catch { throw new Error("Prior tool arguments are invalid."); }
          if (!args || typeof args !== "object" || Array.isArray(args)) throw new Error("Prior tool arguments are invalid.");
          parts.push({ functionCall: { name: call.function.name, args } });
        }
        contents.push({ role: "model", parts });
      } else {
        contents.push({ role: message.role === "assistant" ? "model" : "user", parts: [{ text: message.content ?? "" }] });
      }
    }
    const functionDeclarations = tools.map(value => {
      const fn = (value as { function?: { name?: unknown; description?: unknown; parameters?: unknown } })?.function;
      if (typeof fn?.name !== "string" || !fn.parameters || typeof fn.parameters !== "object") throw new Error("Provider tool definition is invalid.");
      return { name: fn.name, ...(typeof fn.description === "string" ? { description: fn.description } : {}), parameters: fn.parameters };
    });
    const body = {
      contents,
      ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
      ...(functionDeclarations.length ? { tools: [{ functionDeclarations }] } : {}),
      generationConfig: { maxOutputTokens: this.resolveSettings().maxOutputTokens },
    };
    const url = new URL(`models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse`, this.base);
    const response = await this.fetch(url, body, AbortSignal.any([signal, AbortSignal.timeout(60000)]));
    return this.consume(response, signal, onDelta);
  }

  redact(text: string): string { return this.apiKey ? text.split(this.apiKey).join("[redacted]") : text; }

  private async fetch(url: URL, body: unknown, signal: AbortSignal): Promise<Response> {
    try {
      const response = await this.request(url, {
        method: body === undefined ? "GET" : "POST",
        headers: { "x-goog-api-key": this.apiKey, accept: body === undefined ? "application/json" : "text/event-stream", ...(body === undefined ? {} : { "content-type": "application/json" }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        redirect: "error",
        signal,
      });
      if (response.ok) return response;
      await response.body?.cancel().catch(() => {});
      throw new ProviderRequestError(response.status);
    } catch (error) {
      if (error instanceof ProviderRequestError) throw error;
      throw new Error(signal.aborted ? "Session cancelled." : "Provider connection failed. Check its endpoint and availability.");
    }
  }

  private async consume(response: Response, signal: AbortSignal, onDelta?: (text: string) => void | Promise<void>): Promise<ModelReply> {
    if (!response.body) throw new Error("Provider returned an empty stream.");
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let pending = "";
    let text = "";
    let usage: ModelReply["usage"];
    const calls: ToolCall[] = [];
    let finished = false;
    try {
      while (true) {
        signal.throwIfAborted();
        const { value, done } = await reader.read();
        pending += decoder.decode(value, { stream: !done });
        pending = pending.replace(/\r\n/g, "\n");
        if (pending.length > 2_000_000) throw new Error("Provider stream exceeded the supported size.");
        let boundary: number;
        while ((boundary = pending.indexOf("\n\n")) >= 0) {
          const frame = pending.slice(0, boundary);
          pending = pending.slice(boundary + 2);
          const data = frame.split("\n").filter(line => line.startsWith("data:")).map(line => line.slice(5).trimStart()).join("\n");
          if (!data) continue;
          let chunk: GoogleChunk;
          try { chunk = JSON.parse(data) as GoogleChunk; }
          catch { throw new Error("Provider returned malformed stream data."); }
          if (chunk.usageMetadata) usage = {
            prompt_tokens: chunk.usageMetadata.promptTokenCount,
            completion_tokens: chunk.usageMetadata.candidatesTokenCount,
            total_tokens: chunk.usageMetadata.totalTokenCount,
          };
          for (const candidate of chunk.candidates ?? []) {
            if (candidate.finishReason) {
              if (candidate.finishReason === "MAX_TOKENS") throw new Error("Provider response was truncated. No tools were executed.");
              if (candidate.finishReason !== "STOP") throw new Error("Provider response was blocked or could not complete.");
              finished = true;
            }
            for (const part of candidate.content?.parts ?? []) {
              if (typeof part.text === "string") {
                text += part.text;
                if (text.length > 2_000_000) throw new Error("Provider response exceeded the supported size.");
                await onDelta?.(part.text);
              }
              if (part.functionCall) {
                if (!part.functionCall.name || !part.functionCall.args || typeof part.functionCall.args !== "object" || Array.isArray(part.functionCall.args)) throw new Error("Provider returned an invalid function call.");
                calls.push({ id: `google-call-${calls.length}`, type: "function", function: { name: part.functionCall.name, arguments: JSON.stringify(part.functionCall.args) } });
              }
            }
          }
        }
        if (done) break;
      }
      if (!finished) throw new Error("Provider stream ended before completion.");
      if (!text.trim() && !calls.length) throw new Error("Provider returned no answer. Retry the response.");
      return { message: { role: "assistant", content: text || null, ...(calls.length ? { tool_calls: calls } : {}) }, usage };
    } finally {
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
  }
}

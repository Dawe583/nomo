import type { Model, ModelMessage, ModelReply, ToolCall } from "../provider.ts";
import { ProviderRequestError } from "../provider.ts";
import { defaultHarnessSettings, type HarnessSettings } from "../harness-settings.ts";
import type { ProviderAdapterConfig, ProviderAdapterDependencies, ProviderClient } from "./types.ts";
import { isBedrockMantleBaseUrl } from "./bedrock-mantle-config.ts";

type ResponsesOutputItem = {
  readonly type?: string;
  readonly role?: string;
  readonly content?: readonly { readonly type?: string; readonly text?: string; readonly refusal?: string }[];
  readonly id?: string;
  readonly call_id?: string;
  readonly name?: string;
  readonly arguments?: string;
};

type ResponsesObject = {
  readonly id?: string;
  readonly status?: string;
  readonly output?: readonly ResponsesOutputItem[];
  readonly error?: { readonly code?: string; readonly param?: string; readonly message?: string };
  readonly usage?: { readonly input_tokens?: number; readonly output_tokens?: number; readonly total_tokens?: number };
};
function safeErrorField(value: unknown, token: string): string | undefined {
  return typeof value === "string" && /^[A-Za-z0-9._-]{1,128}$/.test(value) &&
    (!token || !value.includes(token)) ? value : undefined;
}

function safeErrorBody(body: unknown, token: string): { error?: { code?: string; param?: string }; detail?: string } | undefined {
  if (!body || typeof body !== "object") return undefined;
  if ("detail" in body && typeof body.detail === "string") return { detail: "[redacted]" };
  if (!("error" in body)) return undefined;
  const error = body.error;
  if (!error || typeof error !== "object") return undefined;
  const code = safeErrorField("code" in error ? error.code : undefined, token);
  const param = safeErrorField("param" in error ? error.param : undefined, token);
  return { error: { ...(code ? { code } : {}), ...(param ? { param } : {}) } };
}


async function requestError(response: Response, preserveBody: boolean, token: string): Promise<ProviderRequestError> {
  const retryAfter = response.headers.get("retry-after");
  let body: unknown;
  if (preserveBody) {
    try {
      const text = await response.text();
      if (text.length <= 65_536) {
        try { body = JSON.parse(text); }
        catch { body = text; }
      }
    } catch { /* Keep the HTTP status even when the error body is unreadable. */ }
  } else {
    await response.body?.cancel().catch(() => {});
  }
  const safeBody = safeErrorBody(body, token);
  const code = safeBody?.error?.code;
  return new ProviderRequestError(
    response.status,
    code,
    retryAfter && /^\d+$/.test(retryAfter) ? Number(retryAfter) : undefined,
    safeErrorField(response.headers.get("x-request-id"), token),
    safeBody,
  );
}

class ResponsesAdapter implements ProviderClient {
  private readonly base: URL;
  private readonly request: typeof fetch;
  private readonly apiKey: string;
  private readonly isChatGPTAccount: boolean;
  private readonly resolveAccessToken?: (accountId: string) => Promise<string>;
  private readonly accountId?: string;
  private readonly resolveSettings: () => HarnessSettings;
  private readonly protocol: "openai" | "azure";
  private readonly azureApiVersion?: "v1" | "preview";

  constructor(
    config: ProviderAdapterConfig,
    request: typeof fetch,
    settings: Partial<HarnessSettings> | (() => HarnessSettings),
    protocol: "openai" | "azure",
    dependencies: ProviderAdapterDependencies = {},
  ) {
    const cloudflare = config.providerId === "cloudflare-ai-gateway";
    const bedrockMantle = config.providerId === "bedrock-mantle";
    this.isChatGPTAccount = config.auth.kind === "openai-chatgpt-account";
    if (config.auth.kind !== "api-key" && !this.isChatGPTAccount) {
      throw new Error("Responses requires a supported authentication profile.");
    }
    if (this.isChatGPTAccount) {
      if (protocol !== "openai" || config.providerId !== "openai" || config.transport !== "openai-responses")
        throw new Error("ChatGPT account auth is supported only by OpenAI Responses.");
      this.accountId = config.auth.kind === "openai-chatgpt-account" ? config.auth.accountId : undefined;
      this.resolveAccessToken = dependencies.openAIChatGPTTokenProvider;
      if (!this.accountId || !this.resolveAccessToken)
        throw new Error("OpenAI ChatGPT account is not available.");
    }
    if (protocol === "openai") {
      if (
        (config.providerId !== "openai" && !cloudflare && !bedrockMantle) ||
        config.transport !== "openai-responses" ||
        config.azureOptions
      ) {
        throw new Error("OpenAI Responses requires an explicit compatible provider descriptor.");
      }
      this.base = new URL(config.baseUrl.endsWith("/") ? config.baseUrl : `${config.baseUrl}/`);
      const path = this.base.pathname.replace(/\/$/, "");
      const validHost = bedrockMantle
        ? isBedrockMantleBaseUrl(config.baseUrl)
        : this.base.hostname.toLowerCase() === (cloudflare ? "gateway.ai.cloudflare.com" : "api.openai.com");
      if (
        this.base.protocol !== "https:" ||
        !validHost ||
        (this.isChatGPTAccount && (this.base.port !== "" || path !== "/v1")) ||
        (cloudflare && !/^\/v1\/[^/]+\/[^/]+\/openai$/.test(path)) ||
        this.base.username || this.base.password || this.base.search || this.base.hash
      ) throw new Error("OpenAI Responses requires its declared official HTTPS API endpoint.");
    } else {
      if (
        !["azure", "azure-openai-responses"].includes(config.providerId) ||
        config.transport !== "azure-openai-responses"
      ) {
        throw new Error("Azure OpenAI Responses requires an explicit Azure provider descriptor.");
      }
      const apiVersion = config.azureOptions?.apiVersion ?? "v1";
      if (apiVersion !== "v1" && apiVersion !== "preview") {
        throw new Error("Azure Responses API uses an unsupported Azure Responses API version.");
      }
      const endpoint = new URL(config.baseUrl);
      const path = endpoint.pathname.replace(/\/$/, "");
      if (
        endpoint.protocol !== "https:" ||
        !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.openai\.azure\.com$/.test(endpoint.hostname.toLowerCase()) ||
        endpoint.username || endpoint.password || endpoint.port || endpoint.search || endpoint.hash ||
        !["", "/openai", "/openai/v1"].includes(path)
      ) {
        throw new Error("Azure OpenAI resource endpoint must be an HTTPS Azure resource URL with an optional /openai/v1 path.");
      }
      endpoint.pathname = "/openai/v1";
      endpoint.search = "";
      endpoint.hash = "";
      this.base = new URL(endpoint.toString().endsWith("/") ? endpoint.toString() : `${endpoint}/`);
      this.azureApiVersion = apiVersion;
    }
    this.protocol = protocol;
    this.apiKey = config.auth.kind === "api-key" ? config.auth.apiKey : "";
    this.request = request;
    this.resolveSettings =
      typeof settings === "function"
        ? settings
        : () => ({ ...defaultHarnessSettings(), ...settings });
  }


  async models(): Promise<readonly Model[]> {
    const body = await this.json("models");
    if (this.isChatGPTAccount) {
      if (!Array.isArray(body.models)) throw new Error("Provider returned an invalid ChatGPT model catalog.");
      return body.models.flatMap((item: unknown) => {
        if (
          typeof item !== "object" || item === null || !("visibility" in item) ||
          item.visibility !== "list" || !("slug" in item) ||
          typeof item.slug !== "string" || !item.slug.trim()
        ) return [];
        return [{ id: item.slug, name: "display_name" in item && typeof item.display_name === "string" && item.display_name.trim() ? item.display_name : item.slug }];
      });
    }
    if (!Array.isArray(body.data)) throw new Error("Provider returned an invalid model catalog.");
    return body.data.flatMap((item: unknown) => {
      if (typeof item !== "object" || item === null || !("id" in item) || typeof item.id !== "string" || !item.id.trim()) return [];
      return [{ id: item.id, name: "name" in item && typeof item.name === "string" ? item.name : item.id }];
    });
  }

  async complete(
    model: string,
    messages: readonly ModelMessage[],
    tools: readonly unknown[],
    signal: AbortSignal,
    onDelta?: (text: string) => void | Promise<void>,
  ): Promise<ModelReply> {
    const instructions = messages.filter(message => message.role === "system").map(message => message.content ?? "").join("\n\n");
    const input: unknown[] = [];
    for (const message of messages) {
      if (message.role === "system") continue;
      if (message.role === "tool") {
        if (!message.tool_call_id) throw new Error("Responses tool output is missing its call ID.");
        input.push({ type: "function_call_output", call_id: message.tool_call_id, output: message.content ?? "" });
      } else if (message.role === "assistant" && message.tool_calls?.length) {
        if (message.content?.trim()) input.push({ role: "assistant", content: [{ type: "output_text", text: message.content }] });
        for (const call of message.tool_calls) {
          input.push({ type: "function_call", call_id: call.id, name: call.function.name, arguments: call.function.arguments });
        }
      } else {
        input.push({ role: message.role, content: [{ type: message.role === "assistant" ? "output_text" : "input_text", text: message.content ?? "" }] });
      }
    }
    const responseTools = tools.map(value => {
      const candidate = value as { function?: { name?: unknown; description?: unknown; parameters?: unknown } };
      const fn = candidate?.function;
      if (typeof fn?.name !== "string" || !fn.parameters || typeof fn.parameters !== "object") {
        throw new Error("Provider tool definition is invalid.");
      }
      return { type: "function", name: fn.name, description: typeof fn.description === "string" ? fn.description : "", parameters: fn.parameters, strict: false };
    });
    const settings = this.resolveSettings();
    const body = {
      model,
      ...(instructions ? { instructions } : {}),
      input,
      ...(responseTools.length ? { tools: responseTools } : {}),
      max_output_tokens: settings.maxOutputTokens,
      ...(this.isChatGPTAccount ? { store: false } : {}),
      stream: this.isChatGPTAccount || !!onDelta,
    };
    const accessToken = await this.authorizationToken();
    const response = await this.post(body, signal, accessToken);
    if (response.headers.get("content-type")?.includes("text/event-stream")) {
      if (!onDelta && !this.isChatGPTAccount) throw new Error("Provider returned an unexpected stream.");
      return this.stream(response, signal, onDelta ?? (() => {}), accessToken);
    }
    if (this.isChatGPTAccount) {
      await response.body?.cancel().catch(() => {});
      throw new Error("Provider returned a non-streaming response.");
    }
    const decoded = await this.decode(response);
    return this.toReply(decoded);
  }

  redact(text: string): string {
    return this.apiKey ? text.split(this.apiKey).join("[redacted]") : text;
  }

  private async authorizationToken(): Promise<string> {
    if (!this.isChatGPTAccount) return this.apiKey;
    const token = await this.resolveAccessToken!(this.accountId!);
    if (!token) throw new Error("OpenAI account requires sign-in again.");
    return token;
  }

  private async post(body: unknown, signal: AbortSignal, accessToken: string): Promise<Response> {
    try {
      const url = new URL("responses", this.base);
      if (this.azureApiVersion) url.searchParams.set("api-version", this.azureApiVersion);
      const headers: Record<string, string> = {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      };
      if (this.protocol === "azure") headers["api-key"] = this.apiKey;
      else headers.authorization = `Bearer ${accessToken}`;
      const response = await this.request(url, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        redirect: "error",
        signal: AbortSignal.any([signal, AbortSignal.timeout(60000)]),
      });
      if (!response.ok) {
        throw await requestError(response, this.isChatGPTAccount, accessToken);
      }
      return response;
    } catch (error) {
      if (error instanceof ProviderRequestError) throw error;
      if (signal.aborted) {
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
  }


  private async json(path: string): Promise<Record<string, unknown>> {
    const url = new URL(path, this.base);
    const headers: Record<string, string> = { accept: "application/json" };
    const accessToken = await this.authorizationToken();
    if (this.protocol === "azure") {
      if (this.azureApiVersion) url.searchParams.set("api-version", this.azureApiVersion);
      headers["api-key"] = this.apiKey;
    } else {
      headers.authorization = `Bearer ${accessToken}`;
    }
    const response = await this.request(url, {
      headers,
      redirect: "error",
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) throw await requestError(response, this.isChatGPTAccount, accessToken);
    try { return await response.json() as Record<string, unknown>; }
    catch { throw new Error("Provider returned invalid JSON."); }
  }


  private async decode(response: Response): Promise<ResponsesObject> {
    try {
      const value: unknown = await response.json();
      if (!value || typeof value !== "object" || !Array.isArray((value as ResponsesObject).output)) throw new Error();
      return value as ResponsesObject;
    } catch { throw new Error("Provider returned an invalid Responses payload."); }
  }

  private toReply(value: ResponsesObject): ModelReply {
    if (value.status && value.status !== "completed") throw new Error("Provider Responses request did not complete.");
    const text: string[] = [];
    const calls: ToolCall[] = [];
    for (const item of value.output ?? []) {
      if (item.type === "message") {
        for (const block of item.content ?? []) {
          if (block.type === "output_text" && typeof block.text === "string") text.push(block.text);
          else if (block.type === "refusal" && typeof block.refusal === "string") text.push(block.refusal);
        }
      } else if (item.type === "function_call") {
        if (!item.call_id || !item.name || typeof item.arguments !== "string") throw new Error("Provider returned an invalid function call.");
        try {
          const args: unknown = JSON.parse(item.arguments);
          if (!args || typeof args !== "object" || Array.isArray(args)) throw new Error();
        } catch { throw new Error("Provider returned invalid tool arguments."); }
        calls.push({ id: item.call_id, type: "function", function: { name: item.name, arguments: item.arguments } });
      }
    }
    const content = text.join("");
    if (!content.trim() && !calls.length) throw new Error("Provider returned no answer. Retry the response.");
    return {
      message: { role: "assistant", content: content || null, ...(calls.length ? { tool_calls: calls } : {}) },
      ...(value.id ? { response_id: value.id } : {}),
      usage: value.usage ? { prompt_tokens: value.usage.input_tokens, completion_tokens: value.usage.output_tokens, total_tokens: value.usage.total_tokens } : undefined,
    };
  }

  private async stream(response: Response, signal: AbortSignal, onDelta: (text: string) => void | Promise<void>, accessToken = this.apiKey): Promise<ModelReply> {
    if (!response.body) throw new Error("Provider returned an empty stream.");
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let pending = "";
    let completed: ResponsesObject | undefined;
    let terminal = false;
    let text = "";
    let emission = "";
    const emit = async (delta: string, flush = false) => {
      emission = this.redact(emission + delta);
      const secrets = [this.apiKey, this.isChatGPTAccount ? accessToken : ""].filter(Boolean);
      for (const secret of secrets) emission = emission.split(secret).join("[redacted]");
      let hold = 0;
      if (!flush || this.isChatGPTAccount) {
        for (const secret of secrets) {
          for (let index = 1; index < secret.length; index++) {
            if (emission.endsWith(secret.slice(0, index))) hold = Math.max(hold, index);
          }
        }
      }
      const visible = flush && hold
        ? `${emission.slice(0, -hold)}[redacted]`
        : emission.slice(0, emission.length - hold);
      emission = hold ? emission.slice(-hold) : "";
      if (visible) await onDelta(visible);
    };
    try {
      while (true) {
        let value: Uint8Array | undefined;
        let done: boolean;
        try {
          signal.throwIfAborted();
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
        if (pending.length > 2_000_000) throw new Error("Provider stream exceeded the supported size.");
        let boundary: number;
        while ((boundary = pending.indexOf("\n\n")) >= 0) {
          const frame = pending.slice(0, boundary);
          pending = pending.slice(boundary + 2);
          const data = frame.split("\n").filter(line => line.startsWith("data:")).map(line => line.slice(5).trimStart()).join("\n");
          if (!data || data === "[DONE]") continue;
          let event: { type?: string; delta?: string; response?: ResponsesObject; error?: unknown; message?: string };
          try { event = JSON.parse(data) as typeof event; }
          catch { throw new Error("Provider returned malformed stream data."); }
          if (
            (event.type === "response.output_text.delta" || event.type === "response.refusal.delta") &&
            typeof event.delta === "string"
          ) {
            text += event.delta;
            if (text.length > 2_000_000) throw new Error("Provider response exceeded the supported size.");
            await emit(event.delta);
          } else if (event.type === "response.completed") {
            completed = event.response;
            terminal = true;
          } else if (event.type === "response.incomplete") {
            throw new Error("Provider Responses request did not complete.");
          } else if (event.type === "error" || event.type === "response.failed") {
            if (this.isChatGPTAccount) {
              const errorBody = event.response ?? event.error ?? event;
              const errorObject = errorBody && typeof errorBody === "object" && "error" in errorBody
                ? errorBody.error : errorBody;
              const safeBody = safeErrorBody({ error: errorObject }, accessToken);
              throw new ProviderRequestError(
                response.status,
                safeBody?.error?.code,
                undefined,
                safeErrorField(response.headers.get("x-request-id"), accessToken),
                safeBody,
              );
            }
            throw new Error("Provider reported a Responses stream error.");
          }
          if (terminal) break;
        }
        if (done || terminal) break;
      }
      if (!completed) throw new Error("Provider Responses stream ended before completion.");
      const reply = this.toReply(completed);
      await emit("", true);
      const content = text || reply.message.content;
      if (this.isChatGPTAccount && accessToken) {
        const redact = (value: string) => {
          let redacted = value.split(accessToken).join("[redacted]");
          let suffixLength = 0;
          for (let index = 1; index < accessToken.length; index++) {
            if (redacted.endsWith(accessToken.slice(0, index))) suffixLength = index;
          }
          if (suffixLength) redacted = `${redacted.slice(0, -suffixLength)}[redacted]`;
          return redacted;
        };
        return {
          ...reply,
          message: {
            ...reply.message,
            content: content === null ? null : redact(content),
            ...(reply.message.tool_calls ? { tool_calls: reply.message.tool_calls.map(call => ({
              ...call,
              function: { ...call.function, arguments: redact(call.function.arguments) },
            })) } : {}),
          },
        };
      }
      if (reply.message.content !== content && content) return { ...reply, message: { ...reply.message, content } };
      return reply;
    } finally {
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
  }
}
export class OpenAIResponsesAdapter extends ResponsesAdapter {
  constructor(
    config: ProviderAdapterConfig,
    request: typeof fetch = fetch,
    settings: Partial<HarnessSettings> | (() => HarnessSettings) = {},
    dependencies: ProviderAdapterDependencies = {},
  ) {
    super(config, request, settings, "openai", dependencies);
  }
}

export class AzureOpenAIResponsesAdapter extends ResponsesAdapter {
  constructor(
    config: ProviderAdapterConfig,
    request: typeof fetch = fetch,
    settings: Partial<HarnessSettings> | (() => HarnessSettings) = {},
  ) {
    super(config, request, settings, "azure");
  }
}

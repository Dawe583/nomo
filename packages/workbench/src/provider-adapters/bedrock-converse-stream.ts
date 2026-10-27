import { defaultProvider } from "@aws-sdk/credential-provider-node";
import type { Model, ModelMessage, ModelReply, ToolCall } from "../provider.ts";
import { ProviderRequestError } from "../provider.ts";
import { defaultHarnessSettings, type HarnessSettings } from "../harness-settings.ts";
import type {
  AwsCredentialProvider,
  ProviderAdapterConfig,
  ProviderClient,
} from "./types.ts";
import { signBedrockRequest, type AwsCredentials } from "./aws-sigv4.ts";

const MAX_FRAME_BYTES = 2_000_000;
type StreamEvent = { type: string; payload: Record<string, unknown>; exceptionType?: string };
type ToolBlock = { id: string; name: string; input: string };
const STREAM_EXCEPTION_STATUSES: Readonly<Record<string, number>> = {
  ValidationException: 400,
  ThrottlingException: 429,
  ServiceUnavailableException: 503,
  ModelStreamErrorException: 424,
  InternalServerException: 500,
};

function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function decodeHeaders(bytes: Uint8Array): Record<string, string> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const headers: Record<string, string> = {};
  let offset = 0;
  while (offset < bytes.length) {
    const nameLength = bytes[offset++];
    if (nameLength === undefined || offset + nameLength + 1 > bytes.length) throw new Error("Bedrock stream contains invalid headers.");
    const name = new TextDecoder().decode(bytes.subarray(offset, offset + nameLength));
    offset += nameLength;
    const type = bytes[offset++];
    if (!name || type === undefined || name in headers) throw new Error("Bedrock stream contains invalid headers.");
    let value: string;
    if (type === 0 || type === 1) value = type === 0 ? "true" : "false";
    else if (type === 2) { if (offset + 1 > bytes.length) throw new Error("Bedrock stream contains invalid headers."); value = String(view.getInt8(offset)); offset += 1; }
    else if (type === 3) { if (offset + 2 > bytes.length) throw new Error("Bedrock stream contains invalid headers."); value = String(view.getInt16(offset)); offset += 2; }
    else if (type === 4) { if (offset + 4 > bytes.length) throw new Error("Bedrock stream contains invalid headers."); value = String(view.getInt32(offset)); offset += 4; }
    else if (type === 5 || type === 8) { if (offset + 8 > bytes.length) throw new Error("Bedrock stream contains invalid headers."); value = String(view.getBigInt64(offset)); offset += 8; }
    else if (type === 6 || type === 7) {
      if (offset + 2 > bytes.length) throw new Error("Bedrock stream contains invalid headers.");
      const length = view.getUint16(offset);
      offset += 2;
      if (offset + length > bytes.length) throw new Error("Bedrock stream contains invalid headers.");
      value = new TextDecoder().decode(bytes.subarray(offset, offset + length));
      offset += length;
    } else if (type === 9) {
      if (offset + 16 > bytes.length) throw new Error("Bedrock stream contains invalid headers.");
      value = Buffer.from(bytes.subarray(offset, offset + 16)).toString("hex");
      offset += 16;
    } else throw new Error("Bedrock stream contains an unsupported header type.");
    headers[name] = value;
  }
  return headers;
}

function decodeFrame(frame: Uint8Array): StreamEvent {
  const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
  const totalLength = view.getUint32(0);
  const headersLength = view.getUint32(4);
  if (totalLength !== frame.length || totalLength < 16 || headersLength > totalLength - 16) throw new Error("Bedrock stream contains an invalid frame.");
  if (view.getUint32(8) !== crc32(frame.subarray(0, 8))) throw new Error("Bedrock stream prelude checksum failed.");
  if (view.getUint32(totalLength - 4) !== crc32(frame.subarray(0, totalLength - 4))) throw new Error("Bedrock stream message checksum failed.");
  const headers = decodeHeaders(frame.subarray(12, 12 + headersLength));
  const exceptionType = headers[":exception-type"];
  if (headers[":message-type"] === "exception") {
    if (!exceptionType) throw new Error("Bedrock stream returned an error event.");
    return { type: "exception", payload: {}, exceptionType };
  }
  const type = headers[":event-type"];
  if (!type || headers[":message-type"] !== "event") throw new Error("Bedrock stream returned an invalid event.");
  let payload: unknown;
  try { payload = JSON.parse(new TextDecoder().decode(frame.subarray(12 + headersLength, totalLength - 4))); }
  catch { throw new Error("Bedrock stream returned malformed event data."); }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error("Bedrock stream returned malformed event data.");
  return { type, payload: payload as Record<string, unknown> };
}

function encodeModelPath(model: string): string {
  return encodeURIComponent(model).replace(/[!'()*]/g, char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
}


export class BedrockConverseStreamAdapter implements ProviderClient {
  private readonly endpoint: URL;
  private readonly region: string;
  private readonly model: string | undefined;
  private readonly request: typeof fetch;
  private readonly now: () => Date;
  private readonly resolveSettings: () => HarnessSettings;
  private readonly credentialProvider: AwsCredentialProvider;
  private credentials?: AwsCredentials;

  constructor(
    config: ProviderAdapterConfig,
    request: typeof fetch = fetch,
    now: () => Date = () => new Date(),
    settings: Partial<HarnessSettings> | (() => HarnessSettings) = {},
    credentialProvider: AwsCredentialProvider = defaultProvider(),
  ) {
    if (
      config.providerId !== "amazon-bedrock" ||
      config.transport !== "bedrock-converse-stream" ||
      config.auth.kind !== "aws-credential-chain"
    ) {
      throw new Error("Amazon Bedrock requires its manifest-approved AWS credential chain.");
    }
    this.endpoint = new URL(config.baseUrl.endsWith("/") ? config.baseUrl : `${config.baseUrl}/`);
    const match = this.endpoint.hostname.match(/^bedrock-runtime\.([a-z0-9-]+)\.amazonaws\.com$/);
    if (this.endpoint.protocol !== "https:" || !match || this.endpoint.port || this.endpoint.pathname !== "/" || this.endpoint.username || this.endpoint.password || this.endpoint.search || this.endpoint.hash) {
      throw new Error("Amazon Bedrock requires an official Bedrock Runtime endpoint.");
    }
    this.region = match[1]!;
    this.model = config.model;
    this.request = request;
    this.now = now;
    this.resolveSettings = typeof settings === "function" ? settings : () => ({ ...defaultHarnessSettings(), ...settings });
    this.credentialProvider = credentialProvider;
  }

  async models(): Promise<readonly Model[]> {
    if (!this.model) return [];
    await this.resolveCredentials();
    return [{ id: this.model, name: this.model }];
  }

  async complete(
    model: string,
    messages: readonly ModelMessage[],
    tools: readonly unknown[],
    signal: AbortSignal,
    onDelta?: (text: string) => void | Promise<void>,
  ): Promise<ModelReply> {
    if (!model || model.length > 2048) throw new Error("Bedrock model ID is invalid.");
    const request = this.requestBody(messages, tools);
    const body = JSON.stringify(request);
    const credentials = await this.resolveCredentials();
    const url = new URL(`model/${encodeModelPath(model)}/converse-stream`, this.endpoint);
    const headers = signBedrockRequest(url, body, credentials, this.region, this.now());
    let response: Response;
    try {
      response = await this.request(url, {
        method: "POST",
        headers: { ...headers, accept: "application/vnd.amazon.eventstream" },
        body,
        redirect: "error",
        signal: AbortSignal.any([signal, AbortSignal.timeout(60000)]),
      });
      if (!response.ok) {
        await response.body?.cancel().catch(() => {});
        throw new ProviderRequestError(response.status);
      }
    } catch (error) {
      if (error instanceof ProviderRequestError) throw error;
      throw new Error(signal.aborted ? "Session cancelled." : "Provider connection failed. Check its endpoint and availability.");
    }
    return this.consume(response, signal, onDelta);
  }

  redact(text: string): string {
    return [
      this.credentials?.secretAccessKey,
      this.credentials?.accessKeyId,
      this.credentials?.sessionToken,
    ]
      .filter((secret): secret is string => Boolean(secret))
      .reduce((result, secret) => result.split(secret).join("[redacted]"), text);
  }
  private async resolveCredentials(): Promise<AwsCredentials> {
    try {
      const credentials = await this.credentialProvider();
      const { accessKeyId, secretAccessKey, sessionToken } = credentials;
      if (
        typeof accessKeyId !== "string" ||
        !accessKeyId ||
        typeof secretAccessKey !== "string" ||
        !secretAccessKey ||
        (sessionToken !== undefined && typeof sessionToken !== "string") ||
        /[\r\n]/.test(accessKeyId + secretAccessKey + (sessionToken ?? ""))
      ) {
        throw new Error("invalid credentials");
      }
      this.credentials = { accessKeyId, secretAccessKey, sessionToken };
      return this.credentials;
    } catch {
      throw new Error("AWS credential chain could not resolve valid credentials.");
    }
  }


  private requestBody(messages: readonly ModelMessage[], tools: readonly unknown[]): Record<string, unknown> {
    const system: Array<{ text: string }> = [];
    const bedrockMessages: Array<{ role: "user" | "assistant"; content: unknown[] }> = [];
    for (const message of messages) {
      if (message.role === "system") {
        if (message.content) system.push({ text: message.content });
      } else if (message.role === "tool") {
        if (!message.tool_call_id) throw new Error("Bedrock tool result is missing its call ID.");
        bedrockMessages.push({ role: "user", content: [{ toolResult: { toolUseId: message.tool_call_id, content: [{ text: message.content ?? "" }] } }] });
      } else if (message.role === "assistant" && message.tool_calls?.length) {
        const content: unknown[] = message.content?.trim() ? [{ text: message.content }] : [];
        for (const call of message.tool_calls) {
          let input: unknown;
          try { input = JSON.parse(call.function.arguments); }
          catch { throw new Error("Prior Bedrock tool arguments are invalid."); }
          if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Prior Bedrock tool arguments are invalid.");
          content.push({ toolUse: { toolUseId: call.id, name: call.function.name, input } });
        }
        bedrockMessages.push({ role: "assistant", content });
      } else {
        bedrockMessages.push({ role: message.role === "assistant" ? "assistant" : "user", content: [{ text: message.content ?? "" }] });
      }
    }
    const declarations = tools.map(value => {
      const fn = (value as { function?: { name?: unknown; description?: unknown; parameters?: unknown } })?.function;
      if (
        typeof fn?.name !== "string" ||
        !/^[a-zA-Z0-9_-]{1,64}$/.test(fn.name) ||
        !fn.parameters ||
        typeof fn.parameters !== "object" ||
        Array.isArray(fn.parameters) ||
        (fn.description !== undefined && (typeof fn.description !== "string" || fn.description.length === 0))
      ) {
        throw new Error("Provider tool definition is invalid.");
      }
      return { toolSpec: { name: fn.name, ...(typeof fn.description === "string" ? { description: fn.description } : {}), inputSchema: { json: fn.parameters } } };
    });
    return {
      messages: bedrockMessages,
      ...(system.length ? { system } : {}),
      ...(declarations.length ? { toolConfig: { tools: declarations } } : {}),
      inferenceConfig: { maxTokens: this.resolveSettings().maxOutputTokens },
    };
  }

  private async consume(response: Response, signal: AbortSignal, onDelta?: (text: string) => void | Promise<void>): Promise<ModelReply> {
    if (!response.body) throw new Error("Bedrock returned an empty stream.");
    if (response.headers.get("content-type")?.split(";")[0]?.trim() !== "application/vnd.amazon.eventstream") {
      throw new Error("Bedrock returned an unsupported stream content type.");
    }
    const reader = response.body.getReader();
    let pending = Buffer.alloc(0);
    let text = "";
    let stopReason: string | undefined;
    let messageStopped = false;
    let usage: ModelReply["usage"];
    const tools = new Map<number, ToolBlock>();
    try {
      while (true) {
        signal.throwIfAborted();
        const { value, done } = await reader.read();
        if (value) pending = Buffer.concat([pending, value]);
        while (pending.length >= 12) {
          const totalLength = pending.readUInt32BE(0);
          if (totalLength < 16 || totalLength > MAX_FRAME_BYTES) throw new Error("Bedrock stream contains an invalid frame length.");
          if (pending.length < totalLength) break;
          const frame = pending.subarray(0, totalLength);
          pending = pending.subarray(totalLength);
          const event = decodeFrame(frame);
          const payload = event.payload;
          if (messageStopped && event.type !== "metadata") throw new Error("Bedrock returned data after messageStop.");
          if (event.exceptionType) {
            const exceptionName = `${event.exceptionType[0]?.toUpperCase()}${event.exceptionType.slice(1)}`;
            const status = Object.hasOwn(STREAM_EXCEPTION_STATUSES, exceptionName)
              ? STREAM_EXCEPTION_STATUSES[exceptionName]
              : undefined;
            if (status === undefined) throw new Error("Bedrock stream returned an error event.");
            throw new ProviderRequestError(status);
          }
          if (event.type === "contentBlockStart") {
            const block = payload.contentBlockStart as { contentBlockIndex?: unknown; start?: { toolUse?: { toolUseId?: unknown; name?: unknown } } } | undefined;
            const index = block?.contentBlockIndex;
            const tool = block?.start?.toolUse;
            if (typeof index === "number" && tool) {
              if (typeof tool.toolUseId !== "string" || typeof tool.name !== "string" || tools.has(index)) throw new Error("Bedrock returned an invalid tool call.");
              tools.set(index, { id: tool.toolUseId, name: tool.name, input: "" });
            }
          } else if (event.type === "contentBlockDelta") {
            const block = payload.contentBlockDelta as { contentBlockIndex?: unknown; delta?: unknown } | undefined;
            const delta = block?.delta;
            if (!delta || typeof delta !== "object" || Array.isArray(delta)) throw new Error("Bedrock returned an unsupported content block delta.");
            const variants = Object.keys(delta);
            if (variants.length !== 1 || (variants[0] !== "text" && variants[0] !== "toolUse")) {
              throw new Error("Bedrock returned an unsupported content block delta.");
            }
            if (variants[0] === "text") {
              if (!("text" in delta) || typeof delta.text !== "string") throw new Error("Bedrock returned an invalid text delta.");
              text += delta.text;
              if (text.length > MAX_FRAME_BYTES) throw new Error("Bedrock response exceeded the supported size.");
              await onDelta?.(delta.text);
            } else {
              if (
                typeof block?.contentBlockIndex !== "number" ||
                !("toolUse" in delta) ||
                !delta.toolUse ||
                typeof delta.toolUse !== "object" ||
                Array.isArray(delta.toolUse) ||
                !("input" in delta.toolUse) ||
                typeof delta.toolUse.input !== "string"
              ) {
                throw new Error("Bedrock returned an invalid tool input delta.");
              }
              const tool = tools.get(block.contentBlockIndex);
              if (!tool) throw new Error("Bedrock returned an invalid tool input delta.");
              tool.input += delta.toolUse.input;
              if (tool.input.length > MAX_FRAME_BYTES) throw new Error("Bedrock tool input exceeded the supported size.");
            }
          } else if (event.type === "messageStop") {
            const stop = payload.messageStop as { stopReason?: unknown } | undefined;
            if (typeof stop?.stopReason !== "string") throw new Error("Bedrock returned no stop reason.");
            stopReason = stop.stopReason;
            messageStopped = true;
          } else if (event.type === "metadata") {
            const metadata = payload.metadata as { usage?: { inputTokens?: unknown; outputTokens?: unknown; totalTokens?: unknown } } | undefined;
            if (metadata?.usage) usage = {
              prompt_tokens: typeof metadata.usage.inputTokens === "number" ? metadata.usage.inputTokens : undefined,
              completion_tokens: typeof metadata.usage.outputTokens === "number" ? metadata.usage.outputTokens : undefined,
              total_tokens: typeof metadata.usage.totalTokens === "number" ? metadata.usage.totalTokens : undefined,
            };
          } else if (!["messageStart", "contentBlockStop"].includes(event.type)) {
            throw new Error("Bedrock returned an unsupported stream event.");
          }
        }
        if (pending.length > MAX_FRAME_BYTES) throw new Error("Bedrock stream frame exceeded the supported size.");
        if (done) break;
      }
      if (pending.length || !stopReason) throw new Error("Bedrock stream ended before completion.");
      if (stopReason !== "end_turn" && stopReason !== "tool_use") throw new Error("Bedrock response was blocked or truncated. No tools were executed.");
      const toolCalls: ToolCall[] = [...tools.values()].map(tool => {
        let parsed: unknown;
        try { parsed = JSON.parse(tool.input); }
        catch { throw new Error("Bedrock returned invalid tool arguments."); }
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Bedrock returned invalid tool arguments.");
        return { id: tool.id, type: "function", function: { name: tool.name, arguments: JSON.stringify(parsed) } };
      });
      if (!text.trim() && !toolCalls.length) throw new Error("Bedrock returned no answer. Retry the response.");
      return { message: { role: "assistant", content: text || null, ...(toolCalls.length ? { tool_calls: toolCalls } : {}) }, usage };
    } finally {
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
  }
}

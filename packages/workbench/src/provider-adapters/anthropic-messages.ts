import type { ModelMessage, ModelReply, ToolCall } from "../provider.ts";
import type { HarnessSettings } from "../harness-settings.ts";
import { isRecord } from "./guards.ts";

export type AnthropicMessagesDependencies = {
  readonly send: (body: unknown, signal: AbortSignal) => Promise<unknown>;
  readonly stream: (body: unknown, signal: AbortSignal) => Promise<Response>;
  readonly redact: (text: string) => string;
  readonly apiKey: string;
  readonly resolveSettings: () => HarnessSettings;
};

const MAX_STREAM_CHARS = 2_000_000;
const MAX_TOOL_ARGUMENT_CHARS = 1_000_000;

type StreamBlock =
  | { kind: "text"; text: string; stopped: boolean }
  | { kind: "tool"; id: string; name: string; initialInput: Record<string, unknown>; arguments: string; hasArguments: boolean; stopped: boolean }
  | { kind: "ignored"; stopped: boolean };
export class AnthropicMessagesAdapter {
  private readonly dependencies: AnthropicMessagesDependencies;

  constructor(dependencies: AnthropicMessagesDependencies) {
    this.dependencies = dependencies;
  }

  async complete(
    model: string,
    messages: readonly ModelMessage[],
    tools: readonly unknown[],
    signal: AbortSignal,
    onDelta?: (text: string) => void | Promise<void>,
  ): Promise<ModelReply> {
    const converted: Array<{ role: string; content: unknown }> = [];
    for (const message of messages.filter(item => item.role !== "system")) {
      if (message.role === "tool") {
        const block = { type: "tool_result", tool_use_id: message.tool_call_id, content: message.content ?? "" };
        const previous = converted.at(-1);
        if (previous?.role === "user" && Array.isArray(previous.content)) previous.content.push(block);
        else converted.push({ role: "user", content: [block] });
      } else if (message.tool_calls?.length) {
        converted.push({
          role: "assistant",
          content: [
            ...(message.content ? [{ type: "text", text: message.content }] : []),
            ...message.tool_calls.map(call => ({
              type: "tool_use",
              id: call.id,
              name: call.function.name,
              input: JSON.parse(call.function.arguments) as unknown,
            })),
          ],
        });
      } else converted.push({ role: message.role, content: message.content ?? "" });
    }
    const request = {
      model,
      max_tokens: this.dependencies.resolveSettings().maxOutputTokens,
      system: messages.filter(message => message.role === "system").map(message => message.content).join("\n"),
      messages: converted,
      ...(tools.length ? {
        tools: tools.map(value => {
          const tool = value as { function: { name: string; description: string; parameters: unknown } };
          return { name: tool.function.name, description: tool.function.description, input_schema: tool.function.parameters };
        }),
      } : {}),
    };
    const body = onDelta
      ? await this.consumeStream(await this.dependencies.stream({ ...request, stream: true }, signal), signal, onDelta)
      : await this.dependencies.send(request, signal);
    const result = body as {
      content?: Array<{ type: string; text?: string; id?: string; name?: string; input?: unknown }>;
      stop_reason?: string | null;
      usage?: { input_tokens?: number; output_tokens?: number };
    };
    if (result.stop_reason === "max_tokens") throw new Error("Anthropic response was truncated because max_tokens was reached.");
    if (result.stop_reason === "model_context_window_exceeded") throw new Error("Anthropic response exceeded the model context window.");
    if (result.stop_reason === "pause_turn") throw new Error("Anthropic response paused before the turn completed; continuation is unsupported.");
    if (result.stop_reason !== "end_turn" && result.stop_reason !== "stop_sequence" && result.stop_reason !== "tool_use" && result.stop_reason !== "refusal") {
      throw new Error("Anthropic response has a missing or unsupported stop_reason.");
    }
    if (!Array.isArray(result.content)) throw new Error("Provider returned an invalid Anthropic response.");
    const calls: ToolCall[] = result.content.filter(block => block.type === "tool_use").map(block => {
      if (!block.id || !block.name || !block.input || typeof block.input !== "object") throw new Error("Invalid Anthropic tool call.");
      return { id: block.id, type: "function", function: { name: block.name, arguments: JSON.stringify(block.input) } };
    });
    return {
      message: {
        role: "assistant",
        content: result.content.filter(block => block.type === "text").map(block => block.text ?? "").join("\n"),
        ...(calls.length ? { tool_calls: calls } : {}),
      },
      usage: result.usage ? {
        prompt_tokens: result.usage.input_tokens,
        completion_tokens: result.usage.output_tokens,
        total_tokens: (result.usage.input_tokens ?? 0) + (result.usage.output_tokens ?? 0),
      } : undefined,
    };
  }

  private async consumeStream(
    response: Response,
    signal: AbortSignal,
    onDelta: (text: string) => void | Promise<void>,
  ): Promise<unknown> {
    if (!response.headers.get("content-type")?.toLowerCase().includes("text/event-stream") || !response.body) {
      await response.body?.cancel().catch(() => {});
      throw new Error("Anthropic returned an invalid event stream.");
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    const blocks = new Map<number, StreamBlock>();
    let buffer = "";
    let dataLines: string[] = [];
    let dataLength = 0;
    let eventName = "";
    let started = false;
    let messageDeltaStarted = false;
    let terminal = false;
    let stopReason: string | null | undefined;
    let inputTokens: number | undefined;
    let outputTokens: number | undefined;
    let textLength = 0;
    let toolArgumentLength = 0;
    let streamLength = 0;
    let emission = "";

    const emit = async (value: string, flush = false): Promise<void> => {
      emission = this.dependencies.redact(emission + value);
      let hold = 0;
      const secret = this.dependencies.apiKey;
      if (secret) {
        for (let index = 1; index < secret.length; index++) {
          if (emission.endsWith(secret.slice(0, index))) hold = index;
        }
      }
      if (flush && hold) {
        emission = `${emission.slice(0, emission.length - hold)}[redacted]`;
        hold = 0;
      }
      const visible = emission.slice(0, emission.length - hold);
      emission = hold ? emission.slice(-hold) : "";
      if (visible) await onDelta(visible);
    };

    const consumeEvent = async (): Promise<void> => {
      if (!dataLines.length) {
        eventName = "";
        return;
      }
      const data = dataLines.join("\n");
      const sourceEventName = eventName;
      dataLines = [];
      dataLength = 0;
      eventName = "";
      let event: unknown;
      try { event = JSON.parse(data); } catch { throw new Error("Anthropic returned an invalid event stream."); }
      if (!isRecord(event) || typeof event.type !== "string" || (sourceEventName && sourceEventName !== event.type)) {
        throw new Error("Anthropic returned an invalid event stream.");
      }
      if (terminal) throw new Error("Anthropic returned data after message_stop.");
      switch (event.type) {
        case "error":
          throw new Error("Anthropic returned an error event.");
        case "message_start": {
          const message = event.message;
          if (started || !isRecord(message) || !Array.isArray(message.content) || message.content.length !== 0 || !isRecord(message.usage) ||
              !Number.isSafeInteger(message.usage.input_tokens) || (message.usage.input_tokens as number) < 0) {
            throw new Error("Anthropic returned an invalid message_start event.");
          }
          started = true;
          inputTokens = message.usage.input_tokens as number;
          break;
        }
        case "content_block_start": {
          const block = event.content_block;
          if (!started || messageDeltaStarted || !Number.isSafeInteger(event.index) || (event.index as number) < 0 ||
              blocks.has(event.index as number) || !isRecord(block) || typeof block.type !== "string") {
            throw new Error("Anthropic returned an invalid content block.");
          }
          if (block.type === "text") {
            if (block.text !== undefined && block.text !== "") throw new Error("Anthropic returned an invalid text block.");
            blocks.set(event.index as number, { kind: "text", text: "", stopped: false });
          } else if (block.type === "tool_use") {
            if (typeof block.id !== "string" || !block.id || typeof block.name !== "string" || !block.name || !isRecord(block.input) ||
                JSON.stringify(block.input).length > MAX_TOOL_ARGUMENT_CHARS) {
              throw new Error("Anthropic returned an invalid tool block.");
            }
            blocks.set(event.index as number, {
              kind: "tool",
              id: block.id,
              name: block.name,
              initialInput: block.input,
              arguments: "",
              hasArguments: false,
              stopped: false,
            });
          } else blocks.set(event.index as number, { kind: "ignored", stopped: false });
          break;
        }
        case "content_block_delta": {
          const block = blocks.get(event.index as number);
          const delta = event.delta;
          if (!started || messageDeltaStarted || !Number.isSafeInteger(event.index) || !block || block.stopped || !isRecord(delta) || typeof delta.type !== "string") throw new Error("Anthropic returned an invalid content block delta.");
          if (block.kind === "text") {
            if (delta.type !== "text_delta" || typeof delta.text !== "string") throw new Error("Anthropic returned an unsupported text delta.");
            textLength += delta.text.length;
            if (textLength > MAX_STREAM_CHARS) throw new Error("Anthropic response exceeded the supported size.");
            block.text += delta.text;
            await emit(delta.text);
          } else if (block.kind === "tool") {
            if (delta.type !== "input_json_delta" || typeof delta.partial_json !== "string") throw new Error("Anthropic returned an unsupported tool delta.");
            toolArgumentLength += delta.partial_json.length;
            if (toolArgumentLength > MAX_TOOL_ARGUMENT_CHARS) throw new Error("Anthropic tool arguments exceeded the supported size.");
            block.arguments += delta.partial_json;
            block.hasArguments = true;
          }
          break;
        }
        case "content_block_stop": {
          const block = blocks.get(event.index as number);
          if (!started || messageDeltaStarted || !Number.isSafeInteger(event.index) || !block || block.stopped) throw new Error("Anthropic returned an invalid content block stop.");
          block.stopped = true;
          break;
        }
        case "message_delta": {
          if (!started || [...blocks.values()].some(block => !block.stopped) || !isRecord(event.delta) || (event.delta.stop_reason !== null && typeof event.delta.stop_reason !== "string") ||
              !isRecord(event.usage) || !Number.isSafeInteger(event.usage.output_tokens) || (event.usage.output_tokens as number) < 0) {
            throw new Error("Anthropic returned an invalid message_delta event.");
          }
          messageDeltaStarted = true;
          stopReason = event.delta.stop_reason as string | null;
          outputTokens = event.usage.output_tokens as number;
          break;
        }
        case "message_stop":
          if (!started || !messageDeltaStarted || stopReason == null || [...blocks.values()].some(block => !block.stopped)) {
            throw new Error("Anthropic returned an incomplete message stream.");
          }
          terminal = true;
          break;
        default:
          break;
      }
    };

    const consumeLine = async (line: string): Promise<void> => {
      if (line.endsWith("\r")) line = line.slice(0, -1);
      if (!line) return consumeEvent();
      if (line.startsWith(":")) return;
      if (line.startsWith("event:")) eventName = line.slice(6).trim();
      else if (line.startsWith("data:")) {
        const value = line.slice(5).replace(/^ /, "");
        dataLength += value.length + (dataLines.length ? 1 : 0);
        if (dataLength > MAX_STREAM_CHARS) throw new Error("Anthropic stream frame exceeded the supported size.");
        dataLines.push(value);
      }
    };

    try {
      while (!terminal) {
        signal.throwIfAborted();
        const { value, done } = await reader.read();
        const chunk = decoder.decode(value, { stream: !done });
        streamLength += value?.byteLength ?? 0;
        if (streamLength > MAX_STREAM_CHARS) throw new Error("Anthropic stream exceeded the supported size.");
        buffer += chunk;
        if (buffer.length > MAX_STREAM_CHARS) throw new Error("Anthropic stream exceeded the supported size.");
        let newline: number;
        while ((newline = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, newline);
          buffer = buffer.slice(newline + 1);
          await consumeLine(line);
          if (terminal) break;
        }
        if (done) {
          if (buffer) await consumeLine(buffer);
          if (!terminal && dataLines.length) await consumeEvent();
          break;
        }
      }
      if (!terminal || buffer.trim() || dataLines.length) throw new Error("Anthropic stream ended before message_stop.");
      await emit("", true);
      const content: Array<{ type: string; text?: string; id?: string; name?: string; input?: unknown }> = [];
      for (const [, block] of [...blocks.entries()].sort(([a], [b]) => a - b)) {
        if (block.kind === "text") content.push({ type: "text", text: block.text });
        else if (block.kind === "tool") {
          let input: unknown = block.initialInput;
          if (block.hasArguments) {
            try { input = JSON.parse(block.arguments); } catch { throw new Error("Anthropic returned invalid tool arguments."); }
            if (!isRecord(input)) throw new Error("Anthropic returned invalid tool arguments.");
          }
          content.push({ type: "tool_use", id: block.id, name: block.name, input });
        }
      }
      return {
        content,
        stop_reason: stopReason,
        usage: inputTokens !== undefined && outputTokens !== undefined
          ? { input_tokens: inputTokens, output_tokens: outputTokens }
          : undefined,
      };
    } catch (error) {
      if (signal.aborted) throw new Error("Session cancelled.");
      if (error instanceof DOMException && error.name === "TimeoutError")
        throw new Error("Provider request timed out.");
      throw new Error("Anthropic stream failed before completion.");
    } finally {
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
  }
}

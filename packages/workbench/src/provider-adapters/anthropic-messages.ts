import type { ModelMessage, ModelReply, ToolCall } from "../provider.ts";
import type { HarnessSettings } from "../harness-settings.ts";

export type AnthropicMessagesDependencies = {
  readonly send: (body: unknown, signal: AbortSignal) => Promise<unknown>;
  readonly resolveSettings: () => HarnessSettings;
};

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
    const body = await this.dependencies.send({
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
    }, signal);
    const result = body as {
      content?: Array<{ type: string; text?: string; id?: string; name?: string; input?: unknown }>;
      usage?: { input_tokens?: number; output_tokens?: number };
    };
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
}

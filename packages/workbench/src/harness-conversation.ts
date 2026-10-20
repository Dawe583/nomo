/**
 * The conversation tail the reviewer may see.
 *
 * The reviewer is blind to the conversation without it. It sees mined
 * lessons and the refusals in force, which is enough to spot a shape but not
 * enough to tell what the operator was actually trying to do, so a blind
 * reviewer tends to propose the same generic lesson again.
 *
 * The conversation is also the one place in this package where raw text
 * lives: the operator's own words, the model's own words, the arguments the
 * model wrote for a tool, and the decoded result a tool returned. Only the
 * provider key is scrubbed from any of it today, so a tail cut without
 * exclusions would carry a pasted credential to the provider and into a
 * prompt that is not a secret-free surface.
 *
 * Four rules hold for what leaves here, and the module exists to enforce
 * them rather than to hope the caller does:
 *
 * 1. A tool message never travels. A tool result is an upstream payload.
 * 2. Tool call arguments never travel. They are model authored JSON that can
 *    quote a document, and a document can hold anything.
 * 3. A system message never travels. The standing instruction and the
 *    learned entry digest block are the harness's own, and a harness entry
 *    must not reach the reviewer twice.
 * 4. A message is cut at a marked boundary, never silently. A message longer
 *    than the per message cap keeps its last characters and says that the
 *    earlier part was omitted, because a half message presented as a whole
 *    one is how a reviewer learns something that was never said.
 *
 * A tail whose text carries a secret is withheld whole rather than trimmed:
 * the review still runs on the chain evidence, and the operator is told that
 * the conversation was not sent. Trimming a secret out of a tail would leave
 * the operator believing the reviewer saw the conversation.
 */
import type { ModelMessage } from "./provider.ts";

/** How many messages the tail may hold. */
export const CONVERSATION_TAIL_MESSAGES = 6;

/** How much of one message the tail may hold. */
export const CONVERSATION_TAIL_MESSAGE_CHARACTERS = 800;

/** How much the whole tail may hold. */
export const CONVERSATION_TAIL_CHARACTERS = 4000;

export type ConversationTail = {
  /** The text to send, empty when the tail was withheld. */
  readonly text: string;
  /** True when the tail was withheld because it carried secret-like text. */
  readonly withheld: boolean;
  /** How many messages the tail holds. */
  readonly messages: number;
};

export type ConversationTailOptions = {
  /** Replaces a known secret with a marker. Applied before the scan. */
  readonly redact?: (text: string) => string;
  /** Decides whether a text carries a secret. The whole tail is withheld
   * when it does, not trimmed. */
  readonly isSecretLike?: (text: string) => boolean;
};

/** The messages a tail may hold: what an operator or the model said, and
 * nothing else. A message that carries tool calls is excluded whole, because
 * its arguments are the part that can quote a document. */
function eligible(messages: readonly ModelMessage[]): ModelMessage[] {
  return messages.filter(
    (message) =>
      (message.role === "user" || message.role === "assistant") &&
      !message.tool_calls &&
      typeof message.content === "string" &&
      message.content.trim().length > 0,
  );
}

/** One message, cut at a marked boundary. */
function render(message: ModelMessage): string {
  const content = (message.content ?? "").trim();
  if (content.length <= CONVERSATION_TAIL_MESSAGE_CHARACTERS)
    return `${message.role}: ${content}`;
  const kept = content.slice(content.length - CONVERSATION_TAIL_MESSAGE_CHARACTERS);
  return `${message.role}: (earlier part omitted) ${kept}`;
}

/**
 * Build the tail.
 *
 * The newest messages win: a tail that holds the oldest exchanges of a long
 * conversation says nothing about how the conversation ended.
 */
export function buildConversationTail(
  messages: readonly ModelMessage[],
  options: ConversationTailOptions = {},
): ConversationTail {
  const eligibleMessages = eligible(messages).slice(-CONVERSATION_TAIL_MESSAGES);
  if (!eligibleMessages.length) return { text: "", withheld: false, messages: 0 };
  let rendered = eligibleMessages.map(render).join("\n");
  // The whole tail is capped, and the oldest message is the one that goes:
  // the newest exchange is the one the reviewer needs.
  while (rendered.length > CONVERSATION_TAIL_CHARACTERS && eligibleMessages.length > 1) {
    eligibleMessages.shift();
    rendered = eligibleMessages.map(render).join("\n");
  }
  if (rendered.length > CONVERSATION_TAIL_CHARACTERS)
    rendered = rendered.slice(rendered.length - CONVERSATION_TAIL_CHARACTERS);
  const redacted = options.redact ? options.redact(rendered) : rendered;
  if (options.isSecretLike?.(redacted))
    return { text: "", withheld: true, messages: eligibleMessages.length };
  return { text: redacted, withheld: false, messages: eligibleMessages.length };
}

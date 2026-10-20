/**
 * The harness tools an agent can call.
 *
 * The harness learns from what the agent sees, and until now the only way a
 * lesson entered it was a review round the model paid for. The agent often
 * knows the same thing and sooner: the operator asked for the same thing
 * three times, and the agent noticed.
 *
 * The tool writes a proposal, never a change. A proposal is inert until an
 * operator approves its exact digest, and an approval is a human act with a
 * human reading the text. An agent that could write its own instructions
 * would be an agent that could talk itself out of every boundary above it,
 * so the tool stops at the proposal and the operator decides.
 *
 * The proposal cites the chain records it was derived from, because the
 * chain is signed and an uncited claim cannot be recorded. The agent does
 * not know those sequence numbers, so the tool cites the head of the chain
 * it observed: the records the agent was looking at when it decided that
 * something was worth remembering.
 */
import type { RefinementProposal } from "./refine-pass.ts";

export const HARNESS_ADD_TOOL = "void_harness_add";
export const HARNESS_FORGET_TOOL = "void_harness_forget";

export const HARNESS_TOOLS = [
  {
    name: HARNESS_ADD_TOOL,
    description:
      "Propose a lesson the harness should remember. The proposal waits for an operator to approve its exact digest; nothing changes until then.",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", description: "What the lesson is about." },
        content: { type: "string", description: "The lesson itself." },
        reason: { type: "string", description: "Why it is worth keeping." },
      },
      required: ["title", "content", "reason"],
      additionalProperties: false,
    },
  },
  {
    name: HARNESS_FORGET_TOOL,
    description:
      "Propose that the harness forget a lesson it holds. The proposal waits for an operator to approve its exact digest; nothing changes until then.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "The id of the lesson to forget." },
        reason: { type: "string", description: "Why it should be forgotten." },
      },
      required: ["id", "reason"],
      additionalProperties: false,
    },
  },
] as const;

export type HarnessToolArgs = {
  readonly title?: unknown;
  readonly content?: unknown;
  readonly reason?: unknown;
  readonly id?: unknown;
};

export type HarnessToolPlan =
  | { readonly ok: true; readonly proposal: RefinementProposal }
  | { readonly ok: false; readonly reason: string };

/**
 * The proposal a tool call asks for.
 *
 * Pure, so the rules are testable without a session: a lesson without a
 * title, a content or a reason is refused here, and a proposal that cites
 * no record is refused here too, because the chain cannot record an
 * uncited claim.
 */
export function harnessToolPlan(
  tool: string,
  args: HarnessToolArgs,
  derivedFromSeq: readonly number[],
): HarnessToolPlan {
  const text = (value: unknown) =>
    typeof value === "string" ? value.trim() : "";
  const reason = text(args.reason);
  if (!reason)
    return { ok: false, reason: "A harness proposal needs a reason: why it is worth keeping." };
  if (!derivedFromSeq.length)
    return {
      ok: false,
      reason:
        "The workspace chain holds no record to cite, so there is nothing a proposal could rest on.",
    };
  if (tool === HARNESS_ADD_TOOL) {
    const title = text(args.title);
    const content = text(args.content);
    if (!title || !content)
      return {
        ok: false,
        reason: "A lesson needs a title and a content: what it is about, and what it says.",
      };
    return {
      ok: true,
      proposal: {
        summary: title,
        rationale: reason,
        expectedOutcome: "The harness holds the lesson, once an operator approves it.",
        edits: [
          {
            action: "create",
            kind: "memory",
            title,
            content,
            derivedFromSeq: [...derivedFromSeq],
            reason,
          },
        ],
      },
    };
  }
  if (tool === HARNESS_FORGET_TOOL) {
    const id = text(args.id);
    if (!id)
      return { ok: false, reason: "A lesson can only be forgotten by its id." };
    return {
      ok: true,
      proposal: {
        summary: `Forget ${id}`,
        rationale: reason,
        expectedOutcome: "The harness stops holding the lesson, once an operator approves it.",
        edits: [
          {
            action: "delete",
            kind: "memory",
            id,
            derivedFromSeq: [...derivedFromSeq],
            reason,
          },
        ],
      },
    };
  }
  return { ok: false, reason: `Unknown harness tool ${tool}.` };
}

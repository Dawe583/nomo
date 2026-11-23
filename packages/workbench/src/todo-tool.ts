/**
 * The `todo_write` tool.
 *
 * The TUI used to derive its checklist by scanning assistant markdown, which
 * meant a plan could only be shown if the model happened to write it as a
 * task list, and the active row could only be guessed from other session
 * state. This tool makes the checklist a first-class record: the model states
 * the items and their states, and the Workbench emits them as a real event.
 *
 * The tool has no other effect. It writes no document, runs no command, and
 * reaches no connector, so an operator can allow it without widening the
 * authority of a run. It never invents an item either: every row comes from
 * the model's own arguments, and a call that does not validate is refused
 * rather than repaired.
 */
export const TODO_WRITE_TOOL = {
  name: "todo_write",
  description:
    "Record the checklist for the current run so the operator's TODO rail shows the real plan. Send the complete list in display order every time, including the rows that did not change, and set exactly the state each row is in. It writes no document and runs no command.",
  inputSchema: {
    type: "object",
    properties: {
      items: {
        type: "array",
        description: "The complete checklist, 1 to 50 items, in display order.",
        minItems: 1,
        maxItems: 50,
        items: {
          type: "object",
          properties: {
            text: {
              type: "string",
              description: "One line of printable text, at most 200 characters.",
              minLength: 1,
              maxLength: 200,
            },
            status: {
              type: "string",
              description:
                "pending before work starts, in_progress while it is happening, completed when it is done.",
              enum: ["pending", "in_progress", "completed"],
            },
          },
          required: ["text", "status"],
          additionalProperties: false,
        },
      },
    },
    required: ["items"],
    additionalProperties: false,
  },
} as const;

/** The agent tool registry entry, in the same shape as the workspace tools. */
export const TODO_TOOLS = [TODO_WRITE_TOOL] as const;

export type TodoStatus = "pending" | "in_progress" | "completed";

export interface TodoWriteItem {
  readonly text: string;
  readonly status: TodoStatus;
}

export type TodoWritePlan =
  | { readonly ok: true; readonly items: readonly TodoWriteItem[] }
  | { readonly ok: false; readonly reason: string };

export const TODO_MAX_ITEMS = 50;
export const TODO_MAX_TEXT = 200;

const TODO_STATUSES: readonly TodoStatus[] = [
  "pending",
  "in_progress",
  "completed",
];

function plainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Printable means one line the rail can print: no control characters. */
function printable(value: string): boolean {
  return !/[\x00-\x1f\x7f-\x9f]/.test(value);
}

/**
 * The checklist a call asks for, or the reason it cannot be shown.
 *
 * Pure, so the rules are testable without a session. Unknown fields are
 * refused instead of ignored: a provider that sends a state this tool does
 * not understand must not have the rest of the list quietly accepted with
 * that state missing.
 */
export function todoWritePlan(args: unknown): TodoWritePlan {
  if (!plainObject(args))
    return { ok: false, reason: "todo_write needs an object with an items array." };
  const unknownArgs = Object.keys(args).filter((key) => key !== "items");
  if (unknownArgs.length)
    return {
      ok: false,
      reason: `todo_write does not accept ${unknownArgs.join(", ")}; the only field is items.`,
    };
  const items = args.items;
  if (!Array.isArray(items))
    return { ok: false, reason: "todo_write needs an items array." };
  if (items.length === 0)
    return { ok: false, reason: "A checklist needs at least one item." };
  if (items.length > TODO_MAX_ITEMS)
    return {
      ok: false,
      reason: `A checklist holds at most ${TODO_MAX_ITEMS} items; this call sent ${items.length}.`,
    };
  const out: TodoWriteItem[] = [];
  for (const [index, item] of items.entries()) {
    const row = `Item ${index + 1}`;
    if (!plainObject(item))
      return { ok: false, reason: `${row} must be an object with text and status.` };
    const unknown = Object.keys(item).filter(
      (key) => key !== "text" && key !== "status",
    );
    if (unknown.length)
      return {
        ok: false,
        reason: `${row} does not accept ${unknown.join(", ")}; the only fields are text and status.`,
      };
    if (typeof item.text !== "string")
      return { ok: false, reason: `${row} needs a text string.` };
    if (item.text.length > TODO_MAX_TEXT)
      return {
        ok: false,
        reason: `${row} text is ${item.text.length} characters; the limit is ${TODO_MAX_TEXT}.`,
      };
    if (!printable(item.text))
      return { ok: false, reason: `${row} text must be one printable line.` };
    const text = item.text.trim();
    if (!text) return { ok: false, reason: `${row} text is empty.` };
    if (
      typeof item.status !== "string" ||
      !TODO_STATUSES.includes(item.status as TodoStatus)
    )
      return {
        ok: false,
        reason: `${row} status must be one of ${TODO_STATUSES.join(", ")}.`,
      };
    out.push({ text, status: item.status as TodoStatus });
  }
  return { ok: true, items: out };
}

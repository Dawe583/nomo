/**
 * The plan a conversation carries, as the model states it (HP4).
 *
 * `nomo_plan_update` replaces the whole plan instead of patching one item at a
 * time: the operator reads the plan as one account of the run, and a partial
 * patch leaves a list that no single call explains. The parser takes `unknown`
 * because the text arrives from a provider, so the rules live here where they
 * are testable without a session and every refusal names the field it refused.
 */

export const PLAN_LIMITS = {
  items: 50,
  idLength: 64,
  textLength: 500,
} as const;

export type PlanStatus = "pending" | "in_progress" | "done";

export type PlanItem = {
  readonly id: string;
  readonly text: string;
  readonly status: PlanStatus;
};

export const PLAN_TOOL = {
  name: "nomo_plan_update",
  description:
    "Replace the conversation plan with a bounded list of pending, in_progress and done items. Returns the complete stored plan.",
  inputSchema: {
    type: "object",
    properties: {
      items: {
        type: "array",
        maxItems: PLAN_LIMITS.items,
        items: {
          type: "object",
          properties: {
            id: { type: "string", maxLength: PLAN_LIMITS.idLength },
            text: { type: "string", maxLength: PLAN_LIMITS.textLength },
            status: { type: "string", enum: ["pending", "in_progress", "done"] },
          },
          required: ["id", "text", "status"],
          additionalProperties: false,
        },
      },
    },
    required: ["items"],
    additionalProperties: false,
  },
} as const;

const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/;

export function parsePlanUpdate(input: unknown): PlanItem[] {
  if (input === null || typeof input !== "object" || Array.isArray(input))
    throw new Error(
      "Invalid plan update: expected an object with an items array.",
    );
  const items = (input as { readonly items?: unknown }).items;
  if (!Array.isArray(items))
    throw new Error("Invalid plan update: items must be an array.");
  if (items.length > PLAN_LIMITS.items)
    throw new Error(
      `Invalid plan update: a plan holds at most ${PLAN_LIMITS.items} items, got ${items.length}.`,
    );
  const plan: PlanItem[] = [];
  const seen = new Set<string>();
  let inProgress = 0;
  for (const [index, raw] of (items as readonly unknown[]).entries()) {
    const where = `Invalid plan item ${index + 1}`;
    if (raw === null || typeof raw !== "object" || Array.isArray(raw))
      throw new Error(`${where}: expected an object with id, text and status.`);
    const candidate = raw as {
      readonly id?: unknown;
      readonly text?: unknown;
      readonly status?: unknown;
    };
    const id = field(where, "id", candidate.id, PLAN_LIMITS.idLength);
    const text = field(where, "text", candidate.text, PLAN_LIMITS.textLength);
    const status = candidate.status;
    if (status !== "pending" && status !== "in_progress" && status !== "done")
      throw new Error(
        `${where}: status must be pending, in_progress or done.`,
      );
    if (seen.has(id))
      throw new Error(`${where}: duplicate id ${JSON.stringify(id)}.`);
    seen.add(id);
    if (status === "in_progress") inProgress += 1;
    plan.push({ id, text, status });
  }
  if (inProgress > 1)
    throw new Error(
      `Invalid plan update: at most one item may be in_progress, got ${inProgress}.`,
    );
  return plan;
}

function field(
  where: string,
  name: string,
  value: unknown,
  maxLength: number,
): string {
  if (typeof value !== "string")
    throw new Error(`${where}: ${name} must be text.`);
  const trimmed = value.trim();
  if (!trimmed) throw new Error(`${where}: ${name} must not be empty.`);
  if (trimmed.length > maxLength)
    throw new Error(
      `${where}: ${name} is at most ${maxLength} characters, got ${trimmed.length}.`,
    );
  if (CONTROL_CHARACTER.test(trimmed))
    throw new Error(`${where}: ${name} contains a control character.`);
  return trimmed;
}

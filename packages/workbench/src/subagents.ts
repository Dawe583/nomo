// WP-SPAWN pure helpers. The orchestration lives in Workbench.spawnSubagent
// in index.ts; everything here is total and unit-testable on its own.
export type SpawnSubagentOptions = {
  readonly model?: string;
  readonly agent?: string;
  readonly idempotencyKey?: string;
};

export const SUBAGENT_IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9_.:-]{1,160}$/;

export function validateIdempotencyKey(
  key: string | undefined | null,
): string | undefined {
  if (key === undefined || key === null) return undefined;
  if (typeof key !== "string" || !SUBAGENT_IDEMPOTENCY_KEY_PATTERN.test(key))
    throw new Error("Invalid Idempotency key.");
  return key;
}

export function validateSpawnPrompt(prompt: string, max: number): string {
  const trimmed = prompt.trim();
  if (!trimmed || trimmed.length > max)
    throw new Error(
      `Enter a prompt between 1 and ${max} characters.`,
    );
  return trimmed;
}

export function spawnWorkspaceName(childId: string): string {
  return `agent-${childId}`;
}

export function subsetTools<T extends { readonly name: string }>(
  childTools: readonly T[],
  parentToolNames: ReadonlySet<string>,
): T[] {
  return childTools.filter((tool) => parentToolNames.has(tool.name));
}
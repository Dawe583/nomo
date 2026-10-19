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

type ToolScopeEntry = {
  readonly name: string;
  readonly connectorId?: string;
};

export function subsetTools<T extends ToolScopeEntry>(
  childTools: readonly T[],
  parentTools: readonly ToolScopeEntry[],
): T[] {
  const namesByConnector = new Map<string | undefined, Set<string>>();
  for (const tool of parentTools) {
    let names = namesByConnector.get(tool.connectorId);
    if (!names) {
      names = new Set();
      namesByConnector.set(tool.connectorId, names);
    }
    names.add(tool.name);
  }
  return childTools.filter((tool) =>
    namesByConnector.get(tool.connectorId)?.has(tool.name),
  );
}
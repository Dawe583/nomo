export type AgentProfile = {
  id: string;
  name: string;
  systemPrompt: string;
  allowedTools: string[];
  policyProfile: string;
  maxTurns: number;
  maxContextTokens: number;
};

export type Hook = {
  id: string;
  event: "before-run" | "after-tool" | "after-run";
  command: string;
  enabled: boolean;
};

export type CompactionResult = {
  summary: string;
  retainedMessageIds: string[];
  omittedMessageCount: number;
  createdAt: string;
};

export const AGENT_LIMITS = { maxTurns: 20, maxContextTokens: 131072 } as const;

export function validateAgentProfile(
  input: unknown,
  context: string = "agent profile",
): AgentProfile {
  if (!input || typeof input !== "object")
    throw new Error(`Invalid ${context}: not an object.`);
  const obj = input as Record<string, unknown>;
  if (typeof obj.id !== "string" || !/^[A-Za-z0-9][\w-]{0,119}$/.test(obj.id))
    throw new Error(`Invalid ${context}: id required as a UUID or slug.`);
  if (typeof obj.name !== "string" || !obj.name.trim() || obj.name.length > 80)
    throw new Error(`Invalid ${context}: name 1..80 chars.`);
  if (typeof obj.systemPrompt !== "string" || obj.systemPrompt.length > 16000)
    throw new Error(`Invalid ${context}: systemPrompt must be text up to 16000 characters.`);
  if (
    !Array.isArray(obj.allowedTools) || obj.allowedTools.length > 200 ||
    !obj.allowedTools.every((t) => typeof t === "string" && t.length > 0 && t.length <= 160 && !/[\x00-\x1f]/.test(t)) ||
    new Set(obj.allowedTools).size !== obj.allowedTools.length
  )
    throw new Error(`Invalid ${context}: allowedTools must be string[].`);
  if (typeof obj.policyProfile !== "string" || !obj.policyProfile.trim())
    throw new Error(`Invalid ${context}: policyProfile required.`);
  const maxTurns = obj.maxTurns;
  const maxContextTokens = obj.maxContextTokens;
  if (
    typeof maxTurns !== "number" ||
    !Number.isSafeInteger(maxTurns) ||
    maxTurns <= 0 || maxTurns > AGENT_LIMITS.maxTurns
  )
    throw new Error(`Invalid ${context}: maxTurns must be 1..${AGENT_LIMITS.maxTurns}.`);
  if (
    typeof maxContextTokens !== "number" ||
    !Number.isSafeInteger(maxContextTokens) ||
    maxContextTokens <= 0 || maxContextTokens > AGENT_LIMITS.maxContextTokens
  )
    throw new Error(`Invalid ${context}: maxContextTokens must be 1..${AGENT_LIMITS.maxContextTokens}.`);
  return {
    id: obj.id.trim(),
    name: obj.name.trim(),
    systemPrompt: obj.systemPrompt,
    allowedTools: [...obj.allowedTools] as string[],
    policyProfile: obj.policyProfile.trim(),
    maxTurns,
    maxContextTokens,
  };
}

export function validateHook(
  input: unknown,
  allowlist: readonly string[] = [],
  context: string = "hook",
): Hook {
  if (!input || typeof input !== "object")
    throw new Error(`Invalid ${context}: not an object.`);
  const obj = input as Record<string, unknown>;
  if (typeof obj.id !== "string" || !obj.id.trim())
    throw new Error(`Invalid ${context}: id required.`);
  const event = obj.event;
  if (event !== "before-run" && event !== "after-tool" && event !== "after-run")
    throw new Error(
      `Invalid ${context}: event must be before-run, after-tool or after-run.`,
    );
  if (typeof obj.command !== "string" || !obj.command.trim())
    throw new Error(`Invalid ${context}: command required.`);
  if (!allowlist.includes(obj.command.trim()))
    throw new Error(`Invalid ${context}: command not on operator allowlist.`);
  if (typeof obj.enabled !== "boolean")
    throw new Error(`Invalid ${context}: enabled boolean required.`);
  return {
    id: obj.id.trim(),
    event,
    command: obj.command.trim(),
    enabled: obj.enabled,
  };
}

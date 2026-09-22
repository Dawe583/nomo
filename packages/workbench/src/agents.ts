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

const OPERATOR_HOOK_ALLOWLIST = ["echo", "notify-send", "logger"] as const;

export function validateAgentProfile(
  input: unknown,
  context: string = "agent profile",
): AgentProfile {
  if (!input || typeof input !== "object")
    throw new Error(`Invalid ${context}: not an object.`);
  const obj = input as Record<string, unknown>;
  if (typeof obj.id !== "string" || !obj.id.trim())
    throw new Error(`Invalid ${context}: id required.`);
  if (typeof obj.name !== "string" || !obj.name.trim() || obj.name.length > 80)
    throw new Error(`Invalid ${context}: name 1..80 chars.`);
  if (typeof obj.systemPrompt !== "string")
    throw new Error(`Invalid ${context}: systemPrompt required.`);
  if (
    !Array.isArray(obj.allowedTools) ||
    !obj.allowedTools.every((t) => typeof t === "string")
  )
    throw new Error(`Invalid ${context}: allowedTools must be string[].`);
  if (typeof obj.policyProfile !== "string" || !obj.policyProfile.trim())
    throw new Error(`Invalid ${context}: policyProfile required.`);
  const maxTurns = obj.maxTurns;
  const maxContextTokens = obj.maxContextTokens;
  if (
    typeof maxTurns !== "number" ||
    !Number.isInteger(maxTurns) ||
    maxTurns <= 0
  )
    throw new Error(`Invalid ${context}: maxTurns positive int.`);
  if (
    typeof maxContextTokens !== "number" ||
    !Number.isInteger(maxContextTokens) ||
    maxContextTokens <= 0
  )
    throw new Error(`Invalid ${context}: maxContextTokens positive int.`);
  return {
    id: obj.id.trim(),
    name: obj.name.trim(),
    systemPrompt: obj.systemPrompt,
    allowedTools: obj.allowedTools as string[],
    policyProfile: obj.policyProfile.trim(),
    maxTurns,
    maxContextTokens,
  };
}

export function validateHook(
  input: unknown,
  allowlist: readonly string[] = OPERATOR_HOOK_ALLOWLIST,
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
  const cmdBase = obj.command.trim().split(/\s+/)[0]!;
  if (!allowlist.includes(cmdBase))
    throw new Error(
      `Invalid ${context}: command ${cmdBase} not on operator allowlist.`,
    );
  if (typeof obj.enabled !== "boolean")
    throw new Error(`Invalid ${context}: enabled boolean required.`);
  return {
    id: obj.id.trim(),
    event,
    command: obj.command.trim(),
    enabled: obj.enabled,
  };
}

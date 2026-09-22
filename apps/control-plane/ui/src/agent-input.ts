type AgentChoice = { id: string; name: string; description?: string };
export function agentOptions(data?: {
  agents?: AgentChoice[];
  profiles?: AgentChoice[];
}): AgentChoice[] {
  return [
    ...new Map(
      [...(data?.agents ?? []), ...(data?.profiles ?? [])].map((agent) => [
        agent.id,
        agent,
      ]),
    ).values(),
  ];
}

export function agentInput(values: Record<string, string>) {
  const maxTurns = Number(values.maxTurns),
    maxContextTokens = Number(values.maxContextTokens);
  if (
    ![maxTurns, maxContextTokens].every(
      (value) => Number.isSafeInteger(value) && value > 0,
    )
  )
    throw new Error("Agent bounds must be a positive integer.");
  return {
    id: (values.id ?? "").trim(),
    name: (values.name ?? "").trim(),
    systemPrompt: values.systemPrompt ?? "",
    allowedTools: (values.allowedTools ?? "")
      .split("\n")
      .map((tool) => tool.trim())
      .filter(Boolean),
    policyProfile: values.policyProfile ?? "",
    maxTurns,
    maxContextTokens,
  };
}

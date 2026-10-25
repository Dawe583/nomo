export type AgentRunnerConsentView =
  | "disabled"
  | "loading"
  | "error"
  | "no-runner"
  | "no-profile"
  | "ready";

export function agentRunnerConsentView(input: {
  enabled: boolean;
  loading: boolean;
  error: boolean;
  runnerCount: number;
  profileCount: number;
}): AgentRunnerConsentView {
  if (!input.enabled) return "disabled";
  if (input.loading) return "loading";
  if (input.error) return "error";
  if (input.runnerCount === 0) return "no-runner";
  if (input.profileCount === 0) return "no-profile";
  return "ready";
}

export function canStartAgentRun(
  preview: { id?: unknown; consentDigest?: unknown } | null,
  accepted: boolean,
  busy: boolean,
): boolean {
  return Boolean(
    !busy &&
      accepted &&
      preview &&
      typeof preview.id === "string" &&
      preview.id.trim() &&
      typeof preview.consentDigest === "string" &&
      /^sha256:[a-f0-9]{64}$/.test(preview.consentDigest),
  );
}

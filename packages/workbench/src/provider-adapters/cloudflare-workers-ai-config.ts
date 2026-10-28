const WORKERS_AI_ENDPOINT =
  /^\/client\/v4\/accounts\/([A-Za-z0-9_-]{1,128})\/ai\/v1\/?$/;

export function normalizeCloudflareWorkersAiEndpoint(input: URL): string | null {
  if (
    input.protocol !== "https:" ||
    input.hostname !== "api.cloudflare.com" ||
    input.username ||
    input.password ||
    input.port ||
    input.search ||
    input.hash
  ) return null;
  const match = WORKERS_AI_ENDPOINT.exec(input.pathname);
  if (!match) return null;
  // Source: https://developers.cloudflare.com/workers-ai/configuration/open-ai-compatibility/
  return `https://api.cloudflare.com/client/v4/accounts/${match[1]}/ai/v1`;
}

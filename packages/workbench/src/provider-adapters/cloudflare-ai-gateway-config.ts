export function cloudflareAiGatewayRouteForTransport(
  transport: string,
): "anthropic" | "compat" | "openai" | null {
  if (transport === "anthropic-messages") return "anthropic";
  if (transport === "openai-completions") return "compat";
  if (transport === "openai-responses") return "openai";
  return null;
}

export function normalizeCloudflareAiGatewayEndpoint(
  url: URL,
  transport: string,
): string | null {
  if (
    url.protocol !== "https:" ||
    url.hostname !== "gateway.ai.cloudflare.com" ||
    url.username ||
    url.password ||
    url.port ||
    url.search ||
    url.hash
  ) return null;

  const path = url.pathname.replace(/\/$/, "");
  const match = /^\/v1\/([^/]+)\/([^/]+)\/(anthropic|compat|openai)(?:\/v1)?$/.exec(path);
  if (!match) return null;

  try {
    const accountId = decodeURIComponent(match[1]);
    const gatewayId = decodeURIComponent(match[2]);
    const forbidden = /[<>/\\\u0000-\u001f\u007f]/;
    if (
      !accountId ||
      !gatewayId ||
      accountId === "." ||
      accountId === ".." ||
      gatewayId === "." ||
      gatewayId === ".." ||
      forbidden.test(accountId) ||
      forbidden.test(gatewayId)
    ) return null;
  } catch {
    return null;
  }

  const route = match[3];
  const expected = cloudflareAiGatewayRouteForTransport(transport);
  if (!expected || route !== expected || (route !== "anthropic" && path.endsWith("/v1")))
    return null;

  return `https://gateway.ai.cloudflare.com${path}${route === "anthropic" && !path.endsWith("/v1") ? "/v1" : ""}`;
}

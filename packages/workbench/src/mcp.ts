import { randomUUID } from "node:crypto";
export function validateEndpoint(value: string, local = false) {
  const url = new URL(value);
  if (
    (url.protocol !== "https:" && !(local && url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))) ||
    url.username ||
    url.password ||
    url.hash ||
    url.search
  )
    throw new Error("Use an HTTPS tool endpoint without embedded credentials.");
  if (
    !local && (url.hostname === "localhost" ||
    url.hostname.endsWith(".localhost") ||
    url.hostname.endsWith(".local") ||
    /^[\d.]+$/.test(url.hostname) ||
    url.hostname.includes(":"))
  )
    throw new Error("Use a public HTTPS tool endpoint.");
  return url.href;
}

/**
 * The MCP revision this client speaks. The local inbound endpoint refuses
 * anything older, so it goes on every request rather than only on the ones
 * that happen to carry a session id.
 */
export const MCP_PROTOCOL_VERSION = "2026-07-28";

/** Narrows to an indexable record. Every read below is checked, never asserted. */
function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * Metadata the current revision requires on every request. It travels in the
 * body as well as the headers so a connectionless request, which has no
 * handshake to carry it, is still self-describing.
 */
function requestMeta(params: unknown): Record<string, unknown> {
  const inherited = asRecord(asRecord(params)?.["_meta"]) ?? {};
  return {
    ...inherited,
    "io.modelcontextprotocol/protocolVersion": MCP_PROTOCOL_VERSION,
    "io.modelcontextprotocol/clientCapabilities": {},
    "io.modelcontextprotocol/clientInfo": {
      name: "void-cloud",
      version: "0.1.0",
    },
  };
}

/** Reads a string field off an unknown params bag without asserting a shape. */
function stringField(params: unknown, key: string): string | undefined {
  const value = asRecord(params)?.[key];
  return typeof value === "string" ? value : undefined;
}

function withMeta(params: unknown): Record<string, unknown> {
  return { ...(asRecord(params) ?? {}), _meta: requestMeta(params) };
}

export type McpConfig = {
  url: string;
  /** A static secret. Only an operator who pasted one may set it. */
  token?: string;
  /**
   * Resolves the bearer per request, for a credential this process issued to
   * itself. Consulted on every call rather than cached, so a grant that
   * expires or is revoked mid-run stops being presented immediately. It is
   * never persisted: the Workbench strips it on the way into the snapshot, so
   * no reader of saved state can mistake it for a saved secret.
   */
  tokenProvider?: () => string | undefined;
  /**
   * Skip the initialize handshake and speak one request per connection. The
   * local endpoint is stateless, so a client that opened a session would be
   * holding an id the server never meant to issue.
   */
  connectionless?: boolean;
  policy?: string;
  facts?: Record<string, boolean | string>;
  mapping?: Record<string, string>;
};

/**
 * The bearer for one request, or nothing. Two sources of authority for the
 * same credential is refused rather than resolved: silently preferring one
 * would hide a caller still trying to choose its own secret behind a provider
 * that only looks like the safer option.
 */
export function bearerFor(config: McpConfig): string | undefined {
  if (config.tokenProvider === undefined) return config.token;
  if (config.token !== undefined)
    throw new Error(
      "An MCP config takes either a static token or a token provider, never both.",
    );
  const issued = config.tokenProvider();
  return typeof issued === "string" && issued.length > 0 ? issued : undefined;
}

export type McpTool = {
  name: string;
  description?: string;
  inputSchema?: unknown;
  connectorId?: string;
  _meta?: Record<string, unknown>;
};
export async function rpc(config: McpConfig, method: string, params: unknown, sessionId?: string): Promise<{ result?: { tools?: McpTool[]; isError?: boolean; [key: string]: unknown }; sessionId?: string }> {
  const id = randomUUID();
  const bearer = bearerFor(config);
  const requestedName =
    method === "tools/call" ? stringField(params, "name") : undefined;
  const response = await fetch(config.url, {
    method: "POST",
    redirect: "error",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": MCP_PROTOCOL_VERSION,
      "mcp-method": method,
      ...(requestedName !== undefined && { "mcp-name": requestedName }),
      ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
      // Absent when the caller holds no session, which is the whole shape of
      // the connectionless flow: nothing to resume, nothing to carry forward.
      ...(sessionId ? { "mcp-session-id": sessionId } : {}),
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      ...(method.startsWith("notifications/") ? {} : { id }),
      method,
      params: withMeta(params),
    }),
    signal: AbortSignal.timeout(45000),
  });
  if (!response.ok)
    throw new Error(`MCP endpoint returned HTTP ${response.status}.`);
  if (method.startsWith("notifications/")) return {};
  let bytes = 0,
    text = "",
    message;
  const decoder = new TextDecoder();
  if (!response.body) throw new Error("Empty MCP response.");
  const reader = response.body.getReader();
  const streaming = response.headers
    .get("content-type")
    ?.includes("text/event-stream");
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.length;
      if (bytes > 1048576) throw new Error("MCP response exceeds 1 MB.");
      text += decoder
        .decode(chunk.value, { stream: true })
        .replace(/\r\n/g, "\n");
      if (streaming) {
        let boundary;
        while ((boundary = text.indexOf("\n\n")) >= 0) {
          const frame = text.slice(0, boundary);
          text = text.slice(boundary + 2);
          const data = frame
            .split("\n")
            .filter((line) => line.startsWith("data:"))
            .map((line) => line.slice(5).trimStart())
            .join("\n");
          if (data) {
            const parsed = JSON.parse(data);
            if (parsed.id === id) {
              message = parsed;
              break;
            }
          }
        }
        if (message) break;
      }
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  if (!streaming) message = JSON.parse(text + decoder.decode());
  if (!message || message.id !== id || message.error)
    throw new Error("MCP request failed. Inspect the tool server.");
  return {
    result: message.result,
    sessionId: response.headers.get("mcp-session-id") ?? sessionId,
  };
}

/** The catalog read is shared by both flows; only the handshake differs. */
function toolsOf(listed: { result?: { tools?: McpTool[] } }): McpTool[] {
  if (!Array.isArray(listed.result?.tools) || listed.result.tools.length > 100)
    throw new Error("MCP tool catalog is invalid or too large.");
  return listed.result.tools;
}

export async function catalog(config: McpConfig) {
  if (config.connectionless) {
    const listed = await rpc(config, "tools/list", {});
    return { tools: toolsOf(listed), sessionId: listed.sessionId };
  }
  const init = await rpc(config, "initialize", {
    protocolVersion: MCP_PROTOCOL_VERSION,
    capabilities: {},
    clientInfo: { name: "void-cloud", version: "0.1.0" },
  });
  await rpc(config, "notifications/initialized", {}, init.sessionId);
  const listed = await rpc(config, "tools/list", {}, init.sessionId);
  return { tools: toolsOf(listed), sessionId: listed.sessionId };
}

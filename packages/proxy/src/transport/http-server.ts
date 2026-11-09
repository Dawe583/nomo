import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { AuthInfo, CallToolResult, JsonSchemaType } from "@modelcontextprotocol/server";
import { McpServer, createMcpHandler, fromJsonSchema } from "@modelcontextprotocol/server";
import { localhostHostValidation, localhostOriginValidation, toNodeHandler } from "@modelcontextprotocol/node";

import {
  createLocalProxyRpcBridge,
  type LocalProxyRpcBridge,
  type LocalProxyRpcBridgeOptions,
  type LocalProxyTool,
  type TrustedToolCallContext,
} from "../bin.ts";
import { legacyArgsDigest } from "../forward/legacy-binding.ts";
import type { OperationAssessment } from "../forward/tools.ts";

export type LocalGrantIdentity = Readonly<{
  principalId: string;
  agentId: string;
  runId: string;
  workspaceId: string;
  toolScope: readonly string[];
  expiresAt: number;
}>;

export const LOCAL_AGENT_TOOL_BINDING_META = "com.nomo/agentBinding";

export type LocalAgentToolBindingSnapshot = Readonly<{
  version: 1;
  toolName: string;
  principalId: string;
  agentId: string;
  runId: string;
  workspaceId: string;
  upstreamId: string;
  schemaDigest: string;
  expiresAt: number;
}>;

export type LocalMcpHttpServerOptions = Readonly<{
  upstreamId: string;
  proxyOptions: LocalProxyRpcBridgeOptions;
  port?: number;
  resolveGrant: (token: string, upstreamId: string) => LocalGrantIdentity | null;
  validateGrant: (
    token: string,
    upstreamId: string,
    toolName: string,
  ) => LocalGrantIdentity | null;
}>;

export type LocalMcpHttpServer = Readonly<{
  url: URL;
  close: () => Promise<void>;
}>;

const validateHost = localhostHostValidation();
const validateOrigin = localhostOriginValidation();

/**
 * Starts the local current-spec MCP endpoint. The listener is fixed to IPv4
 * loopback, and every tool call rechecks the opaque Workbench grant before it
 * reaches the existing proxy interception path.
 */
export async function startLocalMcpHttpServer(
  options: LocalMcpHttpServerOptions,
): Promise<LocalMcpHttpServer> {
  if (!validIdentifier(options.upstreamId))
    throw new TypeError("Invalid local MCP upstream id");
  const port = options.port ?? 0;
  if (!Number.isSafeInteger(port) || port < 0 || port > 65535)
    throw new RangeError("Local MCP port must be between 0 and 65535");

  const bridge = createLocalProxyRpcBridge(options.proxyOptions);
  const maxRequestBodySize =
    options.proxyOptions.inboundMaxBytes ?? 1024 * 1024;
  const handler = createMcpHandler(
    async (context) => {
      const token = context.authInfo?.token;
      if (typeof token !== "string")
        throw new Error("Local agent grant is missing");
      const identity = resolveIdentity(options.resolveGrant, token, options.upstreamId);
      if (!identity) throw new Error("Local agent grant is invalid or expired");
      const tools = await bridge.listTools();
      const server = new McpServer({ name: "nomo-local-proxy", version: "1" });
      for (const tool of tools) {
        if (!identity.toolScope.includes(tool.name)) continue;
        await registerProxyTool(server, bridge, options, token, identity, tool);
      }
      return server;
    },
    { legacy: "reject", maxRequestBodySize },
  );
  const handleMcpRequest = toNodeHandler(handler, { maxRequestBodySize });
  const server = createServer((request, response) => {
    void handleHttpRequest(request, response).catch(() => {
      if (!response.headersSent)
        writeJson(response, 500, { error: "local_mcp_request_failed" });
      else response.destroy();
    });
  });

  try {
    await listenLoopback(server, port);
  } catch (error) {
    await handler.close();
    await bridge.close();
    throw error;
  }

  const address = server.address();
  if (!address || typeof address === "string") {
    await closeNodeServer(server);
    await handler.close();
    await bridge.close();
    throw new Error("Local MCP listener has no TCP address");
  }
  const url = new URL(`http://127.0.0.1:${address.port}/mcp`);
  let closePromise: Promise<void> | null = null;
  return Object.freeze({
    url,
    close() {
      closePromise ??= Promise.all([
        closeNodeServer(server),
        handler.close(),
        bridge.close(),
      ]).then(() => {});
      return closePromise;
    },
  });

  async function handleHttpRequest(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    if (!validateHost(request, response) || !validateOrigin(request, response))
      return;
    let pathname: string;
    try {
      pathname = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
    } catch {
      writeJson(response, 400, { error: "invalid_request_target" });
      return;
    }
    if (pathname !== "/mcp") {
      writeJson(response, 404, { error: "not_found" });
      return;
    }
    if (request.method !== "POST") {
      response.writeHead(405, { allow: "POST", "content-type": "application/json" });
      response.end(JSON.stringify({ error: "method_not_allowed" }));
      return;
    }
    const token = bearerToken(request.headers.authorization);
    if (!token) {
      writeUnauthorized(response);
      return;
    }
    const identity = resolveIdentity(options.resolveGrant, token, options.upstreamId);
    if (!identity) {
      writeUnauthorized(response);
      return;
    }
    const authenticatedRequest = request as IncomingMessage & { auth?: AuthInfo };
    authenticatedRequest.auth = {
      token,
      clientId: identity.agentId,
      scopes: [...identity.toolScope],
      expiresAt: Math.ceil(identity.expiresAt / 1000),
    };
    await handleMcpRequest(authenticatedRequest, response);
  }
}

async function registerProxyTool(
  server: McpServer,
  bridge: LocalProxyRpcBridge,
  options: LocalMcpHttpServerOptions,
  token: string,
  listedIdentity: LocalGrantIdentity,
  tool: LocalProxyTool,
): Promise<void> {
  const schemaDigest = await legacyArgsDigest(tool.inputSchema);
  const bindingSnapshot: LocalAgentToolBindingSnapshot = Object.freeze({
    version: 1,
    toolName: tool.name,
    principalId: listedIdentity.principalId,
    agentId: listedIdentity.agentId,
    runId: listedIdentity.runId,
    workspaceId: listedIdentity.workspaceId,
    upstreamId: options.upstreamId,
    schemaDigest,
    expiresAt: listedIdentity.expiresAt,
  });
  server.registerTool(
    tool.name,
    {
      ...(tool.description !== undefined && { description: tool.description }),
      inputSchema: fromJsonSchema(tool.inputSchema as JsonSchemaType),
      _meta: { [LOCAL_AGENT_TOOL_BINDING_META]: bindingSnapshot },
    },
    async (args, context) => {
      let capturedIdentity: LocalGrantIdentity | undefined;
      const assertCurrentGrant = (): LocalGrantIdentity => {
        let current: LocalGrantIdentity | null;
        try {
          current = options.validateGrant(token, options.upstreamId, tool.name);
        } catch {
          current = null;
        }
        if (!isValidIdentity(current) || !current.toolScope.includes(tool.name))
          throw new Error("Local agent grant is invalid or expired");
        if (capturedIdentity !== undefined && !sameGrantIdentity(current, capturedIdentity))
          throw new Error("Local agent grant identity changed");
        return current;
      };
      const identity = snapshotGrantIdentity(assertCurrentGrant());
      capturedIdentity = identity;
      const callArgs = asJsonObject(args);
      const profile = options.proxyOptions.operationProfiles?.find((candidate) =>
        validIdentifier(candidate.profileId) &&
        candidate.upstreamId === options.upstreamId &&
        candidate.tool === tool.name &&
        candidate.schemaDigest === schemaDigest,
      );
      let assessment: OperationAssessment | undefined;
      try {
        const candidate = profile?.assess({
          upstreamId: options.upstreamId,
          tool: tool.name,
          schemaDigest,
          args: deepFreeze(structuredClone(callArgs)),
          principalId: identity.principalId,
          agentId: identity.agentId,
          runId: identity.runId,
          workspaceId: identity.workspaceId,
        });
        if (isOperationAssessment(candidate)) assessment = candidate;
      } catch {
        assessment = undefined;
      }
      const trustedContext: TrustedToolCallContext = {
        upstreamId: options.upstreamId,
        tool: tool.name,
        schemaDigest,
        principalId: identity.principalId,
        agentId: identity.agentId,
        runId: identity.runId,
        workspaceId: identity.workspaceId,
        ...(profile === undefined ? {} : { profileId: profile.profileId }),
        ...(assessment === undefined ? {} : { assessment }),
      };
      return await bridge.callTool(
        tool.name,
        callArgs,
        context.mcpReq.signal,
        assertCurrentGrant,
        trustedContext,
      ) as CallToolResult;
    },
  );
}

function resolveIdentity(
  resolve: LocalMcpHttpServerOptions["resolveGrant"],
  token: string,
  upstreamId: string,
): LocalGrantIdentity | null {
  try {
    const identity = resolve(token, upstreamId);
    return isValidIdentity(identity) ? identity : null;
  } catch {
    return null;
  }
}

function isValidIdentity(value: LocalGrantIdentity | null): value is LocalGrantIdentity {
  return value !== null &&
    validIdentifier(value.principalId) &&
    validIdentifier(value.agentId) &&
    validIdentifier(value.runId) &&
    validIdentifier(value.workspaceId) &&
    Number.isFinite(value.expiresAt) &&
    value.expiresAt > Date.now() &&
    Array.isArray(value.toolScope) &&
    value.toolScope.length > 0 &&
    value.toolScope.every(validIdentifier);
}

function snapshotGrantIdentity(identity: LocalGrantIdentity): LocalGrantIdentity {
  return Object.freeze({
    ...identity,
    toolScope: Object.freeze([...identity.toolScope]),
  });
}

function sameGrantIdentity(
  current: LocalGrantIdentity,
  captured: LocalGrantIdentity,
): boolean {
  return current.principalId === captured.principalId &&
    current.agentId === captured.agentId &&
    current.runId === captured.runId &&
    current.workspaceId === captured.workspaceId &&
    current.expiresAt === captured.expiresAt &&
    current.toolScope.length === captured.toolScope.length &&
    current.toolScope.every((tool, index) => tool === captured.toolScope[index]);
}

function isOperationAssessment(value: unknown): value is OperationAssessment {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<OperationAssessment>;
  return (candidate.effect === "read" || candidate.effect === "write" ||
    candidate.effect === "mixed" || candidate.effect === "unknown") &&
    (candidate.risk === "low" || candidate.risk === "high" ||
      candidate.risk === "unknown") &&
    (candidate.fastPath === "allow" || candidate.fastPath === "full");
}

function bearerToken(value: string | undefined): string | null {
  if (typeof value !== "string") return null;
  const match = /^Bearer ([A-Za-z0-9_-]{43})$/i.exec(value);
  return match?.[1] ?? null;
}

function validIdentifier(value: unknown): value is string {
  return typeof value === "string" &&
    value.length > 0 &&
    value.length <= 160 &&
    value.trim() === value &&
    !/[\u0000-\u001f\u007f]/.test(value);
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value))
    return value;
  for (const nested of Object.values(value)) deepFreeze(nested);
  return Object.freeze(value);
}

function asJsonObject(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new TypeError("MCP tool arguments must be an object");
  return value as Record<string, unknown>;
}

function writeUnauthorized(response: ServerResponse): void {
  response.writeHead(401, {
    "www-authenticate": "Bearer",
    "content-type": "application/json",
  });
  response.end(JSON.stringify({ error: "invalid_local_agent_grant" }));
}

function writeJson(
  response: ServerResponse,
  status: number,
  body: unknown,
): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

async function listenLoopback(server: Server, port: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => reject(error);
    server.once("error", onError);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", onError);
      resolve();
    });
  });
}

async function closeNodeServer(server: Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}

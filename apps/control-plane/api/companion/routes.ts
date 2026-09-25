import type { IncomingMessage, ServerResponse } from "node:http";
import {
  authenticateDevice,
  pairDevice,
  plainLabel,
  readOnlyScopes,
  readScope,
  revokeDevice,
  writeScope,
  type CompanionScope,
  type CompanionSession,
} from "./devices.ts";
import { companionDiagnostics } from "./diagnostics.ts";
import { readOperation } from "./operations.ts";
import { companionWorkspace, CompanionStoreError } from "./store.ts";

type JsonObject = Record<string, unknown>;

/** Protocol v1 limits reused by the routes: the device credential lifetime and
 * the bounded identity an operation may carry. */
const credentialTtlMs = 15 * 60 * 1000;
const maxBodyBytes = 64 * 1024;
const operationIdPattern = /^[A-Za-z0-9_.:-]{1,160}$/;

function sendJson(response: ServerResponse, statusCode: number, value: JsonObject): void {
  response.setHeader("cache-control", "no-store");
  response.setHeader("x-content-type-options", "nosniff");
  // A device projection is never framed by a browser surface. The companion
  // routes add no CORS middleware and no second origin check, so the host
  // gate and the cross-site protections in front of them remain the only ones
  // deciding who may reach this response.
  response.setHeader("x-frame-options", "DENY");
  response.setHeader("content-security-policy", "frame-ancestors 'none'");
  response.statusCode = statusCode;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.end(JSON.stringify(value));
}

function pathname(request: IncomingMessage): string | null {
  try {
    return new URL(request.url ?? "/", "http://127.0.0.1").pathname;
  } catch {
    return null;
  }
}

function recordOf(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

/** An explicit JSON content type keeps a companion surface fetch-only, the
 * same reason the local decision route refuses a text/plain form body.
 *
 * `present` separates "this request carried no body" from "this request
 * carried a body the server could not read". Collapsing the two would let a
 * malformed or oversized body pass as an absent one, which is exactly the
 * fail-open an identity-bearing route must not have. */
async function readJsonBody(request: IncomingMessage): Promise<{ readonly present: boolean; readonly value: unknown }> {
  const contentType = request.headers["content-type"];
  if (contentType === undefined || contentType.split(";", 1)[0]!.trim().toLowerCase() !== "application/json") return { present: false, value: undefined };
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
    size += buffer.length;
    if (size > maxBodyBytes) return { present: true, value: null };
    chunks.push(buffer);
  }
  if (chunks.length === 0) return { present: false, value: undefined };
  try {
    return { present: true, value: JSON.parse(Buffer.concat(chunks).toString("utf8")) };
  } catch {
    return { present: true, value: null };
  }
}

function parsePairingBody(body: unknown): { readonly label: string; readonly scopes: readonly CompanionScope[] } | null {
  if (body === undefined) return { label: "companion device", scopes: readOnlyScopes };
  const record = recordOf(body);
  if (record === null || Object.keys(record).some(key => key !== "label" && key !== "scopes")) return null;
  const label = record.label ?? "companion device";
  if (typeof label !== "string" || !plainLabel(label)) return null;
  const requested = record.scopes ?? readOnlyScopes;
  if (!Array.isArray(requested) || requested.length > 2) return null;
  const granted: CompanionScope[] = [];
  for (const scope of requested) {
    if (scope !== readScope && scope !== writeScope) return null;
    if (!granted.includes(scope)) granted.push(scope);
  }
  return { label, scopes: granted.sort() };
}

/** A device credential is a separate authority from the loopback host gate. A
 * presented token is proved against the registry and never traded for the
 * operator's loopback trust; an unreadable registry grants nothing, so a
 * corrupt file refuses devices instead of admitting them. */
function deviceSession(request: IncomingMessage, env: Readonly<NodeJS.ProcessEnv>): CompanionSession | null {
  const header = request.headers.authorization;
  if (typeof header !== "string" || !header.startsWith("Bearer ")) return null;
  return authenticateDevice(env, header.slice("Bearer ".length));
}

async function pair(request: IncomingMessage, response: ServerResponse, env: Readonly<NodeJS.ProcessEnv>): Promise<void> {
  if (request.method !== "POST") return sendJson(response, 405, { error: "method_not_allowed" });
  const input = parsePairingBody((await readJsonBody(request)).value);
  if (input === null) return sendJson(response, 400, { error: "invalid_pairing" });
  const { device, deviceToken } = pairDevice(env, input);
  // The plaintext credential exists in this response and nowhere else: the
  // registry holds only its digest and no later route repeats it.
  return sendJson(response, 201, {
    deviceId: device.deviceId,
    deviceToken,
    expiresAt: new Date(Date.parse(device.createdAt) + credentialTtlMs).toISOString(),
    scopes: [...device.scopes],
  });
}

async function operationStatus(request: IncomingMessage, response: ServerResponse, env: Readonly<NodeJS.ProcessEnv>, operationId: string): Promise<void> {
  if (request.method !== "GET") return sendJson(response, 405, { error: "method_not_allowed" });
  if (!operationIdPattern.test(operationId)) return sendJson(response, 400, { error: "invalid_operation_id" });
  // The frozen `operation.status` request carries `{ operationId }` and binds
  // it to the envelope identity. The path is the transport form of the same
  // identity, so a supplied body must agree with it byte for byte; a body that
  // names a different operation is refused rather than resolved in favour of
  // either side.
  const { present, value } = await readJsonBody(request);
  if (present) {
    const supplied = recordOf(value);
    if (supplied === null || Object.keys(supplied).length !== 1 || supplied.operationId !== operationId) {
      return sendJson(response, 400, { error: "invalid_operation_identity" });
    }
  }
  // The host operator, having already passed the loopback or gateway gate in
  // front of this handler, reads the workspace it is configured for. A paired
  // device reads only its own operations.
  const presented = request.headers.authorization !== undefined;
  const session = deviceSession(request, env);
  if (presented && (session === null || !session.scopes.includes(readScope))) return sendJson(response, 403, { error: "device_forbidden" });
  const workspaceId = session === null ? companionWorkspace(env) : session.workspaceId;
  const record = readOperation(env, workspaceId, operationId);
  // An unknown identifier, another device's operation, and another workspace's
  // operation are the same 404: the lookup never reports a success it cannot
  // prove, and never discloses that a foreign record exists.
  if (record === null || (presented && record.deviceId !== session!.deviceId)) return sendJson(response, 404, { error: "operation_not_found" });
  return sendJson(response, 200, { operationId, status: record.status });
}

async function revoke(request: IncomingMessage, response: ServerResponse, env: Readonly<NodeJS.ProcessEnv>, deviceId: string): Promise<void> {
  if (request.method !== "POST") return sendJson(response, 405, { error: "method_not_allowed" });
  const body = recordOf((await readJsonBody(request)).value);
  if (body === null || Object.keys(body).length !== 1 || body.deviceId !== deviceId) {
    return sendJson(response, 400, { error: "invalid_revoke_target" });
  }
  const presented = request.headers.authorization !== undefined;
  const session = deviceSession(request, env);
  // A presented credential is authoritative: a device that lacks execution, or
  // that names a device other than itself, is refused rather than silently
  // downgraded to the operator's rights. Only an unauthenticated caller that
  // already cleared the host gate is the host operator.
  if (presented && (session === null || !session.scopes.includes(writeScope) || session.deviceId !== deviceId)) {
    return sendJson(response, 403, { error: "device_forbidden" });
  }
  const receipt = revokeDevice(env, deviceId);
  if (receipt === null) return sendJson(response, 404, { error: "device_not_found" });
  // The transport holds no long-lived companion stream state and every route
  // re-proves the credential per request, so revoking access closes what was
  // open at once. The dispatched revoke keeps its durable receipt.
  return sendJson(response, 200, { deviceId: receipt.deviceId, revokedAt: receipt.revokedAt, newMutationsAllowed: false, activeStreamsClosed: true });
}

export async function handleCompanionRequest(request: IncomingMessage, response: ServerResponse, env: Readonly<NodeJS.ProcessEnv>): Promise<void> {
  const path = pathname(request);
  if (path === null) return sendJson(response, 400, { error: "bad_url" });
  try {
    if (path === "/api/companion/devices") return await pair(request, response, env);
    if (path === "/api/companion/diagnostics") {
      if (request.method !== "GET") return sendJson(response, 405, { error: "method_not_allowed" });
      const session = deviceSession(request, env);
      if (session === null || !session.scopes.includes(readScope)) return sendJson(response, 403, { error: "device_forbidden" });
      return sendJson(response, 200, companionDiagnostics(env, session) as JsonObject);
    }
    const operation = /^\/api\/companion\/operations\/([^/]+)$/.exec(path);
    if (operation !== null) return await operationStatus(request, response, env, operation[1]!);
    const target = /^\/api\/companion\/devices\/([^/]+)\/revoke$/.exec(path);
    if (target !== null) return await revoke(request, response, env, target[1]!);
    return sendJson(response, 404, { error: "not_found" });
  } catch (error) {
    if (error instanceof CompanionStoreError && error.code === "device_limit") return sendJson(response, 409, { error: "device_limit" });
    // A store that cannot be read or written is never reported with its own
    // contents: the caller learns the stable category and nothing more.
    return sendJson(response, 500, { error: "internal_error" });
  }
}

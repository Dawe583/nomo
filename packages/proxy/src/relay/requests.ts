type JsonRpcId = string | number;

type JsonObject = { readonly [key: string]: unknown };

// JsonRpcRequest lives in rpc.ts so every module speaks the same shape.
import type { JsonRpcRequest } from "../rpc.ts";
export type { JsonRpcRequest };

export type JsonRpcSuccessResponse = {
  readonly jsonrpc: "2.0";
  readonly id: JsonRpcId | null;
  readonly result: unknown;
};

export type JsonRpcErrorResponse = {
  readonly jsonrpc: "2.0";
  readonly id: JsonRpcId | null;
  readonly error: {
    readonly code: number;
    readonly message: string;
    readonly data?: unknown;
  };
};

export type JsonRpcResponse = JsonRpcSuccessResponse | JsonRpcErrorResponse;

export type ServerRequestRelaySession = {
  readonly upstreamToAgent?: Map<JsonRpcId, JsonRpcId> | ReadonlyMap<JsonRpcId, JsonRpcId>;
  readonly allocateAgentId: () => JsonRpcId;
  readonly recordServerRequest?: (upstreamId: JsonRpcId, agentId: JsonRpcId) => void;
  readonly recordProgressToken?: (agentId: JsonRpcId, token: JsonRpcId) => void;
};

function setMapValue(map: Map<JsonRpcId, JsonRpcId> | ReadonlyMap<JsonRpcId, JsonRpcId> | undefined, key: JsonRpcId, value: JsonRpcId): void {
  if (map instanceof Map) {
    map.set(key, value);
  }
}

function lookupReverse(map: ReadonlyMap<JsonRpcId, JsonRpcId>, value: JsonRpcId): JsonRpcId | undefined {
  for (const [candidate, mapped] of map.entries()) {
    if (Object.is(mapped, value)) {
      return candidate;
    }
  }

  return undefined;
}

export function relayServerRequest(
  request: JsonRpcRequest,
  session: ServerRequestRelaySession,
): JsonRpcRequest {
  const agentId = session.allocateAgentId();
  session.recordServerRequest?.(request.id, agentId);
  setMapValue(session.upstreamToAgent, request.id, agentId);

  return request.params === undefined
    ? { ...request, id: agentId }
    : { ...request, id: agentId, params: remapProgressToken(request.params, agentId, session) };
}

// The agent never receives the params object the upstream sent; it receives a
// copy, and a copy whose progress token names the id this relay allocated.
function remapProgressToken(
  params: JsonObject,
  agentId: JsonRpcId,
  session: ServerRequestRelaySession,
): JsonObject {
  const meta = params._meta;
  if (typeof meta !== "object" || meta === null || Array.isArray(meta)) {
    return { ...params };
  }

  const record = meta as JsonObject;
  const token = record.progressToken;
  if (typeof token !== "string" && typeof token !== "number") {
    return { ...params };
  }

  session.recordProgressToken?.(agentId, token);
  return { ...params, _meta: { ...record, progressToken: agentId } };
}

export function relayServerResponse(
  agentResponse: JsonRpcResponse,
  upstreamToAgent: ReadonlyMap<JsonRpcId, JsonRpcId>,
): JsonRpcResponse {
  const upstreamId = agentResponse.id === null
    ? undefined
    : lookupReverse(upstreamToAgent, agentResponse.id);
  const id = upstreamId ?? agentResponse.id;

  if ("error" in agentResponse) {
    return { ...agentResponse, id, error: { ...agentResponse.error } };
  }

  return { ...agentResponse, id };
}

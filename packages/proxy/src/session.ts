import type {
  JsonObject,
  JsonRpcError,
  JsonRpcId,
  JsonRpcMessage,
  JsonRpcNotification,
  JsonRpcRequest,
  JsonRpcResult,
} from "./rpc.ts";

export type SessionMaps = {
  readonly agentToUpstream: ReadonlyMap<JsonRpcId, JsonRpcId>;
  readonly upstreamToAgent: ReadonlyMap<JsonRpcId, JsonRpcId>;
};

const SUPPORTED_PROTOCOL_VERSIONS = [
  "2025-11-25",
  "2025-06-18",
  "2025-03-26",
  "2024-11-05",
  "2024-10-07",
] as const;

export class Session {
  readonly #agentToUpstream = new Map<JsonRpcId, JsonRpcId>();
  readonly #upstreamToAgent = new Map<JsonRpcId, JsonRpcId>();
  readonly #progressTokens = new Map<JsonRpcId, JsonRpcId>();
  readonly #usedIds = new Set<JsonRpcId>();
  #nextId = 1;

  readonly maps: SessionMaps = {
    agentToUpstream: this.#agentToUpstream,
    upstreamToAgent: this.#upstreamToAgent,
  };

  allocateAgentId(): JsonRpcId {
    return this.#allocateId();
  }

  /**
   * Records a server-originated request relayed outside translateInbound,
   * so the agent response remaps to the upstream id. Ids stay typed: a
   * string upstream id never becomes its numeric lookalike.
   */
  recordServerRequest(upstreamId: JsonRpcId, agentId: JsonRpcId): void {
    this.#upstreamToAgent.set(
      assertRequestId(upstreamId),
      assertRequestId(agentId),
    );
    this.#rememberId(upstreamId);
  }

  /**
   * Records the progress token a request carried, so an inbound progress
   * notification is answered with the token the caller chose rather than the
   * id this session minted. The server-originated relay calls this for the
   * requests it translates itself.
   */
  recordProgressToken(agentId: JsonRpcId, token: JsonRpcId): void {
    this.#progressTokens.set(agentId, token);
  }

  translateRequestOut(agentRequest: JsonRpcRequest): JsonRpcRequest {
    const agentId = assertRequestId(agentRequest.id);
    this.#rememberId(agentId);
    const upstreamId = this.#allocateId();
    this.#agentToUpstream.set(agentId, upstreamId);
    const token = readMeta(agentRequest.params)?.progressToken;
    if (typeof token === "string" || typeof token === "number") {
      this.recordProgressToken(upstreamId, token);
    }

    const translated = { ...agentRequest, id: upstreamId };
    const params = remapMetaToken(agentRequest.params, upstreamId);
    return params === agentRequest.params
      ? translated
      : { ...translated, params };
  }

  translateInbound(message: JsonRpcMessage): JsonRpcMessage | null {
    if (isResult(message) || isError(message)) {
      return this.#translateResponse(message);
    }

    if (isNotification(message)) {
      return this.#translateNotification(message);
    }

    return this.#translateServerRequest(message);
  }

  negotiatedVersion(requested: string, upstreamAnswer: string): string {
    const requestedIndex = SUPPORTED_PROTOCOL_VERSIONS.indexOf(
      requested as SupportedProtocolVersion,
    );
    const acceptable =
      requestedIndex === -1
        ? SUPPORTED_PROTOCOL_VERSIONS
        : SUPPORTED_PROTOCOL_VERSIONS.slice(requestedIndex);

    return acceptable.includes(upstreamAnswer as SupportedProtocolVersion)
      ? upstreamAnswer
      : acceptable[0];
  }

  translateCancellation(agentId: JsonRpcId): JsonRpcNotification | null {
    const upstreamId = this.#agentToUpstream.get(agentId);
    if (upstreamId === undefined) {
      return null;
    }

    this.drop(agentId);
    return {
      jsonrpc: "2.0",
      method: "notifications/cancelled",
      params: { requestId: upstreamId },
    };
  }

  drop(agentId: JsonRpcId): void {
    const upstreamId = this.#agentToUpstream.get(agentId);
    this.#agentToUpstream.delete(agentId);
    if (upstreamId !== undefined) this.#progressTokens.delete(upstreamId);
  }

  #translateResponse(
    message: JsonRpcResult | JsonRpcError,
  ): JsonRpcMessage | null {
    if (message.id === undefined) {
      return null;
    }

    if (typeof message.id === "string") {
      // The proxy always allocates numeric upstream ids, so a string id on a
      // response is an unknown identity, never a reply this session routed.
      // It stays a string and is dropped, never coerced to its numeric lookalike.
      return null;
    }

    const upstreamId = assertRequestId(message.id);
    const agentId = this.#agentIdForUpstreamResponse(upstreamId);
    if (agentId === null) {
      return null;
    }

    this.drop(agentId);
    return { ...message, id: agentId };
  }

  #translateNotification(
    message: JsonRpcNotification,
  ): JsonRpcNotification | null {
    if (message.method === "notifications/progress") {
      return this.#translateProgress(message);
    }

    if (message.method === "notifications/cancelled") {
      return this.#translateInboundCancellation(message);
    }

    return message;
  }

  #translateProgress(message: JsonRpcNotification): JsonRpcNotification | null {
    const token = readRequestIdParam(message.params, "progressToken");
    if (token === null) {
      return null;
    }

    const originalToken = this.#progressTokens.get(token);
    if (originalToken === undefined) return null;
    return {
      ...message,
      params: { ...message.params, progressToken: originalToken },
    };
  }

  #translateInboundCancellation(
    message: JsonRpcNotification,
  ): JsonRpcNotification | null {
    const requestId = readRequestIdParam(message.params, "requestId");
    if (requestId === null) {
      return message;
    }

    const agentId = this.#agentIdForUpstreamResponse(requestId);
    if (agentId === null) return null;

    this.drop(agentId);
    return { ...message, params: { ...message.params, requestId: agentId } };
  }

  #translateServerRequest(message: JsonRpcRequest): JsonRpcRequest {
    // Server-originated ids stay typed: "42" never becomes 42, so a string
    // id and its numeric lookalike route independently.
    const upstreamId = assertRequestId(message.id);
    this.#rememberId(upstreamId);
    const agentId = this.#allocateId();
    this.#upstreamToAgent.set(upstreamId, agentId);

    const token = readMeta(message.params)?.progressToken;
    if (typeof token === "string" || typeof token === "number") {
      this.recordProgressToken(agentId, token);
    }
    const translated = { ...message, id: agentId };
    const params = remapMetaToken(message.params, agentId);
    return params === message.params ? translated : { ...translated, params };
  }

  #agentIdForUpstreamResponse(upstreamId: JsonRpcId): JsonRpcId | null {
    for (const [agentId, mappedUpstreamId] of this.#agentToUpstream) {
      if (mappedUpstreamId === upstreamId) {
        return agentId;
      }
    }

    return null;
  }

  #allocateId(): JsonRpcId {
    while (this.#usedIds.has(this.#nextId)) {
      this.#nextId += 1;
    }

    const id = this.#nextId;
    this.#usedIds.add(id);
    this.#nextId += 1;
    return id;
  }

  #rememberId(id: JsonRpcId): void {
    this.#usedIds.add(id);
  }
}

type SupportedProtocolVersion = (typeof SUPPORTED_PROTOCOL_VERSIONS)[number];

function isResult(message: JsonRpcMessage): message is JsonRpcResult {
  return "result" in message;
}

function isError(message: JsonRpcMessage): message is JsonRpcError {
  return "error" in message;
}

function isNotification(
  message: JsonRpcMessage,
): message is JsonRpcNotification {
  return "method" in message && !("id" in message);
}

function assertRequestId(id: JsonRpcId): JsonRpcId {
  if (typeof id === "string" && id !== "") {
    return id;
  }

  if (typeof id === "number" && Number.isInteger(id)) {
    return id;
  }

  throw new Error(
    "JSON-RPC id must be a string or integer for session translation",
  );
}

function readRequestIdParam(
  params: JsonObject | undefined,
  key: string,
): JsonRpcId | null {
  if (params === undefined || !(key in params)) {
    return null;
  }

  const value = params[key];
  if (typeof value === "string" && value !== "") {
    return value;
  }
  if (typeof value === "number" && Number.isInteger(value)) {
    return value;
  }

  return null;
}

function remapMetaToken(
  params: JsonObject | undefined,
  nextToken: JsonRpcId,
): JsonObject | undefined {
  const meta = readMeta(params);
  if (meta === null || !("progressToken" in meta)) {
    return params;
  }

  return { ...params, _meta: { ...meta, progressToken: nextToken } };
}

function readMeta(params: JsonObject | undefined): JsonObject | null {
  if (params === undefined || !("_meta" in params)) {
    return null;
  }

  const meta = params._meta;
  if (typeof meta !== "object" || meta === null || Array.isArray(meta)) {
    return null;
  }

  return meta as JsonObject;
}

import type { JsonObject, JsonRpcError, JsonRpcId, JsonRpcMessage, JsonRpcNotification, JsonRpcRequest, JsonRpcResult } from "./rpc.ts";

export type SessionMaps = {
  readonly agentToUpstream: ReadonlyMap<JsonRpcId, number>;
  readonly upstreamToAgent: ReadonlyMap<number, number>;
};

const SUPPORTED_PROTOCOL_VERSIONS = [
  "2025-11-25",
  "2025-06-18",
  "2025-03-26",
  "2024-11-05",
  "2024-10-07",
] as const;

export class Session {
  readonly #agentToUpstream = new Map<JsonRpcId, number>();
  readonly #upstreamToAgent = new Map<number, number>();
  readonly #progressTokens = new Map<number, JsonRpcId>();
  readonly #usedIds = new Set<number>();
  #nextId = 1;

  readonly maps: SessionMaps = {
    agentToUpstream: this.#agentToUpstream,
    upstreamToAgent: this.#upstreamToAgent,
  };

  allocateAgentId(): number {
    return this.#allocateId();
  }

  translateRequestOut(agentRequest: JsonRpcRequest): JsonRpcRequest {
    const agentId = agentRequest.id;
    if (typeof agentId === "number") this.#rememberId(numericId(agentId));
    const upstreamId = this.#allocateId();
    this.#agentToUpstream.set(agentId, upstreamId);
    const token = readMeta(agentRequest.params)?.progressToken;
    if (typeof token === "string" || typeof token === "number") {
      this.#progressTokens.set(upstreamId, token);
    }

    const translated = { ...agentRequest, id: upstreamId };
    const params = remapMetaToken(agentRequest.params, upstreamId);
    return params === agentRequest.params ? translated : { ...translated, params };
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
    const requestedIndex = SUPPORTED_PROTOCOL_VERSIONS.indexOf(requested as SupportedProtocolVersion);
    const acceptable = requestedIndex === -1
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

  #translateResponse(message: JsonRpcResult | JsonRpcError): JsonRpcMessage | null {
    if (message.id === undefined) {
      return null;
    }

    if (typeof message.id === "string") {
      // The proxy always allocates numeric upstream ids, so a string id on a
      // response is an unknown identity, never a reply this session routed.
      return null;
    }

    const upstreamId = numericId(message.id);
    const agentId = this.#agentIdForUpstreamResponse(upstreamId);
    if (agentId === null) {
      return null;
    }

    this.drop(agentId);
    return { ...message, id: agentId };
  }

  #translateNotification(message: JsonRpcNotification): JsonRpcNotification | null {
    if (message.method === "notifications/progress") {
      return this.#translateProgress(message);
    }

    if (message.method === "notifications/cancelled") {
      return this.#translateInboundCancellation(message);
    }

    return message;
  }

  #translateProgress(message: JsonRpcNotification): JsonRpcNotification | null {
    const token = readNumericParam(message.params, "progressToken");
    if (token === null) {
      return null;
    }

    const originalToken = this.#progressTokens.get(token);
    if (originalToken === undefined) return null;
    return { ...message, params: { ...message.params, progressToken: originalToken } };
  }

  #translateInboundCancellation(message: JsonRpcNotification): JsonRpcNotification | null {
    const requestId = readNumericParam(message.params, "requestId");
    if (requestId === null) {
      return message;
    }

    const agentId = this.#agentIdForUpstreamResponse(requestId);
    if (agentId === null) return null;

    this.drop(agentId);
    return { ...message, params: { ...message.params, requestId: agentId } };
  }

  #translateServerRequest(message: JsonRpcRequest): JsonRpcRequest {
    const upstreamId = numericId(message.id);
    this.#rememberId(upstreamId);
    const agentId = this.#allocateId();
    this.#upstreamToAgent.set(upstreamId, agentId);

    const translated = { ...message, id: agentId };
    const params = remapMetaToken(message.params, agentId);
    return params === message.params ? translated : { ...translated, params };
  }

  #agentIdForUpstreamResponse(upstreamId: number): number | string | null {
    for (const [agentId, mappedUpstreamId] of this.#agentToUpstream) {
      if (mappedUpstreamId === upstreamId) {
        return agentId;
      }
    }

    return null;
  }

  #allocateId(): number {
    while (this.#usedIds.has(this.#nextId)) {
      this.#nextId += 1;
    }

    const id = this.#nextId;
    this.#usedIds.add(id);
    this.#nextId += 1;
    return id;
  }

  #rememberId(id: number): void {
    this.#usedIds.add(id);
  }
}

type SupportedProtocolVersion = typeof SUPPORTED_PROTOCOL_VERSIONS[number];

function isResult(message: JsonRpcMessage): message is JsonRpcResult {
  return "result" in message;
}

function isError(message: JsonRpcMessage): message is JsonRpcError {
  return "error" in message;
}

function isNotification(message: JsonRpcMessage): message is JsonRpcNotification {
  return "method" in message && !("id" in message);
}

function numericId(id: JsonRpcId): number {
  if (typeof id === "number" && Number.isInteger(id)) {
    return id;
  }

  if (typeof id === "string" && /^\d+$/.test(id)) {
    return Number(id);
  }

  throw new Error("JSON-RPC id must be an integer for session translation");
}

function readNumericParam(params: JsonObject | undefined, key: string): number | null {
  if (params === undefined || !(key in params)) {
    return null;
  }

  const value = params[key];
  if (typeof value !== "number" || !Number.isInteger(value)) {
    return null;
  }

  return value;
}

function remapMetaToken(params: JsonObject | undefined, nextToken: number): JsonObject | undefined {
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

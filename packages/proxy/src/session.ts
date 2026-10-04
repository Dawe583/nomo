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
   *
   * Both ids are reserved, not just the upstream one: the agent id is what
   * #upstreamIdForServerRequest matches a reply against, so an id this
   * session minted for something else would make that reply ambiguous.
   */
  recordServerRequest(upstreamId: JsonRpcId, agentId: JsonRpcId): void {
    this.#upstreamToAgent.set(
      assertRequestId(upstreamId),
      assertRequestId(agentId),
    );
    this.#rememberId(upstreamId);
    this.#rememberId(agentId);
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

  /**
   * Releases every row this agent id holds, in whichever direction it was
   * minted. A client request keys #agentToUpstream by its agent id; a
   * server-originated request holds its agent id as the *value* of an
   * #upstreamToAgent row, so that row is found by the same reverse scan
   * #agentIdForUpstreamResponse already makes over the other map. When one
   * agent id is live in both directions the client row wins: the id came
   * from the client, so the terminal frame that named it is the client's,
   * and a server row that merely holds the same number stays live.
   */
  drop(agentId: JsonRpcId): void {
    const upstreamId = this.#agentToUpstream.get(agentId);
    this.#agentToUpstream.delete(agentId);
    this.#usedIds.delete(agentId);

    if (upstreamId !== undefined) {
      this.#progressTokens.delete(upstreamId);
      return;
    }

    // No client row claims this id, so it is the agent id this session minted
    // for a request the upstream itself sent.
    const serverUpstreamId = this.#upstreamIdForServerRequest(agentId);
    if (serverUpstreamId !== null) this.#releaseServerRequest(serverUpstreamId);
  }

  /**
   * Releases the row of a server-originated request, keyed by the upstream id
   * it arrived with, plus the progress token filed under its agent id. Only
   * the upstream can name that key, so a frame carrying it is the upstream
   * retiring its own request; the frame itself is still not routed anywhere.
   */
  #releaseServerRequest(upstreamId: JsonRpcId): void {
    const agentId = this.#upstreamToAgent.get(upstreamId);
    if (agentId === undefined) return;

    this.#upstreamToAgent.delete(upstreamId);
    this.#progressTokens.delete(agentId);
    this.#usedIds.delete(upstreamId);
  }

  /**
   * The upstream id of the server-originated request this agent id was minted
   * for. A reverse scan for the same reason #agentIdForUpstreamResponse is
   * one: #upstreamToAgent is keyed by an id the upstream chose, and every
   * terminal path arrives holding the id this session chose. The comparison
   * is `===` so a string agent id never matches its numeric lookalike.
   */
  #upstreamIdForServerRequest(agentId: JsonRpcId): JsonRpcId | null {
    for (const [upstreamId, mappedAgentId] of this.#upstreamToAgent) {
      if (mappedAgentId === agentId) {
        return upstreamId;
      }
    }

    return null;
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
      // No client request claims this id. It may still name the agent id this
      // session minted for a request the upstream itself sent, and that row
      // belongs to the upstream to retire. The reply is dropped exactly as
      // before; only the row goes, so the id cannot outlive the exchange.
      const serverUpstreamId = this.#upstreamIdForServerRequest(upstreamId);
      if (serverUpstreamId !== null) this.#releaseServerRequest(serverUpstreamId);
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
    if (agentId === null) {
      // The upstream may be cancelling a request it sent itself, whose row
      // #agentToUpstream cannot resolve. That row is released here, keyed by
      // the id the upstream chose, and the notification is dropped as before
      // because there is no client request for it to translate to.
      this.#releaseServerRequest(requestId);
      return null;
    }

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

  /**

   * Mints the next id. #nextId only ever climbs, so an id this session has
   * minted is never handed out twice and needs no reservation of its own;
   * #usedIds holds only the ids the peers are using right now. Skipping
   * those keeps a minted id from colliding with a live peer id in either
   * direction, which is what the reverse scans below and the typed identity
   * of an id both depend on.
   *
   * A terminated request's ids leave #usedIds with its rows, so a long-dead
   * id can be minted again. The cost is that a late frame naming a released
   * id is attributed to whichever request holds that id now. It cannot reach
   * a live request: while a request is live both of its peer ids sit in
   * #usedIds and this loop skips them, so no minted id ever equals a live
   * peer id, and the scans that route a frame match only live rows.
   */
  #allocateId(): JsonRpcId {
    while (this.#usedIds.has(this.#nextId)) {
      this.#nextId += 1;
    }

    const id = this.#nextId;
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

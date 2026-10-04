import type { IncomingMessage, ServerResponse } from "node:http";

import { relayNotification } from "./notifications.ts";
import type { JsonRpcError, JsonRpcId, JsonRpcMessage, JsonRpcNotification, JsonRpcRequest, JsonRpcResult } from "../rpc.ts";
import { Session } from "../session.ts";
import type { UpstreamProcess } from "../transport/stdio.ts";

const HTTP_RELAY_MAX_BODY_SIZE = 10 * 1024 * 1024;
const HTTP_RELAY_MAX_PENDING = 128;
const HTTP_RELAY_REQUEST_TIMEOUT_MS = 120_000;
const HTTP_RELAY_MAX_SSE_BUFFER_SIZE = 1024 * 1024;
const PARSE_ERROR = -32700;
const INVALID_REQUEST = -32600;
const INTERNAL_ERROR = -32603;
const REQUEST_CANCELLED = -32800;

export type HttpRequestRelayOptions = {
  readonly upstream: UpstreamProcess;
  readonly session?: Session;
  readonly maxBodySize?: number;
  readonly maxPendingRequests?: number;
  readonly requestTimeoutMs?: number;
  readonly onError?: (error: Error) => void;
};

export type HttpRequestRelay = {
  readonly handle: (request: IncomingMessage, response: ServerResponse) => Promise<void>;
  readonly receiveUpstreamLine: (line: string) => void;
  readonly close: () => void;
  readonly session: Session;
};

type PendingById = {
  readonly upstreamId: JsonRpcId;
  readonly agentId: JsonRpcId;
  readonly pending: PendingHttpResponse;
};

export function createHttpRequestRelay(options: HttpRequestRelayOptions): HttpRequestRelay {
  const session = options.session ?? new Session();
  const maxBodySize = options.maxBodySize ?? HTTP_RELAY_MAX_BODY_SIZE;
  const maxPendingRequests = options.maxPendingRequests ?? HTTP_RELAY_MAX_PENDING;
  const requestTimeoutMs = options.requestTimeoutMs ?? HTTP_RELAY_REQUEST_TIMEOUT_MS;
  if (!Number.isSafeInteger(maxPendingRequests) || maxPendingRequests < 1 || !Number.isSafeInteger(requestTimeoutMs) || requestTimeoutMs < 1) {
    throw new RangeError("HTTP relay limits must be positive safe integers");
  }
  const pendingByUpstream = new Map<JsonRpcId, PendingById>();
  const pendingByAgent = new Map<JsonRpcId, PendingById>();
  // Reserved before the first await: reading pendingByUpstream.size after
  // readBody resolves lets two concurrent requests both see room and both
  // take it, and the ceiling stops being a ceiling.
  let reservedHandles = 0;

  const removePending = (entry: PendingById): void => {
    pendingByUpstream.delete(entry.upstreamId);
    pendingByAgent.delete(entry.agentId);
    entry.pending.delete(entry.agentId);
    session.drop(entry.agentId);
  };

  const fail = (error: Error): void => {
    options.onError?.(error);
  };

  const handle = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    if (request.method !== "POST") {
      response.writeHead(405, { allow: "POST" });
      response.end();
      return;
    }

    if (reservedHandles >= maxPendingRequests) {
      writeJson(response, 429, jsonRpcError(null, INTERNAL_ERROR, "HTTP relay pending-request limit exceeded"));
      return;
    }
    reservedHandles += 1;
    try {
      await handleReserved(request, response);
    } finally {
      reservedHandles -= 1;
    }
  };

  const handleReserved = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {

    let parsed: unknown;
    try {
      parsed = JSON.parse(await readBody(request, maxBodySize)) as unknown;
    } catch (error) {
      const status = error instanceof BodyTooLargeError ? 413 : 400;
      writeJson(response, status, jsonRpcError(null, PARSE_ERROR, errorMessage(error)));
      return;
    }

    const messages: unknown[] = Array.isArray(parsed) ? parsed : [parsed];
    const batch = Array.isArray(parsed);
    if (messages.length === 0) {
      writeJson(response, 400, jsonRpcError(null, INVALID_REQUEST, "JSON-RPC batch must not be empty"));
      return;
    }

    const requests: JsonRpcRequest[] = [];
    const notifications: JsonRpcNotification[] = [];
    const seenIds = new Set<JsonRpcId>();
    try {
      for (const message of messages) {
        if (isRequest(message)) {
          if (pendingByAgent.has(message.id) || seenIds.has(message.id)) {
            throw new TypeError("Duplicate JSON-RPC request id");
          }
          seenIds.add(message.id);
          requests.push(message);
        } else if (isNotification(message)) {
          notifications.push(message);
        } else {
          throw new TypeError("HTTP relay accepts JSON-RPC requests and notifications only");
        }
      }
    } catch (error) {
      writeJson(response, 400, jsonRpcError(null, INVALID_REQUEST, errorMessage(error)));
      return;
    }
    if (requests.length > maxPendingRequests - pendingByUpstream.size) {
      writeJson(response, 429, jsonRpcError(null, INTERNAL_ERROR, "HTTP relay pending-request limit exceeded"));
      return;
    }
    try {
      for (const notification of notifications) {
        routeNotification(notification, options.upstream, session, pendingByAgent, removePending);
      }
    } catch (error) {
      writeJson(response, 502, jsonRpcError(null, INTERNAL_ERROR, errorMessage(error)));
      return;
    }

    if (requests.length === 0) {
      response.writeHead(202);
      response.end();
      return;
    }

    const sse = acceptsSse(request.headers.accept);
    const pending = new PendingHttpResponse(response, requests.length, batch, sse, requestTimeoutMs, removePending);

    if (sse) {
      response.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
    }

    try {
      for (const clientRequest of requests) {
        const upstreamRequest = session.translateRequestOut(clientRequest);
        const entry = {
          upstreamId: upstreamRequest.id,
          agentId: clientRequest.id,
          pending,
        };
        pending.add(entry);
        pendingByUpstream.set(entry.upstreamId, entry);
        pendingByAgent.set(entry.agentId, entry);
        options.upstream.send(JSON.stringify(upstreamRequest));
      }
    } catch (error) {
      pending.closeWithError(jsonRpcError(null, INTERNAL_ERROR, errorMessage(error)));
    }
  };

  const receiveUpstreamLine = (line: string): void => {
    let message: JsonRpcMessage;
    try {
      message = JSON.parse(line) as JsonRpcMessage;
    } catch (error) {
      fail(new Error(`upstream sent malformed JSON: ${errorMessage(error)}`));
      return;
    }

    if (isProgressNotification(message)) {
      // The token on the wire is the id this session minted for the request,
      // so the routing key is typed and read from the upstream frame. What the
      // agent receives is Session's translation, carrying the agent's own
      // token back.
      const upstreamToken = readIdParam(message.params, "progressToken");
      const translated = session.translateInbound(message);
      if (upstreamToken !== null && translated !== null && isNotification(translated)) {
        pendingByUpstream.get(upstreamToken)?.pending.writeSse(translated);
      }
      return;
    }

    if (isResponse(message)) {
      const entry = message.id === undefined ? undefined : pendingByUpstream.get(message.id);
      const translated = session.translateInbound(message);
      if (entry !== undefined && translated !== null && isResponse(translated)) {
        entry.pending.complete(entry, translated);
      }
      return;
    }

    if (isNotification(message)) {
      const translated = relayNotification(message, session.maps).notification;
      if (translated.method === "notifications/cancelled") {
        const agentId = readIdParam(translated.params, "requestId");
        if (agentId !== null) {
          const entry = pendingByAgent.get(agentId);
          if (entry !== undefined) {
            entry.pending.cancel(entry, translated);
          }
        }
      }
      return;
    }
  };

  return {
    handle,
    receiveUpstreamLine,
    close(): void {
      for (const entry of pendingByUpstream.values()) {
        entry.pending.closeWithError(jsonRpcError(entry.agentId, INTERNAL_ERROR, "HTTP relay closed"));
      }
      pendingByUpstream.clear();
      pendingByAgent.clear();
    },
    session,
  };
}

export async function receiveRequest(
  request: IncomingMessage,
  response: ServerResponse,
  relay: HttpRequestRelay,
): Promise<void> {
  await relay.handle(request, response);
}

class PendingHttpResponse {
  readonly #response: ServerResponse;
  readonly #total: number;
  readonly #batch: boolean;
  readonly #sse: boolean;
  readonly #onDone: (entry: PendingById) => void;
  readonly #responses: Array<JsonRpcResult | JsonRpcError> = [];
  readonly #entries = new Map<JsonRpcId, PendingById>();
  readonly #frames: string[] = [];
  readonly #drainTimeoutMs: number;
  #queuedBytes = 0;
  #backpressured = false;
  #finishWhenDrained = false;
  #drainTimer: NodeJS.Timeout | null = null;
  readonly #timer: NodeJS.Timeout;
  #completed = 0;
  #closed = false;

  constructor(
    response: ServerResponse,
    total: number,
    batch: boolean,
    sse: boolean,
    timeoutMs: number,
    onDone: (entry: PendingById) => void,
  ) {
    this.#response = response;
    this.#total = total;
    this.#batch = batch;
    this.#sse = sse;
    this.#onDone = onDone;
    this.#drainTimeoutMs = Math.min(timeoutMs, 30_000);
    response.once("close", () => {
      clearTimeout(this.#drainTimer ?? undefined);
      this.#abandon();
    });
    this.#timer = setTimeout(() => this.closeWithError(
      jsonRpcError(null, INTERNAL_ERROR, "Upstream outcome unknown after deadline; reconcile before retry"),
      504,
    ), timeoutMs);
    this.#timer.unref();
  }

  add(entry: PendingById): void {
    this.#entries.set(entry.agentId, entry);
  }

  delete(agentId: JsonRpcId): void {
    this.#entries.delete(agentId);
  }

  complete(entry: PendingById, response: JsonRpcResult | JsonRpcError): void {
    if (this.#closed || !this.#entries.has(entry.agentId)) return;
    this.#onDone(entry);
    if (this.#sse) {
      this.writeSse(response);
    } else {
      this.#responses.push(response);
    }
    this.#markComplete();
  }

  cancel(entry: PendingById, notification: JsonRpcNotification): void {
    if (this.#closed || !this.#entries.has(entry.agentId)) return;
    this.#onDone(entry);
    if (this.#sse) {
      this.writeSse(notification);
    } else {
      this.#responses.push(jsonRpcError(entry.agentId, REQUEST_CANCELLED, "Request cancelled"));
    }
    this.#markComplete();
  }

  writeSse(message: JsonRpcMessage): void {
    if (this.#closed || !this.#sse) return;
    this.#sendFrame(`data: ${JSON.stringify(message)}\n\n`);
  }

  closeWithError(error: JsonRpcError, status = 500): void {
    if (this.#closed) return;
    this.#abandon();
    if (this.#sse) {
      this.#sendFrame(`data: ${JSON.stringify(error)}\n\n`);
      this.#finishSse();
    } else {
      writeJson(this.#response, status, error);
    }
  }

  #sendFrame(frame: string): void {
    const size = Buffer.byteLength(frame);
    if (size + this.#queuedBytes + this.#response.writableLength > HTTP_RELAY_MAX_SSE_BUFFER_SIZE) {
      this.#abandon();
      this.#response.destroy();
      return;
    }
    if (this.#backpressured) {
      this.#frames.push(frame);
      this.#queuedBytes += size;
    } else if (!this.#response.write(frame)) {
      this.#waitForDrain();
    }
  }

  #waitForDrain(): void {
    this.#backpressured = true;
    this.#response.once("drain", () => this.#flush());
    this.#drainTimer = setTimeout(() => {
      this.#abandon();
      this.#response.destroy();
    }, this.#drainTimeoutMs);
    this.#drainTimer.unref();
  }

  #flush(): void {
    this.#backpressured = false;
    clearTimeout(this.#drainTimer ?? undefined);
    this.#drainTimer = null;
    while (this.#frames.length > 0) {
      const frame = this.#frames.shift();
      if (frame === undefined) break;
      this.#queuedBytes -= Buffer.byteLength(frame);
      if (!this.#response.write(frame)) {
        this.#waitForDrain();
        return;
      }
    }
    if (this.#finishWhenDrained) this.#response.end();
  }

  #finishSse(): void {
    this.#finishWhenDrained = true;
    if (!this.#backpressured) this.#response.end();
  }

  #abandon(): void {
    if (this.#closed) return;
    this.#closed = true;
    clearTimeout(this.#timer);
    for (const entry of this.#entries.values()) this.#onDone(entry);
  }

  #markComplete(): void {
    this.#completed += 1;
    if (this.#completed < this.#total || this.#closed) return;
    this.#abandon();
    if (this.#sse) {
      this.#finishSse();
    } else {
      writeJson(this.#response, 200, this.#batch ? this.#responses : this.#responses[0]);
    }
  }
}

class BodyTooLargeError extends Error {}

async function readBody(request: IncomingMessage, maxBodySize: number): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    size += buffer.length;
    if (size > maxBodySize) {
      throw new BodyTooLargeError(`HTTP request body exceeded ${maxBodySize} bytes`);
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks, size).toString("utf8");
}

function routeNotification(
  notification: JsonRpcNotification,
  upstream: UpstreamProcess,
  session: Session,
  pendingByAgent: ReadonlyMap<JsonRpcId, PendingById>,
  removePending: (entry: PendingById) => void,
): void {
  if (notification.method === "notifications/cancelled") {
    const requestId = readIdParam(notification.params, "requestId");
    if (requestId === null) {
      return;
    }
    const entry = pendingByAgent.get(requestId);
    const cancel = session.translateCancellation(requestId);
    if (cancel !== null) {
      upstream.send(JSON.stringify(cancel));
    }
    if (entry !== undefined) {
      const relayed = { ...notification, params: { ...notification.params, requestId } };
      entry.pending.cancel(entry, relayed);
      removePending(entry);
    }
    return;
  }

  upstream.send(JSON.stringify(notification));
}

function writeJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

function jsonRpcError(id: JsonRpcId | null, code: number, message: string, data?: unknown): JsonRpcError {
  return { jsonrpc: "2.0", id: id ?? undefined, error: data === undefined ? { code, message } : { code, message, data } };
}

function acceptsSse(accept: string | undefined): boolean {
  return accept?.split(",").some((part) => part.trim().toLowerCase().startsWith("text/event-stream")) ?? false;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isRequest(value: unknown): value is JsonRpcRequest {
  return isObject(value) && value.jsonrpc === "2.0" && typeof value.method === "string" && "id" in value;
}

function isNotification(value: unknown): value is JsonRpcNotification {
  return isObject(value) && value.jsonrpc === "2.0" && typeof value.method === "string" && !("id" in value);
}

function isResponse(value: JsonRpcMessage): value is JsonRpcResult | JsonRpcError {
  return "id" in value && ("result" in value || "error" in value);
}

function isProgressNotification(value: JsonRpcMessage): value is JsonRpcNotification {
  return isNotification(value) && value.method === "notifications/progress";
}

function readIdParam(params: Readonly<Record<string, unknown>> | undefined, key: string): JsonRpcId | null {
  const value = params?.[key];
  return (typeof value === "string" && value !== "") || (typeof value === "number" && Number.isInteger(value)) ? value : null;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

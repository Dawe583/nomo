import { createHash } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { canonicalJson } from "../../../../packages/ledger/src/canonical.ts";
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
import { readOperation, type CompanionOperationStatus } from "./operations.ts";
import { companionWorkspace, CompanionStoreError } from "./store.ts";

type JsonObject = Record<string, unknown>;

/** The frozen protocol constants. They are repeated here rather than imported
 * from the scripts package because the API app must not depend on it, exactly
 * as `companion.test.ts` transcribes the frozen predicates instead of
 * importing the validator. */
const protocol = "void.companion.v1";
const schemaVersion = 1;

/** Protocol v1 admission bounds: the frozen `maxRequestBytes`, the executor
 * clock skew allowance of section 3.3, and the response ceiling the Apple
 * client enforces in `CompanionHTTPClient.maxResponseBytes`. */
const maxRequestBytes = 65_536;
const maxResponseBytes = 1_048_576;
const maxSkewMs = 60_000;
const credentialTtlMs = 15 * 60 * 1000;

const requestFields = [
  "protocol", "schemaVersion", "kind", "requestId", "operationId", "operation",
  "deviceId", "workspaceId", "sessionId", "idempotencyKey", "issuedAt", "expiresAt", "bodyDigest", "body",
] as const;

/** The identity an answer echoes. It is derived only from fields that already
 * passed the bound, so a refused request never reflects raw input, and a body
 * that could not be parsed is answered as explicitly unattributed instead of
 * borrowing an identity it does not have. */
const unattributed = "unattributed";

/** An identity or scope value the envelope carries is a claim to check. The
 * bound is the frozen `text` rule plus a backslash, because the Apple client
 * refuses one in `isBoundedID` and an adapter must never mint an identity its
 * own client would reject. */
function boundedIdentity(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 160
    && Buffer.from(value, "utf8").toString("utf8") === value
    && !/[\u0000-\u001f\u007f/\\]/.test(value);
}

function isUtcTimestamp(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/.test(value)
    && Number.isFinite(Date.parse(value));
}

function recordOf(value: unknown): JsonObject | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as JsonObject : null;
}

function exactKeys(value: JsonObject, allowed: readonly string[]): boolean {
  return Object.keys(value).every(key => allowed.includes(key));
}

type Reply = {
  readonly httpStatus: number;
  readonly outcome: "succeeded" | "denied" | "conflict" | "unknown" | "running" | "unsupported_version" | "expired";
  readonly body?: JsonObject;
  readonly error?: {
    readonly code: string;
    readonly message: string;
    readonly retryable: boolean;
    readonly reconcileRequired?: boolean;
    readonly supportedVersions?: readonly string[];
  };
};

type Echo = {
  readonly requestId: string;
  readonly operationId: string;
  readonly operation: string;
};

/** The device and workspace an answer carries. It is the identity the request
 * itself claimed, or the one a pairing call just minted, and it is null when
 * neither is known: a refusal can then never confirm a device or a workspace
 * the caller did not already name. */
type EchoedScope = { readonly deviceId: string; readonly workspaceId: string } | null;

type RunContext = {
  readonly env: Readonly<NodeJS.ProcessEnv>;
  /** The authority the bound operation runs with. Pairing runs as the host,
   * because the host mints the device, not the caller. */
  readonly session: CompanionSession;
  readonly request: JsonObject;
  readonly operationId: string;
  readonly deviceId: string;
};

type Binding = {
  /** The internal path this operation is bound to. The adapter calls the same
   * store and projection primitives that path uses, so the two cannot drift
   * apart silently; `envelope.test.ts` proves the bound body is byte for byte
   * the one the internal path returns. */
  readonly internalPath: string;
  readonly requiredScope: CompanionScope;
  /** The scope a paired device must already hold before the operation runs. */
  readonly baselineScope: CompanionScope;
  readonly run: (context: RunContext) => Reply;
};

/** The executor identity this host has not published. A fabricated stable
 * identifier would let a phone pin a value that proves nothing about which
 * machine answered, so the fields carry an explicit unverified marker and the
 * handshake lists the identity among its pending behaviors. */
const executor = {
  executorId: "executor-unverified",
  displayName: "Paired Mac",
  platform: process.platform === "darwin" ? "macos" : process.platform,
  build: "unverified",
  identityKeyId: "identity-unverified",
} as const;

const refusalOutcomes = { 403: "denied", 409: "conflict", 410: "expired" } as const;

/** A refusal is never retryable: reading it as a retry would either repeat an
 * effect or reword a decision the contract calls final. */
function refused(httpStatus: 403 | 409 | 410, code: string, message: string): Reply {
  return { httpStatus, outcome: refusalOutcomes[httpStatus], error: { code, message, retryable: false } };
}

/** The v1 admission ceilings of section 12. A server may answer lower, never
 * higher, and this adapter answers with the contract values. */
const limits: JsonObject = {
  maxRequestBytes: 65_536,
  maxPromptCharacters: 32_000,
  maxEventsPerPage: 1_000,
  maxEventPageBytes: 1_048_576,
  maxEventBytes: 32_768,
  maxStreamSeconds: 55,
  replayWindowSeconds: 900,
  idempotencyRetentionHours: 24,
  deviceCredentialSeconds: 900,
  invitationSeconds: 120,
  grantSeconds: 300,
  recoveryPlanSeconds: 900,
  maxMutationsPerDevice: 2,
  maxStreamsPerDevice: 2,
  maxDevicesPerWorkspace: 8,
  maxOperationIds: 500,
  maxErrorCharacters: 320,
};

/** Every capability this adapter can bind is `pending`: the frozen contract
 * allows no `available` status before contract, security, and device evidence,
 * and an unlisted capability is unsupported for this handshake. The order is
 * the order they are reported in. */
const capabilityIds = ["capability.handshake", "operation.status", "device.revoke", "diagnostics.read"] as const;

/** Pairing is the one operation a device without a credential may call, because
 * it is the operation that mints the credential. Every other operation proves
 * an existing one first. */
const uncredentialed: Record<string, true> = { "device.pair": true };

/** `device.revoke` is a frozen mutation and pairing issues authority, so both
 * carry a stable idempotency key across retries. */
const mutating: Record<string, true> = { "device.revoke": true, "device.pair": true };

function handshake(context: RunContext): Reply {
  const body = recordOf(context.request.body);
  const client = body === null ? null : recordOf(body.client);
  const requested = body === null ? null : body.requestedCapabilities;
  const catalog: readonly string[] = capabilityIds;
  if (client === null || !exactKeys(client, ["name", "version", "platform"]) ||
      !boundedIdentity(client.name) || !boundedIdentity(client.version) || !boundedIdentity(client.platform) ||
      !Array.isArray(requested) || requested.length === 0 || requested.length > 16 ||
      !requested.every(id => typeof id === "string" && catalog.includes(id))) {
    return refused(403, "invalid_request", "The handshake body is not the v1 negotiation shape.");
  }
  return {
    httpStatus: 200,
    outcome: "succeeded",
    body: {
      serverTime: new Date().toISOString(),
      protocolVersions: [protocol],
      executor: { ...executor },
      workspace: { workspaceId: context.session.workspaceId },
      device: { deviceId: context.session.deviceId, state: "paired" },
      capabilities: catalog
        .filter(id => requested.includes(id))
        .map(id => ({
          id,
          version: "1",
          status: "pending",
          requiredScope: bindings[id]!.requiredScope,
          limitation: "The companion envelope adapter is pending device and physical-device evidence.",
        })),
      limits: { ...limits },
      pendingBehaviors: [
        "executor identity and pinned certificate",
        "session reads and sends",
        "bounded event cursor",
        "approval decisions",
        "recovery preview and apply",
        "physical-device evidence",
      ],
      expiresAt: new Date(Date.now() + credentialTtlMs).toISOString(),
    },
  };
}

function operationStatus(context: RunContext): Reply {
  const record = readOperation(context.env, context.session.workspaceId, context.operationId);
  // The internal path answers 404 for an identifier it cannot prove, and that
  // answer is reused rather than reinterpreted: a lookup must never report an
  // outcome it cannot read, and an unusable identifier is never promoted to
  // `unknown`, which the contract reserves for a dispatched mutation whose
  // receipt was lost.
  if (record === null) {
    return { ...refused(403, "operation_unknown", "The operation identity is not available to this device."), body: { operationId: context.operationId, status: "denied" } };
  }
  return statusReply(context.operationId, record.status);
}

/** A durable status becomes the outcome of the same name, except for `revoked`.
 * The frozen validator requires a body on every `operation.status` response and
 * also refuses any `revoked` response that carries one, so the two rules leave a
 * status read of a revoked operation unrepresentable. The frozen contract wins:
 * the lookup is answered as a refusal with an explicit `device_revoked` error
 * and a denied status, which stays fail closed instead of inventing a durable
 * outcome the validator would reject. */
function statusReply(operationId: string, status: CompanionOperationStatus): Reply {
  if (status === "revoked") return { ...refused(403, "device_revoked", "The operation was retired by device revocation."), body: { operationId, status: "denied" } };
  if (status === "unknown") {
    return {
      httpStatus: 202,
      outcome: "unknown",
      body: { operationId, status },
      error: { code: "operation_unknown", message: "The operation outcome is not confirmed; reconcile its evidence.", retryable: false, reconcileRequired: true },
    };
  }
  if (status === "succeeded") return { httpStatus: 200, outcome: "succeeded", body: { operationId, status } };
  if (status === "running") return { httpStatus: 202, outcome: "running", body: { operationId, status } };
  if (status === "denied") return { ...refused(403, "authorization_denied", "The operation was refused before any effect."), body: { operationId, status } };
  if (status === "conflict") return { ...refused(409, "human_edit_conflict", "The operation target changed; obtain a fresh plan."), body: { operationId, status } };
  return { ...refused(410, "request_expired", "The operation record expired."), body: { operationId, status } };
}

function deviceRevoke(context: RunContext): Reply {
  const receipt = revokeDevice(context.env, context.deviceId);
  if (receipt === null) return refused(403, "authorization_denied", "The device identity is not available to this workspace.");
  return {
    httpStatus: 200,
    outcome: "succeeded",
    body: { deviceId: receipt.deviceId, revokedAt: receipt.revokedAt, newMutationsAllowed: false, activeStreamsClosed: true },
  };
}

function diagnosticsRead(context: RunContext): Reply {
  return { httpStatus: 200, outcome: "succeeded", body: { entries: companionDiagnostics(context.env, context.session).entries } };
}

/** Pairing parses the same label and scope vocabulary as the internal path, so
 * one request mints the same record on either route. */
function parsePairingBody(body: JsonObject): { readonly label: string; readonly scopes: readonly CompanionScope[] } | null {
  if (!exactKeys(body, ["label", "scopes"])) return null;
  const label = body.label ?? "companion device";
  if (typeof label !== "string" || !plainLabel(label)) return null;
  const requested = body.scopes ?? readOnlyScopes;
  if (!Array.isArray(requested) || requested.length > 2) return null;
  const granted: CompanionScope[] = [];
  for (const scope of requested) {
    if (scope !== readScope && scope !== writeScope) return null;
    if (!granted.includes(scope)) granted.push(scope);
  }
  return { label, scopes: granted.sort() };
}

function devicePair(context: RunContext): Reply {
  const body = recordOf(context.request.body);
  const input = body === null ? null : parsePairingBody(body);
  if (input === null) return refused(403, "invalid_request", "The pairing body is not the v1 pairing shape.");
  const { device, deviceToken } = pairDevice(context.env, input);
  return {
    httpStatus: 201,
    outcome: "succeeded",
    body: {
      deviceId: device.deviceId,
      deviceToken,
      expiresAt: new Date(Date.parse(device.createdAt) + credentialTtlMs).toISOString(),
      scopes: [...device.scopes],
    },
  };
}

const bindings: Readonly<Record<string, Binding>> = {
  "capability.handshake": { internalPath: "GET /api/capabilities", requiredScope: readScope, baselineScope: readScope, run: handshake },
  "operation.status": { internalPath: "GET /api/companion/operations/:operationId", requiredScope: readScope, baselineScope: readScope, run: operationStatus },
  "device.revoke": { internalPath: "POST /api/companion/devices/:deviceId/revoke", requiredScope: writeScope, baselineScope: readScope, run: deviceRevoke },
  "diagnostics.read": { internalPath: "GET /api/companion/diagnostics", requiredScope: readScope, baselineScope: readScope, run: diagnosticsRead },
  "device.pair": { internalPath: "POST /api/companion/devices", requiredScope: readScope, baselineScope: readScope, run: devicePair },
};

/** Body shapes, transcribed from the frozen request validators so the adapter
 * refuses exactly what the shared fixtures refuse. The pairing body is the one
 * shape the frozen catalog does not carry, because pairing is P05 work. */
function bodyRefusal(operation: string, body: JsonObject): Reply | null {
  if (operation === "diagnostics.read") {
    return exactKeys(body, []) ? null : refused(403, "invalid_request", "The diagnostics read body is not empty.");
  }
  if (operation === "operation.status" && (!exactKeys(body, ["operationId"]) || !boundedIdentity(body.operationId))) {
    return refused(403, "invalid_request", "The operation status body is not the frozen shape.");
  }
  if (operation === "device.revoke" && (!exactKeys(body, ["deviceId"]) || !boundedIdentity(body.deviceId))) {
    return refused(403, "invalid_request", "The revoke body is not the frozen shape.");
  }
  return null;
}

function envelopeFor(echo: Echo, reply: Reply, scope: EchoedScope): JsonObject {
  return {
    protocol,
    schemaVersion,
    kind: "response",
    requestId: echo.requestId,
    operationId: echo.operationId,
    operation: echo.operation,
    ...(scope === null ? {} : { deviceId: scope.deviceId, workspaceId: scope.workspaceId }),
    httpStatus: reply.httpStatus,
    outcome: reply.outcome,
    ...(reply.body === undefined ? {} : { body: reply.body }),
    ...(reply.error === undefined ? {} : { error: { ...reply.error } }),
  };
}

/** The companion response headers, transcribed from `companion/routes.ts`
 * because `sendJson` there is private to that module. A device projection is
 * never framed by a browser surface, on either route. */
function sendJson(response: ServerResponse, statusCode: number, value: JsonObject): void {
  response.setHeader("cache-control", "no-store");
  response.setHeader("x-content-type-options", "nosniff");
  response.setHeader("x-frame-options", "DENY");
  response.setHeader("content-security-policy", "frame-ancestors 'none'");
  response.statusCode = statusCode;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.end(JSON.stringify(value));
}

/** A success without a body is never sent as a success. The bound operation
 * decides the outcome, and an envelope that contradicts it is answered with a
 * stable refusal instead of an outcome the client would read as evidence. */
function sendReply(response: ServerResponse, echo: Echo, reply: Reply, scope: EchoedScope): void {
  const complete = reply.outcome !== "succeeded" || (reply.body !== undefined && Object.keys(reply.body).length > 0);
  const answer: Reply = complete ? reply : refused(403, "internal_error", "The operation produced no receipt to report.");
  const envelope = envelopeFor(echo, answer, scope);
  if (Buffer.byteLength(JSON.stringify(envelope), "utf8") > maxResponseBytes) {
    const overflow = refused(403, "internal_error", "The response exceeded the protocol bound.");
    return sendJson(response, overflow.httpStatus, envelopeFor(echo, overflow, scope));
  }
  sendJson(response, answer.httpStatus, envelope);
}

/** An explicit JSON content type and a hard body bound, transcribed from
 * `companion/routes.ts`: a body the server could not read is never the same as
 * an absent one, and a text/plain form post never parses as an envelope. */
async function readEnvelopeBody(request: IncomingMessage): Promise<{ readonly present: boolean; readonly value: unknown }> {
  const contentType = request.headers["content-type"];
  if (contentType === undefined || contentType.split(";", 1)[0]!.trim().toLowerCase() !== "application/json") return { present: false, value: undefined };
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
    size += buffer.length;
    if (size > maxRequestBytes) return { present: true, value: null };
    chunks.push(buffer);
  }
  if (chunks.length === 0) return { present: false, value: undefined };
  try {
    return { present: true, value: JSON.parse(Buffer.concat(chunks).toString("utf8")) };
  } catch {
    return { present: true, value: null };
  }
}

const emptyEcho: Echo = { requestId: unattributed, operationId: unattributed, operation: unattributed };

export async function handleCompanionEnvelopeRequest(
  request: IncomingMessage,
  response: ServerResponse,
  env: Readonly<NodeJS.ProcessEnv>,
): Promise<void> {
  if (request.method !== "POST") {
    return sendReply(response, emptyEcho, refused(403, "invalid_request", "The envelope route accepts POST only."), null);
  }
  const { present, value } = await readEnvelopeBody(request);
  const parsed = recordOf(value);
  if (!present || parsed === null) {
    return sendReply(response, emptyEcho, refused(403, "invalid_request", "The request body is not a protocol envelope."), null);
  }
  const echo: Echo = {
    requestId: boundedIdentity(parsed.requestId) ? parsed.requestId : unattributed,
    operationId: boundedIdentity(parsed.operationId) ? parsed.operationId : unattributed,
    operation: boundedIdentity(parsed.operation) ? parsed.operation : unattributed,
  };
  try {
    // The version is negotiated before the operation is read, so a request for
    // another version cannot use any operation name to reach an executor.
    if (parsed.protocol !== protocol || parsed.schemaVersion !== schemaVersion) {
      return sendReply(response, echo, {
        httpStatus: 426,
        outcome: "unsupported_version",
        error: { code: "protocol_version_unsupported", message: "The requested protocol version is not supported.", retryable: false, supportedVersions: [protocol] },
      }, null);
    }
    if (!exactKeys(parsed, requestFields) || parsed.kind !== "request") {
      return sendReply(response, echo, refused(403, "invalid_request", "The request envelope is not the frozen shape."), null);
    }
    if (echo.requestId === unattributed || echo.operationId === unattributed || echo.operation === unattributed) {
      return sendReply(response, echo, refused(403, "invalid_request", "The request identity is missing or out of bounds."), null);
    }
    const operation = echo.operation;
    const binding = bindings[operation];
    if (binding === undefined) {
      return sendReply(response, echo, refused(403, "authorization_denied", "The operation is not in the v1 catalog."), null);
    }
    const credentialed = uncredentialed[operation] !== true;
    const body = recordOf(parsed.body);
    if (body === null) {
      return sendReply(response, echo, refused(403, "invalid_request", "The request body is required."), null);
    }
    // Pairing is the one operation an unpaired device may call, so it is also
    // the only one whose device and workspace identity is server derived. A
    // claim of either is refused rather than ignored, so a caller can never
    // learn whether the workspace it named exists.
    if (credentialed) {
      if (!boundedIdentity(parsed.deviceId) || !boundedIdentity(parsed.workspaceId)) {
        return sendReply(response, echo, refused(403, "authorization_denied", "The operation requires a device identity."), null);
      }
    } else if (parsed.deviceId !== undefined || parsed.workspaceId !== undefined) {
      return sendReply(response, echo, refused(403, "invalid_request", "Pairing carries no device or workspace claim."), null);
    }
    if (parsed.sessionId !== undefined && !boundedIdentity(parsed.sessionId)) {
      return sendReply(response, echo, refused(403, "invalid_request", "The session identity is out of bounds."), null);
    }
    if (parsed.idempotencyKey !== undefined && !boundedIdentity(parsed.idempotencyKey)) {
      return sendReply(response, echo, refused(403, "invalid_request", "The idempotency key is out of bounds."), null);
    }
    if (mutating[operation] === true && parsed.idempotencyKey === undefined) {
      return sendReply(response, echo, refused(403, "invalid_request", "The operation requires an idempotency key."), null);
    }
    const now = Date.now();
    if (!isUtcTimestamp(parsed.issuedAt) || !isUtcTimestamp(parsed.expiresAt) ||
        Date.parse(parsed.issuedAt) > now + maxSkewMs || Date.parse(parsed.expiresAt) <= now ||
        Date.parse(parsed.issuedAt) >= Date.parse(parsed.expiresAt)) {
      return sendReply(response, echo, refused(403, "request_expired", "The request window is not admissible."), null);
    }
    // Every answer past this point echoes the identity the request itself
    // claimed. It is the caller's own value, so it discloses nothing, and it is
    // what the frozen echo rule and the Apple client both require: a client
    // that reads a refusal still matches the envelope to what it sent. The
    // claim is never a grant, only an echo, and the outcome says whether it
    // was honoured.
    const claim: EchoedScope = { deviceId: parsed.deviceId as string, workspaceId: parsed.workspaceId as string };
    const digest = createHash("sha256").update(canonicalJson(body), "utf8").digest("hex");
    if (!/^[a-f0-9]{64}$/.test(String(parsed.bodyDigest)) || parsed.bodyDigest !== digest) {
      return sendReply(response, echo, refused(403, "invalid_request", "The body digest does not match the canonical body."), claim);
    }
    const shapeRefusal = bodyRefusal(operation, body);
    if (shapeRefusal !== null) return sendReply(response, echo, shapeRefusal, claim);
    if (operation === "operation.status" && body.operationId !== echo.operationId) {
      return sendReply(response, echo, refused(403, "invalid_request", "The body does not name the envelope operation."), claim);
    }
    if (operation === "device.revoke" && body.deviceId !== parsed.deviceId) {
      return sendReply(response, echo, refused(403, "invalid_request", "The body does not name the envelope device."), claim);
    }

    // The credential is proved before the claimed scope is compared, so an
    // wrong device, a wrong workspace, and no credential at all are the same
    // refusal to a caller that cannot prove either side.
    const header = request.headers.authorization;
    const token = typeof header === "string" && header.startsWith("Bearer ") ? header.slice("Bearer ".length) : null;
    const session = token === null ? null : authenticateDevice(env, token);
    if (credentialed) {
      if (session === null || !session.scopes.includes(binding.baselineScope)) {
        return sendReply(response, echo, refused(403, "authentication_required", "The device credential is not active."), claim);
      }
      if (session.deviceId !== parsed.deviceId || session.workspaceId !== parsed.workspaceId) {
        return sendReply(response, echo, refused(403, "authorization_denied", "The claimed device or workspace scope does not match the credential."), claim);
      }
      if (!session.scopes.includes(binding.requiredScope)) {
        return sendReply(response, echo, refused(403, "authorization_denied", "The device grant does not carry the required scope."), claim);
      }
      const reply = binding.run({ env, session, request: parsed, operationId: echo.operationId, deviceId: session.deviceId });
      return sendReply(response, echo, reply, claim);
    }
    // Pairing runs as the host that mints the device. The operator identity is
    // the same one the internal routes grant an unauthenticated caller that
    // already cleared the host gate; its placeholder device identity is never
    // minted into a receipt, because the receipt carries the new one.
    const operator: CompanionSession = { deviceId: unattributed, workspaceId: companionWorkspace(env), label: "host operator", scopes: [readScope, writeScope] };
    const reply = binding.run({ env, session: operator, request: parsed, operationId: echo.operationId, deviceId: unattributed });
    const minted = typeof reply.body?.deviceId === "string" ? reply.body.deviceId : null;
    return sendReply(response, echo, reply, minted === null ? null : { deviceId: minted, workspaceId: operator.workspaceId });
  } catch (error) {
    if (error instanceof CompanionStoreError && error.code === "device_limit") {
      return sendReply(response, echo, refused(409, "device_limit", "The workspace already holds the maximum number of active companion devices."), null);
    }
    // A store that cannot be read or written is answered with a stable
    // category. The outcome stays a refusal on a status the frozen outcome
    // table allows, because a read error is never a dispatchable outcome.
    return sendReply(response, echo, refused(403, "internal_error", "The companion state is not readable."), null);
  }
}

import { createHash } from "node:crypto";
import { canonicalJson } from "../../packages/ledger/src/canonical.ts";

const protocol = "void.companion.v1";
const outcomes = new Set([
  "succeeded", "denied", "conflict", "unknown", "running",
  "unsupported_version", "revoked", "invalid", "expired", "rate_limited",
]);
const rootFields = ["fixture", "protocol", "schemaVersion", "implementation", "sourceRoutes", "request", "response"];
const implementationFields = ["server", "apple", "transport", "authority"];
const requestFields = [
  "protocol", "schemaVersion", "kind", "requestId", "operationId", "operation",
  "deviceId", "workspaceId", "sessionId", "idempotencyKey", "issuedAt", "expiresAt", "bodyDigest", "body",
];
const operations = new Set([
  "capability.handshake", "session.list", "session.read", "session.create", "session.send", "session.cancel",
  "events.read", "events.stream", "approval.list", "approval.decide", "recovery.preview", "recovery.apply",
  "recovery.status", "operation.status", "device.revoke", "diagnostics.read",
]);
const mutations = new Set(["session.create", "session.send", "session.cancel", "approval.decide", "recovery.apply", "device.revoke"]);
const responseFields = [
  "protocol", "schemaVersion", "kind", "requestId", "operationId", "operation",
  "deviceId", "workspaceId", "httpStatus", "outcome", "body", "error",
];
const errorFields = ["code", "message", "retryable", "reconcileRequired", "refreshRequired", "retryAfterMs", "supportedVersions"];

function record(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function fields(value, allowed, label) {
  if (!record(value)) throw new Error(`${label} must be an object`);
  for (const key of Object.keys(value)) if (!allowed.includes(key)) throw new Error(`${label} has unknown field ${key}`);
}

function text(value, label, max = 160) {
  if (typeof value !== "string" || !value.isWellFormed() || value.length === 0 || value.length > max || /[\u0000-\u001f\u007f/]/.test(value))
    throw new Error(`${label} is invalid`);
  return value;
}

function routeText(value) {
  if (typeof value !== "string" || !value.isWellFormed() || value.length === 0 || value.length > 200 || /[\u0000-\u001f\u007f]/.test(value))
    throw new Error("source route is invalid");
  return value;
}

function timestamp(value, label) {
  if (typeof value !== "string" || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/.test(value) || !Number.isFinite(Date.parse(value)))
    throw new Error(`${label} is invalid`);
}

function digest(value, label) {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) throw new Error(`${label} digest is invalid`);
}

const capabilityIds = new Set([...operations, "approval.read"]);
const protocolLimitFields = [
  "maxRequestBytes", "maxPromptCharacters", "maxEventsPerPage", "maxEventPageBytes", "maxEventBytes",
  "maxStreamSeconds", "replayWindowSeconds", "idempotencyRetentionHours", "deviceCredentialSeconds",
  "invitationSeconds", "grantSeconds", "recoveryPlanSeconds", "maxMutationsPerDevice", "maxStreamsPerDevice",
  "maxDevicesPerWorkspace", "maxOperationIds", "maxErrorCharacters",
];
const protocolLimitBounds = {
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
const sessionOperations = new Set(["session.read", "session.send", "session.cancel", "events.read", "events.stream", "approval.decide", "recovery.preview", "recovery.apply", "recovery.status"]);
const recoveryOutcomeStatuses = {
  succeeded: ["restored", "partial"], conflict: ["conflict"], unknown: ["unknown"], running: ["paused"],
  denied: [], invalid: [], expired: [], rate_limited: [], revoked: [], unsupported_version: [],
};
const operationOutcomeStatuses = {
  succeeded: ["succeeded"], running: ["running"], denied: ["denied"], conflict: ["conflict"],
  unknown: ["unknown"], revoked: ["revoked"], expired: ["expired"], invalid: [], rate_limited: [], unsupported_version: [],
};

function requiredFields(value, required, label) {
  for (const key of required) if (value[key] === undefined) throw new Error(`${label} ${key} is required`);
}

function exactObject(value, allowed, required, label) {
  fields(value, allowed, label);
  requiredFields(value, required, label);
}

function boundedStringArray(value, label, maxItems = 32) {
  if (!Array.isArray(value) || value.length === 0 || value.length > maxItems) throw new Error(`${label} is invalid`);
  for (const item of value) text(item, `${label} item`, 120);
}

function integer(value, label, minimum = 0) {
  if (!Number.isSafeInteger(value) || value < minimum) throw new Error(`${label} is invalid`);
}

function validateMutationBody(request) {
  if (!record(request.body)) throw new Error(`${request.operation} body is invalid`);
}

function validOutcomeHttpStatus(outcome, status) {
  if (outcome === "succeeded") return [200, 201].includes(status);
  if (outcome === "running") return status === 202;
  if (outcome === "denied") return [200, 401, 403, 422].includes(status);
  if (outcome === "conflict") return status === 409;
  if (outcome === "unknown") return status === 202;
  if (outcome === "unsupported_version") return status === 426;
  if (outcome === "revoked") return [401, 403].includes(status);
  if (outcome === "invalid") return [400, 422].includes(status);
  if (outcome === "expired") return status === 410;
  if (outcome === "rate_limited") return status === 429;
  return false;
}

function validateHandshakeRequest(request) {
  exactObject(request.body, ["client", "requestedCapabilities"], ["client", "requestedCapabilities"], "capability.handshake body");
  exactObject(request.body.client, ["name", "version", "platform"], ["name", "version", "platform"], "capability.handshake client");
  for (const key of ["name", "version", "platform"]) text(request.body.client[key], `capability.handshake client ${key}`, 120);
  boundedStringArray(request.body.requestedCapabilities, "capability.handshake requestedCapabilities", 16);
  const seen = new Set();
  for (const capability of request.body.requestedCapabilities) {
    if (!capabilityIds.has(capability) || seen.has(capability)) throw new Error("capability.handshake requestedCapabilities is invalid");
    seen.add(capability);
  }
}

function validateHandshakeResponse(request, response) {
  if ((request.protocol !== protocol || request.schemaVersion !== 1) && response.outcome !== "unsupported_version") throw new Error("capability.handshake version is invalid");
  if (response.outcome === "succeeded" && (request.protocol !== protocol || request.schemaVersion !== 1)) throw new Error("capability.handshake version is invalid");
  if (response.outcome !== "succeeded") {
    if (response.body !== undefined || response.deviceId !== undefined || response.workspaceId !== undefined)
      throw new Error("capability.handshake refusal must not disclose state");
    return;
  }
  exactObject(response.body, ["serverTime", "protocolVersions", "executor", "workspace", "device", "capabilities", "limits", "pendingBehaviors", "expiresAt"], ["serverTime", "protocolVersions", "executor", "workspace", "device", "capabilities", "limits", "pendingBehaviors", "expiresAt"], "capability.handshake body");
  timestamp(response.body.serverTime, "capability.handshake serverTime");
  if (!Array.isArray(response.body.protocolVersions) || response.body.protocolVersions.length !== 1 || response.body.protocolVersions[0] !== protocol)
    throw new Error("capability.handshake protocolVersions is invalid");
  exactObject(response.body.executor, ["executorId", "displayName", "platform", "build", "identityKeyId"], ["executorId", "displayName", "platform", "build", "identityKeyId"], "capability.handshake executor");
  for (const key of ["executorId", "displayName", "platform", "build", "identityKeyId"]) text(response.body.executor[key], `capability.handshake executor ${key}`, 160);
  exactObject(response.body.workspace, ["workspaceId", "label"], ["workspaceId"], "capability.handshake workspace");
  text(response.body.workspace.workspaceId, "capability.handshake workspaceId");
  if (response.body.workspace.label !== undefined) text(response.body.workspace.label, "capability.handshake workspace label", 160);
  exactObject(response.body.device, ["deviceId", "state"], ["deviceId", "state"], "capability.handshake device");
  text(response.body.device.deviceId, "capability.handshake deviceId");
  if (!["paired", "pending", "revoked"].includes(response.body.device.state)) throw new Error("capability.handshake device state is invalid");
  if (!Array.isArray(response.body.capabilities) || response.body.capabilities.length > 32) throw new Error("capability.handshake capabilities is invalid");
  for (const capability of response.body.capabilities) {
    exactObject(capability, ["id", "version", "status", "requiredScope", "limitation"], ["id", "version", "status"], "capability.handshake capability");
    text(capability.id, "capability.handshake capability id", 120);
    if (!capabilityIds.has(capability.id) || text(capability.version, "capability.handshake capability version", 80) === "" || !["pending", "unsupported"].includes(capability.status))
      throw new Error("capability.handshake capability is invalid");
    for (const key of ["requiredScope", "limitation"]) if (capability[key] !== undefined) text(capability[key], `capability.handshake capability ${key}`, 320);
  }
  const limits = response.body.limits;
  exactObject(limits, protocolLimitFields, protocolLimitFields, "capability.handshake limits");
  for (const [key, maximum] of Object.entries(protocolLimitBounds)) {
    integer(limits[key], "capability.handshake limit", 1);
    if (limits[key] > maximum) throw new Error(`capability.handshake limit ${key} exceeds maximum`);
  }
  boundedStringArray(response.body.pendingBehaviors, "capability.handshake pendingBehaviors", 32);
  timestamp(response.body.expiresAt, "capability.handshake expiresAt");
  if (response.deviceId !== request.deviceId || response.workspaceId !== request.workspaceId || response.body.device.deviceId !== request.deviceId || response.body.workspace.workspaceId !== request.workspaceId)
    throw new Error("capability.handshake identity does not match request");
}

function validateApprovalRequest(request) {
  exactObject(request.body, ["operationId", "idempotencyKey", "approvalId", "requestDigest", "decision", "grantId", "grantVersion"], ["operationId", "idempotencyKey", "approvalId", "requestDigest", "decision", "grantId", "grantVersion"], "approval.decide body");
  for (const key of ["operationId", "idempotencyKey", "approvalId", "grantId"]) text(request.body[key], `approval.decide ${key}`);
  if (request.body.operationId !== request.operationId || request.body.idempotencyKey !== request.idempotencyKey) throw new Error("approval.decide operation identity does not match request");
  digest(request.body.requestDigest, "approval.decide requestDigest");
  if (!["approved", "denied"].includes(request.body.decision)) throw new Error("approval.decide decision is invalid");
  integer(request.body.grantVersion, "approval.decide grantVersion", 1);
}

function validateApprovalResponse(request, response) {
  if (response.outcome !== "succeeded" && response.outcome !== "denied") {
    if (response.body !== undefined) throw new Error("approval.decide refusal body is invalid");
    return;
  }
  exactObject(response.body, ["approvalId", "status", "effectApplied"], ["approvalId", "status", "effectApplied"], "approval.decide body");
  text(response.body.approvalId, "approval.decide approvalId");
  if (response.body.approvalId !== request.body.approvalId || response.body.effectApplied !== false || !["approved", "denied"].includes(response.body.status) || (response.outcome === "denied" && (response.body.status !== "denied" || request.body.decision !== "denied")) || (response.outcome === "succeeded" && (response.body.status !== "approved" || request.body.decision !== "approved")))
    throw new Error("approval.decide receipt is invalid");
}

function validateRecoveryApplyRequest(request) {
  exactObject(request.body, ["operationId", "idempotencyKey", "jobId", "planDigest", "approved", "grantId", "grantVersion"], ["operationId", "idempotencyKey", "jobId", "planDigest", "approved", "grantId", "grantVersion"], "recovery.apply body");
  for (const key of ["operationId", "idempotencyKey", "jobId", "grantId"]) text(request.body[key], `recovery.apply ${key}`);
  if (request.body.operationId !== request.operationId || request.body.idempotencyKey !== request.idempotencyKey || request.body.approved !== true)
    throw new Error("recovery.apply operation identity or approval is invalid");
  digest(request.body.planDigest, "recovery.apply planDigest");
  integer(request.body.grantVersion, "recovery.apply grantVersion", 1);
}

function validateRecoveryApplyResponse(request, response) {
  if (response.body === undefined && ["denied", "invalid", "expired", "rate_limited", "revoked", "unsupported_version"].includes(response.outcome)) return;
  exactObject(response.body, ["jobId", "status", "checkpoint", "outcomes", "residuals", "pause"], ["jobId", "status", "checkpoint", "outcomes", "residuals"], "recovery.apply body");
  text(response.body.jobId, "recovery.apply response jobId");
  if (response.body.jobId !== request.body.jobId) throw new Error("recovery.apply job identity does not match request");
  if (!["restored", "partial", "conflict", "unknown", "paused"].includes(response.body.status)) throw new Error("recovery.apply response status is invalid");
  const allowedRecoveryStatuses = recoveryOutcomeStatuses[response.outcome] ?? [];
  if (!allowedRecoveryStatuses.includes(response.body.status)) throw new Error(`recovery.${request.operation === "recovery.status" ? "status" : "apply"} outcome status is invalid`);
  integer(response.body.checkpoint, "recovery.apply checkpoint");
  if (!Array.isArray(response.body.outcomes) || !Array.isArray(response.body.residuals)) throw new Error("recovery.apply response collection is invalid");
  for (const outcome of response.body.outcomes) {
    exactObject(outcome, ["operationId", "status"], ["operationId", "status"], "recovery.apply outcome");
    text(outcome.operationId, "recovery.apply outcome operationId");
    if (!["restored", "compensated"].includes(outcome.status)) throw new Error("recovery.apply outcome status is invalid");
  }
  for (const residual of response.body.residuals) {
    exactObject(residual, ["operationId", "status"], ["operationId", "status"], "recovery.apply residual");
    text(residual.operationId, "recovery.apply residual operationId");
    text(residual.status, "recovery.apply residual status", 120);
  }
  if (response.body.pause !== undefined) {
    exactObject(response.body.pause, ["code", "operationId"], ["code", "operationId"], "recovery.apply pause");
    text(response.body.pause.code, "recovery.apply pause code", 80);
    text(response.body.pause.operationId, "recovery.apply pause operationId");
  }
  if (response.outcome === "succeeded" && !["restored", "partial"].includes(response.body.status)) throw new Error("recovery.apply succeeded receipt is invalid");
}
function boundedString(value, label, max = 160) {
  if (typeof value !== "string" || !value.isWellFormed() || value.length === 0 || value.length > max || value.includes("\u0000")) throw new Error(`${label} is invalid`);
}

function validateReadRequest(request, allowed = []) {
  exactObject(request.body, allowed, [], `${request.operation} body`);
}

function validateSessionRequest(request) {
  if (request.operation === "session.list" || request.operation === "session.read" || request.operation === "session.cancel" || request.operation === "events.stream" || request.operation === "approval.list" || request.operation === "diagnostics.read") return validateReadRequest(request);
  if (request.operation === "session.create") {
    exactObject(request.body, ["prompt", "model", "project", "agent", "background"], ["prompt"], "session.create body");
    boundedString(request.body.prompt, "session.create prompt", 32000);
    for (const key of ["model", "project", "agent"]) if (request.body[key] !== undefined) boundedString(request.body[key], `session.create ${key}`);
    if (request.body.background !== undefined && typeof request.body.background !== "boolean") throw new Error("session.create background is invalid");
    return;
  }
  if (request.operation === "session.send") {
    exactObject(request.body, ["prompt"], ["prompt"], "session.send body");
    boundedString(request.body.prompt, "session.send prompt", 32000);
    return;
  }
  if (request.operation === "events.read") {
    exactObject(request.body, ["after", "limit"], [], "events.read body");
    if (request.body.after !== undefined && (typeof request.body.after !== "string" || !/^(0|[1-9]\d*)$/.test(request.body.after) || !Number.isSafeInteger(Number(request.body.after)))) throw new Error("events.read cursor is invalid");
    if (request.body.limit !== undefined) integer(request.body.limit, "events.read limit", 1);
    if (request.body.limit !== undefined && request.body.limit > 1000) throw new Error("events.read limit is invalid");
  }
}

function validateSessionResponse(request, response) {
  if (response.outcome !== "succeeded" && response.outcome !== "running") {
    if (response.body !== undefined && response.outcome !== "revoked") throw new Error(`${request.operation} refusal body is invalid`);
    return;
  }
  if (request.operation === "session.list") {
    exactObject(response.body, ["sessions"], ["sessions"], "session.list body");
    if (!Array.isArray(response.body.sessions) || response.body.sessions.length > 1000) throw new Error("session.list body is invalid");
    for (const session of response.body.sessions) {
      exactObject(session, ["id", "sessionId", "workspaceId", "status", "title", "createdAt", "updatedAt", "lastRecoveryJob"], ["workspaceId"], "session.list session");
      if (session.id === undefined && session.sessionId === undefined) throw new Error("session.list session identity is required");
      if (session.sessionId !== undefined && session.id !== undefined && session.sessionId !== session.id) throw new Error("session.list identity is invalid");
      if (session.workspaceId !== request.workspaceId) throw new Error("session.list workspace scope is invalid");
      for (const key of ["id", "sessionId", "workspaceId", "status", "title"]) if (session[key] !== undefined) boundedString(session[key], `session.list ${key}`);
      for (const key of ["createdAt", "updatedAt"]) if (session[key] !== undefined) timestamp(session[key], `session.list ${key}`);
      if (session.lastRecoveryJob !== undefined) {
        exactObject(session.lastRecoveryJob, ["jobId"], ["jobId"], "session.list lastRecoveryJob");
        text(session.lastRecoveryJob.jobId, "session.list lastRecoveryJob jobId");
      }
    }
    return;
  }
  if (request.operation === "session.read" || request.operation === "session.create") {
    exactObject(response.body, ["session"], ["session"], `${request.operation} body`);
    exactObject(response.body.session, ["id", "sessionId", "workspaceId", "status", "title", "createdAt", "updatedAt", "lastRecoveryJob"], ["workspaceId"], `${request.operation} session`);
    const sessionId = response.body.session.id ?? response.body.session.sessionId;
    if (sessionId === undefined || (response.body.session.id !== undefined && response.body.session.sessionId !== undefined && response.body.session.id !== response.body.session.sessionId)) throw new Error(`${request.operation} identity is invalid`);
    for (const key of ["id", "sessionId", "workspaceId", "status", "title"]) if (response.body.session[key] !== undefined) boundedString(response.body.session[key], `${request.operation} ${key}`);
    for (const key of ["createdAt", "updatedAt"]) if (response.body.session[key] !== undefined) timestamp(response.body.session[key], `${request.operation} ${key}`);
    if (response.body.session.workspaceId !== request.workspaceId || (request.sessionId !== undefined && sessionId !== request.sessionId)) throw new Error(`${request.operation} scope identity is invalid`);
    return;
  }
  if (request.operation === "session.send" || request.operation === "session.cancel") {
    exactObject(response.body, ["ok"], ["ok"], `${request.operation} body`);
    if (typeof response.body.ok !== "boolean") throw new Error(`${request.operation} body is invalid`);
    return;
  }
  if (request.operation === "events.stream") {
    exactObject(response.body, ["closed"], ["closed"], "events.stream body");
    if (typeof response.body.closed !== "boolean") throw new Error("events.stream body is invalid");
    return;
  }
  if (request.operation === "events.read") {
    exactObject(response.body, ["items", "after", "nextAfter", "hasMore", "historyComplete", "scope", "asOf", "replayExpiresAt"], ["items", "after", "nextAfter", "hasMore", "historyComplete", "scope", "asOf", "replayExpiresAt"], "events.read body");
    if (!Array.isArray(response.body.items) || response.body.items.length > protocolLimitBounds.maxEventsPerPage) throw new Error("events.read items are invalid");
    if (Buffer.byteLength(canonicalJson(response.body), "utf8") > protocolLimitBounds.maxEventPageBytes) throw new Error("events.read page exceeds maxEventPageBytes");
    let previous = -1;
    for (const event of response.body.items) {
      exactObject(event, ["id", "sessionId", "runId", "seq", "at", "type", "kind", "schemaVersion", "summary", "metadata"], ["id", "sessionId", "seq", "at", "type", "kind", "schemaVersion"], "events.read event");
      timestamp(event.at, "events.read event at");
      if (event.runId !== undefined) text(event.runId, "events.read event runId");
      text(event.id, "events.read event id");
      if (event.sessionId !== request.sessionId) throw new Error("events.read event scope is invalid");
      integer(event.seq, "events.read event seq");
      if (event.seq <= previous) throw new Error("events.read event sequence is invalid");
      previous = event.seq;
      for (const key of ["type", "kind"]) boundedString(event[key], `events.read event ${key}`, 120);
      integer(event.schemaVersion, "events.read event schemaVersion", 1);
      if (event.summary !== undefined) boundedString(event.summary, "events.read event summary", 320);
      if (event.metadata !== undefined && !record(event.metadata)) throw new Error("events.read event metadata is invalid");
      if (event.metadata !== undefined) {
        fields(event.metadata, ["status", "decision", "class", "operationId", "checkpoint", "resultCategory"], "events.read event metadata");
        for (const key of ["status", "decision", "class", "operationId", "resultCategory"]) if (event.metadata[key] !== undefined) boundedString(event.metadata[key], `events.read event metadata ${key}`);
        if (event.metadata.checkpoint !== undefined) integer(event.metadata.checkpoint, "events.read event metadata checkpoint");
      }
    }
    if (typeof response.body.after !== "string" || (response.body.after !== "0" && !/^(0|[1-9]\d*)$/.test(response.body.after))) throw new Error("events.read after is invalid");
    if (response.body.nextAfter !== null && (typeof response.body.nextAfter !== "string" || !/^(0|[1-9]\d*)$/.test(response.body.nextAfter))) throw new Error("events.read nextAfter is invalid");
    if (typeof response.body.hasMore !== "boolean" || typeof response.body.historyComplete !== "boolean") throw new Error("events.read flags are invalid");
    exactObject(response.body.scope, ["workspaceId", "sessionId"], ["workspaceId", "sessionId"], "events.read scope");
    if (response.body.scope.workspaceId !== request.workspaceId || response.body.scope.sessionId !== request.sessionId) throw new Error("events.read scope is invalid");
    timestamp(response.body.asOf, "events.read asOf");
    timestamp(response.body.replayExpiresAt, "events.read replayExpiresAt");
    return;
  }
}

function validateApprovalListResponse(request, response) {
  if (response.outcome !== "succeeded") {
    if (response.body !== undefined) throw new Error("approval.list refusal body is invalid");
    return;
  }
  exactObject(response.body, ["approvals"], ["approvals"], "approval.list body");
  if (!Array.isArray(response.body.approvals) || response.body.approvals.length > 1000) throw new Error("approval.list approvals are invalid");
  for (const approval of response.body.approvals) {
    exactObject(approval, ["approvalId", "sessionId", "operationId", "workspaceId", "tool", "class", "status", "expiresAt", "requestDigest", "requiredScope", "blastRadius", "reasonCode"], ["approvalId", "sessionId", "operationId", "workspaceId", "tool", "class", "status", "expiresAt", "requestDigest", "requiredScope"], "approval.list approval");
    for (const key of ["approvalId", "sessionId", "operationId", "workspaceId", "tool", "class", "status", "requiredScope", "reasonCode"]) if (approval[key] !== undefined) boundedString(approval[key], `approval.list ${key}`);
    if (!["pending", "approved", "denied", "expired"].includes(approval.status) || approval.workspaceId !== request.workspaceId) throw new Error("approval.list approval is invalid");
    timestamp(approval.expiresAt, "approval.list expiresAt");
    digest(approval.requestDigest, "approval.list requestDigest");
    if (approval.blastRadius !== undefined) integer(approval.blastRadius, "approval.list blastRadius");
  }
}
function validateRecoverySelection(selection, label) {
  exactObject(selection, ["kind", "runId", "operationIds"], ["kind"], label);
  if (selection.kind === "run") { exactObject(selection, ["kind", "runId"], ["runId"], label); text(selection.runId, `${label} runId`); return; }
  if (selection.kind !== "operations") throw new Error(`${label} kind is invalid`);
  exactObject(selection, ["kind", "operationIds"], ["operationIds"], label);
  if (!Array.isArray(selection.operationIds) || selection.operationIds.length < 1 || selection.operationIds.length > 500) throw new Error(`${label} operationIds is invalid`);
  const seen = new Set();
  for (const operationId of selection.operationIds) { text(operationId, `${label} operationId`); if (seen.has(operationId)) throw new Error(`${label} operationIds is invalid`); seen.add(operationId); }
}

function validateRecoveryPreviewRequest(request) {
  exactObject(request.body, ["operationId", "idempotencyKey", "jobId", "selection"], ["operationId", "idempotencyKey", "jobId", "selection"], "recovery.preview body");
  for (const key of ["operationId", "idempotencyKey", "jobId"]) text(request.body[key], `recovery.preview ${key}`);
  if (request.body.operationId !== request.operationId) throw new Error("recovery.preview operation identity is invalid");
  exactObject(request.body.selection, ["kind", "runId", "operationIds"], ["kind"], "recovery.preview selection");
  if (request.body.selection.kind === "run") {
    exactObject(request.body.selection, ["kind", "runId"], ["runId"], "recovery.preview run selection");
    text(request.body.selection.runId, "recovery.preview runId");
  } else if (request.body.selection.kind === "operations") {
    exactObject(request.body.selection, ["kind", "operationIds"], ["operationIds"], "recovery.preview operations selection");
    if (!Array.isArray(request.body.selection.operationIds) || request.body.selection.operationIds.length < 1 || request.body.selection.operationIds.length > 500) throw new Error("recovery.preview operationIds is invalid");
    const seen = new Set();
    for (const operationId of request.body.selection.operationIds) { text(operationId, "recovery.preview operationId"); if (seen.has(operationId)) throw new Error("recovery.preview operationIds is invalid"); seen.add(operationId); }
  } else throw new Error("recovery.preview selection kind is invalid");
}

function validateRecoveryStatusRequest(request) {
  exactObject(request.body, ["jobId"], ["jobId"], "recovery.status body");
  text(request.body.jobId, "recovery.status jobId");
}

function validateRecoveryPreviewResponse(request, response) {
  if (response.outcome !== "succeeded") { if (response.body !== undefined) throw new Error("recovery.preview refusal body is invalid"); return; }
  exactObject(response.body, ["jobId", "planDigest", "selection", "boundary", "steps", "residuals", "expiresAt", "canApply"], ["jobId", "planDigest", "selection", "boundary", "steps", "residuals", "expiresAt", "canApply"], "recovery.preview body");
  validateRecoverySelection(response.body.selection, "recovery.preview selection");
  text(response.body.jobId, "recovery.preview response jobId");
  if (response.body.jobId !== request.body.jobId) throw new Error("recovery.preview job identity is invalid");
  digest(response.body.planDigest, "recovery.preview planDigest");
  exactObject(response.body.boundary, ["sequence", "digest"], ["sequence", "digest"], "recovery.preview boundary");
  integer(response.body.boundary.sequence, "recovery.preview boundary sequence"); digest(response.body.boundary.digest, "recovery.preview boundary digest");
  if (!Array.isArray(response.body.steps) || response.body.steps.length > 500) throw new Error("recovery.preview steps are invalid");
  for (const step of response.body.steps) { exactObject(step, ["operationId", "sequence", "resources", "scope"], ["operationId", "sequence", "resources", "scope"], "recovery.preview step"); text(step.operationId, "recovery.preview step operationId"); integer(step.sequence, "recovery.preview step sequence"); if (!Array.isArray(step.resources) || step.resources.length > 100) throw new Error("recovery.preview resources are invalid"); for (const resource of step.resources) boundedString(resource, "recovery.preview resource"); boundedString(step.scope, "recovery.preview step scope"); }
  if (!Array.isArray(response.body.residuals)) throw new Error("recovery.preview residuals are invalid");
  for (const residual of response.body.residuals) { exactObject(residual, ["operationId", "status"], ["operationId", "status"], "recovery.preview residual"); text(residual.operationId, "recovery.preview residual operationId"); boundedString(residual.status, "recovery.preview residual status"); }
  timestamp(response.body.expiresAt, "recovery.preview expiresAt"); if (typeof response.body.canApply !== "boolean") throw new Error("recovery.preview canApply is invalid");
}

function validateOperationStatusRequest(request) {
  exactObject(request.body, ["operationId"], ["operationId"], "operation.status body");
  text(request.body.operationId, "operation.status operationId");
  if (request.body.operationId !== request.operationId) throw new Error("operation.status operation identity is invalid");
}

function validateDeviceRevokeRequest(request) {
  exactObject(request.body, ["deviceId"], ["deviceId"], "device.revoke body");
  text(request.body.deviceId, "device.revoke deviceId");
  if (request.body.deviceId !== request.deviceId) throw new Error("device.revoke device identity is invalid");
}

function validateStatusResponse(request, response, label, allowedStatuses) {
  if (response.body === undefined) throw new Error(`${label} body is required`);
  const allowedOutcomeStatuses = operationOutcomeStatuses[response.outcome] ?? [];
  exactObject(response.body, ["operationId", "status"], ["operationId", "status"], `${label} body`);
  text(response.body.operationId, `${label} operationId`);
  if (response.body.operationId !== request.operationId || !allowedStatuses.includes(response.body.status) || !allowedOutcomeStatuses.includes(response.body.status)) throw new Error(`${label} outcome status is invalid`);
}

function validateDeviceRevokeResponse(request, response) {
  if (response.outcome !== "succeeded") { if (response.body !== undefined) throw new Error("device.revoke refusal body is invalid"); return; }
  exactObject(response.body, ["deviceId", "revokedAt", "newMutationsAllowed", "activeStreamsClosed"], ["deviceId", "revokedAt", "newMutationsAllowed", "activeStreamsClosed"], "device.revoke body");
  if (response.body.deviceId !== request.deviceId || response.body.newMutationsAllowed !== false || response.body.activeStreamsClosed !== true) throw new Error("device.revoke body is invalid");
  timestamp(response.body.revokedAt, "device.revoke revokedAt");
}

function validateDiagnosticsResponse(request, response) {
  if (response.outcome !== "succeeded") { if (response.body !== undefined) throw new Error("diagnostics.read refusal body is invalid"); return; }
  exactObject(response.body, ["entries"], ["entries"], "diagnostics.read body");
  if (!Array.isArray(response.body.entries) || response.body.entries.length > 100) throw new Error("diagnostics.read entries are invalid");
  for (const entry of response.body.entries) { exactObject(entry, ["id", "status", "summary"], ["id", "status"], "diagnostics.read entry"); text(entry.id, "diagnostics.read entry id"); if (!["ok", "pending", "failed"].includes(entry.status)) throw new Error("diagnostics.read entry status is invalid"); if (entry.summary !== undefined) boundedString(entry.summary, "diagnostics.read entry summary", 320); }
}

function validateOperationRequest(request) {
  if (sessionOperations.has(request.operation) && request.sessionId === undefined) throw new Error(`${request.operation} sessionId is required`);
  if (request.operation === "capability.handshake") return validateHandshakeRequest(request);
  if (["session.list", "session.read", "session.create", "session.send", "session.cancel", "events.read", "events.stream", "approval.list", "diagnostics.read"].includes(request.operation)) return validateSessionRequest(request);
  if (mutations.has(request.operation)) validateMutationBody(request);
  if (request.operation === "approval.decide") return validateApprovalRequest(request);
  if (request.operation === "recovery.preview") return validateRecoveryPreviewRequest(request);
  if (request.operation === "recovery.apply") return validateRecoveryApplyRequest(request);
  if (request.operation === "recovery.status") return validateRecoveryStatusRequest(request);
  if (request.operation === "operation.status") return validateOperationStatusRequest(request);
  if (request.operation === "device.revoke") return validateDeviceRevokeRequest(request);
}

function validateOperationResponse(request, response) {
  if (request.operation === "capability.handshake") return validateHandshakeResponse(request, response);
  if (["session.list", "session.read", "session.create", "session.send", "session.cancel", "events.read", "events.stream"].includes(request.operation)) return validateSessionResponse(request, response);
  if (request.operation === "approval.list") return validateApprovalListResponse(request, response);
  if (request.operation === "approval.decide") return validateApprovalResponse(request, response);
  if (request.operation === "recovery.preview") return validateRecoveryPreviewResponse(request, response);
  if (request.operation === "recovery.apply" || request.operation === "recovery.status") return validateRecoveryApplyResponse(request, response);
  if (request.operation === "operation.status") return validateStatusResponse(request, response, "operation.status", ["running", "succeeded", "denied", "conflict", "unknown", "revoked", "expired"]);
  if (request.operation === "device.revoke") return validateDeviceRevokeResponse(request, response);
  if (request.operation === "diagnostics.read") return validateDiagnosticsResponse(request, response);
}
export function validateCompanionFixture(value) {
  fields(value, rootFields, "fixture");
  if (value.protocol !== protocol || value.schemaVersion !== 1) throw new Error("fixture protocol is unsupported");
  if (typeof value.fixture !== "string" || !value.fixture.startsWith(`${protocol}.`)) throw new Error("fixture identity is invalid");
  fields(value.implementation, implementationFields, "implementation");
  if (value.implementation.server !== "pending" || value.implementation.apple !== "pending" ||
      value.implementation.transport !== "pending" || value.implementation.authority !== "not-granted")
    throw new Error("fixture implementation must remain pending and unauthorized");
  if (!Array.isArray(value.sourceRoutes) || value.sourceRoutes.length === 0 || value.sourceRoutes.some((route) => !routeText(route)))
    throw new Error("fixture source routes are invalid");

  fields(value.request, requestFields, "request");
  if (!operations.has(value.request.operation)) throw new Error("request operation is not allowlisted");
  if (mutations.has(value.request.operation)) text(value.request.idempotencyKey, "mutation idempotencyKey");
  if (value.request.kind !== "request") throw new Error("request envelope is invalid");
  if (!Number.isInteger(value.request.schemaVersion) || value.request.schemaVersion < 1) throw new Error("request schemaVersion is invalid");
  const requestProtocol = value.request.protocol;
  if (value.request.operation !== "capability.handshake" && (requestProtocol !== protocol || value.request.schemaVersion !== 1))
    throw new Error("request protocol is invalid");
  if (value.request.operation === "capability.handshake" && (typeof requestProtocol !== "string" || !requestProtocol))
    throw new Error("request protocol is invalid");
  for (const key of ["requestId", "operationId", "operation", "deviceId", "workspaceId"]) text(value.request[key], `request ${key}`);
  for (const key of ["sessionId", "idempotencyKey"]) if (value.request[key] !== undefined) text(value.request[key], `request ${key}`);
  timestamp(value.request.issuedAt, "request issuedAt");
  timestamp(value.request.expiresAt, "request expiresAt");
  digest(value.request.bodyDigest, "request");
  if (value.request.body === undefined) throw new Error("request body is required");
  const bodyBytes = Buffer.byteLength(canonicalJson(value.request.body), "utf8");
  if (bodyBytes > protocolLimitBounds.maxRequestBytes) throw new Error("request body exceeds maxRequestBytes");
  const bodyDigest = createHash("sha256").update(canonicalJson(value.request.body)).digest("hex");
  if (bodyDigest !== value.request.bodyDigest) throw new Error("request body digest does not match");
  validateOperationRequest(value.request);

  fields(value.response, responseFields, "response");
  if (value.response.protocol !== protocol || value.response.schemaVersion !== 1 || value.response.kind !== "response")
    throw new Error("response envelope is invalid");
  for (const key of ["requestId", "operationId", "operation"]) text(value.response[key], `response ${key}`);
  for (const key of ["deviceId", "workspaceId"]) if (value.response[key] !== undefined) text(value.response[key], `response ${key}`);
  if (value.response.requestId !== value.request.requestId || value.response.operationId !== value.request.operationId || value.response.operation !== value.request.operation)
    throw new Error("response identity does not match request");
  for (const key of ["deviceId", "workspaceId"])
    if (value.response[key] !== undefined && value.response[key] !== value.request[key])
      throw new Error("response scope identity does not match request");
  if (!Number.isInteger(value.response.httpStatus) || value.response.httpStatus < 100 || value.response.httpStatus > 599) throw new Error("response status is invalid");
  if (!outcomes.has(value.response.outcome)) throw new Error("response outcome is invalid");
  if (!validOutcomeHttpStatus(value.response.outcome, value.response.httpStatus)) throw new Error("response http status does not match outcome");
  if (value.response.body !== undefined && !record(value.response.body) && !Array.isArray(value.response.body) && typeof value.response.body !== "string" && typeof value.response.body !== "number" && typeof value.response.body !== "boolean" && value.response.body !== null)
    throw new Error("response body is invalid");
  if (value.response.error !== undefined) {
    fields(value.response.error, errorFields, "response error");
    text(value.response.error.code, "error code", 120);
    text(value.response.error.message, "error message", protocolLimitBounds.maxErrorCharacters);
    if (typeof value.response.error.retryable !== "boolean") throw new Error("error retryable is required");
    for (const key of ["reconcileRequired", "refreshRequired"]) if (value.response.error[key] !== undefined && typeof value.response.error[key] !== "boolean") throw new Error(`${key} is invalid`);
    if (value.response.error.retryAfterMs !== undefined && (!Number.isInteger(value.response.error.retryAfterMs) || value.response.error.retryAfterMs < 0 || value.response.error.retryAfterMs > 60000)) throw new Error("retryAfterMs is invalid");
    if (value.response.error.supportedVersions !== undefined && (!Array.isArray(value.response.error.supportedVersions) || value.response.error.supportedVersions.length > 8 || value.response.error.supportedVersions.some((version) => text(version, "supported version", 80) === ""))) throw new Error("supportedVersions is invalid");
  }
  validateOperationResponse(value.request, value.response);
  const outcome = value.response.outcome;
  if (["denied", "conflict", "unknown", "unsupported_version", "revoked"].includes(outcome) && value.response.error?.retryable === true)
    throw new Error(`${outcome} must not be retryable`);
  if (outcome === "unknown" && (value.response.httpStatus !== 202 || value.response.error?.reconcileRequired !== true)) throw new Error("unknown outcome must require reconciliation");
  if (outcome === "unsupported_version" && (value.response.httpStatus !== 426 || value.response.error?.code !== "protocol_version_unsupported")) throw new Error("unsupported version response is invalid");
  if (outcome === "revoked" && ![401, 403].includes(value.response.httpStatus)) throw new Error("revoked response status is invalid");
  if (outcome === "revoked" && value.response.body &&
      (value.response.body.newMutationsAllowed !== false || value.response.body.activeStreamsClosed !== true))
    throw new Error("revoked response must fail closed");
  return value;
}

export function decodeCompanionFixture(text) {
  let value;
  try { value = JSON.parse(text); } catch { throw new Error("fixture is not valid JSON"); }
  return validateCompanionFixture(value);
}

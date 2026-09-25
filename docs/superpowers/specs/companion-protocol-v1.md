# VOID companion protocol v1

Status: P04 design contract, 2026-09-24. This document freezes a proposed wire contract for later TypeScript and Swift contract tests. It does not implement a listener, pairing flow, device credential, remote authority, or Apple client. Every companion behavior in this document is `pending` until a separately reviewed implementation supplies it and passes the evidence gates below.

## 1. Scope and non-goals

The protocol is a narrow, authenticated client-to-executor contract for a future Apple companion. The first intended executor is one explicitly paired, user-owned Mac. A separately verified server profile may use the same contract later, but it is not assumed ready.

The contract covers:

- version and capability negotiation;
- executor, device, workspace, session, and operation identity;
- bounded session and event reads;
- chat/session requests mapped to existing control-plane services;
- approval reads and decisions;
- recovery preview, apply, and status;
- device revocation and operation reconciliation;
- stable, sanitized error and outcome semantics.

It does not grant a phone arbitrary shell, process, provider, filesystem, or workspace access. It does not make the existing desktop operator token a device credential. It does not promise background execution, push-triggered execution, public relay access, cross-system atomic rollback, or exactly-once effects. A preview is never an approval, and an approval is never proof that an effect completed.

The TypeScript recovery engine, signed journal, policy path, and existing control-plane routes remain authoritative. This document is an adapter contract, not a second policy or recovery implementation.

## 2. Existing route inventory

The names below were inspected in the current tree. They are the preferred binding names for a future adapter. Source inspection is not companion availability.

| Logical operation | Existing route name | Source status | Companion status |
| --- | --- | --- | --- |
| `session.list` | `GET /api/sessions` | source-inspected | pending envelope, auth, and scope adapter |
| `session.read` | `GET /api/sessions/:id` | source-inspected | pending envelope and safe projection |
| `session.create` | `POST /api/sessions` | source-inspected | pending device grant and idempotency adapter |
| `session.send` | `POST /api/sessions/:id` | source-inspected | pending device grant and event projection |
| `session.cancel` | `DELETE /api/sessions/:id` | source-inspected | pending device grant; cancellation is not effect proof |
| `events.read` | `GET /api/sessions/:id/events?after=` | source-inspected | pending bounded cursor and sanitized projection |
| `events.stream` | `GET /api/sessions/:id/stream` | source-inspected | pending bounded SSE lifetime and revocation close |
| `approval.list` | `GET /api/approvals` | source-inspected | pending scoped, sanitized adapter |
| `approval.decide` | `POST /api/approvals/:id/decision` | source-inspected | pending device-bound grant and exact request binding |
| `recovery.preview` | `POST /api/sessions/:id/recovery-jobs/plan` | source-inspected | pending companion-safe projection and expiry |
| `recovery.apply` | `POST /api/sessions/:id/recovery-jobs/apply` | source-inspected | pending single-use grant, digest binding, and operation receipt |
| `recovery.status` | `GET /api/sessions/:id/recovery-jobs/:job` | source-inspected | pending safe status adapter |
| `operation.status` | `GET /api/companion/operations/:operationId` | source-inspected, fixture-tested 2026-09-25 | bounded lookup by `operationId`; implemented, frozen outcome vocabulary |
| `device.revoke` | `POST /api/companion/devices/:deviceId/revoke` | source-inspected, fixture-tested 2026-09-25 | implemented, idempotent per device; active-stream close is still pending |
| `diagnostics.read` | `GET /api/companion/diagnostics` | source-inspected, fixture-tested 2026-09-25 | implemented, allowlisted and redacted |
| `device.pair` | `POST /api/companion/devices` | source-inspected, fixture-tested 2026-09-25 | host-only pairing; the only operation that does not require an existing device credential |

Those four routes landed on 2026-09-25 under `apps/control-plane/api/companion/`.
`POST /api/companion/envelope` closes the envelope gap the bare payloads left
open: it accepts a `void.companion.v1` request envelope, proves the device
credential, maps the operation onto the same store primitives the internal path
uses, and returns a response envelope with the echoed identity. `device.pair`
was added to the Apple client's operation catalog as a separate
`CompanionPairingRequest`, because an unpaired device has no `deviceId` and
making that field optional would have weakened the bounded-identity check for
every other operation. Two client guards were corrected to match the frozen
contract: a `succeeded` outcome may not carry an error or arrive without a
body, and the response identity is verified before the payload.
Local loopback and fixture evidence only: `swift test` is a macOS-host run, so
no paired phone, no iOS simulator and no transport journey is claimed.

The existing cloud cookie and `VOID_CONTROL_TOKEN` authentication paths are not device pairing. They must not be copied into a phone credential. The existing loopback API remains private.

## 3. Protocol envelope and exact identity

### 3.1 Common envelope

All future companion requests and responses use UTF-8 JSON and this protocol identifier:

```json
{
  "protocol": "void.companion.v1",
  "schemaVersion": 1
}
```

`protocol` is exact. `schemaVersion` is an integer and is not inferred from a build number. A server that does not implement exactly `void.companion.v1` and schema `1` fails closed. It must not silently downgrade, infer fields, or treat a newer client as an older client.

A request has this shape:

```ts
type CompanionRequest = {
  protocol: "void.companion.v1";
  schemaVersion: 1;
  kind: "request";
  requestId: string;
  operationId: string;
  operation: string;
  deviceId: string;
  workspaceId: string;
  sessionId?: string;
  idempotencyKey?: string; // required for mutations, stable across retries
  issuedAt: string; // RFC 3339 UTC
  expiresAt: string; // RFC 3339 UTC
  bodyDigest: string; // lowercase SHA-256 of canonical body
  body: JsonValue;
};

// The handshake is the one negotiation request that may carry an unknown
// protocol or schema. Every operation after a successful handshake must use
// the exact CompanionRequest type above.
type CompanionHandshakeRequest = Omit<CompanionRequest, "protocol" | "schemaVersion"> & {
  protocol: string;
  schemaVersion: number;
};

type Outcome =
  | "succeeded"
  | "denied"
  | "conflict"
  | "unknown"
  | "running"
  | "unsupported_version"
  | "revoked"
  | "invalid"
  | "expired"
  | "rate_limited";

type JsonValue = null | boolean | number | string | JsonValue[] | JsonObject;
type JsonObject = { [key: string]: JsonValue };

type CompanionEvent = {
  id: string;
  sessionId: string;
  runId?: string;
  seq: number;
  at: string;
  type: string;
  kind: string;
  schemaVersion: number;
  summary?: string;
  metadata?: JsonObject;
};

type RecoverySelection =
  | { kind: "run"; runId: string }
  | { kind: "operations"; operationIds: string[] };

type ProtocolLimits = {
  maxRequestBytes: number;
  maxPromptCharacters: number;
  maxEventsPerPage: number;
  maxEventPageBytes: number;
  maxEventBytes: number;
  maxStreamSeconds: number;
  replayWindowSeconds: number;
  idempotencyRetentionHours: number;
  deviceCredentialSeconds: number;
  invitationSeconds: number;
  grantSeconds: number;
  recoveryPlanSeconds: number;
  maxMutationsPerDevice: number;
  maxStreamsPerDevice: number;
  maxDevicesPerWorkspace: number;
  maxOperationIds: number;
  maxErrorCharacters: number;
};
```

A response has this shape:

```ts
type CompanionResponse = {
  protocol: "void.companion.v1";
  schemaVersion: 1;
  kind: "response";
  requestId: string;
  operationId: string;
  operation: string;
  deviceId?: string;
  workspaceId?: string;
  httpStatus: number;
  outcome: Outcome;
  body?: JsonValue;
  error?: CompanionError;
};
```

The wire `body` is the operation-specific payload. A response must not echo a bearer credential, invitation, refresh token, private key, raw prompt, document body, capture payload, filesystem path, stack trace, or provider secret. A client must treat unknown response fields as untrusted until a later reviewed schema says otherwise.

### 3.2 Identity rules

`requestId`, `operationId`, `deviceId`, `workspaceId`, and `sessionId` are opaque JSON strings. They are never parsed as numbers, even when they look numeric. A numeric-looking string such as `"00123"` and the number `123` are different identities. Clients must preserve the exact string bytes in logs that are safe to retain and in all retries.

The server derives the authenticated `deviceId` and authorized `workspaceId` from the device credential and host configuration. A value in a request is a claim to check, not authority to select a workspace. A mismatch is denied without revealing whether another workspace exists.

The logical request identity is the tuple:

```text
(protocol, schemaVersion, deviceId, workspaceId, sessionId, operation, operationId, idempotencyKey, bodyDigest)
```

`operationId` is the stable logical operation identity across transport attempts. `requestId` identifies one wire attempt and is echoed exactly. For a mutating operation, `idempotencyKey` is required and is stable across retries. For a read, it may be omitted. The server computes the tuple from validated fields; it never accepts a client-provided authorization result.

`bodyDigest` is the lowercase hexadecimal SHA-256 digest of the canonical JSON body. The existing `packages/ledger/src/canonical.ts` canonicalization is the reference ordering rule: object keys are sorted recursively, arrays retain order, and whitespace is absent. The digest is a correlation and idempotency guard, not a signature and not a promise of exactly-once execution.

IDs are bounded to 160 UTF-8 code points unless an existing route imposes a smaller bound. Control characters, path separators, NULs, and unpaired surrogates are refused. A server must reject a body with an unknown or duplicate identity rather than coerce it.

### 3.3 Time and expiry

The executor clock is authoritative. The server allows at most 60 seconds of clock skew for admission and compares `expiresAt` to its own clock. A request without `expiresAt`, with a non-UTC timestamp, or with an expiry in the past is refused with `request_expired`. Expiry never extends an approval or silently refreshes a device grant. A read-only reconnect may obtain a new envelope, but it may not replay a mutation.

## 4. Capability handshake

The handshake reuses `GET /api/capabilities`. A future adapter negotiates the protocol using the request envelope and an authenticated device credential. No current route implements this negotiation.

Request body:

```json
{
  "client": {
    "name": "VOID Apple companion",
    "version": "0.0.0-fixture",
    "platform": "ios"
  },
  "requestedCapabilities": [
    "session.read",
    "events.read",
    "approval.read",
    "recovery.preview"
  ]
}
```

A successful handshake response body has this shape:

```ts
type Handshake = {
  serverTime: string;
  protocolVersions: ["void.companion.v1"];
  executor: {
    executorId: string;
    displayName: string;
    platform: string;
    build: string;
    identityKeyId: string;
  };
  workspace: {
    workspaceId: string;
    label?: string;
  };
  device: {
    deviceId: string;
    state: "paired" | "pending" | "revoked";
  };
  capabilities: Array<{
    id: string;
    version: string;
    status: "pending" | "unsupported";
    requiredScope?: string;
    limitation?: string;
  }>;
  limits: ProtocolLimits;
  pendingBehaviors: string[];
  expiresAt: string;
};
```

`pending` is the only positive-looking status in this design artifact. A later reviewed implementation may add an `available` status only after contract, security, and device evidence. The P04 fixtures deliberately use `pending` for every implemented-looking capability; an unlisted capability is unsupported for this handshake and must not be called.

The handshake must not return the operator token, a pairing invitation, a refresh token, a private key, a filesystem root, a document list, a prompt, or a provider secret. `displayName` is a short sanitized label, not a path or user-supplied diagnostic dump.

If the requested protocol is not exactly supported, the response is HTTP `426` with `outcome: "unsupported_version"`, a stable `protocol_version_unsupported` code, and only the supported version identifier. It returns no executor, workspace, capability, or device details. A client must stop; it must not retry against a guessed older route.

## 5. Operation catalog

The operation names are stable v1 names. The route column is the preferred existing binding, not permission to call the route directly from a phone.

| Operation | Preferred route | Scope | Mutating | Required grant |
| --- | --- | --- | --- | --- |
| `session.list` | `GET /api/sessions` | `sessions:read` | no | paired device |
| `session.read` | `GET /api/sessions/:id` | `sessions:read` and same workspace | no | paired device |
| `session.create` | `POST /api/sessions` | `sessions:write` | yes | `sessions:write` |
| `session.send` | `POST /api/sessions/:id` | `sessions:write` and same session | yes | `sessions:write` |
| `session.cancel` | `DELETE /api/sessions/:id` | `sessions:write` and same session | yes | `sessions:write` |
| `events.read` | `GET /api/sessions/:id/events?after=` | `events:read` and same session | no | paired device |
| `events.stream` | `GET /api/sessions/:id/stream` | `events:read` and same session | no | paired device |
| `approval.list` | `GET /api/approvals` | `approvals:read` | no | paired device |
| `approval.decide` | `POST /api/approvals/:id/decision` | `approvals:decide` and exact approval | yes | single-use approval grant |
| `recovery.preview` | `POST /api/sessions/:id/recovery-jobs/plan` | `recovery:read` and same session | no | paired device |
| `recovery.apply` | `POST /api/sessions/:id/recovery-jobs/apply` | `recovery:apply` and same session | yes | single-use recovery grant |
| `recovery.status` | `GET /api/sessions/:id/recovery-jobs/:job` | `recovery:read` and same session | no | paired device |
| `operation.status` | pending route | operation owner and same workspace | no | paired device |
| `device.revoke` | pending route | paired device or host operator | yes | host confirmation |
| `diagnostics.read` | pending route | paired device | no | paired device |

A read-only device is the default. Execute and recovery permissions are independent. A device with `sessions:write` still cannot apply recovery without `recovery:apply`. A workspace label is descriptive metadata and never filesystem authority.

## 6. Outcomes and errors

Every mutating or recovery response has exactly one `outcome` discriminator. HTTP status is advisory for clients; the discriminator is authoritative.

| Outcome | Typical HTTP | Meaning | Automatic retry |
| --- | ---: | --- | --- |
| `succeeded` | 200 or 201 | server has durable evidence of the requested result | no need; replay by idempotency key is safe |
| `denied` | 200 for a recorded user denial; 403 or 422 for authorization/policy refusal | the decision or request was refused and no downstream effect occurred | no; do not reword and retry |
| `conflict` | 409 | stale plan, human edit, concurrent device, or changed state | no force path; refresh and obtain a new grant |
| `unknown` | 202 | dispatch may have happened but durable outcome is not confirmed | never for the mutation; poll status |
| `running` | 202 | an accepted operation is still in flight | poll status; do not resend |
| `unsupported_version` | 426 | protocol or schema is not supported | no downgrade or guessed fallback |
| `revoked` | 401 or 403 | device grant is no longer active | no; re-pair through a host-approved flow |
| `invalid` | 400 | malformed or out-of-bound request | only after a new explicit request |
| `expired` | 410 | request, grant, or cursor expired | no implicit extension |
| `rate_limited` | 429 | bounded admission limit reached | only after server-provided delay, for reads |

Error objects are stable and sanitized:

```ts
type CompanionError = {
  code: string;
  message: string;
  retryable: boolean;
  reconcileRequired?: boolean;
  refreshRequired?: boolean;
  retryAfterMs?: number; // 0..60000
  supportedVersions?: string[]; // version identifiers only, at most 8
};
```

Allowed codes in v1 include `authentication_required`, `device_revoked`, `authorization_denied`, `approval_required`, `approval_denied`, `approval_expired`, `idempotency_key_reused`, `request_in_flight`, `request_expired`, `invalid_cursor`, `cursor_expired`, `plan_digest_mismatch`, `plan_expired`, `human_edit_conflict`, `operation_unknown`, `protocol_version_unsupported`, `rate_limited`, and `internal_error`. Messages are short, stable categories. They never contain a path, prompt, document text, key, credential, raw exception, or provider response.

## 7. Idempotency and unknown outcomes

Every mutating request carries a client-generated `idempotencyKey` in the operation body or adapter metadata. The key is stable for one intent and is never regenerated for a retry. The server atomically claims `(deviceId, workspaceId, operation, idempotencyKey)` before dispatch.

The server behavior is:

1. Same key and same `bodyDigest`: return the stored response without a second dispatch. A stored `succeeded`, `denied`, `conflict`, or `unknown` response remains the same response.
2. Same key and different `bodyDigest`: return HTTP `409`, outcome `conflict`, code `idempotency_key_reused`. Do not return the first response.
3. Same key while the first attempt is in flight: return HTTP `409`, outcome `conflict`, code `request_in_flight`, and the stable `operationId` for status polling. Do not dispatch a second effect.
4. Timeout, disconnect, or process loss after the dispatch boundary: return or retain outcome `unknown`, code `operation_unknown`, `reconcileRequired: true`. The client polls `operation.status`; it must not resend the mutation.
5. A pre-dispatch refusal is `denied` or `conflict`, not `unknown`, and has no effect to reconcile.

Idempotency provides deduplication for the retained request record. It does not make an external side effect and a receipt one distributed transaction. The operation status record is the source of truth after a lost response.

A status lookup is read-only. It returns one of `running`, `succeeded`, `denied`, `conflict`, `unknown`, `revoked`, or `expired`, plus a bounded receipt. It never starts, retries, or reverses work.

## 8. Bounded event cursor

The existing `after` query parameter and `Last-Event-ID` SSE header are retained as the source vocabulary. The future companion adapter must treat the cursor as an exact decimal string and validate it as a non-negative safe integer. It must not parse an arbitrary string as a number or silently clamp it.

Request:

```text
GET /api/sessions/:id/events?after=<decimal-string>&limit=1000
```

Response body:

```ts
type EventPage = {
  items: CompanionEvent[];
  after: string;
  nextAfter: string | null;
  hasMore: boolean;
  historyComplete: boolean;
  scope: { workspaceId: string; sessionId: string };
  asOf: string;
  replayExpiresAt: string;
};
```

`seq` is a JSON integer in the range 0 through `Number.MAX_SAFE_INTEGER`. `id` is an opaque string. Events are strictly increasing by `seq`; duplicate sequence numbers in a page are invalid. A page contains at most 1,000 events and at most 1 MiB of encoded JSON. One serialized event is at most 32 KiB. The replay window is 15 minutes from the cursor issue time. A stream ends after 55 seconds, matching the existing cloud bound, and the client reconnects with a fresh bounded read.

If the requested cursor is older than the retained window, return HTTP `409`, outcome `conflict`, code `cursor_expired`, `refreshRequired: true`, and no events. The client reloads a safe session snapshot and then asks for events after the new cursor. Cursor expiry never triggers a mutation retry.

The companion event projection is an allowlist, not the raw internal event. It may contain `id`, `sessionId`, `runId`, `seq`, `at`, `type`, `kind`, `schemaVersion`, a short redacted `summary`, and bounded metadata such as status, decision, class, operation ID, checkpoint, and result category. It must not contain prompts, assistant message bodies, document bodies, raw tool arguments, raw tool results, paths, keys, credentials, stack traces, or provider text. The current source event shape is not evidence that this projection is implemented.

A heartbeat is not an event and has no cursor. Closing a stream is not cancellation. Revocation closes active streams promptly and leaves already-dispatched durable outcomes queryable.

## 9. Approval contract

### 9.1 Approval read

`GET /api/approvals` is bound as `approval.list`. The companion projection contains only:

```ts
type ApprovalSummary = {
  approvalId: string;
  sessionId: string;
  operationId: string;
  workspaceId: string;
  tool: string;
  class: string;
  status: "pending" | "approved" | "denied" | "expired";
  expiresAt: string;
  requestDigest: string;
  requiredScope: string;
  blastRadius?: number;
  reasonCode?: string;
};
```

It never contains raw arguments, prompts, document bodies, paths, secrets, or provider responses. `requestDigest` identifies the exact proposed request. A changed request cannot use an old approval.

### 9.2 Approval decision

`POST /api/approvals/:id/decision` is bound as `approval.decide`. The companion request body has:

```ts
type ApprovalDecisionRequest = {
  operationId: string;
  idempotencyKey: string;
  approvalId: string;
  requestDigest: string;
  decision: "approved" | "denied";
  grantId: string;
  grantVersion: number;
};
```

The authenticated device and server-derived operator identity are not accepted from a caller-controlled `by` field. The adapter may populate the existing route's `by` value from authenticated state. A decision requires a single-use grant bound to device, workspace, session, approval, request digest, operation ID, and expiry. Grants expire after five minutes and cannot be extended by reconnecting.

A successful decision returns a sanitized receipt. A denial is a successful decision with outcome `denied` and no downstream effect. A stale digest, expired grant, revoked device, or concurrent decision is `conflict` or `revoked`, never a forced approval.

## 10. Recovery preview, apply, and status

### 10.1 Preview

`POST /api/sessions/:id/recovery-jobs/plan` is bound as `recovery.preview`. The request keeps the existing vocabulary:

```ts
type RecoveryPreviewRequest = {
  operationId: string;
  idempotencyKey: string;
  jobId: string;
  selection:
    | { kind: "run"; runId: string }
    | { kind: "operations"; operationIds: string[] };
};
```

`jobId` is 1 to 120 safe identifier characters. A run selection is one exact run ID. An operations selection contains 1 to 500 unique operation IDs. No prefix, timestamp, or filesystem path is a selection.

The response is the existing public plan projection, plus protocol metadata:

```ts
type RecoveryPreview = {
  jobId: string;
  planDigest: string; // 64 lowercase hex characters
  selection: RecoverySelection;
  boundary: { sequence: number; digest: string };
  steps: Array<{
    operationId: string;
    sequence: number;
    resources: string[]; // opaque logical IDs, never host paths
    scope: string;
  }>;
  residuals: Array<{ operationId: string; status: string }>;
  expiresAt: string;
  canApply: boolean;
};
```

A plan contains no capture payload, private inverse, document body, key, credential, or raw exception. `resources` are bounded logical resource identifiers in the companion projection; an adapter must sanitize existing path-like values before returning them. Plan digests bind the exact boundary and steps. A plan expires after 15 minutes. A refresh creates a new job ID and a new digest. A preview is read-only and never records approval.

### 10.2 Apply

`POST /api/sessions/:id/recovery-jobs/apply` is bound as `recovery.apply`. The request is:

```ts
type RecoveryApplyRequest = {
  operationId: string;
  idempotencyKey: string;
  jobId: string;
  planDigest: string;
  approved: true;
  grantId: string;
  grantVersion: number;
};
```

`approved` must be the JSON boolean `true`; the strings `"true"`, `"yes"`, and `1` are invalid. The grant is single-use and binds the exact plan digest, workspace, session, device, operation, and expiry. The server reloads the stored plan under the same lock as forward writes, verifies the current authorization and state, and only then dispatches an inverse.

The response uses the existing result vocabulary:

```ts
type RecoveryApplyResponse = {
  jobId: string;
  status: "restored" | "partial" | "conflict" | "unknown" | "paused";
  checkpoint: number;
  outcomes: Array<{ operationId: string; status: "restored" | "compensated" }>;
  residuals: Array<{ operationId: string; status: string }>;
  pause?: { code: "step-unavailable"; operationId: string };
};
```

A human edit produces `conflict` and preserves the newer state. There is no force-overwrite field in v1. `unknown` and `paused` retain the recovery block and never trigger an automatic inverse retry. `restored` and `partial` are terminal receipts; repeated apply with the same idempotency key returns the same receipt without another effect.

The public session may retain only `lastRecoveryJob: { jobId }`. It must not expose `recoveryBlock`, `priorStatus`, capture contents, or private job data. A branch clears that reference because it is a different workspace.

### 10.3 Status

`GET /api/sessions/:id/recovery-jobs/:job` is bound as `recovery.status`. It returns the same sanitized plan or result shape. It never creates a new plan, grants approval, reconciles a journal, or applies an inverse.

## 11. Pairing, revocation, and credentials

Pairing and device credentials are future P05 work. This section defines their required semantics so v1 tests do not accidentally treat a browser token as a phone credential.

A host confirmation flow creates a short-lived, single-use invitation. The invitation is not reusable, is never logged, and is never included in a QR history, screenshot fixture, release asset, or diagnostic bundle. The default invitation lifetime is two minutes. The future device credential is stored in platform secure storage and is separate from `VOID_CONTROL_TOKEN`.

`device.revoke` is a pending authenticated operation. Its response records `deviceId`, `revokedAt`, `activeStreamsClosed`, and a statement that new mutations are denied. Revocation invalidates access and refresh material immediately; it stops new requests, pending approvals, and un-dispatched grants. An already-dispatched effect keeps its durable outcome and is not erased or automatically repeated. A request made after revocation returns `outcome: "revoked"`.

The host may require an unlocked local confirmation for pairing and revocation. A locked executor refuses new remote mutations; it does not queue them for automatic later execution. Read-only diagnosis remains possible only if the device is still authorized and the diagnostic projection is sanitized.

## 12. Limits and boundedness

These are v1 admission limits. A server may choose a lower limit and return `rate_limited`; it may not exceed these values without a new reviewed protocol version.

| Limit | v1 maximum | Rationale |
| --- | ---: | --- |
| JSON request body | 65,536 bytes | matches the existing local and cloud body bound |
| Prompt text | 32,000 characters | matches existing session input bound |
| Event page | 1,000 events | matches the existing cloud event query bound |
| Encoded event page | 1 MiB | prevents a retained page from exhausting a phone |
| One serialized event | 32 KiB | keeps SSE and JSON decoding bounded |
| SSE stream lifetime | 55 seconds | forces bounded reconnect and cursor handling |
| Cursor replay window | 15 minutes | bounds replay memory and stale history |
| Idempotency record retention | 24 hours | covers normal retry and delayed reconnect |
| Device access credential | 15 minutes | limits theft and refresh replay |
| Pairing invitation | 2 minutes | limits invitation theft and QR substitution |
| Approval or recovery grant | 5 minutes | requires a fresh human decision |
| Recovery plan | 15 minutes | prevents applying an old preview |
| Concurrent mutating operations per device | 2 | limits races and duplicate work |
| Concurrent event streams per device | 2 | limits foreground resource use |
| Devices per workspace | 8 | bounded initial beta and revocation review |
| Workspace ID | 160 code points | prevents unbounded identity values |
| Operation/session/device IDs | 160 code points | preserves exact strings and bounds parsing |
| Recovery operation selection | 500 IDs | matches the stricter existing cloud route |
| Error message | 320 characters | prevents diagnostic disclosure and UI overflow |

The server applies a shared rate limit across workers. A limit response contains `retryAfterMs` for safe reads only. It never causes a queued mutation to run later. Pending maps, event buffers, and idempotency records must be evicted only after their retention and terminal state are durable.

## 13. Threat model

| Threat | Asset or boundary | Required v1 control | Residual risk and pending evidence |
| --- | --- | --- | --- |
| Invitation theft | pairing authority | two-minute, single-use invitation; host confirmation; no logs or QR history; rate limit | physical observation and unlocked-host compromise need device tests |
| QR substitution | endpoint and executor identity | QR binds executor ID, identity key, and TLS certificate fingerprint; show a short fingerprint; require host confirmation; never disable TLS validation | camera substitution and certificate replacement need signed sandbox evidence |
| Token theft | device credential | per-device short-lived credential, secure storage, rotation, revocation on active and new requests, no operator token | physical device extraction and backup behavior remain pending |
| Malicious executor address | network routing | explicit endpoint discovery, certificate validation, fingerprint confirmation, no arbitrary URL from a message, no public listener | hostile LAN, DNS/IP changes, and IPv6 need physical-device evidence |
| Replay | request and approval authority | stable idempotency key, body digest, single-use grants, exact operation identity, no automatic retry after unknown | crash and delayed-retry cases need P05 integration tests |
| Cross-workspace access | tenant boundary | server-derived workspace and session scope, device grant bound to one workspace, constant refusal shape | multi-workspace and branch races need contract tests |
| Concurrent devices | operation ownership | atomic idempotency claim, current-state lock, exact digest and grant binding, one winner and a conflict for the other device; no two-person quorum implied | simultaneous approval/revocation races need real device tests |
| Compromised device | all granted scope | read-only default, independent execute/recovery grants, immediate revocation, no secret-bearing diagnostics | full device compromise containment and re-pair flow remain pending |

Threat controls are requirements, not claims that the current tree implements them. A fixture never closes a threat-model row.

## 14. Shared fixture contract

The fixtures in `apps/apple/Fixtures/Protocol/` are deterministic contract vectors, not server responses captured from a running service. Every file has this outer shape:

```ts
type CompanionFixture = {
  fixture: string;
  protocol: "void.companion.v1";
  schemaVersion: 1;
  implementation: {
    server: "pending";
    apple: "pending";
    transport: "pending";
    authority: "not-granted";
  };
  sourceRoutes: string[];
  request: JsonObject;
  response: JsonObject;
};
```

The `request` and `response` members are the exact envelope shapes above. Synthetic IDs contain no secret. Fixture bodies contain no prompt, document body, path, key, credential, capture, or raw exception. The six outcome files are:

- `succeeded.json`: a bounded recovery apply receipt with a durable `restored` result.
- `denied.json`: a pre-dispatch approval or authorization refusal with no effect.
- `conflict.json`: a stale or concurrent plan refusal requiring a fresh preview.
- `unknown.json`: a lost-response result requiring status reconciliation and forbidding retry.
- `unsupported-version.json`: a fail-closed version negotiation refusal with no capabilities.
- `revoked.json`: a post-revocation refusal with active streams closed and no new mutation.

`capability-handshake.json` is the positive handshake shape, but every capability status is `pending`. The fixtures are suitable for Swift `Codable` tests and TypeScript boundary tests once schemas are generated or hand-written beside the eventual implementation. They do not authorize a route, prove TLS, prove device storage, or prove a physical-device journey.

## 15. Pending implementation matrix

No row below is available in the P04 artifact. A future implementation must update the matrix with source, contract-test, security-review, and device evidence without weakening a fail-closed outcome.

| Capability | Server | Apple client | Evidence required |
| --- | --- | --- | --- |
| version handshake | pending | pending | boundary fixtures plus unsupported-version test |
| device credential and pairing | pending | pending | signed sandbox, Keychain, theft/revocation tests |
| scoped session reads and sends | pending | pending | same-workspace and cross-workspace tests |
| bounded event cursor | pending | pending | boundary and boundary-plus-one tests, reconnect test |
| approval read and decision | pending | pending | exact digest, expiry, denial, race tests |
| recovery preview and apply | pending | pending | human-edit conflict, unknown, restart, repeat-apply tests |
| device revocation | pending | pending | active stream, pending approval, and new request tests |
| sanitized diagnostics | pending | pending | synthetic-secret and document-body exclusion tests |
| physical iPhone/iPad behavior | pending | pending | real device evidence; simulator is not a substitute |
| signed Mac sandbox behavior | pending | pending | Developer ID or App Sandbox evidence; source inspection is insufficient |
| TestFlight or store approval | pending | pending | Apple-side evidence; never inferred from fixtures |

## 16. Contract-test acceptance

Later TypeScript and Swift tests should assert observable contracts, not implementation details:

- exact string identity survives numeric-looking and large numeric-looking IDs;
- unsupported protocol and schema return `unsupported_version` with no capability disclosure;
- workspace scope comes from authenticated server state, not a request field;
- body and event boundary values pass and boundary-plus-one values fail predictably;
- a repeated idempotency key with the same digest does not dispatch twice;
- a repeated key with a changed digest fails closed;
- an in-flight duplicate, lost response, and unknown outcome never cause an automatic mutation retry;
- event cursor expiry requires a snapshot reload and does not replay a write;
- approval and recovery grants bind exact request or plan digests and expire;
- human edits produce conflict without overwrite;
- active revocation rejects new work while preserving already-dispatched evidence;
- all errors and diagnostic projections exclude paths, keys, credentials, prompts, document bodies, capture payloads, and raw exceptions.

The contract is ready for fixture decoding only. It is not release evidence, server authorization, Apple signing evidence, physical-device evidence, beta evidence, or store approval.

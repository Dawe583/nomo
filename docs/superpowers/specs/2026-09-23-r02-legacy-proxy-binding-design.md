# R02 legacy proxy binding design

Date: 2026-09-23
Status: accepted
Source: `docs/PLAN-GAPS.md` G-08 and `docs/REVERSE-TOOL-UPGRADE-PLAN.md` WP-R02

## Objective

Prove one honest external MCP write path through the legacy proxy. For
`postgres.row.update`, a host binding must persist a real connector before-image
before dispatch, bind the translated MCP request to that capture, record the
observed upstream outcome, and permit recovery only when the evidence says the
write completed.

This slice closes G-08 only for the named Postgres tool and the tested host
binding. It does not certify arbitrary MCP tools, S3, the standalone
`nomo-proxy` binary, observe posture, or a distributed deployment.

## Current gap

`runProxy` currently calls `captureLegacyEnvelope`, which hashes arguments but
does not persist a connector before-image. The returned envelope is discarded.
After policy approval, the proxy forwards the MCP request and treats the
upstream response as an ordinary relay message. It has no pending operation
record and writes no completed, failed or unknown outcome.

`packages/runtime/src/adapter.ts` defines a separate legacy binding helper, but
no host calls it. It trusts outcome fields supplied by its dispatch callback and
does not persist them. The managed runtime has a complete lifecycle, but moving
a generic external MCP request into that runtime would make the runtime hold
state across an untrusted network dispatch and is outside this first slice.

## Decision

Add one generic injected binding contract to the proxy. The proxy remains
connector agnostic. A composition root or test fixture supplies the concrete
Postgres connector, snapshot store, manifest and outcome recorder.

The binding is optional. When absent, existing behavior and claims remain
unchanged. When present for a tool, it owns four operations:

```ts
export type LegacyCaptureEvidence = {
  readonly tool: string;
  readonly workspace: string;
  readonly argsDigest: string;
  readonly captureDigest: string;
  readonly reference: Readonly<{
    namespace: string;
    digest: string;
  }>;
};

export type LegacyOutcomeStatus = "completed" | "failed" | "unknown";

export type LegacyOutcomeEvidence = {
  readonly tool: string;
  readonly workspace: string;
  readonly argsDigest: string;
  readonly captureDigest: string;
  readonly status: LegacyOutcomeStatus;
  readonly at: string;
};

export type LegacyProxyBinding = {
  readonly tool: string;
  capture(call: InterceptedCall): Promise<LegacyCaptureEvidence>;
  dispatched(evidence: LegacyCaptureEvidence): Promise<void>;
  outcome(
    evidence: LegacyCaptureEvidence,
    response: JsonRpcResult | JsonRpcError | null,
  ): Promise<LegacyOutcomeEvidence>;
};

export type LegacyBindingResolver = (
  call: InterceptedCall,
) => LegacyProxyBinding | null;
```

Exact names may change during the implementation plan self-review, but these
invariants may not:

- the proxy never imports a concrete connector;
- the binding result contains no raw arguments or raw provider result;
- one canonical argument digest is computed once and checked at every boundary;
- the outcome must repeat the tool, workspace, argument digest and capture
  digest from the accepted capture;
- a mismatch fails closed and records unknown;
- only a validated completed outcome can authorize later recovery.

## Request lifecycle

### Policy and capture

1. Parse and classify the `tools/call` request using the existing path.
2. Apply policy and complete any hold.
3. Resolve a binding for the call.
4. If no binding exists, preserve current legacy behavior and do not claim
   recoverability.
5. If a binding exists, call `capture` before translating or sending the
   request.
6. Validate the evidence against the call and canonical argument digest.
7. A capture, manifest or storage failure denies locally. The upstream receives
   zero requests.

### Dispatch

1. Translate the agent request ID through `Session`.
2. Persist the binding's dispatched state before calling `sendUpstream`.
3. Store pending evidence under a typed request ID key that distinguishes
   numeric `1` from string `"1"`.
4. Send exactly once.
5. A failure before send is failed. A failure after the dispatched record is
   unknown.

### Outcome

1. On a matching JSON-RPC success response, pass the response to the binding.
   The Postgres fixture accepts only its explicit result schema. An unrecognized
   success payload is unknown, not completed.
2. On a matching JSON-RPC error response, record failed.
3. On upstream close, upstream error, shutdown or malformed matching response,
   record unknown for every dispatched pending call.
4. Persist and validate the outcome before relaying the response to the agent.
5. Remove the pending entry only after durable outcome recording succeeds.
6. Never redispatch an unknown call.

## Persistence and recovery evidence

The concrete Postgres fixture reuses `makeConnector({ store, exec }).postgres`
for the before-image and existing manifest support for lookup after restart.
The outcome recorder appends signed evidence containing only digests, tool,
workspace, status and time.

A recovery consumer must require all of these facts:

- a verified capture reference and digest;
- a signed completed outcome;
- equal tool, workspace, argument digest and capture digest across both;
- the existing connector inverse reconstructed from persisted bytes;
- current target state still matching the connector's drift precondition.

A failed or unknown outcome is not recoverable. A later human modification
returns conflict and remains untouched.

## Package boundaries

- `packages/proxy` defines and consumes the generic binding interface.
- `packages/proxy` does not import `packages/connectors` or a connector id.
- `packages/connectors` keeps Postgres capture, inverse and apply behavior.
- The conformance fixture composes both packages outside production proxy code.
- `packages/runtime` is not expanded in this slice. Its unused legacy helper is
  either strengthened and reused only if that reduces duplication without
  adding a proxy dependency, or left unchanged and explicitly documented.

## Security and failure rules

- Raw arguments, SQL values, credentials and provider results never enter the
  outcome ledger record.
- Canonical JSON is the only argument digest input. The current mixed
  `JSON.stringify` digest path must be unified.
- Capture failure blocks dispatch.
- Ledger or outcome persistence failure after dispatch produces unknown.
- Cancellation does not prove the upstream write stopped.
- Observe posture may forward, but it cannot create recovery evidence.
- External writes between capture and dispatch remain possible. This slice
  relies on existing drift refusal and does not claim transaction atomicity.
- No automatic retry occurs after dispatch.

## Verification

The primary conformance scenario runs the real `runProxy` flow with a real
Postgres connector against PGlite or the existing disposable Postgres harness:

1. Capture a row before-image.
2. Forward one `postgres.row.update` MCP call.
3. Receive the accepted success schema.
4. Persist a completed outcome bound to the capture digest.
5. Recreate the connector after restart.
6. Build and apply the inverse.
7. Verify the row exactly matches its original value.

Required negative cases:

- capture failure sends zero upstream calls;
- JSON-RPC error records failed and recovery refuses;
- upstream close after dispatch records unknown and does not retry;
- malformed success records unknown;
- human drift returns conflict and preserves the human value;
- changed capture digest, reference, tool, workspace or argument digest refuses;
- simultaneous numeric `1` and string `"1"` requests keep distinct outcomes;
- observe posture creates no completed recovery evidence.

Focused verification uses Node's test runner with TAP where the workspace
aggregator requires it, then package typechecks, `pnpm run check`, the reverse
engine check and the production build.

## Documentation and claim boundary

Update `docs/RECOVERY-COVERAGE.md`, `docs/REVERSE-ENGINE-VALIDATION.md`,
`docs/PLAN-GAPS.md` and `docs/PLAN-STATUS.md` only after the conformance scenario
passes. The claim must name the single certified tool and transport fixture.
All other external tools remain unsupported for legacy recovery.

## Rejected alternatives

### Route the generic MCP call through `RecoveryRuntime`

Rejected for this slice. The runtime assumes its adapter owns prepare, execute
and reconciliation. A generic external MCP server does not provide the same
atomicity or idempotency contract, and waiting on it inside the managed journal
would widen the failure surface before the host binding is proven.

### Certify only the managed Postgres MCP tool

Rejected as the G-08 answer. It is safer and already stronger, but it does not
bind the legacy proxy's external dispatch. It remains the preferred production
path while this legacy integration is narrow.

### Import the Postgres connector directly into the proxy

Rejected by the package contract. The proxy resolves generic bindings through
injection and never imports a connector.

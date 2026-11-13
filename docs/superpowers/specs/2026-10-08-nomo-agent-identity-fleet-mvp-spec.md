# Spec: NOMO Agent Identity and Fleet Control Plane

> Status: planning draft. The product direction and recommended demo boundary were
> accepted for continued planning on 2026-10-08. This is not approval to deploy.
>
> Date: 2026-10-08
> Capability map: `docs/superpowers/specs/2026-10-08-nomo-agent-identity-fleet-capability-map.md`

## Objective

Build NOMO as an Agent Identity & Fleet Control Plane for MCP-capable agents.
The runtime binds every authorized tool call to a registered principal,
workspace, agent and run. All calls receive a cheap identity and scope check and
emit a metadata event. High-risk writes take the full policy and durable-evidence
path; reads and low-risk calls use a fast path. Operators can inspect actions,
block or approve a write, revoke access, and see which already-dispatched actions
remain unresolved. The fast path still passes through the trusted proxy; it does
not bypass identity checks.

The NOMO coding-agent Harness is a required host integration and a release gate.
It is not a separate product pitch. Its runs must use the same identity, token,
proxy, policy and ledger path as other managed agents. A local demo using the
current Workbench does not, by itself, complete the Harness workstream.

## User and business outcomes

## Technology and commands

- Runtime floor: Node.js 24 or newer, pnpm workspace. Existing code must remain
  runnable under the repository's supported Node version.
- Existing web UI baseline: React 19 and Vite 7. Tailwind CSS v4 is a requested
  target, not a reason to add dependencies to the local demo before checking
  current UI conventions.
- Hosted control-plane data may use Neon Postgres and Drizzle after its schema,
  migration and isolation requirements are approved. The local demo uses the
  existing disposable fixtures and local signed ledger.
- Do not add dependencies to the local demo unless an existing package cannot
  meet a verified requirement. The MCP SDK is already declared by the proxy.
- Full check: `pnpm run check`.
- Test suite: `pnpm test`.
- Type check: `pnpm run typecheck`.
- Production build: `pnpm run build`.
- Focused proxy and Workbench tests must be run with the repository's Node test
  runner after the exact new test paths are selected in the implementation plan.
  No command in this spec is permission to target production.

The primary operator is a team owner responsible for coding or workflow agents
that can write to databases, repositories, cloud services or other MCP tools.
The operator needs to answer: which registered agent and run made this call,
what scope and policy applied, who approved it, whether the target received it,
and whether a revoke prevents the next call.

The proposed market wedge is one governed write with four named owners:
agent principal, scope and policy, control approval, and incident response. This
is a hypothesis, not validated demand. Do not claim that identity, runtime
policy, MCP gateways or audit records are an empty market. Current official
products include [Microsoft Entra Agent ID](https://learn.microsoft.com/en-us/entra/agent-id/what-is-microsoft-entra-agent-id),
[AWS Bedrock AgentCore Identity](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/identity.html),
and [Cloudflare MCP server portals](https://developers.cloudflare.com/cloudflare-one/access-controls/ai-controls/mcp-portals/).
A buyer signal counts only when a real write incident or blocked write, named
owner, named approver, incident owner, specific pilot environment and dated next
step are recorded. A paid scope is stronger evidence. Positive feedback to a
feature list is not validation. Pricing and tiers remain unvalidated hypotheses;
this MVP makes no price claim.

## Authority and assumptions

1. The user-provided 2026-10-08 brief establishes Agent Identity & Fleet Control
   Plane as the primary direction and requires the coding-agent Harness.
2. The current code baseline is `@void/*` at `b39a7b0`. NOMO package renames in
   the dirty main checkout and other worktrees are not copied into this branch.
   Any package rename is an explicit compatibility workstream.
3. For the Sunday 2026-10-11 demo, NOMO Workbench is the trusted local host. It
   creates one run identity and uses one local test issuer, one workspace, one
   HTTP MCP proxy endpoint and one disposable MCP target.
4. The local demo token is an internal, opaque capability token with a maximum
   60-second TTL and audience bound to the NOMO proxy. It is not presented as a
   standard MCP OAuth access token. It is held in Workbench server memory, sent
   only in the HTTP `Authorization` header, and never passed to the model,
   persisted in workspace config, or forwarded upstream.
5. Product v1 must use the standard MCP authorization profile for HTTP. It must
   implement Protected Resource Metadata (RFC 9728), Authorization Server
   discovery, PKCE, the `resource` parameter, token audience and validity checks,
   and standard unauthorized responses. STDIO identity uses a separate process
   and environment trust design, not MCP OAuth.
6. The Sunday target is a reproducible local demo, not a public beta, production
   release, or claim of distributed fleet control.
7. No production account or production data is used. Test credentials are
   generated for the local run and are never written to files or logs.

## Scope

### Sunday demo

- A trusted local Workbench run maps to one registered principal, agent and
  workspace. Caller-supplied `agentId` or `runId` is metadata only and cannot
  authorize a request.
- A local issuer creates one random 60-second proxy capability for the run.
  Proxy validation checks issuer, audience, expiry, revocation, workspace, agent,
  run, upstream and allowed tool scope. Invalid grants fail closed.
- A new inbound Streamable HTTP MCP endpoint reuses the existing proxy
  interception and ledger path. The current proxy's HTTP code is an upstream
  client; it is not an inbound HTTP server. The endpoint is loopback-only for
  the demo and uses the MCP SDK and protocol requirements rather than treating
  the existing upstream HTTP client as a server.
- A disposable MCP target is used. The existing `fixtures/e2e-server.mjs` and
  `fixtures/e2e-policy.yaml` are the first candidates; the final target must be
  confirmed by the implementation smoke test.
- The demo proves a read or low-risk fast path, plus high-risk `Allow`, `Deny`,
  and `Hold`; `Hold` binds operator approval to the exact canonical operation
  digest and a verified local operator.
- `observe-only` is an explicit mode that records and forwards without
  enforcing a deny or hold. It is never an error fallback.
- All calls produce a minimal metadata event without secrets or prompts. The
  signed write ledger appends decision evidence before dispatch and appends the
  result after the upstream response. Ledger or policy failure blocks a write.
- A local kill switch stops the next call handled by the one demo process after
  acknowledgement. A call already dispatched may complete and must be shown as
  in flight or unresolved, never as cancelled or rolled back.
- The current Workbench can drive one constrained task through the same runtime
  path. Learning stays disabled in this demo until approval and retrieval pass
  the Harness release gates.

### Product v1

- A principal registry binds each agent to a workspace, registered host,
  credential status and revocation state. Administrative user identity is
  separate from agent identity.
- HTTP MCP authorization follows the current MCP authorization specification.
  Tokens are issued for the canonical NOMO proxy resource, never for an
  upstream. The proxy validates its own audience and never forwards its token.
  An upstream that needs authentication receives a separate credential bound to
  that upstream's canonical resource.
- Run grants are short-lived, scoped and revocable. Policy scope covers
  canonicalized upstream and tool identifiers. Expiry and revocation are
  rechecked immediately before dispatch and after any `Hold`.
- Each write has a durable pre-dispatch decision record and a linked result or
  explicit unknown outcome. The signed append-only ledger has a standalone
  verification path. Neon Postgres and Drizzle may store control-plane state;
  ledger migrations and mutation semantics remain separately controlled.
- `Allow`, `Deny`, `Hold`, and `observe-only` are explicit policy outcomes.
  Unknown identity, scope, tool, policy, broker, revocation state or ledger state
  fails closed.
- Run stop, local agent revoke and fleet-wide revoke are separate operations.
  Fleet success is returned only after active enforcement nodes acknowledge the
  revocation generation. A disconnected node is not reported as revoked.
- The Harness runs coding agents through the same enforcement path. Learning
  suggestions remain inert until the operator approves the exact proposal
  digest. Later retrieval is bounded, same-workspace and sourced only from
  approved, verified records. It cannot change policy or permissions.
- The control plane shows agent and run inventory, live events, approval state,
  revocation acknowledgements, and unresolved in-flight outcomes.

### Full product

Full product adds multi-tenant isolation, role-based access, SSO, hosted key
management, audited integrations, broad host and connector support, resilient
fleet revocation, operational support, independent evidence export, and
enterprise-grade availability. Each added host must declare which authentication,
policy, ledger and kill-switch guarantees it supports. Unsupported guarantees
must be visible rather than inferred.

## Architecture boundaries

- `packages/registry` remains pure classification data and functions. It does
  not own identity records, credentials, cryptography, ledger access or network
  calls.
- Identity and credential issuance are separate from action classification.
  A new package is not required for the one-process demo; extract a shared
  identity package only when product-v1 boundaries are stable.
- The proxy owns MCP request termination, canonicalization, policy evaluation,
  pre-dispatch evidence, forwarding, result evidence and refusal semantics.
- The Workbench owns the trusted local demo principal and obtains the per-run
  token outside the model prompt. It must not store the run token in a public
  config response or tool result.
- The ledger exposes append and read, never update. Existing durable state,
  verification and `void.*` identifiers remain compatible.
- Control-plane user sessions never substitute for agent or run credentials.
- The public proxy spine remains Apache-2.0 open core. Hosted control-plane
  features remain a separate closed service boundary, subject to a verified
  package and licence map.

## Performance requirements

- Identity and scope checks apply to every call. Only high-risk writes incur the
  durable policy and operator approval path; read and low-risk calls use a
  bounded fast path through the proxy.
- No latency or throughput claim is made for the demo. Measure p50 and p95 for
  the fast path and high-risk path separately before setting product targets.
- The high-risk path prioritizes correct authorization and pre-dispatch evidence
  over bypassing policy for speed.

## Security and correctness requirements

1. Token claims bind issuer, audience, agent, run, workspace, allowed upstream,
   canonical tool scope, issue time, expiry and revocation generation. The
   internal demo may keep claims in the issuer's server-side record behind an
   opaque random token; it must not use a hard-coded bearer token.
2. Tokens appear only in the HTTP `Authorization` header. They do not appear in
   URL query strings, prompts, logs, events, ledger payloads, screenshots,
   browser storage or upstream MCP calls.
3. Issuer, audience, expiry, clock skew, key rotation, canonicalization,
   revocation, replay and idempotency contracts are specified and tested before
   product-v1 OAuth is enabled.
4. For an operation held for approval, approval binds the exact operation
   digest, policy version and verified approver. After approval, token expiry,
   revocation and scope are checked again. If the grant expired, issue a new
   scoped grant or reject the operation.
5. Append durable decision evidence before forwarding any write. If append fails,
   deny. A dispatch timeout is an unknown outcome until reconciled against the
   target; never report it as cancelled or reverted.
6. `observe-only` is opt-in and visible. Authentication, ledger, policy or
   broker errors never switch the process into observe mode.
7. Stop does not cancel an already-dispatched MCP call and does not undo side
   effects. The UI exposes run, agent and fleet scope and their acknowledgement
   state separately.
8. Harness proposals cannot change policy, permissions, host commands or
   credentials. Only an operator-approved proposal with current provenance can
   be activated and retrieved later.
9. Tests use fixtures or disposable targets. No autonomous test accesses a
   production account.

## Verification and release gates

### Sunday demo exit

- A single local Workbench run calls the proxy and disposable MCP target.
- A read or low-risk call uses the proxy fast path; only the high-risk write is
  subject to the durable policy and approval path.
- A valid 60-second run token is accepted; wrong audience, wrong scope, expired
  and revoked tokens are refused before upstream dispatch.
- `Allow` forwards only after a pre-dispatch ledger append. `Deny` does not
  forward. `Hold` does not forward until exact-digest operator approval and a
  fresh grant check. `observe-only` forwards only when explicitly selected.
- Token and upstream secret redaction tests pass.
- Local kill acknowledgement blocks the next call; an in-flight call is shown
  as unresolved if its completion is not known.
- The one constrained Harness run reaches the proxy through the Workbench path.
  The demo makes no claim that persistent learning or product-v1 Harness is
  complete.
- Focused tests, `pnpm run typecheck`, and `pnpm test` pass. The demo uses no
  production account or non-disposable target.

### Product-v1 release gate

- MCP HTTP authorization has positive and negative conformance tests for
  resource metadata, resource parameters, issuer, audience, scope, expiry,
  revocation, 401 challenge and no upstream token passthrough.
- All active revocation targets return correct acknowledgement state. Offline
  nodes and already-dispatched work remain visible as unresolved.
- The coding-agent Harness uses the same identity, token, proxy, policy and
  ledger path. Proposal activation requires operator approval; retrieval uses
  only approved, verified, bounded, same-workspace context.
- Threat model, migration, backup, key rotation, incident response, event
  retention and tenant isolation have reviewed acceptance evidence.
- Customer discovery establishes a specific pilot with a named owner, approver,
  incident owner, disposable environment and dated next step. This is separate
  from engineering completion.

## Explicit non-goals

- No production deployment or broad market claim by 2026-10-11.
- No full MCP OAuth, third-party HTTP login, SSO or tenant billing in the local
  Sunday demo.
- No OAuth identity over STDIO in the demo.
- No distributed fleet-wide acknowledgement or kill SLA in the demo.
- No claim that kill cancels an in-flight tool call or reverses its effect.
- No automatic policy learning, autonomous approval, or cross-workspace
  retrieval.
- No deletion of technical, safety, operations or Harness contracts.
- No Git history rewrite or push to `main`. Hosted GitHub Actions are not used.

## Open design questions for implementation

1. Which exact Streamable HTTP server API is supported by the pinned MCP SDK
   version, and can it share the proxy's current interception pipeline without
   copying policy or ledger logic?
2. What local test-issuer state is needed to bind a trusted Workbench run to one
   registered principal while keeping the opaque token only in memory?
3. What canonicalization and replay/idempotency scheme is appropriate for
   upstream resource URI and tool arguments?
4. What is the maximum acceptable clock skew for 60-second grants?
5. What is the product-v1 acknowledgement timeout for each connected proxy,
   and how is a disconnected proxy represented?
6. Which separate process identity and environment boundary can safely support
   STDIO agents without exposing credentials to the model or shell tool?

## Sources

- MCP Authorization, including HTTP versus STDIO requirements, resource
  parameter, protected-resource metadata and token handling:
  https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization
- RFC 9728, OAuth 2.0 Protected Resource Metadata: https://www.rfc-editor.org/rfc/rfc9728
- RFC 8414, OAuth 2.0 Authorization Server Metadata: https://www.rfc-editor.org/rfc/rfc8414
- Microsoft Entra Agent ID:
  https://learn.microsoft.com/en-us/entra/agent-id/what-is-microsoft-entra-agent-id
- AWS Bedrock AgentCore Identity:
  https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/identity.html
- Cloudflare MCP server portals:
  https://developers.cloudflare.com/cloudflare-one/access-controls/ai-controls/mcp-portals/

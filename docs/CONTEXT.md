# NOMO: context

With `DECISIONS.md` and `STANDARDS.md`, this is the authoritative context pack.
When code disagrees with the pack, the code is wrong. When the pack is wrong, a
reviewed work package updates it. Never diverge quietly.

## Product direction

NOMO is an Agent Identity & Fleet Control Plane for agents that use MCP tools.
The runtime binds each tool call to a trusted principal, workspace, registered
agent and run. All calls receive identity and scope checks and emit minimal
metadata events. Reads and low-risk calls use a bounded fast path. High-risk
writes receive the complete policy and durable-evidence path. Operators can
inspect decisions, approve or deny a held operation, revoke a run or agent, and
see unresolved dispatched work.

The coding-agent Harness is a required NOMO host integration and a product-v1
release gate. It is not a separate product pitch. Its runs use the same identity,
token, proxy, policy and ledger path as other managed agents. Learning proposals
remain inert until an operator approves the exact proposal digest. Later-session
retrieval is bounded, same-workspace and based only on approved, verified
records. Learning never changes policy, permissions or credentials.

This direction supersedes recovery-first product positioning in the current
strategy documents. Existing recovery, connector, policy, ledger, verification,
privacy and operational contracts remain technical capabilities unless a dated
decision explicitly changes them. Recovery is not the current primary wedge.

The market is active in identity, credential brokerage, MCP gateways and runtime
control. NOMO does not claim an empty market or a first/only position. The
capability map and spec record the competitive risk and a customer qualification
test. Demand is not validated by positive reactions to a product description.

## Current demo boundary

The target for Sunday 2026-10-11 is a local Workbench demo with one workspace,
one trusted run, one loopback inbound HTTP MCP endpoint and one disposable MCP
target. A local issuer provides an opaque token with a maximum 60-second
lifetime and an audience bound to the NOMO proxy. The token stays in server
memory and is not shown to the model, persisted, logged or forwarded upstream.

This test token is internal demo machinery, not standard MCP OAuth. The inbound
HTTP proxy is new work. The existing proxy accepts agents over STDIO and uses
HTTP as an upstream client. Product v1 must implement the current MCP HTTP
authorization profile, including Protected Resource Metadata, Authorization
Server discovery, PKCE, the `resource` parameter, audience and scope validation,
expiry, revocation and proper unauthorized responses. STDIO needs a separate
process and environment trust design. The demo is not production, full OAuth,
distributed fleet control, fleet-wide kill or revocation acknowledgement,
or proof of customer demand.

## Trust and enforcement model

- An operator account, a registered agent principal and an individual run are
  distinct identities. A web session never substitutes for an agent grant.
- The trusted Workbench or broker binds principal, workspace, agent and run.
  Caller-supplied `agentId` and `runId` are metadata, not authority.
- A run grant is scoped to the NOMO proxy, upstream resource and allowed tools.
  An upstream receives a separate least-privilege credential, never the NOMO
  proxy token.
- `Allow`, `Deny`, `Hold` and `observe-only` are explicit outcomes. Unknown
  identity, scope, policy, broker, revocation or ledger state fails closed.
  `observe-only` is opt-in and never an error fallback.
- For a held operation, approval binds the exact canonical operation digest,
  policy version and verified operator. Scope, expiry and revocation are checked
  again before dispatch.
- Append write-decision evidence before forwarding a high-risk write. If the
  append fails, do not dispatch. Append a result or explicit unknown outcome
  after the upstream response.
- A stop blocks later calls after acknowledgement. It does not cancel a request
  already dispatched and does not reverse side effects. A timeout remains
  unresolved until reconciled.
- Token, prompt and secret values never enter logs, events, ledger payloads,
  screenshots or durable workspace state.
- No autonomous test or demo touches a production account.

## Existing technical contracts

The proxy is an enforcement boundary, not an agent. It terminates a tool call,
validates and classifies it, evaluates policy, then forwards, holds or refuses
it. It does not invent business intent. The current proxy uses STDIO for its
agent-facing transport and supports HTTP upstream calls. The new HTTP ingress
must reuse its decision and evidence path instead of duplicating policy logic.

`packages/registry` is pure classification data and functions. It does not
import ledger, Node built-ins, network clients or connectors. A connector never
imports another connector. The proxy resolves connectors by id. The ledger
exposes append and read, never update. UI code consumes verified contracts and
events; it does not reimplement classification, policy, recovery or ledger
logic.

The ledger is append-only, hash-chained and signed per entry. A signature shows
that bytes came from a process holding the signing key. It does not prove a
human identity or create an independent trust boundary when recorder, signer
and verifier share one OS principal. The receipt location and its verification
rules are explicit claims, not a cryptographic moat. See `docs/OPERATIONS.md`.

The executable recovery contract and coverage remain in
`docs/RECOVERY-CONTRACT.md` and `docs/RECOVERY-COVERAGE.md`. An inverse changes
only the effect it names when the connector has enough verified state. A
point-in-time restore is not an inverse. Reversibility classes R0 to R3 belong
to a call under declared preconditions, not permanently to a tool. Unknown
blast radius is not zero. Existing recovery guarantees must not be generalized
to unsupported hosts or tools.

The existing browser operator session and the new agent credential system are
separate. Preserve current cookie, workspace, encryption and state-migration
contracts until a reviewed decision replaces them. Do not put an agent token in
browser storage or durable user settings.

## Repository and naming

The current source tree and workspace package names use `@void/*`. NOMO is the
approved product direction and `@nomo/*` is the public package target. Preserve
existing package imports, environment variables, CLI commands, encrypted state
and ledgers through an explicit, tested, versioned migration. NOMO environment
names win over VOID compatibility aliases when both are present, including an
explicitly empty NOMO value. No silent rename or state deletion.

The main code boundaries are:

```
packages/
  registry/   classification cases and pure evaluation
  policy/     rules, decisions, holds and approvals
  proxy/      MCP request relay, interception and transports
  ledger/     canonical records, signing, stores and verification
  connectors/ target facts, snapshots, mutation and recovery
  runtime/    managed execution and lifecycle
  workbench/  coding-agent host and Harness
  cli/        operator commands and TUI
  verifier/   standalone evidence verification
apps/control-plane/
  api/        current local and hosted API surfaces
  ui/         operator interface
```

Reuse the existing Workbench, proxy, policy, ledger, control-plane events and
disposable fixtures before creating new abstractions. Do not add Neon, Drizzle,
Tailwind or another dependency to the local demo unless a verified requirement
needs it. Neon Postgres and Drizzle are product-v1 options for durable hosted
control-plane state, subject to schema, migration, isolation and operations
review. The signed ledger remains separately verifiable.

The public proxy spine is Apache-2.0 open core. Hosted control-plane features
have a separate service and licensing boundary. Verify the package and license
map before publishing a claim about which features are open or hosted.

## Product source of truth

- `docs/CONTEXT.md`, `docs/DECISIONS.md` and `docs/STANDARDS.md` define
  repository-wide authority and contracts.
- `docs/superpowers/specs/2026-10-08-nomo-agent-identity-fleet-capability-map.md`
  defines module boundaries and build order.
- `docs/superpowers/specs/2026-10-08-nomo-agent-identity-fleet-mvp-spec.md`
  defines the product and security acceptance criteria.
- `docs/superpowers/plans/2026-10-08-nomo-agent-identity-fleet-mvp-and-roadmap.md`
  defines the implementation tasks, checkpoints and full-product gates.

A new implementation must update its spec and plan before code silently changes
a contract. Preserve existing technical documentation that remains true. Remove
conflicting strategy and sales documents from the active branch only after
valid facts are migrated and the documentation truth test is updated. Do not
rewrite Git history.

# NOMO Agent Identity and Fleet Control Plane Implementation Plan

> **For agentic workers:** Use the existing approved worktrees and review gates.
> Do not create a third subagent. Implement one task at a time, test first, and
> pause at the checkpoints below.

**Goal:** Deliver a safe, local Agent Identity & Fleet Control Plane demo by
Sunday 2026-10-11, then complete the product-v1 identity, fleet, and guarded
Harness capabilities before any public production release.

**Architecture:** Keep the current Workbench, proxy, policy, ledger and control
plane. Add a one-process local identity issuer and inbound Streamable HTTP MCP
server for the demo. The HTTP server reuses the existing proxy decision and
ledger path. Product v1 replaces the local test issuer with standards-compliant
MCP OAuth and durable fleet state. The Harness remains a required integration
on that same enforcement path.

**Tech Stack:** Node.js 24 or newer, pnpm, TypeScript, existing MCP SDK, existing
policy and ledger packages, React 19 and Vite 7 for the current UI. Tailwind CSS
v4 is a target to verify against the existing design system. Neon Postgres and
Drizzle are product-v1 hosted-state options, not dependencies for the local
Sunday demo.

**Spec:** `docs/superpowers/specs/2026-10-08-nomo-agent-identity-fleet-mvp-spec.md`

## Global Constraints

- Treat the user-approved capability map and MVP spec as the design boundary.
- The local demo is not full MCP OAuth, production deployment, distributed fleet
  control, customer validation or a public beta.
- Every call passes trusted identity and scope checks. Reads and low-risk calls
  use a fast path; high-risk writes receive the full policy and durable-evidence
  path.
- The demo token is opaque, local, audience-bound to the NOMO proxy, held only
  in server memory, and expires within 60 seconds. Never log, persist, prompt,
  screenshot or forward it upstream.
- Caller-supplied agent or run IDs are not identity. The trusted Workbench host
  binds the principal, workspace, agent and run.
- Fail closed on missing identity, invalid scope, policy, broker, revocation or
  ledger errors. `observe-only` is explicit, never a fallback.
- Append write-decision evidence before dispatch. A stop does not cancel an
  already-dispatched call or reverse side effects.
- Keep `@void/*` package and state compatibility until a tested, explicit
  NOMO-first migration is approved. `@nomo/*` is the target public namespace.
  Do not copy uncommitted files from another worktree.
- Preserve the current recovery contracts and security guarantees as technical
  capabilities. They are not the primary product pitch.
- Use `node:test`. Add or extend a failing test before implementation. Do not
  skip, weaken or delete tests to get a green run.
- Use fixtures or disposable targets only. Never run autonomous tests against
  production.
- Keep secrets out of source, files, logs, test output and screenshots.
- Work only in `.worktrees/nomo-agent-identity-fleet` on
  `docs/nomo-agent-identity-fleet-2026-10-08`. Do not stage the dirty root
  checkout, `feat/agent-harness`, or the compatibility worktree.
- Keep at most two active subagents, reuse the two existing read-only reviewers,
  and do not spawn more.
- Commit reviewed increments and push them to the existing GitLab feature branch.
  Push the finished branch to GitHub only after verification. Do not push to
  `main`, open a PR, or trigger GitHub Actions without explicit approval.
- Before code changes, record the current failing or passing baseline. Required
  project checks are `pnpm run typecheck`, `pnpm test`, and `pnpm run build`.

## Current Baseline

- The capability map is committed as `b5c5e1c` on the isolated feature branch.
- The map is already pushed to the matching GitLab feature ref.
- The proxy currently accepts agent requests over STDIO. Its HTTP transport is
  upstream-facing, not an inbound HTTP MCP server.
- Workbench currently accepts a static bearer token. It has no per-run local
  issuer or token lifecycle.
- Existing policy, ledger, feed, Workbench, control-plane UI and e2e fixtures
  should be reused before creating abstractions.
- A separate compatibility worktree has partial NOMO-first changes and
  uncommitted files. Review it read-only; do not copy or alter it in this plan.
- A separate Agent Harness workstream has uncommitted specifications and code.
  Preserve it. Integrate only reviewed requirements and code after its owner
  confirms a clean, testable handoff.

## Dependency Order

```text
source-of-truth and branch audit
    -> trusted local run identity and opaque test issuer
    -> inbound HTTP MCP endpoint and token validation
    -> existing policy and ledger decision path
    -> Workbench and Harness run through the same path
    -> event feed and one-process stop control
    -> demo and adversarial review
    -> standards-compliant OAuth and durable hosted identity
    -> distributed fleet revocation and completed safe Harness
    -> multi-tenant product release gates
```

## MVP Schedule: 2026-10-08 to 2026-10-11

### Phase 0: Establish the active product contract

#### Task 1: Update the authoritative context and decision record

**Files:**
- Modify: `docs/CONTEXT.md`
- Modify: `docs/DECISIONS.md`
- Modify: `scripts/src/doc-truth.test.mjs`

- [x] Add a dated decision that makes Agent Identity & Fleet Control Plane the
      primary product and the coding-agent Harness a required workstream.
- [x] State the local 60-second demo boundary and explicitly defer full OAuth,
      distributed kill, production, and market claims.
- [x] Preserve recovery, verification, privacy, compatibility and security
      contracts that remain true.
- [x] Update the latest-decision assertion in the documentation truth test.

**Acceptance:** Context and decisions agree with the approved capability map and
spec. The new plan and spec resolve as live paths. Old decision history is not
rewritten.

**Verify:** `node --test scripts/src/doc-truth.test.mjs`

**Dependencies:** None.

#### Task 2: Freeze package and state compatibility rules

**Files:**
- Review existing manifests, environment lookups, state paths and install
  scripts without modifying the other worktrees.
- Later implementation may touch package manifests, CLI migration code, state
  path helpers and their existing tests.

- [ ] Record canonical `NOMO_*` names and `VOID_*` fallback behavior. NOMO wins
      when both are present, including an explicitly empty NOMO value.
- [ ] Define explicit, non-destructive state migration. Existing `.void` data
      stays readable if `.nomo` is absent. Migration copies to a temporary
      location, validates encrypted state and signed ledgers, and installs
      atomically. It never deletes the source.
- [ ] Decide package rename order. Public product-v1 names target `@nomo/*`;
      existing `@void/*` imports, data, commands and ledgers remain compatible
      through a versioned migration.
- [ ] Review the isolated compatibility branch and dirty state. Do not copy
      uncommitted files or rewrite its history.

**Acceptance:** One authoritative compatibility matrix covers env keys, package
imports, CLI commands, state directories and ledger data. No code path silently
moves or deletes user state.

**Verify:** Tests cover NOMO precedence, VOID fallback, empty values, no input
mutation, migration validation, atomic install and source preservation. Use
`node:test` and the focused package tests before `pnpm test`.

**Dependencies:** Task 1.

### Phase 1: Local identity and transport

#### Task 3: Add trusted local run identity and test issuer

**Files:**
- Create: `packages/workbench/src/agent-identity.ts`
- Create: `packages/workbench/src/agent-identity.test.ts`
- Modify: `packages/workbench/src/agents.ts`
- Modify: `packages/workbench/src/index.ts`

- [ ] Write tests proving caller-provided IDs cannot create identity, the trusted
      Workbench binds one workspace, principal, agent and run, and each token is
      random, opaque and short-lived.
- [ ] Implement an in-memory issuer and validator. Bind issuer, proxy audience,
      run, workspace, agent, allowed upstream, canonical tool scope, expiry and
      revocation in server-side state.
- [ ] Store only a token digest in the issuer state. Return the raw token to the
      trusted Workbench client once; never expose it to a model or public config.
- [ ] Reject expired, revoked, wrong-audience, wrong-run, wrong-workspace and
      wrong-scope requests before proxy dispatch.
- [ ] Set an injectable clock for expiry and clock-skew tests. Do not rely on
      sleeps.

**Acceptance:** A grant expires no later than 60 seconds. Invalid grants fail
closed. Secret-redaction tests prove the raw token is absent from errors,
telemetry and ledger records.

**Verify:** Run the focused `agent-identity.test.ts` and `agents.test.ts`, then
`pnpm run typecheck`.

**Dependencies:** Task 2.

#### Task 4: Add the inbound Streamable HTTP MCP server

**Files:**
- Create: `packages/proxy/src/transport/http-server.ts`
- Create: `packages/proxy/src/transport/http-server.test.ts`
- Modify: `packages/proxy/src/bin.ts`
- Modify: `packages/proxy/src/index.ts`

- [x] First verify the pinned MCP SDK server-transport API and the current MCP
      HTTP specification. Do not hand-roll protocol framing or reuse the
      upstream HTTP client as a server.
- [x] Implement one loopback-only inbound `/mcp` endpoint for the local demo.
- [x] Validate the `Authorization` bearer with the in-memory issuer before
      accepting `tools/list` or `tools/call`.
- [x] Return a standards-shaped unauthorized response for invalid local grants,
      without claiming OAuth compliance.
- [x] Pass accepted requests into the existing proxy interception path. Keep
      upstream auth separate; do not forward the NOMO bearer.
- [x] Cover origin/host checks, unsupported methods, malformed protocol input,
      request size limits, expired grants, wrong audience and clean shutdown.

**Implementation note.** The inbound endpoint uses `@modelcontextprotocol/server@2.3.1` and `@modelcontextprotocol/node@2.1.1` for MCP `2026-07-28`. The existing `@modelcontextprotocol/sdk@1.30.0` remains on the upstream client path. The local bridge forwards request cancellation through the existing proxy path.

**Acceptance:** A valid local MCP client can connect through the endpoint to the
disposable target. Invalid auth and malformed requests never reach upstream.
The listener is not exposed beyond loopback in the demo.

**Verify:** Run `node --test packages/proxy/src/transport/http-server.test.ts
packages/proxy/src/transport/http.test.ts`, then `pnpm run typecheck`.

**Dependencies:** Task 3.

### Phase 2: Enforce and observe the write path

#### Task 5: Connect identity, policy and ledger at dispatch

**Files:**
- Modify: `packages/proxy/src/bin.ts`
- Modify: `packages/proxy/src/forward/tools.ts`
- Modify: `packages/proxy/src/transport/http-server.ts`
- Modify: `packages/workbench/src/index.ts`
- Extend: focused proxy, HTTP bridge and Workbench tests.

- [x] Add focused tests for invalid identity, insufficient tool scope, low-risk
      read and write fast paths, high-risk `Allow`, `Deny`, `Hold`, revoked grant
      during hold, upstream failure and interrupted-call recovery. Expiry during
      hold remains unverified.
- [x] Apply cheap identity and scope checks to every inbound call. Use a bounded
      fast path only for a trusted per-invocation assessment. Require full policy
      for high-risk or unknown operations.
- [ ] Bind `Hold` approval to the canonical operation digest, policy version and
      verified local operator. The existing approval and grant-recheck flow is
      tested, but this exact binding remains open.
- [x] Append signed dispatch evidence before forwarding writes. A signing failure
      blocks dispatch. Record correlated success, failure, not-dispatched or
      unknown outcomes; recovery preserves identity and profile metadata.
- [x] Keep `observe-only` explicit and visible. It must not bypass invalid
      authentication and must never be selected after an error.
- [x] Keep raw credentials, prompts and unnecessary tool arguments out of
      event and ledger payloads.

**Acceptance:** Tests prove that a denied or held write does not reach upstream,
that an approved write has a prior ledger record, and that uncertain outcomes
are not reported as cancelled, reverted or successful.

**Verify:** Focused proxy, policy and ledger tests; then `pnpm run typecheck`.

**Dependencies:** Tasks 3 and 4.

#### Checkpoint: Identity and guarded dispatch

- [x] Wrong, expired and revoked grants fail closed.
- [x] Valid MCP requests use the existing policy and ledger path.
- [x] `Allow`, `Deny`, `Hold`, fast path and explicit observe mode have focused
      tests. Expiry during hold remains unverified.
- [x] No NOMO token reaches the upstream request, the response, the proxy error
      log or durable storage. Prompts and event payloads are not covered by this
      test and stay an open claim.
- [x] `pnpm run typecheck` passes.
- [ ] Read-only security reviewer checks trust boundaries before UI work starts.

**Implementation note (2026-10-10):** Fast-path profiles are trusted local
configuration, matched by stable profile id, upstream id, tool name and exact
input-schema digest. A matching profile assesses each invocation against a
frozen copy of its arguments. A missing or mismatched profile, invalid result or
classifier error falls through to full policy. Fast reads emit signed metadata;
fast writes emit signed pre-dispatch evidence and a correlated terminal outcome.
The exact `Hold` binding and grant-expiry-during-hold checks remain open.

### Phase 3: Harness, events and local stop

#### Task 6: Run Workbench Harness through the identity path

**Files:**
- Modify: `packages/workbench/src/mcp.ts`
- Modify: `packages/workbench/package.json`
- Modify: `packages/workbench/src/index.ts`
- Modify: `packages/workbench/src/agents.ts`
- Extend: `packages/workbench/src/harness-wiring.test.ts`
- Extend: `packages/workbench/src/workbench.test.ts`

- [x] Update the Workbench client to MCP `2026-07-28`, including required
      per-request metadata headers and connectionless request flow. Depend
      directly on `@void/proxy` for the inbound local server.
- [x] Replace static-token-only wiring for the local demo with an in-memory
      token provider bound to the Workbench run.
- [x] Prove the provider does not place bearer text in model prompts, tool
      descriptions, saved settings, debug output or recovery context.
- [x] Run one deterministic, constrained Harness task through the inbound proxy,
      policy and ledger.
- [x] Keep learning activation disabled in the demo. Do not claim this completes
      proposal approval or subsequent-session retrieval.
- [x] Preserve existing provider, workspace, permission-mode and recovery
      behavior unless the feature spec explicitly changes it.

**Acceptance:** The local Harness run has server-bound identity, uses the same
proxy and evidence path, and cannot choose a caller-supplied agent identity or
secret.

**Verify:** Run focused Workbench tests and `pnpm run typecheck`.

**Dependencies:** Tasks 3, 4 and 5.

#### Task 7: Add one-process fleet view and kill acknowledgement

**Files:**
- Modify: `apps/control-plane/api/server.ts`
- Modify: `apps/control-plane/ui/src/overview-state.ts`
- Extend: `apps/control-plane/ui/src/overview-state.test.ts`
- Modify: `apps/control-plane/ui/src/pages.tsx`
- Extend: `apps/control-plane/ui/src/ui.test.ts`

- [x] Emit metadata-only events for stop request and stop acknowledgement; agent
      start, run start, tool decision, approval and dispatch result emissions are
      wired only as far as the store's vocabulary; emission sites for those kinds
      are noted as the remaining subset.
- [ ] Show one registered agent and its current run, state, latest events and
      unresolved in-flight calls. Do not render tokens or prompt contents.
- [x] Add run stop control with visible acknowledgement state; the stop path with
      its "this process only" scope note is the delivered kill control, and no
      separate local process kill action exists. Do not display success before the
      proxy confirms it.
- [ ] State that the demo kill applies to this process only. Show an already
      dispatched call as in flight or unknown until its result is confirmed.
- [x] Reuse the existing event feed and UI state. Do not add Neon, Drizzle,
      polling infrastructure or a new UI framework for the local demo. Existing
      feed and UI state reused; the fleet store is an in-process ring buffer, no
      polling infrastructure added.

**Acceptance:** One operator can see and stop the local demo run. The stop blocks
subsequent calls after acknowledgement, while an in-flight call remains visible.

**Verify:** Run `node --test apps/control-plane/ui/src/overview-state.test.ts
apps/control-plane/ui/src/ui.test.ts apps/control-plane/api/server.test.ts`, then
`pnpm run typecheck`.

**Dependencies:** Tasks 5 and 6.

#### Task 8: Rehearse and freeze the local demo

**Files:**
- Create: `docs/NOMO-LOCAL-IDENTITY-DEMO.md`
- Extend: `scripts/src/e2e.mjs` only if a deterministic end-to-end check is
  missing.
- Reuse: `fixtures/e2e-server.mjs` and `fixtures/e2e-policy.yaml`.

- [ ] Document setup, one low-risk fast-path call, one allowed high-risk write,
      one denied write, one held write, one explicit observe-only run, token
      expiry, kill acknowledgement and unresolved in-flight behavior.
- [ ] Run only against the disposable local MCP fixture. Record the exact
      verified output, not screenshots with live secrets.
- [ ] Run focused tests, `pnpm run check`, `pnpm run build`, and the documentation
      truth test.
- [ ] Review all Git changes and stage only this feature's files.
- [ ] Obtain the two existing read-only reviews: security/spec compliance and
      product/document contradiction review. Do not create more subagents.
- [ ] Commit and push the verified increment to the GitLab and GitHub feature
      branches. Do not open a PR.

**Acceptance:** Another engineer can reproduce the local demo from a clean
checkout using the runbook. All Sunday exit criteria in the spec pass. No
production account, hidden token, or unsupported fleet claim is used.

**Verify:** `pnpm run check`, `pnpm run build`,
`node --test scripts/src/doc-truth.test.mjs`, and the documented local demo.

**Dependencies:** Tasks 1 through 7.

#### Checkpoint: Sunday demo

- [ ] The identity, policy, evidence, Harness, event and stop paths work in one
      local process.
- [ ] The full test suite, typecheck, build and docs truth test pass.
- [ ] Two read-only reviews are resolved or explicitly listed as blockers.
- [ ] GitLab and GitHub feature refs point at the verified commit. The GitHub
      feature ref is already moving with the user instruction of 2026-10-10, so
      it no longer waits for the final review; the GitLab push is still blocked
      on credentials.
- [ ] Customer demand remains unvalidated unless the qualification evidence is
      actually collected.

## Product Roadmap After the Demo

No dates are assigned beyond the local demo until capacity and customer evidence
are known. The order and release gates are fixed; dates are planning estimates,
not commitments.

### Milestone A: Product-v1 identity and OAuth

**Purpose:** Replace the local test issuer with real, interoperable identity for
remote HTTP MCP clients.

- Implement the MCP HTTP authorization profile using Protected Resource
  Metadata, Authorization Server discovery, PKCE, the `resource` parameter,
  audience and scope validation, expiry and revocation checks, and a proper 401
  challenge. Test against the official MCP authorization specification and
  current SDK.
- Add a trusted agent and run registry. Separate operator user identity,
  agent principal, host, workspace and run. Caller metadata never authorizes.
- Issue short-lived credentials bound to the NOMO proxy, never to an upstream.
  Keep upstream credentials in a separate least-privilege broker. Add rotation,
  replay/idempotency protection, revocation and key management.
- Make `@nomo/*` package names canonical for public product-v1 modules while
  preserving tested `@void/*`, CLI, environment and data compatibility through a
  versioned migration. No silent directory rename or data deletion.
- Keep STDIO authentication as a separate host/process trust design. Do not
  claim OAuth support for STDIO.

**Exit gate:** Positive and negative conformance tests pass for issuer,
audience, resource, scope, PKCE, expiry, revoked and wrong-resource tokens,
unauthorized responses and no upstream token passthrough. Migration preserves
existing state and command behavior.

### Milestone B: Hosted control plane and live fleet state

**Purpose:** Manage several agents and runs without confusing local stop with
fleet revocation.

- Store control-plane identity, policy versions, run state, event cursors and
  acknowledgement state in a migration-managed durable store. Neon Postgres and
  Drizzle are candidates; choose only after schema, RLS/isolation, backup and
  operational requirements are reviewed.
- Keep the signed append-only ledger independently verifiable. Define how ledger
  entries reference control-plane rows without making the database the trust
  root.
- Add agent registration, enrollment, credential rotation, status, ownership,
  workspace membership and lifecycle events.
- Add a live feed with explicit `active`, `revoking`, `revoked`, `disconnected`
  and `unknown` states. A fleet revoke is successful only after every active
  enforcement node acknowledges the same generation. Disconnected nodes remain
  unresolved and cannot be reported as safe.
- Add run, agent and fleet-level stop/revoke separately. Record which dispatched
  calls may still complete. Never promise distributed cancellation or undo.
- Add policy rollout preview and rollback of policy versions. Policy approval
  remains distinct from the user's web session.

**Exit gate:** Multi-agent tests prove tenant and workspace isolation, stale
credential rejection, complete acknowledgement accounting, disconnected-node
visibility and correct unresolved-call reporting. The event stream can recover
from reconnect without losing or duplicating security-critical transitions.

### Milestone C: Complete the NOMO coding-agent Harness

**Purpose:** Finish the existing Workbench as a safe managed host, not a second
product.

1. **Compatibility and state:** Complete NOMO-first environment aliases,
   explicit `.void` to `.nomo` migration, package/CLI compatibility and rename
   checks. Preserve old encrypted state and signed ledgers.
2. **Deterministic mining:** Mine candidate Harness entries only from eligible
   verified runs. Keep refusals and existing safety rules ahead of learned
   suggestions. Make extraction deterministic, provenance-bound and read-only.
3. **Review gate:** Do no model refinement call before the deterministic gate
   passes. Use explicit cooldown, in-flight, settled-turn and version checks.
   Malformed, secret-bearing, stale or unsupported proposals are rejected.
4. **Approval lifecycle:** Store a proposal as inert. Record proposal,
   approval, rejection, activation, tombstone and supersession in the verified
   chain. Approval binds the exact proposal digest and current provenance. A
   caller-provided name or identity string is not human approval.
5. **Subsequent-session retrieval:** Rebuild only approved, verified entries
   from the same workspace after restart. Rank deterministically, enforce strict
   token and entry bounds, expire session-scoped data, and never inject memory
   into the session that produced it.
6. **No policy mutation:** Retrieved entries may guide bounded context only.
   They never change `decide`, permission modes, tool catalogs, credentials or
   approvals. The operator can inspect and remove an entry without rewriting
   ledger history.
7. **Honest evaluation:** Report case count and confidence interval. A metric
   named `first_pass_rate` requires observed correction or retry data; otherwise
   show it as unavailable. Scores do not change policy or gates.
8. **Regression and isolation tests:** Cover restart reconstruction, exact-digest
   invalidation, stale provenance, secret rejection, workspace isolation,
   tombstones, supersession, bounded retrieval and unchanged policy decisions.

**Exit gate:** The complete coding-agent flow uses the same identity, token,
proxy, policy and ledger as other managed agents. An operator can inspect,
approve or reject a proposal; only approved verified context is retrieved in a
later session. No automatic policy or permission mutation is possible. A
read-only reviewer verifies privacy, provenance, compatibility and failure
handling.

### Milestone D: Controlled design-partner beta

**Purpose:** Test whether the product solves an expensive, owned write-path
problem before investing in broad integrations.

- Recruit design partners only against a named environment and real write
  workflow. Record the incident or blocked write, principal, approver, incident
  owner, integration, pilot date and a dated next step.
- Start in explicit observe mode with redacted metadata, then enable policy
  enforcement only after the operator reviews observed classifications.
- Measure fast-path and high-risk latency, false holds, missed scope, token
  expiry, revocation acknowledgement, operator review time and unresolved
  outcomes. Do not set a performance claim before measurements.
- Require at least one pilot to have a named owner and a committed, preferably
  paid, next step before calling product demand validated.
- Keep integrations narrow. Prioritize the exact MCP hosts and write surfaces
  demanded by qualified pilots, not a broad connector count.

**Exit gate:** Named pilot owners can reproduce the risk, approve the policy and
interpret the evidence. At least one qualified pilot has a concrete next step.
The product passes an external security review for its supported scope.

### Milestone E: General availability and full product

- **Tenant and access security:** Tenant isolation, workspace boundaries,
  operator RBAC, SSO, audited administration, credential separation, key
  management and bounded session lifetimes.
- **Production operations:** SLOs based on beta measurements, regional health,
  rate limits, quota enforcement, backups, restore drills, incident response,
  change control, rollout/rollback, support and vulnerability handling.
- **Evidence:** Independent ledger verification, export, retention controls,
  schema migration, key rotation, tamper detection and documented limits of
  each signature and trust boundary.
- **Fleet:** Durable inventory, event replay, policy version rollout, per-run,
  per-agent and fleet revoke, honest acknowledgement state, and an escalation
  path for offline hosts.
- **Integrations:** Supported MCP hosts, coding agents, connectors and secret
  brokers selected from qualified customer demand. Each integration has
  conformance tests for identity propagation, tool scope, policy, ledger,
  revocation and failure behavior.
- **Harness:** Completed operator-gated learning, verified retrieval, clear
  disable/delete controls and privacy-preserving evaluation.
- **Commercial readiness:** Pricing, packaging, terms, data-processing terms,
  support boundaries and an accurate comparison with existing identity,
  gateway and security products.

**GA exit gate:** No critical or high severity security issue remains open;
security and tenant-boundary tests pass; backup and revocation drills pass; each
supported host has a signed-off conformance suite; product claims match observed
behavior; and qualified customers have accepted the scope and support model.

## Documentation Retirement

After the new context, spec, plan and README pass review, remove the conflicting
old product direction from the active feature branch. First migrate any still
valid facts into the new capability map, spec, roadmap or Obsidian project vault.
The retirement set is:

- `docs/BUILD-PLAN.md` and `docs/BUILD-PLAN.pdf`
- `docs/EXECUTION-PLAN.md` and `docs/EXECUTION-PLAN.pdf`
- `docs/PLAN-STATUS.md`, `docs/PLAN-GAPS.md`, `docs/STATUS-INDEX.md` and
  `docs/OPEN-WORK-AUDIT.md`
- `docs/ROADMAP-2026-Q4.md`, `docs/VOID-FUTURE-DIRECTION.md`,
  `docs/DEEP-RESEARCH-DIRECTION-2026-10-04.md`
- `docs/COMPETITIVE-WEDGE.md`, `docs/REVERSE-WEDGE.md`
- `docs/GO-TO-MARKET-10K-MRR.md`, `docs/GO-TO-MARKET-10K-MRR-2026.md`,
  `docs/10K-MRR-EXECUTION-BOARD.md`, `docs/10K-MRR-REALITY-CHECK.md` and
  `docs/10K-MRR-TECHNICAL-BACKLOG.md`
- `docs/VOID-MARKETING-MONETIZATION-RESEARCH-2026.md`,
  `docs/VOID-SOCIAL-CONTENT-PACK-2026.md`, `docs/SLACK-OPERATING-PACK.md` and
  `docs/PUBLIC-DEMO.md`
- The complete `docs/strategy-2026-09-30/` directory

Keep `docs/DECISIONS.md` as history and keep current technical contracts,
threat models, operations guides, recovery specifications, standards, release
records, Harness implementation work and customer evidence that still apply.
Update the documentation truth test and its historical-path inventory in the
same cleanup commit. Do not delete files from the dirty root checkout or
unrelated worktrees. Do not rewrite Git history. The deletion commit removes
these documents from the active branch and both remotes; prior Git history stays
intact under the repository's no-history-rewrite contract.

## Risks and Mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| The local 60-second token is mistaken for OAuth | False security claim | Label it internal and local in code, UI and docs; no public endpoint |
| Inbound HTTP transport bypasses current proxy gates | Ungoverned writes | Reuse one decision pipeline; tests prove every request enters it |
| Caller IDs are trusted | Spoofed attribution | Bind identity in trusted Workbench/broker state; ignore body identity |
| Kill is described as cancellation | In-flight side effect is hidden | Expose process scope, acknowledgement and unresolved calls |
| Token leaks into prompts, logs or upstream | Credential compromise | Opaque token, in-memory provider, redaction tests and no forwarding |
| Harness learning activates unreviewed content | Persistent unsafe behavior | Proposals inert by default; exact digest approval and verified retrieval |
| Package rename breaks current users | Lost state or integrations | Stage @nomo canonicalization with @void aliases and explicit migration |
| Scope exceeds the Sunday window | No working demo | Keep one process, workspace and disposable target; never weaken safety gates |
| Market category is crowded | Weak differentiation | Validate one write and four owners; no unsupported first/only claims |
| Branch push triggers automation | Unapproved CI or spend | Verify ref and workflow triggers; no PR or `main` push |

## Parallelization Opportunities

After Task 2 freezes the interfaces, two independent review/build streams may
work in separate approved worktrees: one on local identity and HTTP ingress, one
on Workbench Harness and UI event state. They must not edit the same files or
merge unreviewed state. The proxy policy/ledger integration is sequential after
both interfaces are stable. Never exceed two active subagents; the two existing
reviewers are reserved for read-only review, not new implementation branches.

## Verification

Before any completion claim, capture and review the actual output of:

```sh
pnpm run typecheck
pnpm test
pnpm run build
node --test scripts/src/doc-truth.test.mjs
```

Then run the local demo exactly as documented against disposable fixtures. Verify
the token redaction, invalid-grant refusal, pre-dispatch ledger append, hold
approval digest, low-risk fast path, explicit observe mode, stop acknowledgement
and unresolved in-flight display. Inspect the Git diff and cached diff, verify
only the authorized feature branch changed, push only to the authorized GitLab
feature ref, and leave GitHub untouched until final review.

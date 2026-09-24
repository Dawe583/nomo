# VOID remaining work

## Current bounded parity update

This audit is historical. [Current scope and verification](UPGRADE-VERIFICATION.md) supersedes the missing-feature claims below, not the external certification gates.
The 2026-09-24 Apple 1.0.1 inventory is in `RELEASE-1.0.1-MATRIX.md`.
G-22/G-23 below describe the old distribution proposal. The native iOS
target is now a paired-Mac SwiftUI client, not a local Swift recovery core.
The current `xcodebuild -version` fails under active Command Line Tools;
that does not establish the user's account, certificates or hardware state.


- G-01: managed cloud documents have signed operation/job events, artifacts and state in one SQL transaction. This is not a transaction host for arbitrary external tools. Physical network partition testing remains unverified.
- G-03: local API, cloud routes and MCP expose retained recovery jobs for an exact run or explicit operation list. Dependency/time/checkpoint selectors, leases and fencing remain open.
- G-04: adapters already observe resource keys and revisions. General read/write provenance and dependency closure remain open.
- G-07: managed filesystem and Git recovery exist. Noncooperative writers, full per-hunk enforcement and native cross-platform evidence remain separate work.
- G-20: `scripts/src/verify-ledger-standalone.mjs` uses Node built-ins only. Independently published and audited distribution remains open.
- Section 6: deterministic compaction, bounded local profiles, the twenty-item local queue and signed run/list recovery exist. Hooks, binary input, extra named permission modes, dependency-aware rewind and measured tokenizer accounting remain open.


Audit date: 2026-09-16. Baseline: local `main` at `4c82c37`.
Method: status documents were treated as claims only. Each item below names
the code path that was read and, where cheap, the command that was run.
Sibling lanes own TUI (`packages/cli/src/tui/**`) and GUI
(`apps/control-plane/ui/**`) depth; those two areas appear here at summary
level only. The sibling R05 lane owns managed Git commit recovery on branch
`upgrade/git-commit`; this file does not duplicate that work, see
`tmp/parity/root-lane.md`. No production account, live provider or secret
was touched. Items are ordered by plan priority, not by ease.
`[EXT]` marks work blocked on an external resource.

## 1. Reverse critical path

### G-01 R01: cloud transactional journal and full persistence fault matrix

Plan: `docs/REVERSE-TOOL-UPGRADE-PLAN.md` WP-R01.
Missing: cloud document integration uses the shared runtime in one SQL
transaction, but there is no cloud transactional journal and the fault
matrix stops at call level failures.
Evidence: `docs/UPGRADE-CHECKPOINT.md` states the twenty new tests are
"persistence-call failures, not physical disk failure, network partition
or PostgreSQL client process death".
Minimum change: add a cloud journal with the same lifecycle states as the
local journal, then extend the fault tests to disk exhaustion, partition
and client process kill. Dependency: R02 stable. Size: XL.

### G-02 R04: PostgreSQL certification tail

Plan: `docs/REVERSE-TOOL-UPGRADE-PLAN.md` WP-R04.
Partial evidence now exists: the managed adapter has explicit v1→v2
metadata migration, configured ON DELETE CASCADE capture/restore, and
server-bound tenant RLS checks. The isolated verifier also covers terminated
PostgreSQL backends and client SIGKILL after forward and recovery COMMIT.
Remaining: real-server cascade/tenant/migration certification, an in-flight
client-kill case, and physical network-partition behavior.
Evidence: `packages/connectors/src/postgres/managed.test.ts` is PGlite
fixture coverage; `scripts/src/verify-managed-postgres.mjs` is the isolated
Neon verifier and emits `networkPartitionTest: false`.
Minimum change: keep fixture evidence separate from certification, add one
executable real-server gate per remaining case, and document the explicit
migration command path. Dependency: R02, R03.
Size: XL. `[EXT]` needs a disposable isolated PostgreSQL target and a
reproducible network-fault harness.

### G-03 R06: planner selection, leases, fencing, remote job surfaces

Plan: `docs/REVERSE-TOOL-UPGRADE-PLAN.md` WP-R06.
Missing: dependency and time selection, durable leases and fencing, MCP
and cloud job surfaces. The stored plan covers one run or an explicit
operation list in reverse ledger order only.
Evidence: `packages/runtime/src/recovery/plan.ts` plus `run.ts` exist, but
a tree wide search for lease or fencing terms returns zero hits, and
`docs/RECOVERY-CONTRACT.md` confirms "no cross-agent dependency closure"
and "no time or checkpoint selection".
Minimum change: resource aware selection, single active worker lease with
fencing, then MCP and cloud surfaces on top. Dependency: R02, R03, one
R04 or R05 adapter. Size: XL.

### G-04 R07: runtime provenance and dependency aware recovery

Plan: `docs/REVERSE-TOOL-UPGRADE-PLAN.md` WP-R07.
Missing: everything beyond the legacy taint helpers. The runtime records
no resource read or write sets, no revisions, no dependency certainty, and
the planner uses no graph.
Evidence: `packages/ledger/src/taint/query.test.ts` passes 4/4, so the
legacy helpers work, but no file under `packages/runtime/src` references
taint, and `docs/REVERSE-UPGRADE-PROGRESS.md` marks R07 as retained legacy
only. `node --test packages/ledger/src/taint/query.test.ts` passes.
Minimum change: record resource keys with read and write sets and observed
revisions at dispatch, then compute descendant closure in the planner.
Dependency: R01, R02, integration with R06. Size: XL.

### G-05 R11: staged hold, barriers, cascading cancel

Plan: `docs/REVERSE-TOOL-UPGRADE-PLAN.md` WP-R11.
Missing: the whole package. No staged results, no dependency barrier, no
cascading cancel, no restart semantics for staged work.
Evidence: a tree wide search for "provisional" returns zero hits and
"staged" appears only in unrelated tests; the blocking hold is the only
implemented hold shape (`packages/policy/src/hold.ts`).
Minimum change: staged graph behind an explicit opt in, keeping the
blocking hold as default. Dependency: R06, R07, R10. Size: XL.

### G-06 R00: machine readable certification and claim alignment

Plan: `docs/REVERSE-TOOL-UPGRADE-PLAN.md` WP-R00.
Missing: a versioned machine readable capability profile per provider and
an audit pass that maps each public site claim to a passing gate.
Evidence: `docs/ADAPTER-CONFORMANCE.md` states the report carries
`certification: false` and `sharedRuntimeChecksOnly: true`; the site still
shows illustrations (latency numbers, tool counts) that the reverse plan
section 2 already flags as non evidence.
Minimum change: publish the capability profile schema, require it in the
release gate, and annotate or remove unproven site claims. Dependency:
R12 profiles. Size: L.

## 2. Coding agent adapters

### G-07 R05: Git commit, revert, remote, Windows

Plan: `docs/REVERSE-TOOL-UPGRADE-PLAN.md` WP-R05.
Missing: managed commit and revert, remote recovery, Windows Git, Windows
filesystem rename and mode restoration, and a noncooperative writer
boundary.
Evidence: `docs/MANAGED-GIT.md` limits section lists no commit, branch,
remote, reset or checkout support; `docs/ADAPTER-CONFORMANCE.md` records
Windows rename as refused and Windows Git as POSIX exclusion.
Minimum change: append only revert commit or recovery PR, never reset or
force push; Windows rename only with separate evidence. Dependency: R02,
R03. Size: L to XL. Sibling lane active on commit recovery, root lane
does not duplicate it. `[EXT]` needs a Windows machine for the Windows
gates.

### G-08 R02: legacy proxy capture binding and external tool conformance

Plan: `docs/REVERSE-TOOL-UPGRADE-PLAN.md` WP-R02.
Partial: the proxy now exposes a generic injected host contract that binds
canonical call identity, durable capture, translated dispatch and a terminal
`completed`, `failed` or `unknown` outcome. A PGlite conformance fixture proves
`postgres.row.update` through real `runProxy`, signed evidence, restart and Undo.
Remaining: composition in the standalone host and one honest conformance fixture
for every additional external tool. S3 and cloud provider tools remain open.
Evidence: `packages/proxy/src/forward/legacy-binding.ts`,
`packages/proxy/src/bin.test.ts`, `packages/connectors/src/reverse-engine.test.ts`
and `docs/REVERSE-ENGINE-VALIDATION.md`.
Minimum change: wire an operator-selected binding in a production composition
root, then add provider fixtures without importing connectors into the proxy.
Dependency: R03. Size: M.

### G-09 R03: streaming, pins, retention, GC, quota migration

Plan: `docs/REVERSE-TOOL-UPGRADE-PLAN.md` WP-R03.
Missing: artifact streaming, pin lifecycle, retention policy, garbage
collection that respects pins, and quota migration for existing vaults.
Evidence: `docs/MANAGED-RECOVERY.md` states no automatic GC deletes
history and that changing a vault capacity needs an explicit
administrative migration; default limits are 64 MiB per artifact and
1 GiB total (`docs/RECOVERY-CONTRACT.md`).
Minimum change: retention policy plus a GC that never removes pinned
snapshots, then a reviewed migration command. Dependency: R01. Size: M.

Local follow-up on 2026-09-23: the legacy `LocalSnapshotStore` protects pins
across all cleanup paths, rejects uncertain sidecars, and serializes cooperating
namespace mutations. This does not close managed-vault streaming, pin lifecycle,
quota migration or distributed fencing. See `RECOVERY-CONTRACT.md` for the
old-writer and missing-sidecar compatibility boundary.

## 3. Provider adapters and host boundary

### G-10 R08: managed S3 and Supabase adapters

Plan: `docs/REVERSE-TOOL-UPGRADE-PLAN.md` WP-R08.
Missing: version aware S3 operations with retention handling, and separate
Supabase database and storage capability tests.
Evidence: `packages/connectors/src/s3/` holds the legacy capture and apply
path only, and `docs/REVERSE-ENGINE-VALIDATION.md` states S3 tests use
explicit fake clients with no real restore into an AWS account.
Minimum change: managed S3 adapter with versionId and delete marker
handling, Supabase adapters scoped to granted access, all tested against
disposable services. Dependency: R02, R03, R06. Size: XL. `[EXT]` needs a
disposable AWS bucket and a Supabase test project.

### G-11 R09: GitHub and Vercel executable recovery

Plan: `docs/REVERSE-TOOL-UPGRADE-PLAN.md` WP-R09.
Missing: executable recovery adapters with real sandbox conformance for
GitHub and Vercel operations.
Evidence: `docs/OAUTH-INTEGRATIONS.md` documents connection only and
states external operations have no automatic Undo; the Vercel adapter
exposes allowlisted reads with redacted environment values.
Minimum change: per operation recovery capability (file and commit with
SHA binding, merge via recovery PR), each with sandbox conformance.
Dependency: R02, R03. Size: XL. `[EXT]` needs disposable GitHub and Vercel
test resources.

### G-12 R12: Python transport and provider certification breadth

Plan: `docs/REVERSE-TOOL-UPGRADE-PLAN.md` WP-R12.
Missing: Python transport client, provider specific fixtures, and broader
capability certification profiles.
Evidence: there is no Python client in the tree, and `packages/sdk/src`
holds `client.ts` and `managed.ts` only, with no framework wrap module;
`docs/ADAPTER-CONFORMANCE.md` notes Python transport and general provider
certification as outstanding.
Minimum change: Python transport client plus one fixture per certified
provider. Dependency: R02. Size: L. `[EXT]` needs provider sandboxes.

### G-13 R13: remote executor auth and managed egress

Plan: `docs/REVERSE-TOOL-UPGRADE-PLAN.md` WP-R13.
Missing: authenticated remote executor, managed egress boundary, and
OpenCode host setup beyond read only checks.
Evidence: `packages/cli/src/doctor.ts` header states it is read only and
never touches the network, and `void doctor` plus `void init` exist as
read only CLI; a tree wide search for egress finds only an unrelated
comment in `packages/connectors/src/postgres/capture.ts`.
Minimum change: authenticated executor handshake, explicit egress
allowlist, then host doctor and init that verify it. Dependency: R02, R05
basics. Size: L to XL.

## 4. Budgets, evidence, operations

### G-14 R10: cloud budgets, modes, approval integration

Plan: `docs/REVERSE-TOOL-UPGRADE-PLAN.md` WP-R10.
Missing: cloud accounting, visible policy modes, approval integration, and
the full reservation fault matrix.
Evidence: `packages/runtime/src/budget.ts` is 51 lines of local only
accounting; `docs/REVERSE-UPGRADE-PROGRESS.md` lists cloud accounting and
modes as remaining.
Minimum change: server side budget ledger with the same reservation
semantics, surfaced modes in CLI and GUI. Dependency: R02. Size: L.

### G-15 R14: export bundles, metrics, operational certification

Plan: `docs/REVERSE-TOOL-UPGRADE-PLAN.md` WP-R14.
Missing: complete export bundles with checkpoint completeness, runtime
metrics, and an operational certification pass.
Evidence: `packages/cli/src/operations.ts` implements export and attest
gated on ledger verification, but there is no metrics surface and no
checkpoint completeness check in the gate scripts.
Minimum change: bundle format with completeness proof, minimal metrics,
one certification run recorded in `docs/UPGRADE-CHECKPOINT.md`.
Dependency: R06, R07, R12. Size: M.

### G-16 WP-15 leftovers: hardening tail and publishable artifacts

Plan: `docs/EXECUTION-PLAN.md` WP-15, `docs/RELEASE.md`, `docs/PRIME-HANDOFF.md`.
Missing: key rotation drill (S09), transport bounds and backpressure
(S10), complete typed request identity across relay paths (S11), Slack URL
policy (S14); npm scope ownership, gated publish CI, compiled or bundled
installable artifacts, Docker image, fresh install run.
S11 is partial: c49aa8c and 396178a preserve agent-originated Session ids
and progress tokens. HTTP relay client ids and Session server-originated ids
still undergo numeric coercion; HTTP progress still uses request ids as tokens.
Closed since the 2026-09-16 audit: ledger read limits (S13, 95c73e6, whole
file read remains an accepted single read limit), child environment isolation
(S15, 396178a).
Evidence: `docs/PRIME-HANDOFF.md` scopes the remaining hardening followup;
`docs/RELEASE.md` lists the npm credential, publish CI and installable
artifact blocks; packages stay `private: true`.
Minimum change: close S10 before adding runtime surfaces, then run
the publish checklist in order. Dependency: WP-09 minimum. Size: L.
`[EXT]` needs npm scope ownership and a human release authorization.

## 5. Execution and build plan deltas

### Dependency audit follow-up, 2026-09-23

The reachable legacy CLI S3 blocker is resolved. The CLI now uses
`@aws-sdk/client-s3@3.1036.0`, whose resolved protocol stack no longer includes
the vulnerable `fast-xml-parser` or `uuid` versions. Workflow is `4.8.9`, with
`devalue@5.9.2`; narrow workspace overrides select `nanoid@5.1.16`,
`undici@7.29.0` and `esbuild@0.28.2` until their parents update those pins.

Fresh evidence after the lockfile change: the production dependency audit found
zero vulnerabilities at every severity, the full check passed 1,187 workspace
and 49 cloud tests with the same four optional integration skips, 24 focused S3
tests passed, the production cloud build passed, and the reverse engine check
passed 883 tests. Audit references that caused the update include
[GHSA-m7jm-9gc2-mpf2](https://github.com/advisories/GHSA-m7jm-9gc2-mpf2) and
[GHSA-8gc5-j5rx-235r](https://github.com/advisories/GHSA-8gc5-j5rx-235r).

### G-17 WP-04b: registry breadth toward 500 entries

Plan: `docs/EXECUTION-PLAN.md` WP-04b, `docs/BUILD-PLAN.md` phase 2.
Missing: growth from the current 270 entries (`grep -c '^    id:'`
on `packages/registry/src/registry.ts`) toward the 500 entry batch goal,
with structured output validation per entry.
Evidence: entries exist as data, including Stripe cases with R0, R1 and R2
tones, but there is no batch generation pipeline in the tree.
Minimum change: overnight batch job with schema validation, human review
per batch. Dependency: WP-04a done. Size: M.

### G-18 WP-08: provider specific blast radius measurement

Plan: `docs/EXECUTION-PLAN.md` WP-08.
Missing: exact or bounded measurement per provider with release evidence;
sampling must never satisfy an exact policy limit.
Evidence: `packages/connectors/src/probes/` holds postgres and S3 probes,
and `docs/RECOVERY-CONTRACT.md` already forbids sampling as proof of exact
counts, but provider specific certification is still open per
`docs/REVERSE-UPGRADE-PROGRESS.md`.
Minimum change: one measurement proof per certified provider. Size: M.
`[EXT]` needs provider sandboxes.

### G-19 WP-12 taint graph product integration

Plan: `docs/EXECUTION-PLAN.md` WP-12.
Missing: the two workflow integration of the graph into the product; the
legacy helpers alone do not order recovery.
Evidence: `packages/cli/src/taint.ts` and the ledger taint modules exist
and are tested, but no planner consumes them (see G-04).
Minimum change: wire the graph into the R06 planner. Dependency: G-04.
Size: M.

### G-20 WP-13 standalone verifier

Plan: `docs/EXECUTION-PLAN.md` WP-13.
Missing: a standalone verifier a third party can run without this
software; current attestation verifies inside the repo toolchain.
Evidence: `packages/ledger/src/attest.ts` plus `void attest` exist, but no
separate verifier artifact is published.
Minimum change: publish a minimal verifier with fixtures. Size: S.

### G-21 WP-14 SDK framework wrap

Plan: `docs/EXECUTION-PLAN.md` WP-14.
Missing: the `wrap` adapters for Vercel AI SDK, OpenAI Agents SDK and
LangGraph.
Evidence: `packages/sdk/src` contains no wrap module; the in process
`VoidClient` and managed runtime integration are the implemented subset.
Minimum change: framework neutral wrap plus three adapters, each proven by
the WP-05 moment scenario. Dependency: a real proxy user. Size: L.

## 6. GUI and TUI parity, summary only

Depth belongs to the sibling lanes. The shared surface already provides
streaming chat, Markdown, drafts, sessions, model selection, commands,
documents, approvals, ledger review, branching, retry, usage and responsive
navigation (`docs/GUI-UPGRADE-DELIVERY.md`). Remaining high value parity,
with server or shared runtime authority required for each:

- Configurable permission modes including a visible plan or read only mode
  (M). Never UI state alone.
- Context compaction with a durable inspectable summary and token accounting
  (L). Never rewrite the signed ledger.
- Managed file mentions and richer attachments; binary and multimodal input
  needs private object storage and provider checks (L).
- Unified tool diff review with per change accept or deny where the server
  can enforce it (L).
- Background task management with a real queue; cloud allows one active
  model session and no speculative execution (XL).
- Todo and plan state as structured events, not parsed prose (M).
- Custom agents, hooks and MCP management behind stable host and policy
  contracts (L).
- Safe checkpoint rewind across dependency aware multi operation recovery;
  current rewind covers individually captured operations only (XL,
  needs G-03 and G-04).
- User configurable shortcuts and optional Vim editing after terminal safety
  stays proven (S).

GUI acceptance tail (E8, E9): physical iOS and Android keyboards, screen
readers, real 200 percent zoom, complete browser coverage, measured LCP,
INP and CLS, plus a documented rollback execution. Evidence: the pending
matrix in `docs/MOBILE-ACCESSIBILITY-ACCEPTANCE.md`; the delivery report
claims viewport checks only. `[EXT]` needs physical devices. Size: M.

## 7. Apple, desktop, mobile

### G-22 A1: signed and notarized macOS distribution

Plan: `docs/APPLE-APPS-PLAN.md` A1.
Missing: Developer ID signing, notarization, published DMG with matching
SHA-256 checksum.
Evidence: `docs/UPGRADE-CHECKPOINT.md` states the built app uses an ad hoc
local signature and is not notarized; the plan notes the machine holds an
Apple Development identity, not the required Developer ID identity.
Minimum change: Developer ID identity, sign, notarize, staple, publish a
prerelease with checksum. Size: S once the identity exists. `[EXT]`
blocked on the Apple Developer ID identity.

### G-23 A2 to A5: SwiftUI client, iOS core, pairing, native release

Plan: `docs/APPLE-APPS-PLAN.md` A2 through A5.
Missing: the native client, the iOS local recovery core, Mac pairing, and
the native release itself.
Evidence: the plan marks Swift migration as not implemented and iOS as
deferred design; this machine has Command Line Tools only, no full Xcode
or iOS SDK.
Minimum change: per plan sequence, macOS first, iOS only after the macOS
gates pass. Size: XL. `[EXT]` blocked on full Xcode, provisioning, App
Store Connect access, membership and physical hardware.

### G-24 Windows and Linux packaging tail

Plan: `docs/WINDOWS-DESKTOP.md`, `docs/APPLE-APPS-PLAN.md` (packaging
notes), `docs/UPGRADE-CHECKPOINT.md`.
Missing: full Windows CLI and Git recovery suite evidence, advertised
Windows download, and any Linux native packaging with installed smoke.
Evidence: beta 4 passed build and smoke in Actions run 34896103807, but
the checkpoint still lists full recovery suites as open; Linux packaging
is unverified.
Minimum change: run the full suites on each platform, then advertise.
Size: M. `[EXT]` needs Windows and Linux machines.

### G-25 Production secrets and key rotation drill

Plan: `docs/BETA.md`, `docs/RELEASE.md`, `docs/OPERATIONS.md`.
Missing: production KMS, complete rotation evidence, and ledger read
limits.
Evidence: local encrypted storage and mode-0600 key files exist; the beta
doc scopes this to a single operator workspace with no multiuser RBAC.
Minimum change: KMS selection, rotation drill, recorded evidence. Size: M.
`[EXT]` needs an authorized production like KMS.

## 8. Business plan

`docs/GO-TO-MARKET.md` is marked confidential and must leave the tree
before any open core publication. Open items are human decisions, not code:
USD first pricing (the site prices in EUR), the open versus paid line, and
the MCP registry listing. Size: S. `[EXT]` blocked on human decisions.

## External resources that block certification

- Disposable cloud accounts with spend caps: AWS (S3), Supabase, GitHub,
  Vercel, plus an isolated PostgreSQL target for crash and network work.
  Nothing autonomous may touch a production account.
- Apple Developer ID identity, notarization service, full Xcode with iOS
  SDK, provisioning and App Store Connect access.
- Physical iOS and Android devices, VoiceOver and TalkBack, a real 200
  percent zoom pass.
- Windows and Linux machines for packaging and full recovery suites.
- npm `@void` scope ownership and release authorization.
- Authorized production like KMS for the rotation drill.

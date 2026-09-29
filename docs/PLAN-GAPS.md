# VOID remaining work

## Current bounded parity update

This audit is historical. [Current scope and verification](UPGRADE-VERIFICATION.md) supersedes the missing-feature claims below, not the external certification gates.
The 2026-09-25 Apple 1.0.1 inventory is in `RELEASE-1.0.1-MATRIX.md`. That
matrix also records the same day's disposable-fixture local acceptance run: 67
live control-plane scenarios passed, the named repository suites passed, and
the resulting P09 rows are scoped rather than closed. One finding from that
run, that `GET /api/tools` advertised `void_workspace_write` while
`documentEditing` was `false`, has been corrected in the working tree:
`availableTools()` now filters through `toolAllowedInMode`, with cases in
`packages/workbench/src/permission-authority.test.ts` and
`apps/control-plane/api/parity.test.ts`. Dispatch-time enforcement held
throughout, so the defect was the operator catalog, not a bypass. The live
harness now asserts the read-only catalog and re-passed at 67/67, and
`permission-authority.test.ts` plus `safety-boundaries.test.ts` pass 8/8.
G-22/G-23 below describe the old distribution proposal. The native iOS target
is a paired-Mac SwiftUI client. On 2026-09-25 Xcode 27.0 build 27A266a was
confirmed selected at `/Applications/Xcode.app`; `xcodebuild -list` resolved
the `VOID` project and its schemes, a Release `iphonesimulator` build of the
`VOID` scheme succeeded, and the built product installed and launched on an
iPad Pro 11-inch (M5) simulator. That product is ad-hoc signed with no team
identifier, no entitlements and no app icon, so it is simulator evidence only.
Current source contains 12 `VOIDTests` cases and 18 `VOIDUITests` cases. A
2026-09-26 simulator run passed `VOIDTests` 9/9 and `VOIDUITests` 18/18 on an
iPad Pro 11-inch (M5) at iOS 27.0 with Xcode 27.0, ending `** TEST SUCCEEDED
**`, and a later run the same day passed `VOIDTests` 12/12 after the
paired-device and cache-policy work landed. The 18-case UI run has not been
repeated against that newer source. The earlier 2026-09-25 run on both an iPhone 18 Pro and that iPad passed
`VOIDTests` 9/9 and `VOIDUITests` 8/8 against the smaller UI tree of that day,
so both it and the earlier 6/6 unit figure are superseded. The
`CompanionProtocolKit` package passes 58/58 under `swift test` on a macOS
host, which is not an iOS simulator or device result. Reserved-vault evidence
is 12/12. A `generic/platform=iOS` Release build failed the same day for want of
a provisioning profile for
`com.void.companion`, with no `DEVELOPMENT_TEAM` and no
`CODE_SIGN_ENTITLEMENTS` in the project and the paired iPhone reporting
Developer Mode off.
Physical iPhone/iPad install, signed-device, App Store Connect and TestFlight
evidence remain open. This toolchain inventory does not establish the user's
account, certificates, provisioning or hardware state.

The later 2026-09-25 wave is recorded in the same matrix under "companion
transport and adversarial security pass". Three findings that this file's older
text could not have predicted are now closed: the cloud tool path
short-circuited built-in managed-document writes to `allow` and passed an
unconditional authorize to the recovery runtime, so an r1 write ran with no
human in the loop and the signed journal named the agent as its own approver;
`Workbench.branch` seeded a child workspace with durable document writes under
no permission-mode gate; and an absent `VOID_PERMISSION_MODE` resolved through
two unrelated literals. The first companion transport routes and the
single-endpoint envelope adapter also landed, and the R12 Python transport
client now exists. None of that closes an external certification gate: P09.02
still lacks a paired-phone journey over a real TLS transport, and P10.09 still
needs a Windows x64/MSVC runner.

- G-01: managed cloud documents have signed operation/job events, artifacts and state in one SQL transaction. This is not a transaction host for arbitrary external tools. Physical network partition testing remains unverified.
- G-03: local API, cloud routes and MCP expose retained recovery jobs for an exact run or explicit operation list, and `planRecoveryJob` now also consumes dependency, time and checkpoint selectors and independent branch continuation, resolved to that same exact list. Leases and fencing remain open.
- G-04: adapters already observe resource keys and revisions. General read/write provenance and dependency closure remain open.
- G-07: managed filesystem and Git recovery exist. Noncooperative writers, full per-hunk enforcement and native cross-platform evidence remain separate work.
- G-20: `@void/verifier` is its own package with zero dependencies and no import from this repository. Never published, and the export-bundle fixtures are still missing.
- G-26: the open core is Apache 2.0 and NOT publishable. Nine packages export TypeScript source and ten of twelve have no build, so flipping `private` would ship source Node cannot run.
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
Minimum change: keep fixture evidence separate from certification, and add one
executable real-server gate per remaining case. The explicit migration command
path is no longer outstanding here: `void recovery migrate --config <file>` and
the refusal inside tool execution are documented in `docs/RECOVERY-COVERAGE.md`
under "Managed PostgreSQL metadata migration".
Size: XL. `[EXT]` needs a disposable isolated PostgreSQL target and a
reproducible network-fault harness.

### G-03 R06: planner selection, leases, fencing, remote job surfaces

Plan: `docs/REVERSE-TOOL-UPGRADE-PLAN.md` WP-R06.
Missing: durable leases and fencing, and the MCP and cloud job surfaces. The
stored plan still covers one run or an explicit operation list in reverse
ledger order only; a rule selector is resolved to that list and never stored.
Evidence: `packages/runtime/src/recovery/plan.ts` exports
`resolveRecoverySelection` and `independentBranches`, with 26 tests in
`packages/runtime/src/recovery/selectors.test.ts`. `planRecoveryJob` in
`packages/runtime/src/execute.ts` builds the journal state in one pass from
the retained records and their prepared captures, resolves the selector once
against it, and feeds the resolved operation IDs into the existing step loop.
Every selector kind lands on one of the two recorded `RecoverySelection`
forms, so a signed plan keeps naming the steps it undoes rather than the rule
that chose them, and its digest and every consumer of a plan are unchanged.
Re-planning an existing job id through a rule is refused, and a rule that
reaches nothing is refused because there is no list to record.
Noted: independent branch continuation is the part that can silently disagree
with the ordering proof if it is ever built separately, because "this branch
touches nothing the blocked branch touched" and "this order is safe" are two
readings of the same dependency claim. Both are derived here from the one edge
list `provenanceEdges` returns, one edge per consumer, producer and resource,
which is the same list `orderRecoverySteps` proves an order from, so a branch
held by an edge and a step refused for that edge cannot name different
dependencies.
Minimum change: a single active worker lease with fencing, then MCP and cloud
surfaces on top of the wired planner. Dependency: R02, R03, one R04 or R05
adapter. Size: XL.

### G-04 R07: runtime provenance and dependency aware recovery

Plan: `docs/REVERSE-TOOL-UPGRADE-PLAN.md` WP-R07.
Closed in part 2026-09-26; the residual is stated below rather than repeated
as a missing capability.

The audit row this came from (`docs/OPEN-WORK-AUDIT.md` 24, written against
63dbd2c) said the runtime "records no resource read or write sets" and that
`orderRecoverySteps` therefore "has nothing to order by". Against this tree
both halves were wrong in the same direction. Provenance facts were already
built from the durable capture's `Observation` in `planRecoveryJob`, and
`filesystem.managed` already recorded a read set. What was missing was the
PostgreSQL and managed-documents read sets and the journal fields, and the
planner's problem was the opposite of having too little to order by: it
refused plans it should have accepted.

Now true. `recoveryRuntime` stamps `readSet`, `writeSet` and `revision` onto
the operation identity from the adapter's `preflight` observation, so every
record from `authorized` onwards carries them, and the values are the ones the
adapter observed rather than the ones the caller declared. An adapter that
cannot observe its reads leaves `readSet` absent, and an adapter that reports
no revision leaves `revision` absent, because `canonicalJson` refuses
`undefined` and an absent field is the only honest record of an absence. A
`null` revision is an observation — there was no prior state — and is recorded
canonically. `managedPostgresAdapter` records every row it captured with that
row's own revision from the metadata ledger, and the managed-documents adapter
records the document it read at the revision it read it; the filesystem
adapter needed no change because its read set already was its before-image.
`collectVaultGarbage` in `retention.ts` writes its own `vault.retention`
record and is deliberately not stamped: it has no `Observation`, and the sets
it would carry are the ones its policy names rather than ones it observed.

The closure is computed in `provenanceEdges`. A read of a resource the step
did not write is a consultation and any writer of that resource is a candidate
producer, later ones included, which is the case the proof refuses. A read of
a resource the step did write is its own before-image, so only a writer
earlier in the journal can have produced it. Before this, a read matched every
writer including later ones, and two sequential writes to one file were
refused with the claim that the first had read the second's output. Measured
before and after on `filesystem.managed`: `Recovery job order is not provably
safe: op-1 read file:/…/a.txt from op-2, which is later in the journal` became
a plan of both steps in reverse order. `orderRecoverySteps` now also refuses a
plan in which two steps each wrote one resource and each recorded the same
revision for it, because the second started from a state the first write had
already moved past. No plan.ts rule was added: the unproven and independent
distinction there is the one `independentBranches` and the `dependencies`
selector already use, and this change feeds it rather than restating it.

Still not provable, and not claimed: the Git managed adapter records no read
set until its own owner lands one, and its steps are reported as unproven
rather than ordered. A write must move the revision of every resource it
writes for the chain check to mean anything; an adapter that cannot version
what it writes records no revision and the check skips it rather than reading
the absence as agreement. Cross-system plans, data-flow provenance between
agents (WP-R07's two-to-three-agent exit), and a resource hierarchy across
systems remain open. `node --test packages/runtime/src/provenance.test.ts`
passes 12/12 and the runtime suite 161/161.

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
Shipped: managed commit and revert (2026-09-25, `git/managed-commit.ts`), then
remote recovery as `recoverRemote` (2026-09-26, `git/managed-remote.ts`). The
remote path fetches the named remote branch, re-derives the undone commit from
its own `refs/void/operations/` receipt, and publishes exactly one new
`refs/heads/void/recovery/<digest>` branch carrying the inverse, parented on the
remote tip, with a digest-bound proposal body that names the operation, its
receipt and its commit. No local branch is created, no existing ref moves,
there is no `reset` and there is no force-push; the only remote commands are
`fetch`, `ls-remote` and `push`. A remote that advances between capture and
apply is refused by name rather than rebased, a refused push reconciles to
`failed`, and a branch found at a foreign commit reconciles to `unknown` with
no second push.
Missing: publication and its conformance scenario; the pull request itself;
the Windows gates. `recoverRemote` is wired into the adapter but is not in the
`git.managed` profile's operation list, the profile still lists `remotes` under
`excluded`, the MCP tool schema still omits it, and
`docs/RELEASE-1.0.1-MATRIX.md` still records the pre-remote scenario count.
Turning the published branch into a pull request needs a host credential and
belongs to the GitHub adapter (G-11). `recoverRemote` has no managed inverse of
its own — deleting a published branch is a human decision — so it reports R3
and the default runtime denies the dispatch.
Evidence: `docs/MANAGED-GIT.md` "## Managed remote recovery";
`packages/connectors/src/git/managed-remote.test.ts` against a real bare local
remote with a real second clone as the noncooperative writer;
`docs/ADAPTER-CONFORMANCE.md` records Windows rename as refused and Windows Git
as a POSIX exclusion.
Minimum change: add the operation and a remote-backed conformance fixture to
`packages/cli/src/conformance.ts`, then update the matrix count; Windows rename
only with separate evidence. Dependency: R02, R03. Size: M for publication, XL
for the Windows gates. `[EXT]` needs a Windows machine for the Windows gates.

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
Missing: growth from the current 268 entries (`grep -c '^    id:'`
on `packages/registry/src/registry.ts`, re-measured 2026-09-29) toward the 500
entry batch goal, with structured output validation per entry. Earlier
revisions of this file said 270 and the count is not 270 now. How many of the
268 are executable is a different question with a different denominator, and it
is stated in the 2026-09-29 errata in `docs/ROADMAP-2026-Q4.md`.
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
Answered 2026-09-26, and the answer is that the graph cannot feed recovery
ordering without becoming the graph G-04 already builds. Recorded here with
the evidence rather than left as a missing capability, because "wire it in" is
the instruction that would produce a second, worse provenance graph.

`buildGraph` reads the policy decision feed, not the recovery journal: it
requires `tool`, `klass` and `decision` on every entry and throws
`ledger entry 1 has no klass` without them, so a `void.operation.v1` record
cannot be a node. A node is a call digest with a sequence, a tool name and a
decision, and no file under `packages/ledger/src/taint/` mentions
`operationId`, so nothing joins a taint node to a recovery step. `TaintNode.
revision` is declared and nothing in the tree writes `revision` into a ledger
entry body, so it is `undefined` on every real node.

The edges are the reason it must stay separate. `resourceKeys` derives a key
from what the caller declared — `bucket`/`key`, `table`/`rowPredicateDigest`,
`identity`/`id`, and `argsDigest` when nothing else matches — and `buildGraph`
joins consecutive calls that share one. Verified on a two-entry graph: the
edge is `x:identity=r1`, `bindingType: "observed-resource"`, produced by two
callers naming the same id, with no observation of any resource on either
side. Feeding that to `orderRecoverySteps` would substitute a declared claim
for a proven one, which is the failure G-04's minimum change exists to
eliminate, and the planner would either refuse correct plans or order them on
argument text. Re-keying the graph by operation ID and deriving its resources
from observed read and write sets is not an integration: it is G-04's graph
under a second name, kept honest only by never being consulted.

What the two structures do share is the vocabulary WP-R07 asks for, and the
provenance module now uses it honestly: a taint edge is `confirmed-data`,
`observed-resource` or `conservative-potential`, and a `ProvenanceFact` with
no recorded read set is a conservative potential dependency that contributes
no edge and is reported as unproven. The inspection surface stays exactly
where it is — `void taint` in the CLI over the decision feed, no file under
`packages/runtime/src` importing it — and `docs/RECOVERY-CONTRACT.md` already
says the retained planners never consume it.

Still open under this row: WP-R07's data-flow edges between agents, which need
an `outputDigest`/`inputDigest` pair recorded by the producers themselves. The
decision feed carries no producer for them today, and a caller-supplied
`inputDigest` is the same declared claim this row refuses.

### G-20 WP-13 standalone verifier

Plan: `docs/EXECUTION-PLAN.md` WP-13.
Partly closed 2026-09-26. The verifier is now `@void/verifier`, its own
installable package with a `void-verify` binary, zero dependencies of any kind and
no import from this repository, and it carries a README that commits in writing to
keeping both properties. `scripts/src/licence-line.test.mjs` fails the build if
either is lost.
Still missing: it has never been published to a registry, and the export-bundle
fixtures a third party would use to try it are not in the package.
Minimum change: publish it, and ship a small synthetic bundle as a fixture.
Size: S. Needs release credentials from G-26, not code.

### G-26 the open core is licensed for publication and cannot be published

Measured 2026-09-26, and this is the largest remaining gap in the licence line.
Every package declares Apache 2.0, the root LICENSE is the verbatim text, the
NOTICE carries the registry disclaimer verbatim, and `@void/verifier` is
publishable today. Nothing else is. Twelve packages are `private: true`, and that
flag is not an oversight: `release-packaging.test.mjs` enforces it so nothing ships
with incoherent release metadata, and it is what currently stops a broken release.

Flipping it would make things worse rather than better. Nine packages point
`exports` at TypeScript source and ten of the twelve have no build script, so
publishing them would ship source that Node cannot run. The licence line therefore
rests on a distribution channel that does not exist yet, which is worth stating
plainly because DECISIONS 5 argues the MCP registry, GitHub search and the registry
entry pages all require something installable without a sales call.

Minimum change per open package: a build emitting JavaScript, `main`, `module`
and `types` that agree for all three resolvers the workspace uses, a `files` list
covering the output, build ordering in the root build script, and a preview publish
to a scratch registry. `scripts/src/licence-line.test.mjs` refuses any package that
is publishable without a way to produce its files, so the flag cannot be flipped on
its own.
Size: L. Sequence registry, ledger, policy, proxy, cli, in that order: each depends
on the ones before it, and a partially published chain is harder to consume than an
unpublished one.
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

### G-23 A2 to A5: SwiftUI client, pairing, native release

Plan: `docs/APPLE-APPS-PLAN.md` A2 through A5.
Missing: the remaining native client implementation, Mac pairing, complete
recovery/review journeys, physical-device acceptance, and the native release.
Evidence: the native iOS 17 project, Swift package, app, unit tests and UI-test
source now exist under `apps/apple/`. Xcode metadata and the `VOID` simulator
build succeeded. Current source contains 12 `VOIDTests` cases and 18
`VOIDUITests` cases; the last recorded sequential simulator run against the
source of that day passed 9/9 unit and 18/18 UI, and a later run the same day
passed 12/12 unit after the paired-device and cache-policy work landed. Reserved-vault evidence is 12/12. These results do not prove
pairing, TLS, recovery, physical-device behavior, signing, App Store Connect or
TestFlight.
Minimum change: complete the paired-Mac flow and native acceptance, then run
provisioning/archive/TestFlight on the exact candidate. Size: XL. `[EXT]`
still requires provisioning, App Store Connect access, membership and physical
iPhone/iPad hardware.

### G-24 Windows and Linux packaging tail

Plan: `docs/WINDOWS-DESKTOP.md`, `docs/APPLE-APPS-PLAN.md` (packaging
notes), `docs/UPGRADE-CHECKPOINT.md`.
Status: Windows is out of scope for the 1.0.1 delivery and its current-source
gate remains open. Beta-4 Actions evidence is historical and does not certify a
current candidate. No current-source Windows packaging, installed smoke,
advertised Windows download or full Windows recovery-suite evidence is claimed.
Linux native packaging also remains unverified.
Minimum change: in a later authorized release, run the full suites on the exact
Windows and Linux candidates before advertisement. Size: M. `[EXT]` needs
authorized Windows and Linux machines.

### G-25 Production secrets and key rotation drill

Plan: `docs/BETA.md`, `docs/RELEASE.md`, `docs/OPERATIONS.md`.
Missing: production KMS, the rotation drill, and the recorded evidence that a
rotation happened and stayed verifiable. The third item G-16 used to list here,
ledger read limits, is closed: they shipped on 2026-09-17 in `95c73e6` and live
as per-call byte and entry bounds in `packages/ledger/src/verify.ts`, which
G-16 also records. What remains in this gap is therefore the rotation drill
itself, and the production KMS it would run against.
Evidence: local encrypted storage and mode-0600 key files exist; the beta
doc scopes this to a single operator workspace with no multiuser RBAC. The
`KeyProvider` interface takes a key id and the verifier resolves one per entry,
but the only provider in the tree holds a single key and returns null for any
other id, so a chain signed across a rotation does not verify today. A
`key_id` is already carried in the signature preimage, so the ledger format
itself is not the obstacle.
Minimum change: KMS selection, then the rotation drill and its evidence. Size: M.
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

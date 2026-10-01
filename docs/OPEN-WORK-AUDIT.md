# VOID open-work audit

Written 2026-09-26 against `main` at `63dbd2c`, and re-run against the tree on
2026-09-29. This document reconciles the planning and evidence documents
against the tree. It is not a summary of the repository and it is not a roadmap:
it is a list of what is still open, with each item classified by what is
actually blocking it.

## Method, and the one rule that produced the result

Every item below was checked against the source before it was written down. A
document's claim to be evidence was treated as a claim, not as evidence. Where
a document asserts an absence ("there is no X"), the tree was searched for X
first; of the 31 stale rows in §3, fourteen are a document asserting an absence
that is simply false, and those are the expensive ones, because a reader acts
on them. They are listed there rather than carried forward as work.

Classes used throughout:

| Class | Meaning |
| --- | --- |
| **W** | Code that could be written now, on this machine, with no external input. |
| **D** | Blocked on a human decision about product direction, scope or priority. |
| **X** | Blocked on something outside this machine: an Apple account, a signing identity, physical hardware, a store, a paid service, a real provider, or a Windows/Linux environment. |
| **S** | Already satisfied, or recorded as open but the tree says otherwise. Listed in §3, not here. |
| **R** | Not achievable as written; reframed or dropped. Listed in §2 with the reasoning. |

Where an item is genuinely two things, the class cell names the split rather
than forcing one label. That is the common case for the provider and platform
work, where the code is writable and only the acceptance gate is external.

**What the tree can do today that it could not a week ago.** Twenty `void`
subcommands, all exercised. A signed ledger where every record now names the
policy and rule that decided it, with the rationale, and a malformed
attribution fails the chain while a pre-existing ledger still verifies. Every
verification surface says `integrity only` beside its claim. A compaction
system the planner can order by, a durable recovery-job lease, vault retention
and collection, an export bundle with completeness proof, 18 recomputed metric
counters, a machine-readable capability profile required by the release gate, a
three-arm end-to-end agentic reverse exercise (real files, a real in-process
Postgres, and a spawned MCP stdio server) that runs inside `pnpm test`, a Python
transport client with 84 tests, a companion protocol with five bound operations,
and a cloud deployment that builds and serves for the first time in two months
of failures. The tree contains no `TODO`, `FIXME` or unimplemented marker in
first-party source. The open work is in documents and in the world outside the
machine, not in stubs.

## 1. The open items

One item, one row. Other places the same gap appears are listed as
references, not repeated as rows.

Three rows were closed on 2026-09-29 and struck from this list, one row is
partly closed, and nine more were closed before the re-run. The four are in the
re-run table at the end of this document, which governs where it and the list
above disagree; the nine are carried in the closed list of
`docs/STATUS-INDEX.md` with the commit that closed each. Of the 61 row numbers
above, 49 are open. Numbers are retired, never reused, so every cross-reference
to a row of this audit in another document still resolves to the row it named.

### 1.1 Distribution, signing and the stores — almost entirely external

| # | Item | Class | Recorded in | What done looks like |
| --- | --- | --- | --- | --- |
| 1 | Mac App Store signed-sandbox build and the seven sandbox behaviours it must support (entitlement inheritance, security-scoped folder access, child-process and arbitrary-tool restrictions in store mode, clean shutdown, no orphan runtime, the Tauri-vs-SwiftUI-vs-store-companion architecture call) | **X** (the architecture half is **D**) | Matrix P01.01–P01.07; plan §8; `APPLE-APPS-PLAN.md` A5 | A signed, sandboxed `.app` installs from a build, and a real capture + Undo plus an iPhone/iPad TLS fixture is recorded from it. |
| 2 | Developer ID Application identity, notarization, stapling and a published DMG with a matching SHA-256 | **X** | Matrix P10.03 (notarization half); `PLAN-GAPS.md` G-22; `APPLE-APPS-PLAN.md` A1; `WINDOWS-DESKTOP.md` is not the source | `spctl` accepts the artifact, a `notarization stapled` receipt exists, and a published download returns those bytes. |
| 3 | iOS/iPadOS distribution: provisioning profile for `com.void.companion`, `DEVELOPMENT_TEAM` in the project, archive, TestFlight, App Store Connect | **X** | Matrix P10.04, P11.01–P11.06; `PLAN-GAPS.md` G-23 | An archive of the exact candidate is accepted by App Store Connect and installs on a physical device. |
| 4 | Windows desktop: current-source packaging, installed-application smoke and Windows filesystem/Git recovery evidence before any download is advertised | **X**, with a human step — the workflow is `workflow_dispatch`-only, so somebody has to press it | Matrix P10.09; `PLAN-GAPS.md` G-07 (Windows half), G-24; `WINDOWS-DESKTOP.md` W1–W11; `RECOVERY-COVERAGE.md` filesystem and Git rows | A green run of `.github/workflows/desktop-windows.yml` on current source: NSIS installer, silent install, `--smoke-test` exit 0, SHA-256 published. |
| 5 | Linux native packaging — not even a bundle target in `tauri.conf.json` | **X** | `PLAN-GAPS.md` G-24 only | A Linux build and a full recovery suite on the exact candidate. |
| 7 | App Store metadata, privacy labels, retention/deletion policy, support contact, reviewer instructions, screenshots, age rating, accessible test executor | **X** for the review account and reachability, **W** for the documents | Matrix P10.05, P10.07 | A privacy label and a review-notes document exist, and a reviewer can reach a safe executor. |
| 8 | Export-compliance classification for the encryption the product ships | **D** — the matrix itself says it "cannot be inferred from source" | Matrix P10.06 | An operator records the classification and sets `ITSAppUsesNonExemptEncryption` deliberately. |
| 9 | Account deletion path | **W**, narrowly. The docs say do not invent one, and no mounted route creates an account: `cloud/server.mjs` does not mount `cloud/auth.mjs`'s signup, the Supabase broker refuses signup while `VOID_ACCOUNT_SIGNUP` is unset, and no route accepts the invitation code one would need. Note that the trigger moved: a provider account can now sign in over `POST /api/account/signin` and own rows, so deletion becomes real work at the first real sign in, not at the first mounted signup | Matrix P10.08 | Either a tested deletion route, or a recorded statement that no account exists. |
| 10 | External beta cohort: 10 testers across the device matrix, 7 days, 100 recorded recovery journeys, incident review, retained binaries, documented rollback, emergency disablement | **X** | Matrix P11.01–P11.06; 1.0.1 plan §4 | The cohort runs and its incidents are reviewed. |
| 11 | Support, legal and privacy owners named | **D** | Matrix P10.05; 1.0.1 plan §8 | Three names exist. Nothing can be written until then. |
| 12 | `docs/GO-TO-MARKET.md` is marked confidential and must leave the tree before any open-core publication | **W** (one deletion) | `PLAN-GAPS.md` §8 | The file is gone or un-confidentialised. |

### 1.2 Decisions that are the user's, not the engineer's

| # | Item | Class | Recorded in | What done looks like |
| --- | --- | --- | --- | --- |
| 13 | The 1.0.1 plan's eight approval bullets: Tauri vs SwiftUI, local-network-only vs funded server connectivity, pricing/IAP, locked-Mac mutation policy, one-device-approval sufficiency, and the "if 1.0.0 was never released, say why the public version is 1.0.1" question. The Tauri vs SwiftUI bullet is closed and the other six are open; see the re-run table at the end of this document | **D** | 1.0.1 plan §1 and §10 items 1 and 6; matrix D04.09, D04.13; `PLAN-GAPS.md` §8 | Each open bullet is answered in writing. |
| 14 | Approved visual direction for Mac, iPhone and iPad, and the navigation structure | **D** | Matrix D01.01–D01.05, D04.09 | One direction is chosen before the design-system work starts. |
| 15 | Site claims audit: the site still shows latency and tool-count figures the reverse plan already flags as non-evidence; and it prices in EUR | **D** + **W** | `PLAN-GAPS.md` G-06 (the site half), §8; `GUI-ALLINONE-PLAN.md:173` | Each claim is either evidenced or removed; the pricing currency is chosen. |
| 16 | Whether NVIDIA NIM / GLM 5.3 Flash should be the hardcoded default provider | **D** | `packages/workbench/src/provider-defaults.ts:2`; `2026-09-21-nvidia-product-parity.md` Task 1, Task 8 | A decision. The matrix's own 2026-09-26 correction says the model is the operator's choice and the surface is provider-agnostic, while the source makes one vendor the default. Both cannot be the position. |
| 17 | Whether to publish and independently audit the standalone ledger verifier outside the repository | **D** + **W** (the fixtures) | `PLAN-GAPS.md` G-20 residual | A versioned artifact a third party can fetch, plus an independent audit of the replicated canonicaliser. |
| 18 | npm `@void` scope ownership and release authorization | **X** + **D** | `PLAN-GAPS.md` G-16, G-20, and the consolidated external-resources list | The scope is owned and someone is authorized to publish. |
| 19 | Production KMS and key-rotation drill | **X** for the KMS, **W** for the drill procedure | `PLAN-GAPS.md` G-25; `docs/BETA.md`, `docs/RELEASE.md` | A rotation is performed and its evidence recorded. |
| 20 | Registry breadth target: 268 entries today (re-measured 2026-09-29; this document said 270), goal 500, with "human review per batch" | **D** on the target and the review, **W** on the pipeline | `PLAN-GAPS.md` G-17; `PLAN-STATUS.md` WP-04b; `EXECUTION-PLAN.md` WP-04b | A validated batch pipeline exists and someone has decided whether 500 is still the number. Of the 268, three are executable through the legacy proxy root and four managed adapters run under names that are not registry entries; the errata in `docs/ROADMAP-2026-Q4.md` states both denominators. |

### 1.3 The reverse/recovery engine — the largest block of genuinely writable work

| # | Item | Class | Recorded in | What done looks like |
| --- | --- | --- | --- | --- |
| 22 | Wire the R10 server budget ledger into a real host. `serverBudgetLedger` in `packages/runtime/src/budget.ts` has **zero** production consumers — only its own tests. The R06-style wiring was attempted and reverted because the journal's writer lock wraps the whole transaction, so the budget lock inside it stalls every workspace behind one contended worker. The safe shape is already known: a short prior-record read before the reservation, with the transaction re-checking authoritatively. | **W** | Matrix §"A wiring that was attempted and reverted"; `PLAN-GAPS.md` G-14; `PLAN-STATUS.md` R10; `RECOVERY-CONTRACT.md` "## Irreversibility budget" | The ledger is on a dispatch path, and `crash.test.ts`'s "a restarted executor must not re-observe an already-dispatched operation" property still holds. |
| 23 | Planner selectors: dependency, time and checkpoint selection; independent branch continuation; a cloud MCP job surface; cross-host fencing | **W** | `PLAN-GAPS.md` G-03 residual; `RECOVERY-CONTRACT.md` "## Persistent recovery jobs", "## Cloud managed documents"; `PLAN-STATUS.md` R06 | A plan can be selected by dependency or checkpoint rather than descending journal order, and the taint surface is reachable from a cloud job. |
| 24 | Populate `readSet` / `writeSet` / `revision` for every adapter at dispatch, and compute descendant closure generally | **W** | `PLAN-GAPS.md` G-04 residual; `RECOVERY-CONTRACT.md`; `PLAN-STATUS.md` R07 | Provenance is universal rather than per-adapter opt-in, so `orderRecoverySteps` can refuse more plans. |
| 25 | Wire the legacy taint graph in `packages/ledger/src/taint/` into the R06 planner | **W**, depends on 24 | `PLAN-GAPS.md` G-19; `EXECUTION-PLAN.md` WP-12 | The inspection-only graph feeds recovery ordering. Note this is a *different* graph from the one in item 24, which is why the two must stay separate rows. |
| 26 | Staged hold, dependency barriers and cascading cancel | **W** | `PLAN-GAPS.md` G-05; `REVERSE-TOOL-UPGRADE-PLAN.md` WP-R11; `PLAN-STATUS.md` R11 | A provisional-receipt path behind explicit opt-in, keeping the blocking hold as the default. Nothing exists today. |
| 27 | Cloud/distributed budgets, visible policy modes, weighted costs and staged reservations | **W** for the code, **D** for how far "cloud" is meant to go | `PLAN-GAPS.md` G-14; `RECOVERY-CONTRACT.md` "## Irreversibility budget"; `PLAN-GAPS.md` §6 item 6a | A server-side ledger with the same reservation semantics, surfaced in CLI and GUI. |
| 28 | `managed-postgres` has no capability profile and no conformance suite. The release gate publishes exactly three profiles — `filesystem.managed`, `git.managed`, `managed-documents` — while a full `RecoveryAdapter` implementation exists at `packages/connectors/src/postgres/managed.ts` and is exercised by `reverse-exercise.ts` over PGlite. The gate is fail-closed on a *missing* profile, so the one adapter with the most adversarial coverage is the one no profile names. | **W** — PGlite is in-process, no service needed | Not recorded anywhere. Found by reading the profile set against the adapter set. | A `managedPostgresConformanceProfile` and a scenario list, with the gate refusing a release that ships the adapter unpublished. |
| 29 | **Closed 2026-10-02, and the finding underneath it was stale.** As written this row claimed the published profile "lists `commits` under `excluded` and omits it from `operations`". That was true of `63dbd2c` and stopped being true in `39d3c48` (2026-09-26). `gitConformanceProfile.operations` now reads `["create","write","delete","rename","stage","unstage","commit"]`, `commits` is not an entry in `excluded`, and both `durableExecutionReceipt` and `durableRecoveryReceipt` are `true`, which is what the `refs/void/operations/` receipt work earned. The commit lifecycle is implemented at `packages/connectors/src/git/managed.ts` and advertised, so the remedy this row asked for is satisfied by the tree. `managed-postgres` remains unpublished and is row 28. | **X** for the original claim, superseded by the tree | `packages/connectors/src/git/managed.ts:457-462` (commit preparation) vs `packages/cli/src/conformance.ts:164-180`; corrected against `39d3c48`; `PLAN-GAPS.md` G-07; `RECOVERY-COVERAGE.md` "Managed Git" row; `docs/MANAGED-GIT.md` | Nothing outstanding for the commit lifecycle. What this row's real defect exposed is recorded below and is a code matter, not a documentation one. |
| 30 | Git remote recovery, append-only revert / recovery PR, and the noncooperative-writer boundary | **W** for the first two, **X** for full per-hunk cross-platform evidence | `PLAN-GAPS.md` G-07; `REVERSE-TOOL-UPGRADE-PLAN.md` WP-R05; `PLAN-STATUS.md` R05 | Never reset, never force-push; a recovery PR carries the inverse. |
| 31 | Managed S3 and Supabase adapters with versionId and delete-marker handling | **W** for the adapter, **X** for the stated gate ("tested against disposable services") | `PLAN-GAPS.md` G-10; `REVERSE-TOOL-UPGRADE-PLAN.md` WP-R08; `PLAN-STATUS.md` R08 | A managed S3 adapter with real version semantics, plus a Supabase project. S3 today is a legacy connector path only, with no `RecoveryAdapter`. |
| 32 | GitHub and Vercel executable recovery: file and commit with SHA binding, merge via recovery PR | **W** for the adapters, **X** for sandbox conformance | `PLAN-GAPS.md` G-11; `REVERSE-TOOL-UPGRADE-PLAN.md` WP-R09; `PLAN-STATUS.md` R09; `RECOVERY-COVERAGE.md` "GitHub/Vercel/Supabase OAuth" row | An OAuth token stops being the only thing these integrations can do. |
| 33 | Managed-vault artifact streaming, pin release, retention-index backup and administrative quota migration | **W** | `PLAN-GAPS.md` G-09; `RECOVERY-CONTRACT.md` "## File recovery vault retention"; `PLAN-STATUS.md` R03 | Streaming exists, a pinned artifact can be unpinned without out-of-band surgery, and capacity can be migrated explicitly. Retention and pin-respecting collection already shipped. |
| 34 | Cloud fault matrix: disk exhaustion and in-flight PostgreSQL client SIGKILL | **W** for the local harness, **X** for the physical cases | `PLAN-GAPS.md` G-01 residual; `RECOVERY-COVERAGE.md` "## Verification interpretation" | The document's own three release gates — physical disk exhaustion, client process death, physical network partition — are each either closed or explicitly deferred. |
| 35 | Document the explicit `migrateManagedPostgres` v1→v2 metadata command path, which tool execution deliberately never performs | **W** | `PLAN-GAPS.md` G-02 code half; `RECOVERY-COVERAGE.md` "## PostgreSQL limitations" | An operator can migrate metadata on purpose and the refusal inside tool execution is explained. |
| 36 | Real-server Postgres certification: cascade, tenant/RLS, migration, in-flight client kill, network partition | **X** — needs a disposable isolated Postgres and a network-fault harness; the gates are code, the target is not | `PLAN-GAPS.md` G-02; `RECOVERY-COVERAGE.md`; matrix P09.03 | One executable real-server gate per remaining case, with `verify-managed-postgres.mjs` no longer emitting `networkPartitionTest: false`. |
| 37 | Provider-specific blast-radius measurement and provider certification fixtures | **W** for the fixtures, **X** for the sandboxes | `PLAN-GAPS.md` G-12 residual, G-18; `REVERSE-TOOL-UPGRADE-PLAN.md` WP-R12, WP-R08 | One measurement proof per certified provider, never a sample standing in for an exact count. |
| 38 | Remote executor authentication and a managed egress allowlist, with `void doctor` / `void init` verifying them | **W** | `PLAN-GAPS.md` G-13; `REVERSE-TOOL-UPGRADE-PLAN.md` WP-R13 | `doctor` stops being read-only and reports the boundary it enforces. |
| 39 | SDK framework `wrap` for Vercel AI SDK, OpenAI Agents SDK and LangGraph | **W**, human-gated — the stated dependency is literally "a real proxy user" | `PLAN-GAPS.md` G-21; `EXECUTION-PLAN.md` WP-14 | A framework-neutral wrap plus three adapters, each proven by the moment scenario. |
| 40 | Legacy proxy binding in a production composition root, plus one honest conformance fixture per external tool | **W**, with the S3/cloud fixtures waiting on item 31 | `PLAN-GAPS.md` G-08; `REVERSE-TOOL-UPGRADE-PLAN.md` WP-R02; `PLAN-STATUS.md` R02 | Standalone `void-proxy` composes an operator-selected binding; every bindable tool has a cross-layer fixture. |
| 41 | One operational certification run recorded | **W** — a run, not a build | `PLAN-GAPS.md` G-15; `REVERSE-TOOL-UPGRADE-PLAN.md` WP-R14 | A run in `docs/UPGRADE-CHECKPOINT.md` that says what it did and did not cover. |
| 42 | Transport hardening tail: key-rotation drill (S09), transport bounds and backpressure (S10), typed request identity across the HTTP relay (S11), Slack URL policy (S14), Docker image, fresh-install run | **W** except the publish authorization | `PLAN-GAPS.md` G-16; `docs/PRIME-HANDOFF.md`; `EXECUTION-PLAN.md` WP-15 | Each item closed with a failing-then-passing test, or explicitly dropped. |
| 43 | A whole-tree green under the new explicit CI time budgets | **W** — a run, not a build. `pnpm test` is 671 s against a 25-minute step budget; the old shared-deadline result was the reason a killed `git.managed` run once looked green | Matrix P02.06, P03.01, P03.06; 2026-09-23 R02 plan Task 5 | `pnpm run check` exits zero end to end, and no gate is killed by a shared deadline. |

### 1.4 The protocol, the client and the product surfaces

| # | Item | Class | Recorded in | What done looks like |
| --- | --- | --- | --- | --- |
| 45 | Freeze the companion protocol properly: shared Swift/TypeScript fixtures for every outcome, the boundary-and-boundary-plus-one limits matrix against a real transport, and the security review the rows keep asking for | **W** for the fixtures and the matrix, **D** for who reviews | Matrix P04.01–P04.05 | The frozen v1 contract has a fixture per case, a limit at n and n+1, and a named reviewer's finding list. `CompanionProtocolKit` and `companion-fixtures.test.mjs` cover the client half; the server half and the review are open. |
| 46 | Publish `device.pair` in the handshake capability catalog | **R** as an adapter change — it needs a v1.1 contract change, because the frozen catalog derives from the frozen `operations` set | Matrix §"One finding is not fixable in the adapter" | A `void.companion.v1.1` contract revision. Publishing it inside v1 would make every handshake response fail the frozen validator. |
| 47 | Paired-device security: start-pairing with invitation expiry and single use, native secure credential storage, replay and duplicate acceptance, certificate mismatch, two-device races, revoke during an open stream and during a pending approval, bounded event reconnect that does not repeat a forward mutation | **W** as code, gated on item 6 | Matrix P05.01–P05.06 | Each named race has a test. Most of this is code; the *acceptance gate* is a paired device, which is item 48. |
| 48 | A paired-phone journey over a real TLS transport, on a physical device, with Developer Mode and local-network denial | **X** | Matrix P09.02, P07.05, P07.06, P09.06; `PLAN-GAPS.md` G-23; `RECOVERY-COVERAGE.md` "## Verification interpretation" | The Apple client round-trips against the live routes on hardware, not against in-process transport doubles. |
| 49 | iOS cache retention/redaction and logout or device-removal cleanup. There is no `URLCache` handling, no logout and no sign-out anywhere in `apps/apple/`; cached history is not established as non-authoritative for a new mutation | **W** | Matrix P06.05 | A stated cache policy and a device-removal path that leaves no credential behind. |
| 50 | iPad inspector, chat detail and multi-window keyboard shortcuts. The matrix's evidence for "no keyboard shortcuts" — no `keyboardShortcut` in the target — is now false; `ChatView.swift:377` has one | **W** | Matrix D04.03 | An inspector and a split-view chat detail that is not the phone layout stretched. |
| 51 | Native VoiceOver, physical keyboard, safe areas, rotation, Dynamic Type and background lifecycle | **X** | Matrix P09.06, D04.06 (native half), D04.08; `PLAN-GAPS.md` §6 item 6j; `MOBILE-ACCESSIBILITY-ACCEPTANCE.md`; `PLAN-STATUS.md` E8 | A real screen-reader pass on hardware. A simulator is not a device and a Tab key is not a keyboard. |
| 52 | Desktop new-user flow: a guided safe-workspace exercise, a running build/version/channel strip, actionable permission-half startup guidance, a diagnostics preview/export with an allowlist and secret-exclusion tests, and privacy/support/release-notes surfaces | **W** | Matrix P08.01–P08.05 | A first-run that teaches Undo without a production mutation, and a diagnostics export that provably contains no synthetic secret. |
| 53 | Stale provider bootstrap instructions and stale beta download links | **W** — except verifying links after publication, which needs a publication | Matrix P08.06 | Correct text in the repo; link verification moves to the release runbook. |
| 54 | Packaged-artifact install, upgrade, rollback, unsupported-newer-format refusal and uninstall/reinstall, with no accidental key or data loss | **X** — needs a packaged, signed build | Matrix P09.01, P09.03, P09.04, P10.02 | Each cycle is run on the exact candidate. Fresh-state behaviour is already covered by disposable-directory harnesses; installed behaviour is not. |
| 55 | Real provider streaming in an explicitly authorized bounded-cost sandbox | **X** — the matrix says "Without credentials/budget, leave that gate open; fixtures cannot close it" | Matrix P09.05 | One authorized run. The provider surface is already tested provider-agnostically at 13/13; nothing about a model is missing. |
| 56 | Performance and load budgets on a device and network profile | **X** | Matrix P09.07; 1.0.1 plan §4 | A recorded p95/ack/ready measurement on named hardware. The existing transport load result is a relay bound, not this gate. |
| 57 | Design-system families: D03.02–D03.30 have no real consumer, interaction states or gallery entry. D03.22 (backup health), D03.26 (pairing and revoke) and D03.28 (guided first action) have no consumer at all | **W** | Matrix D03.01–D03.30, D02.01–D02.06 | Each family has a consumer and a gallery state, or is struck. |
| 58 | Per-route search, detail views, paging, export and dialogs on the Mac web surface; the local `/demo` route is hardcoded `{supported: false, available: false}` while `cloud/demo.mjs` implements a real one | **W** | Matrix D04.01 | The demo route either renders or is removed; the matrix's own observation is that it "settles on 'Demo is currently unavailable'". |
| 59 | GUI/TUI parity tail: visible permission modes, compaction status in the UI and TUI, managed file mentions and attachments, unified tool-diff review with per-change accept, a real background queue, todo/plan as structured events, agent/hook/MCP management, dependency-aware checkpoint rewind, user shortcuts | **W**, rewind depends on items 23 and 24 | `PLAN-GAPS.md` §6 items 6a–6i; 2026-09-21 NVIDIA plan Tasks 5–6 | Each surface exists, with the server or shared runtime as the authority for every one of them. |
| 60 | Real browser evidence for streaming, rate limiting, recovery failure and a live pending approval in the compact-GUI harness | **W** — fixtures exist; they were just never injected | 2026-09-23 compact-GUI plan item 5; `GUI-COMPACT-VERIFICATION.md` "Explicit limits" | Those four states are driven in the browser run rather than argued about. |
| 61 | macOS local release candidate: build, launch and a packaged DMG | **W** up to the notarization step | Matrix P10.01, P10.03, "Distribution and retained-format rules"; CHANGELOG Unreleased | Version 1.0.1 is consistent across the four desktop sources (already true) and a built bundle launches with a stable signing identity (already true); what is missing is the packaged artifact. |

### 1.5 Verified-true test counts, for reference

The four iOS simulator destinations, `pnpm test` and typecheck all pass today;
`VOIDTests` is 9/9 and `VOIDUITests` is 18/18 on iPhone Air, iPhone 18 Pro,
iPad Pro 11-inch (M5) and iPad Pro 13-inch (M5). These are not open items and
appear nowhere in the table above. They are stated here once because four
documents record *older* figures for them (§3).

## 2. Reframed and dropped

These are recorded as open work and are not achievable in the form written.
Leaving them on a list is how a plan comes to look perpetually behind.

| Item | Where | Why it is dropped or reframed |
| --- | --- | --- |
| `APPLE-APPS-PLAN.md` A2 (mandatory SwiftUI Mac client) and A3 (iOS local recovery core) | `APPLE-APPS-PLAN.md` A2–A5; `PLAN-STATUS.md` A2, A3 | The document's own header says the 1.0.1 plan supersedes it and "do not execute both architectures". A1's distribution work survives as items 1–3; A2–A5's architecture does not. |
| The NVIDIA plan's `Hook` type and hook executor | 2026-09-21 NVIDIA plan Task 5 Interface block | Retracted by that plan's own header: "`hooksSupported:false`; there is no hook executor." The source agrees. The Interface block is dead text, not open work. |
| "Actual browser 200% zoom" as a checkable gate | 2026-09-23 compact-GUI plan item 5; `GUI-COMPACT-VERIFICATION.md` "Explicit limits" | Recorded as not reliably activatable, with 720×450 reflow used as a proxy. Reframe as: emulated zoom plus a measured reflow, and say so. |
| 1.0.1 plan §10 item 5, "Product code remains unchanged during planning" | 1.0.1 plan §10; matrix D04.12 | The plan header says "planning only … not an implemented capability". The tree is thousands of commits past that. This is not a requirement any more. |
| 1.0.1 plan P00.02's wording, "Reuse void.adapter-capability.v1" | 1.0.1 plan; matrix P00.02 | v1 is retired and the loader refuses a v1 report. The matrix caught this itself; the plan was never updated. |
| D04.09–D04.13 as written | Matrix D04.09–D04.13 | These are the plan's process and approval checklist re-homed under the D04 UI-QA owner, and all five carry D04's gate text, "actual screen capture + viewport/locale/theme/native accessibility matrix". A screen-capture matrix cannot evidence "Next implementation batch is explicitly authorized". Reassign to item 13. |
| P00.02's suggestion that a bare `certification: true` could be recorded | Matrix P00.02, G-06 | The v2 schema refuses exactly that as "not evidence". The question is item 21, not a schema change. |

## 3. Already satisfied, or recorded as open and stale

A stale open item costs as much attention as a real one. Each row here was
checked against the tree, and each is a place where a document currently asks
for work that is done or asserts an absence that is false.

| Stale claim | Where | What the tree shows |
| --- | --- | --- |
| All 22 checkboxes open | `superpowers/plans/2026-09-15-managed-git-recovery.md` | The entire plan is implemented: `git/managed.ts`, `git/managed.test.ts`, the `git.managed` profile, the third recovery config branch, the action-specific MCP schema, `recovery-git.test.ts` and `docs/MANAGED-GIT.md` all exist. |
| All 21 steps open | `superpowers/plans/2026-09-23-r02-legacy-proxy-binding.md` | Tasks 1–4 are delivered plus two extras the plan did not ask for (an S3 cross-layer fixture, `legacy-root.ts`), and `reverse-engine.test.ts:407` asserts completeness over the whole bindable set. |
| Task 1, all 6 items open | 2026-09-21 NVIDIA parity plan | `provider-defaults.ts:2-14` satisfies all three Interface promises literally: `DEFAULT_PROVIDER_ID = "nvidia"`, `DEFAULT_MODEL_ID = "z-ai/glm-5.3-flash"`, and the NIM preset. |
| "there is no Python client in the tree" | `PLAN-GAPS.md` G-12 body | `python/void-transport` exists, has no third-party dependency, and runs 84 tests. The same file's preamble says so. |
| "no separate verifier artifact is published" / "current attestation verifies inside the repo toolchain" | `PLAN-GAPS.md` G-20 body | `packages/verifier/verify-ledger.mjs` imports only `node:crypto`/`fs`/`os`/`path`, has `--selftest`, and is spawned by `packages/cli/src/verify.ts:225` and named in the shipped TUI. What is genuinely open is publication and independent audit — item 17. |
| "a tree wide search for lease or fencing terms returns zero hits" | `PLAN-GAPS.md` G-03 body | `packages/runtime/src/recovery/lease.ts` exists, is imported by `execute.ts:39`, and is claimed, renewed and reclaimed there. |
| "The runtime records no resource read or write sets, no revisions … the planner uses no graph" | `PLAN-GAPS.md` G-04 body | `journal.ts:37-45` declares and `:140-149` validates `resourceKeys`, `readSet`, `writeSet` and `revision`; `recovery/provenance.ts` exports the ordering that `execute.ts:42` consumes. |
| "there is no cloud transactional journal" | `PLAN-GAPS.md` G-01 body | `cloud/recovery.mjs:33-37` and `cloud/store.mjs:22-34` commit signed operation and job events, artifacts and document state in one `pg_advisory_xact_lock`-guarded transaction, and the cloud ledger has an append-only trigger. |
| "no scheduler, lease or external fencing" / "it is not a durable worker lease and offers no fencing" | `RECOVERY-CONTRACT.md`, twice | The local lease shipped. Only *cross-host* fencing remains, and the source does not claim it. |
| Managed Git row: "no durable reconciliation receipt, commit, remote …" | `RECOVERY-COVERAGE.md` "Managed Git" | `git/managed-commit.ts` (63 kB) plus a 99 kB test file are imported by `git/managed.ts:26` and dispatch `{action: "commit"}` through the full lifecycle. Only remote, directory and full-repository recovery are still absent. |
| "## Limits": "There is no commit" and "Both reconciliation methods return unknown" | `docs/MANAGED-GIT.md` | The same file's "## Managed commit slice" section documents commit with `refs/void/operations/` receipts and restart reconciliation. The document contradicts itself. |
| A4 pairing: "not started — No pairing implementation in the tree" | `PLAN-STATUS.md` | `apps/control-plane/api/companion/` exists with a pairing model, five bound operations, hashed device tokens, `timingSafeEqual` comparison, and a 0700-scoped revocation path. |
| A5: "blocked — machine has CLT only" | `PLAN-STATUS.md` | Xcode 27.0 (27A266a) is installed, the Release `iphonesimulator` build succeeds, and four simulator destinations pass. |
| WP-09b: "`void tui --help` currently prints a parse error, needs sibling lane check" | `PLAN-STATUS.md` | Run today: it prints the full view list and exits 0. |
| A1: "Tauri beta with ad hoc signature" | `PLAN-STATUS.md` | `apps/desktop/scripts/build-policy.mjs` resolves `APPLE_SIGNING_IDENTITY`, then a stable keychain identity, then ad-hoc with a spelled-out warning; a notarized run refuses ad-hoc outright. |
| R07 "not started"; R12 "Python transport open"; R14 "bundles, metrics open"; R06 "leases open"; R03 "pins, GC and retention open" | `PLAN-STATUS.md`, REVERSE-TOOL-UPGRADE-PLAN rows | All five shipped in the 2026-09-25/26 wave and are in `CHANGELOG.md` under R03, R06, R07, R12 and R14. |
| "no postgres or git recovery adapter" and "There is no replay apply" | Matrix §"every user-operable surface launched" | `managedPostgresAdapter` (`postgres/managed.ts:654`) and `managedGitAdapter` (`git/managed.ts:44`) both exist and satisfy `RecoveryAdapter`. `void replay` has a real apply path that refuses without signed execution completion and a manifest bound to the capture digest, and opens `VOID_PG_URL` when it has one. What is untested is a run against a *real* Postgres — item 36, not item "no code". |
| "no `keyboardShortcut` in the target" | Matrix D04.03 | `apps/apple/VOIDApp/ChatView.swift:377` has `.keyboardShortcut(.return, modifiers: .command)`. The iPad shortcut work is still open (item 50); this evidence for it is not. |
| `doctor` reports "5 pass, 1 warn" | Matrix §"every user-operable surface launched" | Run today: 4 pass, 2 warn. The new warn is the deliberate degraded-mode notice that verification key material came from signing key material — a change the matrix predates. |
| Windows audit: "16/16 macOS cargo tests" | `WINDOWS-DESKTOP.md` | The matrix says 21/21 and the source has 21 buildable `#[test]` functions. |
| iOS test counts of 6/6, 8/8 and 11 `VOIDUITests` | Matrix, `PLAN-GAPS.md` G-23, `APPLE-APPS-PLAN.md` | 18 `VOIDUITests` and 9 `VOIDTests` today, 18/18 on four destinations. The documents disagree with each other as well as with the tree. |
| `budget.ts` is "51 lines of local only accounting" | `PLAN-GAPS.md` G-14 evidence line | The module carries scope guarantees, compare-and-swap fences, lease expiry and a stale-fence test. The *unwired* part of that module is item 22, which is real. |
| "ledger read limits" both closed (G-16) and missing (G-25) | `PLAN-GAPS.md` G-16 vs G-25 | G-16 records it closed; G-25 lists it as missing. One of the two is wrong and the same file contains both. G-25's remaining scope is item 19. |
| "Status: planning only … not an implemented capability" | 1.0.1 plan header | Superseded by the matrix's own evidence ledger. |
| "First implementation batch after approval: 1. P00" | 1.0.1 plan §7 | P00.01–P00.04 are recorded Done. |
| The plan's only `[x]`, §10 item 2, has no row anywhere | 1.0.1 plan §10 | Grepping the matrix for it returns nothing. The one thing the plan declares done is invisible to the status ledger. |
| G-00 is a scope reference | `GUI-ALLINONE-PLAN.md:173` | `PLAN-GAPS.md` has no G-00 at all, and its G-08 is the legacy proxy binding, not the site claim audit. An unresolvable cross-document ID. |
| R02 plan Task 4: state that S3 "remain[s] unsupported" | 2026-09-23 R02 plan | `packages/connectors/src/reverse-engine.test.ts:297` is an S3 delete/restore cross-layer fixture. Either the doc or the certified scope needs to change; the plan does not say which. |
| Compact-GUI item 5's viewport, theme, locale and focus sub-gates | 2026-09-23 compact-GUI plan; `GUI-COMPACT-VERIFICATION.md` | Closed 2026-09-25/26 by the nine-viewport run and `scripts/src/ui-layout.test.mjs` 22/22 (matrix D04.05, D04.06, D04.08). Only the hardware, zoom and streaming sub-gates survive, and those are items 51 and 60. |
| D03.01 reads as unimplemented because it is "Open" | Matrix D03.01 | The requirement itself is witnessed (`ui-layout.test.mjs:318`); only the family inventory behind it is open, which is item 57. |
| `RECOVERY-COVERAGE.md` header date 2026-09-13 | `RECOVERY-COVERAGE.md` | The file has been edited since; the header date and the counts it warns about are both behind. |

## 4. The ratio, and what it means

Tallying the rows above by what actually blocks the first meaningful step. Every
row is counted exactly once. The list above holds 61 rows; 12 of them are closed
and 49 are open, and the table counts the 49. The three struck on 2026-09-29 are
in the re-run table at the end of this document, and the nine closed before the
re-run are carried in the closed list of `docs/STATUS-INDEX.md` with the commit
that closed each. Rows 23 and 47 are partly closed and count as open. On
2026-09-26, when every row was open, the same tally was 22, 11, 7, 7, 11, 2 and
1, which is 61.

| | Count |
| --- | --- |
| Writable code, nothing outside this machine or a human decision blocks it | **13** |
| Writable code, but the stated acceptance gate needs something outside the machine | **11** |
| Writable code, but a human decision comes first | **7** |
| Blocked purely on a human decision | **4** |
| Blocked purely on something outside the machine | **11** |
| Needs both a human decision and an external resource | **2** |
| Needs a protocol-contract revision, not adapter work (item 46) | **1** |
| **Total open items** | **49** |

Read as the ratio the brief asks for: **31 of the 49 are code that could be
written on this machine today** (13 with nothing at all in the way, 11 whose
code is writable but whose acceptance gate is an Apple account or a disposable
bucket, and 7 that need a decision before the first line). **17 are waiting on
the user or on something outside the machine**, and 1 needs a v1.1 contract
rather than any implementation work.

Set against that, **31 of the roughly 68 open claims in the documents are not
open at all** (§3). Nearly half the apparent backlog is an artefact of
documents that were not reconciled against the tree.

The true writable backlog is also more concentrated than the documents suggest:

- About a third of it is one engine: the planner selectors, universal
  provenance, the budget ledger that has no host, and the postgres and git
  capabilities that exist but are published as absent. Items 22–29.
- A large fraction of the rest is the Apple and Windows distribution chain,
  which is not engineering work at all — an Apple membership, a Developer ID
  identity, a provisioning profile, an App Store Connect role, and somebody to
  press the `workflow_dispatch` button on a workflow that is otherwise ready.
  Items 1–5 and 10.
- The three decisions that actually change what the next quarter is for were
  items 6, 21 and 16: whether the phone ever gets write scope, whether anything
  is ever certified, and whether one vendor is the default. All three are
  answered now, two of them in the re-run table at the end of this document and
  the third in the closed list of `docs/STATUS-INDEX.md`. The re-run found no
  fourth decision of that weight still open.

So: about two thirds of what is left can be written today, and about one third
is blocked on a person or a resource. That ratio is a finding, not a
complaint. The tree has no stubs in it — no `TODO`, no `FIXME`, no unimplemented
marker in first-party source. The project has been building against its own
gates with unusual discipline, and what remains is gated by the world.

## 5. The single largest source of confusion

**`docs/PLAN-STATUS.md` is a second, competing status ledger, using a third ID
namespace, and it is the stalest document in the repository.**

It presents itself exactly like an authoritative ledger: dated, with a
`Status` column, covering `WP-00`–`WP-15`, `R00`–`R14`, `E0`–`E9` and `A1`–`A5`
— fifty-one status rows across four ID namespaces, more than any other
document uses. It was written on 2026-09-16 against `main` at `4c82c37`. Since
then at least nine of its rows are false against the tree, and two of them are
false in the most expensive way possible: **"A4 pairing | not started | No
pairing implementation in the tree"** and **"R07 | not started"**. A reader
who trusts the format rather than checking will conclude there is no phone
pairing and no provenance in a product that has both, and will either rebuild
them or abandon the lane.

The confusion is structural, not a matter of one stale line. The repository has
three status ledgers with three unrelated ID schemes — `P`/`D` in
`RELEASE-1.0.1-MATRIX.md`, `G` in `PLAN-GAPS.md`, `WP`/`R`/`E`/`A` in
`PLAN-STATUS.md` — and **no crosswalk between any pair of them.** The same gap
appears as `G-07` and `R05` and `WP-04b`-adjacent material with no stated
relationship. `GUI-ALLINONE-PLAN.md` even cites a `G-00` that does not exist.
There is no way to ask "is this one thing done?" and get an answer, so people
ask the wrong document and get a wrong answer.

**What I did about it.** This audit treats the tree as the only authority and
publishes no ID of its own. Every row in §1 names its source documents in a
*references* column rather than inheriting an identifier, so the deduplication
is visible and checkable rather than asserted. §1 is the crosswalk the
repository lacks: one row per gap, with every place that gap is recorded listed
against it, and with a verdict on the documents' own conflicting claims. The
recommendation that follows from it is to collapse the three ledgers into one
with a stable ID and a date, and to delete or archive the other two — but that
is a documentation decision with an owner, so it is not done here.

## 6. Findings that contradict the brief or the documents' own framing

1. **The brief's premise that `RELEASE-1.0.1-MATRIX.md` is the main ledger is
   right, but its self-description is not.** The matrix is careful about evidence
   grading and it is right about boundaries. It is *not* current. Three of its
   claims are contradicted by today's tree, all in the section headed "2026-09-26
   every user-operable surface launched": there is "no postgres or git recovery
   adapter" (both exist), "no replay apply" (`void replay` has one), and a
   `doctor` count of 5 pass / 1 warn where running it today gives 4 pass / 2
   warn. A fourth is elsewhere in the document: D04.03's "no `keyboardShortcut`
   in the target", against `ChatView.swift:377`. The section is not uniformly
   stale — it reports today's other work correctly — but four specific sentences
   are.

2. **The matrix systematically understates the tree rather than overstating
   it.** `managed-postgres` ships a full `RecoveryAdapter` with no published
   profile, while the same gate refuses a release containing an adapter with no
   profile, so the gate's own principle is not being applied to the adapter
   set. That is row 28 and it still stands. The `git.managed` half of this
   finding no longer stands: as originally written it said the commit lifecycle
   was real but unadvertised, which was true when the audit ran against
   `63dbd2c` and stopped being true in `39d3c48` (2026-09-26), where `commit`
   joined the published operations and both durable receipt flags became true.
   Corrected in row 29 on 2026-10-02. In the other direction I found no
   overstatement of capability, which is the right way round. But its `P00.01`
   "reconcile stale gaps" row is marked Done on a repository that still carries
   stale open claims (§3), which is the recursion this audit exists to break.

3. **Stale as of the audit's own baseline, corrected in the tree since.** This
   finding said the `RECOVERY-COVERAGE.md` Managed Git row claims "no commit"
   while the adapter has one, and that `docs/MANAGED-GIT.md` contradicts
   *itself* by documenting a commit slice in one section and "There is no
   commit" in another. Neither is true of the current tree. `RECOVERY-COVERAGE.md`
   was reconciled on 2026-09-26 and its Managed Git row now describes the full
   commit lifecycle, the `refs/void/operations/` and `refs/void/recoveries/`
   receipts and `recoverRemote`, and the file's own header records that
   correction and the four source files it was checked against.
   `docs/MANAGED-GIT.md` contains no "There is no commit" sentence. Both
   documents were corrected in the same 2026-09-26 pass that this audit's
   `63dbd2c` baseline predates, so the finding describes a state the tree left
   behind. Corrected 2026-10-02; the underlying Managed Git work is tracked by
   row 30, not here.

4. **The single most consequential open question is not in any of the
   requirement documents.** Nothing in the `P`/`D`/`G` series asks whether the
   iOS companion should ever gain write scope. The shipped app is read-only by
   construction — `AppCopy.swift:143` tells the user that approval and Undo
   happen on the Mac, and `companion/devices.ts:62` makes write pairing an
   operator opt-in that is off by default. Meanwhile P05.03, P06.03 and
   P07.01–P07.04 are all written as though a phone that approves and undoes is
   the plan. Either the app is the plan, in which case a large slice of P07
   should be struck, or the app is a first increment of the plan, in which case
   item 6 is the decision that gates the largest remaining block. Both readings
   are defensible and the documents do not choose.

5. **Not one of the 61 open items is blocked on a missing test framework, a
   missing build, or a missing architectural decision that is not the user's.**
   That is unusual and worth stating plainly: the honest constraint on this
   project is external, not technical.

### Verification performed for this audit

- `node packages/cli/bin/void.mjs --help` and `recovery --help` — 20 subcommands
  confirmed, both exit 0.
- `void doctor` against a disposable `VOID_DATA_DIR` — 4 pass, 2 warn, 0 fail.
- `void tui --help` — exit 0, contradicts `PLAN-STATUS.md` WP-09b.
- Adapter set: `git/managed.ts:44`, `postgres/managed.ts:654` both export
  factories returning `RecoveryAdapter`; `git/managed.ts:457-462` prepares a
  commit and `git/managed.ts:480,498` dispatches it; `recovery.ts` defines the
  six-method contract.
- Conformance: `packages/cli/src/conformance.ts` published exactly three
  profiles on 2026-09-26 and publishes four now, `filesystem.managed`,
  `git.managed`, `managed-documents` and `postgres-managed-conformance`.
  Corrected 2026-10-02: `gitConformanceProfile.operations` now reads
  `["create","write","delete","rename","stage","unstage","commit"]` with
  `durableExecutionReceipt` and `durableRecoveryReceipt` both `true`, and
  `commits` is not an entry in `excluded`. The six-operation list and the
  `commits`-under-`excluded` claim in this bullet were true of `63dbd2c` and
  were overtaken by `39d3c48`.
- `ServerBudgetLedger` / `serverBudgetLedger` — zero consumers outside
  `packages/runtime/src/budget.ts` and its test.
- `void replay` — `packages/cli/src/replay.ts:114-145` has an apply path that
  refuses without signed execution completion and opens `VOID_PG_URL`.
- Route inventory: `apps/control-plane/api/server.ts` and
  `api/companion/`.
- iOS source: 9 `VOIDTests`, 18 `VOIDUITests`; no `URLCache`, logout or
  `signOut` in `apps/apple/`; `keyboardShortcut` at `ChatView.swift:377`.
- `apps/control-plane/api/server.ts:196` — `/api/demo/status` is hardcoded
  `{supported:false, available:false}`; `cloud/demo.mjs:92` exports a real
  `demoRouter`.
- `apps/desktop/src-tauri/tauri.conf.json:16` — bundle targets `["app","dmg"]`,
  no Linux or Windows target.
- `.github/workflows/desktop-windows.yml` — `workflow_dispatch` only.
- `packages/registry/src/registry.ts` — 268 entries on 2026-09-29, not the 270 this
  list recorded on 2026-09-26, so the 500 target is unmet.
- First-party source — no `TODO`, `FIXME` or unimplemented marker.

That pass modified no existing file. The 2026-09-29 re-run at the end of this
document modified this one and no other, and the full `pnpm test` was still not
re-run; the measurements behind the re-run are listed with it.

## 7. Re-run against the tree, 2026-09-29

This is a re-run, not a second audit. Every row above was written on 2026-09-26
against `main` at `63dbd2c` and is left as it was written, because a dated record
that silently absorbs a later correction is not a record. What follows is what
the tree says today, and where the two disagree this section governs.

### 7.1 Closed since this audit was written

| Row | Closed | By what | What closed it |
| --- | --- | --- | --- |
| 6 | 2026-09-26 | "The phone companion stays read-only" in `docs/DECISIONS.md` | The shipped app is read-only by construction, `apps/apple/VOIDApp/AppCopy.swift` already tells the user that approval and Undo happen on the Mac, and pairing a device with write scope is an operator opt-in that is off by default. Matrix `P05.03` is struck at line 946 of `docs/RELEASE-1.0.1-MATRIX.md`, and the read-only half that stays open is implemented and recorded in `docs/IOS-CACHE-AND-REMOVAL-POLICY.md`. |
| 13, architecture bullet | 2026-09-28 | "macOS becomes a SwiftUI target in the same project as iOS" in `docs/DECISIONS.md` | The Tauri vs SwiftUI question is answered and dated. The Tauri shell stays as the desktop distribution that carries the Node sidecar, because that is a packaging question and the earlier answer conflated the two. Matrix `D04.09` and `D04.13`, at lines 1039 and 1043 of `docs/RELEASE-1.0.1-MATRIX.md`, still read Open; this re-run does not correct another ledger, and the disagreement is recorded here instead. The other six bullets of row 13 stay open. |
| 21 | 2026-09-26 | "`certification: false` is the permanent honest answer" in `docs/DECISIONS.md` | Every published capability profile carries the field, `void.adapter-capability.v2` refuses a bare `certification: true` as "not evidence", and the reason is written down rather than widened into a schema for a state that does not exist. The gap the answer exposed stays visible: a profile lists the bound it measured and names the absence in `excluded` rather than leaving the field to be read as a limit. |
| 44 | 2026-09-29 | this document, by stating what is and is not known | The failing test cannot be named, and the reason is that the run that produced it was not retained. `docs/RELEASE-1.0.1-MATRIX.md` records one test failure it could not reproduce and keeps it open "until it can be named"; no output, log, or test identifier from that run survives anywhere in the tree, so there is nothing to name, and re-running the suite would produce a different result rather than identify that one. The row is therefore closed as unnameable rather than left on the list as work nobody can pick up. This is the answer the row asked for, and it is a statement about the record rather than a fix. The matrix still records the failure as open, because the matrix is not this document and this re-run does not edit another ledger. |

Nine further rows were closed before this re-run and are not duplicated here:
9, 12, 16, 22, 28, 29, 35, 41 and 49, each with the commit that closed it in
the closed list of `docs/STATUS-INDEX.md`. Rows 23 and 47 are partly closed and
count as open. Twelve of the 61 rows are therefore closed and 49 are open, which
is the set section 4 now counts.

### 7.2 What else this re-run corrects

- **The "exactly three profiles" line in the 2026-09-26 verification list is
  now corrected in place.** The set publishes four ids: `filesystem.managed`,
  `git.managed`, `managed-documents` and `postgres-managed-conformance`, the
  last one scoped to the configured workspace rather than to a provider. The
  count of three was true on 2026-09-26.
- **Section 6 finding 2 is superseded for the same reason.** It reports that
  `managed-postgres` ships a full `RecoveryAdapter` with no profile at all. That
  stopped being true when the fourth profile was published, and the set is
  fail-closed in both directions: `resolveProviderProfile` in
  `packages/connectors/src/capability-profiles.ts` refuses an adapter id the set
  does not publish and names the ids that do exist, so an adapter cannot ship
  unnamed.
- **Section 6 finding 4 is answered.** The companion write-scope question was
  open when this audit was written and was decided on 2026-09-26, so the largest
  remaining block it names is no longer gated on a decision.
- **Row 16 is answered as well, and is not re-litigated here.** The default
  provider question was decided on 2026-09-26 and `docs/STATUS-INDEX.md` already
  carries it in its closed list. The row stays in the table above as it was
  written, so this document does not duplicate a list that exists elsewhere.
- **The registry count was wrong here twice.** Row 20 and the verification list
  above both said 270 entries. The tree has 268, and the executable ratio is two
  denominators rather than one; the errata at the end of `docs/ROADMAP-2026-Q4.md`
  states both.

### 7.3 Measurements taken for this re-run

- `registry` in `packages/registry/src/registry.ts`, imported and measured
  directly: 268 entries, and 48 distinct vendors from `registryVendors()`. The
  `grep -c '^    id:'` form named in `docs/PLAN-GAPS.md` returns the same 268.
- `LEGACY_BINDING_NAMES` in `packages/proxy/src/legacy-root.ts`: three names,
  `postgres.row.update`, `postgres.row.delete` and `aws.s3.object.delete`, and
  all three are registry entry ids.
- `providerProfiles` in `packages/cli/src/conformance.ts`: the four ids named
  above, none of which is a registry entry id.
- `node scripts/src/check-tests.mjs`, run 2026-09-29: `13 suites, 1817 tests`,
  exit 1, with one failing test in `scripts/src/design-token.test.mjs` in a file
  a concurrent change owned at the moment of the run. The count of green tests
  on a settled tree is therefore unverified, and no replacement figure is
  asserted here.

Not verified by this re-run: whether the four remaining decisions in row 13 have
since been answered outside this tree, and whether any of the 58 open rows
changed for a reason that leaves no trace in a commit or a dated decision. Those
need a reading of the source, not a count.

## 8. Measured 2026-10-01

Four items from the 2026-09-30 strategy audit were reproduced and fixed on this
date, each with a test that fails on the previous code: the recovery takeover
that could not record itself (`lease-expired`), the MCP response that reached
the server under the agent's id, the ledger file created without a mode, and
the agent conversation's `requestDigest`, which could not see the conversation
it was digesting. Each is described in `CHANGELOG.md` under Unreleased with the
file and line that carried the defect.

One item from that audit is reproduced and **not** fixed, because the fix the
defect suggests is weaker than the guarantee it would break.

### Consecutive effects on one path break the recovery chain

Executed against `packages/connectors/src/filesystem/managed.ts` through the
real runtime: two writes to the same path in one run, then a recovery job over
both operations.

```
first  write: succeeded        (file: original -> second)
second write: succeeded        (file: second   -> third)
job status  : conflict checkpoint 1
residuals   : [{"operationId":"op-one","status":"conflict"}]
file content: second
expected    : original
```

The cause is in the comparison itself, not in the planner. `snapshot()` folds
`dev`, `ino`, `ctimeNs`, `uid` and `gid` into `revision`
(`managed.ts:202-211`), `execute` records that revision as the operation's
evidence (`:418`), and `recover` refuses unless the file still carries it
(`:479-482`). The first restore replaces the file, so the inode the second step
recorded is gone, and the step that would finish the undo cannot start.

The obvious fix is to compare content and mode instead of inode identity, and it
makes both chain tests pass. It was reverted because it also makes the
documented ABA case pass: `managed.test.ts:206` writes "human" over the
agent's file and then writes the agent's own bytes back, and that test requires
a conflict. Content equality cannot separate "an earlier step of this job
restored this file" from "a foreign writer replaced it with identical bytes",
because the two are the same observation. A fix therefore has to carry lineage,
not a weaker comparison.

Two shapes that would work, neither small:

- **Durable, schema-bearing.** Each recovery step returns the revision it
  wrote; the runtime records it in the checkpoint event and passes the previous
  step's revision into the next `adapter.recover`. The payload validator in
  `packages/runtime/src/recovery/plan.ts` enforces exact keys, so the field is a
  signed-schema change, and it survives a restart because it lives in the
  journal rather than in the adapter process.
- **Process-local.** The adapter remembers the revisions it wrote per path and
  accepts those. Two lines, and it does not survive a restart, so it would fix
  the reproduction above and still fail the acceptance case
  `docs/strategy-2026-09-30/BACKLOG.md` E0 asks for, which runs the chain
  across a runtime restart. Shipping it would mean claiming less than the
  requirement states.

This is a design decision rather than a defect with an obvious patch, and the
audit's own classification ("not a one-sitting slice if the lineage design is
reworked") is the accurate one.

### Follow-up, 2026-10-01: adjacent resource lineage implemented

The two-write reproduction above now passes in the merged `main` tree. The
runtime derives a continuation only from the preceding restored step in the
same signed recovery plan, and binds it to the workspace, plan digest,
operation order, adapter version, resource and scope. Filesystem recovery uses
the prior signed recovery receipt as the expected revision, preserving conflict
on an external same-byte rewrite. Managed PostgreSQL supports the bounded
one-row `UPDATE`→`UPDATE` path and reconciles a lost inverse response after
restart without applying it twice. Standalone recovery receives no
continuation.

Evidence: `packages/runtime/src/recovery-job.test.ts` covers filesystem
write→write restoration and same-byte ABA refusal;
`packages/connectors/src/postgres/managed.test.ts` covers same-row update
chains, ABA refusal, and lost-response reconciliation. Those suites and the
runtime/connectors typechecks passed on 2026-10-01. The
specific two-write defect documented above is therefore closed. The larger E0
acceptance in `docs/strategy-2026-09-30/BACKLOG.md` remains partial: its combined
create→write→write→rename→delete journey, injected same- and cross-path edits
throughout that journey, and every crash point around the full chain have not
all been exercised as one acceptance scenario.

## 9. Measured 2026-10-02: the conformance runner failed open on an operation
it did not implement

Correcting row 29 above meant reading `packages/cli/src/conformance.ts` rather
than trusting the row, and that surfaced a defect the audit's stale row had been
pointing at without seeing. It is recorded here because it is a live
correctness problem, not a documentation one, and because a green conformance
report is exactly the kind of evidence this document has been asked to trust.

**The claim above `fixtureFor` is false.** Its comment says an operation the
resolved fixture does not accept "is refused by that fixture's own scenario
check, so a profile that gains an operation nobody implemented stops the run
instead of measuring the nearest operation it does have". The code does not do
that. `fixtureFor` casts the profile's published operation to the fixture's
scenario union with `operation as GitScenario` and the other two equivalent
casts, which asserts a type the runtime never checks, and each fixture body
branches on `operation ===` with a final `else` that is the `write` path.

Measured 2026-10-02 on this tree, driving the shipped `runAdapterConformance`
against the shipped `gitConformanceFixture`:

```
operation=rebase   passed=true checks=8 failing=0
operation=write    passed=true checks=8 failing=0
```

`rebase` is not an operation `gitConformanceProfile` publishes and no fixture
implements it. It returned `passed=true` with the same eight checks as `write`,
which is the fail-open the comment claims cannot happen: an operation a profile
lists and nobody built would fall through to the nearest implemented one and be
reported as measured. The cast hides it from the type checker, and the eight
checks are byte-identical to a real run, so nothing in the report distinguishes
the two.

**Why it matters beyond the one case.** A conformance run is the evidence a
release rests on, and this is the one place a run could report success for work
that was never performed. The exposure is bounded in the current tree because
every published operation happens to have a fixture, so no shipped profile
triggers it today; the defect is that the safety property is documented and not
implemented, which means the first profile to gain an operation without one
gets a green report. The fix is to refuse an operation the resolved fixture
does not implement, before any fixture is built, rather than to keep a cast
that promises a check the code never performs. That is code work in
`packages/cli/src/conformance.ts`, outside this document's lane, and it is
recorded as open rather than done: the correction in row 29 fixes the stale
claim, not this.

While correcting row 29, section 6 finding 3 was found to be stale in the same
way and for the same reason. It reported that the `RECOVERY-COVERAGE.md`
Managed Git row says "no commit" and that `docs/MANAGED-GIT.md` contradicts
itself with a "There is no commit" sentence. Both were reconciled on
2026-09-26, in the same pass that this audit's `63dbd2c` baseline predates:
the coverage row now describes the commit lifecycle, its receipts and
`recoverRemote`, and its own header records the correction against the four
source files it was checked against, and `docs/MANAGED-GIT.md` contains no such
sentence. That is the second time in this file that a row outlived the tree it
described, and it is the argument for section 5's point about a second
competing status ledger: a status document that is not re-read against the tree
accumulates confident sentences about code that has since moved.

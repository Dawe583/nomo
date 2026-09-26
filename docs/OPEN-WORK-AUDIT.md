# VOID open-work audit

Written 2026-09-26 against `main` at `63dbd2c`. This document reconciles the
planning and evidence documents against the tree. It is not a summary of the
repository and it is not a roadmap: it is a list of what is still open, with
each item classified by what is actually blocking it.

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

### 1.1 Distribution, signing and the stores — almost entirely external

| # | Item | Class | Recorded in | What done looks like |
| --- | --- | --- | --- | --- |
| 1 | Mac App Store signed-sandbox build and the seven sandbox behaviours it must support (entitlement inheritance, security-scoped folder access, child-process and arbitrary-tool restrictions in store mode, clean shutdown, no orphan runtime, the Tauri-vs-SwiftUI-vs-store-companion architecture call) | **X** (the architecture half is **D**) | Matrix P01.01–P01.07; plan §8; `APPLE-APPS-PLAN.md` A5 | A signed, sandboxed `.app` installs from a build, and a real capture + Undo plus an iPhone/iPad TLS fixture is recorded from it. |
| 2 | Developer ID Application identity, notarization, stapling and a published DMG with a matching SHA-256 | **X** | Matrix P10.03 (notarization half); `PLAN-GAPS.md` G-22; `APPLE-APPS-PLAN.md` A1; `WINDOWS-DESKTOP.md` is not the source | `spctl` accepts the artifact, a `notarization stapled` receipt exists, and a published download returns those bytes. |
| 3 | iOS/iPadOS distribution: provisioning profile for `com.void.companion`, `DEVELOPMENT_TEAM` in the project, archive, TestFlight, App Store Connect | **X** | Matrix P10.04, P11.01–P11.06; `PLAN-GAPS.md` G-23 | An archive of the exact candidate is accepted by App Store Connect and installs on a physical device. |
| 4 | Windows desktop: current-source packaging, installed-application smoke and Windows filesystem/Git recovery evidence before any download is advertised | **X**, with a human step — the workflow is `workflow_dispatch`-only, so somebody has to press it | Matrix P10.09; `PLAN-GAPS.md` G-07 (Windows half), G-24; `WINDOWS-DESKTOP.md` W1–W11; `RECOVERY-COVERAGE.md` filesystem and Git rows | A green run of `.github/workflows/desktop-windows.yml` on current source: NSIS installer, silent install, `--smoke-test` exit 0, SHA-256 published. |
| 5 | Linux native packaging — not even a bundle target in `tauri.conf.json` | **X** | `PLAN-GAPS.md` G-24 only | A Linux build and a full recovery suite on the exact candidate. |
| 6 | Whether the phone companion ever gets write scope, or stays read-only for good | **D** | Matrix P05.03, P06.03, P07.01–P07.04, D04.02; `PLAN-GAPS.md` G-23; `APPLE-APPS-PLAN.md` A4 | A written decision. `apps/apple/VOIDApp/AppCopy.swift:143` already tells the user approval and Undo happen on the Mac; if that is the answer, most of P07 stops being work. |
| 7 | App Store metadata, privacy labels, retention/deletion policy, support contact, reviewer instructions, screenshots, age rating, accessible test executor | **X** for the review account and reachability, **W** for the documents | Matrix P10.05, P10.07 | A privacy label and a review-notes document exist, and a reviewer can reach a safe executor. |
| 8 | Export-compliance classification for the encryption the product ships | **D** — the matrix itself says it "cannot be inferred from source" | Matrix P10.06 | An operator records the classification and sets `ITSAppUsesNonExemptEncryption` deliberately. |
| 9 | Account deletion path | **W**, narrowly. The docs say do not invent one, and no mounted route creates an account: `cloud/server.mjs` does not mount `cloud/auth.mjs`'s signup, the Supabase broker refuses signup while `VOID_ACCOUNT_SIGNUP` is unset, and no route accepts the invitation code one would need. Note that the trigger moved: a provider account can now sign in over `POST /api/account/signin` and own rows, so deletion becomes real work at the first real sign in, not at the first mounted signup | Matrix P10.08 | Either a tested deletion route, or a recorded statement that no account exists. |
| 10 | External beta cohort: 10 testers across the device matrix, 7 days, 100 recorded recovery journeys, incident review, retained binaries, documented rollback, emergency disablement | **X** | Matrix P11.01–P11.06; 1.0.1 plan §4 | The cohort runs and its incidents are reviewed. |
| 11 | Support, legal and privacy owners named | **D** | Matrix P10.05; 1.0.1 plan §8 | Three names exist. Nothing can be written until then. |
| 12 | `docs/GO-TO-MARKET.md` is marked confidential and must leave the tree before any open-core publication | **W** (one deletion) | `PLAN-GAPS.md` §8 | The file is gone or un-confidentialised. |

### 1.2 Decisions that are the user's, not the engineer's

| # | Item | Class | Recorded in | What done looks like |
| --- | --- | --- | --- | --- |
| 13 | The 1.0.1 plan's eight approval bullets: Tauri vs SwiftUI, local-network-only vs funded server connectivity, pricing/IAP, locked-Mac mutation policy, one-device-approval sufficiency, and the "if 1.0.0 was never released, say why the public version is 1.0.1" question | **D** | 1.0.1 plan §1 and §10 items 1 and 6; matrix D04.09, D04.13; `PLAN-GAPS.md` §8 | Each bullet is answered in writing. |
| 14 | Approved visual direction for Mac, iPhone and iPad, and the navigation structure | **D** | Matrix D01.01–D01.05, D04.09 | One direction is chosen before the design-system work starts. |
| 15 | Site claims audit: the site still shows latency and tool-count figures the reverse plan already flags as non-evidence; and it prices in EUR | **D** + **W** | `PLAN-GAPS.md` G-06 (the site half), §8; `GUI-ALLINONE-PLAN.md:173` | Each claim is either evidenced or removed; the pricing currency is chosen. |
| 16 | Whether NVIDIA NIM / GLM 5.3 Flash should be the hardcoded default provider | **D** | `packages/workbench/src/provider-defaults.ts:2`; `2026-09-21-nvidia-product-parity.md` Task 1, Task 8 | A decision. The matrix's own 2026-09-26 correction says the model is the operator's choice and the surface is provider-agnostic, while the source makes one vendor the default. Both cannot be the position. |
| 17 | Whether to publish and independently audit the standalone ledger verifier outside the repository | **D** + **W** (the fixtures) | `PLAN-GAPS.md` G-20 residual | A versioned artifact a third party can fetch, plus an independent audit of the replicated canonicaliser. |
| 18 | npm `@void` scope ownership and release authorization | **X** + **D** | `PLAN-GAPS.md` G-16, G-20, and the consolidated external-resources list | The scope is owned and someone is authorized to publish. |
| 19 | Production KMS and key-rotation drill | **X** for the KMS, **W** for the drill procedure | `PLAN-GAPS.md` G-25; `docs/BETA.md`, `docs/RELEASE.md` | A rotation is performed and its evidence recorded. |
| 20 | Registry breadth target: 270 entries today, goal 500, with "human review per batch" | **D** on the target and the review, **W** on the pipeline | `PLAN-GAPS.md` G-17; `PLAN-STATUS.md` WP-04b; `EXECUTION-PLAN.md` WP-04b | A validated batch pipeline exists and someone has decided whether 500 is still the number. |
| 21 | Whether any adapter is ever going to claim certification, or `certification: false` is the permanent honest answer | **D** | Matrix P00.02, G-06; `RECOVERY-COVERAGE.md` "Verification interpretation" | A decision, written down. The schema currently refuses a bare `certification: true` as "not evidence", so there is nowhere to record a certification that does not exist. |

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
| 29 | `git.managed` implements a complete commit lifecycle — capture, prepare, execute, reconcile, recover, reconcileRecovery, with `refs/void/operations/` receipts and atomic compare-and-swap — and the published profile lists `commits` under `excluded` and omits it from `operations`. The code is real; nothing advertises it. | **W** | `packages/connectors/src/git/managed.ts:357-475` vs `packages/cli/src/conformance.ts:158,164`; `PLAN-GAPS.md` G-07; `RECOVERY-COVERAGE.md` "Managed Git" row; `docs/MANAGED-GIT.md` | Either a `commit` operation in the profile with its own conformance scenarios, or a stated reason why a tested capability stays unpublished. |
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
| 44 | The one unreproduced test failure, still unnamed | **W** | Matrix §"One unreproduced test failure, recorded rather than forgotten" | The failing test is named and either fixed or explained. The matrix is explicit that "a flake in a security product is a finding in its own right, and this one is open until it can be named." |

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

Tallying all 61 rows of §1 by what actually blocks the first meaningful step.
Every row is counted exactly once.

| | Count |
| --- | --- |
| Writable code, nothing outside this machine or a human decision blocks it | **22** |
| Writable code, but the stated acceptance gate needs something outside the machine | **11** |
| Writable code, but a human decision comes first | **7** |
| Blocked purely on a human decision | **7** |
| Blocked purely on something outside the machine | **11** |
| Needs both a human decision and an external resource | **2** |
| Needs a protocol-contract revision, not adapter work (item 46) | **1** |
| **Total open items** | **61** |

Read as the ratio the brief asks for: **40 of the 61 are code that could be
written on this machine today** — 22 with nothing at all in the way, 11 whose
code is writable but whose acceptance gate is an Apple account or a disposable
bucket, and 7 that need a decision before the first line. **21 are waiting on
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
- The three decisions that actually change what the next quarter is for are
  items 6, 21 and 16: whether the phone ever gets write scope, whether anything
  is ever certified, and whether one vendor is the default. All three are the
  user's calls, and all three are cheaper to make than to keep deferring.

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
   it.** `git.managed` ships a full commit lifecycle that no published profile
   advertises, and `managed-postgres` ships a full `RecoveryAdapter` with no
   profile at all — while the same gate refuses a release containing an adapter
   with no profile, so the gate's own principle is not being applied to the
   adapter set. In the other direction I found no overstatement of capability,
   which is the right way round. But its `P00.01` "reconcile stale gaps" row is
   marked Done on a repository that still carries 31 stale open claims (§3),
   which is the recursion this audit exists to break.

3. **`RECOVERY-COVERAGE.md` is the document a reader would trust most and it is
   the second stalest.** Its Managed Git row says "no commit"; the adapter has
   one. `docs/MANAGED-GIT.md` does not merely drift — it contradicts *itself*,
   documenting a commit slice with receipts in one section and "There is no
   commit" in another. A reader cannot resolve that without reading 160 kB of
   TypeScript.

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
  factories returning `RecoveryAdapter`; `git/managed.ts:357-475` dispatches
  `commit`; `recovery.ts` defines the six-method contract.
- Conformance: `packages/cli/src/conformance.ts` publishes exactly three
  profiles; `gitConformanceProfile.operations` is
  `["create","write","delete","rename","stage","unstage"]` with `commits` under
  `excluded`.
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
- `packages/registry/src/registry.ts` — 270 entries, so the 500 target is unmet.
- First-party source — no `TODO`, `FIXME` or unimplemented marker.

No existing file was modified. The full `pnpm test` was not re-run; the
targeted checks above were used instead, per the brief.

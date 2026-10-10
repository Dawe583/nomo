# Status index: one question, three ledgers, and the crosswalk

Written 2026-09-26 after the decision recorded in `docs/DECISIONS.md`, and
updated 2026-09-29 against the re-run of `docs/OPEN-WORK-AUDIT.md`. Three
documents in this repository present themselves as status ledgers, none of them
knows about the other two, and they use three unrelated id namespaces. The
consequence is not tidiness: a reader who asks "is this one thing done?" gets
three answers and no way to tell which is current. `docs/OPEN-WORK-AUDIT.md` §5
is the finding; this file is the index the repository was missing.

It is an index, not a fourth ledger. Nothing here is a status claim. Where a
cell says a gap is recorded in three places, that is a fact about the documents,
not an agreement between them, and the three may still disagree.

## Which document answers which question

| Question | Ask | Not |
| --- | --- | --- |
| What does the 1.0.1 release require, and what evidence grade does each requirement have? | `docs/RELEASE-1.0.1-MATRIX.md`, ids `P00.01`-`P11.06` and `D01.01`-`D04.13` | Not a schedule and not a statement that anything shipped |
| What is missing from the reverse and recovery engine, and what is each gap blocked on? | `docs/PLAN-GAPS.md`, ids `G-01`-`G-26` | Not a requirements list; several rows have no requirement row at all |
| What was each work package supposed to deliver? | `docs/PLAN-STATUS.md`, ids `WP-00`-`WP-15`, `R00`-`R14`, `E0`-`E9`, `A1`-`A5` | Not current. It was written on 2026-09-16 against `main` at `4c82c37` and at least nine of its rows are false against the tree |
| What is still open, classified by what actually blocks it? | `docs/OPEN-WORK-AUDIT.md` rows 1-61, of which 49 are open after the 2026-09-29 re-run | Not a plan and not a summary |

The authority for any factual claim is the tree. A status document is a record
of what somebody believed on a date, and this repository has a gate
(`scripts/src/doc-truth.test.mjs`) that fails when a document names a file that
does not exist, precisely because documents here have drifted.

## The namespaces

| Namespace | Document | Rows | Written |
| --- | --- | --- | --- |
| `P`, `D` | `docs/RELEASE-1.0.1-MATRIX.md` | 128 | continuously |
| `G` | `docs/PLAN-GAPS.md` | 26 | continuously |
| `WP`, `R`, `E`, `A` | `docs/PLAN-STATUS.md` | 48 | 2026-09-16, against `4c82c37` |

There is no id in one namespace that means the same thing as an id in another.
`G-07` and `R05` both concern managed Git; `WP-04b` concerns the registry; and
`docs/GUI-ALLINONE-PLAN.md` cites a `G-00` that does not exist in
`docs/PLAN-GAPS.md` at all. That is the reason for this file.

## The crosswalk

One row per gap, with every place that gap is recorded listed against it. The
gap text, its class and its references are taken from `docs/OPEN-WORK-AUDIT.md`
section 1, which reconciled all three ledgers against the tree on 2026-09-26.
An empty cell means no document in that namespace records the gap, which is
itself the finding: it is why a reader asking the wrong document gets told a
thing is finished.

The table carries 58 rows, because rows 6, 21 and 44 left it on 2026-09-29 and
are in the closed table below. It is not a list of open work: 49 of its rows are
open and 12 are closed, the 9 that were already closed when this index was
written still being here. Use the closed table, not the row count, to decide
whether something is open.

| # | Gap | Class | Recorded in the matrix (`P`/`D`) | Recorded in `PLAN-GAPS` (`G`) | Recorded in `PLAN-STATUS` (`WP`/`R`/`E`/`A`) |
| --- | --- | --- | --- | --- | --- |
| 1 | Mac App Store signed-sandbox build and the seven sandbox behaviours it must support (entitlement inheritance,… | X (the architecture half is D) | P01.01, P01.02, P01.03, P01.04, P01.05, P01.06, P01.07 | — | A5 |
| 2 | Developer ID Application identity, notarization, stapling and a published DMG with a matching SHA-256 | X | P10.03 | G-22 | A1 |
| 3 | iOS/iPadOS distribution: provisioning profile for `com.void.companion`, `DEVELOPMENT_TEAM` in the project, arc… | X | P10.04, P11.01, P11.02, P11.03, P11.04, P11.05, P11.06 | G-23 | — |
| 4 | Windows desktop: current-source packaging, installed-application smoke and Windows filesystem/Git recovery evi… | X, with a human step — the workflow is `workflow_dispatch`-only, so somebody has to press it | P10.09 | G-07, G-24 | — |
| 5 | Linux native packaging — not even a bundle target in `tauri.conf.json` | X | — | G-24 | — |
| 7 | App Store metadata, privacy labels, retention/deletion policy, support contact, reviewer instructions, screens… | X for the review account and reachability, W for the documents | P10.05, P10.07 | — | — |
| 8 | Export-compliance classification for the encryption the product ships | D — the matrix itself says it "cannot be inferred from source" | P10.06 | — | — |
| 9 | Account deletion path | W, narrowly — the docs say do not invent one; `cloud/server.mjs` does not mount `cloud/auth.mjs`'s signup | P10.08 | — | — |
| 10 | External beta cohort: 10 testers across the device matrix, 7 days, 100 recorded recovery journeys, incident re… | X | P11.01, P11.02, P11.03, P11.04, P11.05, P11.06 | — | — |
| 11 | Support, legal and privacy owners named | D | P10.05 | — | — |
| 12 | `docs/GO-TO-MARKET.md` is marked confidential and must leave the tree before any open-core publication | W (one deletion) | — | — | — |
| 13 | The 1.0.1 plan's eight approval bullets: Tauri vs SwiftUI (closed 2026-09-28, see the closed table), local-network-only vs funded server connectivity, p… | D | D04.09, D04.13 | — | — |
| 14 | Approved visual direction for Mac, iPhone and iPad, and the navigation structure | D | D01.01, D01.02, D01.03, D01.04, D01.05, D04.09 | — | — |
| 15 | Site claims audit: the site still shows latency and tool-count figures the reverse plan already flags as non-e… | D + W | — | G-06 | — |
| 16 | Whether NVIDIA NIM / GLM 5.3 Flash should be the hardcoded default provider | D | — | — | — |
| 17 | Whether to publish and independently audit the standalone ledger verifier outside the repository | D + W (the fixtures) | — | G-20 | — |
| 18 | npm `@nomo` scope ownership and release authorization | X + D | — | G-16, G-20 | — |
| 19 | Production KMS and key-rotation drill | X for the KMS, W for the drill procedure | — | G-25 | — |
| 20 | Registry breadth target: 268 entries today (re-measured 2026-09-29; the file said 270), goal 500, with "human review per batch". Of the 268, three are executable through the legacy proxy root and four managed adapters run under names that are not registry entries, so the two are separate denominators; the errata in `docs/ROADMAP-2026-Q4.md` states both | D on the target and the review, W on the pipeline | — | G-17 | WP-04b |
| 22 | Wire the R10 server budget ledger into a real host. `serverBudgetLedger` in `packages/runtime/src/budget.ts` h… | W | — | G-14 | R10 |
| 23 | Planner selectors: dependency, time and checkpoint selection; independent branch continuation; a cloud MCP job… | W | — | G-03 | R06 |
| 24 | Populate `readSet` / `writeSet` / `revision` for every adapter at dispatch, and compute descendant closure gen… | W | — | G-04 | R07 |
| 25 | Wire the legacy taint graph in `packages/ledger/src/taint/` into the R06 planner | W, depends on 24 | — | G-19 | WP-12 |
| 26 | Staged hold, dependency barriers and cascading cancel | W | — | G-05 | R11 |
| 27 | Cloud/distributed budgets, visible policy modes, weighted costs and staged reservations | W for the code, D for how far "cloud" is meant to go | — | G-14 | — |
| 28 | `managed-postgres` has no capability profile and no conformance suite. The release gate publishes exactly thre… | W — PGlite is in-process, no service needed | — | — | — |
| 29 | `git.managed` implements a complete commit lifecycle — capture, prepare, execute, reconcile, recover, reconcil… | W | — | G-07 | — |
| 30 | Git remote recovery, append-only revert / recovery PR, and the noncooperative-writer boundary | W for the first two, X for full per-hunk cross-platform evidence | — | G-07 | R05 |
| 31 | Managed S3 and Supabase adapters with versionId and delete-marker handling | W for the adapter, X for the stated gate ("tested against disposable services") | — | G-10 | R08 |
| 32 | GitHub and Vercel executable recovery: file and commit with SHA binding, merge via recovery PR | W for the adapters, X for sandbox conformance | — | G-11 | R09 |
| 33 | Managed-vault artifact streaming, pin release, retention-index backup and administrative quota migration | W | — | G-09 | R03 |
| 34 | Cloud fault matrix: disk exhaustion and in-flight PostgreSQL client SIGKILL | W for the local harness, X for the physical cases | — | G-01 | — |
| 35 | Document the explicit `migrateManagedPostgres` v1→v2 metadata command path, which tool execution deliberately… | W | — | G-02 | — |
| 36 | Real-server Postgres certification: cascade, tenant/RLS, migration, in-flight client kill, network partition | X — needs a disposable isolated Postgres and a network-fault harness; the gates are code, the target is not | P09.03 | G-02 | — |
| 37 | Provider-specific blast-radius measurement and provider certification fixtures | W for the fixtures, X for the sandboxes | — | G-12, G-18 | R12, R08 |
| 38 | Remote executor authentication and a managed egress allowlist, with `nomo doctor` / `nomo init` verifying them | W | — | G-13 | R13 |
| 39 | SDK framework `wrap` for Vercel AI SDK, OpenAI Agents SDK and LangGraph | W, human-gated — the stated dependency is literally "a real proxy user" | — | G-21 | WP-14 |
| 40 | Legacy proxy binding in a production composition root, plus one honest conformance fixture per external tool | W, with the S3/cloud fixtures waiting on item 31 | — | G-08 | R02 |
| 41 | One operational certification run recorded | W — a run, not a build | — | G-15 | R14 |
| 42 | Transport hardening tail: key-rotation drill (S09), transport bounds and backpressure (S10), typed request ide… | W except the publish authorization | — | G-16 | WP-15 |
| 43 | A whole-tree green under the new explicit CI time budgets | W — a run, not a build. `pnpm test` is 671 s against a 25-minute step budget; the old shared-deadline result was the reason a killed `git.managed` run once looked green | P02.06, P03.01, P03.06 | — | R02 |
| 45 | Freeze the companion protocol properly: shared Swift/TypeScript fixtures for every outcome, the boundary-and-b… | W for the fixtures and the matrix, D for who reviews | P04.01, P04.02, P04.03, P04.04, P04.05 | — | — |
| 46 | Publish `device.pair` in the handshake capability catalog | R as an adapter change — it needs a v1.1 contract change, because the frozen catalog derives from the frozen `operations` set | — | — | — |
| 47 | Paired-device security: start-pairing with invitation expiry and single use, native secure credential storage,… | W as code, gated on item 6 | P05.01, P05.02, P05.03, P05.04, P05.05, P05.06 | — | — |
| 48 | A paired-phone journey over a real TLS transport, on a physical device, with Developer Mode and local-network… | X | P09.02, P07.05, P07.06, P09.06 | G-23 | — |
| 49 | iOS cache retention/redaction and logout or device-removal cleanup. There is no `URLCache` handling, no logout… | W | P06.05 | — | — |
| 50 | iPad inspector, chat detail and multi-window keyboard shortcuts. The matrix's evidence for "no keyboard shortc… | W | D04.03 | — | — |
| 51 | Native VoiceOver, physical keyboard, safe areas, rotation, Dynamic Type and background lifecycle | X | P09.06, D04.06, D04.08 | — | E8 |
| 52 | Desktop new-user flow: a guided safe-workspace exercise, a running build/version/channel strip, actionable per… | W | P08.01, P08.02, P08.03, P08.04, P08.05 | — | — |
| 53 | Stale provider bootstrap instructions and stale beta download links | W — except verifying links after publication, which needs a publication | P08.06 | — | — |
| 54 | Packaged-artifact install, upgrade, rollback, unsupported-newer-format refusal and uninstall/reinstall, with n… | X — needs a packaged, signed build | P09.01, P09.03, P09.04, P10.02 | — | — |
| 55 | Real provider streaming in an explicitly authorized bounded-cost sandbox | X — the matrix says "Without credentials/budget, leave that gate open; fixtures cannot close it" | P09.05 | — | — |
| 56 | Performance and load budgets on a device and network profile | X | P09.07 | — | — |
| 57 | Design-system families: D03.02–D03.30 have no real consumer, interaction states or gallery entry. D03.22 (back… | W | D03.01, D03.02, D03.03, D03.04, D03.05, D03.06, D03.07, D03.08, D03.09, D03.10, D03.11, D03.12, D03.13, D03.14, D03.15, D03.16, D03.17, D03.18, D03.19, D03.20, D03.21, D03.22, D03.23, D03.24, D03.25, D03.26, D03.27, D03.28, D03.29, D03.30, D02.01, D02.02, D02.03, D02.04, D02.05, D02.06 | — | — |
| 58 | Per-route search, detail views, paging, export and dialogs on the Mac web surface; the local `/demo` route is… | W | D04.01 | — | — |
| 59 | GUI/TUI parity tail: visible permission modes, compaction status in the UI and TUI, managed file mentions and… | W, rewind depends on items 23 and 24 | — | — | — |
| 60 | Real browser evidence for streaming, rate limiting, recovery failure and a live pending approval in the compac… | W — fixtures exist; they were just never injected | — | — | — |
| 61 | macOS local release candidate: build, launch and a packaged DMG | W up to the notarization step | P10.01, P10.03 | — | — |
## What the empty cells mean

Read the coverage, not the individual rows:

- **Six gaps are recorded in none of the three ledgers**: rows 12, 16, 28, 46, 59
  and 60. Three of those are closed, rows 12, 16 and 28, so of the 49 open gaps
  three are tracked nowhere: 46, 59 and 60. Row 28 was the managed PostgreSQL
  adapter that no capability profile named, which is now published. A gap no
  ledger records is a gap nobody is tracking.
- **Two gaps are recorded in all three**: the managed PostgreSQL capability
  profile and the Git commit lifecycle, which the audit found as code that
  existed and no document advertised. Both are closed.
- **Fifty of the fifty-eight rows are recorded in one or two of them.** That is
  the structural finding: the same work is tracked in places that cannot see
  each other, so closing it in one leaves the other two claiming it is open.

## How to ask whether one thing is done

1. Find the gap in the table above. If the cell is empty for a namespace, that
   document does not track it, and its silence is not evidence.
2. Read the source the row names. `docs/OPEN-WORK-AUDIT.md` names a file and a
   line for most rows precisely so the answer does not depend on a status
   column.
3. Treat a `done` or `Closed` cell as a claim with a date on it. Nine rows in
   `docs/PLAN-STATUS.md` are false against the current tree, including two that
   would have caused a reader to rebuild or abandon a lane.

## Closed since the audit was written

The audit is a dated record against `63dbd2c` and it was re-run against the tree
on 2026-09-29. These rows were open when it was written and are not open now, so
the list holds 13 of its 61 row numbers and 49 are open. The tree is the
authority; this list exists so a reader who arrives at the audit first does not
rebuild finished work.

| Row | Closed by | What closed it |
| --- | --- | --- |
| 12 | already satisfied | `docs/GO-TO-MARKET.md` is absent from the tree, which is the decision the row asks for |
| 22 | `55308ff` | the server budget ledger is on a dispatch path, with the prior-record read outside the journal writer lock and the settlement outside the transaction |
| 28 | `39d3c48` | `postgres-managed-conformance` is published, five scenarios, and the release gate refuses a release that ships the adapter unnamed |
| 29 | `39d3c48` | `commit` is a published `git.managed` operation with its own scenarios and its durable receipts measured |
| 35 | `ad16679` | the `nomo recovery migrate` path, every refusal and the structural reason tool execution refuses it are documented |
| 41 | `68dfdbb` | one operational certification run recorded in `docs/UPGRADE-CHECKPOINT.md`, with what it did not cover |
| 49 | `ba2e042` | the iOS cache policy, Keychain-only credential storage and a removal path that leaves no credential |
| 16 | the scope answer in `docs/DECISIONS.md` | no provider and no model is a hardcoded default any more; the product asks on first use, the retry guard identifies a free model explicitly, and both handbooks, the README and the beta document say so |
| 9 | the statement in `docs/APPWRITE-AUTH.md` "## Account deletion" | no mounted route creates an account: the Appwrite module is imported only by its own test, the live Supabase broker refuses signup while `NOMO_ACCOUNT_SIGNUP` is unset, and no mounted route accepts the invitation code a signup would need. It is no longer true that no person can hold an account, because a provider account can now sign in over `POST /api/account/signin` and own rows. Deletion therefore becomes real work when a real provider account signs in, and the module has no deletion method to hang a route on |
| 6 | the scope answer "The phone companion stays read-only" in `docs/DECISIONS.md`, 2026-09-26 | the shipped app is read-only by construction, `apps/apple/NOMOApp/AppCopy.swift` already tells the user that approval and Undo happen on the Mac, write pairing is an operator opt-in that is off by default, matrix `P05.03` is struck, and the read-only half that stays open is recorded in `docs/IOS-CACHE-AND-REMOVAL-POLICY.md` |
| 13, architecture bullet | the platform answer "macOS becomes a SwiftUI target in the same project as iOS" in `docs/DECISIONS.md`, 2026-09-28 | the Tauri vs SwiftUI question is answered and dated, and the Tauri shell stays as the desktop distribution carrying the Node sidecar, which is a separate packaging question. Matrix `D04.09` and `D04.13` still read Open and were not corrected here. The other six bullets of row 13 are still open, so the row stays in the crosswalk |
| 21 | the scope answer "`certification: false` is the permanent honest answer" in `docs/DECISIONS.md`, 2026-09-26 | every published capability profile carries the field, `void.adapter-capability.v2` refuses a bare `certification: true` as "not evidence", and the reason is written down rather than widened into a schema for a state that does not exist |
| 44 | the 2026-09-29 re-run in `docs/OPEN-WORK-AUDIT.md`, which states why it cannot be named | no output, log or test identifier from the run that produced the failure survives anywhere in the tree, so there is nothing to name and re-running the suite would produce a different result rather than identify that one. It is closed as unnameable, which is the answer the row asked for, not a fix |

Two rows are partly closed and the remainder is named rather than implied. Row 23
has its dependency, time and checkpoint selectors wired, with cross-host fencing
and the cloud MCP job surface still open. Row 47 has the invitation, the
credential store, the bounded reconnect and the revocation races implemented as
code and tests, with a paired-device round trip on hardware still open.

## What this document does not do

It does not collapse the three ledgers into one, and it does not delete
`docs/PLAN-STATUS.md`. Both were considered and neither is done here: a
collapse is a large migration of every cross-reference in the tree, and this
index exists so that the question has an answer while that decision is open.

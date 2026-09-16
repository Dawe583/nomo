# VOID remaining work

Audit baseline: commit `0189f9d`, extended by the TUI rewind selection
increment in this tree. A sibling session owns R05 managed Git commit recovery
on branch `upgrade/git-commit` and reverted one incomplete merge there; see
`tmp/parity/root-lane.md` for the lane split.

This document consolidates the active plans. It does not replace
`EXECUTION-PLAN.md`, `REVERSE-TOOL-UPGRADE-PLAN.md` or
`GUI-UPGRADE-PLAN.md`. Status claims use `UPGRADE-CHECKPOINT.md`,
`REVERSE-UPGRADE-PROGRESS.md`, focused source review and the current test
entry points. The Graphify graph was built from commit `4a157891`, so it is
useful for the older package graph but not authoritative for recent GUI,
managed Git or persistent recovery jobs.

## Immediate order

1. Finish R01 and R04 crash and persistence certification. Cover provider
   client process death, the remaining persistence boundaries, network
   partition behavior and cloud transactional journal behavior.
2. Finish R05 managed commit recovery. Use an append-only revert commit or a
   recovery pull request. Do not reset or force push shared history.
3. Finish R07 runtime provenance. Record resource read and write sets,
   revisions and dependency certainty, then use the graph in recovery plans.
4. Finish R06 leases, fencing, time selection and dependency closure. Add MCP
   and cloud job surfaces only after those invariants pass.
5. Build R08 and R09 executable S3, Supabase, GitHub and Vercel adapters. Test
   them against disposable services. OAuth and registry metadata are not
   recovery evidence.
6. Finish R10 cloud budgets and policy modes, then R11 staged cancellation.
   R11 depends on R06, R07 and R10 and must not auto-commit an approval hold.
7. Finish R12 Python transport and provider conformance. Finish R13 OpenCode
   doctor and init, remote executor authentication and managed egress.
8. Finish R14 export bundles, checkpoint completeness, metrics and operations
   evidence.
9. Complete the remaining GUI and TUI parity work listed below. Keep all policy,
   classification and recovery authority on the server or shared runtime.
10. Close release blockers: production KMS, native signing and notarization,
    Linux packaging, physical mobile keyboard tests, screen readers and real
    200 percent zoom acceptance.

## Execution and build plan status

| Work package                  | Status                                            | Remaining evidence or work                                                                                                                                                                                                                                                                      |
| ----------------------------- | ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| WP-00 to WP-05                | Done for the current local core                   | Keep context, registry, ledger, proxy and blocking hold contracts aligned as later packages change.                                                                                                                                                                                             |
| WP-06 PostgreSQL              | Partial                                           | R04 cascade and tenant certification, migrations, client process kill and network partition.                                                                                                                                                                                                    |
| WP-07 S3                      | Partial                                           | Replace legacy coverage with managed version-aware recovery and disposable service conformance.                                                                                                                                                                                                 |
| WP-08 probes and blast radius | Partial                                           | Provider-specific exact or bounded measurement and release evidence remain incomplete.                                                                                                                                                                                                          |
| WP-09 CLI                     | Partial                                           | Core commands plus read-only doctor, config, version and init work. Broader provider recovery surfaces remain under R13 and R14.                                                                                                                                                             |
| WP-09b TUI                    | Done for original acceptance, parity still active | PTY safety passes. Shipped: fuzzy commands, management aliases, shortcuts, usage status line, unified diff review, read-only doctor, config, version and init commands, rewind auto-select. Remaining: permission modes, context compaction, file mentions, background tasks, configurable shortcuts. |
| WP-10 API                     | Partial                                           | External cloud tool conformance, remote executor authentication and job surfaces remain.                                                                                                                                                                                                        |
| WP-11 UI                      | Partial                                           | Main React control plane shipped. Physical accessibility, performance certification and the parity list below remain.                                                                                                                                                                           |
| WP-12 taint graph             | Partial                                           | R07 runtime provenance and dependency-aware recovery are missing.                                                                                                                                                                                                                               |
| WP-13 attestation             | Partial                                           | Complete R14 export bundles, checkpoints and operational verification.                                                                                                                                                                                                                          |
| WP-14 SDK wrap                | Partial                                           | Managed TypeScript SDK exists. Python transport and broader provider fixtures remain.                                                                                                                                                                                                           |
| WP-15 hardening and release   | Partial                                           | Native signing, KMS, external service certification, metrics and release operations remain.                                                                                                                                                                                                     |
| AW-00 and AW-01               | Mostly done                                       | Shared events and provider registry exist. Token Harbor activation remains blocked on account email verification and model choice.                                                                                                                                                              |
| AW-02 runtime adapters        | Partial                                           | Native Claude Code, Codex and OpenCode process adapters, PTY embedding and direct host project editing remain open.                                                                                                                                                                             |
| AW-03 TUI workbench           | Done for current local workbench                  | Continue management parity without moving authority into the renderer.                                                                                                                                                                                                                          |
| AW-04 and AW-05               | Mostly done                                       | Cloud API and GUI are usable. External tool coverage and remaining acceptance gates stay open.                                                                                                                                                                                                  |
| AW-06 desktop shell           | Partial                                           | Tauri shell and packaged smoke exist. Signing, notarization and Linux packaging remain.                                                                                                                                                                                                         |
| AW-07 multi-agent review loop | Not started                                       | Product-level orchestration, review loop and safe shared-workspace coordination remain.                                                                                                                                                                                                         |

The older `BUILD-PLAN.md` phases map to the same gaps. Phases 0 to 7 have
working implementations with scoped limits. Phase 8 remains incomplete because
resource provenance is not integrated into recovery. Phases 9 and 10 remain
partial because operational attestations, provider conformance and the second
production deployment shape are not fully certified.

## Reverse plan status

| Package | Status                                  | Exact gap                                                                                                                                                                |
| ------- | --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| R00     | Partial                                 | Machine-readable provider certification and public claim alignment.                                                                                                      |
| R01     | Partial                                 | Cloud journal and the full persistence fault matrix.                                                                                                                     |
| R02     | Partial                                 | Legacy proxy and general external cloud tool conformance.                                                                                                                |
| R03     | Partial                                 | Streaming artifacts, pin lifecycle, retention, garbage collection and quota migration.                                                                                   |
| R04     | Partial                                 | Cascade and tenant tests, migrations, client kill and network partition.                                                                                                 |
| R05     | Partial, sibling lane active            | Managed commit and revert, remote recovery, Windows Git, Windows rename and mode restoration. One incomplete merge was reverted; root lane does not duplicate this work. |
| R06     | Partial                                 | Dependency and time selection, durable leases, fencing, MCP jobs and cloud jobs.                                                                                         |
| R07     | Not started beyond legacy taint helpers | Runtime provenance and dependency-aware recovery integration.                                                                                                            |
| R08     | Not started beyond legacy S3            | Managed S3 and Supabase adapters with real capability tests.                                                                                                             |
| R09     | Not started beyond OAuth                | GitHub and Vercel executable recovery with sandbox conformance.                                                                                                          |
| R10     | Partial                                 | Cloud accounting, visible modes, approval integration and the full reservation fault matrix.                                                                             |
| R11     | Not started                             | Staged graph, barriers, cascading cancellation and restart semantics.                                                                                                    |
| R12     | Partial                                 | Python transport, provider fixtures and broad certification profiles.                                                                                                    |
| R13     | Partial                                 | Doctor and init ship as read-only CLI plus TUI commands. Authenticated remote executor and managed egress remain.                                                                                              |
| R14     | Partial                                 | Export bundle completeness, metrics and operational certification.                                                                                                       |

Source of detail: the table and sequence in `REVERSE-UPGRADE-PROGRESS.md` and
`UPGRADE-CHECKPOINT.md`. These gaps must not be converted into broad recovery
claims from fixture tests.

## GUI plan E0 to E9

| Stage | Status                           | Remaining work                                                                                                                              |
| ----- | -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| E0    | Done                             | Keep reproducible fixtures and screenshots current.                                                                                         |
| E1    | Done for TokenRouter plan target | The later Token Harbor preference is pending account verification. Existing sessions must retain snapshots.                                 |
| E2    | Done                             | React shell, routes, login gate and shared desktop build exist.                                                                             |
| E3    | Mostly done                      | Markdown, composer, drafts, model picker, tool cards and session management exist. Continue message action and management parity.           |
| E4    | Mostly done                      | Streaming, event deltas, reconnect and usage exist. Long-running provider and Workflow throttling behavior still needs production evidence. |
| E5    | Done for managed documents       | Revision conflict, diff, branch and reviewed Undo work. Arbitrary external tool Undo is not implied.                                        |
| E6    | Mostly done                      | Server filters and pagination exist. Continue scale and ledger query performance evidence.                                                  |
| E7    | Mostly done                      | Connectors, catalogs, settings and usage pages exist. Provider price and capacity data remain unknown when providers omit them.             |
| E8    | Partial                          | Physical iOS and Android keyboards, screen readers, real 200 percent zoom, complete browser coverage and measured LCP, INP and CLS.         |
| E9    | Partial                          | Production shipped. Rollback was documented but not executed. Complete provider availability and release acceptance.                        |

### GUI and TUI parity still missing

Current surfaces already provide streaming chat, Markdown, drafts, session
history, model selection, commands, documents, approvals, ledger review,
branching, retry, usage and responsive navigation. Remaining high-value parity:

- Shared configurable permission modes backed by policy, including a visible
  plan or read-only mode. Do not implement this only in UI state.
- Context compaction with a durable, inspectable summary and explicit token
  accounting. Never rewrite the signed ledger.
- Managed file mentions and richer attachment handling. Binary and multimodal
  input need private object storage and provider capability checks.
- Unified tool diff review with per-change accept or deny where the server can
  enforce it. Current document Undo remains the authority after execution.
- Background task management and a real queue. Cloud currently allows one
  active model session and no speculative execution.
- Todo and plan state as structured events rather than parsing assistant prose.
- Custom agents, hooks and MCP management comparable to Claude Code, behind
  stable host and policy contracts.
- Safe checkpoint rewind across dependency-aware multi-operation recovery.
  Current rewind can only use individually captured and verified operations.
- User-configurable shortcuts and optional Vim editing after core terminal
  safety remains proven.
- Complete parity tests at 80, 120 and 200 columns plus the GUI viewport and
  accessibility matrix.

## Desktop, mobile and release blockers

| Plan                       | Status             | Blocker                                                                                                                    |
| -------------------------- | ------------------ | -------------------------------------------------------------------------------------------------------------------------- |
| Apple A1 distribution      | Partial            | macOS app is locally ad-hoc signed, not notarized or published as a signed installer.                                      |
| Apple A2 SwiftUI macOS     | Not started        | Current shell is Tauri and WKWebView. A SwiftUI client remains a separate migration.                                       |
| Apple A3 iOS recovery core | Not started        | No native iOS local recovery core.                                                                                         |
| Apple A4 pairing           | Not started        | No complete Mac pairing and service context.                                                                               |
| Apple A5 native release    | Blocked            | Apple Developer identity, signing, notarization, physical hardware and acceptance evidence.                                |
| Windows desktop            | Partial            | Beta package and WebView smoke passed. Full CLI, Git recovery and installer release evidence remain.                       |
| Linux desktop              | Blocked            | Native packaging and installed smoke are unverified.                                                                       |
| Mobile web                 | Partial            | Browser viewport checks passed. Physical keyboards and screen readers are unavailable in this environment.                 |
| Production secrets         | Partial            | Local encrypted storage exists. Production KMS and complete rotation evidence remain.                                      |
| Live providers             | Blocked or partial | TokenRouter had an observed 503. Token Harbor requires verified email and a selected model. No silent fallback is allowed. |

## External evidence required

The following items cannot be closed by unit tests alone:

- Disposable provider accounts for S3, Supabase, GitHub and Vercel recovery.
- A disposable isolated PostgreSQL target for remaining crash and network work.
- Apple signing identity and notarization service.
- Physical iOS and Android devices plus VoiceOver and TalkBack.
- Linux and Windows machines for native packaging and full recovery suites.
- An authorized production-like KMS and key rotation drill.

No autonomous step may use a production account to obtain this evidence.

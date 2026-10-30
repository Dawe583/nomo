# NOMO TUI ownership and continuation plan

Status: planning and ownership reset, 2026-10-30.

## Purpose

This document is the single current handoff for finishing the production NOMO terminal UI. It replaces conflicting operational instructions, not historical evidence. It does not authorize copying another runtime, deleting user data, weakening NOMO security, or claiming old test results for new commits.

## User outcome

Deliver one reliable, interactive and visually coherent NOMO TUI inspired by useful Prime Agent and OMP patterns. Preserve NOMO branding, truthful Workbench data, existing security and approval contracts, terminal restoration, keyboard usability, monochrome behavior and short-terminal layouts. Every shipped control must invoke a real NOMO action or be omitted.

## Authority and ownership

1. `docs/CONTEXT.md`, `docs/DECISIONS.md`, `docs/STANDARDS.md`, source code and tests remain authoritative for behavior and security.
2. This plan is the current TUI roadmap. `.nomo/work-state.json` is the only execution graph. Obsidian and TheBrain hold status and provenance, not code authority. The imported `Graphify-Index` is historical until its root and indexed commit match the active source.
3. The clean isolated branch `tui/clean-continuation-2026-10-30` is the integration tree. It starts at GitHub `origin/main` commit `521b1c825c95ce3fdda71370aa3dfd8bef5e5dd2`. The integrator in this Prime Agent session owns this worktree and all integration commits.
4. OMP may contribute only through a written task assignment with explicit paths, acceptance, verifier, and return handoff. OMP does not write the integrator's branch. Its task branch must be separate and based on the same current main. The integrator reviews and cherry-picks only verified task-owned commits. The user reports that a new OMP session is now started; verify its exact new worktree/branch before assigning overlapping work. Its current visible `tui/final` tree is a mixed dirty snapshot, not the approved OMP task branch.
5. OpenCode no longer owns a TUI worktree, branch, or remote branch. The `feat/tui-ink-rework` worktree and branch were intentionally removed at the user's explicit request. Do not recreate or adopt the experimental Ink/TUI v2 implementation. Its previous status included demo data and fake actions.
6. The dirty root checkout and all unrelated dirty worktrees are protected. No reset, clean, checkout, delete, cherry-pick, commit or push from those trees.

## Preservation and cleanup rule

Do not delete notes, branches, commits, or dirty files based only on age, filename, or author label. Preserve verified historical evidence. To stop obsolete guidance being followed, create a current index that labels superseded plans as historical and points to this plan, the active graph, and current source. Only archive or remove a specific item after inventory, provenance review, duplicate check, and confirmation that no current task or link depends on it. Never bulk-delete from TheBrain or the Obsidian vault. Keep the original vault intact.

## Visual requirements for the current request

The Prime Agent TUI is the primary visual reference. OMP is a source of reusable patterns, not a second product contract. This updates the older dated parity note that named OMP first. Use current Prime Agent v0.10.1 source for comparable shell/editor behavior, and OMP v18.8.9 only for component patterns that fit NOMO. Do not import Prime or OMP branding, runtime, actions, or fake data.

- Keep the NOMO aperture mark, blue identity, English interface labels, monochrome state labels and transparent terminal canvas. Do not replace the terminal UI with a web-like card dashboard.
- Make chat the visual focus: concise role framing, readable Markdown and code, clear live streaming state when sourced from actual Workbench events, and a steady prompt/editor area that remains visible.
- Reduce repeated chrome and metadata. Use compact header and status rows, a context-sensitive shortcut legend, and the existing command palette. Show run/session detail in the inspector when width allows, not as duplicated JSON in the body.
- Keep all eleven NOMO tabs, each with real data, visible selection, usable empty/error/unknown states, and the existing action owner. Improve the view hierarchy without removing NOMO's operations surfaces.
- Follow terminal-native interaction patterns: selection, history, model selection, prompt editing, help and details. Port only when the binding preserves NOMO semantics and can be tested. In particular, approvals, side effects, run stop, queue capacity, and ledger evidence must remain NOMO-owned.
- Keep status meaning independent of color. Honor `NOMO_TUI_COLOR=0`, `NOMO_TUI_MOTION=0`, terminal foreground/background, reduced capability, no-color output, narrow columns, short heights and terminal restoration.

Reference matrix to complete before implementing parity changes:

| Surface | Current NOMO owner and state source | Prime/OMP pattern to assess | Current tests |
|---|---|---|---|
| Overview / runs | `WorkspaceTui.items()` reads `Workbench.runs()`; stop/reconcile route through `Workbench` | Compact live run rows, detail inspector, honest unknown/reconciliation states | `workspace-controls.test.ts`, `workspace-parity.test.ts` |
| Chat | `WorkspaceTui.session()` plus `chatRows()` over Workbench events | Transcript hierarchy, streaming, Markdown/code, context-first editor dock | `workspace.test.ts`, `workspace-parity.test.ts` |
| Prompt / queue | `WorkspaceInput` and runner keys; send/queue/stop in Workbench | Unicode editing, history, multiline, contextual shortcut hints | `workspace.test.ts`, `workspace-controls.test.ts`, PTY verifier |
| Sessions | `Workbench.list()` and `Workbench.get()` for full detail | Grouped selection, list+inspector at wide sizes | `workspace-controls.test.ts`, `workspace-parity.test.ts` |
| Documents | `Workbench.documentsList()`, `document()`; edit and undo through Workbench | Folder tree, read-only preview, version/revision status | `workspace.test.ts`, `workspace-controls.test.ts` |
| Ledger | signed managed proofs plus proxy records, verified by existing ledger/proxy owner | Compact evidence rows and readable record detail, no raw secret arguments | `workspace-controls.test.ts`, `workspace-proxy.test.ts`, ledger tests |
| Approvals | `Workbench.approvals()` and proxy holds; y/n delegates to approval API | Decision detail next to list where space permits, explicit risk and expiry | `workspace-approval.test.ts`, `workspace-controls.test.ts` |
| Policy / connectors | `Workbench.connectionState().connectors`; mutations via explicit connector methods | Consent lifecycle and connector inspector, no inferred permissions | `workspace-mcp.test.ts`, `workspace-controls.test.ts` |
| Tools | `Workbench.availableTools()` with registry disclaimers and schema | Searchable tool catalog and schema detail; inspection never executes | `workspace.test.ts`, `workspace-controls.test.ts` |
| Models | `Workbench.providerState()` catalog; selecting model is explicit existing command | Search/select capability metadata without claiming unsupported inputs | `workspace.test.ts`, `workspace-settings.test.ts` |
| Usage | `activity(Workbench.allViews())`; missing cost remains unknown | Compact token usage details, no invented metrics | `workspace-parity.test.ts`, `workspace.test.ts` |
| Settings / themes | Workbench preferences/limits and local theme config | Searchable metadata and supported persisted preferences only | `workspace-settings.test.ts`, `theme-config.test.ts` |
| Help / command palette | static command catalog plus actual keybinding dispatch | Discoverable commands and true active key hints | `workspace.test.ts`, `workspace-shortcuts.test.ts` |
| Watch / hold / inline | `WatchRuntime`, `renderHoldPrompt`, and caller-supplied verified state | OMP/Prime terminal component hierarchy only where fits shared-terminal contract | `tui.test.ts`, `live.test.ts`, `workspace-terminal.test.ts` |

For every matrix row record source commit, disposition (`supported`, `safely adapted`, `unsupported`), concrete NOMO contract, before/after renderer evidence, and verifier. A reference screenshot without a tested NOMO behavior is not acceptance evidence.

## Phases

### 0. Ownership and source reconciliation

Owner: integrator. Paths: this plan, `.nomo/work-state.json`, and a new TUI start-here index in the NOMO memory system. Read-only source inventory first. Confirm the OMP session is stopped; record the exact candidate tree HEAD, dirty paths, staged state, and process ownership. Inspect current `origin/main`, every TUI branch, open PRs, TUI contracts, and historical plans. Preserve every tree. Exit when each candidate change is marked `verified-integrated`, `verified-unintegrated`, `unverified`, `foreign-owned`, or `obsolete-with-evidence`.

### 1. Current production baseline

Owner: integrator. The clean integration branch starts at current `origin/main`. Map all 11 production tabs to their Workbench read source, action owner, empty/error/unknown behavior, and focused test. The static source mapping is safe to complete while OMP owns TUI code. Runtime tests/typecheck/PTy are temporarily blocked because the clean worktree has no `node_modules`, and project instructions disallow dependency installation without approval. Do not run tests concurrently with OMP's live PTY work. Obtain either an isolated approved dependency setup or a completed OMP handoff plus clean test result before baseline gates. No implementation during source mapping.

### 2. Review and accept independent changes

Owner: integrator; OMP may propose isolated commits only after assignment. Review every TUI PR and dirty OMP change, including required shared Workbench or provider changes. Check security, correctness, tests, dependency and license changes, UI truthfulness, keyboard behavior, terminal lifecycle, and document consistency. Accept only minimal commits whose tests and typecheck pass on current main. Leave failed or uncertain work preserved and blocked, never silently fold it in.

Known remote branches and state observed on 2026-10-30:

- `tui/terminal-foreground`, PR 123, open, checks failed or cancelled.
- `tui/compact-overview`, PR 124, open, checks failed or cancelled.
- `tui/visual-refresh`, remote commit `0748d41`, no open PR returned by GitHub CLI; old local visual evidence applies only to that commit.
- `tui/upgrade-omp-parity`, remote commit `ab5c8d8`, no open PR returned by GitHub CLI.
- `tui/omp-continuation`, remote commit `346081f`, no open PR returned by GitHub CLI.
- OMP's older `main-current` tree was at `c6beb23`, 8 commits behind main, with 14 modified files across TUI, Workbench and PTY verifier. `git diff --check` passed. Focused regression run in that older tree passed one test and failed two stale expectations: run inspector expected `runId`, proposal detail expected JSON serialization. No files were changed there by Prime.
- OMP pushed `92be3e3`, `bf2abf1`, `bbb3e8d`, and `645a0d4` to `tui/final`. That branch is 4 commits ahead of its common base but 317 behind current main. OMP's graph currently blocks package-artifact launch on unresolved workspace imports and blocks delivery on GitHub auth. Its worktree has uncommitted changes to `workspace.test.ts` and `verify-tui-terminal.py`, plus unrelated staged/untracked changes; treat it as protected. OMP reports the earlier TUI 349/349 plus PTY and CLI typecheck passed; the current follow-up has not been fully rerun or pushed. Prime independently reproduced PTY marker and package logo defects; issues #125/#126 are open.
- Prime independently reviewed the initial staged TUI patch read-only. No confirmed security finding; the alleged stop/restore nesting issue was disproven by numbered source. Packaging of runtime-loaded `nomo-logo.png` is a concrete open check: `packages/cli/package.json` declares `files: ["dist/"]`, while the renderer reads a neighboring PNG; release packaging must prove that asset is copied into `dist/` or remove this dependence.
- Two candidate unit tests were rerun against OMP's latest TUI candidate: `workspace-controls.test.ts` and the focused harness-proposal assertion passed. CLI typecheck passed. The candidate PTY verifier itself is being modified by OMP, and the PTY command previously failed before matching frame updates; no current full-suite/PTTY pass is proven.
- The new user requirement is visual focus using Prime Agent as the primary reference, with OMP secondary. OMP current graph owns `packages/cli/src/tui/**` and a live terminal process. Prime will not edit renderer or PTY verifier until OMP hands off its visual slice. Prime integration remains this clean branch and is non-overlapping.
- Follow-up issues created: #125 fixes the PTY verifier markers against the current prompt contract; #126 proves and repairs packaging of Kitty logo assets. Both are source-backed verification/release blockers.
- At phase start, all branch and diff findings are candidates, not accepted progress. Do not close PRs or delete their remote branches until their ownership and disposition are recorded.

### 3. Functional correctness by ownership boundary

One issue per graph node. Add a failing `node:test` before changing behavior. TUI renders and routes input; Workbench owns state and actions; Proxy, policy and ledger own identity, authorization and evidence. Shared contract work must be assigned to its package owner and update the relevant acceptance docs before implementation. Preserve fail-closed behavior. No fake permissions, approvals, model data, receipts, metrics, tool outcomes or streaming events.

### 4. Reference interaction parity

Pin Prime Agent v0.10.1 and OMP `v18.8.9` sources per comparison. Maintain a matrix of feature, reference source, NOMO capability, disposition, NOMO owner, test and evidence. Use `supported`, `safely adapted`, or `unsupported`. Match only semantics NOMO can honestly support. Preserve the one-slot queued prompt contract unless a reviewed Workbench change authorizes otherwise. Do not require authenticated Prime screenshots; no OAuth or credentials are entered by an agent.

### 5. Visual finish

Do not restart a completed broad visual pass without a new concrete defect. For each defect: capture the actual production renderer before change; add a failing exact-size and mode regression; make a presentation-only patch; capture after; check Unicode terminal-cell widths; inspect color and monochrome; run focused test and typecheck. Matrix: 40x12, 80x24, 120x40, 200x48, all 11 tabs, color and monochrome. Keep user-authored text unchanged. No unsupported cards or actions.

### 6. Consolidation and release

On a clean candidate branch, run `pnpm run test:tui`, `pnpm run typecheck`, and `python3 scripts/src/verify-tui-terminal.py` serially after focused tests. Run full CLI tests if the diff spans more than the TUI renderer. Review exact branch diff against `origin/main`; reject secrets, unrelated docs, generated archives, and foreign hunks. Commit each reviewed slice separately. Push feature branch. Require green CI before merge. Main merge and deployment are distinct release gates.

## Ownership split

- Prime Agent integrator: source of truth, task graph, isolated integration worktree, review, acceptance, cherry-pick, final commits, feature push, and release report.
- OMP contributor: explicitly assigned non-overlapping TUI behavior or test slice in its own worktree; no shared package or policy edits unless assigned; deliver commit hash, files, RED/GREEN, exact gates, limitations, and stop reason.
- No OpenCode TUI v2 lane exists. No third writer. Do not run parallel work in the same file or branch.

## Acceptance gates

- All supported views show only actual Workbench data and explicit unknown/error states.
- Every visible action maps to a tested owner method and cannot bypass policy, approval, idempotency, or ledger checks.
- No fake actions or placeholder production values.
- Tests and typecheck pass on the exact release candidate. PTY verifies launch, key path, cancellation, signals and terminal restoration.
- The full viewport matrix has bounded lines, reachable prompt, readable details, and monochrome state meaning.
- The final diff contains only reviewed TUI task-owned files and necessary shared-contract changes.
- Work Log and task graph state match the actual remote commit and CI. Old notes remain archived or explicitly superseded, not silently deleted.

## Verified quality and blocking issues

- Clean-main baseline at 521b1c8: `pnpm install --offline --frozen-lockfile --ignore-scripts` passed with no lockfile change. `pnpm run typecheck` passed. Workbench suite passed 856, skipped 2, failed 0. TUI suite first reported 191 passed/15 failed. The approval test fixture omitted OpenAI `finish_reason`; adding `tool_calls`/`stop` to the disposable fixture kept all no-dispatch-before-approval assertions and made the focused approval test pass 1/1. Re-run TUI then reported 192 passed/14 failed, same other failures. No TUI production source changed. Issue #127 has exact triage and outputs.
- OMP candidate latest pushed HEAD is `bbb3e8d`, 3 commits ahead of merge base 620aea4 and 317 commits behind main. Its graph reports `pnpm run test:tui` passed 346 tests plus PTY, and CLI typecheck passed. These are reported by the candidate owner; not independently rerun on its exact pushed HEAD. Workspace-wide typecheck is blocked by malformed unrelated `packages/workbench/src/provider-adapters/openai-responses.test.ts` (TS1434). No OMP candidate commit has been cherry-picked.
- Issue #125, current PTY verifier waits for obsolete prompt marker; actual clean-main PTY stops before key scenarios. The prompt contract has been redesigned in the candidate. Fix and verify on OMP branch.
- Issue #126, candidate bundle emits JavaScript that still tries to read `./nomo-logo.png`, but `npm pack` includes only `dist/` JS and no image. A direct package-artifact check reproduced the omission. Fix bundling and test installed artifact before claiming logo support.
- Issue #127, clean-main baseline has 15 TUI failures. They include one approval dispatch fixture, run fixture status, project root setup, layout assertions, prompt navigation, TODO rendering, icon color, prompt-jump counts, document lifecycle, history search and rewind. Separate true regressions from stale fixtures; never delete tests to go green.
- GitHub PRs #123 and #124 remain OPEN with failed/cancelled checks. `gh` annotations for gates report the account billing/spending limit issue, linked to existing issues #98/#110. No billing/account modification or PR merge until the owner resolves CI and checks are green.
- Obsidian Control Center and Work Log have current OMP ownership and issue records. The TheBrain local API is unavailable, so no write is claimed. Graphify `.graphify_root` is absent from the imported Obsidian vault; do not use its stale generated code graph as current evidence.

# NOMO TUI continuation after visual finish Implementation Plan

> **For agentic workers:** This is a roadmap, not permission to start implementation. Use the existing `.nomo/work-state.json` graph; preserve every blocker and worktree owner. Do not stage, commit, merge, push, use credentials, or trigger external side effects without explicit authorization.

**Goal:** Continue the complete production NOMO TUI from its verified visual finish toward evidence-backed Prime Agent and OMP parity, while keeping NOMO's identity, real Workbench state, existing actions, and security contracts intact.

**Architecture:** The production surface remains `packages/cli/src/tui/` and its existing live Workbench path. Treat OMP as the primary visual reference because the existing port plan and the latest completed visual pass name OMP; use Prime Agent v0.10.1 as a secondary reference for matching editor and selection patterns. Keep the OpenCode-owned Ink experiment isolated until every adopted screen has authoritative Workbench state and real actions.

**Tech Stack:** Existing TypeScript CLI, Node.js `node:test`, current TUI renderer and PTY verifier. No new dependency or runtime.

**Spec:** `docs/superpowers/plans/2026-10-14-nomo-omp-tui-port.md`; execution state remains `.nomo/work-state.json`.

## Global Constraints

- Preserve NOMO identity. Reuse structural ideas only; do not copy Prime or OMP logos, branding, product actions, or runtime.
- `Workbench`, policy, proxy, approvals, and ledger remain authoritative. Never invent values, actions, statuses, permission behavior, or lifecycle events.
- Keep all existing keyboard, action, selection, approval, terminal cleanup, monochrome, reduced-motion, short-terminal, and redirected-output contracts.
- Do not change `packages/cli/src/tui-v2/**`, `tui-v2-live/**`, or the OpenCode worktree without an explicit owner handoff.
- Preserve all dirty and untracked work. No install, credentials, OAuth, production data, commit, merge, push, or account-setting changes.
- Add no dependency. Keep built-in labels in English and do not add em dash or en dash characters.
- Do not restart a visual pass already evidenced in the graph unless source changes invalidate its captures or a fresh run demonstrates a concrete defect.

---

## Current Status

Execution authorized on 2026-10-30 in the current `tui/final` worktree through
the `.nomo/work-state.json` node `tui-final-worktree-continuation`. No other
worktree or agent session is part of this execution. The visual evidence below
belongs to its named checkout and is not substituted for current-worktree
verification.

The 2026-10-28 visual evidence covers 11 production screens at 40x12, 80x24, 120x40, and 200x48 in color and monochrome: 88 captures. The recorded run passed workspace parity 79/79, `pnpm run test:tui` 355/355 plus 9 PTY checks, CLI tests 581/581, typecheck, and an isolated launcher/terminal-restoration smoke. That evidence belongs to `.worktrees/nomo-tui-visual` at `0748d41e6aa6eb8c89ee89e3cd98b7d36deeca9b`; do not assume it proves the dirty root checkout.

## Task 1: Reconcile current source, task graph, and owners

**Files:** Read `packages/cli/src/tui/**`, `.nomo/work-state.json`, `docs/superpowers/plans/2026-10-14-nomo-omp-tui-port.md`, and `.nomo/collab-opencode-tui.md`. Read `packages/cli/src/tui-v2/**` only as a separate, read-only implementation reference.

- [ ] Recheck HEAD, dirty paths, active processes, worktree ownership, and the graph's current blockers before selecting any implementation path.
- [ ] Record the production route, all 11 supported tabs, their real state source, current action owner, and existing focused test. Mark any unavailable state as unsupported, not zero or success.
- [ ] Reconcile the recorded OMP references before comparing source: the port plan names v18.8.9, while an older visual audit used v18.6.2. Pin one exact tag/commit per comparison and do not mix evidence across versions.
- [ ] Keep the 2026-10-05 `docs/TUI-HARNESS-MAP.md` as historical reconnaissance only. Verify every lead against current source and contracts before adding work.

**Gate:** Stop implementation if the selected tree has another active owner, the required source is unavailable, or a change crosses into shared Workbench, policy, approval, permission, or terminal-lifecycle behavior without an explicit owner handoff.

## Task 2: Maintain one reference parity matrix

**Files:** Plan/evidence only until a concrete source-backed gap is approved. Update this plan and the existing task graph, not a second task list.

- [ ] For each supported production surface, classify relevant reference behavior as `supported`, `safely adapted`, or `unsupported`, with a source location and the NOMO owner contract.
- [ ] Compare OMP's reusable shell, message framing, selection, settings, tree, and inspector patterns. Compare Prime v0.10.1 only where the existing NOMO contract provides equivalent behavior.
- [ ] Keep OMP-only or Prime-only actions out of the interface when NOMO has no real implementation.
- [ ] Reuse the current 88-frame visual evidence when its source revision still matches. Capture a fresh frame set only after source changes or when a specific defect cannot be decided from current evidence.

**Gate:** Do not claim exact parity from source text, static previews, or test output alone. A visual claim requires a current production-renderer or isolated PTY frame at the relevant terminal size and mode.

## Task 3: Fix only reproduced production visual gaps

**Files:** Only the owning file under `packages/cli/src/tui/`, its focused test, `CHANGELOG.md`, and the existing task graph, after an authorized owner selects the node.

- [ ] Reproduce one visible defect in the current production renderer or isolated PTY before changing source.
- [ ] Add a focused failing visual regression for the exact state, width, and color mode.
- [ ] Change presentation only. Preserve text/data truth, key routing, controls, actions, state, selection, permissions, Workbench contracts, and terminal lifecycle.
- [ ] Verify the focused test, then the relevant TUI and PTY checks. Inspect the resulting actual frame and terminal-cell bounds.

**Gate:** If no concrete defect is reproduced, make no visual change. The completed 88-frame audit is not a mandate for another redesign pass.

## Task 4: Resume Prime interaction parity only after ownership is clear

**Files:** `packages/cli/src/tui/workspace-runner.ts`, `workspace-keybindings.ts`, `workspace.ts`, and their existing focused tests, only inside the graph-authorized tree.

- [ ] Refresh the Prime v0.10.1 source-to-NOMO key/action matrix against current source; mark each item supported, safely adapted, or unsupported.
- [ ] For each approved gap, add a test-first slice that preserves NOMO's editor, queue, prompt, approval, and side-effect semantics. Do not map a reference key when its action means something different in NOMO.
- [ ] Exercise the changed route in an isolated real PTY with temporary HOME and NOMO data, no provider credentials, and no production data.
- [ ] Keep `/help`, runtime hints, and the actual key router consistent.

**Gate:** `prime-agent-tui-interaction-parity` remains blocked until its current owner/process and security-semantic prerequisites are resolved. Authenticated Prime capture remains user-controlled; do not consent, log in, or enter OAuth credentials on the user's behalf.

## Task 5: Keep Ink integration conditional

**Files:** OpenCode-owned `packages/cli/src/tui-v2/**` and `tui-v2-live/**` remain out of scope without a written handoff. Production changes, if later approved, belong to the graph-selected production TUI files.

- [ ] Do not cut `nomo` over to Ink while supported screens show seeded state or fake local actions.
- [ ] Before considering cutover, prove each adopted view reads authoritative Workbench state and routes actions through the existing action owner without changing contracts.
- [ ] Verify actual state transitions and failure paths in isolated fixtures; remove unsupported screens and controls instead of presenting demo outcomes.
- [ ] Make a separate cutover decision only after ownership, behavior, terminal lifecycle, and rollback path are documented.

**Gate:** `nomo-tui-live-workbench-integration` and `nomo-tui-ink-visual-parity` remain blocked until their recorded prerequisites are satisfied. Visual resemblance alone cannot authorize production cutover.

## Task 6: Close only an authorized, verified slice

Run the existing relevant commands serially after the current package scripts and package names are rechecked:

```sh
pnpm run test:tui
pnpm run typecheck
python3 scripts/src/verify-tui-terminal.py
```

- [ ] Inspect the actual changed production TUI surface, including narrow and short dimensions, color and monochrome, and terminal restoration where input/lifecycle changed.
- [ ] Review only the authorized diff and preserve unrelated dirty work.
- [ ] Record exact evidence and remaining blockers in `.nomo/work-state.json` and the TheBrain NOMO Work Log.
- [ ] Stop before stage, commit, merge, push, or deployment unless the user explicitly authorizes that delivery action.

## Acceptance Criteria

- Every supported production TUI view remains truthful and usable at 40x12, 80x24, 120x40, and 200x48 in color and monochrome.
- Each adopted Prime/OMP pattern has a pinned source revision, a current NOMO owner contract, and a demonstrated production-renderer or PTY result.
- No unsupported feature or fake action appears in production, and no existing safety, keyboard, state, or terminal contract regresses.
- No blocked task is silently marked ready, no protected worktree is modified without handoff, and no user-owned changes are discarded.

## Blockers That Must Remain Visible

- The active graph currently has no ready TUI node. Preserve every existing blocked status and stop condition.
- Root `main`, the isolated integration tree, the visual tree, and the OpenCode Ink tree all have dirty or owned changes. Their 2026-10-28 status snapshots must be refreshed before a future implementation slice.
- `prime-agent-authenticated-reference-capture` still requires user consent and OAuth. It is optional if pinned public source and safe local frames suffice.
- `nomo-tui-live-workbench-integration` cannot proceed while Ink screens contain seeded state or fake actions.
- `nomo-tui-terminal-default-foreground-visual-pass` records an open PR whose CI job was blocked by GitHub account billing. Do not change billing or merge it from this plan.

## Handoff

This was the planning-stage handoff. The execution and ownership update below
supersedes its no-implementation status for this worktree only; blockers outside
the current graph node remain in force.

## 2026-10-30 Current-worktree handoff

The user explicitly authorized commits and pushes to the current worktree,
superseding this plan's earlier no-delivery instruction for this branch only.

- Owner: current OMP session, `/Users/dawe/.omp/wt/tui-final-8f69f0e`, branch
  `tui/final`. The next OMP session continues in this same worktree and branch;
  no Prime Agent or other checkout was used.
- Pushed commits: `92be3e3` and `bf2abf1` on `origin/tui/final`.
- Verification: `pnpm run test:tui` passed 346/346 tests and every PTY
  scenario; `pnpm --filter @void/cli typecheck` passed. Repository-wide
  `pnpm run typecheck` is blocked by TS1434 in the unrelated
  `packages/workbench/src/provider-adapters/openai-responses.test.ts`.
- TheBrain write access was unavailable in this session. The available
  Graphify index points to a different worktree and was not treated as current
  evidence. The repository graph is the local handoff source.
- Pre-existing non-TUI staged, unstaged, and untracked changes were preserved.
  This TUI node does not declare the wider cross-contract parity plan complete;
  existing blockers remain governed by the graph.

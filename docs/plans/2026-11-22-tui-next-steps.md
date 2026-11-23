# NOMO TUI next development plans

Status: proposed after the 2026-11-22 completion pass. These plans are not
implemented. They are linked to the existing execution graph node
`tui-completion-verification-2026-11-22` in `.nomo/work-state.json`; no second
state graph is introduced.

Verified baseline for these plans:

- `pnpm run typecheck` exits 0.
- The full TUI suite passes 314 of 314 tests.
- The PTY verifier covers Chat, tools, approvals, errors, cancellation,
  resize, panels, Undo and terminal restoration at 40x12, 80x24, 120x40,
  160x45 and 200x48.
- `nomo` from PATH is rebuilt from this worktree after the gates pass.

## 1. Real provider streaming and honest progress

Priority: P1.

Problem: the PTY proof uses a local fixture provider. The Workbench flushes
streamed deltas only after 250 ms or 512 characters and only when the next
chunk arrives. The Chat phase fallback previously invented "Thinking"; it now
says "Waiting for provider", but a single delayed chunk can still leave the
screen without any runtime-emitted progress.

Scope: Workbench streaming, Chat phase rendering and an opt-in local provider
harness. Do not add a hosted dependency or store credentials.

Affected parts:
- `packages/workbench/src/index.ts` (delta buffering and flush)
- `packages/cli/src/tui/workspace.ts` (phase labels and transcript rows)
- `packages/cli/src/tui/workspace.test.ts`
- `scripts/src/verify-tui-terminal.py`

Dependencies: none beyond the verified baseline. A real provider key is a
user-supplied local prerequisite and must never enter the repository.

Small steps:
1. Flush buffered deltas on a timer, not only on the next chunk.
2. Record the timestamp of the first visible delta in the fixture state.
3. Add a test that a single delayed chunk becomes visible within 150 ms.
4. Add an opt-in real-provider smoke script that reads the key from the
   environment and writes only token counts, never the key or prompt.
5. Assert that no phase label claims thinking, planning or progress that the
   runtime did not emit.

Risks: provider latency varies; timer flushes can increase render frequency;
a real-provider test can be flaky and must stay opt-in.

Acceptance: a streamed answer appears without waiting for a second chunk; the
first delta is visible within 150 ms in the fixture; no synthetic progress
appears; the opt-in smoke run is documented with its exact command.

## 2. Compact Chat and approval layout

Priority: P1.

Problem: at 40x12 the Chat chrome consumes almost every row. The transcript
can collapse to one row, and approval decision keys are not visible below 16
rows. The user requires a usable narrow terminal and preserved approval gates.

Scope: Chat dock, composer chrome and compact confirmation layout. Keep the
original logo, the closed bordered composer and the vertically centered caret.

Affected parts:
- `packages/cli/src/tui/workspace.ts`
- `packages/cli/src/tui/workspace.test.ts`
- `scripts/src/verify-tui-terminal.py`

Dependencies: plan 1 for the streaming rows that must remain visible.

Small steps:
1. At 12 rows or fewer, collapse the activity dock and legend into one line.
2. Reserve at least three body rows for the last transcript rows.
3. Show a one-line decision hint in compact confirmation without dropping the
   tool, class and blast-radius evidence.
4. Keep PgDn scrolling for the remaining evidence.
5. Add 40x12 and 40x16 PTY checks for Chat, approval and rejection.

Risks: hiding a control the operator needs; a one-line hint can be mistaken
for the full review. Keep the evidence scrollable and the decision keys
explicit.

Acceptance: at 40x12 the last message, the composer and the stop or decision
hint are visible; tool, class and radius remain reachable by PgDn; the PTY
matrix passes.

## 3. Settings keyboard completeness

Priority: P1.

Problem: the Settings panel opens and the command form changes values, but the
PTY pass could not move the selection with arrow keys or exit with Escape
while a filter query was active. The printable-filter branch exists, but the
keyboard path is not proven end to end.

Scope: Settings key routing, filter focus, selection and exit precedence.

Affected parts:
- `packages/cli/src/tui/workspace.ts` (`handleSettingsKey`,
  `visibleSettingsControls`, `insertSettingsText`)
- `packages/cli/src/tui/workspace-runner.ts` (key dispatch order)
- `packages/cli/src/tui/workspace-settings.test.ts`
- `scripts/src/verify-tui-terminal.py`

Dependencies: none.

Small steps:
1. Route printable and arrow keys to Settings before the Chat composer when
   the panel owns focus.
2. Make the filter update live and keep the selected row valid after filtering.
3. Define Escape precedence: first clear a query, then close the panel.
4. Add direct key tests for find, select, edit, confirm and exit.
5. Add a PTY check at 40x12 and 80x24 using only real key events.

Risks: key conflicts with the composer and panel navigation; a filter that
matches nothing must not trap the operator.

Acceptance: a keyboard-only operator can find a setting, select it, edit it,
confirm it and leave the panel at both sizes; Escape always has a defined
effect; the PTY check passes.

## 4. Ledger and usage evidence completeness

Priority: P1.

Problem: Usage distinguishes zero from missing measurements and Ledger
separates chain verification from derived records, but the verified fixtures
do not include a managed signed chain with both verified and failed
signatures. Proxy holds now show a deadline when the server supplies one, but
that path is not covered by a fixture.

Scope: read-only evidence fixtures for Usage, Ledger and approvals. Do not
change the append-only ledger or signature rules.

Affected parts:
- `packages/workbench/src/index.ts`
- `packages/policy/src/approvals.ts`
- `packages/cli/src/tui/workspace.ts`
- `packages/cli/src/tui/workspace.test.ts`
- `scripts/src/verify-tui-terminal.py`

Dependencies: none.

Small steps:
1. Add a fixture with one verified and one failed managed signature.
2. Assert that the chain status, verification rows and derived records remain
   separate and that no derived row is labelled verified.
3. Add a proxy hold with `expiresAt` and assert the countdown or "no deadline
   reported" wording.
4. Add usage records with `0` and with a missing count in the same run.
5. Add a PTY check for the Ledger and Usage panels at 80x24.

Risks: fixture data can drift from the real Workbench shape; keep the fixture
in the Workbench contract test rather than a UI-only stub.

Acceptance: the Ledger shows verified and failed signatures without promoting
derived records; Usage shows `0` and `unknown` distinctly; the proxy deadline
is shown only when reported.

## 5. Build freshness and launcher integrity

Priority: P2.

Problem: the launcher served a stale `packages/cli/dist` built before the TUI
source changes, so the visible UI lacked the logo and the closed composer even
though the source was correct. The root package version (0.1.0) and the CLI
package version (1.0.1) also drift.

Scope: build stamping, version source and launcher checks. Do not add a
deployment step.

Affected parts:
- `scripts/src/bundle-cli.mjs`
- `package.json` and `packages/cli/package.json`
- `nomo` launcher script
- `packages/cli/src/tui/workspace-terminal.test.ts`

Dependencies: none.

Small steps:
1. Derive the reported version from one source.
2. Write a build stamp with the source hash and build time into `dist`.
3. Make the launcher fail closed when the stamp is missing or older than the
   source tree.
4. Add a test that the launcher version matches the CLI package version.
5. Document the rebuild command in the TUI README.

Risks: a stamp check can block a deliberate local build; keep an explicit
override for development and never use it in release verification.

Acceptance: `nomo --version` matches the CLI package; a stale dist fails
closed with a clear message; a fresh build passes the launcher check.

## 6. PTY regression gate in CI

Priority: P2.

Problem: the five-dimension PTY verifier is a manual script. Its screen
markers are sensitive to layout changes, and the pass currently depends on
local timing.

Scope: stabilize the verifier, add a package script and run it in CI on macOS
and Linux. Do not add a hosted service.

Affected parts:
- `scripts/src/verify-tui-terminal.py`
- `package.json`
- CI workflow files

Dependencies: plans 1 and 2 for stable streaming and compact layout.

Small steps:
1. Add an environment filter for one scenario and one size for fast debugging.
2. Replace timing sleeps with state waits where the fixture exposes state.
3. Add `pnpm run test:tui:pty` and run it after the unit suite.
4. Cache Node and pnpm, keep one PTY process at a time.
5. Upload the failing screen and state on failure.

Risks: CI terminals differ in termios behavior; macOS and Linux need separate
expectations for transient flags such as PENDIN.

Acceptance: the verifier exits 0 at all five sizes in CI on both platforms;
a failure prints the screen, state and exact scenario.

## 7. Terminal lifecycle hardening

Priority: P2.

Problem: Ctrl+L now forces a repaint, and double Ctrl+D exits a fresh Chat,
but resize storms, SIGHUP, fatal render errors and double Ctrl+C need a
permanent regression matrix rather than one-off checks.

Scope: terminal lifecycle tests and the render loop. Preserve stdin, signals,
exit status and the alternate screen.

Affected parts:
- `packages/cli/src/tui/workspace-runner.ts`
- `packages/cli/src/tui/workspace-terminal.ts`
- `scripts/src/verify-tui-terminal.py`

Dependencies: plan 6.

Small steps:
1. Add a resize storm test with ten SIGWINCH events during a draft.
2. Assert termios, alternate screen and bracketed paste after every exit path.
3. Add a fatal render error fixture and a SIGHUP case.
4. Keep double Ctrl+C and double Ctrl+D as separate fresh-instance checks.
5. Run the matrix at all five sizes.

Risks: signal timing differs by platform; a killed process can leave the
terminal in raw mode. Always restore in a finally block and assert it.

Acceptance: every exit path restores termios, the alternate screen and
bracketed paste; the frame stays within bounds after a resize storm.

## 8. Host-delegated subscription providers

Priority: P1.

Problem: `openai-codex` and `claude-code` subscriptions cannot be imported as
tokens safely. Codex uses a private backend route, Prime stores no token
endpoint, Claude's local token was 61 days expired, and NOMO has no refresh
contract or first-party client id. Direct import would either send a dead
token or impersonate a first-party client.

Scope: route inference for these providers through the installed host app
(Prime Agent for `openai-codex`, Claude Code for `claude-code`) and keep the
credential inside that host. Do not import, refresh, persist or log the token.

Affected parts:
- `packages/workbench/src/agent-runners/` (new host runner)
- `apps/control-plane/api/desktop-setup.ts` (host source type)
- `packages/cli/src/tui/workspace.ts` (`/connect` selection and state)
- `scripts/src/prime-bridge.mjs` (existing Prime Agent bridge)

Dependencies: verified API-key provider matrix and the existing Prime bridge.

Small steps:
1. Add a `host-subscription` source type with no token field.
2. Add a host runner that spawns `prime-agent --provider <id>` or the Claude
   Code host and maps its JSON events to NOMO events.
3. Make `/connect prime:openai-codex` and `/connect claude:claude-code` select
   the host runner, not a direct adapter.
4. Show `host login required`, `running through Prime Agent` or `unavailable`
   from the host probe, never a token value.
5. Test with a fake host executable first, then one opt-in local run.

Risks: host process lifecycle, event mapping drift, consumer terms. Keep the
host as the credential owner and fail closed when it is not logged in.

Acceptance: a prompt sent to a subscription provider runs through the host
app with the host's own auth; NOMO never reads or logs the token; unavailable
host login is a clear state, not a fake success.

## 9. NIB pet next slices

Priority: P1.

Problem: the first NIB slice is header-only. Dock, pose interaction and splash
mark are designed but not implemented. Codex and Prime Agent evidence shows a
pet must never invent progress and must survive narrow terminals.

Scope: opt-in dock with 5 rows only when spare >= 14, Alt+Shift+K pose cycling,
`/pet dock`, one-time splash mark at cols >= 60, ASCII preset parity, PTY tests.

Affected: `packages/cli/src/tui/pet.ts`, `workspace.ts`, `workspace-runner.ts`,
`workspace-parity.test.ts`.

Acceptance: dock never hides composer or decision keys; reduced motion freezes;
state label matches status row; 40x12 stays mini; no new dependency.

## 10. Animation library decision

Priority: P2.

Decision: zero new runtime dependencies. Reuse `motion.ts`, `caps.ts`,
`workspace-terminal.ts` diff and `theme-config.ts`. `cli-spinners` is the only
admissible optional data package, but it does not earn its weight. Reject
terminal-kit (CJS, 4.11 MB, owns the terminal), ora/ink (own render loop or
React), blessed/neo-blessed (unmaintained), @opentui (requires Node 26.4,
project runs 24), @rezi-ui (beta native framework). Revisit only if NOMO
abandons the custom renderer.

## 11. OMP-like work view next

Priority: P1.

Problem: Chat now shows task header, TODO rail, subagent rail and specialized tool cards, but git
branch has no source, tool diffs are text-only, and mouse hit targets for the new rail are not covered.

Scope: add a real git branch source to the workbench projection, add per-tool diff tone and line
numbers, verify rail hit targets with mouse selection, and add a TODO source event only if a real
tool emits one.

Acceptance: no invented values; 40x12 approval keys remain; rail never overlaps transcript.

## 12. Subscription E2E next

Priority: P0.

Problem: Host runner tests pass, but a real Prime `openai-codex` smoke and a Claude subscription
login were not run. `/providers` quick check did not surface host rows, so discoverability needs
verification.

Steps: run `NOMO_HOST_CLI_SMOKE=prime-agent node --test packages/workbench/src/agent-runners/host-cli.test.ts`,
then `/connect prime:openai-codex` with a tiny prompt. Log in to Claude Code with a subscription
account, confirm `claude auth status --json` is not API-key-only, then `/connect claude:claude-code`.
Fix `/providers` host row visibility if the sources are missing from the panel.

Acceptance: one real subscription run through each host; no token read or logged; unavailable state
is explicit.

## 13. Remaining harness and visual roadmap (2026-11-23)

P0 — evidence and real runs
- Real provider E2E beyond Prime host (needs explicit authorization/cost).
- Host run observability and security audit of argv/env/transcript.
- Per-record ledger status instead of fail-whole-workspace.

P1 — visual and interaction polish
- Command palette with preview and sections.
- Toast stack with progress bar and dismiss.
- Sticky header and breadcrumbs in Chat.
- Mouse hit targets for the new rail and composer chips.
- Per-tool diff colors and line numbers in tool cards.
- Accessibility/non-TTY screen-reader tests for new visual surfaces.

P2 — performance and future
- Profile large transcripts and 200x48 frames.
- Optional per-session pet persistence and image atlas.
- Commit/release only on explicit approval.

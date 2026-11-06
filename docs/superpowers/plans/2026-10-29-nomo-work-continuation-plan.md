# Plan: NOMO work continuation wave 1 (2026-10-29)

Status: historical snapshot from 2026-10-29. Do not use this plan as current
task state, ownership or permission authority. Reconcile any remaining product
work against the current roadmap, source and `.nomo/work-state.json` before
starting it.

This plan records the repository state after the pull of 2026-10-29. The live
workflow and permissions are in `docs/agent-contract.md` and
`.agents/skills/nomo-workflow/SKILL.md`.

## 1. Measured state at 2026-10-29

- `main` fast-forwarded from `3be97ae` to `27a67f4` (Integrate verified NOMO
  Harness changes). Local and `origin/main` are equal.
- 13 remote branches arrived in this fetch; most are foreign TUI lanes
  (`tui/*`, `visual/*`, `agent/tui-health-coverage`, `claude/fleet-main`).
  Per the loop contract, `packages/cli/src/tui/*` and foreign worktree files
  are never edited or staged by this controller.
- `origin/feat/wp-regress` is 42 commits ahead of `main`; `main` is 8 commits
  ahead of that lane. The gap is provider-compatibility harness work plus the
  2026-10-17 gate and documentation rounds, integrated here only in part.
- Harness loop plan nodes H0, H1, H2 and H3 are done on `main` with evidence
  in `bf60301`, `3c47146` and `31fb951`. H5 remains ready; H4 is blocked on
  design; H7 and H8 wait on them; H6 stays blocked on the foreign TUI lane.
- At that time, the now-retired harness beta acceptance handoff recorded 60
  graph nodes: 54 done and 6 blocked (H6, H12, H13, H21, H34, H58), with H21
  active on provider compatibility. Reacquire any current state from source,
  tests and the task graph; do not restore or follow that handoff.
- A new specification exists and is unimplemented:
  `docs/superpowers/specs/2026-11-07-nomo-inbound-openai-chat-completions.md`
  (inbound OpenAI-compatible Chat Completions facade over the Control Plane).
- The 2026-10-27 YC strategy wave and the 2026-10-28 playbook are documents.
  Their demand validation work (customer interviews, sample cases, paid pilot
  gate) is human work by design and stays out of the crew graph.
- Environment: Linux checkout, Node 24.21.0, pnpm 10.33.0, `node_modules`
  absent at start and provisioned once with `pnpm install --frozen-lockfile`.
  No new dependency is ever added and no lockfile or package manifest is
  modified. The Obsidian vault is not reachable from this machine, so loop
  recordings stay in the repository graph, the work state file and this plan
  until the operator syncs the memory bundle.

## 2. Goal of wave 1

Four independent, evidence-producing outcomes, all on `main` or on lane
branches that the controller merges:

1. A verified baseline: the full gate recipe run on a clean detached checkout
   at exactly `27a67f4`, with real output captured.
2. A reconciled branch map: what the 42 WP-lane commits hold, which are
   already integrated, which repeat main content, which are foreign, and the
   integration recommendation.
3. The first vertical slice of the inbound OpenAI-compatible facade, test
   first, per its approved specification.
4. The H5 harness settings audit and the H4 profile evidence chain design
   (two independent proposals plus a judge ruling, contract frozen, no code).

Definition of done for the wave: every lane has a READY block with captured
command output, the controller has verified the work independently, the
changed paths pass `doc-truth` and the no-dash and secrets scans, one green
gate recipe covers the merged head, and `main` is fast-forwarded only then.

## 3. Crew: lanes, ownership and stop rules

Each lane runs in its own isolated git worktree on its own branch, exactly as
the work package protocol prescribes. The controller never commits to a lane
branch; a lane never merges or pushes `main`. Every lane reports with a READY
block before any integration.

| Lane                      | Branch                     | Scope (owned paths only)                                                                                                   | Verifier                                                                                    |
| ------------------------- | -------------------------- | -------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| L1 inbound facade         | `claude/wp-inbound-facade` | `apps/control-plane/api/server.ts`, `apps/control-plane/api/server.test.ts`, `apps/control-plane/api/openai-compatible.ts` | `NO_COLOR=1 node --test apps/control-plane/api/server.test.ts` plus control-plane typecheck |
| L2 settings audit         | `claude/h5-settings-audit` | `docs/HARNESS-SETTINGS.md`, `packages/workbench/src/harness-settings.ts`, its test file                                    | workbench `harness-settings` tests plus workbench typecheck                                 |
| L3 profile design A and B | `claude/h4-profile-design` | `docs/NOMO-AGENT-HARNESS-SPEC.md`, `docs/superpowers/designs/2026-10-29-h4-profile-*.md`                                   | doc-truth through the gate; no code paths                                                   |
| L4 baseline and reconcile | none (read only)           | no tree edits; writes one report and the work state                                                                        | gate recipe output plus `git log` census output                                             |

Hard rules for every lane, carried from `AGENTS.local.md`, `docs/STANDARDS.md`
and the work package protocol:

- The loop is `DISCOVER -> SPECIFY -> CHANGE -> VERIFY -> REVIEW -> RECORD`,
  one minimal slice, failing test first for behavior changes.
- Never edit or stage `packages/cli/src/tui/*` or the files of another active
  checkout or worktree. Never `git add -A` or `git add .`.
- No new dependency, no package manifest edit, no lockfile edit, no global
  setting change, no production action, no secrets read or exposed.
- No em or en dash anywhere. A commit message uses an imperative subject
  under 72 characters, a body wrapped at 80 columns and the Co-Authored-By
  trailer. `node_modules` provisioning uses only `pnpm install
--frozen-lockfile`.
- One heavy test process at a time. Lanes run focused suites, never the full
  gate; only the controller runs the gate recipe.
- A lane stops after one targeted repair attempt if a gate fails twice on the
  same sha, on any ownership conflict, on any secrets exposure risk, or when
  a decision is the operator's. It records the blocker with evidence and ends
  its turn.
- Model calls: never route a lane or subagent to any `glm` spelling; the
  main session model default stands.

## 4. The READY contract (lane to controller)

A lane ends by printing this block, adapted from the captain READY contract
to this repository, which merges by fast-forward instead of pull requests.
Verify every field before pinning anything in the train record.

```text
READY <scope-name> <branch> <full-40-char-sha>
TESTS <command> -> <pass/fail counts, real output>
SCOPE <files changed, with a one line reason each>
SCOPE-VIOLATION none | <what and why>
DIFF-STAT <insertions/deletions per area>
CHANGELOG <one line under [Unreleased] | not-applicable: docs only>
OPEN-QUESTIONS <numbered list | none>
NEXT <what the controller should do with it>
STATEMENT lane head frozen from now on
```

Any missing or false field sends the lane back. After the statement, the lane
head is frozen; a later push cancels the READY.

## 5. The controller merge loop

1. Receive READY blocks. Validate each field against the branch head.
2. Run the no-dash scan and the secret scan over the combined diff; reject
   anything that names a two-hyphen typographic character or carries a value
   that looks like a credential.
3. Use one read-only adversarial reviewer per risky lane, in parallel, only
   when no child reviewer is already active. Test-only and docs-only lanes do
   not require one.
4. Merge lanes into main in the scratch checkout, one at a time: land the
   lane content, run the focused verifier again at the merged tree, then the
   next lane. The tree at each prefix is recorded in the graph.
5. Run the gate recipe on a clean detached worktree at exactly the merged
   sha: install, desktop prepare, then `node scripts/src/check-tests.mjs`.
   Evidence in `/tmp/gaterun<N>.txt`. On Linux this runs as one background
   process instead of the macOS launchctl job the loop plan names; the
   recipe and its evidence files are otherwise identical.
6. On green: push the merged tree to `origin/main`, confirm with
   `git ls-remote`, and record sha, test counts, gate runtime and cost.
   On red: one diagnosed fix, one new gate; two reds on one sha stop the wave
   and are recorded as a blocker.
7. Record in the graph file and append the work log line to this plan's
   section 8, committed on `main` after the gate.

## 6. Waves after this one

| Wave | Content                                                                                                                                                                              | Gate                               |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------- |
| 2    | Integrate `feat/wp-regress` into `main` if the census and the owner decision agree: rebase or merge, full gate at the head, fast-forward under the standing rule                     | full gate green at the exact sha   |
| 3    | Inbound facade slice 2 (request streaming cap, plus `stream_options.include_usage` frames of the accepted spec) and the next connector classification slice if evidence calls for it | per slice                          |
| 4    | H4 profile store implementation from the frozen design, then H7 end-to-end proof, H8 documentation closure in both handbook editions, H9 integration                                 | full gate plus recorded transcript |
| 5    | Desktop and release gates from `docs/RELEASE-1.0.1-MATRIX.md` where the environment allows; each blocked acceptance row named honestly                                               | per matrix row                     |

The YC demand validation thread stays human. Crew output feeds it only as
evidence for interviews, never as a demand claim.

## 7. Authority and disputes

The context pack wins over this plan; this plan wins over a lane brief; a
cached checklist or a stale summary wins over neither. When code
disagrees with the pack, the code is wrong. When the pack is wrong, the fix
is a reviewed work package that updates it, and during the wave the affected
node is marked `blocked` and reported with evidence instead.

## 8. Work log (append only)

- 2026-10-29: pulled `origin/main` 3be97ae..27a67f4, fast-forward, clean
  tree; 13 remote branches fetched; `origin/feat/wp-regress` census started
  42 ahead; plan, graph and work state written; `pnpm install
--frozen-lockfile` provisioning started; wave 1 deployment follows this
  commit.
- 2026-10-29: H5 audit complete. docs/HARNESS-SETTINGS.md table and packages/workbench/src/harness-settings.ts agree on all 20 keys, defaults and ranges. Settings test 18/18 pass; workbench typecheck clean. No stray literal in harness-settings.ts beyond the table. Broader run-path literal audit (literals in index.ts, provider.ts, gui.ts, agents.ts that are not yet settings) is out of H5 scope and is recorded as follow-up node H5b.
- 2026-10-29: SPEC-INBOUND verification. The inbound OpenAI-compatible facade in apps/control-plane/api/server.ts already matches the approved spec dated 2026-11-07: auth via the global NOMO_CONTROL_TOKEN gate, GET /v1/models with created:0 and no ambient probing, POST /v1/chat/completions with text-only messages, exact catalog model, stream and stream_options.include_usage, structured 4xx rejections, disconnect cancellation of only the created run, usage from Workbench session events. server.test.ts 48/48 pass, control-plane typecheck clean. No code change.
- 2026-10-29: L4 gate re-run complete (with python venv on PATH). Clean detached worktree at 11d827a: 22 suites, 3384 tests, 0 failures, 3 UNRUN with named reasons (swift/apple-design no swift; script/apple-project no interpreter/SDK; script/desktop-rust no cargo/icons). appwrite-mcp now ran (venv). Code green; UNRUNs are environment/toolchain limits, not code defects. All processes started by this session are now stopped.

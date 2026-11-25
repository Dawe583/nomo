# NOMO 24-hour program, 2026-11-25

Status: proposal and execution order. Nothing in this file is implemented by
writing it. It is the work queue for the next ~26 hours of clean work, with
~6 hours of optional/gated work on top.

Companion analysis:
- `docs/plans/2026-11-25-tui-improvement-plan.md`
- `docs/plans/2026-11-25-harness-learning-rl-plan.md`
- `docs/plans/2026-11-25-nomo-master-workflow.md` (earlier graph)

## How to execute this program

Every node follows Discover -> Specify -> Change -> Verify -> Review -> Record.

1. Read the node, its scope and its verifier. Do not widen scope.
2. Change only the owned paths. One writer per file. `workspace.ts`,
   `workspace-runner.ts`, `index.ts` and `.nomo/work-state.json` are shared
   paths: nodes that touch them are serialised, never parallel.
3. Run the narrowest verifier first (`node --test <file>`, then
   `pnpm --filter @nomo/<pkg> typecheck`, then the wider gate).
4. Quote the observed output in `.nomo/work-state.json` and the Obsidian work
   log. A node without observed output is not done.
5. On failure: diagnose once, repair once, then mark the node blocked with the
   observed failure and move to an independent ready node.
6. Never commit, push, deploy, install a dependency or run a paid model call
   unless the current task asks for it.

Evidence format per node:

```
verifier: <exact command>
observed: <exit code> <counts or first failing line>
```

## Time budget

| Track | Nodes | Hours | Can run parallel with |
|---|---|---|---|
| A. TUI visual and interaction | T1-T17 | 15.5 | B (disjoint paths) |
| B. Harness measurement and learning | H1-H15 | 14.5 | A (disjoint paths) |
| C. RL policy search (achievable now) | R1-R7 | 8.0 | A |
| D. Quality, release readiness, docs | Q1-Q10 | 6.0 | A, B |
| E. Gated / optional | G1-G4 | 6.0 | nothing until gate opens |

Core A+B+C+D = **44 hours of node work**, of which ~26 hours are the critical
path because A and B are path-disjoint. E is optional and gated.

Realistic single-agent schedule (one writer, serialised shared paths):

| Block | Hours | Content |
|---|---|---|
| 1 | 3.0 | T1 design contract, Q1 graph hygiene, Q2 doc-truth |
| 2 | 4.0 | T2.1-T2.3 panel parity (serialised on workspace.ts) |
| 3 | 3.0 | H1 reward record, H2 variant identity |
| 4 | 4.0 | T3 composer ladder, T4 narrow terminals, T8 snapshots+PTY |
| 5 | 3.0 | H3 eval set v2, H4 reward replay |
| 6 | 4.0 | T2.4-T2.5, T5 pet/motion |
| 7 | 4.0 | R1 bandit sampler, R2 simulation |
| 8 | 3.0 | H5 activation/rollback, H6 trend |
| 9 | 3.0 | T6/T7 mouse+keyboard parity, T9 a11y, T10 perf |
| 10 | 3.0 | Q3-Q8 release readiness and final gates |

That is 34 hours of wall-clock blocks with ~4 hours of slack for failures and
re-verification. Cut from the bottom (E, then T11/T12, then R6/R7) if time is
short; never cut a verifier.

## Track A — TUI visual and interaction (15.5 h)

Baseline: 49 production files, 32,207 lines; 40 snapshots at five sizes; 54 PTY
assertions; p95 2.98 ms at 200x48. `renderWorkspace` returns exactly
`rows x columns`. The frame string is the contract.

| id | goal | scope | verifier | stop | h |
|---|---|---|---|---|---|
| T1 | One-page design contract: rail widths, slot ladder and drop order, glyph presets, tone vocabulary, border rules, motion budget, pet grid, colour-never-only rule | new `packages/cli/src/tui/DESIGN.md`, link from `README.md` | manual read; link check | every later T node names a rule it follows | 1.0 |
| T2.1 | `runs` panel to Chat standard: title, empty state, one measured fact per row, footer hint, hit targets | `workspace.ts`, `workspace.test.ts`, snapshots | `node --test packages/cli/src/tui/workspace.test.ts` | snapshot at 5 sizes + empty-state test | 1.5 |
| T2.2 | `mcp` panel: same standard, plus per-server state word | `workspace.ts`, `workspace-mcp.test.ts` | `node --test packages/cli/src/tui/workspace-mcp.test.ts` | state word is a string, not a colour | 1.5 |
| T2.3 | `status` panel: service health and ledger head as measured rows | `workspace.ts`, `health.ts` | `node --test packages/cli/src/tui/*.test.ts` | unmeasured stays `unmeasured` | 1.5 |
| T2.4 | `documents` panel: list, empty state, byte counts, no path leakage | `workspace.ts` | `node --test packages/cli/src/tui/*.test.ts` | no host path is printed | 1.5 |
| T2.5 | `usage` panel: tokens/cost per run, unmeasured when no producer | `workspace.ts`, `usage-visual.ts` | `node --test packages/cli/src/tui/*.test.ts` | a missing producer prints unmeasured | 1.0 |
| T3 | Composer slot ladder: priority `mode > queue > model > context > pet`; drop whole; no new row at 40 cols; decide the blocked mode-chip in writing | `workspace.ts`, `workspace.test.ts`, `docs/DECISIONS.md` | rail-cell assertions + PTY 40x12 | rail is exactly `columns` cells at every size; action hint survives 40x12 | 1.5 |
| T4 | Narrow-terminal audit at 40x12 and 52x16: title, primary fact, escape hint survive | `workspace.ts`, snapshots | PTY matrix + 40x12 snapshots | no screen loses its hint | 1.5 |
| T5.1 | Pet reaction to a completed run (one pose, no new rows) | `pet.ts`, `pet.test.ts` | `node --test packages/cli/src/tui/pet.test.ts` | every pose fits 9x5 | 1.0 |
| T5.2 | Second blink rhythm and a listening pose distinct in silhouette | `pet.ts`, `pet.test.ts` | same | frames are a pure function of the counter | 1.0 |
| T5.3 | Motion budget: one frame per 100 ms, reduced motion byte-identical | `motion.ts`, `a11y.test.ts` | `node --test packages/cli/src/tui/a11y.test.ts` | frozen frame equals animated frame's words | 0.5 |
| T6 | Mouse parity: wheel, click, selection across panels; hit targets stay in sync after resize | `mouse-selection.ts`, `workspace-runner.ts` | `node --test packages/cli/src/tui/workspace-terminal.test.ts` | click on every tab and row kind is tested | 1.0 |
| T7 | Keyboard focus parity: Tab order, Escape return, no stale focus after a panel closes | `workspace-runner.ts` | `workspace-input-parity.test.ts` | every panel returns focus to Chat | 1.0 |
| T8 | Snapshot + PTY refresh for T2-T5; prove the diff is hash-only and reviewed | `test/visual-snapshots.json`, `scripts/src/verify-tui-terminal.py` | `NOMO_UPDATE_SNAPSHOTS=1` then clean run; PTY | exactly the intended frames move | 1.0 |
| T9 | Accessibility pass: every new fact is a string; ASCII preset parity | `a11y.test.ts` | `node --test packages/cli/src/tui/a11y.test.ts` | monochrome/ASCII carry the same words | 1.0 |
| T10 | Re-measure frame cost; record headroom | `perf-budget.test.ts` | `node --test packages/cli/src/tui/perf-budget.test.ts` | p95 under 50 ms at 200x48 | 0.5 |
| T11 | Optional: one-screen Ink parity spike behind an adapter, byte-diffed at 5 sizes | new spike file, not wired | diff vs snapshots | empty diff or the spike is removed | 2.0 |
| T12 | Optional: retire the orphan `scripts/src/verify-opentui-terminal.py` with a recorded reason | that file | `git diff --check` | no caller remains and the reason is in the graph | 0.5 |

## Track B — Harness measurement and learning (14.5 h)

Baseline: frozen taskset with paired runs and exact-match scoring; score board
with `unmeasured`; refinement outcomes and measured effects; persisted cooldown;
metric producers for `approvalMs`, `costUsd`, `recovery`; signed chain.

| id | goal | scope | verifier | stop | h |
|---|---|---|---|---|---|
| H1 | Reward record per evaluated case: `caseId`, `variantId`, `passed`, guardrails, cost, latency, approvalMs, weights | `harness-scores.ts`, `harness-eval.mjs`, new test | `node --test packages/workbench/src/harness-scores.test.ts` | reward recomputable from the chain alone | 2.0 |
| H2 | Variant identity: digest of settings+prompt+model written with each case; one axis differs | `harness-settings.ts`, `harness-eval.mjs` | eval run with two variants | two runs differ only by the changed axis | 1.5 |
| H3 | Eval set v2: 12+ tasks covering read-before-write, hold, timeout, truncation, compaction, SSRF, plan/todo; frozen versions | `scripts/src/fixtures/harness-eval-core.json` (v2 file) | `node scripts/src/harness-eval.mjs <file>` | both splits named, no task edited after freezing | 2.0 |
| H4 | Reward replay: recompute a case's reward from chain records only | new `scripts/src/harness-replay.mjs` + test | `node --test scripts/src/harness-replay.test.mjs` | replay matches the stored reward | 1.0 |
| H5 | Activation and rollback wiring: exact digest, approval, rollback on guardrail regression | `refine-trigger.ts`, `workspace.ts` | `node --test packages/workbench/src/refine-trigger.test.ts` | no activation without a typed digest | 1.5 |
| H6 | Trend report: per activation pass rate, reward, guardrail state, sample count, delta | `packages/cli/src/harness.ts` or a workbench view | fixture chain with two activations | insufficient data stays insufficient | 1.0 |
| H7 | Held-out split enforcement: train/eval split by task id, eval never used for selection | `harness-eval.mjs` | test that a training task cannot score eval | split is mechanical | 1.0 |
| H8 | Guardrail regression detector: any measured guardrail worse than the previous activation blocks | `harness-scores.ts` | fixture regression fails the gate | unmeasured is never a pass | 1.0 |
| H9 | Trajectory export for a future trainer: prompt, tool calls, verifier outcome, reward; content-minimised | new `scripts/src/trajectory-export.mjs` + test | test asserts no prompt text reaches the file | export holds ids and outcomes only | 1.5 |
| H10 | Cost/latency weights as documented settings with a consumer | `harness-settings.ts`, inventory test | `node --test scripts/src/harness-inventory.test.mjs` | no documented gap | 1.0 |
| H11 | Eval runner adapter: a local runner that answers the taskset through the governed path | `scripts/src/harness-eval-runner.mjs` | eval run prints per-task results | no model grading, no network without approval | 1.5 |
| H12 | Learning-loop documentation: how a proposal becomes an activation and a rollback | new `docs/HARNESS-LEARNING.md` | manual read | one page, cites the records | 0.5 |
| H13 | Chain record schema versioning for reward records | `packages/ledger/src/store.ts` | `node --test packages/ledger/src/*.test.ts` | old records still verify | 1.0 |
| H14 | Operator command: `nomo harness reward <case>` and `nomo harness trend` | `packages/cli/src/harness.ts` | CLI test | prints measured or unmeasured, never a guess | 1.5 |
| H15 | End-to-end dry run of the loop with fixture rewards, no model call | scripts + fixture | `node --test scripts/src/harness-*.test.mjs` | a fixture proposal activates and rolls back | 1.0 |

## Track C — RL policy search, achievable now (8 h)

Honest scope: a contextual bandit over harness variants, not gradient RL.
Gradient RL is G1 and stays gated.

| id | goal | scope | verifier | stop | h |
|---|---|---|---|---|---|
| R1 | Arm definition: at most 4 variants per axis (compaction threshold, tool-result ceiling, prompt preamble) | `harness-settings.ts`, new `harness-arms.ts` | unit test | each arm has a digest and a default | 1.0 |
| R2 | Thompson sampler with a token budget and a stopping rule | new `harness-bandit.ts` + test | simulation over fixture rewards | prefers the better arm; stops at budget | 2.0 |
| R3 | Reward aggregation per arm with cost and latency penalties | `harness-scores.ts` | unit test | weights come from settings, not constants | 1.0 |
| R4 | Exploration guard: never explore a guardrail-changing axis without approval | `harness-bandit.ts` | test refuses that axis | refusal is explicit | 1.0 |
| R5 | Activation from a sampled arm through the existing gate | `refine-trigger.ts` | integration test | activation names arm and digest | 1.5 |
| R6 | Simulation report: regret, samples per arm, stop reason | `scripts/src/harness-bandit-sim.mjs` | run prints a table | no model call | 1.0 |
| R7 | Document the difference between bandit, policy search and gradient RL in the operator doc | `docs/HARNESS-LEARNING.md` | manual read | no claim of RL training | 0.5 |

## Track D — Quality, release readiness, docs (6 h)

| id | goal | scope | verifier | stop | h |
|---|---|---|---|---|---|
| Q1 | Graph hygiene: no duplicate ids, no dangling deps, every done node has evidence | `.nomo/work-state.json` | node script | 0 duplicates, 0 dangling | 0.5 |
| Q2 | Fix the two doc-truth failures: dead-path inventory and stale inventory | `docs/`, `scripts/src/doc-truth.test.mjs` | `node --test scripts/src/doc-truth.test.mjs` | 9/9 | 1.0 |
| Q3 | Module inventory: settle the last orphan `test-fixture.ts` (wire or allowlist with a reason) | `scripts/src/module-inventory.test.mjs` | `node --test scripts/src/module-inventory.test.mjs` | 2/2 with a reason | 0.5 |
| Q4 | Harness inventory: regenerate and confirm the gap list is empty | `scripts/src/harness-inventory.test.mjs` | same | every documented key present, empty gap list | 0.5 |
| Q5 | Provider smoke re-run against the local Zen provider; record latency and tokens, never the key | `scripts/src/provider-smoke.mjs` | `node scripts/src/provider-smoke.mjs` | PASS or SKIP with a reason | 0.5 |
| Q6 | Release readiness checklist: version, changelog, dist freshness, launcher | `packages/cli/dist/`, `CHANGELOG.md` | `node scripts/src/bundle-cli.mjs`; `nomo --version` | dist is newer than source | 1.0 |
| Q7 | Dependency audit: no new dependency without a recorded reason; lockfile clean | `package.json`, `pnpm-lock.yaml` | `pnpm install --frozen-lockfile --offline` | no drift | 0.5 |
| Q8 | Local CI dry run: typecheck, TUI, workbench, scripts suites in the documented order | root | `pnpm run typecheck`; `pnpm run test:tui`; workbench suite | all green or a named pre-existing failure | 1.0 |
| Q9 | Update `docs/CONTEXT.md` / `docs/STANDARDS.md` only if this program changed a contract | those docs | manual read | no contradiction | 0.5 |
| Q10 | Final handoff: one page with what shipped, what is blocked, and the next ready node | new `docs/plans/2026-11-25-program-handoff.md` | manual read | a new session can start from it | 0.5 |

## Track E — Gated / optional (6 h, needs a decision)

| id | gate | work | h |
|---|---|---|---|
| G1 | A trainable local model and GPU budget exist | SFT then DPO over H9 trajectories; held-out eval before/after; activation only through H5 | 4.0 |
| G2 | Owner still wants a library surface after T1-T10 | full parity adapter for one screen, then a second, byte-diffed at 5 sizes | 2.0 |
| G3 | Owner approves a paid benchmark | run the frozen taskset against a hosted model, record cost | 1.0 |
| G4 | Owner approves release | tag, changelog, push, deploy | 1.0 |

G1 is the only node that would justify the phrase "RL training". Until it runs,
the repository has a measured learning loop and a bandit, not RL.

## Milestones and gates

| Gate | After | Pass condition |
|---|---|---|
| M1 design frozen | T1 | DESIGN.md exists and every open T node cites it |
| M2 visual parity | T2.1-T2.5, T8 | 40+ snapshots and 54+ PTY assertions green at 5 sizes |
| M3 measurable reward | H1, H2, H4 | a case's reward is reproducible from the chain |
| M4 real eval set | H3, H7, H11 | 12+ tasks, held-out split, runner adapter |
| M5 learning loop closed | H5, H6, H8, H15 | a fixture proposal activates, is measured, and rolls back |
| M6 policy search | R1-R5 | one sampled arm activated with a digest and a rollback |
| M7 release ready | Q1-Q8 | full local gate green, dist fresh |
| M8 RL (gated) | G1 | held-out eval does not regress after training |

## Risk register

| Risk | Signal | Mitigation |
|---|---|---|
| `workspace.ts` merge pain | two T nodes touch it at once | serialise T2 nodes; one writer per file |
| Snapshot churn hides a real regression | many hashes move at once | review the rendered frame before accepting; accept only named frames |
| Reward is gamed by a weak verifier | pass rate up, guardrails down | H8 blocks on any measured regression; unmeasured never passes |
| Bandit overfits the eval split | train/eval gap widens | H7 mechanical split; held-out never used for selection |
| Cost blow-up during exploration | token spend per day | R2 budget; no paid model without approval |
| "RL" claim outruns the code | docs say RL, no weights change | R7 wording; G1 gate |
| TUI library attempt repeats 2026-11-25 | a surface looks worse than the current one | T11/G2 parity gate only, never default |
| Long program loses the thread | nodes done without evidence | Q1 graph hygiene; evidence format per node |

## Explicitly out of scope

- Big-bang renderer rewrite.
- A library surface as the default before byte-for-byte parity.
- Gradient RL without a trainable model and GPU budget.
- Hosted CI, paid benchmarks, release, push or deploy without explicit approval.
- Deleting a test, a snapshot or a guardrail to reach green.
- Any secret in a record, a document or a log.

## Definition of done for the program

1. Every node in A-D is either done with quoted verifier output, or blocked with
   the observed failure and a named missing authority.
2. `pnpm run typecheck`, `pnpm run test:tui`, the workbench suite and the
   scripts suites are green, or every failure is pre-existing and named.
3. The Obsidian work log carries one entry per milestone, not per keystroke.
4. `.nomo/work-state.json` has no duplicate ids, no dangling dependencies and no
   done node without evidence.
5. A new session can start from `docs/plans/2026-11-25-program-handoff.md` and
   find the next ready node without re-discovery.

## Addendum, 2026-11-25: audit and Track F

`docs/plans/2026-11-25-plan-audit.md` audits this program against the README's
product-v1 gates. Verdict: the program moves engineering quality and the "safe
learning" gate, but two of the three named v1 gates (operator approval
end-to-end, later-session retrieval) had no node, and the control-plane claim
had none either. Track F (F1-F4, 12 h) corrects that and is ordered **before**
T2.x, T4-T7 and T9-T10. T2.4, T2.5, T5.2, T6 and T7 move to the backlog if the
clock runs out. F1-F3 never move.

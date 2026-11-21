# NOMO Harness Loop Plan

Status: active, 2026-10-21. Scope: the coding-agent Harness as a NOMO product-v1
release gate. Owner: the main session. The task graph in `.nomo/work-state.json`
remains the execution state. The context pack (`docs/CONTEXT.md`,
`docs/DECISIONS.md`, `docs/STANDARDS.md`), the harness specs
(`docs/NOMO-AGENT-HARNESS-SPEC.md`, `docs/NOMO-AGENT-HARNESS-IMPLEMENTATION-SPEC.md`)
and `docs/HARNESS-SETTINGS.md` remain authoritative for product and security
contracts. This document turns them into one graph and one loop, so no future
slice needs a prompt from the user.

## 1. Goal and definition of done

Close the Harness learning loop end to end: a refusal is mined into a proposal,
an operator approves its exact digest, the refinement activates, later turns
retrieve only approved and verified records, and the ratchet reports what
happened. Then make skill and subagent promotion use the same evidence chain,
and prove the whole path with a real agent session through the proxy.

The program is done when all of the following hold:

- Every node in section 6 is `done` with captured evidence.
- `pnpm run typecheck` exits 0 and the full gate is green at the lane head.
- The lane is fast-forwarded to `main` and verified with `git ls-remote`.
- Both handbook editions and the harness README describe the same behavior.
- The Obsidian work log and the memory `project` block record the closure.

Out of scope by decision, not by omission: the Python REPL runtime, prompt
hillclimb as a product feature, cloud or distributed budgets, multi-workspace
RBAC, and any change to the foreign TUI lane (`packages/cli/src/tui/*`).

## 2. Authority

- Code, tests and the context pack win over generated graphs. Graphify and
  Understand Anything are navigation only.
- Learning never changes policy, permissions or credentials. A mined rule is
  evidence until an operator pastes it into their own file.
- A proposal is inert until its exact digest is approved. Retrieval is bounded,
  same-workspace and sourced only from approved, verified records.
- Unknown identity, scope, policy, broker, revocation or ledger state fails
  closed. `observe-only` is an explicit opt-in.
- Secrets, tokens, prompt bodies and raw payloads never enter logs, events,
  ledger payloads, screenshots or durable state.
- Foreign files in active worktrees are never edited and never staged.

## 3. Operating contract

### 3.1 One graph, one active node

`.nomo/work-state.json` is the single execution state. Each node carries a
stable id, status (`ready`, `active`, `blocked`, `done`, `reverted`), owner,
dependencies, allowed paths, acceptance criteria, verifier, evidence and stop
condition. Only one node is `active` at a time. A node is `done` only with
captured evidence. Parallelism is optional and never the default.

### 3.2 The loop

Every node runs `DISCOVER -> SPECIFY -> CHANGE -> VERIFY -> REVIEW -> RECORD`:

1. Discover: read the context pack, the graph, the relevant source and tests,
   and the Obsidian work log. Inspect `git status`, active worktrees and the
   subagent count.
2. Specify: one expected behavior and one minimal slice. State the failing test
   before the change.
3. Change: only owned paths. Preserve foreign dirty changes. No dependency
   install and no global setting change.
4. Verify: focused test first, then typecheck, then the relevant wider suite,
   then the diff checks (no em or en dash, no secrets, no colour literal).
5. Review: inspect the full diff. Use one read-only subagent only when the risk
   justifies it and no child is already active.
6. Record: update the graph evidence, the Obsidian work log and the memory
   `project` block.

### 3.3 Commit and integration

- Stage only the named paths. Never `git add -A` or `git add .`.
- Commit with `git commit -F /tmp/msgfile`, imperative subject under 72
  characters, body wrapped at 80 columns, trailer
  `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`.
- Push immediately: `env -u GH_TOKEN -u GITHUB_TOKEN git push origin feat/wp-regress`.
- Gate at the lane head with one launchctl job. Clean worktree
  `/tmp/nomo-gaterun-clean`, detached checkout, `pnpm --dir apps/desktop run prepare:runtime`,
  then `node scripts/src/check-tests.mjs`. Evidence in `/tmp/gaterunN.txt` and
  `/tmp/gaterunN-launchd.log`. Sleeps of at most 110 seconds.
- Fast-forward `main` only after a green gate at that exact sha:
  `git push origin <sha>:main`, then verify with `git ls-remote`.
- A red gate gets one diagnosed fix and one new gate. Two red gates in a row
  stops the loop and is recorded as a blocker.

### 3.4 Blocker handling

When a node needs a product decision, the user has already authorized the main
session to decide and record it, provided the decision is consistent with the
context pack. When a node needs a file owned by another lane, do not edit it;
record the dependency and take the next independent node. Never idle-poll for a
foreign commit. When a node is blocked twice, stop and report.

### 3.5 Record formats

- Work-state node: `id`, `status`, `owner`, `paths`, `goal`, `acceptance`,
  `verifier`, `stopCondition`, `evidence`.
- Work log entry: changed areas, exact verifier commands with observed output,
  blockers, next node.
- Memory `project` block: one durable fact per line, no duplication of the
  work log.

## 4. Settings

| Setting | Where it lives | Purpose |
| --- | --- | --- |
| Task graph | `.nomo/work-state.json` | Single execution state; schema in section 3.1 |
| Loop contract | `AGENTS.local.md` (this repository) | Standing loop and skill entrypoints |
| Loop skills | `.agents/skills/nomo-loops/SKILL.md`, `nomo-graphs/SKILL.md`, `nomo-pipeline/SKILL.md`, `.opencode/skill/nomo-work-package.md` | Procedures for loops, graphs and delivery |
| Gate recipe | Section 3.3 above | One launchctl job, clean tree, evidence files |
| Test commands | Section 7 below | Focused and wide verification |
| Branch policy | Section 3.3 above | Push per commit, main ff only on green |
| Protected paths | `packages/cli/src/tui/*`, foreign worktree files | Never edited or staged |
| Handbook pair | `docs/HANDBOOK.md` and `docs/HANDBOOK.cs.md` | Every handbook change touches both |
| Harness settings | `docs/HARNESS-SETTINGS.md`, `packages/workbench/src/harness-settings.ts` | Operator limits; no new dependency |

No new infrastructure is added by this plan. The skills above are reused as-is.

## 5. Decisions taken on 2026-10-21

D1. The ratchet stays descriptive. It never refuses, changes or gates a
refinement. The reason is in the spec: the score never changes a gate, policy
or permission, and an unmeasured guardrail cannot be a gate. The ratchet is
attached to the review so the operator decides with evidence. The report labels
each guardrail as measured or unmeasured.

D2. `rollback_count` counts a rollback of an activated harness refinement,
written by `rollbackHarnessProposal` as `event: "rollback"`. A document undo is
not this metric; it is agent correctness, not harness churn. H1 implements the
writer.

D3. `unknown_tool_rate` becomes measurable only when a connector call records a
classification outcome. H2 adds an additive `classification` field to the
signed body, set to `unclassified` when the registry has no case. Chains
without the field stay unmeasured, which keeps the existing tests honest.

D4. Skill and subagent promotion stays proposal-only until a profile store joins
the evidence chain. H4 designs and implements that store; until then the agent
tools for those kinds remain disabled.

D5. The terminal compaction summary stays blocked on the foreign TUI lane. The
workbench API is ready; no TUI file is edited here.

D6. No new dependency, store or transport is added by this plan.

## 6. Work graph

Each node follows the loop in section 3.2. Statuses are tracked in
`.nomo/work-state.json`.

- H0. Graph and settings bootstrap. Status: active. Paths:
  `docs/HARNESS-LOOP-PLAN.md`, `AGENTS.local.md`,
  `.agents/skills/nomo-loops/SKILL.md`, `.agents/skills/nomo-graphs/SKILL.md`,
  `.agents/skills/nomo-pipeline/SKILL.md`. Verifier: `pnpm run typecheck` is
  not applicable to docs; run `node scripts/src/doc-truth.test.mjs` via the
  gate. Stop: the plan, the contract and the skills are tracked and pushed.

- H1. Rollback evidence. Status: ready. Paths:
  `packages/workbench/src/index.ts`, `packages/workbench/src/harness-scores.ts`,
  `packages/workbench/src/harness-rollback.test.ts`. Goal: write
  `event: "rollback"` on every rollback record and count it in
  `rollback_count`. Verifier:
  `NO_COLOR=1 node --test packages/workbench/src/harness-rollback.test.ts packages/workbench/src/harness-scores.test.ts`
  plus `npx tsc -p packages/workbench/tsconfig.json --noEmit`. Stop: the writer
  and the metric agree on one chain.

- H2. Unknown-tool classification evidence. Status: ready, depends on H1. Paths:
  `packages/workbench/src/index.ts`, `packages/workbench/src/harness-scores.ts`.
  Goal: record `classification: "unclassified"` in the signed body when the
  registry has no case, and count it in `unknown_tool_rate`. Verifier:
  focused workbench tests plus typecheck. Stop: a chain with an unclassified
  connector call reports a measured rate; chains without the field stay
  unmeasured.

- H3. Ratchet review surface. Status: ready, depends on H1 and H2. Paths:
  `packages/cli/src/harness.ts`, `apps/control-plane/ui/src/harness-entries.ts`,
  `apps/control-plane/ui/src/harness-entries.tsx`. Goal: show the three
  guardrails with measured or unmeasured labels next to a proposal review.
  Verifier: `node --test` for the CLI and UI test files plus typecheck.
  Stop: the operator sees guardrail movement before approving.

- H4. Profile evidence chain. Status: blocked on design, depends on H3. Paths:
  `packages/workbench/src/agents.ts`, `packages/workbench/src/refine-pass.ts`,
  `docs/NOMO-AGENT-HARNESS-SPEC.md`. Goal: a skill or subagent promotion
  writes the prior and next profile into the signed chain with digest approval
  and rollback. Verifier: refinement and rollback tests. Stop: a rollback
  restores a profile the way it restores an entry.

- H5. Harness settings audit. Status: done. Paths:
  `docs/HARNESS-SETTINGS.md`, `packages/workbench/src/harness-settings.ts`.
  Goal: document the limits that govern runs and remove any remaining literal.
  Verifier: typecheck and the settings tests. Stop: every limit is named in one
  table.

- H5b. Broader run-path literal audit. Status: implemented 2026-11-21, pending
  the gate. Paths: `packages/workbench/src/harness-settings.ts`,
  `packages/workbench/src/index.ts`, `packages/workbench/src/provider.ts`,
  `packages/workbench/src/gui.ts`, `packages/workbench/src/agents.ts`,
  `docs/HARNESS-SETTINGS.md`. Goal: audit every remaining numeric literal on
  the run path across the four consumer files; promote `providerRequestTimeoutMs`,
  `toolRequestTimeoutMs` and `maxToolResultCharacters` into the settings table,
  wire `checkContextBudget` and `streamReply` to respect `maxOutputTokens` and
  `maxToolCallsPerTurn`, and document every remaining literal as deliberately
  fixed. Verifier: `pnpm run typecheck`, settings/wiring/TUI/API settings tests,
  `doc-truth` and `no-dash`. Stop: every run-path literal is either backed by a
  setting with a named consumer or explicitly recorded as fixed.

- H6. Terminal compaction summary. Status: blocked on the foreign TUI lane.
  Paths: `packages/workbench/src/context.ts`, `packages/workbench/src/index.ts`,
  `packages/cli/src/tui/*` (foreign, not edited here). Goal: the terminal
  reads the compaction summary through a non-blocking surface. Verifier:
  `pnpm run test:tui` once the lane is available. Stop: the summary shows
  without blocking the render loop.

- H7. End-to-end harness proof. Status: implemented 2026-11-21, pending the
  gate. Paths: `packages/workbench/src/harness-proof.test.ts`,
  `packages/workbench/src/index.ts`,
  `docs/superpowers/evidence/2026-11-21-h7-harness-proof.md`. Goal: one real
  agent session through the proxy produces a refusal, a mined proposal, an
  approved activation, bounded retrieval, H10 outcome feedback and a measured
  H11 ratchet effect, with both chains verified offline. Verifier:
  `NOMO_H7_TRANSCRIPT=1 NO_COLOR=1 node --test packages/workbench/src/harness-proof.test.ts`
  plus the gate. Stop: the transcript is attached in
  `docs/superpowers/evidence/2026-11-21-h7-harness-proof.md` and both chains
  verify offline.

- H8. Documentation closure. Status: implemented 2026-11-21, pending the gate.
  Paths: `docs/HANDBOOK.md`, `docs/HANDBOOK.cs.md`,
  `packages/workbench/README.md`, `docs/HARNESS-SETTINGS.md`. Goal: both
  handbook editions and the README state what the code does with links to
  audited settings and the H7 proof transcript. Verifier:
  `scripts/src/handbook.test.mjs`, `scripts/src/doc-truth.test.mjs`,
  `scripts/src/no-dash.test.mjs` and the gate. Stop: no claim without a
  measurement.

- H9. Integration. Status: ready, depends on H0 through H8. Paths: repository
  root. Goal: one green gate at the lane head, main fast-forwarded, verified.
  Verifier: `node scripts/src/check-tests.mjs` inside the gate. Stop: the gate
  is green or a double-red blocker is recorded.

- H10. Refinement outcome feedback. Status: implemented 2026-11-21, pending
  the gate. Paths: `packages/workbench/src/refinement-outcomes.ts`,
  `packages/workbench/src/harness-runtime.ts`, `packages/workbench/src/index.ts`.
  Goal: the reviewer reads the signed fate of the workspace's earlier
  proposals, and a rejected or rolled back refinement cannot be proposed again
  without newer evidence. Verifier:
  `NO_COLOR=1 node --test packages/workbench/src/refinement-outcomes.test.ts packages/workbench/src/harness-outcome-feedback.test.ts packages/workbench/src/harness-runtime.test.ts`
  plus the workbench typecheck. Stop: an outcome never reaches `decide`,
  policy or the agent prompt. Design record:
  `docs/superpowers/designs/2026-11-21-h10-refinement-outcome-feedback.md`.

- H11. Refinement effect measurement. Status: implemented 2026-11-21, pending
  the gate. Paths: `packages/workbench/src/harness-scores.ts`,
  `packages/workbench/src/refinement-outcomes.ts`,
  `packages/workbench/src/harness-runtime.ts`,
  `packages/workbench/src/index.ts`, `packages/cli/src/harness.ts`. Goal:
  measure the descriptive before-and-after effect of each signed refinement
  activation from the verified chain, show it to the reviewer inside
  `maxPromptCharacters` and to the CLI operator in `nomo harness ratchet`,
  and explicitly label unmeasured guardrails. Verifier: workbench typecheck,
  `packages/workbench/src/*.test.ts`, `packages/cli/src/harness.test.ts`,
  `scripts/src/doc-truth.test.mjs`, `scripts/src/no-dash.test.mjs`. Stop:
  any path where a score changes state, triggers rollback or enters `decide`
  or the agent prompt stops the node (decision D1). Design record:
  `docs/superpowers/designs/2026-11-21-h11-refinement-effect.md`.

## 7. Verification commands

- Typecheck: `npx tsc -p packages/workbench/tsconfig.json --noEmit`
- Workbench focused: `NO_COLOR=1 node --test packages/workbench/src/harness-rollback.test.ts packages/workbench/src/harness-scores.test.ts`
- Workbench wide: `NO_COLOR=1 node --test packages/workbench/src/*.test.ts`
- CLI and UI: `NO_COLOR=1 node --test packages/cli/src/harness.test.ts apps/control-plane/ui/src/*.test.ts`
- Full: `pnpm run typecheck` then the gate recipe in section 3.3
- Dash check: `git diff --cached | LC_ALL=C.UTF-8 grep -nP '[\x{2013}\x{2014}]'` must be empty
- Doc truth: `node scripts/src/doc-truth.test.mjs` through the gate
- Licence line: `node scripts/src/licence-line.test.mjs` through the gate

## 8. Risks and stop rules

- Swift macro flake: retry once, then stop on a double red.
- CSS budgets: a new block inherits the card size and carries no radius.
- Unmeasured guardrails: report them, never treat them as passing or failing.
- Foreign TUI files: never edited, never staged.
- Gate runtime: 15 to 20 minutes; do not poll; read the evidence files when
  the job finishes.

## 9. Immediate execution order

1. H0: track this plan, the contract and the skills, then push.
2. H1: rollback evidence, then H2 classification evidence.
3. H3: review surface.
4. H4: design the profile store, then implement.
5. H5: settings audit.
6. H7: end-to-end proof.
7. H8 and H9: documentation and integration.

## 10. Authorization

The user authorized the standing loop on 2026-10-21: continue safe, in-scope
nodes without re-prompting, commit and push after each verified slice, and
fast-forward `main` after a green gate. Scope is limited to the NOMO repository,
with no production access, no secrets, no dependency installs and no global
setting changes.
EOF
echo written
# NOMO harness next plans

Status: proposed 2026-11-24 from a source audit at HEAD `1620bbe0`. Plan A is
in progress; plans C and D are open; plan B's TUI slice and plan E are done.
Ordered by evidence, not ambition.

Landed on 2026-11-24:
- plan E: `scripts/src/harness-inventory.test.mjs` (settings doc to source
  parity, with a self-pruning gap list) and `scripts/src/module-inventory.test.mjs`
  (no workbench module may be imported only by tests). Both proved to fail on
  the exact regression class the merge shipped.
- plan B, ratio half: `unknown_tool_rate` now samples `unknown/classified`
  instead of a raw count, so a longer chain no longer looks worse.
- plan B, TUI slice: the score row no longer prints a rate, CI and sample count
  for a metric whose sample count is structurally zero; the qualifier now sits
  under the verdict; score and harness are hoisted above the unbounded record
  list while signed entries stay above the derived groups.

## The finding that reorders everything

Merge `d7b55f38` ("upstream-only orphaned workbench modules removed") deleted
17 files and severed 7 imports in `packages/workbench/src/index.ts`. The
upstream tests that pin those contracts were kept, so mainline is red:

- full workbench package run: **1310 tests, 1276 pass, 31 fail, 3 skipped**
- the 31 failures are **real source regressions**, not stale tests
  (verifier audit; the opposite of the initial hypothesis)
- the same merge edited `harness-settings.test.ts` to delete three expected
  keys, so a documented setting loss stays green

What the merge removed, proved by ancestry (`14a77b36` -> HEAD):

| Capability | Evidence |
|---|---|
| 24 public `Workbench` methods | `createSchedule`, `listSchedules`, `promotedSkills`, `harnessEffects`, `harnessOutcomes`, `startGoal`, `promoteHarnessProposal`, `demoteHarnessPromotion`, ... |
| 7 module imports | `goals.ts`, `delegate-tools.ts`, `profile-promotion.ts`, `skill-promotion.ts`, `agent-messages.ts`, `web-tools.ts`, `schedules.ts` |
| 17 files | `operator-harness.ts`, `refinement-outcomes.ts`, `project-read.ts`, `openai-chatgpt-auth.ts`, ... |
| 6 documented settings | `providerRequestTimeoutMs`, `toolRequestTimeoutMs`, `maxToolResultCharacters`, `autoCompactMessages`, `sessionSearchEnabled`, `webToolsEnabled` |

`docs/HARNESS-LOOP-PLAN.md` still marks HP5, HP7, HP9, HP10, HP11 and H4b as
implemented. They are not.

## Plans

### Plan A - Restore the deleted workbench wiring (31 red tests)

Goal: the 31 failures go green by restoring the source, not by deleting tests.

Owned paths: `packages/workbench/src/index.ts` (sole writer), plus the intact
module files and `harness-settings.ts`.

Groups: schedules (10), web tools (7), agent messaging (5), skill promotion
(4), delegation (2), profile review (1), provider projection (2, contract
decision).

Acceptance: `node --test --test-concurrency=1` inside `packages/workbench`
reports 0 fail; `pnpm --filter @nomo/workbench typecheck` exits 0.

Stop condition: each group green after at most one targeted repair, or blocked
with the failing assertion quoted.

Risk of doing nothing: red mainline makes every future "green" claim false, and
six advertised capabilities stay missing.

Smallest first slice: schedules (wiring only, `schedules.ts` is intact).

### Plan B - Make the harness unable to lie about itself

Goal: every claim the harness shows resolves to a real sample, or says it is
unmeasured at the point of the claim.

Evidence of the problem:
- `harness-scores.ts:408` calls `summariseCases([], ...)`, so `first_pass_rate`
  is permanently `n=0`; `compareBoards` therefore always returns
  `insufficient-data`.
- `unknown_tool_rate` is a raw count labelled `unit: "ratio"` and its
  denominator grows with chain length (`:78-83`, `:395-397`).
- `approvalMs`, `costUsd` and `event:"recovery"` have no production writer.
- the TUI groups cases per workspace (1 case for a single-workspace operator)
  while CLI/API group per `tool|klass`; the board can never leave
  `insufficient-data` on the TUI path.

Acceptance: a metric with no producer is not printed as a number; the TUI and
CLI group cases the same way; one test per metric proves the producer exists.

Stop condition: the board's verdict and its reasons agree at 40x12 and 120x40.

Smallest first slice: drop `first_pass_rate` from the TUI headline and label
the verdict with its discriminator (`flat · no baseline`).

### Plan C - Give the reviewer the fate of its own proposals

Goal: an identical re-proposal of a rejected or rolled-back proposal is refused
unless it cites a newer record.

Evidence: `refinement-outcomes.ts` was deleted in the merge; the review request
carries entries, tail, rule count and lens count but no fates
(`index.ts:6930-6985`).

Acceptance: a RED-first test proves the refusal names the earlier digest and
seq; the fate block stays inside `maxPromptCharacters`.

Stop condition: focused suite green, typecheck 0.

Smallest first slice: the fate list in the review request, no refusal rule yet.

### Plan D - Bound the harness's own cost

Goal: a refused boundary is actually free.

Evidence: `serviceHarnessBoundary` awaits `deps.entries()` **before** the gate
(`harness-runtime.ts:248`), and that is a full `verifyChain` with per-record
Ed25519 plus a full re-mine - on every follow-up turn and every refused
boundary. `refine-gate.ts:5-9` claims "every check below is deterministic and
free". The gate now runs before the chain read, and the cooldown state is
persisted with the other harness state (`refine-trigger.ts`), so a restart
inside the cooldown refuses with `under-cooldown` instead of buying a review.
Verified 2026-11-25: workbench 1363 tests, 1360 pass, 0 fail, 3 skipped.

Acceptance: a refused boundary performs no chain verification (counted, not
asserted by prose); the cooldown survives a restart; shutdown does not spend.

Stop condition: measured counts in a fixture, not a claim.

Smallest first slice: move the gate before the entries await, with a fixture
that counts `verifyChain` calls.

### Plan E - Capability inventory gate

Goal: a merge that deletes a module or a settings key fails locally.

Evidence: `doc-truth.test.mjs` covers no HARNESS document, so 17 deleted files
and 6 deleted keys produced no failure.

Acceptance: `node scripts/src/harness-inventory.test.mjs` exits 0; deleting one
key or one module makes it exit non-zero naming the doc row.

Stop condition: green with an allowlist where every entry names the plan that
closes it.

Smallest first slice: settings-doc to table parity (26 doc rows vs 20 keys),
with the 6 gaps as named exceptions.

## Authority split

No user authority needed: Plan A (source restoration, local tests), Plan C,
Plan E, and Plan D's measurement fixtures.

Needs owner sign-off, not credentials: Plan A's web-tools half re-enables an
outbound surface; Plan A's session-search half moves text between
conversations; goal and schedule wiring can spend tokens when fired.

Needs explicit user authority: real provider E2E, Claude subscription E2E,
push, release, deploy, hosted CI, and the spec's benchmark budget.

## What this document does not claim

No test was run for the harness analysis itself. The 31 failures were observed;
the capability losses are proved by source presence (`before=N, head=0`), not by
running the pre-merge tree.

# H11 design record: measure the effect of an activated refinement

Date: 2026-11-21. Decided by the controller session under the standing
authorization in `docs/HARNESS-LOOP-PLAN.md` section 3.4. Node `H11` in
`.nomo/work-state.json`.

## The gap

H10 (`docs/superpowers/designs/2026-11-21-h10-refinement-outcome-feedback.md`)
closed the first half of the return path: the reviewer reads whether an
operator rejected, activated or rolled back earlier proposals, and a rejected
or rolled back proposal cannot be asked again without newer evidence. What
remained open is what happened **after** an approved refinement activated:

- The signed chain already holds both the activation record
  (`proposal:activated` and legacy `refinement:approved`) and every signed
  decision before and after it, plus `refinement:rolled-back` when an operator
  later undid it.
- `packages/workbench/src/harness-scores.ts` already provides `scoreCases`,
  `measureBoard` and `compareBoards`, yet had no function that splits a chain
  strictly across an activation sequence to measure that activation's effect.
- `packages/workbench/src/harness-runtime.ts` sent earlier proposal statuses
  (`outcomes`) to the reviewer, never the before-and-after ratchet effect of
  activated refinements.
- `packages/cli/src/harness.ts` (`nomo harness ratchet`) compared pre-activation
  records against the whole cumulative chain for the latest activation only.
  Comparing `before` against the cumulative chain dilutes post-activation
  regressions with pre-activation calls and echoes pre-activation averages even
  when zero calls ran after activation. It also could not inspect individual
  activations or summarize which guardrails were unmeasured.

Without a strictly disjoint before-and-after measurement from the signed chain,
neither the operator nor the reviewer can see whether an activated refinement
moved safety guardrails or left them unmeasured.

## Options considered

A. **Disjoint signed-chain effect miner, reviewer block, and operator report.**
   Add pure `measureRefinementEffect` to `packages/workbench/src/harness-scores.ts`
   using `scoreCases`, `measureBoard` and `compareBoards` over strictly disjoint
   windows (`seq < activationSeq` vs `seq > activationSeq`, capped at
   `<= rolledBackSeq` when rolled back). Add `mineRefinementEffects` and
   `formatEffectsForReview` to `packages/workbench/src/refinement-outcomes.ts`.
   Wire `Workbench.harnessEffects` into `serviceHarnessBoundary` via an optional
   `effects` dependency charged to the existing `maxPromptCharacters` ceiling,
   and expose the effect section (plus optional digest-prefix filter) in
   `packages/cli/src/harness.ts` `ratchet` while preserving its existing
   cumulative baseline lines.

B. **Automatic score-driven rollback or gating.** Trigger
   `rollbackHarnessProposal` or block future activations when a guardrail
   regresses outside noise.

C. **Fold score text into `harnessEntries` so the working agent reads it.**
   Emit measured effects as entries returned by `mineHarnessEntries`.

## Selected: A

Rejected B: violates decision D1 in `docs/HARNESS-LOOP-PLAN.md` and
`docs/NOMO-AGENT-HARNESS-SPEC.md` section 4.7. Scores are descriptive only.
They never gate, refuse, roll back or change state without an operator, and
unmeasured guardrails are gaps in the record rather than passes or failures.

Rejected C: `harnessEntries` feeds `retrievalContext` in the working agent's
prompt (`docs/CONTEXT.md` bounds retrieval to approved, verified records).
A ratchet score is descriptive evidence for the operator and the reviewer, not
an approved instruction for the working agent.

## Contract

1. **Signed chain only, pure and order-independent.**
   `measureRefinementEffect(entries, activationSeq, options?)` filters to
   entries with integer `seq`, sorts ascending by `seq`, and compares
   `seq < activationSeq` against `seq > activationSeq` (and `seq <= untilSeq`
   when `untilSeq` is supplied for a rolled-back refinement). Reordering input
   entries yields the exact same result. Records without integer `seq` are
   skipped rather than guessed at.
2. **Zero before/after leakage.**
   A call recorded before `activationSeq` never enters the post-activation
   board. When no decided call occurred after `activationSeq`, every post-side
   guardrail has `n: 0, mean: null`, `measured: false`, belongs to
   `unmeasuredGuardrails`, and `verdict` is `"insufficient-data"`.
3. **Explicit guardrail labeling.**
   For every key in `SCORE_GUARDRAILS` (`deny_rate`, `rollback_count`,
   `unknown_tool_rate`), `RefinementEffect.guardrails` reports `before`,
   `after`, `verdict`, `regressed`, and `measured` (`before.n > 0 && after.n > 0`).
   Any guardrail with `measured: false` is named in `unmeasuredGuardrails` and
   rendered explicitly as unmeasured on both the reviewer block and CLI output.
   Never treat an unmeasured guardrail as a pass or a zero.
4. **Activation discovery only from signed lifecycle decisions.**
   `mineRefinementEffects(entries, generatedAt?)` finds activations strictly
   from signed `proposal:activated` and legacy `refinement:approved` records
   carrying an integer `seq`, never from free prose or summaries. When a later
   `refinement:rolled-back` record matches the same 64-hex digest, `status` is
   `"rolled-back"` and `rolledBackSeq` caps the measurement window; otherwise
   `status` is `"activated"` and `rolledBackSeq` is `null`. One measured effect
   per signed activation record keeps the loop strictly bounded.
5. **Descriptive only (decision D1).**
   Nothing in `harness-scores.ts`, `refinement-outcomes.ts`,
   `harness-runtime.ts`, `Workbench.harnessEffects` or `packages/cli/src/harness.ts`
   mutates workspace state, triggers rollback, blocks a proposal, or passes
   score data to `decide`, policy, permissions, the tool catalog or
   `harnessEntries` / agent prompts.
6. **Bounded reviewer block inside existing ceiling.**
   `HarnessRuntimeDeps.effects` is optional. When omitted or empty, the review
   request is byte-identical to H10. When non-empty, `formatEffectsForReview`
   emits newest-first lines labelled as descriptive evidence (never an
   instruction or rollback trigger), charged to the operator's existing
   `maxPromptCharacters` ceiling with whole-line dropping and a truncation
   notice, introducing no new setting or literal ceiling.
7. **Operator CLI visibility.**
   `nomo harness ratchet --session <id>` preserves its existing descriptive
   header and baseline output, and appends the per-activation refinement effect
   report (strictly before vs after activation, standing vs rolled-back status,
   `hold_rate` and all three guardrails, `REGRESSED` markers and explicit
   unmeasured guardrails line). Passing an optional `<digest>` prefix filters
   the effect report to the matching activated refinement, refusing unknown or
   ambiguous prefixes.

## What this does not do

It does not automatically roll back or suppress refinements whose guardrails
regressed. It does not invent correction history for `first_pass_rate` when
the chain carries none, so `compareBoards` keeps reporting `insufficient-data`
while still flagging guardrail breaches honestly. It does not touch
`packages/cli/src/tui/*`.

## Tests, failing first

- `packages/workbench/src/harness-scores.test.ts`: `measureRefinementEffect`
  splits strictly before vs after `activationSeq`, is order-independent,
  caps the post window at `untilSeq`, marks zero post-activation activity as
  unmeasured without leakage, flags guardrail regression outside noise, and
  lists every unmeasured guardrail explicitly.
- `packages/workbench/src/refinement-outcomes.test.ts`: `mineRefinementEffects`
  reads only signed activation records, links rolled-back activations to their
  rollback window, tracks `activatedSeq` on rolled-back outcomes, and
  `formatEffectsForReview` stays empty on no effects, orders newest first,
  labels descriptive-only and unmeasured guardrails, and obeys `maxCharacters`.
- `packages/workbench/src/harness-outcome-feedback.test.ts`: at the Workbench
  level, `harnessEffects` computes measured before/after effects from the real
  signed ledger, leaves workspace state and ledger untouched, never triggers a
  rollback on regression, and stays absent from `harnessEntries` and agent
  prompts.
- `packages/workbench/src/harness-runtime.test.ts`: review request includes the
  descriptive effect block when `effects` are present, stays byte-identical
  when omitted or empty, and stays within `maxPromptCharacters` alongside
  `outcomes` and `entries`.
- `packages/cli/src/harness.test.ts`: `nomo harness ratchet --session <id>`
  prints the strictly before-vs-after refinement effect section with
  unmeasured guardrails labeled, handles post-activation silence honestly,
  supports optional `<digest>` prefix filtering, and never mutates state.

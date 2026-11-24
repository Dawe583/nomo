# Harness learning loop and RL plan, 2026-11-25

Status: proposal. Nothing here is implemented by this document.

## What exists (verified)

- **Frozen local evaluation set.** `scripts/src/harness-eval.mjs` feeds a
  taskset to a runner on stdin, parses one JSON decision line and compares it to
  a frozen expectation. Paired runs: a task passes only when every run matches.
  No model grades another model. With no runner it prints SKIP and exits 0, so
  a gate cannot show a false green. Fixture: `nomo-document-tools-v1`
  (`scripts/src/fixtures/harness-eval-core.json`).
- **Scoring.** `harness-scores.ts`: `measureBoard`, `scoreCases`,
  `unmeasuredMetrics`; ratios are sampled per case, not per chain entry; a
  metric with no producer prints as unmeasured instead of as a pass.
- **Outcome feedback.** `refinement-outcomes.ts`: `mineRefinementOutcomes`,
  `mineRefinementEffects`, `measureRefinementEffect`; the reviewer is told what
  happened to its earlier proposals, and a proposal that repeats a rejected or
  rolled-back one is refused.
- **Activation gate.** `refine-trigger.ts`: persisted cooldown, `cheapGate`
  before chain verification, `serviceHarnessBoundary`, exact-digest activation.
- **Metric producers.** `approvalMs`, `costUsd` and `recovery` each have a
  producer that writes a signed chain record.
- **Evidence.** Signed append-only ledger with verification; a node is done only
  with observed verifier output.

## What is missing

1. **No reward.** Outcomes are recorded, but nothing turns them into one number
   per case that a policy can optimise.
2. **No arms.** The harness has settings and prompt variants, but no record of
   which variant produced which case, so two variants cannot be compared.
3. **No exploration policy.** A variant is activated by a human decision; there
   is no sampling rule, no budget and no stopping rule.
4. **No trainer.** There is no RL trainer, no reward model and no trainable
   local policy. Nothing in the repository updates weights from reward.
5. **No trend.** There is no per-activation score trend printed from the chain,
   so "is it learning?" cannot be answered with a number.

## Honest definition

"RL" here can mean three different things. Only the third is RL in the strict
sense, and it needs a trainable model this repository does not have.

- **Bandit (achievable now):** choose among harness variants, reward = eval pass
  rate minus guardrail breaches and cost, update from measured outcomes.
- **Policy search (achievable now):** search prompt/setting variants with the
  frozen eval set as the objective; no weights change.
- **Gradient RL (needs a trainable model):** SFT/DPO/GRPO over trajectories
  exported from the chain. Requires a local trainable model, a GPU budget and a
  held-out eval. Do not call anything in this plan "RL training" until a policy
  is actually updated by reward.

## Proposals, in priority order

### H1. Reward record

One signed chain record per evaluated case: `caseId`, `variantId`, `passed`,
`guardrails` (each measured or `unmeasured`), `costUsd`, `latencyMs`,
`approvalMs`. Reward = `passed - 0.5*guardrailBreaches - lambda*cost - mu*latency`
with the weights stored in the record so a later reader can recompute it.
Verifier: a test that writes one record and reads it back; the score board
reports the reward for a fixture with two cases.
Stop: a case's reward is reproducible from the chain alone.

### H2. Variant identity and attribution

Every run records the exact variant digest (settings + prompt + model). Two
runs are comparable only when their digests differ in one axis. The eval
runner writes the digest with each case.
Verifier: two fixture runs with different variants produce different digests
and the same case ids.
Stop: "variant A beat variant B on case X" is checkable from records.

### H3. Evaluation set v2

Grow the frozen taskset from the document tools to the real failure modes:
read-before-write, approval hold, tool timeout, truncated result, compaction,
SSRF refusal, plan/todo use. Freeze it; a change is a new version, never an
edit. Held-out split: 70% train, 30% eval, fixed by task id.
Verifier: `node scripts/src/harness-eval.mjs fixtures/... -- <runner>` prints
per-task results and a pass rate; SKIP without a runner.
Stop: at least 12 tasks, both splits named, no task edited after freezing.

### H4. Bandit / policy search

Thompson sampling over at most 4 variants per axis (e.g. compaction threshold,
tool-result ceiling, prompt preamble), reward from H1, exploration budget in
tokens, stop when the posterior separates or the budget is spent. Activation
still requires an exact digest and a human approval; rollback on any guardrail
regression.
Verifier: a simulation test over fixture rewards proves the sampler prefers the
better arm and stops at the budget.
Stop: one activation produced by the sampler, with its reward and a rollback
command.

### H5. Trend report

`nomo harness trend` prints, per activation: eval pass rate, reward, guardrail
state, sample count and the delta from the previous activation, read from the
chain. Insufficient data stays `insufficient-data`.
Verifier: fixture chain with two activations prints a measured delta.
Stop: the operator can answer "is it learning?" from one command.

### H6. Gradient RL track (gated)

Only if a trainable local model exists. Export trajectories (prompt, tool
calls, verifier outcome, reward) from the chain, filter to verified cases,
train SFT then DPO against the frozen eval, and require the H4 gate before any
activation. No hosted CI, no paid benchmark without explicit approval.
Verifier: held-out eval before and after training; a regression blocks the
activation.
Stop: a policy is updated by reward and the held-out eval does not regress, or
the track is recorded as blocked on hardware/model access.

## Workflow

```
H1 reward record ──> H2 variant identity ──> H3 eval set v2
        │                                      │
        └──────────────> H4 bandit/policy search <┘
                              │
                              ├─> H5 trend report
                              └─> H6 gradient RL (gated on a trainable model)
```

Each node runs Discover -> Specify -> Change -> Verify -> Review -> Record.
A node is done only with the verifier output quoted in `.nomo/work-state.json`
and the Obsidian work log. One writer per file. The chain is append-only; a
reward is never rewritten, only superseded by a new record.

## What this plan refuses

- Calling prompt tuning "RL".
- A reward that cannot be recomputed from the chain.
- A model grading another model as a measurement.
- Hosted CI, paid benchmarks or a training run without explicit approval.
- Deleting a guardrail or a test to make a variant look better.

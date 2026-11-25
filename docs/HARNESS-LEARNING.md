# Harness learning loop

Status: current operator contract, 2026-11-25.

NOMO's harness loop is measurement plus human-gated activation. It is a
contextual bandit and policy-search loop. It is not reinforcement learning:
no model weights are updated by reward in this repository.

## Loop

1. **Proposal.** The harness writes a signed `proposal:created` record. The
   full digest is the only handle on that exact proposal.
2. **Review.** `nomo harness list --session <id>` prints pending proposals,
   the full digest, rationale, expected outcome and exact edits.
3. **Approval and activation.** `nomo harness approve --session <id> <digest>`
   activates only the full 64-character digest and writes `proposal:activated`.
   A prefix is display text, never authorization input.
4. **Measurement.** `node scripts/src/harness-eval.mjs <taskset> --records
   <path> --weights breach=<n>,cost=<n>,latency=<n> --variant <variant.json> --
   <runner>` writes one `nomo.reward.v1` record per evaluated case. Missing
   producers stay `"unmeasured"`. Train and held-out eval results stay separate.
5. **Replay.** `node scripts/src/harness-replay.mjs <ledger-or-jsonl>` recomputes
   stored rewards. A mismatch is evidence against the writer, not something to
   repair silently.
6. **Trend.** `nomo harness trend --session <id>` prints measured activation
   outcomes from the chain. `nomo harness ratchet --session <id>` compares the
   current board with the previous activation and reports guardrail regressions.
7. **Rollback.** `nomo harness rollback --session <id> <digest>` is the one
   operator command. It writes `refinement:rolled-back` with
   `harnessRefinement.rolledBackDigest` naming the activation it undid.
8. **Exploration.** `nomo.bandit.v1` history records Thompson-sampling state.
   Guardrail-axis exploration, currently `promptPreamble`, starts stopped as
   `unapproved-guardrail` unless the exact arm-set digest was approved.

## Records

- `proposal:created`: the proposed exact edits.
- `proposal:activated`: the operator-approved activation.
- `proposal:rejected`: a decision that activates nothing.
- `refinement:rolled-back`: the rollback and the digest it restores past.
- `nomo.reward.v1`: one measured case, recomputable from explicit weights.
- `nomo.bandit.v1`: append-only contextual-bandit state.
- `nomo.trajectory.v1`: export-only tool names, classes and outcomes. It never
  carries prompt text or tool output.

## Commands

```sh
nomo harness list --session <id>
nomo harness approve --session <id> <digest>
nomo harness reject --session <id> <digest> --reason <text>
nomo harness rollback --session <id> <digest>
nomo harness ratchet --session <id>
nomo harness trend --session <id>
node scripts/src/harness-eval.mjs <taskset.json> -- <runner argv...>
node scripts/src/harness-replay.mjs <chain.jsonl>
node scripts/src/trajectory-export.mjs <chain.jsonl> [--out <path>]
```

## Boundaries

Activation never happens from a score alone. The operator types the full digest
after seeing the proposal. Rollback evidence does not rewrite history; the
append-only chain gains a new signed record. A held-out eval task must never be
used for selection. A missing metric is `unmeasured`, never zero. Gradient RL
remains blocked on a trainable local model, hardware and an explicit approval
path; none exists here.

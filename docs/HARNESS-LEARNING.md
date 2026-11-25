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
   With `--execute-workspace --measurements <path>`, the offline fixture also
   executes governed managed-document proposals through the production
   `executeWorkspaceTool` state machine against in-memory fixture state only.
   It writes explicit `nomo.eval-tool.v1` measurements before the reward. Those
   records carry case, variant, run, tool name, class and completion only; no
   host file, network, provider, model, prompt, argument, result or document
   content is part of the measurement.
5. **Ingestion.** `nomo harness ingest-rewards --session <id> <records.jsonl>
nomo harness ingest-eval --session <id> <measurements.jsonl>`
   validates a reward-only file. `nomo harness ingest-eval --session <id>
   <measurements.jsonl>` validates a mixed reward and eval-tool measurement
   file. Both validate the whole file before writing anything: schema, bounded
   identifiers, exact weights, exact reward recomputation and exact eval-tool
   record shape. Valid records enter the session workspace chain. An exact
   rerun is recognised by the file digest plus record position and skips only
   positions already written. A separate measurement file with the same values
   is new evidence, not a duplicate. A tampered, malformed or
   side-channel-carrying file writes nothing.
6. **Replay.** `node scripts/src/harness-replay.mjs <ledger-or-jsonl>` recomputes
   stored rewards. A mismatch is evidence against the writer, not something to
   repair silently.
7. **Trend.** `nomo harness trend --session <id>` prints measured activation
   outcomes from the chain. `nomo harness ratchet --session <id>` compares the
   current board with the previous activation and reports guardrail regressions.
8. **Rollback.** `nomo harness rollback --session <id> <digest>` is the one
   operator command. It writes `refinement:rolled-back` with
   `harnessRefinement.rolledBackDigest` naming the activation it undid.
9. **Exploration.** `nomo.bandit.v1` history records Thompson-sampling state.
   Guardrail-axis exploration, currently `promptPreamble`, starts stopped as
   `unapproved-guardrail` unless the exact arm-set digest was approved.

## Records

- `proposal:created`: the proposed exact edits.
- `proposal:activated`: the operator-approved activation.
- `proposal:rejected`: a decision that activates nothing.
- `refinement:rolled-back`: the rollback and the digest it restores past.
- `nomo.reward.v1`: one measured case, recomputable from explicit weights.
- `nomo.bandit.v1`: append-only contextual-bandit state.
- `nomo.eval-tool.v1`: one governed offline fixture tool execution, explicitly
  attributed to a case, variant and run. It never carries arguments or results.
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
nomo harness ingest-rewards --session <id> <records.jsonl>
nomo harness run-eval --case <id> --variant <id> --run <n> --prompt <text> [--idempotency-key <key>]
node scripts/src/harness-eval.mjs <taskset.json> -- <runner argv...>
node scripts/src/harness-replay.mjs <chain.jsonl>
node scripts/src/trajectory-export.mjs <chain.jsonl> [--out <path>]
```

## Names that must not be confused

- **Bandit:** chooses among fixed harness arms from measured rewards. The arms
  do not learn internal weights.
- **Policy search:** compares prompt or settings variants on the frozen eval
  and activates one only through operator approval. The eval is measurement,
  not model training.
- **Gradient RL:** updates model weights from reward through a training
  algorithm. This repository has no trainable local model, GPU budget or such
  training path, so no NOMO surface may claim RL training.

## Production eval attribution

`startHarnessEval` starts a real Workbench run bound to one validated case id,
variant id and run number. Every ledger entry caused by that session carries
only this bounded `harnessEval` identity; prompts, arguments, results and
document contents never enter the attribution. Delegated subagent sessions
inherit the same case identity because their work is part of the same run.
Recording a reward or eval-tool measurement into that session is refused when
its case identity does not match the session identity. Trajectory export
groups attributed entries by exact case, variant and run when the reward
carries `harnessEval`; interleaved repeated runs of one case do not merge.
A reward without run metadata can adopt only one unambiguous pending run, and
an exact eval reward never adopts unrelated positional entries. Entries
without the field keep legacy positional treatment, malformed or mismatched
attribution refuses the affected export, and unrelated entries are counted as
unattributed rather than guessed.

Two operator surfaces expose the same path. `POST /api/sessions` accepts an
optional `harnessEval` object with exactly `caseId`, `variantId` and `run`;
malformed input is refused as `invalid_session_eval` before a session exists.
The returned session view and later reads carry that same bounded identity as
`harnessEval`, so an operator can confirm attribution without opening raw
ledger entries. The object is part of idempotency identity, so one idempotency
key cannot silently reuse a session for a different eval run. The CLI form is:

```sh
nomo harness run-eval --case <id> --variant <id> --run <n> \
  (--prompt <text> | --prompt-file <path>) [--model <id>] [--agent <id>] \
  [--idempotency-key <key>]
```

`run-eval` starts a real production model run and waits for its terminal
state. It can incur provider cost only because the operator explicitly invoked
that run. `--idempotency-key` names one exact request so an operator retry
after an interrupted CLI cannot silently start the same paid run twice; using
that key for a different prompt, model, agent or eval identity is refused.
A non-idle terminal state is printed and returns a nonzero exit code; it is
evidence to reconcile, not a success. The command does not compute
or ingest a reward: task verification and reward measurement remain separate
explicit steps, so an idle terminal state is not a passed eval by itself.

## Boundaries

Activation never happens from a score alone. The operator types the full digest
after seeing the proposal. Rollback evidence does not rewrite history; the
append-only chain gains a new signed record. A held-out eval task must never be
used for selection. A missing metric is `unmeasured`, never zero. Gradient RL
remains blocked on a trainable local model, hardware and an explicit approval
path; none exists here.

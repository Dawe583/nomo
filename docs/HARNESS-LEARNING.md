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
5. **Ingestion.** `nomo harness ingest-rewards --session <id> <records.jsonl>`
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
   `unapproved-guardrail` unless the exact arm-set digest was approved. For a
   two-axis factorial history, `node scripts/src/harness-factorial-bandit-report.mjs
   <history.jsonl>` is a read-only measurement report: it prints cell means,
   main effects and interaction, never samples or deploys a treatment.
10. **Offline policy evaluation.** `node scripts/src/harness-offline-policy.mjs
   <rounds.jsonl> --arm <id> [--arm <id>...]` evaluates deterministic candidate
   arms with inverse propensity scoring. The input contract is one bounded
   JSON object per line with exactly `armId`, `reward` and `propensity`;
   propensity is the probability the logging policy gave the arm it actually
   chose. It is never inferred when the logging policy failed to record it.
   The report is measurement only: unsupported arms are `unmeasured`, no model
   is trained and no arm is deployed.

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
nomo harness run-eval --case <id> --variant <id> --run <n> --prompt <text> [--idempotency-key <key>] [--gate <exact-command> --weights breach=<n>,cost=<n>,latency=<n>]
node scripts/src/harness-eval.mjs <taskset.json> -- <runner argv...>
node scripts/src/harness-replay.mjs <chain.jsonl>
node scripts/src/trajectory-export.mjs <chain.jsonl> [--out <path>]
node scripts/src/harness-offline-policy.mjs <rounds.jsonl> --arm <id> [--arm <id>...]
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
unattributed rather than guessed. Explicit offline eval-tool measurements use
the same unambiguous-run rule inside their case, variant and ingestion-file
family; repeated pending runs are refused rather than merged. Bare measurement
records without ingestion provenance have only the weaker case/variant family.

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
  [--idempotency-key <key>] [--gate <exact-command> --weights breach=<n>,cost=<n>,latency=<n>]
```

`run-eval` starts a real production model run and waits for its terminal
state. It can incur provider cost only because the operator explicitly invoked
that run. `--idempotency-key` names one exact request so an operator retry
after an interrupted CLI cannot silently start the same paid run twice; using
that key for a different prompt, model, agent or eval identity is refused.
A non-idle terminal state is printed and returns a nonzero exit code; it is
evidence to reconcile, not a success. Without `--gate`, the command does not
compute or ingest a reward: an idle terminal state is not a passed eval by
itself.

With `--gate` and `--weights` together, the exact verifier command is validated
against the operator hook allowlist before the first provider turn. The verifier
runs only after settlement, its outcome is written as `harness.eval-gate`
without stdout or stderr, and the reward is written through the signed chain.
A timeout or spawn failure is verifier failure, not evidence that the case
failed, so no reward is written. An exited verifier receipt is reused only when
its command digest matches; one exact measurement retry does not duplicate the
verifier or reward. A different weights object is a different scoring measurement,
so it does not reuse a reward written with different weights.

Every attributed eval provider turn writes one bounded `harness.usage` receipt,
including receipts in direct attributed subagent workspaces. `costUsd` is
measured only when every receipt in every attributed workspace carries the
provider's own numeric cost; any missing, null, partial or unreadable producer
leaves cost `unmeasured`, never zero.
`latencyMs` is the operator-visible wall clock from immediately before the CLI
start call until observed settlement, including queue and orchestration time. An
idempotent replay cannot recover the original run's wall clock, so latency is
`unmeasured` for that replay. `approvalMs` is the sum of exact operator-decided
hold latencies in the attributed evidence. Both internal Workbench holds and
proxy holds write the measured latency when an operator decision timestamp
exists, and the public ledger feed projects that bounded number without
exposing arguments or payloads. No held call is measured zero because complete
chain evidence proves no approval wait occurred; expired, cancelled or legacy
holds without a decision timestamp remain `unmeasured`.

Reward guardrails use the existing board guardrails `deny_rate`,
`rollback_count` and `unknown_tool_rate`, measured only from chain entries that
carry the exact eval attribution. Decision rates reconstruct logical governed
calls from their initial `allow`, `hold` or `deny` anchor: hold resolution and
execution records are stages of that same call, not additional attempts. A
denied hold is both one hold and one refusal. Internal subagent-spawn lifecycle
records are not counted as a second delegated tool call. Governed tool
decisions carry the bounded classification outcome `classified` or
`unclassified`; the chain does not need registry facts or classifier internals
for that measurement. If a direct attributed child workspace is unreadable, all guardrails are
`unmeasured`. Internally incomplete evidence makes the affected measurement
`unmeasured` rather than partial truth. Guardrail measurement is
descriptive chain evidence, not a model capability proof.

## Boundaries

Activation never happens from a score alone. The operator types the full digest
after seeing the proposal. Rollback evidence does not rewrite history; the
append-only chain gains a new signed record. A held-out eval task must never be
used for selection. A missing metric is `unmeasured`, never zero. Gradient RL
remains blocked on a trainable local model, hardware and an explicit approval
path; none exists here.

# NOMO 24h program handoff

Date: 2026-11-25. Branch: `tui-merge-main`. Canonical work record:
`.nomo/work-state.json`. If this file and the graph disagree, the graph wins.

## Verified base

Last full local dry run was recorded in Q8 and merged to `main` as `96675914`.

- `pnpm run typecheck`: exit 0.
- `pnpm run test:tui`: 529 tests, 529 pass, 0 fail, plus the PTY matrix ending
  `PASS: every scenario at every size`.
- `node --test --test-concurrency=1 packages/workbench/src/*.test.ts`: 1188
  tests, 1186 pass, 0 fail, 2 skipped.
- `node --test --test-concurrency=1 scripts/src/*.test.mjs`: 408 tests, 369
  pass, 6 fail, 32 skipped, 1 todo. The six failures are named pre-existing
  failures in Q8 evidence, not new regressions from this session.
- `node scripts/src/work-graph-check.mjs`: duplicate ids 0, dangling deps 0,
  done without evidence 0.

## Shipped in this program slice

- Identity truth: local agent revoke is durable across restart and honestly
  labelled local. Fleet-wide revoke is documented as unavailable until registry,
  node inventory, acknowledgement, fail-closed disconnected nodes and
  reconciliation exist.
- Harness measurement: reward records, variant identity, frozen eval v2,
  replay, guardrail regression detection, activation by exact digest, rollback,
  trajectory export, schema-versioned reward reading, cost and latency weights,
  operator reward inspection, and the offline end-to-end fixture dry run.
- Policy search evidence: deterministic bandit simulation, reward aggregation,
  exploration guard and arm activation through the approval gate. This is a
  contextual bandit and measurement loop, not reinforcement learning.
- TUI contract: `packages/cli/src/tui/DESIGN.md` exists and the composer uses
  the slot ladder `queue > attachment > model > context > dock` with no mode
  chip.
- Quality: work graph validation, doc truth, module inventory, harness
  inventory, local bundle verification, offline lockfile verification and the
  local CI dry run.

## Important limits

- The deterministic eval runner proves plumbing and governance only. It does
  not prove model capability.
- `nomo.reward.v1` records can enter the signed workspace chain through
  `nomo harness ingest-rewards --session <id> <records.jsonl>` (H19). The
  command validates the whole file before writing, recomputes rewards exactly,
  refuses side-channel fields without printing them and resumes exact or
  partial ingestion by file digest plus record position.
- The Q8 script-suite failure list is historical evidence, not current state.
  Q17 repaired the four remaining groups without weakening the tests. The full
  scripts suite now reports 417 tests, 384 pass, 0 fail, 32 skipped and 1 todo.
- H9 trajectory grouping is positional for direct production-chain rewards until
  production tool entries carry case ids. The offline managed-workspace eval
  fixture can now produce explicit `nomo.eval-tool.v1` attribution and
  `ingest-eval` can carry it into the signed chain. Bare-eval ingested rewards
  without those measurements still export empty tool calls rather than adopting
  unrelated positional entries.

## Blocked or gated

- Q5 provider smoke: the gate is satisfied only as SKIP. Observed output:
  `SKIP provider-smoke: NOMO_SMOKE_API_KEY is not set, so nothing was sent.`
  No provider response is proven.
- F4 provider release path: still missing a provider credential. Approval does
  not create a key.
- G1 gradient training: gated on a trainable local model and GPU budget. Do not
  claim it exists.
- G2 component-library parity: closed against Ink by the T11 byte-parity
  experiment. Reopen only under the DECISIONS triggers, never as a default.
- G3 paid benchmark: owner approval is present in-session, but no hosted model
  credential or concrete cost cap exists in this environment.
- G4 release: owner approval is present in-session. A release still needs a
  concrete version target, changelog, tag decision and deploy path checked
  immediately before use.

## Next ready node

The original autonomous expansion backlog through Q13 is complete, H19 closed
the reward-ingestion production gap, and Q17 repaired the scripts quality suite.
H16 remains blocked on operator opt-in/review of a real-run corpus before
freezing; H17 depends on H16 plus human labels. T11 is complete as a rejected
spike: Ink could not preserve even the exact input frame bytes because its
renderer trims line endings and wraps width-padded rows.

H20b implemented the first truthful attribution path: an explicit offline
managed-workspace execution fixture, signed ingestion of attributed measurement
records, and export matching by ingestion provenance. Direct production-chain
attribution is implemented for explicitly started eval runs; legacy entries
without `harnessEval` keep positional treatment. H20c exposes that path through
`POST /api/sessions` optional `harnessEval` and `nomo harness run-eval`. The
CLI waits for terminal state, but reward computation and ingestion remain
separate explicit measurement steps. H20c4 exposes `--idempotency-key` for
safe exact retries of provider-costing eval runs. H20c5 exposes the bounded
identity on session views and API reads, including after restart. H20c6 makes
trajectory attribution exact per run and refuses ambiguous or mismatched
reward attribution rather than merging repeated runs. H20c7 applies the same
unambiguous-run rule to explicit offline eval-tool measurements.

## Do not do

- Do not run live provider smoke, paid benchmarks, hosted CI, release or deploy
  without explicit approval in the current session.
- Do not expose secrets or write them into ledgers, docs, tests or logs.
- Do not recreate the launchd autoloop.
- Do not touch `nomo-web`.
- Do not weaken or delete tests to reach green.
- Do not claim fleet-wide revocation or reinforcement learning exists.

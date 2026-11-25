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
  Q11 fixed the CLI 1.0.1 versus root 0.1.0 version mismatch. The full scripts
  suite has not been re-run after H19, so no smaller current failure count is
  claimed here.
- H9 trajectory grouping is positional for direct chain rewards until tool entries carry case ids.
  Bare-eval ingested rewards export with empty tool calls rather than adopting
  unrelated positional entries. Full attribution redesign remains discovery.

## Blocked or gated

- Q5 provider smoke: blocked by missing explicit in-session approval for a live
  provider call.
- F4 provider release path: same missing authority.
- G1 gradient training: gated on a trainable local model and GPU budget. Do not
  claim it exists.
- G2 component-library parity: optional owner decision only, never default
  without byte-for-byte parity.
- G3 paid benchmark: explicit owner approval required.
- G4 release: explicit owner approval required.

## Next ready node

The original autonomous expansion backlog through Q13 is complete, and H19
closed the reward-ingestion production gap. H16 remains blocked on operator
opt-in/review of a real-run corpus before freezing; H17 depends on H16 plus
human labels. T11 remains owner-gated; Q5, G3 and G4 remain approval-gated.

A possible H20 case-attribution redesign is discovery work, not a ready
implementation node: current eval records do not execute tools, so simply
adding a case id field to chain entries would not create truthful attribution.
Do not start T11 unless the owner explicitly chooses the optional parity spike.

## Do not do

- Do not run live provider smoke, paid benchmarks, hosted CI, release or deploy
  without explicit approval in the current session.
- Do not expose secrets or write them into ledgers, docs, tests or logs.
- Do not recreate the launchd autoloop.
- Do not touch `nomo-web`.
- Do not weaken or delete tests to reach green.
- Do not claim fleet-wide revocation or reinforcement learning exists.

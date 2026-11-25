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
- `nomo.reward.v1` records can be written through `recordHarnessReward`. Bare
  eval record files still need a production ingestion path if eval output is
  meant to enter the chain outside a fixture.
- Scripts remain red in six pre-existing areas: control-plane colour literals,
  test env-var scanner findings, hidden-directory licence coverage,
  historical/generated em-dash files, and the CLI 1.0.1 versus root 0.1.0
  version mismatch counted by two release metadata tests.
- H9 trajectory grouping is positional until tool entries carry case ids.

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

Start T8, snapshot and PTY refresh. Exact first action: open
`docs/plans/2026-11-25-nomo-24h-program-detailed.md` section T8, inspect
`packages/cli/src/tui/visual-snapshots.test.ts` and the PTY matrix, then
refresh only intentional hashes after reviewing the changed frames.

After T2.5, continue T4 panel navigation, then T4, T5.x, T6, T7, T8,
T9 and T10 as the detailed program orders them. Do not start T11 unless the
owner explicitly chooses the optional parity spike.

## Do not do

- Do not run live provider smoke, paid benchmarks, hosted CI, release or deploy
  without explicit approval in the current session.
- Do not expose secrets or write them into ledgers, docs, tests or logs.
- Do not recreate the launchd autoloop.
- Do not touch `nomo-web`.
- Do not weaken or delete tests to reach green.
- Do not claim fleet-wide revocation or reinforcement learning exists.

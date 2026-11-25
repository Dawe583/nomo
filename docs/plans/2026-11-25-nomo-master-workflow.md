# NOMO master workflow 2026-11-25

One long-running workstream, expressed as a graph so it can be executed in
bounded loops without losing the thread. Every node has a scope, an acceptance
claim, a verifier that can be run locally, and a stop condition. Nodes marked
`blocked` need the user; everything else is executable now.

## Graph

```
A1 composer visual pass ──┐
A2 pet visual pass ───────┼─> A3 visual snapshot refresh ─> A4 PTY matrix
                          │
B1 metric producers ──────┼─> B2 score board moves ────────> B3 rollback command
B4 cooldown persistence ──┘
C1 retrieval index ───────┼─> C2 retrieval hit accounting
D1 session-search wiring ─┼─> D2 plan tool wiring ─> D3 goals wiring ─> D4 project-context wiring
E1 harness evaluation set ─> E2 trend report ─> E3 operator scope (HP1)
```

## Nodes

### A. Visual work (composer and pet)

- **A1 composer visual pass.** Scope: `packages/cli/src/tui/workspace.ts`,
  `packages/cli/src/tui/layout.ts`. Goal: the composer states more with less
  space - a mode chip with its own glyph, a queue badge that appears only when
  something is queued, a chip overflow policy that drops the least useful chip
  instead of clipping, and a caret row that keeps its frame at every size.
  Acceptance: a chip that does not fit is dropped whole, never cut; the rail
  still closes at 40x12; no chip carries meaning by colour alone. Verifier:
  `node --test packages/cli/src/tui/workspace.test.ts`.
- **A2 pet visual pass.** Scope: `packages/cli/src/tui/pet.ts`,
  `packages/cli/src/tui/pet.test.ts`. Goal: more life without more rows - a
  second blink rhythm, a listening pose that is distinct in silhouette, a
  reaction to a completed run, and a bubble that never covers the caret.
  Acceptance: every pose stays inside the 9x5 grid, every frame is a pure
  function of the counter, reduced motion is byte-identical, and the ASCII
  preset keeps a readable pet. Verifier:
  `node --test packages/cli/src/tui/pet.test.ts`.
- **A3 snapshot refresh.** Regenerate only the frames the two passes change and
  prove the diff is hash-only. Verifier: `NOMO_UPDATE_SNAPSHOTS=1` then a clean
  run.
- **A4 PTY matrix.** `python3 scripts/src/verify-tui-terminal.py` at all five
  sizes.

### B. Harness measurement

- **B1 metric producers.** Write `approvalMs` when a hold is decided, `costUsd`
  when a provider reports cost, and `event: "recovery"` when a recovery job
  settles. Acceptance: each metric has a producer and one test that proves the
  record reaches the chain. Verifier: workbench suite.
  - Finding (2026-11-25): `approvalMs` has no producer because
    `ApprovalRecord` in `packages/policy/src/approvals.ts` carries `expiresAt`
    but no `createdAt`, so the decision cannot compute a latency. The slice is
    therefore: add `createdAt` at hold creation, carry it through
    `PendingApprovalRecord`, compute `decidedAt - createdAt` where the decision
    is recorded, and write `approvalMs` into the ledger entry the proxy appends.
    `costUsd` needs the provider usage path to report cost; `recovery` needs the
    recovery job to append its own record. None of the three can be faked.
- **B2 score board moves.** With producers in place the board must be able to
  leave `insufficient-data` in a fixture. Acceptance: a fixture with two
  decided cases reports a measured rate.
- **B3 rollback command.** The score row's rollback candidate becomes
  actionable (`/harness rollback <digest>`), still requiring an explicit
  confirmation. Acceptance: no rollback without a typed digest.
- **B4 cooldown persistence.** The trigger state that carries `lastReviewAt`
  survives a restart, so a restart cannot buy a free review. Acceptance: a
  restart inside the cooldown refuses with `under-cooldown`.

### C. Retrieval

- **C1 retrieval index.** Cache the per-entry term sets and IDF between turns,
  invalidated by a new chain record. Acceptance: two consecutive turns with an
  unchanged chain do no re-tokenisation, measured by a counter.
- **C2 retrieval hit accounting.** Record which entries reached which prompt so
  "the model was told" becomes checkable. Acceptance: one record per turn,
  bounded, no content.

### D. Unwired modules

- **D1 session-search**, **D2 plan tool**, **D3 goals**, **D4 project-context
  files.** Each is intact with tests and has no caller. Acceptance per module:
  the tool or feature is reachable from a real session and its test is green;
  the `module-inventory` allowlist entry is removed.

### E. Learning loop

- **E1 evaluation set.** A frozen local taskset with paired runs, no hosted CI.
- **E2 trend report.** Score trend per activation, printed from the chain.
- **E3 operator scope (HP1).** Cross-conversation lessons, only after E2 shows
  a measured effect.

## Blocked on the user

Release, push, deploy, hosted CI, paid benchmark runs. Nothing else.

## Rule for this workflow

One writer per file. A node is done only when its verifier output is quoted in
`.nomo/work-state.json` and the work log. A failed check gets one targeted
repair, then the node blocks and the next ready node starts.

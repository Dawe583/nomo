# Audit: does the 24-hour program move NOMO forward?

Date: 2026-11-25. Verdict first, evidence second, correction last.

## Verdict

**Partially. The program moves engineering quality forward and one of the three
product-v1 release gates forward. It does not, by itself, move NOMO as a product
closer to v1.**

- Track B (reward, variant identity, eval set, activation/rollback) and Track C
  (bandit) serve the README's **"safe learning"** release gate directly. That is
  the strongest part of the program.
- Track A (TUI panels, composer, pet, parity) serves the recent trajectory but is
  **polish, not product value**. It makes an existing surface nicer; it does not
  add a capability an operator did not have.
- Track D is release hygiene. Necessary, not differentiating.
- **Two of the three v1 gates named in the README have no node**: operator
  approval end-to-end is only touched by T3 (a chip decision), and
  later-session retrieval has **zero** nodes.
- The control-plane claim itself (identity, scope, fleet revocation truth) has no
  node in the 24h program.
- The GUI track is absent, although `docs/GUI-UPGRADE-PLAN.md` (391 lines) and
  `docs/GUI-ALLINONE-PLAN.md` (168 lines) exist and describe requested work.

## Evidence

README, first screen:

> NOMO is being built as an Agent Identity & Fleet Control Plane … Safe learning,
> operator approval and later-session retrieval are product-v1 release gates.

Current graph: 45 nodes, 43 done, one partial (`provider-e2e-and-release`, needs
explicit authorization for cost) and one blocked (`composer-mode-chip`, needs a
product decision). So the open queue is thin: the program is not competing with
a backlog of product work, it is choosing what to do next.

Recent history is TUI-heavy (`1620bbe0`, `d3252367`, `c4ef0e3f`, `ef945c8a`,
`b5a6c6b8`, `14a77b36`), plus control-plane provider matrix and ledger
verification. That explains why a TUI-heavy plan feels natural — and why it can
quietly avoid the product gates.

94 `TODO`/`FIXME` markers exist across `packages/*/src`. The program does not
triage them, so an unknown share of real gaps is invisible to it.

## What the program would achieve in 24 h

1. Five panels at parity, a composer rule, pet motion, mouse/keyboard parity,
   green snapshots and PTY. A visibly better TUI, same capabilities.
2. A reward record, variant identity, a 12-task eval set, replay, activation and
   rollback, a trend command. Measurable learning, no new policy.
3. A bandit proven in simulation. One sampled arm activated.
4. Inventories and doc-truth green, dist fresh.

That is a better-engineered NOMO. It is not a NOMO that passes more of its own
v1 gates than it did yesterday, except "safe learning".

## Correction: add Track F, product-v1 gates (12 h)

These nodes are ordered before the TUI polish that is not already in flight.
Each starts with a Discover step, because part of each may already exist
(`retrieval-accounting-and-cooldown-persistence` and
`tui-wide-approval-density` are done nodes).

| id | goal | scope | verifier | stop | h |
|---|---|---|---|---|---|
| F1 | Later-session retrieval gate: a later session can retrieve a prior decision with its evidence, and the prompt reports which entries it carried | `packages/workbench/src/session-search.ts`, retrieval cache, prompt assembly | `node --test packages/workbench/src/session-search.test.ts`; one end-to-end fixture | a second session retrieves a first session's decision, and the prompt names the entries it used | 4.0 |
| F2 | Operator approval end-to-end: hold -> decision -> evidence -> ledger -> visible in the TUI | `packages/policy/src/approvals.ts`, `workspace.ts`, ledger | policy tests + PTY hold prompt | an approval produces a signed record and a visible decision line | 4.0 |
| F3 | Identity and fleet truth: principal, workspace, agent and run binding shown, revocation state truthful after revoke | control-plane view, TUI status panel | control-plane tests + one revoke fixture | a revoked agent's state reads revoked everywhere it is shown | 3.0 |
| F4 | Provider release path: settle `provider-e2e-and-release` or record the exact missing authority | provider adapter, smoke | `node scripts/src/provider-smoke.mjs` | PASS or a named blocker | 1.0 |

F1-F3 are the actual v1 movement. They are also the nodes a user would notice.

## Revised ordering

1. **F1, F2** first (8 h). These are the gates, not the polish.
2. **H1, H2, H3** (5.5 h). Safe learning, measurable.
3. **T1, T3, T8** (3.5 h). The TUI work that is required by F2's visibility and
   by the composer decision.
4. **R1, R2** (3 h). Bandit in simulation.
5. **Q1-Q5** (3 h). Hygiene that the above touches.
6. Then T2.x, T4-T7, T9-T10 from the original program, as time allows.

Move T2.4, T2.5, T5.2, T6, T7 to the backlog if the clock runs out. Never move
F1-F3.

## What this audit does not claim

- It does not claim F1-F3 are unimplemented. It claims the program has no node
  for them, and that a done node named "retrieval accounting" is not the same as
  the README gate.
- It does not measure user demand for the panels. If nobody opens `usage`, T2.5
  is busywork; that is a product decision, not an engineering one.
- It does not resolve the GUI question. 559 lines of GUI plans and no decision
  is itself a gap: either GUI is v1 (then it needs nodes) or it is post-v1 (then
  the plans should say so).

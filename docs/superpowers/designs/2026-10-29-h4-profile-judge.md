# H4 judge ruling: profile store joins the evidence chain

Date: 2026-10-29. Judge: controller session. Inputs: proposal A (minimal blast
radius, fail closed) and proposal B (operator value loop). Both were written
independently from the same sources and agree on the core contract.

## Selected

Proposal A is the base contract, with three additions taken from proposal B:

1. The operator review surface must expose the before and after snapshots and
   the parent bound for each profile edit. Proposal A lists the scope checks but
   does not name them as operator-visible evidence; proposal B does, and an
   approval the operator cannot read is not an approval.
2. The audit test from proposal B's test plan
   (`harness-profile-audit.test.ts`: the review surface receives the before and
   after snapshots and the parent bound for each profile edit) is required, not
   optional. It pins the operator-visible evidence property.
3. The rollback record must name the restored profile ids, as proposal B
   states, in addition to the digest. Proposal A implies this through symmetry
   but does not say it.

## Rejected

- A separate profile store outside the ledger (both proposals reject it; kept
  rejected).
- Promotion on proposal creation rather than approval (both reject it; kept
  rejected).
- Approval without the before snapshot (proposal B rejects it; adopted).

## Tradeoffs recorded

- Minimal contract versus operator ergonomics. Resolved by making the operator
  surface a required part of the contract rather than a later polish item, so
  the minimal implementation still has to carry it.
- Reusing the existing `harnessRefinement.profiles` field versus a new
  `harnessProfile` field. Resolved as additive: new records write both, old
  records keep replaying through the fallback. No migration, no history rewrite.

## Frozen contract

1. Promotion is a signed operation written through `commitWorkspace`, never
   outside it.
2. The record carries `digest`, `atSeq`, and `changes: [{ id, before, after }]`,
   plus `profile:promoted` or `profile:rolled-back` in `harnessLifecycle.events`.
3. `digest` equals the approved proposal digest and the refinement digest; the
   mismatch check stays mandatory.
4. Approval requires the chain length to equal `atSeq` at write time.
5. Parent scope checks (tools, policy profile, max turns, max context tokens,
   collision with presets and built-in agents) stay mandatory and are recorded.
6. Rollback is symmetric to entry rollback: inverse profile changes, active
   store must match the signed `after`, `approvedBy: "rollback"`, and the record
   names the restored profile ids.
7. Additive migration only; old chains replay unchanged.
8. Promotion cannot bypass the policy engine; `policyProfile` is clamped to the
   parent's.
9. Snapshots are re-scanned for secrets at write time.

## Implementation order

1. Helper `profilePromotion.ts` beside `refine-pass.ts` (construction of the
   record and its inverse), so approval and rollback share one shape.
2. Approval path writes `harnessProfile` and `profile:promoted`.
3. Rollback path writes `profile:rolled-back` and names restored ids.
4. Tests from both proposals' test plans, failing first.
5. Spec section 3.4 table row updated from "partially implemented" to
   "implemented" only after the tests pass.

## Open questions left for the owner

1. Should skill promotion (markdown skill, not subagent profile) share this
   record kind, or get its own `skill:promoted` event? This is a material
   decision; until it is answered, skill promotion stays deferred to a child
   node H4b and the profile store ships without it.
2. Should promotion be a separate CLI and control plane command, or stay
   folded into `approveHarnessProposal`?
3. May a promoted profile outlive the session that created it, or only the
   workspace? Replay is workspace scoped; cross-workspace promotion is out of
   scope for v1.

## Consequence for the graph

H4 moves from `active-design` to `frozen-contract` for the profile store. Skill
promotion is split into child node H4b, blocked on open question 1. No code is
written by this ruling.

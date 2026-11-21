# H10 design record: the refiner reads the fate of its own proposals

Date: 2026-11-21. Decided by the controller session under the standing
authorization in `docs/HARNESS-LOOP-PLAN.md` section 3.4. Node `H10` in
`.nomo/work-state.json`.

## The gap

The learning loop was closed in one direction only. The chain is mined into
entries, a gated review turns entries into a proposal, an operator approves or
rejects the exact digest, and an approved refinement is retrieved by later
turns. Nothing travelled back. The signed chain records `proposal:created`,
`proposal:rejected`, `proposal:activated` and `refinement:rolled-back`, and no
reader of the chain looked at those four records as evidence:

- `mineHarnessEntries` reads `tool`, `klass` and `decision` of tool calls only.
- `buildRefineRequest` lists mined entries, so the reviewer never saw that an
  operator had already rejected, or rolled back, the same idea.
- `refineHarness` accepted a proposal identical to one an operator had just
  rejected, because `pendingForWorkspace` only tracks what is still open.

A harness that cannot see what became of its own output does not learn from
it. It asks the operator the same question again. This is the open item in
`docs/NOMO-AGENT-HARNESS-SPEC.md` section 7, the learner running over its own
output, and it is what this node addresses.

## Options considered

A. **Outcome feedback as evidence, plus a deterministic repeat refusal.** A pure
   miner reads the four lifecycle records and produces one outcome per proposal
   digest. The review request carries the outcomes as a labelled block. A
   proposal that carries exactly the edits of a rejected or rolled back one,
   and cites no record newer than that decision, is refused before it reaches
   the chain.

B. **Score-driven automatic rollback.** Compare the ratchet before and after an
   activation and undo a refinement whose guardrails regressed.

C. **Outcomes as ordinary harness entries.** Emit the outcomes from
   `mineHarnessEntries` so every existing consumer picks them up.

## Selected: A

Rejected B: decision D1 in the loop plan keeps the ratchet descriptive. A score
never gates, changes or undoes a refinement, and an unmeasured guardrail cannot
be a gate. Automatic rollback would also be a state change no operator
approved.

Rejected C: `harnessEntries` feeds `retrievalContext`, which is the agent's
prompt. `docs/CONTEXT.md` bounds later-session retrieval to approved, verified
records. A note that an operator rejected a proposal is neither an approved
instruction nor something the working agent should act on, so outcomes stay out
of that list and reach only the reviewer.

## Contract

1. `mineRefinementOutcomes` is a pure function over chain entries. It writes
   nothing, calls no model and is deterministic under any input order.
2. One outcome per proposal digest. A proposal produces at most one outcome, so
   the loop cannot amplify itself: outcomes derived from proposals derived from
   outcomes are still bounded by the number of proposals the chain holds.
3. An outcome is evidence, not authority. It never reaches `decide`, policy,
   permissions, the tool catalog or the agent prompt.
4. The repeat refusal is exact and narrow. It applies only when the new
   proposal carries exactly the edits of one rejected or rolled back proposal,
   compared on action, kind, id, title, content, prompt addendum and profile,
   and no edit cites a sequence after the operator's decision. The reason and
   the summary are not compared, because they are the prose a model rewords. A
   subset is not a repeat: an operator who refused two edits together has not
   been asked about one of them alone. A proposal that cites a newer record is
   accepted and goes to the operator as before: citing a newer record is a
   floor for asking again, not proof that the answer changed.
5. The outcome block is charged to the operator's existing prompt ceiling. No
   new setting and no new literal limit is introduced.
6. The block quotes the proposal summary, which is model-written text the chain
   already holds and that passed the secret scan when it was recorded. The
   rejection reason an operator typed is not in the signed body and is
   therefore not available to quote.
7. Additive only. Old chains replay unchanged and a caller that passes no
   outcomes sends the byte-identical request it sent before.

## What this does not do

It does not measure whether an activated refinement helped. That needs the
ratchet compared across the activation sequence and stays a later node, read
by the operator and never applied automatically. It does not learn from the
rejection reason. It does not change when the gate pays for a review.

## Tests, failing first

- `refinement-outcomes.test.ts`: each lifecycle status, order independence,
  malformed bodies, one outcome per digest, repeat detection with and without
  newer evidence, the bounded block.
- `harness-outcome-feedback.test.ts`: at the Workbench level, a rejected
  proposal cannot be recorded again unchanged, the same edit citing a newer
  record can, a rolled back refinement behaves the same way, and outcomes are
  absent from `harnessEntries`.
- `harness-runtime.test.ts`: the review request carries the block, stays inside
  the ceiling, and is unchanged when there are no outcomes.

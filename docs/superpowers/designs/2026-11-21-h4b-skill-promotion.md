# H4b design record: skill promotion gets its own signed record

Date: 2026-11-21. Decided by the controller session under the standing
authorization in `docs/HARNESS-LOOP-PLAN.md` section 3.4. Node `H4b` in
`.nomo/work-state.json`. Resolves open question 1 of
`docs/superpowers/designs/2026-10-29-h4-profile-judge.md`, and keeps decisions
D4 and D6 of `docs/HARNESS-LOOP-PLAN.md` section 5.

## The question

The H4 judge froze the subagent profile store and left one material question to
the owner: should markdown skill promotion share the profile record kind, or get
its own `skill:promoted` event? Until it was answered, skill promotion stayed
deferred to this node, and a `skill` refinement edit still activated as a lesson
entry rather than as a skill, because `applyProposal` has no skill store to
write.

Three facts decide it, and all three are in the source today.

1. A subagent profile and a markdown skill are different objects with different
   authority. `packages/workbench/src/agents.ts` validates a profile into a
   spawnable agent: tools, policy profile, turn and context bounds. A skill is
   text that reaches a prompt. Filing both under `harnessProfile` would mean one
   replay function reading two shapes and one review surface showing two kinds of
   decision as if they were one.
2. `packages/workbench/src/project-skills.ts` already defines what a workspace
   skill is on disk: a lock-listed `skills/<id>/SKILL.md` under `.agents`, read
   only as a regular non-symlink file, bounded at 32 KiB per file, with the
   locked digest compared to the actual digest. A learned skill must not become
   one of those files, because that path is the operator's own reviewed source
   and has no digest approval behind it.
3. The profile store is already shipped: `index.ts` writes
   `harnessRefinement.profiles` plus `profile:activated` on approval and
   `profile:rolled-back` on rollback, and `promotedAgentProfiles` replays it. The
   H4 judge names the activation event `profile:promoted`, while `index.ts` writes
   `profile:activated` today; the skill path reuses neither name.

## Decision

**Skill promotion gets its own signed record field `harnessSkill` and its own
lifecycle events `skill:promoted` and `skill:rolled-back`.** It does not share
`harnessProfile`, and it does not reuse `profile:activated`.

**A promoted skill lives in the verified signed workspace chain.** The record is
written through `commitWorkspace` like every other record, so it is signed by the
same key and replayed from a verified chain. It is never written as a file into
`.agents/skills`, never added to `skills-lock.json`, and never becomes a project
skill snapshot. The same record can also live in the operator chain
`nomo-operator-harness` from HP1, so an operator can promote one learned skill to
every conversation through the same digest governance. That wiring is a later
slice: `operatorEntries` reads promotion records, not skill records, today. What
this module guarantees is that `replayPromotedSkills` is chain-agnostic, so it
reads whichever verified chain the caller hands it.

**A learned skill is guidance and nothing else.** It never alters `decide`,
policy, permissions, approvals or the tool catalog. The only rendering is
`formatPromotedSkillsForPrompt`, which labels every skill
`[Approved learned skill <id>; not policy or tool authority]` and stays inside the
caller's character budget, which is the operator's existing `maxPromptCharacters`
ceiling. No new setting is introduced, per D6.

## Record shape

The record the write path carries. `SKILL_PROMOTED_EVENT` and
`SKILL_ROLLED_BACK_EVENT` are exported from the module so the wiring slice names
the events rather than spelling them.

```jsonc
{
  "decision": "harness.skill-promotion",
  "harnessSkill": { "digest": "<64 hex>", "atSeq": 12,
                    "changes": [ { "id": "deploy-runbook",
                                   "before": null,
                                   "after": { "id": "deploy-runbook",
                                              "title": "...", "description": "...",
                                              "body": "..." } } ] },
  "harnessLifecycle": { "digest": "<64 hex>", "events": ["skill:promoted"], "atSeq": 12 }
}
```

`digest` is the proposal digest the operator approved, and it equals
`harnessLifecycle.digest`. `atSeq` is the chain position the approval was given
at, and the write is refused unless the chain length still equals `atSeq`.
`before` is `null` for a create and `after` is `null` for a delete, which is the
same shape the profile path uses.

`prepareSkillPromotion` builds the record and refuses everything the approval
must not cover: a digest that does not match the approved digest, a chain that
moved, more than four changes, a duplicate id, an update of a skill that is not
active, a create that collides with an active skill, a delete of a skill that is
not active, an update that changes nothing, a promotion that would leave more
than sixteen active skills, an id that collides with a project skill id when the
caller passes the project's ids, invalid UTF-8 or a control character in the
title, description or body, and secret-shaped text or a known secret value in any
of them.

## Rollback

`prepareSkillRollback` is symmetric to entry rollback and to profile rollback. It
takes the signed `changes` of the promotion and the skills the workspace reads
now, refuses unless the active skill matches the signed `after` exactly, and
produces the inverse changes plus `restoredIds`: the ids whose `before` was a real
snapshot, which excludes a create because nothing existed to restore. The record
carries `approvedBy: "rollback"`, which is what the entry rollback already writes
and what keeps a restored text from being read as a fresh operator instruction.

## Replay

`replayPromotedSkills` reads the verified chain in sequence order and applies
every `skill:promoted` and `skill:rolled-back` record. A record that does not
parse throws rather than being skipped, for the reason `minePromotions` gives:
this chain feeds a prompt, and a guess here is a guess in every later turn. Replay
also refuses a rollback of a digest the chain never promoted, a second rollback of
the same digest, a record carrying both events or neither, a lifecycle digest that
disagrees with the record digest, a change whose `before` does not match the state
the earlier records produced, and a skill record that carries no sequence. The
result is a map and a list sorted by id, so two runs over one chain agree.

## Limits

| Field | Limit | Why |
| --- | --- | --- |
| `id` | 64 characters, kebab case | Matches a project skill id shape closely enough to collide loudly, and stays a single token in a prompt line. |
| `title` | 120 characters | One prompt line, one review line. |
| `description` | 400 characters | The summary an operator reads before the body. |
| `body` | 8000 characters | One skill, not a document tree; the prompt block still drops whole skills to fit the ceiling. |
| changes per proposal | 4 | One approval covers one readable diff. |
| active skills per workspace | 16 | Bounds what a single prompt block can ever carry. |

The four limits, the change cap and the active cap are the constants in
`SKILL_PROMOTION_LIMITS`, so a reader finds every number in one place.

## Failure modes, all fail closed

- Digest mismatch between the proposal and the approval: refused by name.
- Chain length not equal to `atSeq`: refused, as approval already requires.
- Any limit exceeded, any invalid UTF-8, any control character: refused at parse
  time and re-checked on the write path, because a caller can construct a change
  object by hand.
- A secret-shaped value or a known secret in the text: refused on the promotion
  path, and the check covers the `before` snapshot as well as the `after`, because
  the set of known secrets can grow between the write and the promotion.
- A project skill id collision: refused, so a learned skill can never shadow or
  overwrite the operator's own lock-listed file.
- Active skill count above the cap: refused before a record is built.

## What this slice does not do

- It does not wire the record into `approveHarnessProposal`. `index.ts` is not
  owned by this node's path set, so the module lands as a pure contract with its
  tests, and the write path plus the CLI and HTTP surfaces follow in a separate
  slice. Until that slice lands, a `skill` refinement still activates as a lesson
  entry and never as a skill.
- It does not add a CLI command, an HTTP endpoint, a store, a transport or a
  dependency. D6 holds.
- It does not touch `packages/cli/src/tui/*`.
- It does not let a promoted skill change a decision. Nothing in the module
  returns a rule, a decision, a permission or a tool, and the prompt formatter
  says so in its own text.

## Tests, failing first

`packages/workbench/src/skill-promotion.test.ts` pins, in this order: the parse
limits and the UTF-8 and control-character refusals; the digest and `atSeq`
matches; the change cap, duplicate ids, project id collision, secret refusal and
active-state checks; the active skill cap; rollback symmetry including
`restoredIds` and `approvedBy`; replay order independence, later promotion
wins, rollback of an unknown digest, double rollback, both-events and digest
mismatch refusals; the prompt block label, budget and whole-skill dropping; and
the operator review diff for create, update and delete.

## Verification

```
NO_COLOR=1 node --test --test-reporter=tap packages/workbench/src/skill-promotion.test.ts
npx tsc -p packages/workbench/tsconfig.json --noEmit
LC_ALL=C.UTF-8 grep -nP '[\x{2013}\x{2014}]' \
  docs/superpowers/designs/2026-11-21-h4b-skill-promotion.md \
  packages/workbench/src/skill-promotion.ts \
  packages/workbench/src/skill-promotion.test.ts
```

Observed on 2026-11-21: 48 tests, 48 pass, 0 fail; `tsc` exit 0 with no
diagnostics; the dash grep exits 1 with no output, which is the pass. The same
grep over the three paths for any non-ASCII byte also exits 1.

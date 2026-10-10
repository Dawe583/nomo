# OMP harness, kus 6 and kus 7: superseded

Kus 6 and kus 7 from `harness/settled-review-race` are **superseded** by this
branch. **Do not port them here.** The port was tried and it would break two
things.

Both were verified by running the tree, not by reading the diff.

## Score rows: the ported module is a different design, not a refactor

`harness-score-rows.ts` on the other branch returns **one row per workspace**:
id `harness-score:<workspace>`, label `◆ harness score <first 8 of the
workspace>`, showing `hold_rate`, `deny_rate` and `first_pass_rate`. It carries
no `Verdict:` line and no sentence about the metric having no authority — the
string `Verdict` and the word `Descriptive` do not appear in that module at all.

This branch renders **one aggregated row**, id `harness:scores`, label `◈
harness score ${verdict}`, carrying the verdict, the first-pass rate, a 95%
confidence interval, the sample count, the case count, every metric without a
sample mapped through `unmeasuredMetrics()`, and the sentence stating that none
of it changes a decision or a permission.

`workspace-harness-rows.test.ts` holds this branch to that row on line 263 (the
row exists on the ledger tab), 264 (its label names a harness score), 265
(`insufficient-data`), 266 (`0 cases`), 267 (`CI: unavailable`), 274 (`HARNESS
SCORES, verdict: insufficient-data`), 275 (`95% CI: unavailable`), 276 (sample
count), 277 (case count), 278 (`never changes a decision or permission`), 307
(`1 case`), 308 (`CI: unavailable`) and 318 (`Reason: no decided call in the
chain`).

And `harness-score-rows.test.ts` from the other branch ends on line 125 with an
assertion that forbids exactly what this branch requires:

```js
assert.equal(
  rows[0].lines.filter((line) => /verdict|allow|deny the call/i.test(line))
    .length,
  0,
);
```

**These are not duplicates. They are two opposing contracts.** Porting would
bring in a test that deliberately requires breaking existing behaviour.

## Proposal rows: the port would change the shape of the signed ledger

`harness-proposal-rows.ts` calls `pendingProposalsFromEntries`, exported from
`packages/workbench/src/refine-pass.ts:469` on the other branch. **That export
does not exist on this branch** — grepping all of `packages/` returns zero
hits. Copied as is, the file does not compile: `TS2305: Module has no exported
member 'pendingProposalsFromEntries'`.

Even with the export added, the module would be dead. This branch writes a
different record shape into `harnessRefinement` at `index.ts:2982-2992` —
summary, rationale, expectedOutcome, applied, overrides, suppressedIds,
approvedBy, digest, atSeq — with **no `status` and no nested `proposal`**,
which is what the predicate reads. State is written under a different key,
`harnessProposal` (`index.ts:2820, 2837, 2969, 3024`), and the string
`status: "proposed"` does not occur anywhere in this repository.

This branch reads pending proposals through a live API,
`workbench.pendingApprovalsFor(sessionId)`, and approves through
`prepareHarnessDecision` (`workspace.ts:876`) with a confirmation dialog that
shows the operator the summary, the rationale, the expected outcome, the full
digest, the cited chain position (`Cited chain position: ${match.atSeq}.`) and
the complete proposal JSON. **That is richer than re-parsing ledger entries,
not thinner.**

A ported row would also name `/refine approve DIGEST`, which does not exist
here: this branch has `/harness approve DIGEST`.

## What survived, so nobody loses kus 6

Kus 6 (chain integration, `f939ca8`) and kus 7 (TUI score, `30d4583`) are on
`harness/settled-review-race` and neither is an ancestor of this branch. This
branch reaches the same ground by its own commits, and it is strictly ahead on
the Workbench API: `pendingApprovalsFor`, `applyPromptAddendum`,
`expectedBranchVersion` and `prepareHarnessDecision` occur zero times across
`packages/workbench/src` and `packages/cli/src/tui` on the other branch, and
exist on this one.

So the branch guard `expectedBranchVersion`, which stops a stale write when the
reviewed branch moved, has no counterpart to port because the other branch has
no such guard.

# WP-LENSES Proposal B: different fixed angles, any-approve with first-approval tiebreak

## 1. Value case

One reviewer has three uncorrelated failure modes, and the repo's own history
proves each one is real:

1. **Reviewer variance.** A single sample from a stochastic model declines a
   real lesson or approves noise on temperature alone. A second independent
   read over the same evidence packet is the only correction that does not
   trust the first answer.
2. **Weak proposals.** Lens 1 asks "is there a durable lesson" and accepts any
   well-formed proposal. Nothing today checks whether the edit would survive
   `validateProposal` usefully or help an operator reading it. A
   proposal-quality angle rejects approvals whose edits are vague, untestable,
   or cosmetic.
3. **Evidence misreads.** The review prompt already warns that the chain
   records what happened, not why, yet a single reviewer still approves causal
   stories that sound plausible. An evidence-skeptic angle exists only to
   decline those.

What a second lens buys, honestly: higher **recall of real lessons** (a lesson
two angles independently approve is worth more than one sample's opinion) and
fewer **bad approvals reaching the operator** (a quality veto is cheaper than
operator time on a cosmetic proposal, even with the prompt-edit human gate
downstream).

When it is NOT worth it: quiet workspaces where the gate fires rarely gain
nothing measurable, because K multiplies a cost that is already near zero and
a second opinion on an obvious decline is pure spend. If the evidence is
usually unambiguous, lens 1 already decides correctly and lenses 2..K only
confirm it. At default K=1 the feature costs exactly nothing, so the honest
position is: ship the dial, leave it at 1, turn it up only on workspaces
where declined-then-regretted or approved-then-useless reviews are observed.

If the feature is not worth building at all, the cheapest experiment that
settles it: run lens 1 twice (K=2 identical samples) over a sample of real
armed rounds and measure the disagreement rate. Agreement above ~95% means a
second lens adds nothing and this WP should be deferred; disagreement above
~20% means reviewer variance alone justifies K=2 before any new angles.

## 2. Design

### Decision 1. What a lens is: K different fixed angles

Three fixed prompts in code, each the same evidence packet plus one angle
suffix:

- **Lens 1, noise filter.** Today's reviewer prompt, byte-identical. When K=1
  the request string is constructed exactly as today, so default behavior is
  bit-for-bit reproducible.
- **Lens 2, proposal-quality critic.** Same evidence, plus a fixed suffix
  demanding the proposal be concrete, operator-readable, and enforceable:
  decline approvals whose edits are vague, cosmetic, or untestable.
- **Lens 3, evidence skeptic.** Same evidence, plus a fixed suffix demanding
  the lesson be supported by the entries shown: decline causal explanations,
  hypotheses, and generalizations the listed entries do not support.

Rationale: identical re-samples catch only variance; proposer-plus-checkers
needs two sequential round-trips (the checker cannot judge a proposal it has
not seen) and widens the branch-move window. Parallel distinct angles catch
all three failure modes in one round of calls.

K is clamped to 1..3. Lens `i` runs only if `i <= K`; lens order and prompts
are fixed, so K=2 always means noise filter plus quality critic.

### Decision 2. Merge policy: any-approve, first-approval proposal wins, ties broken by fixed lens order

A round approves if **any** lens approves. The applied proposal is the first
approval in fixed lens order (lens 1 beats lens 2 beats lens 3).
Deterministic, no randomness, no operator input.

Rationale and fail direction: the merge itself leans toward learning, which
is safe here because precision already lives downstream — `validateProposal`
rejects malformed proposals, `kind: "prompt"` edits wait for an operator
signature, and the cooldown stamps every attempt either way. The reviewer's
job in this loop is recall (finding lessons worth a human look); the gate and
the validator supply the fail-toward-NOT-learning bias the repo demands. The
one place ambiguity fails toward NOT learning is proposal choice: on
disagreement about proposal text, later lenses never overwrite an earlier
approval, and a lens that approved nothing contributes nothing.

Rejected: unanimity. With three independent decline probabilities almost
nothing would ever clear, and every armed round would still pay K calls — cost
without value.

### Decision 3. Fan-out lives in `harness-runtime.ts` `review()`, calling the injected `ask` K times sequentially

The evidence packet (`question` plus `evidence`) is built once, identically
for every lens. `review()` then loops `i = 1..K`, appending that lens's fixed
suffix (empty for lens 1), and awaits `deps.ask` once per lens, in order.
The `ask` closure in `index.ts` is untouched.

Rationale: the injected `ask` is the seam the module was designed around
("hand in an asker that counts"), so K calls through it keep cost honesty
automatic — K usage events, one per call, with zero wiring changes. Sequential
await keeps usage-event order deterministic and keeps the K=1 path a single
unchanged call. The per-session boundary lock (D-8) already serializes
boundaries, so no new concurrency gate is needed or added.

### Decision 4. The setting: `refinementLensCount`, range 1..3, default 1, consumed in `harness-runtime.ts`

```ts
refinementLensCount: {
  label: "Review lenses",
  description: "How many independent reviewer angles read one evidence packet before their verdicts are merged. 1 reproduces today's single review.",
  consumerFile: "harness-runtime.ts",
  consumers: ["resolveLensCount"],
  default: 1,
  min: 1,
  max: 3,
  icon: "◐",
},
```

The `consumerFile` union in `harness-settings.ts` widens with one member:
`"index.ts" | "provider.ts" | "gui.ts" | "agents.ts" | "harness-runtime.ts"`.
`harness-runtime.ts` gains an exported `resolveLensCount(raw: unknown): number`
(clamp to 1..3, non-numbers fall back to 1) which `serviceHarnessBoundary`
reads from a new optional dep `lensCount`. `index.ts` passes
`lensCount: this.harness.refinementLensCount` — wiring only, no logic there,
so the consumer assertion (which greps the named file for the named symbol)
holds: `resolveLensCount` is defined in `harness-runtime.ts`.

Rationale: the name follows the `refinement*` family; the range is the number
of fixed angles that exist, so a setting value can never name a lens with no
prompt; the default preserves today's behavior exactly.

### Decision 5. Per-lens failure: a failed lens degrades to a decline; only all-failed is a round failure

- A lens whose `ask` throws, or whose reply is not the agreed JSON (garbage,
  prose, approval-without-proposal), is recorded as that lens's decline, with
  reason `lens N (name) errored: <message>` or the existing
  `parseReviewVerdict` decline reason. The round continues with the other
  lenses.
- If **at least one** lens returns a verdict (approve or decline), the round
  outcome is `declined` or `ran` per the merge table. A single dead lens never
  fails a round that produced a real verdict.
- If **all** lenses error (or K=1 errors, exactly today's path), the round is
  `failed` with the first error, stamps the cooldown, and reports exactly as
  today.

Rationale: failing the whole round on one bad lens would let a transient
provider hiccup veto learning the other lenses already paid to evaluate, and
would burn the cooldown on partial information. But errors are never silent:
each degraded lens is named in the report reason. All-failed stays `failed`
(rather than `declined`) so a down provider is still visible as a provider
problem and still throttled by the cooldown, preserving the prime-src rule
that every attempt stamps.

### Decision 6. What the operator sees: per-lens verdicts inside the existing reason/note strings, no new event types

- `declined` reason becomes a joined string, e.g.
  `"lens 1 (noise filter) declined: one-off tool output; lens 2 (proposal quality) declined: edits too vague to enforce"`.
  A degraded lens appears as `"lens 3 (evidence skeptic) errored: <message>"`.
- `ran` keeps today's shape (`instructions` = winning proposal); the
  `harness.review` report note names the winning lens, e.g.
  `"Harness review ran and recorded a proposal (lens 2 of 2, proposal quality)."`.
  Dissenting declines are appended to the same note string.
- Usage events are unchanged in shape: K calls produce K `usage` events with
  `source: "harness"` through the existing closure. A lens that never ran
  (K smaller, or short-circuit never happens — there is none) produces no
  event and is never claimed.

Rationale: the outcome vocabulary and ledger event shapes are frozen, and a
reason string that names each lens is fully queryable by the operator without
any new schema. No TUI change is needed: the settings panel renders
`harnessSettingsView` rows automatically.

## 3. Merge policy table

`A` = approve with proposal, `D` = decline, `E` = errored/garbage (degraded
to decline). Lenses in fixed order 1..K. Winner = first `A` in lens order.

| Lenses (K=2) | Round outcome | Reported |
| --- | --- | --- |
| D, D | `declined` | both reasons joined |
| A(x), D | `ran` with x | lens 1 named winner; lens 2 dissent in note |
| D, A(y) | `ran` with y | lens 2 named winner; lens 1 dissent in note |
| A(x), A(y), x != y | `ran` with x | first-approval wins; lens 2 dissent in note |
| E, D | `declined` | lens 1 error named, lens 2 reason joined |
| D, E | `declined` | lens 2 error named, lens 1 reason joined |
| E, E | `failed` (first error) | today's failure path, cooldown stamped |

| Lenses (K=3, additions) | Round outcome | Reported |
| --- | --- | --- |
| D, D, D | `declined` | all three reasons joined |
| any one A | `ran` with first A in order | winner named; dissents in note |
| A(x), A(y), A(z) all differ | `ran` with x | lens 1 wins; others dissent in note |
| E, E, D | `declined` | errors named, verdict decides |
| E, E, E | `failed` (first error) | today's failure path |

K=1 rows are exactly today's behavior: `A` -> `ran`, `D` -> `declined`,
`E` -> `failed`.

## 4. Diff sketch

- `packages/workbench/src/harness-runtime.ts` (~+120 lines): `LENS_DEFS`
  (three fixed `{ name, suffix }` entries, lens 1 suffix `""`),
  `resolveLensCount`, `mergeLensVerdicts` (pure, table above),
  `formatLensReport`; `review()` builds the packet once and loops K asks;
  `HarnessRuntimeDeps` gains optional `lensCount?: number`. K=1 prompt string
  unchanged by construction (empty suffix, single call).
- `packages/workbench/src/harness-settings.ts` (~+15 lines): new
  `refinementLensCount` key; `consumerFile` union gains `"harness-runtime.ts"`.
- `packages/workbench/src/index.ts` (~+5 lines): pass
  `lensCount: this.harness.refinementLensCount` in `serveHarnessBoundary`.
- `packages/workbench/src/harness-runtime.test.ts` (new or extended):
  fan-out and merge tests below. No ledger, gate, trigger, or TUI changes.

## 5. Test plan

- `lens count defaults to 1 on missing, non-numeric, and out-of-range input`.
- `K=1 sends today's exact prompt string through one ask call`.
- `K=2 sends the same evidence packet with each lens suffix, in lens order`.
- `any single approval runs the round with the first approval's proposal`.
- `two approvals with different proposals apply the lens-1 text`.
- `all declines join every lens reason in the declined string`.
- `one errored lens plus one decline is declined, naming the errored lens`.
- `all lenses errored is failed with the first error and stamps the cooldown`.
- `K=2 produces two usage records through the ask closure; a skipped lens produces none`.
- `settings table: refinementLensCount names resolveLensCount in harness-runtime.ts` (covered by the existing consumer assertion once widened).
- `invalid proposal from the winning lens still fails toward not learning via validateProposal`.

## 6. Risks and what fails toward NOT learning

- **Noise approvals rise with any-approve.** Accepted: downstream
  `validateProposal` plus the prompt-edit human gate bound the damage, and the
  quality-critic lens exists to offset exactly this. If approval quality drops
  in practice, the dial turns back to 1 with no code change.
- **Cost doubles/triples per armed round.** Honest and intended: the setting
  description states the multiplier, usage events stay per-call, default 1
  changes nothing. The gate still runs first, so held rounds cost zero.
- **Proposal disagreement hides a better edit.** First-approval-wins may apply
  lens 1's weaker proposal over lens 2's stronger one. Accepted as the price
  of determinism; dissents are visible in the note for the operator to judge.
- **A lens prompt that is itself bad vetoes nothing and approves noise.**
  Lens prompts are frozen strings reviewed like code; a bad lens is fixed by
  editing the string, not by adding operator text.
- **Branch move mid-fan-out.** Unchanged handling: the existing
  `currentBranchVersion` check after `review()` discards the whole merged
  verdict, and partial lens results are never applied or retained.

## 7. Cost accounting

Happy path, K lenses, gate passed: exactly **K provider calls** and **K
`usage` events** (`source: "harness"`), one per lens, in lens order. K=1:
1 call, 1 record — today's accounting to the token.

Failure paths:

- Gate held: **0 calls, 0 records** (unchanged; the gate runs once before any lens).
- One lens errors, another returns a verdict: **K calls attempted, K-1 or
  fewer records** — only lenses whose `ask` resolved produce usage records; the
  errored lens bills nothing and claims nothing.
- All lenses error: **K calls attempted, 0 verdicts, round `failed`**,
  cooldown stamped once (unchanged single stamp in `serviceTrigger`).
- Branch moved during fan-out: **up to K calls spent, 0 records applied** —
  the merged verdict is discarded, nothing is written, cooldown unstamped
  (today's rule preserved).
- Post-merge `run` throws on the winning proposal: unchanged `failed` path;
  lens dissents do not retry anything.

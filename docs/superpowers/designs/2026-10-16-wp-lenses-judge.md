# WP-LENSES judge ruling (2026-10-16)

Base: proposal A (minimal blast radius). Taken from B: the falsification experiment plus ship-at-1 operator guidance, and the `resolveLensCount` pure-clamp helper shape (re-ranged to 1..3).

## Scorecard

| Criterion | A | B |
| --- | --- | --- |
| 1. Fail-direction safety | 2: unanimity fails toward NOT learning under every disagreement; every spend-or-learn path (ask, apply, stamp) is named | 0: any-approve leans toward learning at the merge; a round can apply on partial info with an errored lens inside |
| 2. Cost honesty | 2: K calls = K records per path; unrun lenses never billed or claimed | 1: Decision 6 says K calls produce K usage events, but section 7 says K-1 or fewer; an errored lens's spend is invisible on a `ran` round |
| 3. Minimal blast radius | 2: about 60 lines, K=1 byte-identical, no union widening | 1: K=1 byte-identical, but about 120 lines, three prompt strings, one union member |
| 4. Effect integrity | 2: every decline vetoes; every lens changes the outcome | 0: under any-approve, lens 2/3 declines change nothing when lens 1 approved (see answer below) |
| 5. Testability | 2: all pinned with the injected ask, no model | 2: same seam, prompt-suffix assertions still exact-string |
| 6. Contract clarity | 2: exact names, strings, ranges, failure semantics | 1: usage-record contradiction above; ran-note dissent format not exactly specified |
| 7. Value honesty | 2: admits K>1 is insurance that rarely fires | 1: asserts recall and quality gains unmeasured; partial credit for naming the experiment that would falsify them |
| Total | 14 | 6 |

## Mandatory answers

- Under B any-approve, lens 2's or 3's decline in a round where lens 1 approved changes nothing. The round still runs with lens 1's proposal; the dissent lands in a note string only. That is decorative, not an effect, and it is not acceptable: a lens whose verdict cannot change the outcome is a billed call with no vote.
- Under A unanimity with identical samples, the honest expected effect is small and negative on volume: the veto fires at the identical-sample disagreement rate, which for a decisive reviewer is low single digits, so K=2 buys a rarely-firing veto at 2x review spend and slightly higher precision. The design still earns the dial because the dial is the instrument that measures that rate: ship the dial at default 1, let the operator observe the veto rate, keep the cost decision with the operator.
- Throw-fails (A) matches "every attempt stamps the cooldown" and the repo bias. The trigger stamps the cooldown on both `declined` and `failed`, so the discriminator is not the stamp: it is visibility. A throw that fails the round surfaces a down provider as `failed` and throttles it. B degrade can return `ran` with an errored lens inside, masking a failing provider for as long as one lens succeeds, which is the unbounded-learning-on-a-failing-provider mirror of the unbounded-bill the cooldown rule exists to prevent.
- Setting range: 1..3. Under unanimity each added lens buys only more veto power at full K cost; K=2 delivers the whole veto value and K=3 allows observing the disagreement rate. Beyond 3 is spend without a named buyer, so the smaller cap wins.
- Consumer file: index.ts (A). No union widening. If the builder widens the union instead, they must also update CONSUMER_FILES in harness-settings.test.ts; the frozen contract does not.

## Decision

Base proposal A, with two takes from B and four rejections.

Taken from B: (1) the falsification experiment as operator guidance (measure the K=2 veto/disagreement rate over real armed rounds; near-zero means leave the dial at 1 and defer any angle work; material means K=2 earns its keep); (2) the `resolveLensCount` pure clamp helper shape, re-ranged to 1..3.

## Rejected parts

- B any-approve merge: inverts fail-toward-NOT-learning and leaves dissenting lenses decorative.
- B distinct fixed angle suffixes: unvalidated prompt surface with no measured buyer; identical samples keep K=1 byte-identical by construction.
- B degrade-to-decline: masks provider failure and learns on partial info.
- A max 5: spend beyond the veto's value; cap is 3.
- B harness-runtime.ts consumer plus union widening: buys nothing the index.ts wiring does not already provide.

## Frozen contract

### harness-runtime.ts exports

```ts
export function resolveLensCount(raw: unknown): number;
export function mergeLensVerdicts(verdicts: ReviewVerdict[]): ReviewVerdict;
export type HarnessRuntimeDeps = { ...existing...; readonly reviewLensCount?: number; };
```

- `resolveLensCount`: non-number (including undefined) falls back to 1; otherwise round and clamp to 1..3.
- `mergeLensVerdicts`: input is non-empty, length K, fixed lens order. All approve gives `{ approve: true, instructions: verdicts[0].instructions }` (lens 1 text, first in fixed order). Otherwise gives `{ approve: false, reason }` with reason `(M of K approved) p1; p2; ...` where M counts approvals and each part is `lens i approved` or `lens i: <verdict reason>`, 1-based, joined with `; `. Pure, no model, no clock.
- `serviceHarnessBoundary` review closure: build the request string exactly as today, once. `const lensCount = resolveLensCount(deps.reviewLensCount)`. If 1, one ask and return `parseReviewVerdict` unmerged (today's path, no tally). Else loop i = 1..K sequentially: `deps.ask` in try/catch; on throw, throw `new Error(\`lens ${i} of ${K}: ${message}\`)` so later lenses never run; else push `parseReviewVerdict(reply)` (garbage JSON is a decline, never a throw). Return `mergeLensVerdicts(verdicts)`. `parseReviewVerdict`, gate, trigger, and cooldown handling untouched.

### Combination table (K=2, generalizes to any K; A approve, D decline incl. garbage, T throw)

| Lens 1 | Lens 2 | Outcome | Effect |
| --- | --- | --- | --- |
| A text-P | A text-Q | ran | applies P (lens 1 text, first in fixed order) |
| A | D reason-R | declined | reason `(1 of 2 approved) lens 1 approved; lens 2: R` |
| D reason-R | A | declined | reason `(1 of 2 approved) lens 1: R; lens 2 approved` |
| D reason-R | D reason-S | declined | reason `(0 of 2 approved) lens 1: R; lens 2: S` |
| A | T err-E | failed | error `lens 2 of 2: E`; cooldown stamped; 2 asks billed |
| T err-E | never runs | failed | error `lens 1 of 2: E`; cooldown stamped; 1 ask billed, lens 2 never billed or claimed |
| D reason-R | T err-E | failed | error `lens 2 of 2: E`; the earlier decline is moot, failure dominates |
| garbage-G | A | declined | G parses to a decline; same as A+D |
| garbage-G | garbage-H | declined | same as D+D with parse reasons |

General rule: all-A gives ran with lens 1 text; any D with no T gives declined with the full per-lens tally; any T gives failed naming the first lens that threw, lenses after it never run.

### Report strings (exact)

- K=1 declined: outcome.reason is the bare reviewer reason; note `Review declined: <reason>` (existing code, untouched).
- K>1 declined: outcome.reason `(M of K approved) p1; p2; ...`; the existing `Review declined: ` prefix applies, e.g. `Review declined: (1 of 2 approved) lens 1 approved; lens 2: edits too vague to enforce.`
- K=1 ran: `Harness review ran and recorded a proposal.` (existing code, untouched).
- K>1 ran: `Harness review ran and recorded a proposal (K of K lenses approved).` via a small branch in `reportHarnessOutcome` reading the clamped setting (unanimity means M always equals K on ran).
- Failed: existing `Harness review did not complete: <message>` where the message already carries `lens i of K: `.
- `manualResultFrom` untouched: it forwards outcome.reason, so the tally flows to `/harness review` callers for free.

### Setting row (harness-settings.ts)

```ts
refinementLensCount: {
  label: "Review lenses",
  description: "How many independent reviews one harness round pays for. Every lens must approve before anything is recorded; 1 is today's behavior.",
  consumerFile: "index.ts",
  consumers: ["serveHarnessBoundary"],
  icon: "◑",
  default: 1,
  min: 1,
  max: 3,
},
```

No change to the consumerFile union, no change to CONSUMER_FILES or the zero-means-unlimited list in harness-settings.test.ts (min is 1).

### index.ts wiring delta

- Import `resolveLensCount` from harness-runtime.ts; in `serveHarnessBoundary` pass `reviewLensCount: resolveLensCount(this.harness.refinementLensCount)` into `serviceHarnessBoundary`. Ask closure, apply, branch version, write-back all untouched.
- In `reportHarnessOutcome`, for a `ran` outcome with clamped count above 1, append ` (K of K lenses approved)`. Declined, not-run, and failed paths untouched.

### Allowed files

`packages/workbench/src/harness-runtime.ts`, `packages/workbench/src/harness-settings.ts`, `packages/workbench/src/index.ts` (wiring plus the ran-note branch only), `packages/workbench/src/harness-runtime.test.ts` (new). No changes to refine-gate.ts, refine-trigger.ts, harness-settings.test.ts, ledger or event shapes, or TUI files.

### Cost accounting (frozen per path)

- Gate held: 0 provider calls, 0 usage records.
- Happy path K lenses: exactly K asks; one usage record per ask that returns a reply (provider-reported via the untouched closure, never invented); at most 1 apply on unanimous approve, else 0.
- Throw at lens i: exactly i asks; lenses after i never run and are never billed or claimed; outcome failed; cooldown stamped.
- Garbage JSON at any lens: all K asks still run (a reply was received and billed); outcome declined; nothing applied.
- Branch move mid-loop: existing trigger checks discard the round without stamping; calls made stay billed, unmade never run.
- Pending-review path (retained approval): 0 asks regardless of K; lenses apply only to fresh reviews.

## Test list

- lenses-default-one-ask-is-todays-path: K absent sends one ask with the exact current prompt and returns its verdict unmerged.
- lenses-k1-reason-has-no-tally: K=1 decline reason equals today's bare reviewer reason.
- lenses-two-approvals-run-first-text: two approving asks apply lens 1 instructions.
- lenses-one-decline-vetoes: A+D yields declined with `(1 of 2 approved)` naming both lenses.
- lenses-all-decline-joins-reasons: D+D yields declined with `(0 of 2 approved)` and both reasons.
- lenses-garbage-json-is-a-decline: non-JSON second reply vetoes; round is declined, not failed.
- lenses-throw-fails-and-stamps-cooldown: second ask rejecting yields failed with `lens 2 of 2: ` and a stamped cooldown.
- lenses-throw-skips-later-lenses: first ask rejecting makes exactly one ask call.
- lenses-decline-then-throw-still-fails: D then T yields failed naming lens 2; the decline is moot.
- lenses-setting-clamps: refinementLensCount 0 clamps to 1, 99 clamps to 3, non-number falls back to 1.
- lenses-consumer-assertion-covers-new-key: serveHarnessBoundary resolves in index.ts (covered by the existing generic test; named here so VERIFY checks it).
- lenses-k2-asks-twice-and-merges: K=2 makes exactly two sequential asks with the byte-identical request string.

## Build exit commands (one node process at a time)

```
npx tsc -p packages/workbench/tsconfig.json --noEmit
npx tsc -p packages/cli/tsconfig.json --noEmit
node --test --test-concurrency=1 packages/workbench/src/*.test.ts
node --test --test-concurrency=1 packages/cli/src/tui/*.test.ts
```

## D-9 decision-log row (paste into the graph doc)

| Decision | Choice | Rejected because |
| -------- | ------ | ---------------- |
| D-2026-10-16-9 WP-LENSES merge rule | Unanimous K identical samples, throw-fails, range 1..3, consumer index.ts, default K=1 byte-identical; falsification experiment (measure the K=2 veto rate; near-zero leaves the dial at 1) | Any-approve inverts fail-toward-NOT-learning and leaves dissents decorative; fixed angles add unvalidated prompt surface with no measured buyer; degrade-to-decline masks provider failure; max 5 spends beyond the veto's value; widening the consumer union buys nothing |

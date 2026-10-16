# WP-LENSES proposal A: minimal blast radius (2026-10-16)

Mandate: optimize for smallest diff, behavior identical at K=1, easiest to test, least new surface.

## Value case

A second lens buys one thing: protection against a single flaky approval. Today one
approval writes a proposal to the signed chain; two identical samples that disagree
are evidence the lesson was noise, and the repo's stated bias is to fail toward NOT
learning. That is the whole honest value: a veto on one-off approvals, not better
diagnoses.

When it is not worth it: with identical prompts the lenses mostly agree, so K=2
roughly doubles review spend for a veto that fires rarely. Any operator turning the
dial up is buying insurance, not signal. Diverse fixed angles would buy signal but
are a larger diff (new prompt strings to validate, angle-drift to test, merge policy
over unlike verdicts), which is exactly what this proposal refuses to pay.

## Design

### 1. What a lens is: K identical samples

Each lens sends the byte-identical request the single review sends today (same
evidence packet, same REFINEMENT_INSTRUCTIONS, same VERDICT_PROTOCOL) through the
same injected ask. No new prompt strings, no angles, no proposer/checker roles.
Rationale: K=1 executes literally today's code path, and sampling is the only lens
shape whose merge policy needs no judgment about which angle outranks another.
Gives up: diversity of perspective; correlated failures stay correlated.

### 2. Merge policy: unanimity to learn, first approval's text

The round runs (applies a proposal) only if ALL K lenses approve. Any decline
vetoes the round and the outcome is declined. When all approve but proposal texts
differ, the applied instructions are lens 0's (fixed order, deterministic,
documented). Rationale: unanimity is the only policy whose fail direction is NOT
learning under every disagreement, matching the repo bias; any-approve would make
K a learning-rate multiplier, which inverts the bias. First-in-order breaks text
ties without comparing proposals.

### 3. Fan-out: harness-runtime.ts review() calls injected ask K times, sequentially

The loop lives inside the review closure in serviceHarnessBoundary, which builds
the request once and calls deps.ask K times in a for loop, awaiting each in turn.
The ask closure in index.ts is untouched and stays the single billing point.
Rationale: the trigger (refine-trigger.ts) never learns lenses exist (outcome
vocabulary and cooldown stamping unchanged); sequential awaits keep the D-8
single-boundary no-concurrency property with zero new synchronization; K=1 takes
the exact current path. Gives up: latency is Kx sequential instead of parallel.

### 4. Setting: refinementLensCount, default 1, range 1..5, consumed in index.ts

- Key: refinementLensCount. Label "Review lenses". Description: "How many
  independent reviews one harness round pays for. Every lens must approve before
  anything is recorded; 1 is today's behavior."
- default 1, min 1, max 5. Min 1 (not 0) because 0 lenses is a second off-switch
  next to refinementEnabled and a setting that disables learning by another name;
  max 5 caps the per-round bill at five model calls.
- consumerFile: index.ts (already in the consumerFile union, so the union does
  NOT need widening). consumers: ["serveHarnessBoundary"], which reads
  this.harness.refinementLensCount, clamps defensively to 1..5, and passes it as a
  new optional HarnessRuntimeDeps field reviewLensCount (default 1 when absent).
- The settings-rule test keeps passing unmodified: the generic loops cover the
  new key automatically and the consumer assertion resolves serveHarnessBoundary
  in index.ts.

### 5. Per-lens failure: throw fails the round, garbage JSON is a decline

- A lens whose ask rejects (error, timeout, abort): the review closure lets it
  throw, exactly as today's single ask does. serviceTrigger's existing catch
  stamps the cooldown and the outcome is failed, reported through the existing
  harness.review.failed path. No per-lens retry, no degradation: a retried lens
  would spend beyond the K the operator budgeted, and degrading to K-1 would
  silently change the merge quorum.
- A lens returning non-JSON or approve-without-proposal: parseReviewVerdict
  already maps both to a decline with a reason, so that lens counts as declined
  with reason "lens i: <existing reason>". The round then declines by unanimity.
- Report: a thrown lens names itself in the failure error ("lens 2 of 3:
  <message>"); garbage JSON appears as that lens's decline reason in the joined
  string.

### 6. Operator surface: one line, no new event types

No new ledger event shapes. The existing harness.review tool event carries a
tallied reason string; usage events already fire once per ask through the
untouched closure, so K lenses produce K source-harness usage records with no
code change. Formats:

- declined: "Review declined (1/2 approved): lens 1 approved; lens 2: <reason>."
- ran: "Harness review ran and recorded a proposal (2/2 lenses approved)."
- failed: unchanged ("Harness review did not complete: lens 2 of 2: <message>").
- At K=1 the strings reduce to near-today's ("Review declined: <reason>") by
  omitting the tally when lensCount is 1, keeping existing tests and operator
  muscle memory intact.
- manualResultFrom in index.ts is untouched: it forwards outcome.reason, so the
  tally flows to /harness review callers for free.

## Merge policy table

Lens verdicts use A (approve), D (decline, incl. garbage JSON), T (throw).
Order is fixed lens 0..K-1; the table shows K=2, generalizing to any K.

| Lens 1 | Lens 2 | Round outcome | Applied instructions / reason |
| ------ | ------ | ------------- | ------------------------------ |
| A text-P | A text-Q | ran | lens 1's text P (first in fixed order) |
| A | D reason-R | declined | "Review declined (1/2 approved): lens 1 approved; lens 2: R." |
| D reason-R | A | declined | "Review declined (1/2 approved): lens 1: R; lens 2 approved." |
| D reason-R | D reason-S | declined | "Review declined (0/2 approved): lens 1: R; lens 2: S." |
| A | T err-E | failed | error "lens 2 of 2: E"; cooldown stamped |
| T err-E | (never runs) | failed | error "lens 1 of 2: E"; cooldown stamped; lens 2 never billed |
| D reason-R | T err-E | failed | error "lens 2 of 2: E"; the earlier decline is moot, failure dominates |
| garbage-G | A | declined | G parses to a decline, same as A+D row |
| garbage-G | garbage-H | declined | same as D+D row with parse reasons |

General rule for K: all-A gives ran with lens 0's text; any D (with no T) gives
declined with the full per-lens tally; any T gives failed naming the first lens
that threw, and lenses after it never run.

## Diff sketch

- packages/workbench/src/harness-runtime.ts (~40 lines): HarnessRuntimeDeps
  gains `reviewLensCount?: number`; serviceHarnessBoundary clamps it to 1..5
  defaulting to 1; the review closure builds the request once, loops K asks, and
  calls a new pure helper mergeLensVerdicts(verdicts: ReviewVerdict[]):
  ReviewVerdict (about 15 lines, unit-testable without a model). parseReviewVerdict
  untouched. K=1 path: one ask, verdict returned unmerged (no tally prefix).
- packages/workbench/src/index.ts (~5 lines): serveHarnessBoundary passes
  reviewLensCount: clamp of this.harness.refinementLensCount. ask closure,
  reportHarnessOutcome, manualResultFrom untouched.
- packages/workbench/src/harness-settings.ts (~13 lines): one new table row
  refinementLensCount (min 1, max 5, default 1, icon from the unused geometric
  range, consumerFile index.ts, consumers ["serveHarnessBoundary"]).
- No changes to refine-gate.ts, refine-trigger.ts, harness-settings.test.ts, or
  any ledger/event shape.

## Test plan (node:test, one line each)

- lenses-default-one-ask-is-todays-path: K absent sends one ask with the exact current prompt and returns its verdict unprefixed.
- lenses-two-approvals-run-first-text: two approving asks apply lens 0's instructions.
- lenses-one-decline-vetoes: A+D yields declined with the (1/2) tally naming both lenses.
- lenses-all-decline-joins-reasons: D+D yields declined with the (0/2) tally and both reasons.
- lenses-garbage-json-is-a-decline: non-JSON second reply vetoes like a decline, round is declined not failed.
- lenses-throw-fails-and-stamps-cooldown: second ask rejecting yields failed, cooldown stamped, settled counter reset.
- lenses-throw-skips-later-lenses: first ask rejecting makes exactly one ask call.
- lenses-setting-clamps: refinementLensCount 0 clamps to 1, 99 clamps to 5, non-number falls back to 1.
- lenses-consumer-assertion-covers-new-key: serveHarnessBoundary resolves in index.ts (covered by the existing generic test, named here so VERIFY checks it).
- lenses-k1-reason-has-no-tally: K=1 decline reason equals today's bare reason string.

## Risks and what fails toward NOT learning

- Identical samples mostly agree, so K>1 spends Kx for a rarely-firing veto; the
  cost is visible per-lens in usage events and capped at 5 by the max.
- Unanimity suppresses learning as K grows (two reviewers must both say yes);
  this is the intended fail direction, and the default K=1 means nobody pays it
  unasked.
- All-approve with differing proposal texts applies lens 0's text and discards
  the rest; deterministic and documented, but a better-composed proposal is not
  synthesized.
- Sequential asks make a K-lens round Kx slower than one review; accepted to
  avoid any concurrency surface inside the D-8 boundary lock.
- Decline-reason strings grow with K; capped in practice by max 5 and the
  existing prompt ceiling, and a long reason can only make a declined round more
  obviously declined.
- A lens that times out fails the whole round and stamps the cooldown, so one
  slow provider call delays the next review window; the alternative (retry or
  degrade) would spend unbudgeted calls or move the quorum silently.

## Cost accounting

- Gate held (any held refusal, manual or not): 0 provider calls, 0 usage records.
- Happy path, K lenses: exactly K ask calls, K usage records with source
  harness, 1 applied proposal at most (unanimous approve) or 0 (any decline).
- Per-lens throw at lens i (1-based): exactly i ask calls, i usage records for
  the attempts made, lenses after i never run and are never billed or claimed;
  outcome failed.
- Per-lens garbage JSON at any lens: all K asks still run (a reply was received
  and billed), K usage records, outcome declined, nothing applied.
- Branch move during the lens loop: existing trigger checks discard the round
  without stamping; calls already made stay billed (they happened), calls not
  yet made never run.
- Pending-review path (a retained approval from an earlier boundary): 0 asks
  regardless of K; lenses apply only to fresh reviews.

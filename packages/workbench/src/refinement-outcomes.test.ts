/**
 * The fate of a proposal, read back from the chain that recorded it.
 *
 * The claim under test is narrow: the four lifecycle records are enough to say
 * what became of every proposal, the answer does not depend on the order the
 * records are handed over in, and a proposal an operator already settled can
 * be recognised without trusting the model that wrote it.
 */
import test, { describe } from "node:test";
import assert from "node:assert/strict";

import type { RefinementEdit, RefinementProposal } from "./refine-pass.ts";
import {
  formatOutcomesForReview,
  mineRefinementOutcomes,
  repeatsSettledProposal,
} from "./refinement-outcomes.ts";

const digest = (letter: string) => letter.repeat(64);

const edit = (overrides: Partial<RefinementEdit> = {}): RefinementEdit => ({
  action: "create",
  kind: "memory",
  title: "deletes are held",
  content: "Ask before deleting a bucket.",
  reason: "recurring refusal",
  derivedFromSeq: [1],
  ...overrides,
});

const proposal = (
  edits: readonly RefinementEdit[] = [edit()],
  summary = "confirm deletes need an approval",
): RefinementProposal => ({
  summary,
  rationale: "seq 1 refused five times",
  expectedOutcome: "fewer holds",
  edits,
});

const created = (seq: number, id: string, value = proposal()) => ({
  seq,
  body: { decision: "proposal:created", harnessProposal: { digest: id, proposal: value } },
});
const rejected = (seq: number, id: string) => ({
  seq,
  body: { decision: "proposal:rejected", harnessProposal: { digest: id, status: "rejected" } },
});
const activated = (seq: number, id: string, value = proposal()) => ({
  seq,
  body: {
    decision: "proposal:activated",
    harnessProposal: { digest: id, status: "approved", proposal: value },
    harnessLifecycle: { digest: id, events: ["proposal:approved", "proposal:activated"] },
  },
});
const rolledBack = (seq: number, id: string) => ({
  seq,
  body: {
    decision: "refinement:rolled-back",
    event: "rollback",
    harnessLifecycle: { digest: id, events: ["refinement:rolled-back"] },
  },
});
const call = (seq: number) => ({
  seq,
  body: { decision: "deny:policy", tool: "aws.s3.bucket.delete", klass: "r3" },
});

describe("mineRefinementOutcomes", () => {
  test("an empty chain and a chain of tool calls hold no outcomes", () => {
    assert.deepEqual(mineRefinementOutcomes([]), []);
    assert.deepEqual(mineRefinementOutcomes([call(1), call(2)]), []);
  });

  test("names each of the four states a proposal can be in", () => {
    const outcomes = mineRefinementOutcomes([
      call(1),
      created(2, digest("a")),
      created(3, digest("b")),
      rejected(4, digest("b")),
      created(5, digest("c")),
      activated(6, digest("c")),
      created(7, digest("d")),
      activated(8, digest("d")),
      rolledBack(9, digest("d")),
    ]);

    assert.deepEqual(
      outcomes.map((outcome) => [outcome.digest[0], outcome.status, outcome.createdSeq, outcome.settledSeq]),
      [
        ["a", "pending", 2, null],
        ["b", "rejected", 3, 4],
        ["c", "activated", 5, 6],
        ["d", "rolled-back", 7, 9],
      ],
    );
    assert.equal(outcomes[1]!.summary, "confirm deletes need an approval");
    assert.equal(outcomes[1]!.edits.length, 1);
  });

  test("the answer does not depend on the order the records arrive in", () => {
    const chain = [
      created(2, digest("a")),
      rejected(3, digest("a")),
      created(4, digest("b")),
      activated(5, digest("b")),
      rolledBack(6, digest("b")),
    ];
    assert.deepEqual(
      mineRefinementOutcomes([...chain].reverse()),
      mineRefinementOutcomes(chain),
    );
  });

  test("a proposal recorded again after a rejection is pending again, and counted", () => {
    const [outcome] = mineRefinementOutcomes([
      created(2, digest("a")),
      rejected(3, digest("a")),
      created(4, digest("a")),
    ]);
    assert.equal(outcome!.status, "pending");
    assert.equal(outcome!.createdSeq, 4);
    assert.equal(outcome!.settledSeq, null);
    assert.equal(outcome!.timesProposed, 2);
    assert.equal(outcome!.timesRejected, 1);
  });

  test("one outcome per digest, however long the chain around it grows", () => {
    // The loop reads its own records, so the count must be bounded by the
    // proposals the chain holds and by nothing else.
    const chain = [];
    for (let seq = 1; seq <= 300; seq += 3)
      chain.push(created(seq, digest("a")), rejected(seq + 1, digest("a")), call(seq + 2));
    const outcomes = mineRefinementOutcomes(chain);
    assert.equal(outcomes.length, 1);
    assert.equal(outcomes[0]!.timesRejected, 100);
  });

  test("records it cannot read are skipped rather than guessed at", () => {
    const outcomes = mineRefinementOutcomes([
      { seq: 1, body: null },
      { seq: 2, body: "proposal:created" },
      { seq: 3, body: { decision: "proposal:created" } },
      { seq: 4, body: { decision: "proposal:created", harnessProposal: { digest: "short", proposal: proposal() } } },
      { seq: 5, body: { decision: "proposal:rejected", harnessProposal: { digest: digest("z") } } },
      created(6, digest("a")),
    ]);
    assert.deepEqual(outcomes.map((outcome) => outcome.digest), [digest("a")]);
  });
});

describe("repeatsSettledProposal", () => {
  const settled = mineRefinementOutcomes([
    created(2, digest("a")),
    rejected(3, digest("a")),
    created(4, digest("b"), proposal([edit({ title: "rollback me", content: "v1" })])),
    activated(5, digest("b"), proposal([edit({ title: "rollback me", content: "v1" })])),
    rolledBack(6, digest("b")),
    created(7, digest("c"), proposal([edit({ title: "standing", content: "kept" })])),
    activated(8, digest("c"), proposal([edit({ title: "standing", content: "kept" })])),
  ]);

  test("the same edit citing nothing newer than the rejection is a repeat", () => {
    const repeat = repeatsSettledProposal(proposal([edit({ derivedFromSeq: [1, 3] })]), settled);
    assert.equal(repeat?.digest, digest("a"));
    assert.equal(repeat?.status, "rejected");
  });

  test("a reworded reason or summary does not disguise the same edit", () => {
    const repeat = repeatsSettledProposal(
      proposal([edit({ reason: "worded differently this time" })], "another summary"),
      settled,
    );
    assert.equal(repeat?.digest, digest("a"));
  });

  test("the same edit citing a record after the decision is not a repeat", () => {
    assert.equal(repeatsSettledProposal(proposal([edit({ derivedFromSeq: [1, 4] })]), settled), null);
  });

  test("a rolled back refinement is settled the same way a rejected one is", () => {
    const again = proposal([edit({ title: "rollback me", content: "v1", derivedFromSeq: [6] })]);
    assert.equal(repeatsSettledProposal(again, settled)?.status, "rolled-back");
    const newer = proposal([edit({ title: "rollback me", content: "v1", derivedFromSeq: [7] })]);
    assert.equal(repeatsSettledProposal(newer, settled), null);
  });

  test("one edit out of a refused pair is a question nobody was asked", () => {
    const pair = mineRefinementOutcomes([
      created(2, digest("a"), proposal([edit(), edit({ title: "second" })])),
      rejected(3, digest("a")),
    ]);
    assert.equal(repeatsSettledProposal(proposal([edit()]), pair), null);
    assert.equal(
      repeatsSettledProposal(proposal([edit({ title: "second" }), edit()]), pair)?.digest,
      digest("a"),
    );
  });

  test("a different edit, a wider proposal and a standing activation are not repeats", () => {
    assert.equal(repeatsSettledProposal(proposal([edit({ content: "Ask twice." })]), settled), null);
    assert.equal(
      repeatsSettledProposal(proposal([edit(), edit({ title: "something else" })]), settled),
      null,
    );
    assert.equal(
      repeatsSettledProposal(proposal([edit({ title: "standing", content: "kept" })]), settled),
      null,
    );
  });

  test("an empty proposal repeats nothing", () => {
    assert.equal(repeatsSettledProposal(proposal([]), settled), null);
  });
});

describe("formatOutcomesForReview", () => {
  const outcomes = mineRefinementOutcomes([
    created(2, digest("a")),
    rejected(3, digest("a")),
    created(4, digest("b"), proposal([edit({ title: "standing" })], "keep the standing note")),
    activated(5, digest("b"), proposal([edit({ title: "standing" })], "keep the standing note")),
  ]);

  test("nothing to report is an empty string, so the request is unchanged", () => {
    assert.equal(formatOutcomesForReview([]), "");
  });

  test("says what happened, at which sequence, newest first", () => {
    const block = formatOutcomesForReview(outcomes);
    const lines = block.split("\n");
    const standing = lines.findIndex((line) => line.includes("keep the standing note"));
    const refused = lines.findIndex((line) => line.includes("confirm deletes need an approval"));
    assert.ok(standing > 0 && refused > standing, block);
    assert.match(lines[standing]!, /activated at seq 5/);
    assert.match(lines[refused]!, /rejected by an operator at seq 3/);
    assert.match(block, /not an instruction/);
  });

  test("a ceiling drops whole lines and says so, and never overruns", () => {
    const full = formatOutcomesForReview(outcomes);
    const budget = full.length - 10;
    const cut = formatOutcomesForReview(outcomes, budget);
    assert.ok(cut.length <= budget, `${cut.length} > ${budget}`);
    assert.match(cut, /keep the standing note/);
    assert.doesNotMatch(cut, /confirm deletes need an approval/);
    assert.match(cut, /1 of 2/);
  });

  test("a ceiling too small for any line yields nothing rather than a fragment", () => {
    assert.equal(formatOutcomesForReview(outcomes, 40), "");
  });
});

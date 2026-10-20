import test from "node:test";
import assert from "node:assert/strict";
import { proposalEdits } from "./harness-proposals.ts";

/**
 * The operator's view of a harness proposal.
 *
 * The panel shows the proposal the digest covers, so a field that is dropped
 * here is a field the operator never saw and never approved. These pin the
 * fields that carry the decision: what the edit does, what it writes, why it
 * is worth keeping, and which signed records it was derived from.
 */

const memory = {
  action: "create",
  kind: "memory",
  id: "lesson-1",
  title: "approval pattern",
  content: "The operator repeatedly approved the same action.",
  derivedFromSeq: [1, 2],
  reason: "the pattern repeats",
};

test("an edit keeps every field the operator decides on", () => {
  const edits = proposalEdits({ edits: [memory] });
  assert.equal(edits.length, 1);
  assert.equal(edits[0]!.action, "create");
  assert.equal(edits[0]!.kind, "memory");
  assert.equal(edits[0]!.id, "lesson-1");
  assert.equal(edits[0]!.title, "approval pattern");
  assert.equal(edits[0]!.body, "The operator repeatedly approved the same action.");
  assert.equal(edits[0]!.reason, "the pattern repeats");
  assert.equal(edits[0]!.records, "1, 2");
});

test("a prompt edit shows its addendum, not an empty content", () => {
  const edits = proposalEdits({
    edits: [
      {
        action: "create",
        kind: "prompt",
        title: "standing rule",
        promptAddendum: "Never retry a denied call with reworded arguments.",
        derivedFromSeq: [3],
        reason: "the operator asked for it",
      },
    ],
  });
  assert.equal(edits[0]!.prompt, true);
  assert.equal(
    edits[0]!.body,
    "Never retry a denied call with reworded arguments.",
  );
});

test("a proposal with no edits shows nothing rather than a broken entry", () => {
  assert.deepEqual(proposalEdits({ edits: [] }), []);
  assert.deepEqual(proposalEdits(undefined), []);
});

test("an edit with an absent field shows an empty value, never undefined", () => {
  const edits = proposalEdits({ edits: [{ action: "delete", kind: "memory" }] });
  assert.equal(edits[0]!.id, "");
  assert.equal(edits[0]!.body, "");
  assert.equal(edits[0]!.records, "");
});

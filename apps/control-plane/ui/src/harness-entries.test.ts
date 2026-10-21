import test from "node:test";
import assert from "node:assert/strict";
import { harnessEntries, harnessRatchetView } from "./harness-entries.ts";

/**
 * The operator's view of what the harness holds.
 *
 * A mined lesson and an operator-approved one are shown apart, because the
 * difference is the difference between a pattern the harness noticed and a
 * rule a human wrote.
 */
test("an operator-approved entry and a mined one are kept apart", () => {
  const entries = harnessEntries({
    entries: [
      {
        id: "lesson-1",
        kind: "lesson",
        title: "approval pattern",
        content: "the operator approved the same action",
        tool: "postgres.row.update",
        klass: "r2",
        repeats: 3,
        decidedByOperator: true,
        derivedFromSeq: [1, 2],
      },
      {
        id: "lesson-2",
        kind: "lesson",
        title: "drift",
        content: "the same tool is classified two ways",
        tool: "postgres.row.delete",
        klass: "r3",
        repeats: 1,
        decidedByOperator: false,
        derivedFromSeq: [4],
      },
    ],
  });
  assert.equal(entries.length, 2);
  assert.equal(entries[0]!.decidedByOperator, true);
  assert.equal(entries[1]!.decidedByOperator, false);
  assert.equal(entries[0]!.tool, "postgres.row.update");
  assert.deepEqual(entries[0]!.derivedFromSeq, [1, 2]);
});

test("the ratchet view keeps the three guardrails and their measured state", () => {
  const view = harnessRatchetView({
    baselineSeq: 7,
    verdict: "flat",
    caseCount: 2,
    guardrailBreaches: ["rollback_count regressed outside noise"],
    after: {
      metrics: {
        deny_rate: { n: 1, mean: 0.2, half: null, unmeasured: 0 },
        rollback_count: { n: 1, mean: 2, half: null, unmeasured: 0 },
        unknown_tool_rate: { n: 0, mean: null, half: null, unmeasured: 3 },
      },
    },
  });
  assert.ok(view);
  assert.equal(view!.baselineSeq, 7);
  assert.equal(view!.verdict, "flat");
  assert.equal(view!.guardrails.length, 3);
  assert.equal(view!.guardrails[0]!.key, "deny_rate");
  assert.equal(view!.guardrails[0]!.measured, true);
  assert.equal(view!.guardrails[2]!.key, "unknown_tool_rate");
  assert.equal(view!.guardrails[2]!.measured, false);
  assert.equal(view!.guardrails[2]!.unmeasured, 3);
  assert.deepEqual(view!.guardrailBreaches, ["rollback_count regressed outside noise"]);
});

test("an empty ratchet reports no guardrails", () => {
  const view = harnessRatchetView({ empty: true, verdict: "insufficient-data" });
  assert.ok(view);
  assert.equal(view!.empty, true);
  assert.equal(view!.guardrails.length, 0);
});

test("a missing ratchet reports nothing", () => {
  assert.equal(harnessRatchetView(undefined), null);
});

test("a missing field shows an empty value, never undefined", () => {
  const entries = harnessEntries({ entries: [{ id: "lesson-1", kind: "lesson" }] });
  assert.equal(entries[0]!.title, "");
  assert.equal(entries[0]!.content, "");
  assert.equal(entries[0]!.decidedByOperator, false);
  assert.deepEqual(entries[0]!.derivedFromSeq, []);
  assert.equal(entries[0]!.ruleDecision, "");
  assert.equal(entries[0]!.ruleSeconds, 0);
  assert.deepEqual(entries[0]!.policyText, []);
});

test("a mined rule carries the decision it proposes, not only a count", () => {
  const entries = harnessEntries({
    entries: [
      {
        id: "le_rule_1",
        kind: "rule",
        title: "refused this call shape",
        content: "Refused 3 times on the signed ledger. Not written by an operator.",
        tool: "fs.delete",
        klass: "r3",
        repeats: 3,
        derivedFromSeq: [1, 2, 3],
        rule: {
          match: { class: "r3", tool: "fs.delete" },
          decision: "hold",
          seconds: 300,
          notify: ["cli"],
          rationale: "Refused 3 times on the signed ledger. Not written by an operator.",
        },
        policyText: [
          "- match:",
          "    class: r3",
          "    tool: fs.delete",
          "  decision: hold",
        ],
      },
    ],
  });
  assert.equal(entries[0]!.ruleDecision, "hold");
  assert.equal(entries[0]!.ruleSeconds, 300);
  assert.equal(entries[0]!.repeats, 3);
  // The panel is where a browser operator copies the rule from, so the text
  // the terminal prints has to survive this view rather than be flattened
  // into the decision line.
  assert.deepEqual(entries[0]!.policyText, [
    "- match:",
    "    class: r3",
    "    tool: fs.delete",
    "  decision: hold",
  ]);
});

test("no entries show nothing rather than a broken card", () => {
  assert.deepEqual(harnessEntries({}), []);
  assert.deepEqual(harnessEntries(undefined), []);
});

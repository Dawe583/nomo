import test from "node:test";
import assert from "node:assert/strict";

import {
  CLASSIFICATION_DRIFT_MIN_CLASSES,
  HARNESS_KINDS,
  LEARNED_LESSON_MIN_REPEATS,
  mineHarnessEntries,
} from "./learned-harness.ts";
import { LEARNED_RULE_MIN_REPEATS, mineLearnedRules } from "./learned-rules.ts";

/** One ledger entry with the `seq` provenance needs. */
const entry = (seq: number, tool: string, klass: string, decision: string) => ({
  seq,
  body: { tool, klass, decision },
});

/** `count` identical records, seqs ascending from 1. */
const repeat = (count: number, tool: string, klass = "r1", decision = "hold:approved") =>
  Array.from({ length: count }, (_, index) => entry(index + 1, tool, klass, decision));

const AT = "2026-10-07T00:00:00.000Z";
const mine = (chain: readonly unknown[], options = {}) =>
  mineHarnessEntries(chain as never[], { generatedAt: AT, ...options });

test("repeated approvals become a lesson that names its provenance", () => {
  const { entries } = mine(repeat(6, "fs.write"));
  assert.equal(entries.length, 1);
  assert.equal(entries[0].kind, "lesson");
  assert.equal(entries[0].scope, "workspace");
  assert.equal(entries[0].repeats, 6);
  // The whole point of deriving from the chain: a proposal that cannot say
  // which records produced it is a claim, not evidence.
  assert.deepEqual(entries[0].derivedFromSeq, [1, 2, 3, 4, 5, 6]);
});

test("a lesson states the observation and stops before the conclusion", () => {
  const [lesson] = mine(repeat(6, "fs.write")).entries;
  assert.match(lesson.content, /Approved 6 times/);
  // The chain records that a human said yes. It does not record that the call is
  // routine, and a lesson that claimed so would be the harness guessing at the
  // operator's reasoning.
  assert.doesNotMatch(lesson.content, /is safe|is routine|therefore/i);
});

test("a lesson needs more repeats than a rule does", () => {
  // Three is the floor for a rule because a rule changes what an operator is
  // asked to answer. A lesson changes nothing until somebody reads it, so a
  // shape seen twice is not yet a pattern worth a queue somebody has to clear.
  assert.ok(
    LEARNED_LESSON_MIN_REPEATS > LEARNED_RULE_MIN_REPEATS,
    "the stricter threshold belongs to the stricter action",
  );
  assert.equal(LEARNED_RULE_MIN_REPEATS, 3);
  assert.deepEqual(mine(repeat(4, "fs.write")).entries, [], "four approvals is not a pattern");
  assert.equal(mine(repeat(5, "fs.write")).entries.length, 1);
});

test("a hold that expired is not an approval", () => {
  // Nobody answered. Treating a timeout as consent is how an unattended
  // approval happens by accident, so it must not teach the same lesson.
  assert.deepEqual(mine(repeat(9, "fs.write", "r1", "hold:expired")).entries, []);
});

test("a hold that was denied is not an approval", () => {
  assert.deepEqual(mine(repeat(9, "fs.write", "r1", "hold:denied")).entries, []);
});

test("a refusal never becomes a lesson, it becomes a rule", () => {
  // The sibling module owns refusals and can only produce `hold`. Keeping that
  // separate is what stops an operator's explicit refusal from turning into a
  // note somebody reads as permission.
  const mined = mine(repeat(6, "fs.write", "r1", "deny:policy"));
  assert.deepEqual(mined.entries, []);
  assert.equal(mined.rules.length, 1);
  assert.equal(mined.rules[0].decision, "hold");
});

test("execute:unknown is not an approval and not a lesson", () => {
  // "The tool ran and we do not know what happened" is a gap in our knowledge.
  // The sibling declines to teach a rule from it for the same reason this
  // declines to note it: an instrumentation gap is not an operator decision.
  assert.deepEqual(mine(repeat(9, "fs.write", "r1", "execute:unknown")).entries, []);
});

test("a tool seen in two classes is reported as drift", () => {
  // Neither reference harness can produce this finding. `omp` records what the
  // agent did and `prime` records what it changed about itself; neither records
  // the class the registry decided, so an unstable classification is invisible
  // in both. Here it is a first-class finding.
  const chain = [
    entry(1, "fs.write", "r1", "hold:approved"),
    entry(2, "fs.write", "r3", "hold:approved"),
  ];
  const { entries } = mine(chain);
  const drift = entries.find((e) => /classified into more than one class/.test(e.title));
  assert.ok(drift, "an unstable classification must be reported");
  assert.match(drift.content, /more than one reversibility class/);
  assert.deepEqual(drift.derivedFromSeq, [1, 2]);
});

test("drift names the classes without picking one", () => {
  // Choosing would be guessing, and a guess about a reversibility class feeds
  // straight into `decide`. The entry reports the disagreement instead.
  const chain = [
    entry(1, "fs.write", "r1", "hold:approved"),
    entry(2, "fs.write", "r3", "hold:approved"),
  ];
  const drift = mine(chain).entries.find((e) => /classified into more than one class/.test(e.title));
  assert.ok(drift);
  // The majority class is carried only so the entry groups and sorts like any
  // other; the content carries the set.
  assert.equal(drift.klass, "r1");
  assert.doesNotMatch(
    drift.content,
    /\br1\b/,
    "the entry reports the disagreement, it does not resolve it",
  );
});

test("one class per tool is not drift", () => {
  // Nine approvals in a single class is a lesson, not a disagreement.
  const { entries } = mine(repeat(9, "fs.write", "r1"));
  assert.equal(entries.filter((e) => /more than one class/.test(e.title)).length, 0);
});

test("drift is per tool, not per chain", () => {
  // Two tools each in one class is stability. Only a tool that disagrees with
  // itself is a finding, so grouping must not mix tools.
  const chain = [entry(1, "fs.write", "r1", "hold:approved"), entry(2, "fs.delete", "r3", "hold:approved")];
  assert.deepEqual(mine(chain).entries, []);
});

test("drift needs more than one class", () => {
  assert.equal(CLASSIFICATION_DRIFT_MIN_CLASSES, 2);
  assert.equal(mine([entry(1, "fs.write", "r1", "hold:approved")]).entries.length, 0);
  assert.equal(
    mine([entry(1, "fs.write", "r1", "hold:approved"), entry(2, "fs.write", "r3", "hold:approved")])
      .entries.length,
    1,
  );
});

test("the same chain always produces the same entries in the same order", () => {
  const chain = [
    ...repeat(6, "zulu.tool"),
    ...repeat(6, "alpha.tool"),
    entry(20, "zulu.tool", "r3", "hold:approved"),
  ];
  const first = mine(chain);
  const second = mine(chain);
  assert.deepEqual(
    first.entries.map((e) => e.id),
    second.entries.map((e) => e.id),
  );
  assert.deepEqual(
    first.entries.map((e) => e.id),
    [...first.entries.map((e) => e.id)].sort(),
    "ordering cannot depend on insertion order",
  );
});

test("ids are content addressed, so the same observation has the same id", () => {
  // An id built from a clock would make two runs over one chain produce
  // different entries, and the chain could then not be compared against itself.
  const chain = repeat(6, "fs.write");
  assert.deepEqual(
    mine(chain, {}).entries.map((e) => e.id),
    mine(chain, { lessonMinRepeats: LEARNED_LESSON_MIN_REPEATS }).entries.map((e) => e.id),
  );
});

test("entries that are not records are skipped rather than crashing the chain", () => {
  const chain = [
    { seq: 1, body: null },
    { seq: 2, body: [1, 2] },
    { seq: 3, body: 7 },
    ...repeat(5, "fs.write").map((e, i) => ({ ...e, seq: 10 + i })),
  ];
  assert.equal(mine(chain).entries.length, 1);
});

test("a record with no tool or no class cannot be grouped", () => {
  const chain = Array.from({ length: 9 }, (_, i) => ({
    seq: i + 1,
    body: { decision: "hold:approved" },
  }));
  assert.deepEqual(mine(chain).entries, []);
});

test("entries mined without chain positions cite nothing", () => {
  // `seq` is optional in the ledger type, so mining can see calls that carry
  // no chain position. Such an entry teaches, but nothing about it can be
  // traced, and refine-pass refuses an edit whose derivedFromSeq is empty , 
  // so mining has to produce the empty citation rather than invent one.
  const withoutSeq = Array.from({ length: 9 }, () => ({
    body: { tool: "fs.write", klass: "r1", decision: "hold:approved" },
  }));
  const mined = mine(withoutSeq);
  assert.equal(mined.entries.length, 1);
  assert.deepEqual(mined.entries[0].derivedFromSeq, []);
  assert.deepEqual(mine(repeat(6, "fs.write")).entries[0].derivedFromSeq.length > 0, true);
});

test("the threshold is a count, and a useless one is refused", () => {
  assert.throws(() => mineHarnessEntries([], { generatedAt: AT, lessonMinRepeats: 0 }), /positive integer/);
  assert.throws(() => mineHarnessEntries([], { generatedAt: AT, lessonMinRepeats: 1.5 }), /positive integer/);
  assert.throws(() => mineHarnessEntries([], { generatedAt: AT, driftMinClasses: 0 }), /positive integer/);
});

test("a session scope is never produced here", () => {
  // Both lesson kinds are derived from the chain, so both are workspace scope.
  // A session-scoped note is written by a caller, not mined by this module, and
  // inventing one here would give it a lifetime nobody chose.
  const mined = mine(repeat(6, "fs.write"));
  for (const entry of mined.entries) assert.equal(entry.scope, "workspace");
});

test("the two kinds are the two the module declares", () => {
  assert.deepEqual([...HARNESS_KINDS], ["rule", "lesson"]);
  const mined = mine([...repeat(4, "fs.delete", "r3", "deny:policy"), ...repeat(6, "fs.write")]);
  assert.deepEqual(
    [...new Set([...mined.entries.map((e) => e.kind), ...(mined.rules.length ? ["rule"] : [])])].sort(),
    ["lesson", "rule"],
  );
});

test("mining lessons does not disturb the rules the sibling produces", () => {
  const chain = [...repeat(4, "fs.delete", "r3", "deny:policy"), ...repeat(6, "fs.write")];
  assert.deepEqual(mine(chain).rules, mineLearnedRules(chain));
});

test("an empty chain proposes nothing and proves nothing", () => {
  assert.deepEqual(mine([]), { entries: [], rules: [], ruleEntries: [] });
});
test("the rule the operator reads is the rule the miner minted", () => {
  // The operator copies this text into their own policy file, so the entry and
  // the rule cannot be built by two different constructions.
  const mined = mine(repeat(3, "fs.delete", "r3", "deny:policy"));
  assert.equal(mined.ruleEntries.length, 1);
  const [readable] = mined.ruleEntries;
  assert.equal(readable.kind, "rule");
  assert.equal(readable.scope, "workspace");
  assert.equal(readable.tool, "fs.delete");
  assert.equal(readable.klass, "r3");
  assert.equal(readable.repeats, 3);
  assert.deepEqual(readable.derivedFromSeq, [1, 2, 3]);
  assert.deepEqual(readable.rule, mined.rules[0]);
  assert.equal(readable.rule?.decision, "hold");
  assert.match(readable.content, /Not written by an operator/);
});

test("a chain below the threshold produces no rule entry either", () => {
  const mined = mine(repeat(2, "fs.delete", "r3", "deny:policy"));
  assert.deepEqual(mined.rules, []);
  assert.deepEqual(mined.ruleEntries, []);
});

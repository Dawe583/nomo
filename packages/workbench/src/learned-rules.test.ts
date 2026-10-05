import test from "node:test";
import assert from "node:assert/strict";

import { LEARNED_RULE_MIN_REPEATS, mineLearnedRules } from "./learned-rules.ts";

const entry = (tool: string, klass: string, decision: string) => ({
  body: { tool, klass, decision },
});

test("a repeated refusal becomes a hold rule naming the tool and the class", () => {
  const rules = mineLearnedRules([
    entry("void_workspace_delete", "r1", "deny:policy"),
    entry("void_workspace_delete", "r1", "deny:policy"),
    entry("void_workspace_delete", "r1", "hold:denied"),
  ]);
  assert.equal(rules.length, 1);
  assert.deepEqual(rules[0].match, { class: "r1", tool: "void_workspace_delete" });
  // Hold, never deny: an operator who did not ask for this must be able to
  // undo it, and a permanent ban should not come from one observed pattern.
  assert.equal(rules[0].decision, "hold");
  assert.match(rules[0].rationale ?? "", /Refused 3 times/);
});

test("a single refusal teaches nothing", () => {
  assert.deepEqual(
    mineLearnedRules([
      entry("void_workspace_delete", "r1", "deny:policy"),
      entry("void_workspace_write", "r1", "hold:denied"),
    ]),
    [],
  );
});

test("a successful call does not count towards a refusal", () => {
  // The tool the model over-uses will also succeed sometimes. Counting
  // successes would let one denial manufacture a rule from a handful of calls.
  const rules = mineLearnedRules([
    entry("void_workspace_write", "r1", "execute:completed"),
    entry("void_workspace_write", "r1", "execute:completed"),
    entry("void_workspace_write", "r1", "deny:policy"),
    entry("void_workspace_write", "r1", "execute:completed"),
  ]);
  assert.deepEqual(rules, []);
});

test("execute:unknown is not treated as a model mistake", () => {
  // It means "the tool ran and we do not know what happened". That is a gap in
  // our knowledge, and a rule mined from it would turn the gap into a ban.
  assert.deepEqual(
    mineLearnedRules([
      entry("echo", "r3", "execute:unknown"),
      entry("echo", "r3", "execute:unknown"),
      entry("echo", "r3", "execute:unknown"),
      entry("echo", "r3", "execute:unknown"),
    ]),
    [],
  );
});

test("a delegated proxy decision is not attributed to the model", () => {
  assert.deepEqual(
    mineLearnedRules([
      entry("echo", "r3", "proxy"),
      entry("echo", "r3", "proxy"),
      entry("echo", "r3", "proxy"),
    ]),
    [],
  );
});

test("different tools and different classes are separate patterns", () => {
  const rules = mineLearnedRules([
    entry("a", "r1", "deny:policy"),
    entry("a", "r1", "deny:policy"),
    entry("a", "r1", "deny:policy"),
    entry("b", "r1", "deny:policy"),
    entry("b", "r1", "deny:policy"),
    entry("a", "r3", "deny:policy"),
    entry("a", "r3", "deny:policy"),
    entry("a", "r3", "deny:policy"),
  ]);
  assert.equal(rules.length, 2);
  // Sorted by class then tool, so the same chain always yields the same rules.
  assert.deepEqual(rules[0].match, { class: "r1", tool: "a" });
  assert.deepEqual(rules[1].match, { class: "r3", tool: "a" });
});

test("the same chain always produces the same rules in the same order", () => {
  const build = () => [
    entry("z", "r3", "hold:expired"),
    entry("z", "r3", "hold:expired"),
    entry("z", "r3", "hold:expired"),
    entry("a", "r1", "deny:policy"),
    entry("a", "r1", "deny:policy"),
    entry("a", "r1", "deny:policy"),
  ];
  assert.deepEqual(mineLearnedRules(build()), mineLearnedRules(build().reverse()));
});

test("entries that are not records are skipped rather than crashing the chain", () => {
  const rules = mineLearnedRules([
    { body: null },
    { body: "deny:policy" },
    { body: ["deny:policy"] },
    { body: {} },
    { body: { decision: "deny:policy" } },
    { body: { tool: "t", klass: "r1", decision: "deny:policy" } },
    { body: { tool: "t", klass: "r1", decision: "deny:policy" } },
    { body: { tool: "t", klass: "r1", decision: "deny:policy" } },
  ]);
  assert.equal(rules.length, 1);
  assert.deepEqual(rules[0].match, { class: "r1", tool: "t" });
});

test("the threshold is a count, and a useless one is rejected", () => {
  assert.equal(LEARNED_RULE_MIN_REPEATS, 3);
  const chain = [
    entry("t", "r1", "deny:policy"),
    entry("t", "r1", "deny:policy"),
  ];
  assert.deepEqual(mineLearnedRules(chain, 2).length, 1);
  assert.deepEqual(mineLearnedRules(chain, 3), []);
  assert.throws(() => mineLearnedRules(chain, 0), /positive integer/);
  assert.throws(() => mineLearnedRules(chain, 1.5), /positive integer/);
});
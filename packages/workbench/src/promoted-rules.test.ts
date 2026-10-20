/**
 * Promoted rules: the refusals an operator never wrote, mined into a rule
 * the operator has to approve.
 *
 * A promoted rule is evidence, never authority. The five rules that govern
 * a learned rule govern it too: the decision is deny, the rule is appended
 * after the operator's own rules, it is replayable from the chain alone,
 * self-caused refusals do not vote for themselves, and what counts as a
 * failure is an operator denial, not a tool failing.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { minePromotedRules, promotedRuleRationale } from "./learned-rules.ts";
import type { Rule } from "../../policy/src/rules.ts";

const refused = (tool: string, klass: string, count: number) =>
  Array.from({ length: count }, () => ({
    body: { tool, klass, decision: "hold:denied" },
  }));

test("three refusals of the same shape promote a deny rule", () => {
  const rules = minePromotedRules(refused("postgres.row.update", "r2", 3));
  assert.equal(rules.length, 1);
  assert.equal(rules[0]!.match.class, "r2");
  assert.equal(rules[0]!.match.tool, "postgres.row.update");
  assert.equal(rules[0]!.decision, "deny");
  assert.equal(rules[0]!.rationale, promotedRuleRationale(3));
});

test("fewer than three refusals promote nothing", () => {
  assert.deepEqual(minePromotedRules(refused("postgres.row.update", "r2", 2)), []);
  assert.deepEqual(minePromotedRules(refused("postgres.row.update", "r2", 1)), []);
});

test("a tool failing does not teach a promoted rule", () => {
  const entries = Array.from({ length: 3 }, () => ({
    body: { tool: "postgres.row.update", klass: "r2", decision: "execute:failed" },
  }));
  assert.deepEqual(minePromotedRules(entries), []);
});

test("an execute:unknown does not teach a promoted rule", () => {
  const entries = Array.from({ length: 3 }, () => ({
    body: { tool: "postgres.row.update", klass: "r2", decision: "execute:unknown" },
  }));
  assert.deepEqual(minePromotedRules(entries), []);
});

test("a hold the operator let through does not teach a promoted rule", () => {
  const entries = Array.from({ length: 3 }, () => ({
    body: { tool: "postgres.row.update", klass: "r2", decision: "hold:approved" },
  }));
  assert.deepEqual(minePromotedRules(entries), []);
});

test("a self-caused refusal does not vote for itself", () => {
  const entries = [
    ...Array.from({ length: 3 }, () => ({
      body: {
        tool: "postgres.row.update",
        klass: "r2",
        decision: "hold:denied",
        attribution: {
          rule: { rationale: promotedRuleRationale(3) },
        },
      },
    })),
  ];
  assert.deepEqual(minePromotedRules(entries), []);
});

test("two shapes are mined separately and ordered", () => {
  const entries = [
    ...refused("postgres.row.update", "r2", 3),
    ...refused("postgres.row.delete", "r3", 4),
  ];
  const rules = minePromotedRules(entries);
  assert.equal(rules.length, 2);
  assert.equal(rules[0]!.match.class, "r2");
  assert.equal(rules[1]!.match.class, "r3");
});

test("a promoted rule does not carry a seconds or notify field", () => {
  const rules = minePromotedRules(refused("postgres.row.update", "r2", 3));
  assert.equal(rules[0]!.seconds, undefined);
  assert.equal(rules[0]!.notify, undefined);
});

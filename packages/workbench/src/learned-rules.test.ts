import test, { describe } from "node:test";
import { isolatedWorkbench } from "./test-fixture.ts";
import assert from "node:assert/strict";

import {
  LEARNED_RULE_MIN_REPEATS,
  learnedRule,
  learnedRuleGroups,
  learnedRuleRationale,
  mineLearnedRules,
  ruleAsPolicyText,
} from "./learned-rules.ts";
import { decide } from "../../policy/src/decide.ts";
import { loadPolicy } from "../../policy/src/rules.ts";
import { mineHarnessEntries } from "./learned-harness.ts";

const entry = (
  tool: string,
  klass: string,
  decision: string,
  attribution?: unknown,
) => ({
  body: {
    tool,
    klass,
    decision,
    ...(attribution === undefined ? {} : { attribution }),
  },
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

test("a mined rule never overrides the rule an operator wrote", () => {
  // A real policy always ends with the terminal catch-all and `decide` takes
  // the first matching rule. The operator's own allow is reached first; the
  // mined hold is appended behind the catch-all and never runs. The miner is
  // evidence the operator can read, not a rule that binds.
  const loaded = loadPolicy(
    "version: 1\nrules:\n  - match:\n      class: r1\n      tool: void_workspace_delete\n    decision: allow\n    rationale: the operator allows this on purpose\n  - match: {}\n    decision: hold\n    seconds: 30\n",
  );
  if (!loaded.ok)
    throw new Error(`fixture policy failed to load: ${loaded.errors.join("; ")}`);
  const chain = [
    entry("void_workspace_delete", "r1", "deny:policy"),
    entry("void_workspace_delete", "r1", "deny:policy"),
    entry("void_workspace_delete", "r1", "hold:denied"),
  ];
  const mined = mineLearnedRules(chain);
  assert.equal(mined.length, 1);
  const merged = {
    ok: true as const,
    policy: { ...loaded.policy, rules: [...loaded.policy.rules, ...mined] },
  };
  const decision = decide(merged, {
    tool: "void_workspace_delete",
    connector: "workspace",
    workspace: undefined,
    klass: "r1",
    blastRadius: undefined,
    unclassified: false,
  });
  assert.equal(decision.kind, "allow", "the operator's decision stands");
  assert.equal(decision.ruleIndex, 0, "the operator's rule is the one that decides");
});

describe("self-caused refusals are not learned evidence", () => {
  test("a learned rule's own denied holds are not its own evidence", () => {
    // Three independent refusals mint the rule; denials produced by firing
    // that same rule must not inflate its repeat count.
    const base = [
      entry("t", "r1", "deny:policy"),
      entry("t", "r1", "deny:policy"),
      entry("t", "r1", "hold:denied"),
    ];
    const first = mineLearnedRules(base);
    assert.equal(first.length, 1);
    assert.equal(first[0].rationale, learnedRuleRationale(3));
    const selfCaused = [
      entry("t", "r1", "hold:denied", {
        rule: { index: 0, rationale: learnedRuleRationale(3) },
      }),
      entry("t", "r1", "hold:denied", {
        rule: { index: 0, rationale: learnedRuleRationale(3) },
      }),
    ];
    const remined = mineLearnedRules([...base, ...selfCaused]);
    assert.deepEqual(remined, first);
    assert.equal(remined[0].rationale, "Refused 3 times on the signed ledger. Not written by an operator.");
  });

  test("mining is a fixed point under self-feedback", () => {
    let chain = [
      entry("t", "r1", "deny:policy"),
      entry("t", "r1", "deny:policy"),
      entry("t", "r1", "hold:denied"),
    ];
    const first = mineLearnedRules(chain);
    assert.equal(first.length, 1);
    for (let i = 0; i < 3; i++) {
      const mined = mineLearnedRules(chain);
      // Each freshly fired denial carries the mined rule's own rationale back
      // into the chain; the next mining must not move.
      chain = [
        ...chain,
        entry("t", "r1", "hold:denied", {
          rule: { index: 0, rationale: mined[0].rationale },
        }),
      ];
      assert.deepEqual(mineLearnedRules(chain), first);
    }
  });

  test("a refusal without attribution still counts", () => {
    // A body with no attribution at all cannot name a fired learned rule, so
    // it is genuine evidence by construction. Those must keep teaching or a
    // writer that stamps nothing would starve the miner.
    const chain = [
      entry("t", "r1", "hold:expired"),
      entry("t", "r1", "hold:expired"),
      entry("t", "r1", "hold:expired"),
    ];
    const rules = mineLearnedRules(chain);
    assert.equal(rules.length, 1);
    assert.equal(rules[0].rationale, learnedRuleRationale(3));
  });

  test("an imported refusal under an operator rule still counts", () => {
    // The syncStdio proxy import channel spreads the upstream body, which
    // carries operator-policy attribution whose rationale is never the
    // learned template, so imports keep teaching through the same door.
    const chain = [
      entry("t", "r1", "hold:expired", {
        rule: { index: 0, rationale: "operator rule: production writes held" },
      }),
      entry("t", "r1", "hold:expired", {
        rule: { index: 0, rationale: "operator rule: production writes held" },
      }),
      entry("t", "r1", "hold:expired", {
        rule: { index: 0, rationale: "operator rule: production writes held" },
      }),
    ];
    const rules = mineLearnedRules(chain);
    assert.equal(rules.length, 1);
    assert.equal(rules[0].rationale, learnedRuleRationale(3));
  });

  test("an operator rationale that merely quotes the sentence still counts", () => {
    // The matcher is fully anchored, so extra text around the sentence means
    // a human wrote it and the refusal is genuine evidence.
    const quoted = "Operator reviewed: " + learnedRuleRationale(9);
    const chain = [
      entry("t", "r1", "deny:policy"),
      entry("t", "r1", "deny:policy"),
      entry("t", "r1", "hold:denied", {
        rule: { index: 0, rationale: quoted },
      }),
    ];
    const rules = mineLearnedRules(chain);
    assert.equal(rules.length, 1);
    assert.equal(rules[0].rationale, learnedRuleRationale(3));
  });

  test("a group held up only by self-caused refusals never mints", () => {
    const chain = [
      entry("t", "r1", "hold:denied", {
        rule: { index: 0, rationale: learnedRuleRationale(3) },
      }),
      entry("t", "r1", "hold:denied", {
        rule: { index: 0, rationale: learnedRuleRationale(7) },
      }),
      entry("t", "r1", "hold:expired", {
        rule: { index: 0, rationale: learnedRuleRationale(1) },
      }),
    ];
    assert.deepEqual(mineLearnedRules(chain), []);
  });

  test("parity with the harness mining stays exact", () => {
    const chain = [
      entry("t", "r1", "deny:policy"),
      entry("t", "r1", "deny:policy"),
      entry("t", "r1", "hold:denied"),
      entry("t", "r1", "hold:denied", {
        rule: { index: 0, rationale: learnedRuleRationale(3) },
      }),
    ];
    assert.deepEqual(
      mineHarnessEntries(chain, { generatedAt: "2026-10-16T00:00:00.000Z" }).rules,
      mineLearnedRules(chain),
    );
  });
});

test("appended learned rule cannot pass the terminal catch-all", () => {
  // The pinned inertness: the loader requires the terminal catch-all
  // (match: {}) as the last rule, decide is first-match-wins, and
  // policyWithLearned appends mined rules after it. A mined rule matching this
  // exact call still loses to the catch-all. The merge below is built the same
  // way policyWithLearned builds it rather than by calling it, so the test
  // pins the rule shape and the decide outcome, not one private method.
  const loaded = loadPolicy(
    "version: 1\nrules:\n  - match:\n      tool: unrelated.tool\n    decision: deny\n    rationale: operator refuses something else\n  - match: {}\n    decision: allow\n",
  );
  if (!loaded.ok)
    throw new Error(`fixture policy failed to load: ${loaded.errors.join("; ")}`);
  const mined = mineLearnedRules([
    entry("guarded.tool", "r3", "deny:policy"),
    entry("guarded.tool", "r3", "deny:policy"),
    entry("guarded.tool", "r3", "hold:denied"),
  ]);
  assert.equal(mined.length, 1);
  assert.deepEqual(mined[0]?.match, { class: "r3", tool: "guarded.tool" });
  const merged = {
    ok: true as const,
    policy: { ...loaded.policy, rules: [...loaded.policy.rules, ...mined] },
  };
  const decision = decide(merged, {
    tool: "guarded.tool",
    connector: "test",
    workspace: undefined,
    klass: "r3",
    blastRadius: undefined,
    unclassified: false,
  });
  assert.equal(decision.kind, "allow");
  if (decision.kind !== "allow")
    throw new Error("the terminal catch-all must allow this call");
  assert.equal(
    decision.ruleIndex,
    1,
    "the terminal catch-all decides, at its own index",
  );
  assert.notEqual(decision.ruleIndex, 2, "the appended rule never binds");
});
test("the rationale builder and the matcher cannot drift apart", () => {
  // The matcher is private. Derive the same anchored regex from the builder
  // output, replacing only the count, so the test proves the two stay in step
  // without copying the sentence into the test file.
  const template = learnedRuleRationale(0).replace(/\d+/, "\\d+");
  const anchored = new RegExp(`^${template}$`);
  for (const n of [1, 2, 3, 7, 100, 1000000]) {
    assert.match(learnedRuleRationale(n), anchored, `N=${n} must match the matcher`);
    assert.doesNotMatch(
      `${learnedRuleRationale(n)}x`,
      anchored,
      `N=${n} with a trailing character is an operator note, not self-cause`,
    );
  }
  const seed = [1, 2, 3].map(() => entry("t", "r1", "hold:denied"));
  const [rule] = mineLearnedRules(seed);
  assert.ok(rule, "the seed must mint a rule");
  assert.equal(rule.rationale, learnedRuleRationale(3));
});

describe("the group is the one thing both the rule and the entry read", () => {
  test("a group carries the count and the chain sequences behind it", () => {
    const chain = [
      { seq: 4, body: { tool: "t", klass: "r2", decision: "deny:policy" } },
      { seq: 9, body: { tool: "t", klass: "r2", decision: "hold:denied" } },
      { seq: 12, body: { tool: "t", klass: "r2", decision: "hold:expired" } },
    ];
    const groups = learnedRuleGroups(chain);
    assert.equal(groups.length, 1);
    assert.deepEqual(
      { tool: groups[0]!.tool, klass: groups[0]!.klass, repeats: groups[0]!.repeats, seqs: groups[0]!.seqs },
      { tool: "t", klass: "r2", repeats: 3, seqs: [4, 9, 12] },
    );
  });

  test("a group without sequences still counts, and reports none", () => {
    const chain = [
      { body: { tool: "t", klass: "r2", decision: "deny:policy" } },
      { body: { tool: "t", klass: "r2", decision: "deny:policy" } },
      { body: { tool: "t", klass: "r2", decision: "deny:policy" } },
    ];
    assert.deepEqual(learnedRuleGroups(chain)[0]?.seqs, []);
    assert.equal(mineLearnedRules(chain).length, 1, "the rule is still minted");
  });

  test("the rule builder is the one the miner uses", () => {
    const [group] = learnedRuleGroups([
      { body: { tool: "t", klass: "r2", decision: "deny:policy" } },
      { body: { tool: "t", klass: "r2", decision: "deny:policy" } },
      { body: { tool: "t", klass: "r2", decision: "deny:policy" } },
    ]);
    assert.deepEqual(learnedRule(group!), mineLearnedRules([
      { body: { tool: "t", klass: "r2", decision: "deny:policy" } },
      { body: { tool: "t", klass: "r2", decision: "deny:policy" } },
      { body: { tool: "t", klass: "r2", decision: "deny:policy" } },
    ])[0]);
  });
});

test("the rule text is what the operator's loader accepts", () => {
  // The rule is not in force. Printing it is only useful if the operator can
  // paste it into their own file, so the text is loaded by the same loader
  // the runtime uses, ahead of the terminal catch-all it has to sit before.
  // Both surfaces print this text, so this is the one place that proves the
  // rendering matches the grammar.
  const [group] = learnedRuleGroups([
    { body: { tool: "fs.delete", klass: "r3", decision: "deny:policy" } },
    { body: { tool: "fs.delete", klass: "r3", decision: "deny:policy" } },
    { body: { tool: "fs.delete", klass: "r3", decision: "deny:policy" } },
  ]);
  const text = ruleAsPolicyText(learnedRule(group!)).join("\n");
  const loaded = loadPolicy(
    `version: 1\nrules:\n${text}\n- match: {}\n  decision: allow\n`,
  );
  assert.equal(loaded.ok, true, loaded.ok ? "" : loaded.errors.join("; "));
  if (!loaded.ok) return;
  assert.deepEqual(loaded.policy.rules[0]?.match, { class: "r3", tool: "fs.delete" });
  assert.equal(loaded.policy.rules[0]?.decision, "hold");
  assert.equal(loaded.policy.rules[0]?.seconds, 300);
  assert.deepEqual(loaded.policy.rules[0]?.notify, ["cli"]);
});

import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Workbench } from "./index.ts";
import assert from "node:assert/strict";

import { LEARNED_RULE_MIN_REPEATS, mineLearnedRules } from "./learned-rules.ts";

const entry = (tool: string, klass: string, decision: string) => ({
  body: { tool, klass, decision },
});

test("a repeated refusal becomes a hold rule naming the tool and the class", () => {
  const rules = mineLearnedRules([
    entry("nomo_workspace_delete", "r1", "deny:policy"),
    entry("nomo_workspace_delete", "r1", "deny:policy"),
    entry("nomo_workspace_delete", "r1", "hold:denied"),
  ]);
  assert.equal(rules.length, 1);
  assert.deepEqual(rules[0].match, { class: "r1", tool: "nomo_workspace_delete" });
  // Hold, never deny: an operator who did not ask for this must be able to
  // undo it, and a permanent ban should not come from one observed pattern.
  assert.equal(rules[0].decision, "hold");
  assert.match(rules[0].rationale ?? "", /Refused 3 times/);
});

test("a single refusal teaches nothing", () => {
  assert.deepEqual(
    mineLearnedRules([
      entry("nomo_workspace_delete", "r1", "deny:policy"),
      entry("nomo_workspace_write", "r1", "hold:denied"),
    ]),
    [],
  );
});

test("a successful call does not count towards a refusal", () => {
  // The tool the model over-uses will also succeed sometimes. Counting
  // successes would let one denial manufacture a rule from a handful of calls.
  const rules = mineLearnedRules([
    entry("nomo_workspace_write", "r1", "execute:completed"),
    entry("nomo_workspace_write", "r1", "execute:completed"),
    entry("nomo_workspace_write", "r1", "deny:policy"),
    entry("nomo_workspace_write", "r1", "execute:completed"),
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

test("learned rules are appended, so an operator's own rule is still reached first", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "nomo-learned-order-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  // Nothing here reaches a provider — the workbench is only built so its
  // evidence map and policy merge exist to be inspected. Without a fetcher
  // `configure` tries a real endpoint and the test fails on the network
  // instead of on the ordering it exists to prove.
  const fetcher = (async (url: unknown) =>
    String(url).endsWith("/models")
      ? Response.json({ data: [{ id: "fixture" }] })
      : Response.json({ choices: [{ message: { role: "assistant", content: "Done" } }] })) as typeof fetch;
  const app = new Workbench({ NOMO_DATA_DIR: directory }, fetcher);
  await app.configure({ baseUrl: "https://fixture.test/v1", apiKey: "fixture" });
  await app.shutdown();

  const internals = app as unknown as {
    evidence: Record<string, unknown[]>;
    policyWithLearned(policy: unknown, workspace: string): unknown;
  };
  const workspace = "w";
  internals.evidence[workspace] = [
    { body: { tool: "nomo_workspace_delete", klass: "r1", decision: "deny:policy" } },
    { body: { tool: "nomo_workspace_delete", klass: "r1", decision: "deny:policy" } },
    { body: { tool: "nomo_workspace_delete", klass: "r1", decision: "hold:denied" } },
  ];

  // The operator explicitly allows what the chain shows being refused. Were a
  // learned rule placed first, `decide` would hold a call the operator allowed
  // on purpose - a model observation overriding a human decision.
  const operator = {
    ok: true as const,
    policy: {
      version: 1,
      rules: [{ match: { class: "r1", tool: "nomo_workspace_delete" }, decision: "allow" as const }],
    },
  };
  const merged = internals.policyWithLearned(operator, workspace) as {
    ok: true;
    policy: { rules: ReadonlyArray<{ decision: string; rationale?: string }> };
  };
  assert.equal(merged.ok, true);
  assert.equal(merged.policy.rules.length, 2);
  assert.equal(merged.policy.rules[0].decision, "allow", "the operator's rule must come first");
  assert.equal(merged.policy.rules[1].decision, "hold", "the learned rule fills the gap behind it");
  assert.match(merged.policy.rules[1].rationale ?? "", /Not written by an operator/);
  assert.equal(operator.policy.rules.length, 1, "the operator's policy must not be mutated");
});
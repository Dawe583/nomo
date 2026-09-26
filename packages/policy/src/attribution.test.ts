import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { loadPolicy } from "./rules.ts";
import { decide, type PolicyCall } from "./decide.ts";
import { policyDigest } from "./digest.ts";
import { canonicalDigest } from "../../ledger/src/sign.ts";

const call = (over: Partial<PolicyCall> = {}): PolicyCall => ({
  tool: "aws.s3.object.delete",
  connector: "s3",
  workspace: "prod",
  klass: "r0",
  blastRadius: 1,
  ...over,
});

const loaded = loadPolicy(`
version: 1
rules:
  - match: { class: r0 }
    decision: allow
    rationale: reads are reversible
  - match: { tool: postgres.table.drop }
    decision: deny
    rationale: destructive schema change
  - match: {}
    decision: hold
    seconds: 60
`);
if (!loaded.ok) throw new Error("fixture policy must load");

test("an allow names the rule that authorized it, because an authorization is the record that needs one", () => {
  const decision = decide(loaded, call({ klass: "r0" }));
  assert.equal(decision.kind, "allow");
  assert.equal(decision.kind === "allow" ? decision.ruleIndex : null, 0);
  assert.equal(decision.kind === "allow" ? decision.rationale : null, "reads are reversible");
});

test("the unknown opt-in allow path names its rule too", () => {
  const explicit = loadPolicy(`
version: 1
rules:
  - match: { class: unknown }
    decision: allow
    rationale: operator opted in
  - match: {}
    decision: deny
`);
  if (!explicit.ok) throw new Error("fixture must load");
  const decision = decide(explicit, call({ klass: "r3", unclassified: true }));
  assert.equal(decision.kind, "allow");
  assert.equal(decision.kind === "allow" ? decision.ruleIndex : null, 0);
});

test("an allow whose rule states no rationale says so rather than inventing one", () => {
  const terse = loadPolicy(`
version: 1
rules:
  - match: { class: r0 }
    decision: allow
  - match: {}
    decision: deny
`);
  if (!terse.ok) throw new Error("fixture must load");
  const decision = decide(terse, call({ klass: "r0" }));
  assert.equal(decision.kind === "allow" ? decision.ruleIndex : null, 0);
  assert.equal(decision.kind === "allow" && "rationale" in decision, true);
  assert.equal(decision.kind === "allow" ? decision.rationale : "x", undefined);
});

test("the policy digest is over the content, not the file bytes", () => {
  const spaced = loadPolicy(`
version: 1
rules:

  - match: { class: r0 }
    decision: allow
    rationale: reads are reversible
  - match: { tool: postgres.table.drop }
    decision: deny
    rationale: destructive schema change
  - match: {}
    decision: hold
    seconds: 60
`);
  if (!spaced.ok) throw new Error("fixture must load");
  // A third party who obtains the operator's policy file must arrive at the
  // same value, so formatting and comment style cannot decide whether a
  // record is attributable.
  assert.equal(policyDigest(spaced.policy), policyDigest(loaded.policy));
  assert.equal(policyDigest(loaded.policy), canonicalDigest(loaded.policy));
  assert.match(policyDigest(loaded.policy), /^[0-9a-f]{64}$/);
});

test("a policy that changes only its declared version is a different policy", () => {
  // The format constant is part of the content, and that is the point: a
  // record must not survive a policy that changed what it claims to be.
  const bumped = { ...loaded.policy, version: 2 };
  assert.notEqual(policyDigest(bumped), policyDigest(loaded.policy));
});

test("changing one rationale changes the digest", () => {
  const edited = {
    ...loaded.policy,
    rules: loaded.policy.rules.map((rule, index) =>
      index === 1 ? { ...rule, rationale: "fine actually" } : rule,
    ),
  };
  assert.notEqual(policyDigest(edited), policyDigest(loaded.policy));
});

test("the shipped default policy is digestible and stable across reloads", () => {
  const text = readFileSync(new URL("../../../policy/default.yaml", import.meta.url), "utf8");
  const first = loadPolicy(text);
  const second = loadPolicy(text);
  if (!first.ok || !second.ok) throw new Error("the shipped policy must load");
  assert.equal(policyDigest(first.policy), policyDigest(second.policy));
});

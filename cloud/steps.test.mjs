import test from "node:test";
import assert from "node:assert/strict";
import { loadPolicy } from "../packages/policy/src/rules.ts";
import { CLOUD_POLICY, cloudToolDecision, holdTokenMatches, mintHoldToken } from "./steps.mjs";
import { workspaceToolClass } from "../packages/workbench/src/workspace.ts";

const policy = loadPolicy(CLOUD_POLICY);
assert.ok(policy.ok, "the shipped cloud policy must parse");

/** Mirrors how `advance` builds a built-in call: workspace tools are classified
 * by name, not by the external-tool classifier. */
const builtinCall = (name) => {
  const tone = workspaceToolClass(name);
  assert.ok(tone, `${name} must have a workspace class`);
  return {
    classification: { outcome: "classified", tone },
    callInfo: {
      tool: name,
      connector: "workspace",
      workspace: "agent-fixture",
      klass: tone,
      blastRadius: undefined,
      arguments: { path: "check.txt", content: "x" },
    },
  };
};

test("a built-in managed document write is held for human approval, not allowed", () => {
  for (const name of ["void_workspace_write", "void_workspace_delete"]) {
    const { classification, callInfo } = builtinCall(name);
    assert.equal(classification.tone, "r1", `${name} must classify as r1`);
    const decision = cloudToolDecision(policy, classification, callInfo);
    assert.equal(
      decision.kind,
      "hold",
      `${name} must wait for a human, not run without approval`,
    );
    assert.ok(decision.seconds > 0, "a hold must expire so it cannot strand a session");
  }
});

test("a built-in managed document read stays allowed", () => {
  for (const name of ["void_workspace_read", "void_workspace_list"]) {
    const { classification, callInfo } = builtinCall(name);
    const decision = cloudToolDecision(policy, classification, callInfo);
    assert.equal(decision.kind, "allow", `${name} is r0 and must not be held`);
  }
});

test("an unclassified or unknown tool is denied outright", () => {
  const callInfo = { tool: "mystery.tool", workspace: "agent-fixture", klass: "r3", arguments: {} };
  assert.deepEqual(
    cloudToolDecision(policy, { outcome: "unknown" }, callInfo),
    { kind: "deny" },
  );
});

test("the cloud policy still holds every non-r0 class", () => {
  // Guards the policy text itself: relaxing it to allow r1 would silently reopen
  // the same hole from the other direction.
  for (const klass of ["r1", "r2", "r3"]) {
    const decision = cloudToolDecision(
      policy,
      { outcome: "classified", tone: klass },
      { tool: "x", workspace: "agent-fixture", klass, arguments: {} },
    );
    assert.equal(decision.kind, "hold", `class ${klass} must be held`);
  }
});

test("a cloud hold carries a possession factor the deterministic identifier cannot supply", () => {
  // The hold identifier is `${session}-${generation}-${turn}-${queue.length}`,
 // every component of which is readable through the API. The token is the only
  // unguessable part, so it has to be random, unique and unforgeable.
  const tokens = new Set();
  for (let index = 0; index < 1000; index += 1) {
    const token = mintHoldToken();
    assert.match(token, /^[A-Za-z0-9_-]{32}$/, "24 random bytes base64url is 32 characters");
    assert.equal(tokens.has(token), false, "two holds must never share a token");
    tokens.add(token);
  }

  const record = { decisionToken: mintHoldToken() };
  assert.equal(holdTokenMatches(record, record.decisionToken), true);
  for (const presented of [undefined, null, "", "wrong-token-value-that-is-long-enough-to-compare", record.decisionToken.slice(0, -1), record.decisionToken + "x", record.decisionToken.toUpperCase()]) {
    assert.equal(holdTokenMatches(record, presented), false, `must refuse ${String(presented)}`);
  }
  // A record with no token at all is refused rather than waved through, so a
  // hold written before this field existed cannot be decided without review.
  assert.equal(holdTokenMatches({}, record.decisionToken), false);
  assert.equal(holdTokenMatches(undefined, record.decisionToken), false);
});

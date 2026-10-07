import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { loadPolicy } from "../../policy/src/rules.ts";
import { classifyTool } from "../../registry/src/evaluate.ts";
import { loadAgentPolicy } from "./load.ts";
import {
  checkPolicy,
  type CheckDeps,
  type PolicyCheckRequest,
} from "./check.ts";
import {
  revocationView,
  type RevocationRecord,
  type TokenClaims,
} from "./revocations.ts";

const agentsYaml = readFileSync(
  new URL("../../../policy/agents.yaml", import.meta.url),
  "utf8",
);
const voidDefaultYaml = readFileSync(
  new URL("../../../policy/default.yaml", import.meta.url),
  "utf8",
);

/**
 * A class policy for the demo: VOID semantics, but reads the registry cannot
 * classify are allowed, so the identity layer is what decides them. The real
 * default.yaml holds them, and one test below shows that interaction.
 */
const demoClassYaml = `
version: 1
rules:
  - match: { tool: postgres.table.drop }
    decision: deny
    rationale: schema drops never recover from a rollback
  - match: { class: unknown, tool: [notes.read] }
    decision: allow
    rationale: reads change nothing
  - match: { class: r0 }
    decision: allow
    rationale: fully reversible
  - match: { class: [r2, r3] }
    decision: hold
    seconds: 60
    rationale: a human looks first
  - match: {}
    decision: deny
`;

const NOW = new Date("2026-10-07T18:00:00.000Z");
const nowSeconds = Math.floor(NOW.getTime() / 1000);

const request = (
  over: Partial<PolicyCheckRequest> = {},
): PolicyCheckRequest => ({
  contract: "nomo.policy-check.v0",
  requestId: "req-1",
  agent: { id: "demo-support-bot" },
  tool: "fs.file.write",
  connector: "fs",
  args: { path: "drafts/reply.md" },
  target: "fs:sandbox/drafts/reply.md",
  scope: "write",
  workspace: "demo",
  ...over,
});

const deps = (
  over: Partial<CheckDeps> & {
    facts?: Record<string, string>;
    tool?: string;
    revocationRecords?: RevocationRecord[];
  } = {},
): CheckDeps => {
  const { facts = {}, tool, revocationRecords = [], ...rest } = over;
  return {
    agentPolicy: loadAgentPolicy(agentsYaml),
    classPolicy: loadPolicy(demoClassYaml),
    classify: () => classifyTool(tool ?? "fs.file.write", { facts, args: {} }),
    revocations: revocationView(revocationRecords),
    now: () => NOW,
    requireToken: false,
    ...rest,
  };
};

const shadowCaptured = { "fs.shadow.captured": "true" };

describe("checkPolicy: allow, deny, hold", () => {
  test("allow: the support bot writes a reversible draft", () => {
    const result = checkPolicy(request(), deps({ facts: shadowCaptured }));
    assert.equal(result.decision, "allow");
    assert.equal(result.class, "r0");
    assert.equal(result.ruleId, "support-bot-writes-drafts");
    assert.equal(result.layer, "agent-policy");
    assert.deepEqual(
      result.trace.map((s) => [s.layer, s.decision, s.ruleId]),
      [
        ["kill-switch", "allow", "nomo:kill-switch"],
        ["agent-policy", "allow", "support-bot-writes-drafts"],
        ["class-policy", "allow", "void:rule[2]"],
      ],
    );
    assert.match(result.agentPolicyDigest ?? "", /^[0-9a-f]{64}$/);
    assert.match(result.classPolicyDigest ?? "", /^[0-9a-f]{64}$/);
  });

  test("deny: the same write outside the drafts folder is not granted", () => {
    const result = checkPolicy(
      request({ target: "fs:sandbox/notes/secret.md" }),
      deps({ facts: shadowCaptured }),
    );
    assert.equal(result.decision, "deny");
    assert.equal(result.ruleId, "default-deny");
    assert.equal(result.layer, "agent-policy");
    assert.match(result.reason, /no rule grants this agent this action/);
  });

  test("deny: another agent may not do what the support bot may", () => {
    const result = checkPolicy(
      request({ agent: { id: "demo-report-bot" } }),
      deps({ facts: shadowCaptured }),
    );
    assert.equal(result.decision, "deny");
    assert.equal(result.ruleId, "default-deny");
  });

  test("deny: the agent grant does not cover an irreversible write", () => {
    // No shadow copy: the registry says r3, the drafts rule only covers r0/r1.
    const result = checkPolicy(request(), deps());
    assert.equal(result.class, "r3");
    assert.equal(result.decision, "deny");
    assert.equal(result.ruleId, "default-deny");
  });

  test("hold: a delete waits for a person even when VOID would allow it", () => {
    const result = checkPolicy(
      request({
        tool: "fs.path.remove_recursive",
        scope: "delete",
        target: "fs:sandbox/drafts/old/",
      }),
      deps({
        tool: "fs.path.remove_recursive",
        facts: { "fs.tree.git_clean": "true" },
      }),
    );
    assert.equal(result.class, "r0");
    assert.equal(result.decision, "hold");
    assert.equal(result.holdSeconds, 120);
    assert.equal(result.ruleId, "support-bot-deletes-need-a-human");
  });

  test("hold: when both layers hold, the shorter timer wins", () => {
    const result = checkPolicy(
      request({
        tool: "fs.path.remove_recursive",
        scope: "delete",
        target: "fs:sandbox/drafts/old/",
      }),
      deps({ tool: "fs.path.remove_recursive" }),
    );
    assert.equal(result.class, "r3");
    assert.equal(result.decision, "hold");
    assert.equal(result.holdSeconds, 60);
    assert.equal(result.ruleId, "support-bot-deletes-need-a-human");
  });

  test("the class policy can still deny what the agent policy allows", () => {
    const agents = loadAgentPolicy(`
version: 1
agents:
  - id: dba-bot
rules:
  - id: dba-everything
    match: { agent: dba-bot }
    decision: allow
  - id: default-deny
    match: {}
    decision: deny
`);
    const result = checkPolicy(
      request({
        agent: { id: "dba-bot" },
        tool: "postgres.table.drop",
        connector: "postgres",
        target: "postgres:demo/public.orders",
        scope: "admin",
      }),
      deps({ agentPolicy: agents, tool: "postgres.table.drop" }),
    );
    assert.equal(result.decision, "deny");
    assert.equal(result.layer, "class-policy");
    assert.equal(result.ruleId, "void:rule[0]");
  });
});

describe("checkPolicy: unknown tools and agents", () => {
  test("an unknown tool is class unknown and a broad allow does not cover it", () => {
    const result = checkPolicy(
      request({ tool: "fs.file.shred", target: "fs:sandbox/drafts/x" }),
      deps({ tool: "fs.file.shred" }),
    );
    assert.equal(result.class, "unknown");
    assert.equal(result.decision, "deny");
    assert.equal(result.ruleId, "default-deny");
  });

  test("an allow that names only real classes, or no class, never covers an unknown tool", () => {
    const agents = loadAgentPolicy(`
version: 1
agents:
  - id: wide-bot
rules:
  - id: wide-by-class
    match: { agent: wide-bot, class: [r0, r1, r2, r3] }
    decision: allow
  - id: wide-no-class
    match: { agent: wide-bot }
    decision: allow
  - id: default-deny
    match: {}
    decision: deny
`);
    const result = checkPolicy(
      request({ agent: { id: "wide-bot" }, tool: "fs.file.shred" }),
      deps({ agentPolicy: agents, tool: "fs.file.shred" }),
    );
    assert.equal(result.class, "unknown");
    assert.equal(result.decision, "deny");
    assert.equal(result.ruleId, "default-deny");
  });

  test("a deny or hold that names r3 does cover an unknown tool", () => {
    const agents = loadAgentPolicy(`
version: 1
agents:
  - id: wide-bot
rules:
  - id: hold-worst
    match: { agent: wide-bot, class: r3 }
    decision: hold
    seconds: 30
  - id: default-deny
    match: {}
    decision: deny
`);
    const result = checkPolicy(
      request({ agent: { id: "wide-bot" }, tool: "notes.read", scope: "read" }),
      deps({ agentPolicy: agents, tool: "notes.read" }),
    );
    assert.equal(result.decision, "hold");
    assert.equal(result.ruleId, "hold-worst");
    assert.equal(result.holdSeconds, 30);
  });

  test("an unknown tool is allowed only by a rule that names class unknown", () => {
    const result = checkPolicy(
      request({
        tool: "notes.read",
        scope: "read",
        target: "fs:sandbox/notes/faq.md",
      }),
      deps({ tool: "notes.read" }),
    );
    assert.equal(result.class, "unknown");
    assert.equal(result.decision, "allow");
    assert.equal(result.ruleId, "support-bot-reads-notes");
  });

  test("with VOID's shipped default policy the same read is held by the class layer", () => {
    const result = checkPolicy(
      request({
        tool: "notes.read",
        scope: "read",
        target: "fs:sandbox/notes/faq.md",
      }),
      deps({ tool: "notes.read", classPolicy: loadPolicy(voidDefaultYaml) }),
    );
    assert.equal(result.decision, "hold");
    assert.equal(result.layer, "class-policy");
    assert.equal(result.ruleId, "void:rule[3]");
  });

  test("an undeclared agent is denied before any rule is read", () => {
    const result = checkPolicy(request({ agent: { id: "stranger" } }), deps());
    assert.equal(result.decision, "deny");
    assert.equal(result.ruleId, "nomo:unknown-agent");
  });
});

describe("checkPolicy: broken input fails closed", () => {
  test("a broken agent policy denies every call", () => {
    const result = checkPolicy(
      request(),
      deps({
        agentPolicy: loadAgentPolicy("version: 1\nagents: []\nrules: []\n"),
      }),
    );
    assert.equal(result.decision, "deny");
    assert.equal(result.ruleId, "nomo:engine-error");
    assert.match(result.reason, /agent policy is invalid/);
  });

  test("a broken class policy denies every call", () => {
    const result = checkPolicy(
      request(),
      deps({ classPolicy: loadPolicy("version: 1\nrules: [\n") }),
    );
    assert.equal(result.decision, "deny");
    assert.equal(result.ruleId, "nomo:engine-error");
    assert.match(result.reason, /class policy is invalid/);
  });

  test("a throwing classifier is an engine error, not a crash", () => {
    const result = checkPolicy(
      request(),
      deps({
        classify: () => {
          throw new Error("registry exploded");
        },
      }),
    );
    assert.equal(result.decision, "deny");
    assert.equal(result.ruleId, "nomo:engine-error");
    assert.doesNotMatch(result.reason, /exploded/);
  });

  test("a target that walks out of its prefix is refused", () => {
    const result = checkPolicy(
      request({ target: "fs:sandbox/drafts/../notes/secret.md" }),
      deps({ facts: shadowCaptured }),
    );
    assert.equal(result.decision, "deny");
    assert.equal(result.ruleId, "nomo:invalid-request");
  });

  test("an unknown scope is refused", () => {
    const result = checkPolicy(
      request({ scope: "root" as never }),
      deps({ facts: shadowCaptured }),
    );
    assert.equal(result.decision, "deny");
    assert.equal(result.ruleId, "nomo:invalid-request");
  });

  test("the same input gives the same result", () => {
    const a = checkPolicy(request(), deps({ facts: shadowCaptured }));
    const b = checkPolicy(request(), deps({ facts: shadowCaptured }));
    assert.deepEqual(a, b);
  });
});

describe("checkPolicy: kill-switch and tokens", () => {
  const kill = (at: string): RevocationRecord => ({
    kind: "kill",
    agentId: "demo-support-bot",
    at,
    by: "oliver",
    reason: "demo",
  });
  const reinstate = (at: string): RevocationRecord => ({
    kind: "reinstate",
    agentId: "demo-support-bot",
    at,
    by: "oliver",
    reason: "demo over",
  });
  const token = (over: Partial<TokenClaims> = {}): TokenClaims => ({
    jti: "tok-1",
    agentId: "demo-support-bot",
    tool: "fs.file.write",
    target: "fs:sandbox/drafts/reply.md",
    scope: "write",
    workspace: "demo",
    iat: nowSeconds - 10,
    exp: nowSeconds + 50,
    agentPolicyDigest: "0".repeat(64),
    ...over,
  });

  test("a killed agent is denied even with a valid token for an allowed call", () => {
    const result = checkPolicy(
      request({ token: token() }),
      deps({
        facts: shadowCaptured,
        requireToken: true,
        revocationRecords: [kill("2026-10-07T17:59:55.000Z")],
      }),
    );
    assert.equal(result.decision, "deny");
    assert.equal(result.layer, "kill-switch");
    assert.equal(result.ruleId, "nomo:kill-switch");
  });

  test("after a reinstate the agent works again, but its old token stays dead", () => {
    const records = [
      kill("2026-10-07T17:59:55.000Z"),
      reinstate("2026-10-07T17:59:58.000Z"),
    ];
    const old = checkPolicy(
      request({ token: token() }),
      deps({
        facts: shadowCaptured,
        requireToken: true,
        revocationRecords: records,
      }),
    );
    assert.equal(old.decision, "deny");
    assert.equal(old.ruleId, "nomo:token-revoked");

    const fresh = checkPolicy(
      request({
        token: token({
          jti: "tok-2",
          iat: nowSeconds - 1,
          exp: nowSeconds + 59,
        }),
      }),
      deps({
        facts: shadowCaptured,
        requireToken: true,
        revocationRecords: records,
      }),
    );
    assert.equal(fresh.decision, "allow");
  });

  test("a kill of another agent changes nothing for this one", () => {
    const result = checkPolicy(
      request({ token: token() }),
      deps({
        facts: shadowCaptured,
        requireToken: true,
        revocationRecords: [
          { ...kill("2026-10-07T17:59:55.000Z"), agentId: "demo-report-bot" },
        ],
      }),
    );
    assert.equal(result.decision, "allow");
  });

  test("at call time a token is required", () => {
    const result = checkPolicy(
      request(),
      deps({ facts: shadowCaptured, requireToken: true }),
    );
    assert.equal(result.decision, "deny");
    assert.equal(result.ruleId, "nomo:token-missing");
  });

  test("an expired token is refused", () => {
    const result = checkPolicy(
      request({ token: token({ iat: nowSeconds - 61, exp: nowSeconds - 1 }) }),
      deps({ facts: shadowCaptured, requireToken: true }),
    );
    assert.equal(result.ruleId, "nomo:token-expired");
  });

  test("a token longer than 60 seconds is refused", () => {
    const result = checkPolicy(
      request({
        token: token({ iat: nowSeconds - 1, exp: nowSeconds + 3600 }),
      }),
      deps({ facts: shadowCaptured, requireToken: true }),
    );
    assert.equal(result.ruleId, "nomo:token-expired");
  });

  test("a token for another target is refused", () => {
    const result = checkPolicy(
      request({ token: token({ target: "fs:sandbox/drafts/other.md" }) }),
      deps({ facts: shadowCaptured, requireToken: true }),
    );
    assert.equal(result.decision, "deny");
    assert.equal(result.ruleId, "nomo:token-mismatch");
    assert.match(result.reason, /target/);
  });
});

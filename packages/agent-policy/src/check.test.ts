import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { loadPolicy } from "../../policy/src/rules.ts";
import { classifyTool } from "../../registry/src/evaluate.ts";
import { loadAgentPolicy } from "./load.ts";
import {
  checkPolicy,
  type CheckDeps,
  type GrantedIdentity,
  type PolicyCheckRequest,
} from "./check.ts";

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

/** Every tool these tests call, so the grant gate passes unless a test narrows it. */
const ALL_TOOLS = [
  "fs.file.delete",
  "fs.file.shred",
  "fs.file.write",
  "fs.path.remove_recursive",
  "notes.read",
  "postgres.table.drop",
];

/** What `LocalAgentIdentityIssuer.validate` hands over for a verified grant. */
const grant = (
  agentId = "demo-support-bot",
  over: Partial<GrantedIdentity> = {},
): GrantedIdentity => ({
  agentId,
  runId: "run-1",
  workspaceId: "demo",
  toolScope: ALL_TOOLS,
  ...over,
});

/** `agent` is shorthand for a grant to that agent; the request itself carries no agent id. */
const request = (
  over: Partial<PolicyCheckRequest> & { agent?: { id: string } } = {},
): PolicyCheckRequest => {
  const { agent, ...rest } = over;
  return {
    contract: "nomo.policy-check.v0",
    requestId: "req-1",
    identity: grant(agent?.id),
    tool: "fs.file.write",
    connector: "fs",
    args: { path: "drafts/reply.md" },
    target: "fs:sandbox/drafts/reply.md",
    scope: "write",
    ...rest,
  };
};

const deps = (
  over: Partial<CheckDeps> & {
    facts?: Record<string, string>;
    tool?: string;
  } = {},
): CheckDeps => {
  const { facts = {}, tool, ...rest } = over;
  return {
    agentPolicy: loadAgentPolicy(agentsYaml),
    classPolicy: loadPolicy(demoClassYaml),
    classify: () => classifyTool(tool ?? "fs.file.write", { facts, args: {} }),
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
        ["grant", "allow", "nomo:grant-valid"],
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

describe("checkPolicy: the Workbench grant decides who is asking", () => {
  test("no grant, or an expired or revoked one, is a deny before any rule", () => {
    const result = checkPolicy(
      request({ identity: null }),
      deps({ facts: shadowCaptured }),
    );
    assert.equal(result.decision, "deny");
    assert.equal(result.layer, "grant");
    assert.equal(result.ruleId, "nomo:no-grant");
    assert.deepEqual(result.trace, [
      { layer: "grant", decision: "deny", ruleId: "nomo:no-grant" },
    ]);
  });

  test("a tool outside the grant is denied even when agents.yaml allows it", () => {
    const result = checkPolicy(
      request({
        identity: grant("demo-support-bot", { toolScope: ["notes.read"] }),
      }),
      deps({ facts: shadowCaptured }),
    );
    assert.equal(result.decision, "deny");
    assert.equal(result.ruleId, "nomo:outside-grant");
    assert.match(result.reason, /run-1/);
  });

  test("the agent is whoever the grant names: the same call as the report bot is denied", () => {
    const asSupport = checkPolicy(request(), deps({ facts: shadowCaptured }));
    const asReport = checkPolicy(
      request({ identity: grant("demo-report-bot") }),
      deps({ facts: shadowCaptured }),
    );
    assert.equal(asSupport.decision, "allow");
    assert.equal(asReport.decision, "deny");
    assert.equal(asReport.ruleId, "default-deny");
  });

  test("the workspace comes from the grant", () => {
    const yaml = agentsYaml.replace(
      "      scope: write\n      class: [r0, r1]\n",
      "      scope: write\n      class: [r0, r1]\n      workspace: demo\n",
    );
    assert.notEqual(yaml, agentsYaml);
    const policy = loadAgentPolicy(yaml);
    const inDemo = checkPolicy(
      request(),
      deps({ facts: shadowCaptured, agentPolicy: policy }),
    );
    const elsewhere = checkPolicy(
      request({ identity: grant("demo-support-bot", { workspaceId: "prod" }) }),
      deps({ facts: shadowCaptured, agentPolicy: policy }),
    );
    assert.equal(inDemo.decision, "allow");
    assert.equal(elsewhere.decision, "deny");
  });

  test("a grant whose agent id the policy cannot hold, or a malformed one, is refused", () => {
    for (const identity of [
      grant("Workbench Agent"),
      grant("demo-support-bot", { runId: "" }),
      grant("demo-support-bot", { workspaceId: "" }),
      { ...grant(), toolScope: "fs.file.write" } as unknown as GrantedIdentity,
      "demo-support-bot" as unknown as GrantedIdentity,
    ]) {
      const result = checkPolicy(
        request({ identity }),
        deps({ facts: shadowCaptured }),
      );
      assert.equal(result.decision, "deny");
      assert.equal(result.ruleId, "nomo:no-grant");
    }
  });
});

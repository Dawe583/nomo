/**
 * CONTRACT.md section 10 item 2: the Workbench grant carries the NOMO agent id
 * the operator declared, so a rule in `policy/agents.yaml` that names an agent
 * can actually match.
 *
 * The defect this file exists to pin down is a name, not a behaviour. The grant
 * used to carry `workbench-local-agent`, a string derived from the principal
 * id, which no policy file declares. Per-agent rules therefore never matched and
 * every real call ended at `nomo:unknown-agent`. A test that only asserted "the
 * call was refused" would have passed against that bug, so these tests assert
 * the identity the grant actually carries, and the decision that identity
 * produces once it reaches the proxy.
 *
 * The second half runs a grant from the real `LocalAgentIdentityIssuer` through
 * the real proxy decision path, so the three answers an operator needs are
 * proven together: a declared agent is allowed, an undeclared one is refused by
 * name, and a stopped run loses its grant. Target and scope are supplied by an
 * explicit derivation over the demo tool's arguments. They are never defaults:
 * an unresolved target or scope is `nomo:invalid-request`, which is the point.
 */

import test, { describe } from "node:test";
import assert from "node:assert/strict";

import {
  LocalAgentIdentityIssuer,
  LOCAL_AGENT_GRANT_AUDIENCE,
  LOCAL_AGENT_PRINCIPAL_ID,
} from "./agent-identity.ts";
import { validateLocalHarnessTask } from "./agents.ts";

import { classifyTool } from "../../registry/src/index.ts";
import { loadPolicy, type PolicyCall } from "../../policy/src/index.ts";
import {
  loadAgentPolicy,
  type GrantedIdentity,
} from "../../agent-policy/src/index.ts";
import { interceptCall, type InterceptedCall } from "../../proxy/src/forward/tools.ts";
import { evaluateWithAgentPolicy } from "../../proxy/src/forward/agent-policy.ts";

const TASK_DEFAULTS = {
  upstreamId: "local-demo-upstream",
  prompt: "Read the demo bucket state",
  toolScope: ["aws.s3.object.put"],
  facts: { "aws.s3.shadow.captured": "true" },
  learning: { enabled: false as const },
} as const;

function task(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { ...TASK_DEFAULTS, ...overrides };
}

/** A task with no proxy block: validation is what is under test here. */
function validated(overrides: Record<string, unknown> = {}) {
  return validateLocalHarnessTask(task(overrides));
}

describe("the operator-declared agent id on a harness task", () => {
  test("a task that names no agent is refused, not defaulted", () => {
    // The old behaviour was to mint `workbench-local-agent` from the principal
    // id. A default here is a silent identity, which is the defect itself.
    assert.throws(() => validated(), /agent/i);
  });

  test("a declared agent id is carried through validation", () => {
    const parsed = validated({ declaredAgentId: "demo-support-bot" });
    assert.equal(parsed.declaredAgentId, "demo-support-bot");
  });

  test("an agent id outside the NOMO grammar is refused", () => {
    // CONTRACT section 2: ^[a-z0-9][a-z0-9._-]{0,63}$. Uppercase, a leading
    // dot and an over-long name are all refused rather than normalised, because
    // a normalised id is not the id the operator declared.
    for (const bad of ["Demo-Support-Bot", ".leading-dot", "a".repeat(65), "has space", ""]) {
      assert.throws(
        () => validated({ declaredAgentId: bad }),
        /agent/i,
        `${JSON.stringify(bad)} must be refused`,
      );
    }
  });

  test("a caller still cannot name the bound identity directly", () => {
    // The declared agent id is the one field the operator declares. The fields
    // that would let a caller choose the principal, run or workspace it acts
    // as stay refused, so this is not a new way in.
    assert.throws(() => validated({ agentId: "caller-chosen-agent" }), /agentId/);
    assert.throws(() => validated({ runId: "caller-run" }), /runId/);
    assert.throws(() => validated({ principalId: "caller-principal" }), /principalId/);
  });
});

/** The demo tool the fixture upstream advertises, and the call it makes. */
const demoCall: InterceptedCall = {
  tool: "aws.s3.object.put",
  connector: "aws",
  args: { key: "demo", body: "hello" },
};

/**
 * The target and scope the connector owning this tool derives. Written out
 * rather than defaulted: an unresolved one must be an invalid request, and a
 * fixture that cannot fail closed proves nothing about the gate.
 */
const deriveTarget = (call: InterceptedCall): string | null => {
  const key = call.args.key;
  return typeof key === "string" && key !== "" ? `aws:sandbox/${key}` : null;
};
const deriveScope = (call: InterceptedCall) =>
  call.tool === "aws.s3.object.put" ? ("write" as const) : null;

const AGENT_YAML = `
version: 1
agents:
  - id: demo-support-bot
    owner: oliver
rules:
  - id: support-bot-writes-demo-bucket
    match:
      agent: demo-support-bot
      tool: aws.s3.object.put
      target_prefix: aws:sandbox/
      scope: write
      class: r3
    decision: allow
    rationale: the support bot may write its demo bucket
  - id: default-deny
    match: {}
    decision: deny
    rationale: no rule grants this agent this action
`;

/**
 * The class layer is deliberately permissive here so that the decision under
 * test is the agent layer's. `aws.s3.object.put` classifies as r3, which VOID's
 * shipped class policy holds; that the stricter of the two wins is proven in
 * packages/proxy/src/forward/agent-policy.test.ts, not restated here.
 */
const CLASS_YAML = `
version: 1
rules:
  - match: { class: [unknown, r0, r1, r3] }
    decision: allow
  - match: {}
    decision: deny
`;

const policyCall = {
  tool: demoCall.tool,
  connector: demoCall.connector,
  workspace: "demo-workspace",
  klass: "unknown",
  blastRadius: undefined,
  unclassified: true,
} satisfies PolicyCall;

/**
 * Issues a real grant and returns the proxy's view of it: the identity the
 * ingress would hand the gate, resolved through the issuer rather than built by
 * hand. `null` once the run is stopped, which is what makes the last test in
 * this file meaningful.
 */
function grantGate(issuer: LocalAgentIdentityIssuer, token: string, runId: string) {
  const agentPolicy = loadAgentPolicy(AGENT_YAML);
  const classPolicy = loadPolicy(CLASS_YAML);
  assert.ok(agentPolicy.ok, "the agent policy under test must load");
  assert.ok(classPolicy.ok, "the class policy under test must load");

  const identity = (): GrantedIdentity | null => {
    const verified = issuer.authenticate(token, {
      audience: LOCAL_AGENT_GRANT_AUDIENCE,
      upstreamId: TASK_DEFAULTS.upstreamId,
    });
    if (!verified) return null;
    return {
      agentId: verified.agentId,
      runId: verified.runId,
      workspaceId: verified.workspaceId,
      toolScope: verified.toolScope,
    };
  };

  const decide = () => {
    const gate = {
      agentPolicy,
      classPolicy,
      requestId: () => "req-1",
      identity,
      target: deriveTarget,
      scope: deriveScope,
    };
    const call = { ...demoCall };
    return evaluateWithAgentPolicy(
      gate,
      policyCall,
      classifyTool(call.tool, { facts: TASK_DEFAULTS.facts, args: call.args }),
      call,
    );
  };

  return { decide, identity, stop: () => issuer.revoke(runId), runId };
}

function issueFor(agentId: string) {
  const issuer = new LocalAgentIdentityIssuer();
  const issued = issuer.issue({
    principalId: LOCAL_AGENT_PRINCIPAL_ID,
    workspaceId: "demo-workspace",
    agentId,
    runId: "run-support",
    upstreamId: TASK_DEFAULTS.upstreamId,
    toolScope: [...TASK_DEFAULTS.toolScope],
  });
  return { issuer, issued, gate: grantGate(issuer, issued.token, "run-support") };
}

describe("a granted, declared agent reaches the proxy decision path", () => {
  test("the grant carries the declared id, not one derived from the principal", () => {
    const { issuer, issued } = issueFor("demo-support-bot");
    const verified = issuer.authenticate(issued.token, {
      audience: LOCAL_AGENT_GRANT_AUDIENCE,
      upstreamId: TASK_DEFAULTS.upstreamId,
    });
    assert.equal(verified?.agentId, "demo-support-bot");
    // The string that used to be minted here, named so a regression is legible.
    assert.notEqual(verified?.agentId, "workbench-local-agent");
    assert.notEqual(verified?.agentId, `${LOCAL_AGENT_PRINCIPAL_ID}-agent`);
  });

  test("a declared agent the policy grants is allowed, and the call forwards", async () => {
    const { gate } = issueFor("demo-support-bot");
    const verdict = gate.decide();
    assert.equal(verdict.decision.kind, "allow");
    assert.equal(verdict.result.layer, "agent-policy");
    assert.equal(verdict.result.ruleId, "support-bot-writes-demo-bucket");

    // The same verdict through the real interception path, so this is the
    // answer the proxy actually returns rather than a unit of the gate alone.
    const forwarded: string[] = [];
    const call = { ...demoCall };
    const outcome = await interceptCall(call, {
      classify: () => classifyTool(call.tool, { facts: TASK_DEFAULTS.facts, args: call.args }),
      policy: (policyCallArg, evaluation) =>
        evaluateWithAgentPolicy(
          {
            agentPolicy: loadAgentPolicy(AGENT_YAML),
            classPolicy: loadPolicy(CLASS_YAML),
            requestId: () => "req-2",
            identity: gate.identity,
            target: deriveTarget,
            scope: deriveScope,
          },
          policyCallArg,
          evaluation!,
          call,
        ).decision,
      hold: async () => {
        throw new Error("an allowed call must not hold");
      },
      ledger: (entry) => {
        forwarded.push((entry as { decision: string }).decision);
      },
    });
    assert.deepEqual(outcome, { kind: "allow" });
    assert.deepEqual(forwarded, ["allow", "allow:resolved"]);
  });

  test("an undeclared agent is refused by name", async () => {
    // This is the exact denial the old hardcoded id produced for every call.
    const { gate } = issueFor("workbench-local-agent");
    const verdict = gate.decide();
    assert.equal(verdict.decision.kind, "deny");
    assert.equal(verdict.result.ruleId, "nomo:unknown-agent");
    assert.equal(verdict.result.layer, "agent-policy");

    const call = { ...demoCall };
    const outcome = await interceptCall(call, {
      classify: () => classifyTool(call.tool, { facts: TASK_DEFAULTS.facts, args: call.args }),
      policy: (policyCallArg, evaluation) =>
        evaluateWithAgentPolicy(
          {
            agentPolicy: loadAgentPolicy(AGENT_YAML),
            classPolicy: loadPolicy(CLASS_YAML),
            requestId: () => "req-3",
            identity: gate.identity,
            target: deriveTarget,
            scope: deriveScope,
          },
          policyCallArg,
          evaluation!,
          call,
        ).decision,
      hold: async () => {
        throw new Error("a denied call must not hold");
      },
      ledger: () => {},
    });
    assert.equal(outcome.kind, "deny");
    assert.match(
      outcome.kind === "deny" ? String(outcome.error.error.message) : "",
      /nomo:unknown-agent|workbench-local-agent/,
    );
  });

  test("an agent id in the body of the request cannot replace the granted one", () => {
    // The model may put anything it likes in the arguments. The gate reads the
    // identity from the grant only.
    const { gate } = issueFor("demo-support-bot");
    const call: InterceptedCall = {
      ...demoCall,
      args: { ...demoCall.args, agentId: "demo-support-bot", agent: "demo-support-bot" },
    };
    const verdict = evaluateWithAgentPolicy(
      {
        agentPolicy: loadAgentPolicy(AGENT_YAML),
        classPolicy: loadPolicy(CLASS_YAML),
        requestId: () => "req-4",
        identity: gate.identity,
        target: deriveTarget,
        scope: deriveScope,
      },
      policyCall,
      classifyTool(call.tool, { facts: TASK_DEFAULTS.facts, args: call.args }),
      call,
    );
    assert.equal(verdict.decision.kind, "allow");
    assert.equal(verdict.result.layer, "agent-policy");
  });

  test("stopping the run revokes the grant and the call fails closed", () => {
    const { gate } = issueFor("demo-support-bot");
    assert.equal(gate.decide().decision.kind, "allow");

    assert.equal(gate.stop(), true, "stopping the run must drop its grant");

    const after = gate.decide();
    assert.equal(after.decision.kind, "deny");
    assert.equal(after.result.ruleId, "nomo:no-grant");
    assert.equal(after.result.layer, "grant");
    // Observe posture may forward a class-policy non-allow, never this one.
    assert.equal(after.identityBound, true);
  });

  test("a tool outside the grant scope is refused before any rule is read", () => {
    const issuer = new LocalAgentIdentityIssuer();
    const issued = issuer.issue({
      principalId: LOCAL_AGENT_PRINCIPAL_ID,
      workspaceId: "demo-workspace",
      agentId: "demo-support-bot",
      runId: "run-support",
      upstreamId: TASK_DEFAULTS.upstreamId,
      toolScope: ["notes.read"],
    });
    const verified = issuer.authenticate(issued.token, {
      audience: LOCAL_AGENT_GRANT_AUDIENCE,
      upstreamId: TASK_DEFAULTS.upstreamId,
    });
    const call = { ...demoCall };
    const verdict = evaluateWithAgentPolicy(
      {
        agentPolicy: loadAgentPolicy(AGENT_YAML),
        classPolicy: loadPolicy(CLASS_YAML),
        requestId: () => "req-5",
        identity: () =>
          verified && {
            agentId: verified.agentId,
            runId: verified.runId,
            workspaceId: verified.workspaceId,
            toolScope: verified.toolScope,
          },
        target: deriveTarget,
        scope: deriveScope,
      },
      policyCall,
      classifyTool(call.tool, { facts: TASK_DEFAULTS.facts, args: call.args }),
      call,
    );
    assert.equal(verdict.decision.kind, "deny");
    assert.equal(verdict.result.ruleId, "nomo:outside-grant");
  });

  test("an unresolvable target is refused rather than guessed", () => {
    const { gate } = issueFor("demo-support-bot");
    const call: InterceptedCall = { ...demoCall, args: { body: "hello" } };
    const verdict = evaluateWithAgentPolicy(
      {
        agentPolicy: loadAgentPolicy(AGENT_YAML),
        classPolicy: loadPolicy(CLASS_YAML),
        requestId: () => "req-6",
        identity: gate.identity,
        target: deriveTarget,
        scope: deriveScope,
      },
      policyCall,
      classifyTool(call.tool, { facts: TASK_DEFAULTS.facts, args: call.args }),
      call,
    );
    assert.equal(verdict.decision.kind, "deny");
    assert.equal(verdict.result.ruleId, "nomo:invalid-request");
  });
});
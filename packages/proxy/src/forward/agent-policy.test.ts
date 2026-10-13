import test, { describe } from "node:test";
import assert from "node:assert/strict";

import { classifyTool } from "../../../registry/src/index.ts";
import { loadPolicy, type PolicyCall } from "../../../policy/src/index.ts";
import { loadAgentPolicy, type GrantedIdentity } from "../../../agent-policy/src/index.ts";

import { interceptCall, type InterceptedCall } from "./tools.ts";
import {
  evaluateWithAgentPolicy,
  type AgentPolicyGate,
} from "./agent-policy.ts";

const AGENT_YAML = `
version: 1
agents:
  - id: demo-support-bot
    owner: oliver
rules:
  - id: support-bot-reads-notes
    match:
      agent: demo-support-bot
      tool: notes.read
      target_prefix: fs:sandbox/notes/
      scope: read
      class: unknown
    decision: allow
    rationale: the support bot may read the shared notes folder
  - id: support-bot-writes-drafts
    match:
      agent: demo-support-bot
      tool: fs.file.write
      target_prefix: fs:sandbox/drafts/
      scope: write
      class: [r0, r1]
    decision: allow
    rationale: drafts are reversible
  - id: default-deny
    match: {}
    decision: deny
    rationale: no rule grants this agent this action
`;

const CLASS_YAML = `
version: 1
rules:
  # An unclassified call reaches the class policy as the assumed worst, so a
  # read has to be opted in by name or it would hold forever.
  - match: { class: unknown, tool: [notes.read] }
    decision: allow
  - match: { class: [r0, r1] }
    decision: allow
  - match: { class: [r2, r3] }
    decision: hold
    seconds: 60
  - match: {}
    decision: deny
`;

const agentPolicy = loadAgentPolicy(AGENT_YAML);
const classPolicy = loadPolicy(CLASS_YAML);

const supportBot: GrantedIdentity = {
  agentId: "demo-support-bot",
  runId: "run-support",
  workspaceId: "demo",
  toolScope: ["notes.read", "fs.file.write"],
};

function gate(overrides: Partial<AgentPolicyGate> = {}): AgentPolicyGate {
  return {
    agentPolicy,
    classPolicy,
    requestId: () => "req-1",
    identity: () => supportBot,
    target: () => "fs:sandbox/notes/faq.md",
    scope: () => "read",
    ...overrides,
  };
}

const notesRead: InterceptedCall = {
  tool: "notes.read",
  connector: "fs",
  args: { path: "sandbox/notes/faq.md" },
};

const draftsWrite: InterceptedCall = {
  tool: "fs.file.write",
  connector: "fs",
  args: { path: "sandbox/drafts/reply.md", content: "hi" },
};

function classify(tool: string, args: Record<string, unknown>) {
  const facts =
    tool === "fs.file.write" ? { "fs.shadow.captured": "true" } : {};
  return classifyTool(tool, { facts, args });
}

describe("the agent policy inside the proxy decision path", () => {
  test("a granted agent call the agent policy allows forwards", () => {
    const verdict = evaluateWithAgentPolicy(
      gate(),
      {
        tool: notesRead.tool,
        connector: notesRead.connector,
        workspace: "demo",
        klass: "unknown",
        blastRadius: undefined,
        unclassified: true,
      } satisfies PolicyCall,
      classify(notesRead.tool, notesRead.args),
      notesRead,
    );
    assert.equal(verdict.decision.kind, "allow");
    assert.equal(verdict.result.ruleId, "support-bot-reads-notes");
    assert.equal(verdict.result.layer, "agent-policy");
    assert.equal(verdict.identityBound, false);
  });

  test("a grant the agent policy refuses is denied with its rule id", () => {
    // Granted for the tool, but the target is the notes folder, which no
    // write rule covers: the grant names the tool, not the folder.
    const verdict = evaluateWithAgentPolicy(
      gate({ target: () => "fs:sandbox/notes/faq.md", scope: () => "write" }),
      {
        tool: "fs.file.write",
        connector: "fs",
        workspace: "demo",
        klass: "r0",
        blastRadius: undefined,
      } satisfies PolicyCall,
      classify("fs.file.write", { path: "sandbox/notes/faq.md" }),
      { ...draftsWrite, args: { path: "sandbox/notes/faq.md", content: "x" } },
    );
    assert.equal(verdict.decision.kind, "deny");
    assert.equal(verdict.result.ruleId, "default-deny");
    assert.match(String((verdict.decision as { rationale?: string }).rationale), /default-deny/);
  });

  test("a missing or revoked grant fails closed even when the class policy allows", () => {
    const verdict = evaluateWithAgentPolicy(
      gate({ identity: () => null }),
      {
        tool: notesRead.tool,
        connector: notesRead.connector,
        workspace: "demo",
        klass: "unknown",
        blastRadius: undefined,
        unclassified: true,
      } satisfies PolicyCall,
      classify(notesRead.tool, notesRead.args),
      notesRead,
    );
    assert.equal(verdict.decision.kind, "deny");
    assert.equal(verdict.result.ruleId, "nomo:no-grant");
    assert.equal(verdict.result.layer, "grant");
    // observe posture may forward a class-policy non-allow, never this one.
    assert.equal(verdict.identityBound, true);
  });

  test("a tool outside the grant is refused before any rule is read", () => {
    const verdict = evaluateWithAgentPolicy(
      gate({ identity: () => ({ ...supportBot, toolScope: ["notes.read"] }) }),
      {
        tool: "fs.file.write",
        connector: "fs",
        workspace: "demo",
        klass: "r0",
        blastRadius: undefined,
      } satisfies PolicyCall,
      classify("fs.file.write", draftsWrite.args),
      draftsWrite,
    );
    assert.equal(verdict.decision.kind, "deny");
    assert.equal(verdict.result.ruleId, "nomo:outside-grant");
    assert.equal(verdict.identityBound, true);
  });

  test("an unresolvable target is an invalid request, not a guess", () => {
    const verdict = evaluateWithAgentPolicy(
      gate({ target: () => null }),
      {
        tool: notesRead.tool,
        connector: notesRead.connector,
        workspace: "demo",
        klass: "unknown",
        blastRadius: undefined,
        unclassified: true,
      } satisfies PolicyCall,
      classify(notesRead.tool, notesRead.args),
      notesRead,
    );
    assert.equal(verdict.decision.kind, "deny");
    assert.equal(verdict.result.ruleId, "nomo:invalid-request");
  });

  test("the class policy still holds a call the agent policy allows", () => {
    // agents.yaml allows the write at every class; the class policy holds r2,
    // so the strictest answer wins and the call waits for a person.
    const anyClass = loadAgentPolicy(`
version: 1
agents:
  - id: demo-support-bot
    owner: oliver
rules:
  - id: drafts-any-class
    match: { agent: demo-support-bot, tool: fs.file.write }
    decision: allow
  - id: default-deny
    match: {}
    decision: deny
`);
    const strict = loadPolicy(`
version: 1
rules:
  - match: { class: [r2, r3] }
    decision: hold
    seconds: 45
  - match: {}
    decision: deny
`);
    const verdict = evaluateWithAgentPolicy(
      gate({
        agentPolicy: anyClass,
        classPolicy: strict,
        target: () => "fs:sandbox/drafts/reply.md",
        scope: () => "write",
      }),
      {
        tool: "fs.file.write",
        connector: "fs",
        workspace: "demo",
        klass: "r2",
        blastRadius: undefined,
      } satisfies PolicyCall,
      { outcome: "classified", entryId: "fs.file.write", caseIndex: 0, tone: "r2", reason: "matched" } as const,
      draftsWrite,
    );
    assert.equal(verdict.decision.kind, "hold");
    assert.equal(verdict.result.layer, "class-policy");
    assert.equal(verdict.decision.kind === "hold" ? verdict.decision.seconds : null, 45);
  });

  test("interceptCall reaches the agent policy through its policy hook", async () => {
    const ledger: Array<{ decision: string }> = [];
    const call = notesRead;
    const verdict = await interceptCall(call, {
      classify: () => classify(call.tool, call.args),
      policy: (policyCall, evaluation) => {
        assert.ok(evaluation, "interceptCall must hand its classification to the policy hook");
        return evaluateWithAgentPolicy(gate(), policyCall, evaluation, call).decision;
      },
      hold: async () => {
        throw new Error("hold should not run");
      },
      ledger: (entry) => {
        ledger.push(entry as { decision: string });
      },
    });
    assert.deepEqual(verdict, { kind: "allow" });
    assert.deepEqual(ledger.map((entry) => entry.decision), ["allow", "allow:resolved"]);
  });

  test("interceptCall blocks a denied call and records it", async () => {
    const ledger: Array<{ decision: string }> = [];
    const call: InterceptedCall = {
      tool: "fs.file.write",
      connector: "fs",
      args: { path: "sandbox/notes/faq.md", content: "x" },
    };
    const verdict = await interceptCall(call, {
      classify: () => classify(call.tool, call.args),
      policy: (policyCall, evaluation) =>
        evaluateWithAgentPolicy(
          gate({ target: () => "fs:sandbox/notes/faq.md", scope: () => "write" }),
          policyCall,
          evaluation!,
          call,
        ).decision,
      hold: async () => {
        throw new Error("hold should not run");
      },
      ledger: (entry) => {
        ledger.push(entry as { decision: string });
      },
    });
    assert.equal(verdict.kind, "deny");
    assert.match(
      verdict.kind === "deny" ? verdict.error.error.message : "",
      /default-deny/,
    );
    assert.ok(
      ledger.some((entry) => entry.decision.startsWith("deny")),
      "a refused call must leave a ledger record",
    );
  });
});
/**
 * The agent policy on top of the Workbench local agent grant, end to end in
 * one process: issue a grant, validate it per call the way the inbound proxy
 * does, decide with agents.yaml and the VOID class policy, run a fake
 * connector, then stop the run and let the grant expire.
 *
 * Nothing here is the proxy and nothing in the Workbench is changed. The
 * issuer is David's real `LocalAgentIdentityIssuer`, so this proves the two
 * compose before anyone wires the agent policy into the proxy's policy hook.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { loadPolicy } from "../../policy/src/rules.ts";
import { classifyTool } from "../../registry/src/evaluate.ts";
import {
  LOCAL_AGENT_GRANT_AUDIENCE,
  LOCAL_AGENT_GRANT_TTL_MS,
  LocalAgentIdentityIssuer,
} from "../../workbench/src/agent-identity.ts";
import { checkPolicy, type PolicyCheckResult } from "./check.ts";
import type { Scope } from "./grammar.ts";
import { loadAgentPolicy } from "./load.ts";

const agentPolicy = loadAgentPolicy(
  readFileSync(new URL("../../../policy/agents.yaml", import.meta.url), "utf8"),
);
const classPolicy = loadPolicy(`
version: 1
rules:
  - match: { class: unknown, tool: [notes.read] }
    decision: allow
  - match: { class: r0 }
    decision: allow
  - match: { class: [r2, r3] }
    decision: hold
    seconds: 60
  - match: {}
    decision: deny
`);

const UPSTREAM = "fake-fs";

/** Fake connector over fake data: a map of sandbox paths. */
class FakeFs {
  readonly files = new Map<string, string>([
    ["fs:sandbox/notes/faq.md", "refunds take 5 days"],
    ["fs:sandbox/drafts/old.md", "stale draft"],
  ]);
  run(tool: string, target: string, args: Record<string, unknown>): unknown {
    if (tool === "notes.read") return this.files.get(target);
    if (tool === "fs.file.write")
      return (this.files.set(target, String(args.content)), "ok");
    if (tool === "fs.file.delete") return this.files.delete(target);
    throw new Error(`fake connector has no ${tool}`);
  }
}

const CLASS_FACTS: Record<string, Record<string, string>> = {
  "fs.file.write": { "fs.shadow.captured": "true" },
};

test("a Workbench grant, the agent policy, a stop and an expiry, end to end", () => {
  let monotonic = 1_000;
  let wall = Date.parse("2026-10-11T09:00:00.000Z");
  const later = (ms: number) => {
    monotonic += ms;
    wall += ms;
  };
  const issuer = new LocalAgentIdentityIssuer({
    now: () => monotonic,
    wallNow: () => wall,
  });
  const fs = new FakeFs();
  let seq = 0;

  const issue = (agentId: string, runId: string) =>
    issuer.issue({
      principalId: "workbench-local",
      workspaceId: "demo",
      agentId,
      runId,
      upstreamId: UPSTREAM,
      toolScope: ["notes.read", "fs.file.write", "fs.file.delete"],
    }).token;

  /** What the inbound proxy would do per call: validate the grant, decide, dispatch. */
  const call = (
    token: string,
    tool: string,
    target: string,
    scope: Scope,
    args: Record<string, unknown> = {},
  ): { result: PolicyCheckResult; output: unknown } => {
    const identity = issuer.validate(token, {
      audience: LOCAL_AGENT_GRANT_AUDIENCE,
      upstreamId: UPSTREAM,
      toolName: tool,
    });
    const result = checkPolicy(
      {
        contract: "nomo.policy-check.v0",
        requestId: `req-${++seq}`,
        identity,
        tool,
        connector: "fs",
        args,
        target,
        scope,
      },
      {
        agentPolicy,
        classPolicy,
        classify: () =>
          classifyTool(tool, { facts: CLASS_FACTS[tool] ?? {}, args: {} }),
      },
    );
    const output =
      result.decision === "allow" ? fs.run(tool, target, args) : undefined;
    return { result, output };
  };

  const support = issue("demo-support-bot", "run-support");

  // Granted and allowed by agents.yaml: read the FAQ, write a draft.
  assert.equal(
    call(support, "notes.read", "fs:sandbox/notes/faq.md", "read").output,
    "refunds take 5 days",
  );
  const write = call(
    support,
    "fs.file.write",
    "fs:sandbox/drafts/reply.md",
    "write",
    {
      content: "Hi, refunds take 5 days.",
    },
  );
  assert.equal(write.result.ruleId, "support-bot-writes-drafts");
  assert.equal(
    fs.files.get("fs:sandbox/drafts/reply.md"),
    "Hi, refunds take 5 days.",
  );

  // Granted, but agents.yaml says no: the grant names the tool, not the folder.
  const sneak = call(
    support,
    "fs.file.write",
    "fs:sandbox/notes/faq.md",
    "write",
    {
      content: "x",
    },
  );
  assert.equal(sneak.result.decision, "deny");
  assert.equal(sneak.result.ruleId, "default-deny");
  assert.equal(fs.files.get("fs:sandbox/notes/faq.md"), "refunds take 5 days");

  // Granted, but a delete waits for a person.
  const remove = call(
    support,
    "fs.file.delete",
    "fs:sandbox/drafts/old.md",
    "delete",
  );
  assert.equal(remove.result.decision, "hold");
  assert.equal(remove.result.ruleId, "support-bot-deletes-need-a-human");
  assert.equal(fs.files.has("fs:sandbox/drafts/old.md"), true);

  // A tool outside the grant never reaches the rules: validate returns null.
  const outside = call(
    support,
    "fs.path.remove_recursive",
    "fs:sandbox/drafts",
    "delete",
  );
  assert.equal(outside.result.ruleId, "nomo:no-grant");

  // The same grant shape for another agent does not carry the support bot's rules.
  const report = issue("demo-report-bot", "run-report");
  assert.equal(
    call(report, "fs.file.write", "fs:sandbox/drafts/reply.md", "write", {
      content: "overwritten",
    }).result.ruleId,
    "default-deny",
  );
  assert.equal(
    call(report, "notes.read", "fs:sandbox/notes/faq.md", "read").result.ruleId,
    "report-bot-reads-only",
  );

  // Stopping the run revokes its grant; the next call is denied and nothing runs.
  assert.equal(issuer.revoke("run-support"), true);
  const afterStop = call(
    support,
    "fs.file.write",
    "fs:sandbox/drafts/reply.md",
    "write",
    {
      content: "after stop",
    },
  );
  assert.equal(afterStop.result.ruleId, "nomo:no-grant");
  assert.equal(afterStop.output, undefined);
  assert.equal(
    fs.files.get("fs:sandbox/drafts/reply.md"),
    "Hi, refunds take 5 days.",
  );

  // The report bot's run was not stopped, until its 60 seconds run out.
  assert.equal(
    call(report, "notes.read", "fs:sandbox/notes/faq.md", "read").result
      .decision,
    "allow",
  );
  later(LOCAL_AGENT_GRANT_TTL_MS);
  assert.equal(
    call(report, "notes.read", "fs:sandbox/notes/faq.md", "read").result.ruleId,
    "nomo:no-grant",
  );

  // A token that was never issued is no grant at all.
  assert.equal(
    call("A".repeat(43), "notes.read", "fs:sandbox/notes/faq.md", "read").result
      .ruleId,
    "nomo:no-grant",
  );
});

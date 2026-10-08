/**
 * The one flow the spike must prove, contract section 0, end to end in one
 * process: token request, issuance, call-time re-check, a fake connector,
 * fleet projections, then the kill-switch stopping the agent mid run.
 *
 * Nothing here is the proxy. It is the sequence the proxy will run once
 * [DAVID] picks where the agent id and token enter it, so the pieces are
 * proven to compose before that wiring exists.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { keyProviderFromPkcs8 } from "../../ledger/src/sign.ts";
import { loadPolicy } from "../../policy/src/rules.ts";
import { classifyTool } from "../../registry/src/evaluate.ts";
import type { PolicyCheckRequest, PolicyCheckResult } from "./check.ts";
import {
  projectPolicyDecision,
  projectRevocation,
  projectTokenIssued,
  type NomoFleetFields,
} from "./fleet.ts";
import { AgentHoldIndex, killAgent, reinstateAgent } from "./kill.ts";
import { loadAgentPolicy } from "./load.ts";
import { readRevocations, revocationView } from "./revocations.ts";
import { checkCall, issueToken, verifierFor } from "./token.ts";

const signer = keyProviderFromPkcs8(
  generateKeyPairSync("ed25519").privateKey.export({
    format: "der",
    type: "pkcs8",
  }) as Buffer,
);
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

/** Fake connector over fake data: a map of sandbox paths. Step 6. */
class FakeFs {
  readonly files = new Map<string, string>([
    ["fs:sandbox/notes/faq.md", "refunds take 5 days"],
    ["fs:sandbox/drafts/old.md", "stale draft"],
  ]);
  run(tool: string, target: string, args: Record<string, unknown>): unknown {
    if (tool === "notes.read") return this.files.get(target);
    if (tool === "fs.file.write") return this.files.set(target, String(args.content)), "ok";
    if (tool === "fs.file.delete") return this.files.delete(target);
    throw new Error(`fake connector has no ${tool}`);
  }
}

const CLASS_FACTS: Record<string, Record<string, string>> = {
  "fs.file.write": { "fs.shadow.captured": "true" },
};

test("section 0: issue, call, kill, and the agent is stopped everywhere", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "nomo-spike-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = join(dir, "revocations.jsonl");

  let clock = new Date("2026-10-08T09:00:00.000Z");
  const later = (seconds: number) => {
    clock = new Date(clock.getTime() + seconds * 1000);
  };
  const fs = new FakeFs();
  const feed: NomoFleetFields[] = [];
  const holds = new AgentHoldIndex();
  const pendingHolds = new Set<string>();
  let seq = 0;

  const engineDeps = async (tool: string) => ({
    agentPolicy,
    classPolicy,
    classify: () => classifyTool(tool, { facts: CLASS_FACTS[tool] ?? {}, args: {} }),
    revocations: revocationView(await readRevocations(store)),
    now: () => clock,
  });

  const ask = (
    tool: string,
    target: string,
    scope: PolicyCheckRequest["scope"],
    args: Record<string, unknown> = {},
  ): PolicyCheckRequest => ({
    contract: "nomo.policy-check.v0",
    requestId: `req-${++seq}`,
    agent: { id: "demo-support-bot" },
    tool,
    connector: "fs",
    args,
    target,
    scope,
    workspace: "demo",
  });

  /** Steps 1 to 3, as the issuer runs them. */
  async function requestToken(request: PolicyCheckRequest) {
    const issued = await issueToken(request, { ...(await engineDeps(request.tool)), signer });
    if (issued.kind === "issued")
      feed.push(projectTokenIssued(issued.token.claims, request.requestId));
    else feed.push(projectPolicyDecision(request, issued.check));
    if (issued.kind === "held") {
      holds.track(request.requestId, request.agent.id);
      pendingHolds.add(request.requestId);
    }
    return issued;
  }

  /** Steps 4 to 7, as the proxy runs them: re-check, then the connector. */
  async function call(request: PolicyCheckRequest, tokenValue: unknown) {
    const { token: _, ...bare } = request;
    const result: PolicyCheckResult = await checkCall(bare, tokenValue, {
      ...(await engineDeps(request.tool)),
      verifier: verifierFor(signer),
    });
    feed.push(projectPolicyDecision(request, result));
    const output =
      result.decision === "allow"
        ? fs.run(request.tool, request.target, request.args)
        : undefined;
    return { result, output };
  }

  // The bot reads the FAQ and writes a draft reply.
  const read = ask("notes.read", "fs:sandbox/notes/faq.md", "read");
  const readToken = await requestToken(read);
  assert.equal(readToken.kind, "issued");
  if (readToken.kind !== "issued") return;
  assert.equal((await call(read, readToken.token.value)).output, "refunds take 5 days");

  const write = ask("fs.file.write", "fs:sandbox/drafts/reply.md", "write", {
    content: "Hi, refunds take 5 days.",
  });
  const writeToken = await requestToken(write);
  assert.equal(writeToken.kind, "issued");
  if (writeToken.kind !== "issued") return;
  assert.equal((await call(write, writeToken.token.value)).result.decision, "allow");
  assert.equal(fs.files.get("fs:sandbox/drafts/reply.md"), "Hi, refunds take 5 days.");

  // The read token does not stretch to a write, and nothing outside drafts is granted.
  const sneak = ask("fs.file.write", "fs:sandbox/notes/faq.md", "write", { content: "x" });
  assert.equal((await call(sneak, readToken.token.value)).result.ruleId, "nomo:token-mismatch");
  assert.equal((await requestToken(sneak)).kind, "denied");
  assert.equal(fs.files.get("fs:sandbox/notes/faq.md"), "refunds take 5 days");

  // A delete waits for a person.
  const remove = ask("fs.file.delete", "fs:sandbox/drafts/old.md", "delete");
  assert.equal((await requestToken(remove)).kind, "held");

  // Step 8: the operator stops the agent ten seconds in. The write token is still
  // inside its 60 seconds, and the delete is still waiting.
  later(10);
  const kill = await killAgent({
    storePath: store,
    agentId: "demo-support-bot",
    by: "oliver",
    reason: "drafting replies it should not",
    now: () => clock,
    holds: {
      index: holds,
      deny: (holdId) => pendingHolds.delete(holdId),
    },
  });
  feed.push(projectRevocation(kill.record));
  assert.deepEqual(kill.deniedHolds, [remove.requestId]);
  assert.equal(pendingHolds.size, 0);

  // Next check denies, the live token is dead, and nothing new is issued.
  later(5);
  const again = { ...write, requestId: `req-${++seq}`, args: { content: "overwritten" } };
  const afterKill = await call(again, writeToken.token.value);
  assert.equal(afterKill.result.ruleId, "nomo:kill-switch");
  assert.equal(afterKill.output, undefined);
  assert.equal(fs.files.get("fs:sandbox/drafts/reply.md"), "Hi, refunds take 5 days.");
  const reissue = await requestToken(ask("notes.read", "fs:sandbox/notes/faq.md", "read"));
  assert.equal(reissue.kind, "denied");
  if (reissue.kind === "denied") assert.equal(reissue.check.ruleId, "nomo:kill-switch");

  // Reinstating lets the agent ask again, but a token from before the kill stays dead.
  later(5);
  const back = await reinstateAgent({
    storePath: store,
    agentId: "demo-support-bot",
    by: "oliver",
    reason: "reviewed",
    now: () => clock,
  });
  feed.push(projectRevocation(back));
  assert.equal(
    (await call({ ...again, requestId: `req-${++seq}` }, writeToken.token.value)).result.ruleId,
    "nomo:token-revoked",
  );
  const fresh = await requestToken(ask("notes.read", "fs:sandbox/notes/faq.md", "read"));
  assert.equal(fresh.kind, "issued");

  // The fleet feed told the story without a target, a reason, an operator or a token.
  assert.deepEqual(
    feed.map((e) => [e.type, e.decision ?? "", e.ruleId ?? ""]),
    [
      ["token.issued", "", ""],
      ["policy.decided", "allow", "support-bot-reads-notes"],
      ["token.issued", "", ""],
      ["policy.decided", "allow", "support-bot-writes-drafts"],
      ["policy.decided", "deny", "nomo:token-mismatch"],
      ["policy.decided", "deny", "default-deny"],
      ["policy.decided", "hold", "support-bot-deletes-need-a-human"],
      ["agent.killed", "", ""],
      ["policy.decided", "deny", "nomo:kill-switch"],
      ["policy.decided", "deny", "nomo:kill-switch"],
      ["agent.reinstated", "", ""],
      ["policy.decided", "deny", "nomo:token-revoked"],
      ["token.issued", "", ""],
    ],
  );
  const wire = JSON.stringify(feed);
  for (const secret of [
    writeToken.token.value,
    readToken.token.value,
    "fs:sandbox",
    "refunds",
    "oliver",
    "drafting replies",
  ])
    assert.equal(wire.includes(secret), false, `fleet feed leaked ${secret.slice(0, 20)}`);
});

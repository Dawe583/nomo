import test, { describe } from "node:test";
import assert from "node:assert/strict";

import { loadPolicy } from "../../policy/src/rules.ts";
import { classifyTool } from "../../registry/src/evaluate.ts";
import { checkPolicy, type PolicyCheckRequest } from "./check.ts";
import {
  NOMO_FLEET_EVENT_TYPES,
  NOMO_FLEET_FIELDS,
  projectPolicyDecision,
  projectRevocation,
  projectTokenIssued,
} from "./fleet.ts";
import { loadAgentPolicy } from "./load.ts";
import { revocationView, type TokenClaims } from "./revocations.ts";

// Markers that must never reach the feed. Each is planted where a careless
// projection would pick it up: the target, the rule rationale that becomes the
// reason, the arguments, the operator and the revocation reason.
const TARGET = "fs:sandbox/drafts/SECRET-TARGET-7f3a.md";
const RATIONALE = "SECRET-RATIONALE-91c2 quoted from the operator";
const ARG = "SECRET-ARG-55d0";
const OPERATOR = "SECRET-OPERATOR-e8b4";
const REVOKE_REASON = "SECRET-REVOKE-REASON-0a6f";
const NOW_SECONDS = Date.parse("2026-10-08T10:00:00Z") / 1000;
const MARKERS = [TARGET, "SECRET-TARGET", RATIONALE, "SECRET-RATIONALE", ARG, OPERATOR, REVOKE_REASON];

const agentPolicy = loadAgentPolicy(`
version: 1
agents:
  - id: demo-support-bot
rules:
  - id: support-bot-deletes-need-a-human
    match: { agent: demo-support-bot, scope: delete }
    decision: hold
    seconds: 120
    rationale: ${RATIONALE}
  - id: default-deny
    match: {}
    decision: deny
    rationale: ${RATIONALE}
`);
const classPolicy = loadPolicy(`
version: 1
rules:
  - match: {}
    decision: allow
`);

const request = (
  scope: PolicyCheckRequest["scope"],
  token?: TokenClaims,
): PolicyCheckRequest => ({
  contract: "nomo.policy-check.v0",
  requestId: "01JA2Z6Y5V3QK8M1N0P7R4S9TB",
  agent: { id: "demo-support-bot", sessionId: "session-1" },
  tool: "fs.file.write",
  connector: "fs",
  args: { path: TARGET, content: ARG },
  target: TARGET,
  scope,
  workspace: "demo",
  ...(token === undefined ? {} : { token }),
});

const check = (req: PolicyCheckRequest) =>
  checkPolicy(req, {
    agentPolicy,
    classPolicy,
    classify: () =>
      classifyTool("fs.file.write", {
        facts: { "fs.shadow.captured": "true" },
        args: {},
      }),
    revocations: revocationView([]),
    now: () => new Date(NOW_SECONDS * 1000),
    requireToken: false,
  });

function assertClosed(value: object): void {
  for (const key of Object.keys(value))
    assert.ok(
      (NOMO_FLEET_FIELDS as readonly string[]).includes(key),
      `unexpected fleet field ${key}`,
    );
  const text = JSON.stringify(value);
  for (const marker of MARKERS)
    assert.ok(!text.includes(marker), `${marker} leaked into ${text}`);
}

const claims: TokenClaims = {
  jti: "tok-01JA2Z6Y5V",
  agentId: "demo-support-bot",
  tool: "fs.file.write",
  target: TARGET,
  scope: "write",
  workspace: "demo",
  iat: NOW_SECONDS - 5,
  exp: NOW_SECONDS + 55,
  agentPolicyDigest: "",
};

describe("fleet projection", () => {
  test("a hold becomes policy.decided with the verdict and nothing else", () => {
    const req = request("delete");
    const result = check(req);
    assert.equal(result.decision, "hold");
    // The source really carries what must not leave it.
    assert.match(result.reason, /SECRET-RATIONALE/);

    const event = projectPolicyDecision(req, result, {
      ledger: { seq: 42, hash: "a".repeat(64) },
    });
    assert.deepEqual(event, {
      type: "policy.decided",
      agent: "demo-support-bot",
      tool: "fs.file.write",
      requestId: "01JA2Z6Y5V3QK8M1N0P7R4S9TB",
      decision: "hold",
      ruleId: "support-bot-deletes-need-a-human",
      layer: "agent-policy",
      class: "r0",
      scope: "delete",
      ledger: { seq: 42, hash: "a".repeat(64) },
    });
    assertClosed(event);
  });

  test("a deny with a token carries the jti, never the token's target", () => {
    const req = request("write", claims);
    const event = projectPolicyDecision(req, check(req));
    assert.equal(event.decision, "deny");
    assert.equal(event.ruleId, "default-deny");
    assert.equal(event.tokenId, "tok-01JA2Z6Y5V");
    assertClosed(event);
  });

  test("extra keys smuggled onto the source objects are not copied", () => {
    const req = request("delete");
    const result = check(req);
    const event = projectPolicyDecision(
      { ...req, secret: OPERATOR } as PolicyCheckRequest,
      { ...result, target: TARGET, args: { ARG } } as typeof result,
    );
    assertClosed(event);
  });

  test("malformed values are dropped, not passed through or truncated", () => {
    const req = request("delete");
    const result = check(req);
    const event = projectPolicyDecision(
      {
        ...req,
        agent: { id: "Not An Agent" },
        tool: `fs.file.write\n${TARGET}`,
        scope: "root" as never,
      },
      { ...result, requestId: `${TARGET} ${"x".repeat(200)}`, ruleId: RATIONALE },
      { ledger: { seq: -1, hash: "a".repeat(64) } },
    );
    assert.deepEqual(event, {
      type: "policy.decided",
      decision: "hold",
      layer: "agent-policy",
      class: "r0",
    });
    assertClosed(event);
  });

  test("token.issued names the jti and the scope, not the target", () => {
    const event = projectTokenIssued(claims, "01JA2Z6Y5V3QK8M1N0P7R4S9TB");
    assert.deepEqual(event, {
      type: "token.issued",
      agent: "demo-support-bot",
      tool: "fs.file.write",
      requestId: "01JA2Z6Y5V3QK8M1N0P7R4S9TB",
      scope: "write",
      tokenId: "tok-01JA2Z6Y5V",
    });
    assertClosed(event);
  });

  test("kill and reinstate name the agent, not the operator or the reason", () => {
    for (const kind of ["kill", "reinstate"] as const) {
      const event = projectRevocation({
        kind,
        agentId: "demo-support-bot",
        at: "2026-10-08T10:00:00.000Z",
        by: OPERATOR,
        reason: REVOKE_REASON,
      });
      assert.deepEqual(event, {
        type: kind === "kill" ? "agent.killed" : "agent.reinstated",
        agent: "demo-support-bot",
      });
      assertClosed(event);
    }
  });

  test("every projected type is one the contract proposes", () => {
    const req = request("delete");
    const types = [
      projectPolicyDecision(req, check(req)).type,
      projectTokenIssued(claims, "r").type,
      projectRevocation({ kind: "kill", agentId: "a", at: "2026-10-08T10:00:00Z", by: "o", reason: "" }).type,
      projectRevocation({ kind: "reinstate", agentId: "a", at: "2026-10-08T10:00:00Z", by: "o", reason: "" }).type,
    ];
    assert.deepEqual(types, [...NOMO_FLEET_EVENT_TYPES]);
  });
});

/**
 * NOMO's agent policy inside the proxy decision path.
 *
 * The proxy stays an enforcement boundary and nothing else. This module is the
 * seam that lets the agent policy join the decision the proxy already makes:
 * `checkPolicy` runs the grant, then `agents.yaml`, then VOID's own class
 * policy, and the strictest answer wins. The result is mapped back onto the
 * `PolicyDecision` the proxy already speaks, so holds, ledger records and error
 * bodies keep working unchanged. Contract: docs/nomo/CONTRACT.md.
 *
 * Two things are deliberately not decided here. The identity is whatever the
 * verified Workbench grant carried for this call, never an agent id from the
 * request body. The target and the scope are derived by the connector that owns
 * the tool, and a connector that cannot derive them produces an invalid
 * request, which is a deny. Guessing a scope would turn a delete into a read
 * and let it through, so an unresolved one fails closed instead.
 */

import {
  checkPolicy,
  HOLD_CEILING_SECONDS,
  POLICY_CHECK_CONTRACT,
  type GrantedIdentity,
  type LoadedAgentPolicy,
  type PolicyCheckResult,
  type Scope,
} from "../../../agent-policy/src/index.ts";
import type { EvaluationResult } from "../../../registry/src/index.ts";
import type {
  LoadedPolicy,
  PolicyCall,
  PolicyDecision,
} from "../../../policy/src/index.ts";

import type { InterceptedCall } from "./tools.ts";

export type AgentPolicyGate = {
  /** `policy/agents.yaml`: who may act, on what, with which scope. */
  readonly agentPolicy: LoadedAgentPolicy;
  /** VOID's `policy/default.yaml`: how dangerous the act is. Unchanged. */
  readonly classPolicy: LoadedPolicy;
  readonly requestId: () => string;
  /**
   * The identity the Workbench local agent grant verified for this call, or
   * null when it is missing, expired or revoked. Null is a deny.
   */
  readonly identity: () => GrantedIdentity | null;
  /**
   * The resource the call acts on, as the connector derives it, for example
   * `fs:sandbox/notes/faq.md`. Null means the connector could not name it and
   * the request is invalid.
   */
  readonly target: (call: InterceptedCall) => string | null;
  /** What the agent asks to be allowed to do. Null is invalid, never a guess. */
  readonly scope: (call: InterceptedCall) => Scope | null;
};

export type AgentPolicyVerdict = {
  /** What the proxy already understands. */
  readonly decision: PolicyDecision;
  /** The full NOMO result, so an operator can read the trace and the digests. */
  readonly result: PolicyCheckResult;
  /**
   * True when the answer came from the grant or from the engine rather than
   * from a rule file. Observe posture may forward a class-policy non-allow and
   * may never forward this: a trial mode that runs stopped agents is not a
   * trial. See docs/nomo/CONTRACT.md section 6.
   */
  readonly identityBound: boolean;
};

/**
 * VOID rule ids are file indices; NOMO rule ids are named strings like
 * `support-bot-writes-drafts` or `nomo:no-grant`. There is no honest index to
 * record for a named rule, so the decision carries -1 and the rule id travels
 * in the rationale, which is what an operator reads in the denial and what the
 * ledger entry binds.
 */
const NO_RULE_INDEX = -1;

/** A hold with no stated seconds still waits; it never resolves into an allow. */
const DEFAULT_HOLD_SECONDS = 60;

function rationaleFor(result: PolicyCheckResult): string {
  return `${result.layer} ${result.ruleId}: ${result.reason}`;
}

function toDecision(result: PolicyCheckResult): PolicyDecision {
  const rationale = rationaleFor(result);
  if (result.decision === "allow") return { kind: "allow", rationale };
  if (result.decision === "deny")
    return { kind: "deny", ruleIndex: NO_RULE_INDEX, rationale };
  const seconds = Math.min(
    HOLD_CEILING_SECONDS,
    Math.max(1, result.holdSeconds ?? DEFAULT_HOLD_SECONDS),
  );
  return {
    kind: "hold",
    ruleIndex: NO_RULE_INDEX,
    seconds,
    notify: ["cli"],
    rationale,
  };
}

export function evaluateWithAgentPolicy(
  gate: AgentPolicyGate,
  policyCall: PolicyCall,
  classification: EvaluationResult,
  call: InterceptedCall,
): AgentPolicyVerdict {
  const target = gate.target(call);
  const scope = gate.scope(call);
  const result = checkPolicy(
    {
      contract: POLICY_CHECK_CONTRACT,
      requestId: gate.requestId(),
      identity: gate.identity(),
      tool: policyCall.tool,
      connector: policyCall.connector,
      args: call.args,
      // An unresolved target or scope is handed to the engine as the empty
      // value rather than a substituted one, so its own validator is what
      // rejects the request. The proxy does not get a second opinion on what
      // "invalid" means.
      target: target ?? "",
      scope: scope ?? ("" as Scope),
    },
    {
      agentPolicy: gate.agentPolicy,
      classPolicy: gate.classPolicy,
      // The proxy already classified this call, with probe facts merged. That
      // classification is the one the ledger records, so the agent policy
      // must judge the same one rather than recomputing it from no facts.
      classify: () => classification,
      blastRadius: policyCall.blastRadius,
    },
  );
  return {
    decision: toDecision(result),
    result,
    identityBound: result.layer === "grant" || result.layer === "engine",
  };
}
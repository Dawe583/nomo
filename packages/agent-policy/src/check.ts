/**
 * The NOMO policy check: the verified grant, the agent policy, then the VOID
 * class policy, and the strictest answer wins. Contract: docs/nomo/CONTRACT.md.
 *
 * Identity is not this module's job. The Workbench local agent grant
 * (`packages/workbench/src/agent-identity.ts`) authenticates the token, binds
 * it to agent, run, workspace, upstream and tool scope, and revokes it on
 * stop. This module takes the identity that grant verified, never an agent id
 * from the request body, and decides what that agent may do with it.
 *
 * Gate 2 is VOID's own `decide`, called unchanged. This module adds identity
 * on top of the reversibility class; it does not re-implement the class rules.
 *
 * Every path returns a result with a rule id and a reason. Nothing throws out
 * of `checkPolicy`: an internal failure is a deny named nomo:engine-error,
 * because the proxy calling this sits in a write path and fails closed.
 */

import { canonicalDigest } from "../../ledger/src/sign.ts";
import { decide, type PolicyCall } from "../../policy/src/decide.ts";
import { policyDigest } from "../../policy/src/digest.ts";
import type { LoadedPolicy } from "../../policy/src/rules.ts";
import type { EvaluationResult } from "../../registry/src/evaluate.ts";
import {
  AGENT_ID,
  BUILTIN_RULES,
  isScope,
  type AgentDecision,
  type CallClass,
  type Scope,
} from "./grammar.ts";
import { evaluateAgentPolicy } from "./evaluate.ts";
import type { LoadedAgentPolicy } from "./load.ts";

export const POLICY_CHECK_CONTRACT = "nomo.policy-check.v0" as const;

/**
 * The identity a verified Workbench grant carries: the fields of
 * `LocalAgentIdentity` this check reads. Null when the grant is missing,
 * expired or revoked, which is a deny here as it is at the proxy.
 */
export type GrantedIdentity = {
  readonly agentId: string;
  readonly runId: string;
  readonly workspaceId: string;
  readonly toolScope: readonly string[];
};

export type PolicyCheckRequest = {
  readonly contract: typeof POLICY_CHECK_CONTRACT;
  readonly requestId: string;
  /** From `LocalAgentIdentityIssuer.validate`, never from the agent. */
  readonly identity: GrantedIdentity | null;
  readonly tool: string;
  readonly connector: string;
  readonly args: Readonly<Record<string, unknown>>;
  readonly target: string;
  readonly scope: Scope;
};

export type CheckLayer = "grant" | "agent-policy" | "class-policy" | "engine";

export type TraceStep = {
  readonly layer: CheckLayer;
  readonly decision: AgentDecision | "skipped";
  readonly ruleId: string;
};

export type PolicyCheckResult = {
  readonly contract: typeof POLICY_CHECK_CONTRACT;
  readonly requestId: string;
  readonly decision: AgentDecision;
  readonly reason: string;
  readonly class: CallClass;
  readonly ruleId: string;
  readonly layer: CheckLayer;
  readonly holdSeconds?: number;
  readonly trace: readonly TraceStep[];
  readonly agentPolicyDigest: string | null;
  readonly classPolicyDigest: string | null;
};

export type CheckDeps = {
  readonly agentPolicy: LoadedAgentPolicy;
  readonly classPolicy: LoadedPolicy;
  /** The VOID registry classification for this call, as the proxy computes it. */
  readonly classify: () => EvaluationResult;
  /** Measured blast radius from a connector probe, when there is one. */
  readonly blastRadius?: number;
};

/** A target is a connector-derived resource name. Dot segments would walk out of a prefix. */
function targetProblem(target: unknown): string | null {
  if (typeof target !== "string" || target === "") return "target is required";
  if (target.length > 512) return "target is longer than 512 characters";
  if (/[\x00-\x1f\x7f\\]/.test(target))
    return "target contains a control character or a backslash";
  const segments = target.split("/");
  if (segments.some((s) => s === ".." || s === "."))
    return "target contains a . or .. segment";
  return null;
}

function requestProblem(request: PolicyCheckRequest): string | null {
  if (request.contract !== POLICY_CHECK_CONTRACT)
    return `contract must be ${POLICY_CHECK_CONTRACT}`;
  if (typeof request.requestId !== "string" || request.requestId === "")
    return "requestId is required";
  if (typeof request.tool !== "string" || request.tool === "")
    return "tool is required";
  if (typeof request.connector !== "string" || request.connector === "")
    return "connector is required";
  if (!isScope(request.scope))
    return "scope must be read, write, delete or admin";
  return targetProblem(request.target);
}

/** The grant is checked for shape again: a caller that passes junk gets a deny, not a match. */
function identityProblem(identity: GrantedIdentity): string | null {
  if (typeof identity !== "object" || identity === null)
    return "the grant identity is not an object";
  if (typeof identity.agentId !== "string" || !AGENT_ID.test(identity.agentId))
    return "the grant names an agent id the agent policy cannot hold";
  if (typeof identity.runId !== "string" || identity.runId === "")
    return "the grant names no run";
  if (typeof identity.workspaceId !== "string" || identity.workspaceId === "")
    return "the grant names no workspace";
  if (
    !Array.isArray(identity.toolScope) ||
    !identity.toolScope.every((tool) => typeof tool === "string")
  )
    return "the grant tool scope is not a list of tool names";
  return null;
}

const STRICTNESS: Record<AgentDecision, number> = {
  allow: 0,
  hold: 1,
  deny: 2,
};

export function checkPolicy(
  request: PolicyCheckRequest,
  deps: CheckDeps,
): PolicyCheckResult {
  const requestId =
    typeof request?.requestId === "string" ? request.requestId : "";
  const base = {
    contract: POLICY_CHECK_CONTRACT,
    requestId,
    agentPolicyDigest: null as string | null,
    classPolicyDigest: null as string | null,
  };
  const deny = (
    layer: CheckLayer,
    ruleId: string,
    reason: string,
    klass: CallClass,
    trace: readonly TraceStep[],
    digests: Partial<typeof base> = {},
  ): PolicyCheckResult => ({
    ...base,
    ...digests,
    decision: "deny",
    reason,
    class: klass,
    ruleId,
    layer,
    trace: [...trace, { layer, decision: "deny", ruleId }],
  });

  try {
    const problem = requestProblem(request);
    if (problem !== null)
      return deny(
        "engine",
        BUILTIN_RULES.invalidRequest,
        problem,
        "unknown",
        [],
      );
    if (!deps.agentPolicy.ok)
      return deny(
        "engine",
        BUILTIN_RULES.engineError,
        `agent policy is invalid: ${deps.agentPolicy.errors.join("; ")}`,
        "unknown",
        [],
      );
    if (!deps.classPolicy.ok)
      return deny(
        "engine",
        BUILTIN_RULES.engineError,
        `class policy is invalid: ${deps.classPolicy.errors.join("; ")}`,
        "unknown",
        [],
      );
    const digests = {
      agentPolicyDigest: canonicalDigest(deps.agentPolicy.policy),
      classPolicyDigest: policyDigest(deps.classPolicy.policy),
    };
    // Gate 0: the grant. A missing, expired or revoked grant reaches here as
    // null; stopping a run revokes its grant, so this is also where a stopped
    // agent ends.
    if (request.identity === null || request.identity === undefined)
      return deny(
        "grant",
        BUILTIN_RULES.noGrant,
        "no valid grant: it is missing, expired or revoked",
        "unknown",
        [],
        digests,
      );
    const identityIssue = identityProblem(request.identity);
    if (identityIssue !== null)
      return deny(
        "grant",
        BUILTIN_RULES.noGrant,
        identityIssue,
        "unknown",
        [],
        digests,
      );
    const { agentId, workspaceId: workspace } = request.identity;
    if (!request.identity.toolScope.includes(request.tool))
      return deny(
        "grant",
        BUILTIN_RULES.outsideGrant,
        `the grant for run ${request.identity.runId} does not cover ${request.tool}`,
        "unknown",
        [],
        digests,
      );
    const trace: TraceStep[] = [
      { layer: "grant", decision: "allow", ruleId: "nomo:grant-valid" },
    ];

    if (!deps.agentPolicy.policy.agents.some((agent) => agent.id === agentId))
      return deny(
        "agent-policy",
        BUILTIN_RULES.unknownAgent,
        `agent ${agentId} is not declared in the agent policy`,
        "unknown",
        trace,
        digests,
      );

    const classification = deps.classify();
    const classified = classification.outcome === "classified";
    const klass: CallClass = classified ? classification.tone : "unknown";

    // Gate 1: who may do this.
    const agentVerdict = evaluateAgentPolicy(deps.agentPolicy.policy, {
      agentId,
      tool: request.tool,
      connector: request.connector,
      target: request.target,
      scope: request.scope,
      workspace,
      klass,
    });
    trace.push({
      layer: "agent-policy",
      decision: agentVerdict.decision,
      ruleId: agentVerdict.ruleId,
    });

    // Gate 2: how dangerous is it, VOID's rules unchanged.
    const policyCall: PolicyCall = {
      tool: request.tool,
      connector: request.connector,
      workspace,
      klass: classified ? classification.tone : "r3",
      blastRadius: deps.blastRadius,
      ...(classified ? {} : { unclassified: true as const }),
    };
    const classDecision = decide(deps.classPolicy, policyCall);
    const classVerdict =
      classDecision.kind === "unmatched"
        ? {
            decision: "deny" as const,
            ruleId: BUILTIN_RULES.unmatched,
            rationale: "the class policy matched no rule",
            seconds: undefined,
          }
        : {
            decision: classDecision.kind,
            ruleId:
              classDecision.ruleIndex === undefined
                ? "void:rule[?]"
                : `void:rule[${classDecision.ruleIndex}]`,
            rationale: classDecision.rationale,
            seconds:
              classDecision.kind === "hold" ? classDecision.seconds : undefined,
          };
    trace.push({
      layer: "class-policy",
      decision: classVerdict.decision,
      ruleId: classVerdict.ruleId,
    });

    // The strictest wins. On a tie the agent layer speaks first, because the
    // identity grant is what the operator of this agent wrote.
    const layers = [
      { layer: "agent-policy" as const, ...agentVerdict },
      { layer: "class-policy" as const, ...classVerdict },
    ];
    const winner = layers.reduce((a, b) =>
      STRICTNESS[b.decision] > STRICTNESS[a.decision] ? b : a,
    );
    const holdSeconds =
      winner.decision === "hold"
        ? Math.min(
            ...layers
              .filter((l) => l.decision === "hold")
              .map((l) => l.seconds!),
          )
        : undefined;
    const rationale =
      winner.rationale === undefined ? "" : `: ${winner.rationale}`;
    return {
      ...base,
      ...digests,
      decision: winner.decision,
      reason: `${winner.layer} rule ${winner.ruleId} said ${winner.decision}${rationale}`,
      class: klass,
      ruleId: winner.ruleId,
      layer: winner.layer,
      ...(holdSeconds === undefined ? {} : { holdSeconds }),
      trace,
    };
  } catch {
    return deny(
      "engine",
      BUILTIN_RULES.engineError,
      "internal engine failure; operator review required",
      "unknown",
      [],
    );
  }
}

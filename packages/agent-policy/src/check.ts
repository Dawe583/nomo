/**
 * The NOMO policy check: kill-switch, token, agent policy, then the VOID class
 * policy, and the strictest answer wins. Contract: docs/nomo/CONTRACT.md.
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
import {
  checkTokenClaims,
  type RevocationView,
  type TokenClaims,
} from "./revocations.ts";

export const POLICY_CHECK_CONTRACT = "nomo.policy-check.v0" as const;

export type PolicyCheckRequest = {
  readonly contract: typeof POLICY_CHECK_CONTRACT;
  readonly requestId: string;
  readonly agent: { readonly id: string; readonly sessionId?: string };
  readonly tool: string;
  readonly connector: string;
  readonly args: Readonly<Record<string, unknown>>;
  readonly target: string;
  readonly scope: Scope;
  readonly workspace: string;
  readonly token?: TokenClaims;
};

export type CheckLayer =
  "kill-switch" | "token" | "agent-policy" | "class-policy" | "engine";

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
  readonly revocations: RevocationView;
  readonly now: () => Date;
  /** Measured blast radius from a connector probe, when there is one. */
  readonly blastRadius?: number;
  /** True at call time (proxy), false at token issuance. */
  readonly requireToken: boolean;
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
  if (typeof request.agent?.id !== "string" || !AGENT_ID.test(request.agent.id))
    return "agent.id is not a valid agent id";
  if (typeof request.tool !== "string" || request.tool === "")
    return "tool is required";
  if (typeof request.connector !== "string" || request.connector === "")
    return "connector is required";
  if (!isScope(request.scope))
    return "scope must be read, write, delete or admin";
  if (typeof request.workspace !== "string" || request.workspace === "")
    return "workspace is required";
  return targetProblem(request.target);
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
    const agentId = request.agent.id;

    // Gate 0: the kill-switch is read before anything else, so a killed
    // agent is denied even with a valid token and a permissive file.
    if (deps.revocations.isKilled(agentId))
      return deny(
        "kill-switch",
        BUILTIN_RULES.killSwitch,
        `agent ${agentId} was stopped by the kill-switch`,
        "unknown",
        [],
        digests,
      );
    const trace: TraceStep[] = [
      {
        layer: "kill-switch",
        decision: "allow",
        ruleId: BUILTIN_RULES.killSwitch,
      },
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

    if (request.token !== undefined || deps.requireToken) {
      if (request.token === undefined)
        return deny(
          "token",
          BUILTIN_RULES.tokenMissing,
          "a token is required for this call",
          "unknown",
          trace,
          digests,
        );
      const tokenCheck = checkTokenClaims(
        request.token,
        { ...request, agentId },
        deps.revocations,
        deps.now(),
      );
      if (!tokenCheck.ok)
        return deny(
          "token",
          tokenCheck.ruleId,
          tokenCheck.reason,
          "unknown",
          trace,
          digests,
        );
      if (request.token.agentPolicyDigest !== digests.agentPolicyDigest)
        trace.push({
          layer: "token",
          decision: "allow",
          ruleId: "nomo:token-policy-changed",
        });
      else
        trace.push({
          layer: "token",
          decision: "allow",
          ruleId: "nomo:token-valid",
        });
    }

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
      workspace: request.workspace,
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
      workspace: request.workspace,
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

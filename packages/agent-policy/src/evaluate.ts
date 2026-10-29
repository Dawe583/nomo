/**
 * Agent policy evaluation: one call and one loaded file in, one decision with
 * the id of the rule that made it out. First match wins, no state, no clock.
 */

import {
  BUILTIN_RULES,
  type AgentDecision,
  type CallClass,
  type Scope,
} from "./grammar.ts";
import type { AgentRule, AgentPolicyFile } from "./load.ts";

/** The call as gate 1 sees it. The class comes from the NOMO registry, never from the agent. */
export type AgentCall = {
  readonly agentId: string;
  readonly tool: string;
  readonly connector: string;
  readonly target: string;
  readonly scope: Scope;
  readonly workspace: string;
  readonly klass: CallClass;
};

export type AgentVerdict = {
  readonly decision: AgentDecision;
  readonly ruleId: string;
  readonly rationale: string | undefined;
  /** Present only on hold. */
  readonly seconds?: number;
};

const list = (value: unknown): readonly string[] =>
  Array.isArray(value) ? (value as string[]) : [value as string];

/**
 * An unclassified call is matched the way NOMO matches it: an allow covers it
 * only when the rule names `unknown` explicitly, so a broad allow cannot
 * authorize what the registry could not classify. A deny or hold that names
 * r3 also covers it, because unclassified is treated as the worst class.
 */
function classMatches(
  expected: unknown,
  actual: CallClass,
  decision: AgentDecision,
): boolean {
  if (expected === undefined)
    return actual !== "unknown" || decision !== "allow";
  const classes = list(expected);
  if (actual !== "unknown") return classes.includes(actual);
  return (
    classes.includes("unknown") ||
    (decision !== "allow" && classes.includes("r3"))
  );
}

function ruleMatches(rule: AgentRule, call: AgentCall): boolean {
  const match = rule.match;
  if (!classMatches(match.class, call.klass, rule.decision)) return false;
  for (const [key, expected] of Object.entries(match)) {
    if (expected === undefined) continue;
    const values = list(expected);
    switch (key) {
      case "agent":
        if (!values.includes(call.agentId)) return false;
        break;
      case "tool":
        if (!values.includes(call.tool)) return false;
        break;
      case "connector":
        if (!values.includes(call.connector)) return false;
        break;
      case "workspace":
        if (!values.includes(call.workspace)) return false;
        break;
      case "scope":
        if (!values.includes(call.scope)) return false;
        break;
      case "target":
        if (!values.includes(call.target)) return false;
        break;
      case "target_prefix":
        if (!values.some((prefix) => call.target.startsWith(prefix)))
          return false;
        break;
      case "class":
        break;
    }
  }
  return true;
}

/**
 * The caller has already checked that the agent is declared; this function
 * only matches rules. The loader guarantees a terminal deny, so the fallback
 * below is reachable only with a file built by hand around the loader, and it
 * denies.
 */
export function evaluateAgentPolicy(
  policy: AgentPolicyFile,
  call: AgentCall,
): AgentVerdict {
  for (const rule of policy.rules) {
    if (!ruleMatches(rule, call)) continue;
    return {
      decision: rule.decision,
      ruleId: rule.id,
      rationale: rule.rationale,
      ...(rule.decision === "hold" ? { seconds: rule.seconds! } : {}),
    };
  }
  return {
    decision: "deny",
    ruleId: BUILTIN_RULES.unmatched,
    rationale: "no rule matched",
  };
}

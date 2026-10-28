/**
 * The agent policy grammar: who may act, on what, with which scope.
 *
 * This sits beside the NOMO class policy rather than inside it. NOMO's file
 * answers how dangerous a call is (R0 to R3); this file answers which agent is
 * allowed to make it. Both are evaluated and the stricter answer wins, so
 * nothing here can widen what the class policy already holds or denies.
 *
 * Same posture as `@nomo/policy`: no expressions, no regular expressions,
 * unknown keys and values are load errors, first match wins. One difference
 * on purpose: the terminal catch-all must deny. An agent gets nothing it was
 * not granted by name.
 */

export const AGENT_POLICY_VERSION = 1;

export const AGENT_MATCH_KEYS = [
  "agent",
  "tool",
  "connector",
  "target",
  "target_prefix",
  "scope",
  "class",
  "workspace",
] as const;

export type AgentMatchKey = (typeof AGENT_MATCH_KEYS)[number];

/** Closed on purpose: an unknown scope in a request is a deny, in a file a load error. */
export const SCOPES = ["read", "write", "delete", "admin"] as const;
export type Scope = (typeof SCOPES)[number];

/** NOMO classes plus the explicit opt-in for calls the registry could not classify. */
export const CLASSES = ["r0", "r1", "r2", "r3", "unknown"] as const;
export type CallClass = (typeof CLASSES)[number];

export type AgentDecision = "allow" | "deny" | "hold";

/** Same ceiling as NOMO holds, so an MCP request cannot outlive client timeouts. */
export const HOLD_CEILING_SECONDS = 900;

/** Agent ids land in signed ledger bodies and event streams, so they are bounded and plain. */
export const AGENT_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/;

/** Rule ids share the agent id alphabet; the nomo: prefix is reserved for built-ins. */
export const RULE_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/;

/** Rule ids for outcomes no rule in the file produced. */
export const BUILTIN_RULES = {
  noGrant: "nomo:no-grant",
  outsideGrant: "nomo:outside-grant",
  unknownAgent: "nomo:unknown-agent",
  invalidRequest: "nomo:invalid-request",
  engineError: "nomo:engine-error",
  unmatched: "nomo:default-deny",
} as const;

export function isScope(value: unknown): value is Scope {
  return (SCOPES as readonly unknown[]).includes(value);
}

export function isAgentMatchKey(name: string): name is AgentMatchKey {
  return (AGENT_MATCH_KEYS as readonly string[]).includes(name);
}

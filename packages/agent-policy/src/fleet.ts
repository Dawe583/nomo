/**
 * NOMO's additions to Max's fleet feed, contract docs/nomo/CONTRACT.md
 * section 8, as pure projections. Nothing here touches the workbench: these
 * functions return the proposed fields and Max's code decides where they join
 * his `FleetEvent` (cursor, at, sessionId and model stay his).
 *
 * Same rule as his `projectFleetEvent`: every output is built field by field
 * from a closed set and no source object is spread into it. `target`, `reason`,
 * rationale text, arguments and the operator's name are never read into an
 * output, because a target is a path or table name taken from the arguments
 * and a reason can quote an operator. They stay in the policy result and the
 * ledger, where access is already controlled. A value that fails its shape
 * check is dropped rather than truncated into something that looks valid.
 */

import {
  AGENT_ID,
  CLASSES,
  SCOPES,
  type AgentDecision,
  type CallClass,
  type Scope,
} from "./grammar.ts";
import type { CheckLayer, PolicyCheckRequest, PolicyCheckResult } from "./check.ts";
import type { RevocationRecord, TokenClaims } from "./revocations.ts";

/** The fleet event types NOMO proposes; Max's FLEET_EVENT_TYPES gains these. */
export const NOMO_FLEET_EVENT_TYPES = [
  "policy.decided",
  "token.issued",
  "agent.killed",
  "agent.reinstated",
] as const;
export type NomoFleetEventType = (typeof NOMO_FLEET_EVENT_TYPES)[number];

/** Every key a projection can emit. A test holds outputs to this list. */
export const NOMO_FLEET_FIELDS = [
  "type",
  "agent",
  "tool",
  "requestId",
  "decision",
  "ruleId",
  "layer",
  "class",
  "scope",
  "tokenId",
  "ledger",
] as const;

export type FleetLedgerRef = { readonly seq: number; readonly hash: string };

export type NomoFleetFields = {
  readonly type: NomoFleetEventType;
  /** The NOMO agent id from agents.yaml. */
  readonly agent?: string;
  /** A tool name, never its arguments; Max's existing field. */
  readonly tool?: string;
  /** Joins token request, call, ledger entry and every event. */
  readonly requestId?: string;
  readonly decision?: AgentDecision;
  readonly ruleId?: string;
  readonly layer?: CheckLayer;
  readonly class?: CallClass;
  readonly scope?: Scope;
  /** The token's jti only, never the token value. */
  readonly tokenId?: string;
  readonly ledger?: FleetLedgerRef;
};

const LAYERS: readonly CheckLayer[] = [
  "kill-switch",
  "token",
  "agent-policy",
  "class-policy",
  "engine",
];
const DECISIONS: readonly AgentDecision[] = ["allow", "deny", "hold"];

/** Same bound Max puts on a tool name, so a hostile name cannot bloat a frame. */
const TOOL_NAME_MAX = 120;
/** Ids are opaque correlators: ULIDs, UUIDs, jti values. Plain and bounded. */
const OPAQUE_ID = /^[A-Za-z0-9._:-]{1,128}$/;
/** File rule ids, nomo: built-ins and void:rule[n]. */
const RULE_REF = /^(?:nomo:|void:)?[a-z0-9][a-z0-9._?[\]-]{0,63}$/;
const LEDGER_HASH = /^[0-9a-f]{64}$/;

const oneOf = <T extends string>(
  value: unknown,
  allowed: readonly T[],
): T | undefined =>
  (allowed as readonly unknown[]).includes(value) ? (value as T) : undefined;

const matching = (value: unknown, pattern: RegExp): string | undefined =>
  typeof value === "string" && pattern.test(value) ? value : undefined;

const toolName = (value: unknown): string | undefined =>
  typeof value === "string" &&
  value.length > 0 &&
  value.length <= TOOL_NAME_MAX &&
  !/[\x00-\x1f\x7f]/.test(value)
    ? value
    : undefined;

function ledgerRef(value: FleetLedgerRef | undefined): FleetLedgerRef | undefined {
  if (value === undefined) return undefined;
  const seq = value.seq;
  const hash = matching(value.hash, LEDGER_HASH);
  if (!Number.isSafeInteger(seq) || seq < 0 || hash === undefined)
    return undefined;
  return { seq, hash };
}

/** Assembles the output in a fixed key order, leaving out what is undefined. */
function build(fields: NomoFleetFields): NomoFleetFields {
  const out: Record<string, unknown> = {};
  for (const key of NOMO_FLEET_FIELDS) {
    const value = (fields as Record<string, unknown>)[key];
    if (value !== undefined) out[key] = value;
  }
  return out as NomoFleetFields;
}

export type FleetProjectionExtras = {
  /** The ledger entry the proxy wrote for this decision, when it wrote one. */
  readonly ledger?: FleetLedgerRef;
};

/**
 * `policy.decided` from a check. The request supplies who and what scope, the
 * result supplies the verdict. Whether allows are sent too is Max's call
 * (contract section 8); this projects whatever it is given.
 */
export function projectPolicyDecision(
  request: PolicyCheckRequest,
  result: PolicyCheckResult,
  extras: FleetProjectionExtras = {},
): NomoFleetFields {
  return build({
    type: "policy.decided",
    agent: matching(request.agent?.id, AGENT_ID),
    tool: toolName(request.tool),
    requestId: matching(result.requestId, OPAQUE_ID),
    decision: oneOf(result.decision, DECISIONS),
    ruleId: matching(result.ruleId, RULE_REF),
    layer: oneOf(result.layer, LAYERS),
    class: oneOf(result.class, CLASSES),
    scope: oneOf(request.scope, SCOPES),
    tokenId: matching(request.token?.jti, OPAQUE_ID),
    ledger: ledgerRef(extras.ledger),
  });
}

/** `token.issued` from the claims of a token the issuer just minted. */
export function projectTokenIssued(
  claims: TokenClaims,
  requestId: string,
  extras: FleetProjectionExtras = {},
): NomoFleetFields {
  return build({
    type: "token.issued",
    agent: matching(claims.agentId, AGENT_ID),
    tool: toolName(claims.tool),
    requestId: matching(requestId, OPAQUE_ID),
    scope: oneOf(claims.scope, SCOPES),
    tokenId: matching(claims.jti, OPAQUE_ID),
    ledger: ledgerRef(extras.ledger),
  });
}

/** `agent.killed` or `agent.reinstated` from a revocation record. */
export function projectRevocation(
  record: RevocationRecord,
  extras: FleetProjectionExtras = {},
): NomoFleetFields {
  return build({
    type: record.kind === "kill" ? "agent.killed" : "agent.reinstated",
    agent: matching(record.agentId, AGENT_ID),
    ledger: ledgerRef(extras.ledger),
  });
}

/**
 * Kill-switch state and token claim checks.
 *
 * A kill is an appended record, never an edit: the store is a log of kill and
 * reinstate acts, and the current state of an agent is the last act on it.
 * Tokens are killed without enumerating them: a token dies when its agent has
 * a kill at or after the moment the token was issued. A reinstate does not
 * revive a token, because the kill that preceded it is still after its iat.
 */

import { appendFile, readFile } from "node:fs/promises";
import { AGENT_ID, BUILTIN_RULES, type Scope } from "./grammar.ts";

export type RevocationRecord = {
  readonly kind: "kill" | "reinstate";
  readonly agentId: string;
  /** ISO 8601 UTC. */
  readonly at: string;
  readonly by: string;
  readonly reason: string;
};

export type RevocationView = {
  /** True when the last act on this agent is a kill. */
  isKilled(agentId: string): boolean;
  /** Milliseconds of every kill on this agent, ascending. */
  kills(agentId: string): readonly number[];
};

export class RevocationStoreError extends Error {}

export function revocationView(
  records: readonly RevocationRecord[],
): RevocationView {
  const last = new Map<string, RevocationRecord["kind"]>();
  const kills = new Map<string, number[]>();
  for (const record of records) {
    last.set(record.agentId, record.kind);
    if (record.kind === "kill") {
      const at = Date.parse(record.at);
      const list = kills.get(record.agentId) ?? [];
      list.push(at);
      kills.set(record.agentId, list);
    }
  }
  for (const list of kills.values()) list.sort((a, b) => a - b);
  return {
    isKilled: (agentId) => last.get(agentId) === "kill",
    kills: (agentId) => kills.get(agentId) ?? [],
  };
}

function validateRecord(value: unknown, line: number): RevocationRecord {
  const fail = (why: string): never => {
    throw new RevocationStoreError(`revocations line ${line}: ${why}`);
  };
  if (typeof value !== "object" || value === null || Array.isArray(value))
    fail("must be an object");
  const record = value as Record<string, unknown>;
  if (record.kind !== "kill" && record.kind !== "reinstate")
    fail("kind must be kill or reinstate");
  if (typeof record.agentId !== "string" || !AGENT_ID.test(record.agentId))
    fail("agentId is not a valid agent id");
  if (typeof record.at !== "string" || Number.isNaN(Date.parse(record.at)))
    fail("at must be an ISO 8601 time");
  if (typeof record.by !== "string" || record.by === "") fail("by is required");
  if (typeof record.reason !== "string") fail("reason must be a string");
  return record as RevocationRecord;
}

/**
 * Parses the JSONL store. A missing file is an empty store, because a fresh
 * install has killed nobody. A file that exists and cannot be parsed is an
 * error, and the caller denies every call: a corrupt kill list must never
 * read as an empty one.
 */
export function parseRevocations(text: string): RevocationRecord[] {
  const records: RevocationRecord[] = [];
  text.split("\n").forEach((line, index) => {
    if (line.trim() === "") return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      throw new RevocationStoreError(`revocations line ${index + 1}: not JSON`);
    }
    records.push(validateRecord(parsed, index + 1));
  });
  return records;
}

export async function readRevocations(
  path: string,
): Promise<RevocationRecord[]> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw new RevocationStoreError(`revocations: cannot read ${path}`);
  }
  return parseRevocations(text);
}

export async function appendRevocation(
  path: string,
  record: RevocationRecord,
): Promise<void> {
  validateRecord(record, 0);
  await appendFile(path, `${JSON.stringify(record)}\n`, "utf8");
}

/** The claims NOMO checks. Encoding and signature belong to the token runtime. */
export type TokenClaims = {
  readonly jti: string;
  readonly agentId: string;
  readonly tool: string;
  readonly target: string;
  readonly scope: Scope;
  readonly workspace: string;
  /** Unix seconds. */
  readonly iat: number;
  /** Unix seconds, at most iat + 60. */
  readonly exp: number;
  readonly agentPolicyDigest: string;
};

export const TOKEN_TTL_SECONDS = 60;

export type TokenCheck =
  | { readonly ok: true }
  | { readonly ok: false; readonly ruleId: string; readonly reason: string };

/**
 * Checks claims that a verified signature vouches for. It does not verify the
 * signature: that is the runtime's job and must happen before this call.
 */
export function checkTokenClaims(
  claims: TokenClaims,
  call: {
    readonly agentId: string;
    readonly tool: string;
    readonly target: string;
    readonly scope: Scope;
    readonly workspace: string;
  },
  revocations: RevocationView,
  now: Date,
): TokenCheck {
  const nowSeconds = Math.floor(now.getTime() / 1000);
  if (claims.exp - claims.iat > TOKEN_TTL_SECONDS)
    return {
      ok: false,
      ruleId: BUILTIN_RULES.tokenExpired,
      reason: `token lifetime exceeds ${TOKEN_TTL_SECONDS} seconds`,
    };
  if (nowSeconds >= claims.exp || nowSeconds < claims.iat)
    return {
      ok: false,
      ruleId: BUILTIN_RULES.tokenExpired,
      reason: "token is expired or not yet valid",
    };
  const issuedMs = claims.iat * 1000;
  if (
    revocations.kills(claims.agentId).some((killedMs) => killedMs >= issuedMs)
  )
    return {
      ok: false,
      ruleId: BUILTIN_RULES.tokenRevoked,
      reason: "the agent was killed after this token was issued",
    };
  const fields = ["agentId", "tool", "target", "scope", "workspace"] as const;
  const mismatch = fields.filter((field) => claims[field] !== call[field]);
  if (mismatch.length > 0)
    return {
      ok: false,
      ruleId: BUILTIN_RULES.tokenMismatch,
      reason: `token does not cover this call: ${mismatch.join(", ")}`,
    };
  return { ok: true };
}

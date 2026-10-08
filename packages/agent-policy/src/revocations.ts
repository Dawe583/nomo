/**
 * Kill-switch state and token claim checks.
 *
 * A kill is an appended record, never an edit: the store is a log of kill and
 * reinstate acts, and the current state of an agent is the last act on it.
 * Tokens are killed without enumerating them: a token dies when its agent has
 * a kill at or after the moment the token was issued. A reinstate does not
 * revive a token, because the kill that preceded it is still after its iat.
 */

import { randomUUID } from "node:crypto";
import { appendFile, open, readFile, stat, unlink } from "node:fs/promises";
import { AGENT_ID, BUILTIN_RULES, type Scope } from "./grammar.ts";

export type RevocationRecord = {
  readonly kind: "kill" | "reinstate";
  readonly agentId: string;
  /** ISO 8601 UTC with a Z, as `Date.prototype.toISOString` writes it. */
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

const UTC_INSTANT =
  /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.\d{1,9})?Z$/;

/**
 * True for an ISO 8601 instant in UTC with a Z. A time without a zone is read
 * by `Date.parse` as local time, and an offset is easy to misread in a log an
 * operator scans by eye; either would move a kill against the token iat it is
 * compared with. Calendar overflow, 02-30 or 24:00, is refused rather than
 * rolled into the next day.
 */
export function isUtcInstant(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const match = UTC_INSTANT.exec(value);
  if (match === null) return false;
  const ms = Date.parse(value);
  return (
    !Number.isNaN(ms) && new Date(ms).toISOString().slice(0, 19) === match[1]
  );
}

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
  if (!isUtcInstant(record.at))
    fail("at must be an ISO 8601 time in UTC, ending in Z");
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

export class RevocationLockTimeout extends RevocationStoreError {}

/** How long a writer waits for the store lock before giving up. */
export const STORE_LOCK_WAIT_MS = 2_000;
/** A lock older than this was left by a writer that died; it is broken. */
export const STORE_LOCK_STALE_MS = 10_000;

export type StoreLockOptions = {
  readonly waitMs?: number;
  readonly staleMs?: number;
};

const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Runs `run` while holding `<store>.lock`, an exclusive-create file beside the
 * store, so a read-check-append of one writer cannot interleave with another
 * writer's append. Writers in other processes take the same file, which is why
 * this is a file and not an in-memory mutex.
 *
 * A lock whose file is older than `staleMs` is broken, because its writer
 * died. Two waiters breaking the same stale lock at once can still race; the
 * window is one stat and one unlink after ten idle seconds, accepted for the
 * spike. The store's directory must exist.
 */
export async function withStoreLock<T>(
  storePath: string,
  run: () => Promise<T>,
  options: StoreLockOptions = {},
): Promise<T> {
  const lockPath = `${storePath}.lock`;
  const waitMs = options.waitMs ?? STORE_LOCK_WAIT_MS;
  const staleMs = options.staleMs ?? STORE_LOCK_STALE_MS;
  const token = `${process.pid} ${randomUUID()}`;
  const started = Date.now();
  for (;;) {
    try {
      const handle = await open(lockPath, "wx", 0o600);
      try {
        await handle.writeFile(token, "utf8");
      } finally {
        await handle.close();
      }
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    const held = await stat(lockPath).catch(() => null);
    if (held !== null && Date.now() - held.mtimeMs > staleMs) {
      await unlink(lockPath).catch(() => undefined);
      continue;
    }
    if (Date.now() - started >= waitMs)
      throw new RevocationLockTimeout(
        `revocations: ${lockPath} is held by another writer`,
      );
    await sleep(10);
  }
  try {
    return await run();
  } finally {
    // Only our own lock is removed: if it was broken as stale meanwhile, the
    // file now belongs to the writer that took it next.
    const current = await readFile(lockPath, "utf8").catch(() => null);
    if (current === token) await unlink(lockPath).catch(() => undefined);
  }
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

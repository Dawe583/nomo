import { join } from "node:path";
import { CompanionStoreError, companionDirectory, readStoreFile, writeStoreFile } from "./store.ts";

/**
 * Idempotency for companion mutations.
 *
 * A retry of a `device.revoke` inside the advertised window must produce the
 * receipt the first attempt produced, not a second effect. That is safe because
 * a revoke receipt carries no secret: it is a device id, a timestamp and two
 * booleans.
 *
 * It is deliberately NOT used for `device.pair`. A pairing receipt carries the
 * one-time plaintext device token, and storing that on disk to make a retry
 * replayable would trade a replay window for credential material at rest. The
 * protocol requires a key on pairing, so the key is recorded and the operation
 * stays non-replayable: a caller that lost a pairing response pairs again, and
 * the workspace's eight-device cap bounds what that costs. The handshake says so
 * in `pendingBehaviors` rather than advertising a limit it does not honour.
 */
export type CompanionIdempotencyRecord = {
  /** Bound to the exact request, so a key reused for a different body is refused
   * rather than silently resolving to the first call's effect. */
  readonly requestDigest: string;
  readonly operationId: string;
  readonly recordedAt: number;
};

export type CompanionIdempotencyStore = Record<string, CompanionIdempotencyRecord>;

const recordKeys = ["requestDigest", "operationId", "recordedAt"] as const;
const keyPattern = /^[A-Za-z0-9_.:-]{1,160}$/;
const retentionMs = 24 * 60 * 60 * 1000;
const maxRecords = 500;

function idempotencyFile(env: Readonly<NodeJS.ProcessEnv>): string {
  return join(companionDirectory(env), "idempotency.json");
}

function parseStore(value: unknown): CompanionIdempotencyStore {
  if (value === null) return {};
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new CompanionStoreError("corrupt_store", "companion idempotency store is not a keyed record map");
  }
  const store: CompanionIdempotencyStore = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    const record = typeof entry === "object" && entry !== null && !Array.isArray(entry) ? entry as Record<string, unknown> : null;
    if (
      !keyPattern.test(key) ||
      record === null ||
      Object.keys(record).length !== recordKeys.length ||
      Object.keys(record).some((name) => !recordKeys.includes(name as typeof recordKeys[number])) ||
      typeof record.requestDigest !== "string" ||
      typeof record.operationId !== "string" ||
      !keyPattern.test(record.operationId) ||
      typeof record.recordedAt !== "number" ||
      !Number.isFinite(record.recordedAt)
    ) {
      throw new CompanionStoreError("corrupt_store", "companion idempotency record is not the stored shape");
    }
    store[key] = record as unknown as CompanionIdempotencyRecord;
  }
  return store;
}

function load(env: Readonly<NodeJS.ProcessEnv>): CompanionIdempotencyStore {
  return parseStore(readStoreFile(idempotencyFile(env)));
}

function prune(store: CompanionIdempotencyStore, now: number): CompanionIdempotencyStore {
  // Expired first, then oldest, so the file stays inside the protocol's
  // `maxOperationIds` without ever evicting a record that is still in window.
  const live = Object.entries(store)
    .filter(([, record]) => record.recordedAt + retentionMs > now)
    .sort((left, right) => right[1].recordedAt - left[1].recordedAt)
    .slice(0, maxRecords);
  return Object.fromEntries(live) as CompanionIdempotencyStore;
}

/** The record a retry should reuse, or null when the key is new or expired. A
 * record for a different request digest is a conflict, never a match. */
export function readIdempotency(
  env: Readonly<NodeJS.ProcessEnv>,
  key: string,
  requestDigest: string,
): { readonly state: "new" } | { readonly state: "replay"; readonly operationId: string } | { readonly state: "conflict" } {
  if (!keyPattern.test(key)) {
    throw new CompanionStoreError("invalid_idempotency_key", "companion idempotency key is out of bounds");
  }
  const record = load(env)[key];
  if (record === undefined) return { state: "new" };
  if (record.requestDigest !== requestDigest) return { state: "conflict" };
  return { state: "replay", operationId: record.operationId };
}

export function recordIdempotency(
  env: Readonly<NodeJS.ProcessEnv>,
  key: string,
  record: CompanionIdempotencyRecord,
): void {
  if (!keyPattern.test(key)) {
    throw new CompanionStoreError("invalid_idempotency_key", "companion idempotency key is out of bounds");
  }
  const now = record.recordedAt;
  const store = prune(load(env), now);
  store[key] = record;
  writeStoreFile(idempotencyFile(env), store);
}

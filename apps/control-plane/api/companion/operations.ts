import { join } from "node:path";
import { CompanionStoreError, companionDirectory, readStoreFile, writeStoreFile } from "./store.ts";

/** The frozen `void.companion.v1` outcome vocabulary, identical to
 * `CompanionOutcome` in the Apple package and to the allowlist in
 * `scripts/src/companion-fixtures.mjs`. A bounded lookup may answer with
 * `running`, `succeeded`, `denied`, `conflict`, `unknown`, `revoked` or
 * `expired`. `failed` and `pending` are deliberately absent: a settled refusal
 * is `denied` or `unknown`, and an operation still in flight is `running`. An
 * unknown identifier is never one of them, it is a 404, because a lookup must
 * never invent a success. */
export type CompanionOperationStatus =
  | "running"
  | "succeeded"
  | "denied"
  | "conflict"
  | "unknown"
  | "revoked"
  | "expired";

const statuses: readonly CompanionOperationStatus[] = ["running", "succeeded", "denied", "conflict", "unknown", "revoked", "expired"];
const idPattern = /^[A-Za-z0-9_.:-]{1,160}$/;
const recordKeys = ["operationId", "workspaceId", "deviceId", "operation", "status", "updatedAt"];

export type CompanionOperation = {
  readonly operationId: string;
  readonly workspaceId: string;
  readonly deviceId: string;
  readonly operation: string;
  readonly status: CompanionOperationStatus;
  readonly updatedAt: string;
};

export type CompanionOperationStore = Record<string, CompanionOperation>;

function operationsFile(env: Readonly<NodeJS.ProcessEnv>): string {
  return join(companionDirectory(env), "operations.json");
}

function parseStore(value: unknown): CompanionOperationStore {
  if (value === null) return {};
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new CompanionStoreError("corrupt_store", "companion operation store is not a keyed record map");
  }
  const records: CompanionOperationStore = {};
  for (const [operationId, entry] of Object.entries(value as Record<string, unknown>)) {
    const record = typeof entry === "object" && entry !== null && !Array.isArray(entry) ? entry as Record<string, unknown> : null;
    if (record === null || record.operationId !== operationId || Object.keys(record).length !== recordKeys.length ||
        Object.keys(record).some(key => !recordKeys.includes(key)) ||
        typeof record.workspaceId !== "string" || !idPattern.test(record.workspaceId) ||
        typeof record.deviceId !== "string" || !idPattern.test(record.deviceId) ||
        typeof record.operation !== "string" || !idPattern.test(record.operation) ||
        typeof record.updatedAt !== "string" || !Number.isFinite(Date.parse(record.updatedAt)) ||
        typeof record.status !== "string" || !statuses.includes(record.status as CompanionOperationStatus)) {
      throw new CompanionStoreError("corrupt_store", "companion operation record is not the stored shape");
    }
    records[operationId] = record as unknown as CompanionOperation;
  }
  return records;
}

export function loadOperations(env: Readonly<NodeJS.ProcessEnv>): CompanionOperationStore {
  return parseStore(readStoreFile(operationsFile(env)));
}

/** One keyed entry per dispatched operation. The identity of a revoke is
 * derived from the device it retires, so the record is overwritten rather than
 * appended and the store stays bounded by the number of known devices. */
export function recordOperation(env: Readonly<NodeJS.ProcessEnv>, operation: CompanionOperation): void {
  if (!idPattern.test(operation.operationId)) throw new CompanionStoreError("corrupt_store", "companion operation identity is out of bounds");
  writeStoreFile(operationsFile(env), { ...loadOperations(env), [operation.operationId]: operation });
}

/** Bounded, exact-key lookup inside one workspace. A structurally invalid
 * identifier cannot match anything, and a record from another workspace is
 * indistinguishable from a record that does not exist. */
export function readOperation(env: Readonly<NodeJS.ProcessEnv>, workspaceId: string, operationId: string): CompanionOperation | null {
  if (!idPattern.test(operationId)) return null;
  const record = loadOperations(env)[operationId];
  return record === undefined || record.workspaceId !== workspaceId ? null : record;
}

export function countOperations(env: Readonly<NodeJS.ProcessEnv>, workspaceId: string): number {
  return Object.values(loadOperations(env)).filter(record => record.workspaceId === workspaceId).length;
}

/** Revocation is the one mutation this transport dispatches, and it is
 * idempotent per device, so its operation identity is the device identity. */
export function revokeOperationId(deviceId: string): string {
  return `op-device-revoke-${deviceId}`;
}

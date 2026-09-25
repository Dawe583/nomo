import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { join } from "node:path";
import { CompanionStoreError, companionDirectory, companionWorkspace, readStoreFile, writeStoreFile } from "./store.ts";
import { recordOperation, revokeOperationId } from "./operations.ts";

/** v1 keeps a paired device read-only unless the host explicitly grants
 * execution. The names stay local to this transport on purpose: the protocol
 * catalog does not yet carry a reviewed scope vocabulary, and adopting its
 * `sessions:write` spelling here would claim an authority the executor does
 * not grant. Execution and read authority stay independent. */
export const readScope = "companion:read";
export const writeScope = "companion:write";

export type CompanionScope = typeof readScope | typeof writeScope;

export const readOnlyScopes: readonly CompanionScope[] = [readScope];

/** Protocol v1 admission limits: a fifteen minute device credential, eight
 * active devices per workspace, and a bounded retained registry so a
 * long-lived host cannot grow an unbounded credential file. */
const credentialTtlMs = 15 * 60 * 1000;
const maxActiveDevices = 8;
const maxRetainedDevices = 64;
const maxLabelLength = 80;
const idPattern = /^[A-Za-z0-9_.:-]{1,160}$/;
const hashPattern = /^[a-f0-9]{64}$/;

export type CompanionDevice = {
  readonly deviceId: string;
  readonly workspaceId: string;
  readonly label: string;
  readonly tokenHash: string;
  readonly scopes: readonly CompanionScope[];
  readonly createdAt: string;
  readonly revokedAt: string | null;
};

export type CompanionSession = {
  readonly deviceId: string;
  readonly workspaceId: string;
  readonly label: string;
  readonly scopes: readonly CompanionScope[];
};

export type PairedDevice = {
  readonly device: CompanionDevice;
  /** Shown once, at pairing. The plaintext is never written to the registry
   * and never returned by any other route. */
  readonly deviceToken: string;
};

function deviceFile(env: Readonly<NodeJS.ProcessEnv>): string {
  return join(companionDirectory(env), "devices.json");
}

/** Whether the host operator has authorised new devices to carry the write
 * scope. It is the operator's decision, never the caller's, so it is host
 * configuration and defaults to off. With it off, pairing mints read-only
 * devices and a request for the write scope is refused rather than silently
 * downgraded. */
export function pairingGrantsWrite(env: Readonly<NodeJS.ProcessEnv>): boolean {
  return env.VOID_COMPANION_WRITE_PAIRING === "1";
}

function parseDevice(value: unknown): CompanionDevice {
  const record = typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
  const keys = record === null ? [] : Object.keys(record);
  if (record === null || keys.length !== 7 || keys.some(key => !["deviceId", "workspaceId", "label", "tokenHash", "scopes", "createdAt", "revokedAt"].includes(key))) {
    throw new CompanionStoreError("corrupt_store", "companion device record is not the stored shape");
  }
  const { deviceId, workspaceId, label, tokenHash, scopes, createdAt, revokedAt } = record;
  if (typeof deviceId !== "string" || !idPattern.test(deviceId) || typeof workspaceId !== "string" || !idPattern.test(workspaceId) ||
      typeof label !== "string" || !plainLabel(label) || typeof tokenHash !== "string" || !hashPattern.test(tokenHash) ||
      !Array.isArray(scopes) || scopes.length === 0 || scopes.some(scope => scope !== readScope && scope !== writeScope) ||
      typeof createdAt !== "string" || !Number.isFinite(Date.parse(createdAt)) ||
      (revokedAt !== null && (typeof revokedAt !== "string" || !Number.isFinite(Date.parse(revokedAt))))) {
    throw new CompanionStoreError("corrupt_store", "companion device record has an out of contract field");
  }
  return { deviceId, workspaceId, label, tokenHash, scopes: scopes as readonly CompanionScope[], createdAt, revokedAt };
}

/** A label is operator display text: bounded, free of control characters, and
 * well formed, which the UTF-8 round trip is what proves, because a lone
 * surrogate does not survive one. It is deliberately allowed to look like a
 * path or a token here, because the diagnostics projection, not the registry,
 * is the place where such text must be refused. */
export function plainLabel(label: string): boolean {
  const points = Array.from(label);
  return points.length > 0 && points.length <= maxLabelLength && Buffer.from(label, "utf8").toString("utf8") === label &&
    !points.some(point => { const code = point.codePointAt(0) ?? 0; return code < 0x20 || code === 0x7f; });
}

export function loadDevices(env: Readonly<NodeJS.ProcessEnv>): readonly CompanionDevice[] {
  const value = readStoreFile(deviceFile(env));
  if (value === null) return [];
  if (!Array.isArray(value)) throw new CompanionStoreError("corrupt_store", "companion registry is not a record list");
  return value.map(parseDevice);
}

export function pairDevice(
  env: Readonly<NodeJS.ProcessEnv>,
  input: { readonly label: string; readonly scopes: readonly CompanionScope[] },
  now: number = Date.now(),
): PairedDevice {
  const workspaceId = companionWorkspace(env);
  const devices = loadDevices(env);
  if (devices.filter(device => device.workspaceId === workspaceId && device.revokedAt === null).length >= maxActiveDevices) {
    throw new CompanionStoreError("device_limit", "workspace already holds the maximum number of active companion devices");
  }
  const deviceToken = randomBytes(32).toString("base64url");
  const device: CompanionDevice = {
    deviceId: `device-${randomBytes(9).toString("base64url")}`,
    workspaceId,
    label: input.label,
    tokenHash: createHash("sha256").update(deviceToken, "utf8").digest("hex"),
    scopes: input.scopes,
    createdAt: new Date(now).toISOString(),
    revokedAt: null,
  };
  const retained = [...devices, device];
  while (retained.length > maxRetainedDevices) {
    const stale = retained.findIndex(entry => entry.revokedAt !== null);
    if (stale === -1) break;
    retained.splice(stale, 1);
  }
  writeStoreFile(deviceFile(env), retained);
  return { device, deviceToken };
}

/** Fail-closed device authentication. A missing, wrong, expired, revoked, or
 * foreign-workspace credential yields no session, and an unreadable registry
 * yields no session either: guessing a device must never be cheaper than
 * proving one. */
export function authenticateDevice(env: Readonly<NodeJS.ProcessEnv>, token: string, now: number = Date.now()): CompanionSession | null {
  if (typeof token !== "string" || token.length < 32 || token.length > 128) return null;
  let devices: readonly CompanionDevice[];
  try {
    devices = loadDevices(env);
  } catch {
    return null;
  }
  const workspaceId = companionWorkspace(env);
  const presented = Buffer.from(createHash("sha256").update(token, "utf8").digest("hex"), "hex");
  let matched: CompanionDevice | null = null;
  for (const device of devices) {
    if (device.workspaceId !== workspaceId || device.revokedAt !== null) continue;
    if (timingSafeEqual(presented, Buffer.from(device.tokenHash, "hex"))) matched = device;
  }
  if (matched === null || Date.parse(matched.createdAt) + credentialTtlMs <= now) return null;
  return { deviceId: matched.deviceId, workspaceId: matched.workspaceId, label: matched.label, scopes: matched.scopes };
}

/** Revocation is a durable, workspace-scoped, idempotent receipt. A second
 * call replays the first timestamp instead of minting a new one, and the
 * already dispatched effect keeps its durable outcome instead of being
 * erased or replayed. */
export function revokeDevice(
  env: Readonly<NodeJS.ProcessEnv>,
  deviceId: string,
  now: number = Date.now(),
): { readonly deviceId: string; readonly revokedAt: string } | null {
  const workspaceId = companionWorkspace(env);
  const devices = loadDevices(env);
  const index = devices.findIndex(device => device.deviceId === deviceId && device.workspaceId === workspaceId);
  if (index === -1) return null;
  const device = devices[index]!;
  const revokedAt = device.revokedAt ?? new Date(now).toISOString();
  if (device.revokedAt === null) {
    const retained = [...devices];
    retained[index] = { ...device, revokedAt };
    writeStoreFile(deviceFile(env), retained);
    recordOperation(env, {
      operationId: revokeOperationId(deviceId),
      workspaceId,
      deviceId,
      operation: "device.revoke",
      status: "succeeded",
      updatedAt: revokedAt,
    });
  }
  return { deviceId, revokedAt };
}


import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { CompanionStoreError, companionDirectory, companionWorkspace, readStoreFile, writeStoreFile } from "./store.ts";

/** A pairing invitation is the host operator's one-time authority to create
 * exactly one device. Without it, `POST /api/companion/devices` would mint a
 * credential for anything that could reach the loopback gate, and a second
 * start with the same invitation would have to be either honoured twice or
 * silently ignored. Both are wrong: the host needs to be able to say "that
 * invitation is spent" instead.
 *
 * The lifetime is the frozen `limits.invitationSeconds` from the handshake
 * contract. It is transcribed here for the same reason `operations.ts`
 * transcribes the outcome vocabulary: the API app does not import the scripts
 * package. */
const invitationTtlMs = 120 * 1000;

/** A host holds a bounded number of unspent invitations, so a long-lived host
 * cannot grow an unbounded directory. A host that wants more devices mints
 * more once the spent and expired ones have been pruned, which `mintInvitation`
 * does on every call. */
const maxUnspentInvitations = 32;

const invitationPattern = /^invite-[A-Za-z0-9_-]{32}$/;
const hashPattern = /^[a-f0-9]{64}$/;
const idPattern = /^[A-Za-z0-9_.:-]{1,160}$/;

type StoredInvitation = {
  readonly invitationId: string;
  readonly workspaceId: string;
  readonly tokenHash: string;
  readonly createdAt: string;
  readonly expiresAt: string;
};

const recordKeys = ["invitationId", "workspaceId", "tokenHash", "createdAt", "expiresAt"];

export type MintedInvitation = {
  /** The single secret. It is its own identifier, so there is no identifier
   * that names an invitation without also being able to spend it. Shown once;
   * the registry keeps only its digest. */
  readonly invitation: string;
  readonly expiresAt: string;
};

export type ConsumedInvitation = {
  readonly invitationId: string;
  readonly workspaceId: string;
};

export function invitationDirectory(env: Readonly<NodeJS.ProcessEnv>): string {
  return join(companionDirectory(env), "invitations");
}

function recordFile(env: Readonly<NodeJS.ProcessEnv>, invitationId: string): string {
  return join(invitationDirectory(env), `${invitationId}.json`);
}

/** Spending an invitation is one exclusive create. `openSync(path, "wx")` is
 * the only primitive in this file store that is atomic against a concurrent
 * writer: `readStoreFile` followed by `writeStoreFile` is a read-modify-write
 * whose rename commits one whole file, so two pairings that read the same
 * unspent invitation would both go on to mint a device. The marker is the
 * decision point, and a loser is told the invitation is spent rather than
 * being allowed to pair a second device. */
function spentMarker(env: Readonly<NodeJS.ProcessEnv>, invitationId: string): string {
  return join(invitationDirectory(env), `${invitationId}.spent`);
}

function parseInvitation(value: unknown, invitationId: string): StoredInvitation {
  const record = typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
  if (record === null || record.invitationId !== invitationId ||
      Object.keys(record).length !== recordKeys.length || Object.keys(record).some(key => !recordKeys.includes(key))) {
    throw new CompanionStoreError("corrupt_store", "companion invitation is not the stored shape");
  }
  const { workspaceId, tokenHash, createdAt, expiresAt } = record;
  if (typeof workspaceId !== "string" || !idPattern.test(workspaceId) ||
      typeof tokenHash !== "string" || !hashPattern.test(tokenHash) ||
      typeof createdAt !== "string" || !Number.isFinite(Date.parse(createdAt)) ||
      typeof expiresAt !== "string" || !Number.isFinite(Date.parse(expiresAt)) ||
      Date.parse(expiresAt) <= Date.parse(createdAt)) {
    throw new CompanionStoreError("corrupt_store", "companion invitation has an out of contract field");
  }
  return { invitationId, workspaceId, tokenHash, createdAt, expiresAt };
}

/** Minting is the host operator's act, and this is not a protocol operation:
 * the invitation is host admission control around the existing `device.pair`
 * route, so nothing is added to the frozen `void.companion.v1` catalog. */
export function mintInvitation(env: Readonly<NodeJS.ProcessEnv>, now: number = Date.now()): MintedInvitation {
  const workspaceId = companionWorkspace(env);
  const directory = invitationDirectory(env);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  prune(env, now);
  if (unspentInvitations(env, now).length >= maxUnspentInvitations) {
    throw new CompanionStoreError("invitation_limit", "host already holds the maximum number of unspent pairing invitations");
  }
  const invitation = `invite-${randomBytes(24).toString("base64url")}`;
  const record: StoredInvitation = {
    invitationId: invitation,
    workspaceId,
    tokenHash: createHash("sha256").update(invitation, "utf8").digest("hex"),
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + invitationTtlMs).toISOString(),
  };
  writeStoreFile(recordFile(env, invitation), record);
  return { invitation, expiresAt: record.expiresAt };
}

/** The invitations that still represent unspent operator authority: present,
 * unexpired, and not yet claimed. A spent one is retained as evidence but is
 * no longer authority, so it must not hold a slot the operator still needs. */
function unspentInvitations(env: Readonly<NodeJS.ProcessEnv>, now: number): readonly StoredInvitation[] {
  const directory = invitationDirectory(env);
  let entries: string[];
  try {
    entries = readdirSync(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const unspent: StoredInvitation[] = [];
  for (const entry of entries.sort()) {
    if (!entry.endsWith(".json")) continue;
    const invitationId = entry.slice(0, -".json".length);
    if (!invitationPattern.test(invitationId)) continue;
    if (existsSync(spentMarker(env, invitationId))) continue;
    const stored = readStoreFile(recordFile(env, invitationId));
    if (stored === null) continue;
    const record = parseInvitation(stored, invitationId);
    if (Date.parse(record.expiresAt) > now) unspent.push(record);
  }
  return unspent;
}

/** How long a spent invitation stays readable. It is the device credential
 * lifetime, because that is the window in which an operator can still be
 * holding a live device and wondering which phone took their invitation. Inside
 * that window a second start is told "already spent"; after it the record is
 * pruned, which is what keeps a long-lived host's directory bounded. */
const spentRetentionMs = 15 * 60 * 1000;

/** Pruning is what bounds the directory. An unspent invitation that timed out
 * goes now, because it can never be spent. A spent one waits out its
 * retention, because its refusal is still the answer an operator needs. A
 * record that cannot be read is left in place: deleting it would turn a
 * corrupt store into a working one and hide the fault, and the operator is
 * the only party who can decide what to do about it. */
function prune(env: Readonly<NodeJS.ProcessEnv>, now: number): void {
  const directory = invitationDirectory(env);
  let entries: string[];
  try {
    entries = readdirSync(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  for (const entry of entries) {
    const isSpentMarker = entry.endsWith(".spent");
    const isRecord = entry.endsWith(".json");
    if (!isSpentMarker && !isRecord) continue;
    const invitationId = entry.slice(0, isSpentMarker ? -".spent".length : -".json".length);
    if (!invitationPattern.test(invitationId)) continue;
    let record: StoredInvitation;
    try {
      const stored = readStoreFile(recordFile(env, invitationId));
      if (stored === null) {
        removeQuietly(join(directory, entry));
        continue;
      }
      record = parseInvitation(stored, invitationId);
    } catch {
      continue;
    }
    const expired = Date.parse(record.expiresAt) <= now;
    if (isSpentMarker) {
      if (expired && Date.parse(record.expiresAt) + spentRetentionMs <= now) {
        removeQuietly(join(directory, entry));
        removeQuietly(recordFile(env, invitationId));
      }
      continue;
    }
    if (expired) {
      removeQuietly(recordFile(env, invitationId));
      removeQuietly(spentMarker(env, invitationId));
    }
  }
}

function removeQuietly(path: string): void {
  try {
    unlinkSync(path);
  } catch {
    /* Pruning is best effort; a surviving file is bounded by the directory cap. */
  }
}

/** Spend an invitation, or name exactly why it cannot be spent. Every refusal
 * is a distinct stable code, because "please pair again" is useless to an
 * operator who does not know whether their invitation expired, was already
 * used by a second phone, or never existed.
 *
 * The order is the point: an unknown or malformed invitation never reaches the
 * marker, so a stranger cannot spend a token it cannot prove, and an expired
 * one is refused even if the marker could still be created. */
export function consumeInvitation(
  env: Readonly<NodeJS.ProcessEnv>,
  invitation: unknown,
  now: number = Date.now(),
): ConsumedInvitation {
  if (typeof invitation !== "string" || !invitationPattern.test(invitation)) {
    throw new CompanionStoreError("invalid_invitation", "pairing requires a host invitation");
  }
  // A missing record is an invitation refusal. A record that exists but cannot
  // be read is a store fault, and it stays a store fault: reporting it as "no
  // such invitation" would tell an operator their invitation was wrong when
  // the truth is that the host cannot read its own state.
  const stored = readStoreFile(recordFile(env, invitation));
  if (stored === null) throw new CompanionStoreError("invalid_invitation", "no such pairing invitation");
  const record = parseInvitation(stored, invitation);
  // The presented secret is proved against the stored digest in constant time,
  // the same way a device credential is, so a caller learns nothing from how
  // long a wrong invitation took to reject.
  const presented = Buffer.from(createHash("sha256").update(invitation, "utf8").digest("hex"), "hex");
  if (!timingSafeEqual(presented, Buffer.from(record.tokenHash, "hex")) ||
      record.workspaceId !== companionWorkspace(env)) {
    throw new CompanionStoreError("invalid_invitation", "pairing invitation does not belong to this workspace");
  }
  if (Date.parse(record.expiresAt) <= now) {
    throw new CompanionStoreError("expired_invitation", "pairing invitation has expired; mint a new one");
  }
  claim(invitationDirectory(env), spentMarker(env, invitation));
  return { invitationId: record.invitationId, workspaceId: record.workspaceId };
}

function claim(directory: string, marker: string): void {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  let handle: number;
  try {
    handle = openSync(marker, "wx", 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new CompanionStoreError("used_invitation", "pairing invitation was already spent by another device");
    }
    throw error;
  }
  try {
    fsyncSync(handle);
  } finally {
    closeSync(handle);
  }
}


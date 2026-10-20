import { createHash, randomBytes } from "node:crypto";
import { mkdir, open, readdir, readFile, rename, rm, stat, type FileHandle } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";

import { canonicalJson } from "../../ledger/src/canonical.ts";
import type { Json } from "../../connectors/src/recovery.ts";
import type {
  GarbageReport,
  RetentionReport,
} from "../../connectors/src/snapshot/store.ts";
import {
  digest,
  type OperationEvent,
  type OperationJournal,
  type Stage,
} from "./journal.ts";
import type { VaultReference } from "./vault.ts";
import { ARTIFACT_UNAVAILABLE, REFERENCE_ABSENT } from "./vault-refusals.ts";

export type VaultPin = { ownerId: string; kind: "recovery" | "operator" };
export const RETENTION_POLICY_VERSION = 1;
export type RetentionKind = "unpinned" | "recovery" | "operator";
export type RetentionPolicy = {
  readonly version: typeof RETENTION_POLICY_VERSION;
  /** "manual" is the shipped default: nothing expires and GC deletes nothing. */
  readonly mode: "manual" | "age";
  readonly ttlByKind: Readonly<Record<RetentionKind, number | null>>;
};
/** The default policy is deliberately non-invasive. Until an operator selects an
 * age policy the store keeps every artifact exactly as it does today. */
export const MANUAL_RETENTION_POLICY: RetentionPolicy = Object.freeze({
  version: RETENTION_POLICY_VERSION,
  mode: "manual",
  ttlByKind: Object.freeze({
    unpinned: null,
    recovery: null,
    operator: null,
  }),
});
/** Per-artifact retention evidence. Absent means "protect"; a pin is never
 * dropped here, so an artifact cannot release itself. A release is recorded
 * rather than implied by an empty record, so "protected because unknown" and
 * "collectable because an operator said so" stay distinguishable. */
export type VaultLifecycle = { pin?: VaultPin; release?: VaultRelease };
/** A recorded release: who released which pin, and when. */
export type VaultRelease = {
  readonly operatorId: string;
  readonly at: string;
  readonly released: { readonly ownerId: string; readonly kind: VaultPin["kind"] };
};
type ArtifactIdentity = { readonly digest: string };
const kinds: readonly RetentionKind[] = ["unpinned", "recovery", "operator"];

/** ponytail: the descriptor is small on purpose. A pinned kind has no TTL because
 * a pin is never evicted, and refusing that here is the invariant, not a comment. */
export function validateRetentionPolicy(
  policy: RetentionPolicy | unknown,
): RetentionPolicy {
  // The parameter is spelled `unknown` in practice: a policy arrives as JSON
  // text at a boundary and this check is the only thing that turns it into a
  // policy, so the type stays honest about accepting what it validates.
  const candidate = policy as RetentionPolicy;
  if (
    typeof candidate !== "object" ||
    candidate === null ||
    typeof candidate.ttlByKind !== "object" ||
    candidate.ttlByKind === null
  )
    throw new Error(
      "A recovery retention policy is an object with a version, a mode and a ttl block.",
    );
  if (candidate.version !== RETENTION_POLICY_VERSION)
    throw new Error(
      `Recovery retention policy version ${JSON.stringify(candidate.version)} is not the version this binary reads: ${RETENTION_POLICY_VERSION}.`,
    );
  if (candidate.mode !== "manual" && candidate.mode !== "age")
    throw new Error(
      `Recovery retention policy mode ${JSON.stringify(candidate.mode)} is neither manual nor age.`,
    );
  const ttlByKind = {} as Record<RetentionKind, number | null>;
  for (const kind of kinds) {
    if (!Object.hasOwn(candidate.ttlByKind, kind))
      throw new Error(
        `Recovery retention policy ttl block is missing ${kind}; it must name all of ${kinds.join(", ")}.`,
      );
    const ttl = candidate.ttlByKind[kind];
    if (ttl !== null && (!Number.isSafeInteger(ttl) || ttl < 1))
      throw new Error(
        "A recovery retention TTL is null or a positive millisecond count.",
      );
    if (kind !== "unpinned" && ttl !== null)
      throw new Error("A pinned recovery artifact kind cannot expire.");
    ttlByKind[kind] = ttl;
  }
  if (Object.keys(candidate.ttlByKind).length !== kinds.length)
    throw new Error(
      `Recovery retention policy ttl block carries ${JSON.stringify(Object.keys(candidate.ttlByKind))}: the valid kinds are ${kinds.join(", ")}.`,
    );
  if (candidate.mode === "manual" && ttlByKind.unpinned !== null)
    throw new Error("A manual recovery retention policy carries no TTL.");
  if (candidate.mode === "age" && ttlByKind.unpinned === null)
    throw new Error("An age recovery retention policy needs an unpinned TTL.");
  return Object.freeze({
    version: RETENTION_POLICY_VERSION,
    mode: candidate.mode,
    ttlByKind: Object.freeze(ttlByKind),
  });
}

export const evidenceDir = (index: string, workspace: string, artifactRoot: string): string => {
  if (!/^[\w-]{1,100}$/.test(workspace))
    throw new Error(`Invalid vault retention workspace ${JSON.stringify(workspace)}.`);
  // The evidence tree must not be the artifact tree, or any parent of it: the
  // reserved vault reads every file in a workspace directory as a legacy
  // artifact, so a `.meta` sidecar there makes the whole store unverifiable.
  // Refuse rather than write into a tree we just said is unsafe.
  const base = resolve(index);
  const root = resolve(artifactRoot);
  if (root === base || root.startsWith(`${base}${sep}`))
    throw new Error("Recovery vault retention evidence must live outside the artifact root.");
  return join(base, workspace);
};

/** A backup or a restore target must also live outside the artifact tree, for
 * the same reason evidence does: the reserved vault reads every file in a
 * workspace directory as a legacy artifact, so a manifest there makes the
 * whole store unverifiable. */
const outsideArtifactRoot = (path: string, artifactRoot: string): string => {
  const resolved = resolve(path),
    root = resolve(artifactRoot);
  if (resolved === root || resolved.startsWith(`${root}${sep}`))
    throw new Error(
      "Recovery vault retention evidence must live outside the artifact root.",
    );
  return resolved;
};
/** How long a lock may sit before a collector may reclaim it, and only if its
 * recorded owner is provably gone. Long enough to cover a slow collection,
 * short enough that a crash does not freeze retention until an operator
 * notices. */
const retentionLeaseMs = 15 * 60 * 1000;

const lifecyclePath = (dir: string, artifact: ArtifactIdentity): string => {
  if (!/^[a-f0-9]{64}$/.test(artifact.digest))
    throw new Error(REFERENCE_ABSENT);
  return join(dir, `${artifact.digest}.meta`);
};
const lifecycleRefusal = (detail: string): Error =>
  new Error(
    // The base sentence is load bearing: the collector tests match refusals
    // by its phrase, so every detail is appended after it. Details name
    // fields, keys and kinds; any file-supplied value is capped because a
    // hostile sidecar can make a field arbitrarily long.
    `Recovery artifact lifecycle is invalid; retention refused: ${detail}`,
  );
/** At most 40 characters of a file-supplied value reach a refusal. */
const bounded = (value: unknown): string => {
  const text = typeof value === "string" ? value : JSON.stringify(value) ?? "undefined";
  return text.length > 40 ? `${text.slice(0, 40)}...` : text;
};
const boundedKeys = (keys: readonly string[]): string => {
  const shown = keys.slice(0, 4).map((key) => (key.length > 40 ? `${key.slice(0, 40)}...` : key));
  return `${shown.join(", ")}${keys.length > 4 ? `, and ${keys.length - 4} more` : ""}`;
};
function vaultPin(value: unknown): VaultPin {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw lifecycleRefusal(
      `the pin is ${value === null ? "null" : Array.isArray(value) ? "an array" : typeof value}, not an object.`,
    );
  const record = value as Readonly<Record<string, unknown>>;
  const unexpected = Object.keys(record).filter(
    (key) => key !== "ownerId" && key !== "kind",
  );
  if (unexpected.length)
    throw lifecycleRefusal(
      `pin carries unexpected key ${boundedKeys(unexpected)}; a pin has ownerId and kind.`,
    );
  if (typeof record.ownerId !== "string" || !record.ownerId.length)
    throw lifecycleRefusal("pin.ownerId is missing or not a nonempty string.");
  if (record.kind !== "recovery" && record.kind !== "operator")
    throw lifecycleRefusal(
      `pin.kind is ${bounded(record.kind)}; kinds are recovery or operator.`,
    );
  return value as VaultPin;
}
export { vaultPin };
function vaultRelease(value: unknown): VaultRelease {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw lifecycleRefusal(
      `the release is ${value === null ? "null" : Array.isArray(value) ? "an array" : typeof value}, not an object.`,
    );
  const record = value as Readonly<Record<string, unknown>>;
  const unexpected = Object.keys(record).filter(
    (key) => key !== "operatorId" && key !== "at" && key !== "released",
  );
  if (unexpected.length)
    throw lifecycleRefusal(
      `release carries unexpected key ${boundedKeys(unexpected)}; a release has operatorId, at and released.`,
    );
  if (typeof record.operatorId !== "string" || !record.operatorId.length)
    throw lifecycleRefusal(
      "release.operatorId is missing or not a nonempty string.",
    );
  if (typeof record.at !== "string")
    throw lifecycleRefusal("release.at is missing or not a string.");
  return {
    operatorId: record.operatorId,
    at: record.at,
    released: vaultPin(record.released),
  };
}
/** Parse retention evidence text into a lifecycle, refusing anything this
 * store cannot prove rather than guessing a pin. Absent evidence is handled
 * by the caller; a present but unreadable or invalid record is always a
 * refusal, so both the file sidecar and the reserved-vault record column
 * share one reading of what counts as evidence. */
export function parseVaultLifecycle(raw: string): VaultLifecycle {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw lifecycleRefusal("the evidence text is not JSON.");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
    throw lifecycleRefusal(
      `the lifecycle record is ${parsed === null ? "null" : Array.isArray(parsed) ? "an array" : typeof parsed}, not an object.`,
    );
  const record = parsed as Readonly<Record<string, unknown>>;
  const unexpected = Object.keys(record).filter(
    (key) => key !== "pin" && key !== "release",
  );
  if (unexpected.length)
    throw lifecycleRefusal(
      `lifecycle carries unexpected key ${boundedKeys(unexpected)}; a lifecycle record has pin and release.`,
    );
  return {
    ...(Object.hasOwn(record, "pin") ? { pin: vaultPin(record.pin) } : {}),
    ...(Object.hasOwn(record, "release")
      ? { release: vaultRelease(record.release) }
      : {}),
  };
}

/** Absent evidence is reported as undefined so the caller protects the artifact.
 * Unreadable or invalid evidence refuses instead of guessing the pin. */
async function readLifecycle(
  dir: string,
  artifact: ArtifactIdentity,
): Promise<VaultLifecycle | undefined> {
  let bytes: Buffer;
  try {
    bytes = await readFile(lifecyclePath(dir, artifact));
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return undefined;
    throw new Error(
      "Recovery artifact lifecycle is unreadable; retention refused.",
    );
  }
  return parseVaultLifecycle(bytes.toString("utf8"));
}

export type VaultLifecycleRequest = {
  /** Root of the encrypted artifact vault. */
  readonly root: string;
  /** Retention evidence. It lives outside the artifact tree on purpose: the
   * reserved vault reads every file in a workspace directory as a legacy
   * artifact, so a sidecar there would break legacy migration. */
  readonly index: string;
  readonly workspace: string;
  readonly reference: VaultReference;
  readonly pin?: VaultPin;
};
/** R03 pin lifecycle. Recording no pin releases an artifact for retention;
 * removing a pin is refused, so nothing unpins itself. */
export async function markVaultLifecycle(
  request: VaultLifecycleRequest,
): Promise<void> {
  const dir = evidenceDir(request.index, request.workspace, request.root);
  // The same lock the collector holds. Without it, a pin recorded while a
  // collection is scanning is never observed, the artifact is deleted, and the
  // sidecar is removed with it, so the one record that protected the artifact
  // is destroyed by the run that was supposed to respect it.
  await withRetentionLock(dir, async () => {
    const path = lifecyclePath(dir, request.reference);
    const incoming: VaultLifecycle =
      request.pin === undefined ? {} : { pin: vaultPin(request.pin) };
    const existing = await readLifecycle(dir, request.reference);
    if (existing?.pin !== undefined && incoming.pin === undefined)
      throw new Error(
        `The recorded pin on ${request.reference.digest} in ${request.workspace} is not released by retention; unpin it instead.`,
      );
    if (
      existing?.pin !== undefined &&
      incoming.pin !== undefined &&
      (existing.pin.ownerId !== incoming.pin.ownerId ||
        existing.pin.kind !== incoming.pin.kind)
    )
      throw new Error(
        `The recorded pin ${existing.pin.ownerId}:${existing.pin.kind} does not match the stated pin ${incoming.pin!.ownerId}:${incoming.pin!.kind}; nothing was recorded.`,
      );
    const artifact = join(
        resolve(request.root),
        request.workspace,
        request.reference.digest,
      ),
      metadata = await stat(artifact).catch((error: unknown) => {
        if (!isNodeError(error) || error.code !== "ENOENT") throw error;
        throw new Error(ARTIFACT_UNAVAILABLE);
      });
    if (!metadata.isFile())
      throw new Error(ARTIFACT_UNAVAILABLE);
    const lifecycle: VaultLifecycle = { ...existing, ...incoming };
    if (existing !== undefined && canonicalJson(lifecycle) === canonicalJson(existing))
      return;
    await writeLifecycle(dir, request.reference, lifecycle);
  });
}

export type VaultPinReleaseRequest = {
  readonly root: string;
  readonly index: string;
  readonly workspace: string;
  readonly reference: VaultReference;
  /** The pin the operator believes is recorded. It must match the recorded one
 * exactly: a release names the protection it removes, so a stale operator
 * view cannot release a pin that has since been changed by someone else. */
  readonly pin: VaultPin;
  readonly operatorId: string;
  readonly clock?: () => Date;
};
/** R03 pin release. This is the supported way to remove a pin; the alternative
 * was editing the sidecar by hand, which is a retention bug rather than a
 * policy. It takes the same lock the collector holds, so a release cannot land
 * in the gap between a collector's scan and its unlink. The artifact itself is
 * never touched: only the record protecting it changes, and what it changes to
 * is a recorded release naming the operator, not an absent pin. */
export async function releaseVaultPin(
  request: VaultPinReleaseRequest,
): Promise<VaultRelease> {
  if (!/^[\w-]{1,120}$/.test(request.operatorId))
    throw new Error(
      `Recovery pin release operator is ${JSON.stringify(request.operatorId)}: it must be 1 to 120 word or hyphen characters.`,
    );
  const dir = evidenceDir(request.index, request.workspace, request.root);
  const held = vaultPin(request.pin);
  return withRetentionLock(dir, async () => {
    const existing = await readLifecycle(dir, request.reference);
    // Absent evidence means "protect", not "nothing to do": releasing an
    // artifact whose pin state this store cannot prove would convert unknown
    // into collectable, which is the one inference retention must never make.
    if (existing === undefined)
      throw new Error(
        `The artifact ${request.reference.digest} in ${request.workspace} has no recorded pin; a release cannot prove what protection to remove.`,
      );
    if (existing.pin === undefined)
      throw new Error(
        `The recorded lifecycle of ${request.reference.digest} in ${request.workspace} names no pin; it is already released for retention.`,
      );
    if (
      existing.pin.ownerId !== held.ownerId ||
      existing.pin.kind !== held.kind
    )
      throw new Error(
        `The recorded pin ${existing.pin.ownerId}:${existing.pin.kind} does not match the stated pin ${held.ownerId}:${held.kind}; nothing was released.`,
      );
    const release: VaultRelease = {
      operatorId: request.operatorId,
      at: (request.clock ?? (() => new Date()))().toISOString(),
      released: { ownerId: held.ownerId, kind: held.kind },
    };
    await writeLifecycle(dir, request.reference, {
      release: { ...existing.release, ...release },
    });
    return release;
  });
}

/** The sidecar write, shared by marking and releasing so both land the same
 * way: a synced temporary, renamed into place, never a partial record. */
async function writeLifecycle(
  dir: string,
  artifact: ArtifactIdentity,
  lifecycle: VaultLifecycle,
): Promise<void> {
  const path = lifecyclePath(dir, artifact),
    bytes = Buffer.from(canonicalJson(lifecycle));
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const temporary = `${path}.tmp-${randomBytes(16).toString("hex")}`;
  try {
    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
  if (process.platform !== "win32") {
    const parent = await open(dir, "r");
    try { await parent.sync(); } finally { await parent.close(); }
  }
}

export type RetentionRequest = {
  readonly workspace: string;
  readonly operationId: string;
  readonly policyDigest: string;
};
export type VaultGarbageOptions = {
  readonly root: string;
  readonly index: string;
  readonly workspace: string;
  readonly journal: OperationJournal;
  readonly operationId: string;
  readonly agentId: string;
  readonly runId: string;
  readonly policy?: RetentionPolicy;
  readonly clock?: () => Date;
  readonly authorize: (request: RetentionRequest) => Promise<boolean>;
};
export type VaultFile = {
  readonly path: string;
  readonly artifact: ArtifactIdentity;
  readonly size: number;
  readonly mtimeMs: number;
  readonly pinned: boolean;
};

/** R03 garbage collection for the encrypted file vault. It reuses the connector
 * snapshot protocol: only artifacts whose recorded lifecycle leaves them unpinned
 * and past the policy TTL are removed, and the run is a signed operation journal
 * chain, so a delete is never silent. */
export async function collectVaultGarbage(
  options: VaultGarbageOptions,
): Promise<GarbageReport> {
  const policy = validateRetentionPolicy(
    options.policy ?? MANUAL_RETENTION_POLICY,
  );
  const { workspace, operationId, agentId, runId } = options;
  const identityFields: [string, string][] = [
    ["workspace", workspace],
    ["operationId", operationId],
    ["agentId", agentId],
    ["runId", runId],
  ];
  for (const [field, value] of identityFields)
    if (!/^[\w-]{1,120}$/.test(value))
      throw new Error(
        `Recovery retention identity ${field} is ${JSON.stringify(value)}: it must be 1 to 120 word or hyphen characters.`,
      );
  const artifacts = join(resolve(options.root), workspace),
    evidence = evidenceDir(options.index, workspace, options.root);
  const clock = options.clock ?? (() => new Date());
  const policyDigest = digest(canonicalJson(policy));
  const identity: OperationEvent = {
    schema: "void.operation.v1",
    workspace,
    operationId,
    requestDigest: digest(canonicalJson({ workspace, policyDigest })),
    adapterId: "vault.retention",
    adapterVersion: "1",
    agentId,
    runId,
    at: clock().toISOString(),
    stage: "received",
    data: {
      policy: JSON.parse(canonicalJson(policy)) as Json,
      policyDigest,
    },
  };
  return options.journal.transaction(workspace, async (tx) => {
    const record = async (stage: Stage, data: Json = null) => {
      await tx.append({ ...identity, stage, data, at: clock().toISOString() });
    };
    await record("received", identity.data);
    if (!(await options.authorize({ workspace, operationId, policyDigest }))) {
      await record("denied");
      throw new Error("Vault retention was denied; no artifact was collected.");
    }
    await record("authorized");
    return withRetentionLock(evidence, async () => {
      // Unreadable lifecycle evidence throws here, before any delete, so a pin
      // this store cannot prove is never resolved in favour of deleting.
      const files = await vaultFiles(artifacts, evidence);
      const ttl = policy.ttlByKind.unpinned,
        now = clock().getTime();
      const expired =
          ttl === null ? [] : files.filter((file) => now - file.mtimeMs >= ttl),
        skippedPinned = expired.filter((file) => file.pinned).length;
      await record("prepared", {
        policyDigest,
        expired: expired.length,
        skippedPinned,
        retained: files.length - skippedPinned,
      });
      await record("dispatched", {
        policyDigest,
        deleting: expired.length - skippedPinned,
      });
      const report = await deleteArtifacts(
        expired.filter((file) => !file.pinned),
        evidence,
      );
      if (report.errors.length) {
        await record("failed", { policyDigest, errors: [...report.errors] });
        throw new Error(
          `File vault garbage collection failed: ${[...report.errors].join("; ")}`,
        );
      }
      const garbage: GarbageReport = {
        skippedPinned,
        retained: files.length - report.deleted - skippedPinned,
        deleted: report.deleted,
        freedBytes: report.freedBytes,
      };
      await record("succeeded", { policyDigest, ...garbage });
      return garbage;
    });
  });
}

/** A lock that outlives its process would freeze collection permanently, and
 * "delete the lock if it looks old" is how two collectors end up deleting at
 * once. The lease is therefore reclaimable only when the deadline has passed
 * AND the recorded owner is provably gone. Either check being uncertain keeps
 * the refusal, so the failure mode stays "no delete" rather than "two
 * deletes". */
type RetentionLockRecord = {
  readonly schema: "void.retention.lock.v1";
  readonly pid: number;
  readonly expiresAt: number;
};

async function reclaimableLock(lockPath: string, now: number): Promise<boolean> {
  const raw = await readFile(lockPath, "utf8").catch(() => null);
  if (raw === null) return true;
  let record: RetentionLockRecord;
  try {
    const parsed = JSON.parse(raw) as Partial<RetentionLockRecord>;
    if (parsed.schema !== "void.retention.lock.v1" || !Number.isInteger(parsed.pid) || !Number.isFinite(parsed.expiresAt)) return false;
    record = { schema: parsed.schema, pid: parsed.pid as number, expiresAt: parsed.expiresAt as number };
  } catch {
    // A lock we cannot read is a lock we will not take.
    return false;
  }
  if (record.expiresAt > now) return false;
  try {
    process.kill(record.pid, 0);
    return false;
  } catch (error) {
    return isNodeError(error) && error.code === "ESRCH";
  }
}

async function withRetentionLock<T>(
  dir: string,
  run: () => Promise<T>,
  now: () => number = Date.now,
): Promise<T> {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const lockPath = join(dir, ".retention.lock");
  let handle: FileHandle | null = null;
  for (let attempt = 0; attempt < 2 && handle === null; attempt += 1) {
    const opened = await open(lockPath, "wx", 0o600).catch((error: unknown) => {
      if (isNodeError(error) && error.code === "EEXIST") return null;
      throw error;
    });
    if (opened !== null) {
      handle = opened;
      break;
    }
    if (attempt === 0 && (await reclaimableLock(lockPath, now()))) {
      // Only reached once the deadline passed and the owner is provably gone.
      await rm(lockPath, { force: true });
      continue;
    }
    throw new Error(
      "Recovery vault retention is locked; review the active writer before retrying.",
    );
  }
  const held = handle as FileHandle;
  try {
    const record: RetentionLockRecord = {
      schema: "void.retention.lock.v1",
      pid: process.pid,
      expiresAt: now() + retentionLeaseMs,
    };
    await held.writeFile(JSON.stringify(record));
    await held.sync();
    return await run();
  } finally {
    await held.close();
    await rm(lockPath, { force: true });
  }
}

export async function vaultFiles(
  artifacts: string,
  evidence: string,
): Promise<VaultFile[]> {
  const names = await readdir(artifacts).catch((error: unknown) => {
    if (isNodeError(error) && error.code === "ENOENT") return [] as string[];
    throw error;
  });
  const files: VaultFile[] = [];
  for (const name of names) {
    if (!/^[a-f0-9]{64}$/.test(name)) continue;
    const path = join(artifacts, name);
    const metadata = await stat(path).catch((error: unknown) => {
      if (isNodeError(error) && error.code === "ENOENT") return undefined;
      throw error;
    });
    if (metadata === undefined || !metadata.isFile()) continue;
    // Recorded evidence is authoritative. Absent evidence is not permission: the
    // artifact stays protected until an operator releases it.
    const lifecycle = await readLifecycle(evidence, { digest: name });
    files.push({
      path,
      artifact: { digest: name },
      size: metadata.size,
      mtimeMs: metadata.mtimeMs,
      pinned: lifecycle === undefined || lifecycle.pin !== undefined,
    });
  }
  return files;
}

async function deleteArtifacts(
  files: readonly VaultFile[],
  evidence: string,
): Promise<RetentionReport> {
  let deleted = 0,
    freedBytes = 0;
  const errors: string[] = [];
  for (const file of files) {
    try {
      // Re-read the evidence immediately before the unlink rather than trusting
      // the scan-time snapshot. A pin recorded between the scan and this point
      // has to be able to stop the delete, and the sidecar must not be removed
      // for an artifact that was kept.
      const lifecycle = await readLifecycle(evidence, file.artifact);
      if (lifecycle === undefined || lifecycle.pin !== undefined) {
        errors.push(
          `${file.artifact.digest} gained evidence or a pin after the scan; not deleted`,
        );
        continue;
      }
      await rm(file.path);
      deleted += 1;
      freedBytes += file.size;
      await rm(lifecyclePath(evidence, file.artifact), { force: true });
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }
  return { deleted, freedBytes, errors };
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

/** R03 retention-index backup. The index is authoritative state, not derived
 * state: it is the only record of which artifacts are pinned, and a lost
 * sidecar is indistinguishable from an artifact that was never reviewed. It
 * cannot be rebuilt from the artifact tree, so it needs a backup that is
 * verified before it is trusted. */
export const RETENTION_INDEX_MANIFEST = "void.retention.index.v1";
export type RetentionIndexEntry = {
  /** Path relative to the index root, `workspace/digest.meta`. */
  readonly path: string;
  readonly bytes: number;
  readonly sha256: string;
};
export type RetentionIndexManifest = {
  readonly schema: typeof RETENTION_INDEX_MANIFEST;
  readonly entries: readonly RetentionIndexEntry[];
};
export type RetentionIndexBackupRequest = {
  /** The retention index root, the same one passed to the collector. */
  readonly index: string;
  /** Where the backup is written. Refused inside the artifact root. */
  readonly destination: string;
  readonly artifactRoot: string;
};
export type RetentionIndexRestoreRequest = {
  readonly index: string;
  /** The backup directory a previous `backupRetentionIndex` produced. */
  readonly source: string;
  readonly artifactRoot: string;
};

const indexEntries = (
  dir: string,
  prefix = "",
  /** The backup manifest is the backup's own descriptor, not evidence about an
   * artifact, so it is skipped when the tree being walked is a backup. */
  manifestName?: string,
): Promise<string[]> =>
  readdir(dir, { withFileTypes: true })
    .then((items) =>
      Promise.all(
        items.map(async (item) => {
          const name = prefix ? `${prefix}/${item.name}` : item.name;
          // The lock is a live coordination file, not evidence. Backing it up
          // would restore a stale lock and freeze collection on the next run.
          if (item.name === ".retention.lock") return [];
          if (!prefix && manifestName && item.name === manifestName) return [];
          if (item.isDirectory())
            return indexEntries(join(dir, item.name), name, manifestName);
          if (!item.isFile())
            throw new Error(
              "Recovery retention index holds an entry that is not a file; backup refused.",
            );
          if (!/^[a-f0-9]{64}\.meta$/.test(item.name))
            throw new Error(
              "Recovery retention index holds a file that is not artifact evidence; backup refused.",
            );
          return [name];
        }),
      ),
    )
    .then((groups) => groups.flat());

const readIndexEntry = async (
  source: string,
  entry: RetentionIndexEntry,
): Promise<Buffer> => {
  const path = join(source, ...entry.path.split("/")),
    bytes = await readFile(path);
  if (
    bytes.byteLength !== entry.bytes ||
    createHash("sha256").update(bytes).digest("hex") !== entry.sha256
  )
    throw new Error(
      "Recovery retention index backup does not match its manifest; restore refused.",
    );
  return bytes;
};

/** Copies every evidence sidecar and writes a manifest naming each one with its
 * byte count and digest. A sidecar that is not a digest-named evidence file is
 * refused rather than skipped: a backup that quietly omitted one would restore
 * an index that no longer protects what it used to. */
export async function backupRetentionIndex(
  request: RetentionIndexBackupRequest,
): Promise<RetentionIndexManifest> {
  const source = resolve(request.index),
    destination = outsideArtifactRoot(request.destination, request.artifactRoot);
  outsideArtifactRoot(source, request.artifactRoot);
  const names = (await stat(source).catch(() => {
    throw new Error("Recovery retention index is unavailable; backup refused.");
  })).isDirectory()
    ? await indexEntries(source)
    : [];
  const entries: RetentionIndexEntry[] = [];
  // The manifest is written last, so a backup interrupted before it lands has
  // no manifest and therefore cannot be mistaken for a complete one.
  for (const name of names.sort()) {
    const bytes = await readFile(join(source, ...name.split("/"))),
      path = join(destination, ...name.split("/"));
    entries.push({
      path: name,
      bytes: bytes.byteLength,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    });
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const temporary = `${path}.tmp-${randomBytes(16).toString("hex")}`;
    try {
      const handle = await open(temporary, "wx", 0o600);
      try {
        await handle.writeFile(bytes);
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(temporary, path);
    } finally {
      await rm(temporary, { force: true });
    }
  }
  const manifest: RetentionIndexManifest = {
    schema: RETENTION_INDEX_MANIFEST,
    entries,
  };
  await mkdir(destination, { recursive: true, mode: 0o700 });
  const manifestPath = join(destination, "retention-index.json"),
    temporary = `${manifestPath}.tmp-${randomBytes(16).toString("hex")}`;
  try {
    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(canonicalJson(manifest));
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, manifestPath);
  } finally {
    await rm(temporary, { force: true });
  }
  return manifest;
}

/** Restores an index from a backup. Every entry is read and verified against
 * the manifest before anything is installed, and an unlisted file in the
 * backup refuses the whole restore: a partial restore would leave the index
 * asserting protection it no longer holds. */
export async function restoreRetentionIndex(
  request: RetentionIndexRestoreRequest,
): Promise<RetentionIndexManifest> {
  const source = outsideArtifactRoot(request.source, request.artifactRoot);
  const target = outsideArtifactRoot(request.index, request.artifactRoot);
  let parsed: unknown;
  try {
    parsed = JSON.parse(
      await readFile(join(source, "retention-index.json"), "utf8"),
    );
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT")
      throw new Error(
        "Recovery retention index backup has no manifest; restore refused.",
      );
    throw new Error(
      "Recovery retention index backup manifest is unreadable; restore refused.",
    );
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    Array.isArray(parsed) ||
    !("schema" in parsed) ||
    parsed.schema !== RETENTION_INDEX_MANIFEST ||
    !("entries" in parsed) ||
    !Array.isArray(parsed.entries)
  )
    throw new Error(
      "Recovery retention index backup manifest is invalid; restore refused.",
    );
  const entries: RetentionIndexEntry[] = [];
  for (const entry of parsed.entries) {
    if (
      typeof entry !== "object" ||
      entry === null ||
      !("path" in entry) ||
      typeof entry.path !== "string" ||
      !/^[\w-]{1,100}\/[a-f0-9]{64}\.meta$/.test(entry.path) ||
      !("bytes" in entry) ||
      typeof entry.bytes !== "number" ||
      !Number.isSafeInteger(entry.bytes) ||
      entry.bytes < 0 ||
      !("sha256" in entry) ||
      typeof entry.sha256 !== "string" ||
      !/^[a-f0-9]{64}$/.test(entry.sha256)
    )
      throw new Error(
        "Recovery retention index backup manifest is invalid; restore refused.",
      );
    entries.push({
      path: entry.path,
      bytes: entry.bytes,
      sha256: entry.sha256,
    });
  }
  // Verify everything before installing anything, so a corrupt backup cannot
  // leave the index half-restored and half-asserting protection it lost.
  const verified = new Map<string, Buffer>();
  for (const entry of entries)
    verified.set(entry.path, await readIndexEntry(source, entry));
  const present = (
    await indexEntries(source, "", "retention-index.json")
  ).sort();
  const listed = entries.map((entry) => entry.path).sort();
  if (present.join("\n") !== listed.join("\n"))
    throw new Error(
      "Recovery retention index backup holds files its manifest does not list; restore refused.",
    );
  for (const [name, bytes] of verified) {
    const path = join(target, ...name.split("/"));
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const temporary = `${path}.tmp-${randomBytes(16).toString("hex")}`;
    try {
      const handle = await open(temporary, "wx", 0o600);
      try {
        await handle.writeFile(bytes);
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(temporary, path);
    } finally {
      await rm(temporary, { force: true });
    }
  }
  return { schema: RETENTION_INDEX_MANIFEST, entries };
}

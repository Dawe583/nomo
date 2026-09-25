import { randomBytes } from "node:crypto";
import { mkdir, open, readdir, readFile, rename, rm, stat, type FileHandle } from "node:fs/promises";
import { join, resolve, sep } from "node:path";

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
 * dropped here, so an artifact cannot release itself. */
export type VaultLifecycle = { pin?: VaultPin };
type ArtifactIdentity = { readonly digest: string };
const kinds: readonly RetentionKind[] = ["unpinned", "recovery", "operator"];

/** ponytail: the descriptor is small on purpose. A pinned kind has no TTL because
 * a pin is never evicted, and refusing that here is the invariant, not a comment. */
export function validateRetentionPolicy(
  policy: RetentionPolicy,
): RetentionPolicy {
  if (
    typeof policy !== "object" ||
    policy === null ||
    policy.version !== RETENTION_POLICY_VERSION ||
    (policy.mode !== "manual" && policy.mode !== "age") ||
    typeof policy.ttlByKind !== "object" ||
    policy.ttlByKind === null
  )
    throw new Error("Invalid recovery retention policy.");
  const ttlByKind = {} as Record<RetentionKind, number | null>;
  for (const kind of kinds) {
    if (!Object.hasOwn(policy.ttlByKind, kind))
      throw new Error("Invalid recovery retention policy.");
    const ttl = policy.ttlByKind[kind];
    if (ttl !== null && (!Number.isSafeInteger(ttl) || ttl < 1))
      throw new Error(
        "A recovery retention TTL is null or a positive millisecond count.",
      );
    if (kind !== "unpinned" && ttl !== null)
      throw new Error("A pinned recovery artifact kind cannot expire.");
    ttlByKind[kind] = ttl;
  }
  if (Object.keys(policy.ttlByKind).length !== kinds.length)
    throw new Error("Invalid recovery retention policy.");
  if (policy.mode === "manual" && ttlByKind.unpinned !== null)
    throw new Error("A manual recovery retention policy carries no TTL.");
  if (policy.mode === "age" && ttlByKind.unpinned === null)
    throw new Error("An age recovery retention policy needs an unpinned TTL.");
  return Object.freeze({
    version: RETENTION_POLICY_VERSION,
    mode: policy.mode,
    ttlByKind: Object.freeze(ttlByKind),
  });
}

const evidenceDir = (index: string, workspace: string, artifactRoot: string): string => {
  if (!/^[\w-]{1,100}$/.test(workspace))
    throw new Error("Invalid vault retention workspace.");
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
/** How long a lock may sit before a collector may reclaim it, and only if its
 * recorded owner is provably gone. Long enough to cover a slow collection,
 * short enough that a crash does not freeze retention until an operator
 * notices. */
const retentionLeaseMs = 15 * 60 * 1000;

const lifecyclePath = (dir: string, artifact: ArtifactIdentity): string => {
  if (!/^[a-f0-9]{64}$/.test(artifact.digest))
    throw new Error("Invalid or unavailable recovery reference.");
  return join(dir, `${artifact.digest}.meta`);
};
function vaultPin(value: unknown): VaultPin {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    Object.keys(value).some((key) => key !== "ownerId" && key !== "kind") ||
    !("ownerId" in value) ||
    typeof value.ownerId !== "string" ||
    !value.ownerId.length ||
    !("kind" in value) ||
    (value.kind !== "recovery" && value.kind !== "operator")
  )
    throw new Error("Recovery artifact lifecycle is invalid; retention refused.");
  return value as VaultPin;
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
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error(
      "Recovery artifact lifecycle is invalid; retention refused.",
    );
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    Array.isArray(parsed) ||
    Object.keys(parsed).some((key) => key !== "pin")
  )
    throw new Error(
      "Recovery artifact lifecycle is invalid; retention refused.",
    );
  const record = parsed as Readonly<Record<string, unknown>>;
  return Object.hasOwn(record, "pin") ? { pin: vaultPin(record.pin) } : {};
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
      throw new Error("A pinned recovery artifact is not released by retention.");
    if (
      existing?.pin !== undefined &&
      incoming.pin !== undefined &&
      (existing.pin.ownerId !== incoming.pin.ownerId ||
        existing.pin.kind !== incoming.pin.kind)
    )
      throw new Error("Recovery artifact pin conflicts with recorded lifecycle.");
    const artifact = join(
        resolve(request.root),
        request.workspace,
        request.reference.digest,
      ),
      metadata = await stat(artifact).catch(() => {
        throw new Error(
          "Recovery artifact is unavailable; lifecycle was not recorded.",
        );
      });
    if (!metadata.isFile())
      throw new Error(
        "Recovery artifact is unavailable; lifecycle was not recorded.",
      );
    const bytes = Buffer.from(canonicalJson({ ...existing, ...incoming }));
    if (existing !== undefined && bytes.toString() === canonicalJson(existing))
      return;
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
  });
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
type VaultFile = {
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
  for (const value of [workspace, operationId, agentId, runId])
    if (!/^[\w-]{1,120}$/.test(value))
      throw new Error("Invalid vault retention identity.");
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
        throw new Error("Recovery vault garbage collection failed.");
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

async function vaultFiles(
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
    const metadata = await stat(path);
    if (!metadata.isFile()) continue;
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

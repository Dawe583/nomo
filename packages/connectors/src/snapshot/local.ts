import { link, mkdir, open, readdir, readFile, rename, rm, stat } from "node:fs/promises";
import { join, resolve } from "node:path";

import { applyRedaction } from "./redact.ts";
import { makeGetError, makePutError, sha256Digest, type PutError, type RedactionHook, type RetentionPlan, type RetentionReport, type SnapshotNamespace, type SnapshotPin, type SnapshotReference, type SnapshotStore } from "./store.ts";

type SnapshotMeta = {
  readonly pin?: SnapshotPin;
  readonly keyId?: string;
  readonly expiresAt?: string;
};

export type LocalSnapshotStoreOptions = {
  readonly maxBytes?: number;
  readonly redaction?: RedactionHook;
  readonly clock?: () => Date;
  /** R03: key ids this store can read back; a put with a foreign keyId is refused. */
  readonly availableKeyIds?: readonly string[];
};

const DEFAULT_MAX_BYTES = 1024 * 1024 * 1024;
const namespaceOperations = new Map<string, Promise<void>>();

export function LocalSnapshotStore(root: string, options: LocalSnapshotStoreOptions = {}): SnapshotStore {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) throw new Error("Snapshot byte budget must be a nonnegative safe integer.");
  const redaction = options.redaction;
  const clock = options.clock ?? (() => new Date());
  const availableKeyIds = options.availableKeyIds;

  return {
    keyIds: availableKeyIds,
    async put(namespace, bytes, metadata = {}, putOptions = {}) {
      try {
        assertSafeNamespace(namespace);
      } catch (error) {
        throw makePutError("InvalidNamespace", namespace, "invalid snapshot namespace", error);
      }
      if (putOptions.keyId !== undefined) {
        const known = availableKeyIds?.includes(putOptions.keyId);
        if (availableKeyIds !== undefined && !known) {
          throw makePutError("InternalError", namespace, `snapshot key id ${putOptions.keyId} is not an available key id; no capture was stored.`);
        }
      }
      if (putOptions.pin !== undefined && (!putOptions.pin.ownerId.length || putOptions.pin.kind !== "recovery" && putOptions.pin.kind !== "operator")) {
        throw makePutError("InternalError", namespace, "snapshot pin requires an owner id and a recovery or operator kind.");
      }
      if (putOptions.expiresAt !== undefined && Number.isNaN(putOptions.expiresAt.getTime())) {
        throw makePutError("InternalError", namespace, "snapshot expiry must be a valid date.");
      }
      let redacted: Uint8Array;
      try {
        redacted = await applyRedaction(bytes, redaction, namespace, metadata);
      } catch (error) {
        throw makePutError("RedactionFailed", namespace, "snapshot redaction failed", error);
      }

      if (redacted.byteLength > maxBytes) throw makePutError("RetentionFailed", namespace, "Snapshot exceeds the configured byte budget; no capture was stored.");
      const digest = sha256Digest(redacted);
      const digestHex = digest.slice("sha256:".length);
      const dir = namespaceDir(root, namespace);
      const path = join(dir, digestHex);
      const meta: SnapshotMeta = {
        ...(putOptions.pin === undefined ? {} : { pin: putOptions.pin }),
        ...(putOptions.keyId === undefined ? {} : { keyId: putOptions.keyId }),
        ...(putOptions.expiresAt === undefined ? {} : { expiresAt: putOptions.expiresAt.toISOString() }),
      };

      try { snapshotMeta(meta); }
      catch (error) { throw makePutError("InternalError", namespace, "invalid snapshot metadata", error); }

      return withNamespaceLock(root, namespace, async () => {
        const tmp = join(dir, `.tmp-${process.pid}-${clock().getTime()}-${Math.random().toString(16).slice(2)}`);
        try {
          await mkdir(dir, { recursive: true, mode: 0o700 });
          const evictions = await budgetEvictions(root, namespace, maxBytes, path, redacted.byteLength);
          const existing = await readFile(path).catch((error: unknown) => {
            if (isNodeError(error) && error.code === "ENOENT") return undefined;
            throw error;
          });
          if (existing === undefined) {
            await writeAll(tmp, redacted);
            try {
              await link(tmp, path);
            } catch (error) {
              const raced = await readFile(path).catch(() => undefined);
              if (raced === undefined || sha256Digest(raced) !== digest) throw error;
            } finally {
              await rm(tmp, { force: true });
            }
          } else if (sha256Digest(existing) !== digest) {
            throw new Error("Existing snapshot bytes do not match their digest path.");
          }
          await writeSidecar(dir, digestHex, meta);
          const report = await deleteSnapshots(evictions);
          if (report.errors.length)
            throw makePutError("RetentionFailed", namespace, "snapshot retention failed", report.errors);
        } catch (error) {
          await rm(tmp, { force: true });
          if (isPutError(error)) throw error;
          throw makePutError("WriteFailed", namespace, "snapshot write failed", error);
        }

        return { digest, reference: { namespace, digest, uri: `file://${path}` } };
      }).catch((error: unknown) => {
        if (isPutError(error)) throw error;
        throw makePutError("WriteFailed", namespace, "snapshot write failed", error);
      });
    },


    async get(reference) {
      try {
        assertSafeReference(reference);
      } catch (error) {
        throw makeGetError("InvalidReference", reference, "invalid snapshot reference", error);
      }
      const path = pathForReference(root, reference);
      let bytes: Uint8Array;
      try {
        bytes = await readFile(path);
      } catch (error) {
        throw makeGetError("SnapshotUnavailable", reference, "snapshot is unavailable", error);
      }
      const digest = sha256Digest(bytes);
      if (digest !== reference.digest) {
        throw makeGetError("DigestMismatch", reference, "snapshot digest mismatch");
      }
      return bytes;
    },

    async retention(namespace) {
      assertSafeNamespace(namespace);
      const retainedBytes = await withNamespaceLock(root, namespace, async () => {
        const files = await snapshotFiles(root, namespace);
        return files.reduce((total, file) => total + file.size, 0);
      });
      return {
        namespace,
        retainedBytes,
        deleteOlderThan: (cutoff) => withNamespaceLock(root, namespace, () => deleteOlderThan(root, namespace, cutoff)),
      } satisfies RetentionPlan;
    },

    async collectGarbage(namespace, { cutoff }) {
      assertSafeNamespace(namespace);
      const cutoffMs = validCutoff(cutoff);
      return withNamespaceLock(root, namespace, async () => {
        const files = await snapshotFiles(root, namespace);
        const expired = files.filter((file) => file.mtimeMs < cutoffMs);
        const skippedPinned = expired.filter((file) => file.pinned).length;
        const report = await deleteSnapshots(expired.filter((file) => !file.pinned));
        if (report.errors.length) throw new Error("Snapshot garbage collection failed.");
        return { skippedPinned, retained: files.length - report.deleted - skippedPinned, deleted: report.deleted, freedBytes: report.freedBytes };
      });
    },

  } satisfies SnapshotStore;
}

function withNamespaceLock<T>(root: string, namespace: SnapshotNamespace, run: () => Promise<T>): Promise<T> {
  assertSafeNamespace(namespace);
  const directory = namespaceDir(resolve(root), namespace);
  const next = (namespaceOperations.get(directory) ?? Promise.resolve()).catch(() => {}).then(async () => {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    // Match the manifest writer: competing or stale locks refuse mutation.
    const lockPath = join(directory, ".retention.lock");
    const handle = await open(lockPath, "wx", 0o600);
    try { return await run(); }
    finally { await handle.close(); await rm(lockPath); }
  });
  const settled = next.then(() => {}, () => {});
  namespaceOperations.set(directory, settled);
  void settled.then(() => { if (namespaceOperations.get(directory) === settled) namespaceOperations.delete(directory); });
  return next;
}

function sidecarPath(snapshotPath: string): string {
  return `${snapshotPath}.meta`;
}

async function writeSidecar(dir: string, digestHex: string, incoming: SnapshotMeta): Promise<void> {
  const snapshotPath = join(dir, digestHex);
  const target = sidecarPath(snapshotPath);
  const existing = await readSidecar(snapshotPath);
  const meta = mergeMeta(existing, incoming);
  if (existing !== undefined && JSON.stringify(existing) === JSON.stringify(meta)) return;
  const bytes = new TextEncoder().encode(JSON.stringify(meta));
  if (existing === undefined) {
    await writeAll(target, bytes);
    return;
  }
  const temporary = `${target}.tmp-${process.pid}-${Math.random().toString(16).slice(2)}`;
  try {
    await writeAll(temporary, bytes);
    await rename(temporary, target);
  } finally {
    await rm(temporary, { force: true });
  }
}

function mergeMeta(existing: SnapshotMeta | undefined, incoming: SnapshotMeta): SnapshotMeta {
  if (existing === undefined) return incoming;
  if (existing.pin !== undefined && incoming.pin !== undefined &&
      (existing.pin.ownerId !== incoming.pin.ownerId || existing.pin.kind !== incoming.pin.kind))
    throw new Error("Snapshot pin metadata conflicts with an existing capture.");
  for (const field of ["keyId", "expiresAt"] as const) {
    if (existing[field] !== undefined && incoming[field] !== undefined && existing[field] !== incoming[field])
      throw new Error(`Snapshot ${field} metadata conflicts with an existing capture.`);
  }
  return { ...incoming, ...existing };
}

async function readSidecar(snapshotPath: string, required = false): Promise<SnapshotMeta | undefined> {
  let bytes: Buffer;
  try {
    bytes = await readFile(sidecarPath(snapshotPath));
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      if (!required) return undefined;
      throw new Error("Snapshot metadata is missing; retention refused.");
    }
    throw new Error("Snapshot metadata is unreadable; retention refused.");
  }
  let parsed: unknown;
  try { parsed = JSON.parse(bytes.toString("utf8")); }
  catch { throw new Error("Snapshot metadata is invalid; retention refused."); }
  return snapshotMeta(parsed);
}

function snapshotMeta(parsed: unknown): SnapshotMeta {
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
    throw new Error("Snapshot metadata is invalid; retention refused.");
  const record = parsed as Readonly<Record<string, unknown>>;
  const pin = record.pin;
  if (
    Object.keys(record).some((key) => !["pin", "keyId", "expiresAt"].includes(key)) ||
    (Object.hasOwn(record, "pin") && (
      typeof pin !== "object" || pin === null || Array.isArray(pin) ||
      Object.keys(pin).some((key) => key !== "ownerId" && key !== "kind") ||
      !("ownerId" in pin) || typeof pin.ownerId !== "string" || !pin.ownerId.length ||
      !("kind" in pin) || (pin.kind !== "recovery" && pin.kind !== "operator")
    )) ||
    (Object.hasOwn(record, "keyId") && (typeof record.keyId !== "string" || !record.keyId.length)) ||
    (Object.hasOwn(record, "expiresAt") && (
      typeof record.expiresAt !== "string" || !Number.isFinite(Date.parse(record.expiresAt))
    ))
  ) throw new Error("Snapshot metadata is invalid; retention refused.");
  return record as SnapshotMeta;
}

/** R03 sidecar metadata for one reference; undefined when the snapshot has none. */
export async function readEntryMeta(reference: SnapshotReference): Promise<SnapshotMeta | undefined> {
  // The reference uri already includes the namespace directory; the sidecar
  // sits beside the snapshot file.
  const snapshotPath = reference.uri.replace(/^file:\/\//, "");
  return readSidecar(snapshotPath);
}

async function writeAll(path: string, bytes: Uint8Array): Promise<void> {
  const handle = await open(path, "wx", 0o600);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function budgetEvictions(root: string, namespace: SnapshotNamespace, maxBytes: number, incomingPath: string, incomingBytes: number): Promise<SnapshotFile[]> {
  const files = await snapshotFiles(root, namespace);
  await readSidecar(incomingPath);
  let retained = incomingBytes + files.reduce((total, file) => total + (file.path === incomingPath ? 0 : file.size), 0);
  const evictions: SnapshotFile[] = [];
  for (const file of files.sort((left, right) => left.mtimeMs - right.mtimeMs)) {
    if (retained <= maxBytes) break;
    if (file.pinned || file.path === incomingPath) continue;
    evictions.push(file);
    retained -= file.size;
  }
  // Check the entire admission before changing bytes or evicting an old inverse.
  if (retained > maxBytes)
    throw makePutError("RetentionFailed", namespace, "Protected snapshots exhaust the byte budget; no capture was stored.");
  return evictions;
}

async function deleteSnapshots(files: readonly SnapshotFile[]): Promise<RetentionReport> {
  let deleted = 0;
  let freedBytes = 0;
  const errors: string[] = [];
  for (const file of files) {
    try {
      await rm(file.path);
      deleted += 1;
      freedBytes += file.size;
      await rm(sidecarPath(file.path), { force: true });
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }
  return { deleted, freedBytes, errors };
}

async function deleteOlderThan(root: string, namespace: SnapshotNamespace, cutoff: Date): Promise<RetentionReport> {
  const cutoffMs = validCutoff(cutoff);
  const files = await snapshotFiles(root, namespace);
  return deleteSnapshots(files.filter((file) => !file.pinned && file.mtimeMs < cutoffMs));
}

function validCutoff(cutoff: Date): number {
  const timestamp = cutoff instanceof Date ? cutoff.getTime() : NaN;
  if (!Number.isFinite(timestamp))
    throw new Error(`Snapshot retention cutoff ${JSON.stringify(cutoff)} must be a valid date.`);
  return timestamp;
}

type SnapshotFile = { readonly path: string; readonly size: number; readonly mtimeMs: number; readonly pinned: boolean };

async function snapshotFiles(root: string, namespace: SnapshotNamespace): Promise<SnapshotFile[]> {
  const dir = namespaceDir(root, namespace);
  const names = await readdir(dir).catch((error: unknown) => {
    if (isNodeError(error) && error.code === "ENOENT") {
      return [];
    }
    throw error;
  });
  const files: SnapshotFile[] = [];
  for (const name of names) {
    if (!/^[a-f0-9]{64}$/.test(name)) {
      continue;
    }
    const path = join(dir, name);
    const stats = await stat(path);
    if (stats.isFile()) {
      const meta = await readSidecar(path, true);
      files.push({ path, size: stats.size, mtimeMs: stats.mtimeMs, pinned: meta?.pin !== undefined });
    }
  }
  return files;
}

function namespaceDir(root: string, namespace: SnapshotNamespace): string {
  return join(root, encodeURIComponent(namespace));
}

function pathForReference(root: string, reference: SnapshotReference): string {
  return join(namespaceDir(root, reference.namespace), reference.digest.slice("sha256:".length));
}

function assertSafeNamespace(namespace: SnapshotNamespace): void {
  if (namespace.length === 0 || namespace.includes("/") || namespace.includes("\\") || namespace === "." || namespace === "..") {
    throw new Error(`Invalid snapshot namespace ${JSON.stringify(namespace)}.`);
  }
}

function assertSafeReference(reference: SnapshotReference): void {
  assertSafeNamespace(reference.namespace);
  if (!/^sha256:[a-f0-9]{64}$/.test(reference.digest)) {
    throw new Error(`Invalid snapshot digest ${JSON.stringify(reference.digest)}.`);
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function isPutError(error: unknown): error is PutError {
  return error instanceof Error && "kind" in error && "namespace" in error;
}

import { mkdir, open, readdir, readFile, rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";

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
      const tmp = join(dir, `.tmp-${process.pid}-${clock().getTime()}-${Math.random().toString(16).slice(2)}`);

      try {
        await mkdir(dir, { recursive: true, mode: 0o700 });
        await writeAll(tmp, redacted);
        await rename(tmp, path).catch(async (error: unknown) => {
          await rm(tmp, { force: true });
          const existing = await readFile(path).catch(() => undefined);
          if (existing !== undefined && sha256Digest(existing) === digest) {
            return;
          }
          throw error;
        });
        if (putOptions.pin !== undefined || putOptions.expiresAt !== undefined || putOptions.keyId !== undefined) {
          await writeSidecar(dir, digestHex, {
            ...(putOptions.pin === undefined ? {} : { pin: putOptions.pin }),
            ...(putOptions.keyId === undefined ? {} : { keyId: putOptions.keyId }),
            ...(putOptions.expiresAt === undefined ? {} : { expiresAt: putOptions.expiresAt.toISOString() }),
          });
        }
        await enforceBudget(root, namespace, maxBytes);
      } catch (error) {
        if (isPutError(error)) {
          throw error;
        }
        throw makePutError("WriteFailed", namespace, "snapshot write failed", error);
      }

      return { digest, reference: { namespace, digest, uri: `file://${path}` } };
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
      const files = await snapshotFiles(root, namespace);
      const retainedBytes = files.reduce((total, file) => total + file.size, 0);
      return {
        namespace,
        retainedBytes,
        deleteOlderThan: (cutoff) => deleteOlderThan(root, namespace, cutoff),
      } satisfies RetentionPlan;
    },

    async collectGarbage(namespace, { cutoff }) {
      assertSafeNamespace(namespace);
      const dir = namespaceDir(root, namespace);
      const files = await snapshotFiles(root, namespace);
      let deleted = 0;
      let freedBytes = 0;
      let skippedPinned = 0;
      for (const file of files) {
        if (file.mtimeMs >= cutoff.getTime()) {
          continue;
        }
        const meta = await readSidecar(dir, file.path);
        if (meta?.pin !== undefined) {
          skippedPinned += 1;
          continue;
        }
        try {
          await rm(file.path, { force: true });
          await rm(sidecarPath(file.path), { force: true });
          deleted += 1;
          freedBytes += file.size;
        } catch {
          // A file another writer removed stays counted as retained.
        }
      }
      return { skippedPinned, retained: files.length - deleted - skippedPinned, deleted, freedBytes };
    },
  } satisfies SnapshotStore;
}

function sidecarPath(snapshotPath: string): string {
  return `${snapshotPath}.meta`;
}

async function writeSidecar(dir: string, digestHex: string, meta: SnapshotMeta): Promise<void> {
  await writeAll(join(dir, `${digestHex}.meta`), new TextEncoder().encode(JSON.stringify(meta)));
}

async function readSidecar(dir: string, snapshotPath: string): Promise<SnapshotMeta | undefined> {
  const bytes = await readFile(sidecarPath(snapshotPath)).catch(() => undefined);
  if (bytes === undefined) return undefined;
  try {
    const parsed = JSON.parse(bytes.toString("utf8")) as Readonly<Record<string, unknown>>;
    const pin = parsed.pin as SnapshotPin | undefined;
    const keyId = typeof parsed.keyId === "string" ? parsed.keyId : undefined;
    const expiresAt = typeof parsed.expiresAt === "string" ? parsed.expiresAt : undefined;
    if (pin === undefined && keyId === undefined && expiresAt === undefined) return undefined;
    return { ...(pin === undefined ? {} : { pin }), ...(keyId === undefined ? {} : { keyId }), ...(expiresAt === undefined ? {} : { expiresAt }) };
  } catch {
    return undefined;
  }
}

/** R03 sidecar metadata for one reference; undefined when the snapshot has none. */
export async function readEntryMeta(reference: SnapshotReference): Promise<SnapshotMeta | undefined> {
  // The reference uri already includes the namespace directory; the sidecar
  // sits beside the snapshot file.
  const snapshotPath = reference.uri.replace(/^file:\/\//, "");
  return readSidecar(snapshotPath, snapshotPath);
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

async function enforceBudget(root: string, namespace: SnapshotNamespace, maxBytes: number): Promise<RetentionReport> {
  const files = await snapshotFiles(root, namespace);
  let retained = files.reduce((total, file) => total + file.size, 0);
  let deleted = 0;
  let freedBytes = 0;
  const errors: string[] = [];

  for (const file of files.sort((left, right) => left.mtimeMs - right.mtimeMs)) {
    if (retained <= maxBytes) {
      break;
    }
    try {
      await rm(file.path, { force: true });
      retained -= file.size;
      deleted += 1;
      freedBytes += file.size;
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }

  if (errors.length > 0) {
    throw makePutError("RetentionFailed", namespace, "snapshot retention failed", errors);
  }
  return { deleted, freedBytes, errors };
}

async function deleteOlderThan(root: string, namespace: SnapshotNamespace, cutoff: Date): Promise<RetentionReport> {
  const files = await snapshotFiles(root, namespace);
  let deleted = 0;
  let freedBytes = 0;
  const errors: string[] = [];
  for (const file of files) {
    if (file.mtimeMs >= cutoff.getTime()) {
      continue;
    }
    try {
      await rm(file.path, { force: true });
      deleted += 1;
      freedBytes += file.size;
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }
  return { deleted, freedBytes, errors };
}

type SnapshotFile = { readonly path: string; readonly size: number; readonly mtimeMs: number };

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
      files.push({ path, size: stats.size, mtimeMs: stats.mtimeMs });
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
    throw new Error("invalid snapshot namespace");
  }
}

function assertSafeReference(reference: SnapshotReference): void {
  assertSafeNamespace(reference.namespace);
  if (!/^sha256:[a-f0-9]{64}$/.test(reference.digest)) {
    throw new Error("invalid snapshot digest");
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function isPutError(error: unknown): error is PutError {
  return error instanceof Error && "kind" in error && "namespace" in error;
}

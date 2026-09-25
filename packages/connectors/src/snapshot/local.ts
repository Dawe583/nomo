import {
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  rm,
  stat,
} from "node:fs/promises";
import { join, resolve } from "node:path";

import { applyRedaction } from "./redact.ts";
import {
  makeGetError,
  makePutError,
  sha256Digest,
  type ArtifactState,
  type GarbagePolicy,
  type GarbageReport,
  type PutError,
  type RedactionHook,
  type RetentionPlan,
  type RetentionReport,
  type SnapshotNamespace,
  type SnapshotPin,
  type SnapshotPutOptions,
  type SnapshotReference,
  type SnapshotStore,
} from "./store.ts";

/**
 * Local content addressed snapshot store.
 *
 * Two constraints shape this file. Artifact facts, pin expiry and key binding,
 * live in a durable per namespace journal rather than in memory, because a pin
 * that evaporates on restart turns a retention promise into a deletion. And
 * every deletion path here, budget eviction, delete by age and garbage
 * collection, refuses an artifact whose state it cannot prove, so an
 * uninterpretable journal leaks bytes instead of destroying the only before
 * image an inverse still needs.
 */

export type LocalSnapshotStoreOptions = {
  readonly maxBytes?: number;
  readonly redaction?: RedactionHook;
  readonly clock?: () => Date;
  /** Keys the operator holds. Absent means none, so a keyed artifact is unreadable. */
  readonly availableKeyIds?: readonly string[];
};

const DEFAULT_MAX_BYTES = 1024 * 1024 * 1024;
const ARTIFACT_LOG = "artifacts.jsonl";

type ArtifactRecord = {
  readonly digest: string;
  readonly keyId?: string;
  readonly expiresAt?: string;
  readonly pin?: SnapshotPin;
  readonly formatVersion?: number;
  /** Two different key bindings cannot both decrypt the same bytes. */
  readonly conflicted?: boolean;
  /** The record exists but cannot be read, so it proves nothing. */
  readonly uninterpretable?: boolean;
};

const journalWrites = new Map<string, Promise<void>>();

export function LocalSnapshotStore(
  root: string,
  options: LocalSnapshotStoreOptions = {},
): SnapshotStore {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0)
    throw new Error("Snapshot byte budget must be a nonnegative safe integer.");
  const redaction = options.redaction;
  const clock = options.clock ?? (() => new Date());
  const available = new Set(options.availableKeyIds ?? []);

  return {
    async put(namespace, bytes, metadata = {}, putOptions = {}) {
      try {
        assertSafeNamespace(namespace);
        assertPutOptions(namespace, putOptions);
      } catch (error) {
        if (isPutError(error)) {
          throw error;
        }
        throw makePutError(
          "InvalidNamespace",
          namespace,
          "invalid snapshot namespace or put options",
          error,
        );
      }
      let redacted: Uint8Array;
      try {
        redacted = await applyRedaction(bytes, redaction, namespace, metadata);
      } catch (error) {
        throw makePutError(
          "RedactionFailed",
          namespace,
          "snapshot redaction failed",
          error,
        );
      }

      if (redacted.byteLength > maxBytes)
        throw makePutError(
          "RetentionFailed",
          namespace,
          "Snapshot exceeds the configured byte budget; no capture was stored.",
        );
      const digest = sha256Digest(redacted);
      const digestHex = digest.slice("sha256:".length);
      const dir = namespaceDir(root, namespace);
      const path = join(dir, digestHex);
      const tmp = join(
        dir,
        `.tmp-${process.pid}-${clock().getTime()}-${Math.random().toString(16).slice(2)}`,
      );

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
        // The record follows the bytes, never the other way round. A crash in
        // between leaves an artifact with no record, which garbage collection
        // retains forever rather than treating as unpinned.
        await recordArtifact(dir, captureRecord(digest, putOptions));
        await enforceBudget(root, namespace, maxBytes, available, digest);
      } catch (error) {
        if (isPutError(error)) {
          throw error;
        }
        throw makePutError(
          "WriteFailed",
          namespace,
          "snapshot write failed",
          error,
        );
      }

      return {
        digest,
        reference: { namespace, digest, uri: `file://${path}` },
      };
    },

    async get(reference) {
      try {
        assertSafeReference(reference);
      } catch (error) {
        throw makeGetError(
          "InvalidReference",
          reference,
          "invalid snapshot reference",
          error,
        );
      }
      const state = await artifactState(root, reference, available);
      if (
        state.recorded &&
        state.keyId !== undefined &&
        !available.has(state.keyId)
      ) {
        throw makeGetError(
          "KeyUnavailable",
          reference,
          `snapshot recovery key ${state.keyId} is not available in this store`,
        );
      }
      const path = pathForReference(root, reference);
      let bytes: Uint8Array;
      try {
        bytes = await readFile(path);
      } catch (error) {
        throw makeGetError(
          "SnapshotUnavailable",
          reference,
          "snapshot is unavailable",
          error,
        );
      }
      const digest = sha256Digest(bytes);
      if (digest !== reference.digest) {
        throw makeGetError(
          "DigestMismatch",
          reference,
          "snapshot digest mismatch",
        );
      }
      return bytes;
    },

    async artifactState(reference) {
      try {
        assertSafeReference(reference);
      } catch (error) {
        throw makeGetError(
          "InvalidReference",
          reference,
          "invalid snapshot reference",
          error,
        );
      }
      return artifactState(root, reference, available);
    },

    availableKeyIds: () => [...available],

    async collectGarbage(namespace, policy) {
      return collectGarbage(root, namespace, policy, available);
    },

    async retention(namespace) {
      assertSafeNamespace(namespace);
      const files = await snapshotFiles(root, namespace);
      const retainedBytes = files.reduce((total, file) => total + file.size, 0);
      return {
        namespace,
        retainedBytes,
        deleteOlderThan: (cutoff) =>
          deleteOlderThan(root, namespace, cutoff, available),
      } satisfies RetentionPlan;
    },
  } satisfies SnapshotStore;
}

function captureRecord(
  digest: `sha256:${string}`,
  options: SnapshotPutOptions,
): ArtifactRecord {
  return {
    digest,
    keyId: options.keyId,
    expiresAt: options.expiresAt?.toISOString(),
    pin: options.pin,
    formatVersion: options.formatVersion,
  };
}

function assertPutOptions(
  namespace: SnapshotNamespace,
  options: SnapshotPutOptions,
): void {
  if (options.expiresAt !== undefined) {
    if (
      !(options.expiresAt instanceof Date) ||
      !Number.isFinite(options.expiresAt.getTime())
    ) {
      throw makePutError(
        "InvalidOptions",
        namespace,
        "invalid snapshot expiresAt",
      );
    }
  }
  if (
    options.pin !== undefined &&
    (typeof options.pin.ownerId !== "string" ||
      options.pin.ownerId === "" ||
      typeof options.pin.kind !== "string" ||
      options.pin.kind === "")
  ) {
    throw makePutError("InvalidOptions", namespace, "invalid snapshot pin");
  }
  if (
    options.keyId !== undefined &&
    (typeof options.keyId !== "string" || options.keyId === "")
  ) {
    throw makePutError("InvalidOptions", namespace, "invalid snapshot keyId");
  }
  if (
    options.formatVersion !== undefined &&
    (!Number.isSafeInteger(options.formatVersion) || options.formatVersion < 0)
  ) {
    throw makePutError(
      "InvalidOptions",
      namespace,
      "invalid snapshot formatVersion",
    );
  }
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

async function recordArtifact(
  dir: string,
  record: ArtifactRecord,
): Promise<void> {
  const line = `${JSON.stringify({
    digest: record.digest,
    ...(record.keyId === undefined ? {} : { keyId: record.keyId }),
    ...(record.expiresAt === undefined ? {} : { expiresAt: record.expiresAt }),
    ...(record.pin === undefined ? {} : { pin: record.pin }),
    ...(record.formatVersion === undefined
      ? {}
      : { formatVersion: record.formatVersion }),
  })}\n`;
  await serializeJournal(dir, async () => {
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const handle = await open(join(dir, ARTIFACT_LOG), "a", 0o600);
    try {
      await handle.writeFile(line);
      await handle.sync();
    } finally {
      await handle.close();
    }
  });
}

function serializeJournal(
  dir: string,
  run: () => Promise<void>,
): Promise<void> {
  const key = resolve(dir);
  const next = (journalWrites.get(key) ?? Promise.resolve())
    .catch(() => {})
    .then(run);
  journalWrites.set(key, next);
  void next
    .finally(() => {
      if (journalWrites.get(key) === next) journalWrites.delete(key);
    })
    .catch(() => {});
  return next;
}

async function readArtifactRecords(
  dir: string,
): Promise<Map<string, ArtifactRecord>> {
  const records = new Map<string, ArtifactRecord>();
  let text: string;
  try {
    text = await readFile(join(dir, ARTIFACT_LOG), "utf8");
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return records;
    }
    throw error;
  }
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    const record = parseArtifactRecord(trimmed);
    // A torn tail is the ordinary crash artifact of an append. Reading stops
    // there: whatever follows is unknown, and unknown state retains bytes.
    if (record === null) break;
    mergeRecord(records, record);
  }
  return records;
}

function parseArtifactRecord(line: string): ArtifactRecord | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const raw = parsed as Readonly<Record<string, unknown>>;
  if (typeof raw.digest !== "string" || !raw.digest.startsWith("sha256:"))
    return null;
  const pin = parsePin(raw.pin);
  const keyId =
    raw.keyId === undefined
      ? undefined
      : typeof raw.keyId === "string" && raw.keyId !== ""
        ? raw.keyId
        : undefined;
  const expiresAt =
    typeof raw.expiresAt === "string" &&
    Number.isFinite(Date.parse(raw.expiresAt))
      ? raw.expiresAt
      : undefined;
  const formatVersion = Number.isSafeInteger(raw.formatVersion)
    ? (raw.formatVersion as number)
    : undefined;
  return {
    digest: raw.digest,
    keyId,
    expiresAt,
    pin,
    formatVersion,
    uninterpretable:
      raw.pin !== undefined && pin === undefined ? true : undefined,
  };
}

function parsePin(value: unknown): SnapshotPin | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const raw = value as Readonly<Record<string, unknown>>;
  if (
    typeof raw.ownerId !== "string" ||
    raw.ownerId === "" ||
    typeof raw.kind !== "string" ||
    raw.kind === ""
  )
    return undefined;
  return { ownerId: raw.ownerId, kind: raw.kind };
}

function mergeRecord(
  records: Map<string, ArtifactRecord>,
  record: ArtifactRecord,
): void {
  const existing = records.get(record.digest);
  if (existing === undefined) {
    records.set(record.digest, record);
    return;
  }
  const keyId = existing.keyId ?? record.keyId;
  const conflicted =
    existing.conflicted === true ||
    (existing.keyId !== undefined &&
      record.keyId !== undefined &&
      existing.keyId !== record.keyId);
  records.set(record.digest, {
    digest: record.digest,
    // A pin is a promise, so any record that carries one keeps it. The longest
    // declared deadline wins, because the shorter one would collect evidence
    // some other writer promised to keep.
    pin: existing.pin ?? record.pin,
    keyId: conflicted ? undefined : keyId,
    expiresAt: laterInstant(existing.expiresAt, record.expiresAt),
    formatVersion: existing.formatVersion ?? record.formatVersion,
    conflicted: conflicted || undefined,
    uninterpretable:
      existing.uninterpretable === true ||
      record.uninterpretable === true ||
      undefined,
  });
}

function laterInstant(
  left: string | undefined,
  right: string | undefined,
): string | undefined {
  if (left === undefined) return right;
  if (right === undefined) return left;
  return Date.parse(left) >= Date.parse(right) ? left : right;
}

async function artifactState(
  root: string,
  reference: SnapshotReference,
  available: ReadonlySet<string>,
): Promise<ArtifactState> {
  const records = await readArtifactRecords(
    namespaceDir(root, reference.namespace),
  );
  const record = records.get(reference.digest);
  if (record === undefined) {
    return { digest: reference.digest, recorded: false, readable: false };
  }
  return {
    digest: record.digest,
    recorded: true,
    readable:
      record.uninterpretable !== true &&
      record.conflicted !== true &&
      (record.keyId === undefined || available.has(record.keyId)),
    keyId: record.keyId,
    expiresAt: record.expiresAt,
    pin: record.pin,
    formatVersion: record.formatVersion,
  };
}

/**
 * Budget eviction, delete by age and garbage collection share one verdict so a
 * pin cannot be honoured by one path and ignored by another.
 */
function isCollectable(
  record: ArtifactRecord | undefined,
  available: ReadonlySet<string>,
): boolean {
  if (record === undefined) return false;
  if (record.pin !== undefined) return false;
  if (record.uninterpretable === true || record.conflicted === true)
    return false;
  return record.keyId === undefined || available.has(record.keyId);
}

async function enforceBudget(
  root: string,
  namespace: SnapshotNamespace,
  maxBytes: number,
  available: ReadonlySet<string>,
  capturing: `sha256:${string}`,
): Promise<RetentionReport> {
  const files = await snapshotFiles(root, namespace);
  const records = await readArtifactRecords(namespaceDir(root, namespace));
  let retained = files.reduce((total, file) => total + file.size, 0);
  let deleted = 0;
  let freedBytes = 0;
  let skipped = 0;
  const errors: string[] = [];

  for (const file of files.sort(
    (left, right) => left.mtimeMs - right.mtimeMs,
  )) {
    if (retained <= maxBytes) {
      break;
    }
    // The capture this call is about to return a reference for is never the
    // artifact evicted to make room for it. Returning a reference to bytes the
    // same call deleted is how an inverse stops existing without a trace.
    if (
      file.digest === capturing ||
      !isCollectable(records.get(file.digest), available)
    ) {
      skipped += 1;
      continue;
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
    throw makePutError(
      "RetentionFailed",
      namespace,
      "snapshot retention failed",
      errors,
    );
  }
  if (retained > maxBytes) {
    throw makePutError(
      "RetentionFailed",
      namespace,
      `snapshot byte budget cannot be met: ${skipped} pinned or unreadable snapshot(s) retained`,
    );
  }
  return { deleted, freedBytes, errors, skipped };
}

async function collectGarbage(
  root: string,
  namespace: SnapshotNamespace,
  policy: GarbagePolicy,
  available: ReadonlySet<string>,
): Promise<GarbageReport> {
  assertSafeNamespace(namespace);
  const cutoff = policy.cutoff.getTime();
  if (!Number.isFinite(cutoff))
    throw new Error("garbage collection cutoff must be a valid date");
  const files = await snapshotFiles(root, namespace);
  const records = await readArtifactRecords(namespaceDir(root, namespace));
  const deletedDigests: string[] = [];
  const errors: string[] = [];
  let freedBytes = 0;
  let retained = 0;
  let skippedPinned = 0;
  let skippedProtected = 0;
  let skippedUnreadable = 0;

  for (const file of files.sort(
    (left, right) => left.mtimeMs - right.mtimeMs,
  )) {
    if (
      policy.protectedDigests?.has(file.digest) === true ||
      (policy.collectable !== undefined && !policy.collectable.has(file.digest))
    ) {
      skippedProtected += 1;
      continue;
    }
    const record = records.get(file.digest);
    if (record?.pin !== undefined) {
      skippedPinned += 1;
      continue;
    }
    if (!isCollectable(record, available)) {
      skippedUnreadable += 1;
      continue;
    }
    if (file.mtimeMs >= cutoff && policy.expired?.has(file.digest) !== true) {
      retained += 1;
      continue;
    }
    try {
      await rm(file.path, { force: true });
      deletedDigests.push(file.digest);
      freedBytes += file.size;
    } catch (error) {
      retained += 1;
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }

  return {
    scanned: files.length,
    deleted: deletedDigests.length,
    deletedDigests,
    retained,
    freedBytes,
    skippedPinned,
    skippedProtected,
    skippedUnreadable,
    errors,
  };
}

async function deleteOlderThan(
  root: string,
  namespace: SnapshotNamespace,
  cutoff: Date,
  available: ReadonlySet<string>,
): Promise<RetentionReport> {
  if (!Number.isFinite(cutoff.getTime()))
    throw new Error("retention cutoff must be a valid date");
  const files = await snapshotFiles(root, namespace);
  const records = await readArtifactRecords(namespaceDir(root, namespace));
  let deleted = 0;
  let freedBytes = 0;
  let skipped = 0;
  const errors: string[] = [];
  for (const file of files) {
    if (file.mtimeMs >= cutoff.getTime()) {
      continue;
    }
    const record = records.get(file.digest);
    if (record?.pin !== undefined) {
      skipped += 1;
      errors.push(`retained pinned snapshot ${file.digest}`);
      continue;
    }
    if (!isCollectable(record, available)) {
      skipped += 1;
      errors.push(
        `retained snapshot ${file.digest} this store cannot prove unpinned and readable`,
      );
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
  return { deleted, freedBytes, errors, skipped };
}

type SnapshotFile = {
  readonly path: string;
  readonly digest: `sha256:${string}`;
  readonly size: number;
  readonly mtimeMs: number;
};

async function snapshotFiles(
  root: string,
  namespace: SnapshotNamespace,
): Promise<SnapshotFile[]> {
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
      files.push({
        path,
        digest: `sha256:${name}`,
        size: stats.size,
        mtimeMs: stats.mtimeMs,
      });
    }
  }
  return files;
}

function namespaceDir(root: string, namespace: SnapshotNamespace): string {
  return join(root, encodeURIComponent(namespace));
}

function pathForReference(root: string, reference: SnapshotReference): string {
  return join(
    namespaceDir(root, reference.namespace),
    reference.digest.slice("sha256:".length),
  );
}

function assertSafeNamespace(namespace: SnapshotNamespace): void {
  if (
    namespace.length === 0 ||
    namespace.includes("/") ||
    namespace.includes("\\") ||
    namespace === "." ||
    namespace === ".."
  ) {
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

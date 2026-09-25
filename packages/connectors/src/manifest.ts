import { mkdir, readFile, rename, open, unlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";

import {
  sha256Digest,
  type ArtifactState,
  type SnapshotReference,
  type SnapshotStore,
} from "./snapshot/store.ts";

/**
 * Snapshot manifest: the append only index binding a captured digest to the tool
 * that captured it, plus the readiness and garbage collection surface of work
 * package R03.
 *
 * Two rules shape everything here. Readiness is reported only from bytes that
 * were read back and re-hashed, never from an absent field, because a declared
 * precondition is only as honest as the operator's config. Garbage collection is
 * deny by default: an entry is removed only after the store confirmed the bytes
 * are gone, and anything unproven is retained, because leaking evidence is
 * recoverable while deleting the only before image an inverse needs is not.
 */

/** The newest capture layout this code can honestly claim to understand. */
export const SUPPORTED_CAPTURE_FORMAT_VERSION = 1;

/** Seven days is the free tier retention the paid tiers extend, per DECISIONS 5. */
export const DEFAULT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

export type SnapshotManifestEntry = {
  readonly digest: string;
  readonly reference: SnapshotReference;
  readonly tool: string;
  readonly operationId?: string;
  readonly recoveryJobId?: string;
  readonly pinned?: boolean;
  readonly expiresAt?: string;
  readonly formatVersion?: number;
  readonly keyId?: string;
};

export type ManifestWriter = {
  readonly write: (entry: SnapshotManifestEntry) => Promise<void>;
};

export type RecoveryReadiness =
  | {
      readonly status: "available";
      readonly digest: string;
      readonly reference: SnapshotReference;
      readonly reason: string;
    }
  | { readonly status: "unavailable"; readonly reason: string };

export type ManifestGarbageOptions = {
  readonly now?: Date;
  /** Applied to an entry that declares no deadline of its own. */
  readonly retentionMs?: number;
  /** Jobs and operations proven terminal. Anything else is still referenced. */
  readonly terminalJobIds?: ReadonlySet<string>;
  readonly terminalOperationIds?: ReadonlySet<string>;
};

export type ManifestGarbageReport = {
  readonly scanned: number;
  readonly deleted: number;
  readonly retained: number;
  readonly skippedPinned: number;
  readonly skippedActiveJob: number;
  readonly skippedUnreadable: number;
  readonly errors: readonly string[];
};

const MANIFEST_FILE = "manifest.jsonl";

const writers = new Map<string, Promise<unknown>>();

export function manifestWriter(snapshotDir: string): ManifestWriter {
  return {
    write: (entry) =>
      withManifest(snapshotDir, async () => {
        const records = await manifestReader(snapshotDir);
        await writeManifest(snapshotDir, [
          ...records,
          validateEntry(entry, records.length + 1),
        ]);
      }),
  };
}

export async function manifestReader(
  snapshotDir: string,
): Promise<readonly SnapshotManifestEntry[]> {
  let text: string;
  try {
    text = await readFile(join(snapshotDir, MANIFEST_FILE), "utf8");
  } catch (error) {
    if (isMissingFile(error)) return [];
    throw error;
  }

  const records: SnapshotManifestEntry[] = [];
  const lines = text.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!.trim();
    if (line === "") continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      throw new Error(`manifest line ${index + 1} is not JSON`);
    }
    records.push(validateEntry(parsed, index + 1));
  }
  return records;
}

export async function findEntry(
  snapshotDir: string,
  digest: string,
  tool: string,
): Promise<SnapshotManifestEntry | null> {
  const records = await manifestReader(snapshotDir);
  return (
    records.find((entry) => entry.digest === digest && entry.tool === tool) ??
    null
  );
}

/**
 * Reports whether the bytes an inverse needs can be read and verified now.
 *
 * A missing field is never a pass. Expiry, key binding and capture format are
 * all checked, and the final verdict comes from re-hashing bytes this call read
 * back through the store rather than from a record that claims they exist.
 */
export async function resolveRecoveryReadiness(
  snapshotDir: string,
  store: SnapshotStore,
  digest: string,
  tool: string,
  options: { readonly now?: Date } = {},
): Promise<RecoveryReadiness> {
  const now = options.now ?? new Date();
  const entry = await findEntry(snapshotDir, digest, tool);
  if (entry === null)
    return unavailable(`no snapshot manifest entry for ${tool} ${digest}`);

  if (
    entry.formatVersion !== undefined &&
    entry.formatVersion > SUPPORTED_CAPTURE_FORMAT_VERSION
  ) {
    return unavailable(
      `snapshot capture format version ${entry.formatVersion} is newer than the supported version ${SUPPORTED_CAPTURE_FORMAT_VERSION}`,
    );
  }

  const state = (await store.artifactState?.(entry.reference)) ?? null;
  // A recorded artifact this store cannot read is refused here. An artifact the
  // store keeps no record of is not judged at all: the read below is positive
  // evidence, while the record exists only so collection can prove an artifact
  // safe to remove. Refusing legacy captures on an absent record would be a
  // false negative on bytes that demonstrably exist.
  if (state !== null && state.recorded && !state.readable) {
    return unavailable(
      `snapshot ${digest} is not readable: ${describeUnreadable(state)}`,
    );
  }
  if (
    entry.keyId !== undefined &&
    store.availableKeyIds !== undefined &&
    !store.availableKeyIds().includes(entry.keyId)
  ) {
    return unavailable(
      `snapshot recovery key ${entry.keyId} is not available in this store`,
    );
  }
  if (
    state !== null &&
    state.keyId !== undefined &&
    entry.keyId !== undefined &&
    state.keyId !== entry.keyId
  ) {
    return unavailable(
      `snapshot key binding ${state.keyId} does not match the manifest key ${entry.keyId}`,
    );
  }
  const deadline = state?.expiresAt ?? entry.expiresAt;
  if (deadline !== undefined && isPast(deadline, now)) {
    return unavailable(`snapshot is expired since ${deadline}`);
  }

  let bytes: Uint8Array;
  try {
    bytes = await store.get(entry.reference);
  } catch (error) {
    return unavailable(`snapshot is unavailable: ${readFailure(error)}`);
  }
  if (sha256Digest(bytes) !== entry.reference.digest) {
    return unavailable(
      `snapshot digest mismatch: bytes re-hash to ${sha256Digest(bytes)}`,
    );
  }
  return {
    status: "available",
    digest,
    reference: entry.reference,
    reason: "bytes read back and digest verified",
  };
}

/**
 * Collects manifest entries whose artifact the store confirms it deleted.
 *
 * Every entry is cleared by proof, never by absence: pinned, still referenced by
 * a job this caller has not proven terminal, of an unknown capture format, of an
 * unreadable or unrecorded artifact, or still inside its retention window is
 * retained. Bytes go first and the index is replaced atomically afterwards, so a
 * failed replacement leaves entries that now resolve as unavailable rather than
 * silently orphaned evidence.
 */
export async function collectManifestGarbage(
  snapshotDir: string,
  store: SnapshotStore,
  options: ManifestGarbageOptions = {},
): Promise<ManifestGarbageReport> {
  const now = options.now ?? new Date();
  return withManifest(snapshotDir, () =>
    collectLocked(snapshotDir, store, options, now),
  );
}

async function collectLocked(
  snapshotDir: string,
  store: SnapshotStore,
  options: ManifestGarbageOptions,
  now: Date,
): Promise<ManifestGarbageReport> {
  const records = await manifestReader(snapshotDir);
  const retentionMs = options.retentionMs ?? DEFAULT_RETENTION_MS;
  const errors: string[] = [];
  // Per namespace: every digest this manifest cleared, and the subset whose
  // declared deadline has passed rather than aged out through modification time.
  const candidates = new Map<
    string,
    { readonly collectable: Set<string>; readonly expired: Set<string> }
  >();
  let skippedPinned = 0;
  let skippedActiveJob = 0;
  let skippedUnreadable = 0;
  let retained = 0;

  for (const entry of records) {
    if (entry.pinned === true) {
      skippedPinned += 1;
      continue;
    }
    if (isStillReferenced(entry, options)) {
      skippedActiveJob += 1;
      continue;
    }
    if (
      entry.formatVersion !== undefined &&
      entry.formatVersion > SUPPORTED_CAPTURE_FORMAT_VERSION
    ) {
      skippedUnreadable += 1;
      continue;
    }
    if (
      store.collectGarbage === undefined ||
      store.artifactState === undefined
    ) {
      skippedUnreadable += 1;
      continue;
    }
    const state = await store.artifactState(entry.reference);
    if (state === null || !state.recorded || !state.readable) {
      skippedUnreadable += 1;
      continue;
    }
    if (state.pin !== undefined) {
      skippedPinned += 1;
      continue;
    }
    if (
      entry.keyId !== undefined &&
      store.availableKeyIds !== undefined &&
      !store.availableKeyIds().includes(entry.keyId)
    ) {
      skippedUnreadable += 1;
      continue;
    }
    const declared = deadlineOf(entry, state);
    if (declared !== undefined && declared > now.getTime()) {
      retained += 1;
      continue;
    }
    const namespace = candidates.get(entry.reference.namespace) ?? {
      collectable: new Set<string>(),
      expired: new Set<string>(),
    };
    namespace.collectable.add(entry.reference.digest);
    if (declared !== undefined) {
      namespace.expired.add(entry.reference.digest);
    }
    candidates.set(entry.reference.namespace, namespace);
  }

  const removed = new Set<string>();
  for (const [namespace, cleared] of candidates) {
    if (store.collectGarbage === undefined) continue;
    // An entry that declared no deadline ages out through the store's
    // modification time instead, so nothing is collectable the moment it is
    // written.
    const cutoff = new Date(now.getTime() - retentionMs);
    try {
      const report = await store.collectGarbage(namespace, {
        cutoff,
        collectable: cleared.collectable,
        expired: cleared.expired,
      });
      for (const digest of report.deletedDigests) removed.add(digest);
      retained +=
        cleared.collectable.size -
        report.deletedDigests.filter((digest) =>
          cleared.collectable.has(digest),
        ).length;
      errors.push(...report.errors);
    } catch (error) {
      // Nothing this namespace cleared is collectable while the store refuses
      // to answer, so every candidate stays and the caller is told why.
      retained += cleared.collectable.size;
      errors.push(`namespace ${namespace}: ${readFailure(error)}`);
    }
  }

  if (removed.size > 0) {
    await writeManifest(
      snapshotDir,
      records.filter((entry) => !removed.has(entry.reference.digest)),
    );
  }
  return {
    scanned: records.length,
    deleted: removed.size,
    retained,
    skippedPinned,
    skippedActiveJob,
    skippedUnreadable,
    errors,
  };
}

function unavailable(reason: string): RecoveryReadiness {
  return { status: "unavailable", reason };
}

function describeUnreadable(state: ArtifactState): string {
  if (state.keyId !== undefined)
    return `recovery key ${state.keyId} is not available in this store`;
  return "the store holds no readable record of its key binding";
}

/**
 * An entry naming a job or operation is referenced until the caller proves that
 * reference terminal. Without those sets nothing carrying a reference is
 * collected, which is the only reading that cannot delete a live plan.
 */
function isStillReferenced(
  entry: SnapshotManifestEntry,
  options: ManifestGarbageOptions,
): boolean {
  if (
    entry.recoveryJobId !== undefined &&
    options.terminalJobIds?.has(entry.recoveryJobId) !== true
  )
    return true;
  if (
    entry.operationId !== undefined &&
    options.terminalOperationIds?.has(entry.operationId) !== true
  )
    return true;
  return false;
}

/**
 * The declared retention deadline, or undefined when the entry declares none.
 * An unparseable deadline is not "no deadline": it is a deadline nobody can
 * evaluate, so the caller treats the entry as declared and unexpired.
 */
function deadlineOf(
  entry: SnapshotManifestEntry,
  state: { readonly expiresAt?: string },
): number | undefined {
  const declared = entry.expiresAt ?? state.expiresAt;
  if (declared === undefined) return undefined;
  const parsed = Date.parse(declared);
  return Number.isFinite(parsed) ? parsed : Number.POSITIVE_INFINITY;
}

function isPast(deadline: string, now: Date): boolean {
  const parsed = Date.parse(deadline);
  // An unparseable deadline is not "not expired": it is a deadline nobody can
  // evaluate, so recovery cannot be called available on it.
  return !Number.isFinite(parsed) || parsed <= now.getTime();
}

function readFailure(error: unknown): string {
  if (error instanceof Error) {
    const kind = (error as Error & { readonly kind?: unknown }).kind;
    return typeof kind === "string"
      ? `${kind}: ${error.message}`
      : error.message;
  }
  return String(error);
}

async function withManifest<T>(
  snapshotDir: string,
  run: () => Promise<T>,
): Promise<T> {
  const key = resolve(snapshotDir);
  const next = (writers.get(key) ?? Promise.resolve())
    .catch(() => {})
    .then(async () => {
      await mkdir(snapshotDir, { recursive: true, mode: 0o700 });
      // Another process must fail closed, rather than overwrite a newer manifest.
      // A stale lock requires operator inspection; never guess its owner is dead.
      const lock = join(snapshotDir, `${MANIFEST_FILE}.lock`);
      const handle = await open(lock, "wx", 0o600);
      try {
        return await run();
      } finally {
        await handle.close();
        await unlink(lock);
      }
    });
  writers.set(key, next);
  void next
    .finally(() => {
      if (writers.get(key) === next) writers.delete(key);
    })
    .catch(() => {});
  return next;
}

async function writeManifest(
  snapshotDir: string,
  records: readonly SnapshotManifestEntry[],
): Promise<void> {
  const target = join(snapshotDir, MANIFEST_FILE);
  const temporary = join(
    snapshotDir,
    `${MANIFEST_FILE}.${process.pid}.${randomUUID()}.tmp`,
  );
  const text =
    records.map((record) => JSON.stringify(record)).join("\n") +
    (records.length === 0 ? "" : "\n");
  const handle = await open(temporary, "wx", 0o600);
  try {
    // Windows requires a writable handle for FlushFileBuffers.
    try {
      await handle.writeFile(text);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, target);
    // Node cannot open/flush directory handles on Windows. File contents are
    // flushed above, but durable directory replacement needs a native API.
    if (process.platform !== "win32") {
      const directory = await open(snapshotDir, "r");
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
    }
  } finally {
    await unlink(temporary).catch((error) => {
      if (!isMissingFile(error)) throw error;
    });
  }
}

function validateEntry(value: unknown, line: number): SnapshotManifestEntry {
  if (typeof value !== "object" || value === null)
    throw new Error(`manifest line ${line} is not an object`);
  const record = value as Readonly<Record<string, unknown>>;
  if (typeof record.digest !== "string" || record.digest === "")
    throw new Error(`manifest line ${line} has no digest`);
  if (typeof record.tool !== "string" || record.tool === "")
    throw new Error(`manifest line ${line} has no tool`);
  if (!isSnapshotReference(record.reference))
    throw new Error(`manifest line ${line} has invalid reference`);
  // Optional facts are copied only when present, so a round trip does not
  // invent a false deadline or a false key binding for an older capture.
  return {
    digest: record.digest,
    reference: record.reference,
    tool: record.tool,
    ...optionalIdentifier(record.operationId, line, "operationId"),
    ...optionalIdentifier(record.recoveryJobId, line, "recoveryJobId"),
    ...optionalIdentifier(record.keyId, line, "keyId"),
    ...(record.pinned === undefined
      ? {}
      : { pinned: readBoolean(record.pinned, line, "pinned") }),
    ...(record.expiresAt === undefined
      ? {}
      : { expiresAt: readDeadline(record.expiresAt, line) }),
    ...(record.formatVersion === undefined
      ? {}
      : { formatVersion: readFormatVersion(record.formatVersion, line) }),
  };
}

function optionalIdentifier(
  value: unknown,
  line: number,
  field: string,
): { readonly [key: string]: string } {
  if (value === undefined) return {};
  if (typeof value !== "string" || value === "")
    throw new Error(`manifest line ${line} has an invalid ${field}`);
  return { [field]: value };
}

function readBoolean(value: unknown, line: number, field: string): boolean {
  if (typeof value !== "boolean")
    throw new Error(`manifest line ${line} has an invalid ${field}`);
  return value;
}

function readDeadline(value: unknown, line: number): string {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value)))
    throw new Error(`manifest line ${line} has an invalid expiresAt`);
  return value;
}

function readFormatVersion(value: unknown, line: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0)
    throw new Error(`manifest line ${line} has an invalid formatVersion`);
  return value as number;
}

function isSnapshotReference(value: unknown): value is SnapshotReference {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Readonly<Record<string, unknown>>;
  return (
    typeof record.namespace === "string" &&
    record.namespace !== "" &&
    typeof record.digest === "string" &&
    record.digest.startsWith("sha256:") &&
    typeof record.uri === "string" &&
    record.uri !== ""
  );
}

function isMissingFile(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as Readonly<Record<string, unknown>>).code === "ENOENT"
  );
}

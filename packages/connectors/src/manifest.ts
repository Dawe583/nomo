import { mkdir, readFile, rename, open, unlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";

import type { GarbageReport, SnapshotReference, SnapshotStore } from "./snapshot/store.ts";
import { sha256Digest } from "./snapshot/store.ts";
import { readEntryMeta } from "./snapshot/local.ts";

export type SnapshotManifestEntry = {
  readonly digest: string;
  readonly reference: SnapshotReference;
  readonly tool: string;
  /** R03 provenance, when the caller records it. */
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
  | { readonly status: "available" }
  | { readonly status: "unavailable"; readonly reason: string };

export type ManifestGarbageReport = { readonly skippedPinned: number; readonly retained: number; readonly deleted: number; readonly freedBytes: number };

const MANIFEST_FILE = "manifest.jsonl";

const writers = new Map<string, Promise<void>>();

export function manifestWriter(snapshotDir: string): ManifestWriter {
  return {
    write: (entry) => {
      const key = resolve(snapshotDir);
      const next = (writers.get(key) ?? Promise.resolve()).catch(() => {}).then(async () => {
        await mkdir(snapshotDir, { recursive: true, mode: 0o700 });
        // Another process must fail closed, rather than overwrite a newer manifest.
        // A stale lock requires operator inspection; never guess its owner is dead.
        const lock = join(snapshotDir, `${MANIFEST_FILE}.lock`);
        const handle = await open(lock, 'wx', 0o600);
        try { const records = await manifestReader(snapshotDir); await writeManifest(snapshotDir, [...records, validateEntry(entry, records.length + 1)]); }
        finally { await handle.close(); await unlink(lock); }
      });
      writers.set(key, next);
      void next.finally(() => { if (writers.get(key) === next) writers.delete(key); }).catch(() => {});
      return next;
    },
  };
}

export async function manifestReader(snapshotDir: string): Promise<readonly SnapshotManifestEntry[]> {
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

export async function findEntry(snapshotDir: string, digest: string, tool: string): Promise<SnapshotManifestEntry | null> {
  const records = await manifestReader(snapshotDir);
  return records.find((entry) => entry.digest === digest && entry.tool === tool) ?? null;
}

async function writeManifest(snapshotDir: string, records: readonly SnapshotManifestEntry[]): Promise<void> {
  const target = join(snapshotDir, MANIFEST_FILE);
  const temporary = join(snapshotDir, `${MANIFEST_FILE}.${process.pid}.${randomUUID()}.tmp`);
  const text = records.map((record) => JSON.stringify(record)).join("\n") + (records.length === 0 ? "" : "\n");
  const handle = await open(temporary, "wx", 0o600);
  try {
    // Windows requires a writable handle for FlushFileBuffers.
    try { await handle.writeFile(text); await handle.sync(); }
    finally { await handle.close(); }
    await rename(temporary, target);
    // Node cannot open/flush directory handles on Windows. File contents are
    // flushed above, but durable directory replacement needs a native API.
    if (process.platform !== "win32") {
      const directory = await open(snapshotDir, "r");
      try { await directory.sync(); } finally { await directory.close(); }
    }
  } finally {
    await unlink(temporary).catch((error) => { if (!isMissingFile(error)) throw error; });
  }
}

function validateEntry(value: unknown, line: number): SnapshotManifestEntry {
  if (typeof value !== "object" || value === null) throw new Error(`manifest line ${line} is not an object`);
  const record = value as Readonly<Record<string, unknown>>;
  if (typeof record.digest !== "string" || record.digest === "") throw new Error(`manifest line ${line} has no digest`);
  if (typeof record.tool !== "string" || record.tool === "") throw new Error(`manifest line ${line} has no tool`);
  if (!isSnapshotReference(record.reference)) throw new Error(`manifest line ${line} has invalid reference`);
  const operationId = optionalString(record.operationId);
  const recoveryJobId = optionalString(record.recoveryJobId);
  const keyId = optionalString(record.keyId);
  const expiresAt = optionalString(record.expiresAt);
  const pinned = typeof record.pinned === "boolean" ? record.pinned : undefined;
  const formatVersion = typeof record.formatVersion === "number" && Number.isInteger(record.formatVersion) ? record.formatVersion : undefined;
  return {
    digest: record.digest,
    reference: record.reference,
    tool: record.tool,
    ...(operationId === undefined ? {} : { operationId }),
    ...(recoveryJobId === undefined ? {} : { recoveryJobId }),
    ...(keyId === undefined ? {} : { keyId }),
    ...(expiresAt === undefined ? {} : { expiresAt }),
    ...(pinned === undefined ? {} : { pinned }),
    ...(formatVersion === undefined ? {} : { formatVersion }),
  };
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

/** R03: recovery is available only for verified bytes; expiry, corruption,
 * lost keys and loss each report unavailable with the reason. */
export async function resolveRecoveryReadiness(
  snapshotDir: string,
  store: Pick<SnapshotStore, "get" | "keyIds">,
  digest: string,
  tool: string,
): Promise<RecoveryReadiness> {
  const entry = await findEntry(snapshotDir, digest, tool);
  if (entry === null) return { status: "unavailable", reason: "manifest has no entry for this digest" };
  // Expiry, pin and key binding live in the store's sidecar metadata; the
  // manifest line may omit them. The store is the single source for both.
  const meta = await readEntryMeta(entry.reference);
  const expiresAt = entry.expiresAt ?? meta?.expiresAt;
  if (expiresAt !== undefined && Date.parse(expiresAt) <= Date.now()) {
    return { status: "unavailable", reason: `snapshot expired at ${expiresAt}` };
  }
  const keyId = entry.keyId ?? meta?.keyId;
  if (keyId !== undefined) {
    // Key binding: a rotated or lost key stays unavailable. The store reports
    // the loss; without an available-key check the readback fails closed.
    const available = store.keyIds;
    if (available !== undefined && !available.includes(keyId)) {
      return { status: "unavailable", reason: `snapshot key ${keyId} is not available` };
    }
  }
  try {
    const bytes = await store.get(entry.reference);
    if (sha256Digest(bytes) !== entry.digest) return { status: "unavailable", reason: "snapshot digest mismatch" };
    return { status: "available" };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { status: "unavailable", reason: message };
  }
}

/** R03: collect unpinned garbage across the manifest; pinned snapshots
 * survive and are reported, never deleted. */
export async function collectManifestGarbage(
  snapshotDir: string,
  store: { collectGarbage?: (namespace: string, options: { readonly cutoff: Date }) => Promise<GarbageReport> },
): Promise<ManifestGarbageReport> {
  const records = await manifestReader(snapshotDir);
  const namespaces = new Set(records.map((entry) => entry.reference.namespace));
  let skippedPinned = 0;
  let retained = 0;
  let deleted = 0;
  let freedBytes = 0;
  for (const namespace of namespaces) {
    const garbage = store.collectGarbage;
    if (garbage === undefined) {
      retained += records.filter((entry) => entry.reference.namespace === namespace).length;
      continue;
    }
    const report = await garbage(namespace, { cutoff: new Date(Date.now() + 86_400_000) });
    skippedPinned += report.skippedPinned;
    deleted += report.deleted;
    freedBytes += report.freedBytes;
    // Retained is the store's own count of live snapshots it did not delete.
    retained += report.retained;
  }
  return { skippedPinned, retained, deleted, freedBytes };
}

function isSnapshotReference(value: unknown): value is SnapshotReference {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Readonly<Record<string, unknown>>;
  return typeof record.namespace === "string"
    && record.namespace !== ""
    && typeof record.digest === "string"
    && record.digest.startsWith("sha256:")
    && typeof record.uri === "string"
    && record.uri !== "";
}

function isMissingFile(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as Readonly<Record<string, unknown>>).code === "ENOENT";
}

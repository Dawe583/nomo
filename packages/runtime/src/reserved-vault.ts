import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { readdir, lstat, open } from "node:fs/promises";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { DatabaseSync } from "node:sqlite";
import { canonicalJson } from "../../ledger/src/canonical.ts";
import { digest } from "./journal.ts";
import { ARTIFACT_UNAVAILABLE } from "./vault-refusals.ts";
import {
  localRecoveryVault,
  VaultCapacityError,
  type RecoveryVault,
  type VaultReference,
  type VaultAllocation,
  type VaultSlot,
} from "./vault.ts";
import type { Json } from "../../connectors/src/recovery.ts";
import type { RetentionReport } from "../../connectors/src/snapshot/store.ts";
import {
  parseVaultLifecycle,
  vaultPin,
  type VaultLifecycle,
  type VaultPin,
  type VaultRelease,
} from "./retention.ts";
import {
  assertPrivateDirectoryPath,
  assertPrivateFileIfPresent,
  assertPrivateFilePath,
  ensurePrivateDirectory,
  ensurePrivateFile,
  secureGeneratedPrivateSidecar,
} from "../../ledger/src/hardening.ts";
const slots: readonly VaultSlot[] = ["capture", "outcome", "recovery"];
type LegacyState = {
  bytes: number;
  sample?: { workspace: string; reference: VaultReference };
};
const identity = (value: string) => {
  if (typeof value !== "string" || !/^[\w-]{1,120}$/.test(value))
    throw new Error(`Invalid vault identity; ${JSON.stringify(value)} is not 1 to 120 word characters.`);
};

/** The record column crosses the statement boundary as unknown, so the shape
 * is proved before a pin is read. An unreadable or invalid record refuses
 * rather than guessing protection, which is the file vault's rule verbatim. */
const readRetentionRecord = (
  db: DatabaseSync,
  workspace: string,
  target: string,
): VaultLifecycle | undefined => {
  const row: unknown = db
    .prepare("SELECT record FROM retention WHERE workspace=? AND digest=?")
    .get(workspace, target);
  if (row === undefined) return undefined;
  const record: unknown =
    row === null || typeof row !== "object" || !("record" in row)
      ? undefined
      : (row as Record<string, unknown>).record;
  if (typeof record !== "string")
    throw new Error(
      `Recovery artifact lifecycle is invalid; retention refused: the retention row for ${workspace}:${target} carries ${record === undefined ? "no record column" : `a ${typeof record} record`} where a JSON lifecycle string is required.`,
    );
  return parseVaultLifecycle(record);
};

const toRetentionRow = (row: unknown): ReservedRetentionRow => {
  if (
    typeof row !== "object" ||
    row === null ||
    !("digest" in row) ||
    !("bytes" in row) ||
    !("at" in row) ||
    !("record" in row)
  )
    throw new Error("Recovery artifact cannot be verified.");
  const record = row as Record<string, unknown>;
  if (
    typeof record.digest !== "string" ||
    !/^[a-f0-9]{64}$/.test(record.digest) ||
    typeof record.bytes !== "number" ||
    !Number.isSafeInteger(record.bytes) ||
    record.bytes < 1 ||
    (record.at !== null && typeof record.at !== "string")
  )
    throw new Error("Recovery artifact cannot be verified.");
  return {
    digest: record.digest,
    bytes: record.bytes,
    at: record.at,
    lifecycle: record.record === null ? undefined : parseVaultLifecycle(record.record as string),
  };
};
export type VaultCapacity = { maxArtifactBytes: number; maxTotalBytes: number };

/** One plaintext chunk. A capture too large to hold is fed as chunks, and the
 * vault never concatenates them into a single value. */
export type VaultPlaintext = AsyncIterable<Uint8Array> | Iterable<Uint8Array>;
/** A streamed artifact declares its exact plaintext length. The quota decision
 * and the ciphertext layout both depend on it before the first chunk is read,
 * so a stream that delivers a different total is refused rather than resized. */
export type VaultStreamRequest = {
  readonly bytes: number;
  readonly allocation?: VaultAllocation;
};
/** A capacity move states the capacity the vault is expected to hold now. It
 * is refused unless it does, so a second operator, or a worker that already
 * migrated, cannot silently apply a stale decision. */
export type VaultCapacityMigration = {
  readonly from: VaultCapacity;
  readonly operatorId: string;
};
export type VaultCapacityMigrationReport = {
  readonly from: VaultCapacity;
  readonly to: VaultCapacity;
  readonly usedBytes: number;
  readonly reservations: number;
};
export interface ManagedRecoveryVault extends RecoveryVault {
  reserve(
    workspace: string,
    operationId: string,
    slots?: readonly VaultSlot[],
  ): Promise<void>;
  release(workspace: string, operationId: string): Promise<void>;
  putStream(
    workspace: string,
    source: VaultPlaintext,
    request: VaultStreamRequest,
  ): Promise<VaultReference>;
  getStream(
    workspace: string,
    reference: VaultReference,
  ): AsyncGenerator<Uint8Array>;
  migrateCapacity(
    request: VaultCapacityMigration,
  ): Promise<VaultCapacityMigrationReport>;
  /** Retention, mirrored from the file vault: absent or conflicting evidence
   * protects, a release is a recorded fact naming the pin it removed, and
   * nothing unpins itself. The collector reads one workspace snapshot and
   * deletes only what the snapshot still proves unpinned. */
  markVaultLifecycle(
    workspace: string,
    reference: VaultReference,
    request: { readonly pin?: VaultPin },
  ): Promise<void>;
  releaseVaultPin(
    workspace: string,
    reference: VaultReference,
    request: {
      readonly pin: VaultPin;
      readonly operatorId: string;
      readonly clock?: () => Date;
    },
  ): Promise<VaultRelease>;
  retentionEntries(workspace: string): Promise<ReservedRetentionRow[]>;
  deleteRetained(
    workspace: string,
    digests: readonly string[],
  ): Promise<RetentionReport>;
}
/** One reserved-vault artifact with the retention evidence that protects it.
 * `at` is the write time; a row stored by schema v1 carries `at: null`, which
 * keeps the artifact protected because an unknown age is not a passed age. */
export type ReservedRetentionRow = {
  readonly digest: string;
  readonly bytes: number;
  readonly at: string | null;
  readonly lifecycle: VaultLifecycle | undefined;
};

const capacityOf = (capacity: VaultCapacity): VaultCapacity => {
  for (const [field, value] of [
    ["maxArtifactBytes", capacity.maxArtifactBytes],
    ["maxTotalBytes", capacity.maxTotalBytes],
  ] as const)
    if (
      !Number.isSafeInteger(value) ||
      value < 1 ||
      value > Number.MAX_SAFE_INTEGER / 4
    )
      throw new Error(
        `vaultCapacity.${field} is ${JSON.stringify(value)}: the capacity must be a whole number from 1 to ${Math.floor(Number.MAX_SAFE_INTEGER / 4)}.`,
      );
  return capacity;
};

/** A view of stored bytes without copying them. The old writer copied each
 * blob twice and the reader three times, which is most of why a large artifact
 * cost more memory than its own size. */
const view = (bytes: Uint8Array, at = 0, to = bytes.byteLength): Buffer =>
  Buffer.isBuffer(bytes)
    ? bytes.subarray(at, to)
    : Buffer.from(bytes.buffer, bytes.byteOffset + at, to - at);

/** The reference digest is the canonical digest of the base64 of the stored
 * bytes, which is sha256 over `"` + base64 + `"`. The base64 alphabet contains
 * nothing JSON.stringify escapes, so that preimage is exact and can be hashed
 * in three-byte-aligned slices instead of materialising a string four thirds
 * the size of the artifact. Slicing on that boundary is what makes the
 * concatenation byte-identical to the one-shot encoding: only the final slice
 * may carry padding. */
const streamedBase64Digest = (bytes: Uint8Array): string => {
  const hash = createHash("sha256").update('"'),
    aligned = bytes.length - (bytes.length % 3),
    step = 3 * 4096;
  for (let at = 0; at < aligned; at += step)
    hash.update(
      view(bytes, at, Math.min(at + step, aligned)).toString("base64"),
    );
  if (aligned !== bytes.length)
    hash.update(view(bytes, aligned, bytes.length).toString("base64"));
  return hash.update('"').digest("hex");
};

/** Ciphertext layout: a 12 byte IV, a 16 byte GCM tag, then the payload. */
const VAULT_OVERHEAD = 28;
const STREAM_CHUNK = 256 * 1024;
export const recoveryKeyProof = (key: Uint8Array, keyId: string): string =>
  createHmac("sha256", key)
    .update(`void.recovery.key-check.v1:${keyId}`)
    .digest("hex");
/** Encrypted payloads and quota changes commit in one local SQLite transaction.
 * ponytail: one writer, local disk, no eviction of recovery evidence. A capture
 * too large to hold is written with `putStream`, which encrypts chunk by chunk;
 * `put` is the same statement for a value the caller already holds. */
export function reservedRecoveryVault(
  root: string,
  keys: Readonly<Record<string, Uint8Array>>,
  currentKey: string,
  requested: VaultCapacity = {
    maxArtifactBytes: 64 * 1024 * 1024,
    maxTotalBytes: 1024 * 1024 * 1024,
  },
): ManagedRecoveryVault {
  const capacity = capacityOf(requested),
    { maxArtifactBytes, maxTotalBytes } = capacity;
  const key = keys[currentKey];
  identity(currentKey);
  if (!key || key.byteLength !== 32)
    throw new Error("A 256-bit recovery key is required.");
  const rootPath = resolve(root),
    legacy = localRecoveryVault(rootPath, keys, currentKey, maxArtifactBytes),
    slotBytes = maxArtifactBytes + 28;
  async function legacyState(): Promise<LegacyState> {
    let bytes = 0,
      sample: LegacyState["sample"];
    for (const entry of await readdir(rootPath, { withFileTypes: true })) {
      if (
        entry.name === "vault.sqlite" ||
        entry.name.startsWith("vault.sqlite-")
      )
        continue;
      if (!entry.isDirectory())
        throw new Error(`Unexpected entry in legacy vault at ${JSON.stringify(join(rootPath, entry.name))}: the legacy layout stores one directory per workspace.`);
      const workspaceDir = join(rootPath, entry.name);
      await assertPrivateDirectoryPath(
        workspaceDir,
        "legacy vault workspace directory",
        undefined,
        true,
      );
      for (const file of await readdir(join(rootPath, entry.name), {
        withFileTypes: true,
      })) {
        if (!file.isFile()) throw new Error(`Unexpected legacy artifact layout at ${JSON.stringify(join(rootPath, entry.name, file.name))}: the legacy vault stores regular files only.`);
        const artifactPath = join(rootPath, entry.name, file.name);
        await assertPrivateFilePath(artifactPath, "legacy vault artifact");
        const stat = await lstat(artifactPath);
        bytes += stat.size;
        sample ??= {
          workspace: entry.name,
          reference: { digest: file.name, keyId: currentKey, bytes: stat.size },
        };
      }
    }
    return { bytes, sample };
  }
  const expectedKeyProof = recoveryKeyProof(key, currentKey);
  const keyProofMatches = (actual: unknown): boolean =>
    typeof actual === "string" &&
    /^[a-f0-9]{64}$/.test(actual) &&
    timingSafeEqual(Buffer.from(actual, "hex"), Buffer.from(expectedKeyProof, "hex"));
  const isMissingFile = (error: unknown): boolean =>
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT";
  const isAuthenticationFailure = (error: unknown): boolean =>
    error instanceof Error &&
    /authenticate|bad decrypt|unsupported state/i.test(error.message);
  async function ensureKeyMarker(
    db: DatabaseSync,
    old: LegacyState,
  ): Promise<void> {
    const existing = db
      .prepare("SELECT proof FROM key_checks WHERE key_id=?")
      .get(currentKey);
    if (existing) {
      if (!keyProofMatches(existing.proof))
        throw new Error(`The retained key ${currentKey} is unavailable or incorrect for this vault.`);
      return;
    }
    const keyRows: unknown = db
      .prepare("SELECT DISTINCT key_id FROM artifacts ORDER BY key_id")
      .all();
    if (!Array.isArray(keyRows))
      throw new Error("Recovery artifact cannot be verified.");
    for (const keyRow of keyRows) {
      if (
        typeof keyRow !== "object" ||
        keyRow === null ||
        Array.isArray(keyRow) ||
        !("key_id" in keyRow) ||
        typeof keyRow.key_id !== "string"
      )
        throw new Error("Recovery artifact cannot be verified.");
      const row = db
        .prepare(
          "SELECT workspace,digest,key_id,data FROM artifacts WHERE key_id=? ORDER BY workspace,digest LIMIT 1",
        )
        .get(keyRow.key_id);
      if (
        !row ||
        typeof row.workspace !== "string" ||
        typeof row.digest !== "string" ||
        typeof row.key_id !== "string" ||
        !(row.data instanceof Uint8Array)
      )
        throw new Error("Recovery artifact cannot be verified.");
      try {
        decode(
          row.workspace,
          { digest: row.digest, keyId: row.key_id, bytes: row.data.length },
          Buffer.from(row.data),
        );
      } catch (error) {
        if (
          isAuthenticationFailure(error) ||
          (error instanceof Error && error.message === "Recovery key unavailable.")
        )
          throw new Error(`The retained key ${currentKey} is unavailable or incorrect for this vault.`);
        throw error;
      }
    }
    if (keyRows.length === 0 && old.bytes > 0) {
      if (old.sample) {
        let verified = false,
          missing = false,
          authenticationFailure = false;
        for (const keyId of Object.keys(keys)) {
          try {
            await legacy.get(old.sample.workspace, {
              ...old.sample.reference,
              keyId,
            });
            verified = true;
            break;
          } catch (error) {
            missing ||= isMissingFile(error);
            authenticationFailure ||= isAuthenticationFailure(error);
          }
        }
        if (!verified) {
          if (authenticationFailure && !missing)
            throw new Error(`No retained key verified the recorded sample; restore the key the retained artifacts were written with.`);
          throw new Error("Recovery artifact cannot be verified.");
        }
      } else {
        throw new Error("Recovery artifact cannot be verified.");
      }
    }
    db.prepare("INSERT INTO key_checks(key_id,proof) VALUES(?,?)").run(
      currentKey,
      expectedKeyProof,
    );
  }
  async function transaction<T>(
    run: (db: DatabaseSync, used: number) => T | Promise<T>,
    /** Present only for an explicit administrative capacity move. It replaces
     * the equality check below with a compare-and-swap against the capacity
     * the operator says the vault holds, and records the move in the same
     * transaction. No other caller may change the persisted capacity. */
    migrate?: VaultCapacityMigration,
  ): Promise<T> {
    await ensurePrivateDirectory(rootPath, "recovery vault directory", true);
    const old = await legacyState();
    const path = join(rootPath, "vault.sqlite");
    await ensurePrivateFile(path, "recovery vault database");
    for (const suffix of ["-journal", "-wal", "-shm"])
      await assertPrivateFileIfPresent(
        `${path}${suffix}`,
        "recovery vault SQLite sidecar",
      );
    const db = new DatabaseSync(path);
    try {
      await assertPrivateFilePath(path, "recovery vault database");
      db.exec("PRAGMA busy_timeout=0; PRAGMA synchronous=FULL");
      const deadline = Date.now() + 30_000;
      for (;;) {
        try {
          db.exec("BEGIN IMMEDIATE");
          break;
        } catch (error) {
          if (
            !(error instanceof Error) ||
            !error.message.includes("database is locked") ||
            Date.now() >= deadline
          )
            throw error;
          await delay(25);
        }
      }
      const versionRow: unknown = db.prepare("PRAGMA user_version").get();
      if (
        typeof versionRow !== "object" ||
        versionRow === null ||
        !("user_version" in versionRow) ||
        typeof versionRow.user_version !== "number"
      )
        throw new Error("Recovery vault schema version cannot be verified.");
      const schemaVersion = versionRow.user_version;
      // Schema 2 adds the retention table and the artifact write time. An
      // older binary reading a moved database refuses on the version instead
      // of writing through a shape it cannot prove, which is the same
      // stop-old-writers rule the capacity migration already established.
      if (schemaVersion > 2)
        throw new Error(`Unsupported recovery vault schema version ${schemaVersion}; this binary supports schema 2.`);
      db.exec(`CREATE TABLE IF NOT EXISTS settings(id INTEGER PRIMARY KEY CHECK(id=1),capacity TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS artifacts(workspace TEXT NOT NULL,digest TEXT NOT NULL,key_id TEXT NOT NULL,data BLOB NOT NULL,operation_id TEXT,slot TEXT,content_digest TEXT NOT NULL,at TEXT,PRIMARY KEY(workspace,digest),UNIQUE(workspace,operation_id,slot));
    CREATE TABLE IF NOT EXISTS reservations(workspace TEXT NOT NULL,operation_id TEXT NOT NULL,slot TEXT NOT NULL,bytes INTEGER NOT NULL,PRIMARY KEY(workspace,operation_id,slot));
    CREATE TABLE IF NOT EXISTS key_checks(key_id TEXT PRIMARY KEY,proof TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS artifacts_key_id ON artifacts(key_id);
    CREATE TABLE IF NOT EXISTS capacity_migrations(at TEXT NOT NULL,operator_id TEXT NOT NULL,from_capacity TEXT NOT NULL,to_capacity TEXT NOT NULL,used_bytes INTEGER NOT NULL,reservations INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS retention(workspace TEXT NOT NULL,digest TEXT NOT NULL,record TEXT NOT NULL,at TEXT NOT NULL,PRIMARY KEY(workspace,digest));`);
      if (schemaVersion < 2) {
        // A v1 database carries artifacts without a write time. The column is
        // added and existing rows are left NULL: retention must never guess an
        // age it cannot prove, so schema 1 artifacts stay protected until an
        // operator marks them.
        const columns = db.prepare("PRAGMA table_info(artifacts)").all() as ReadonlyArray<
          Record<string, unknown>
        >;
        if (!columns.some((column) => column.name === "at"))
          db.exec("ALTER TABLE artifacts ADD COLUMN at TEXT");
      }
      db.exec("PRAGMA user_version=2;");
      const limits = canonicalJson({ maxArtifactBytes, maxTotalBytes });
      db.prepare("INSERT OR IGNORE INTO settings VALUES(1,?)").run(limits);
      const expected = migrate
        ? canonicalJson(capacityOf(migrate.from))
        : limits;
      const persisted: unknown = db
        .prepare("SELECT capacity FROM settings WHERE id=1")
        .get();
      // The refusal reports what it found, so the recorded capacity is read
      // here with an explicit shape; a settings row the schema guarantees
      // should never be anything else.
      const recorded =
        typeof persisted === "object" &&
        persisted !== null &&
        "capacity" in persisted &&
        typeof persisted.capacity === "string"
          ? persisted.capacity
          : "no settings row";
      if (
        typeof persisted !== "object" ||
        persisted === null ||
        !("capacity" in persisted) ||
        persisted.capacity !== expected
      )
        // A worker that refuses a capacity mismatch without naming both
        // capacities it compared sends the operator hunting through the
        // state directory; the message is the fastest way to the fix.
        throw new Error(
          migrate
            ? `Recovery vault capacity migration believed the vault holds ${expected} but the settings row records ${recorded}.`
            : `Vault worker states ${limits} but the vault persists ${recorded}.`,
        );
      await ensureKeyMarker(db, old);
      const used =
        Number(
          db
            .prepare(
              "SELECT COALESCE((SELECT SUM(length(data)) FROM artifacts),0)+COALESCE((SELECT SUM(bytes) FROM reservations),0) AS bytes",
            )
            .get()!.bytes,
        ) + old.bytes;
      const result = await run(db, used);
      // The move and its record commit together or not at all. An operator
      // who cannot read back the row that says what the capacity became has
      // no evidence the move happened, so the two are one statement.
      if (migrate) {
        const counted: unknown = db
          .prepare("SELECT COUNT(*) AS count FROM reservations")
          .get();
        if (
          typeof counted !== "object" ||
          counted === null ||
          !("count" in counted) ||
          typeof counted.count !== "number"
        )
          throw new Error("Recovery vault reservations cannot be counted.");
        db.prepare("UPDATE settings SET capacity=? WHERE id=1").run(limits);
        db.prepare(
          "INSERT INTO capacity_migrations(at,operator_id,from_capacity,to_capacity,used_bytes,reservations) VALUES(?,?,?,?,?,?)",
        ).run(
          new Date().toISOString(),
          migrate.operatorId,
          expected,
          limits,
          used,
          counted.count,
        );
      }
      db.exec("COMMIT");
      if (process.platform !== "win32") {
        const directory = await open(rootPath, "r");
        try { await directory.sync(); } finally { await directory.close(); }
      }
      return result;
    } finally {
      db.close();
      for (const suffix of ["-journal", "-wal", "-shm"])
        await secureGeneratedPrivateSidecar(
          `${path}${suffix}`,
          "recovery vault SQLite sidecar",
        );
    }
  }
  const decode = (
    workspace: string,
    reference: VaultReference,
    bytes: Buffer,
  ): Json => {
    if (
      bytes.length !== reference.bytes ||
      digest(bytes.toString("base64")) !== reference.digest
    )
      throw new Error(`The stored artifact reads ${bytes.length} bytes with digest ${digest(bytes.toString("base64"))}; the reference carries ${reference.bytes} bytes of ${reference.digest}.`);
    if (!Object.hasOwn(keys, reference.keyId))
      throw new Error("Recovery key unavailable.");
    const cipher = createDecipheriv(
      "aes-256-gcm",
      keys[reference.keyId]!,
      bytes.subarray(0, 12),
    );
    cipher.setAAD(
      Buffer.from(`void.recovery.v1:${workspace}:${reference.keyId}`),
    );
    cipher.setAuthTag(bytes.subarray(12, 28));
    return JSON.parse(
      Buffer.concat([
        cipher.update(bytes.subarray(28)),
        cipher.final(),
      ]).toString(),
    );
  };
  /** A streamed write and a whole-value write are one statement, so a capture
   * that fits in memory and a capture that does not cannot diverge. The
   * content digest is always the hash of the plaintext bytes, which for a value
   * is exactly the canonical digest the slot retry compares. */
  async function write(
    db: DatabaseSync,
    used: number,
    workspace: string,
    source: VaultPlaintext,
    bytes: number,
    allocation?: VaultAllocation,
  ): Promise<VaultReference> {
    if (allocation) {
      identity(allocation.operationId);
      if (!slots.includes(allocation.slot))
        throw new Error(`Invalid vault slot ${JSON.stringify(allocation.slot)}.`);
    }
    if (!Number.isSafeInteger(bytes) || bytes < 1)
      throw new Error(`A recovery artifact declares ${bytes} bytes; it must be a positive safe integer.`);
    if (bytes > maxArtifactBytes)
      throw new VaultCapacityError(`Recovery artifact of ${bytes} bytes exceeds the ${maxArtifactBytes} byte artifact limit.`);
    // GCM expands by a fixed amount and the caller declared the plaintext
    // length, so the ciphertext length is known before the first chunk: one
    // allocation filled in place, not a chunk list plus a concatenation.
    const data = Buffer.alloc(bytes + VAULT_OVERHEAD),
      iv = randomBytes(12),
      content = createHash("sha256"),
      cipher = createCipheriv("aes-256-gcm", key, iv);
    iv.copy(data, 0);
    cipher.setAAD(Buffer.from(`void.recovery.v1:${workspace}:${currentKey}`));
    let at = VAULT_OVERHEAD, written = 0;
    for await (const chunk of source) {
      const block = view(chunk);
      written += block.byteLength;
      if (written > bytes)
        throw new Error(
          "A streamed recovery artifact exceeded the byte count it declared; nothing was stored.",
        );
      content.update(block);
      at += cipher.update(block).copy(data, at);
    }
    if (written !== bytes)
      throw new Error(
        "A streamed recovery artifact ended before the byte count it declared; nothing was stored.",
      );
    at += cipher.final().copy(data, at);
    if (at !== data.byteLength)
      throw new Error(
        "Recovery artifact encryption did not produce its declared length.",
      );
    cipher.getAuthTag().copy(data, 12);
    const contentDigest = content.digest("hex");
    // The slot retry resolves after the plaintext is hashed, not before it is
    // read: a caller retrying a slot must prove the evidence it offers is the
    // evidence that slot already holds.
    const prior = allocation
      ? db
          .prepare(
            "SELECT digest,key_id,data,content_digest FROM artifacts WHERE workspace=? AND operation_id=? AND slot=?",
          )
          .get(workspace, allocation.operationId, allocation.slot)
      : undefined;
    if (prior) {
      if (prior.content_digest !== contentDigest)
        throw new Error(`Vault slot ${allocation!.slot} already holds evidence ${String(prior.content_digest)}; the reservation for ${allocation!.operationId} carries ${contentDigest}.`);
      const stored = prior.data as Uint8Array,
        reference = {
          digest: String(prior.digest),
          keyId: String(prior.key_id),
          bytes: stored.byteLength,
        };
      decode(workspace, reference, view(stored));
      return reference;
    }
    // The reservation is only consulted once the slot is known to be empty.
    // A retry arrives after its reservation was spent on the first write, so
    // demanding one here would refuse the idempotent replay it exists to allow.
    const reserved = allocation
      ? db
          .prepare(
            "SELECT bytes FROM reservations WHERE workspace=? AND operation_id=? AND slot=?",
          )
          .get(workspace, allocation.operationId, allocation.slot)
      : undefined;
    if (allocation && !reserved)
      throw new Error(`Reservation ${allocation.operationId} at slot ${allocation.slot} is not recorded in ${workspace}.`);
    const reference = {
      digest: streamedBase64Digest(data),
      keyId: currentKey,
      bytes: data.byteLength,
    };
    if (
      data.byteLength > Number(reserved?.bytes ?? maxTotalBytes) ||
      used - Number(reserved?.bytes ?? 0) + data.byteLength > maxTotalBytes
    )
      throw new VaultCapacityError(`The reserved vault holds ${used} of its ${maxTotalBytes} byte total; an artifact of ${data.byteLength} bytes would exceed it.`);
    db.prepare("INSERT INTO artifacts VALUES(?,?,?,?,?,?,?,?)").run(
      workspace,
      reference.digest,
      currentKey,
      data,
      allocation?.operationId ?? null,
      allocation?.slot ?? null,
      contentDigest,
      // The write time is the only age retention may rely on, so it is stored
      // with the artifact in the same statement rather than derived later.
      new Date().toISOString(),
    );
    if (allocation)
      db.prepare(
        "DELETE FROM reservations WHERE workspace=? AND operation_id=? AND slot=?",
      ).run(workspace, allocation.operationId, allocation.slot);
    return reference;
  }
  return {
    async reserve(workspace, operationId, requested = slots) {
      identity(workspace);
      identity(operationId);
      if (
        !requested.length ||
        new Set(requested).size !== requested.length ||
        requested.some((slot) => !slots.includes(slot))
      )
        throw new Error("Invalid vault slots.");
      await transaction((db, used) => {
        let extra = 0;
        for (const slot of requested) {
          if (
            db
              .prepare(
                "SELECT 1 FROM artifacts WHERE workspace=? AND operation_id=? AND slot=?",
              )
              .get(workspace, operationId, slot)
          )
            continue;
          const prior = db
            .prepare(
              "SELECT bytes FROM reservations WHERE workspace=? AND operation_id=? AND slot=?",
            )
            .get(workspace, operationId, slot);
          extra += Math.max(0, slotBytes - Number(prior?.bytes ?? 0));
          db.prepare(
            "INSERT INTO reservations VALUES(?,?,?,?) ON CONFLICT(workspace,operation_id,slot) DO UPDATE SET bytes=MAX(bytes,excluded.bytes)",
          ).run(workspace, operationId, slot, slotBytes);
        }
        if (used + extra > maxTotalBytes)
          throw new VaultCapacityError(`The reserved vault holds ${used} of its ${maxTotalBytes} byte total; a reservation of ${extra} bytes more would exceed it.`);
      });
    },
    async release(workspace, operationId) {
      identity(workspace);
      identity(operationId);
      await transaction((db) => {
        db.prepare(
          "DELETE FROM reservations WHERE workspace=? AND operation_id=?",
        ).run(workspace, operationId);
      });
    },
    async put(workspace, value, allocation) {
      identity(workspace);
      const plain = Buffer.from(canonicalJson(value));
      return transaction((db, used) =>
        write(db, used, workspace, [plain], plain.byteLength, allocation),
      );
    },
    async putStream(workspace, source, request) {
      identity(workspace);
      if (typeof request !== "object" || request === null)
        throw new Error(`A streamed recovery artifact declares its byte count; got ${JSON.stringify(request)}.`);
      // The declared length is proved against the quota before the source is
      // touched, so an oversized capture costs no chunk of reading.
      if (
        !Number.isSafeInteger(request.bytes) ||
        request.bytes < 1 ||
        request.bytes > maxArtifactBytes
      )
        throw new VaultCapacityError(`The declared artifact of ${request.bytes} bytes exceeds the ${maxArtifactBytes} byte artifact limit.`);
      return transaction((db, used) =>
        write(db, used, workspace, source, request.bytes, request.allocation),
      );
    },
    async *getStream(workspace, reference) {
      identity(workspace);
      if (!/^[a-f0-9]{64}$/.test(reference.digest))
        throw new Error(`Invalid recovery reference; ${JSON.stringify(reference.digest)} is not a sha256 hex digest.`);
      const row: unknown = await transaction((db) =>
        db
          .prepare("SELECT data FROM artifacts WHERE workspace=? AND digest=?")
          .get(workspace, reference.digest),
      );
      if (typeof row !== "object" || row === null || !("data" in row))
        throw new Error(
          "Recovery artifact streaming covers the reserved vault only; a legacy file artifact has no chunked reader.",
        );
      // A SQLite blob column binds a Buffer, but the row crosses the statement
      // boundary as unknown, so the shape is proved before it is read.
      const blob = row.data;
      if (!(blob instanceof Uint8Array))
        throw new Error(`The stored payload behind ${reference.digest} is not a readable blob; the reference declares ${reference.bytes} bytes.`);
      const stored: Buffer = view(blob);
      // The stored payload arrives as one SQLite blob, which is the last
      // full-size allocation on this path. Verifying and decrypting it in place
      // is what removes the four plaintext-sized copies the value reader made.
      if (
        stored.byteLength !== reference.bytes ||
        streamedBase64Digest(stored) !== reference.digest
      )
        throw new Error(`The stored artifact reads ${stored.byteLength} bytes with digest ${streamedBase64Digest(stored)}; the reference carries ${reference.bytes} bytes of ${reference.digest}.`);
      if (!Object.hasOwn(keys, reference.keyId))
        throw new Error("Recovery key unavailable.");
      const cipher = createDecipheriv(
        "aes-256-gcm",
        keys[reference.keyId]!,
        view(stored, 0, 12),
      );
      cipher.setAAD(
        Buffer.from(`void.recovery.v1:${workspace}:${reference.keyId}`),
      );
      cipher.setAuthTag(view(stored, 12, VAULT_OVERHEAD));
      for (
        let at = VAULT_OVERHEAD;
        at < stored.byteLength;
        at += STREAM_CHUNK
      ) {
        const plain = cipher.update(
          view(stored, at, Math.min(at + STREAM_CHUNK, stored.byteLength)),
        );
        if (plain.byteLength) yield plain;
      }
      const last = cipher.final();
      if (last.byteLength) yield last;
    },
    async migrateCapacity(request) {
      identity(request.operatorId);
      if (typeof request.from !== "object" || request.from === null)
        throw new Error(
          "Recovery vault capacity migration declares its expected capacity.",
        );
      const from = capacityOf(request.from);
      return transaction((db, used) => {
        // Lowering the ceiling under what is already stored would leave
        // artifacts no writer can place again, so the move is refused here
        // rather than applied and discovered at some later write.
        if (maxTotalBytes < used)
          throw new Error(
            `Recovery vault capacity migration cannot lower the total below the ${used} bytes the vault holds.`,
          );
        const counted: unknown = db
          .prepare("SELECT COUNT(*) AS count FROM reservations")
          .get();
        if (
          typeof counted !== "object" ||
          counted === null ||
          !("count" in counted) ||
          typeof counted.count !== "number"
        )
          throw new Error("Recovery vault reservations cannot be counted.");
        return {
          from,
          to: { maxArtifactBytes, maxTotalBytes },
          usedBytes: used,
          reservations: counted.count,
        };
      }, request);
    },
    async markVaultLifecycle(workspace, reference, request) {
      identity(workspace);
      if (!/^[a-f0-9]{64}$/.test(reference.digest))
        throw new Error(`Invalid recovery reference; ${JSON.stringify(reference.digest)} is not a sha256 hex digest.`);
      await transaction((db) => {
        // The file vault refuses to record evidence for an artifact it cannot
        // stat; the row lookup is the same refusal, because a lifecycle record
        // for an absent artifact would protect nothing and still pretend to.
        if (
          !db
            .prepare("SELECT 1 FROM artifacts WHERE workspace=? AND digest=?")
            .get(workspace, reference.digest)
        )
          throw new Error(ARTIFACT_UNAVAILABLE);
        const existing = readRetentionRecord(db, workspace, reference.digest);
        const incoming: VaultLifecycle =
          request.pin === undefined ? {} : { pin: vaultPin(request.pin) };
        if (existing?.pin !== undefined && incoming.pin === undefined)
          throw new Error(`The recorded pin on ${reference.digest} in ${workspace} is not released by retention; unpin it instead.`);
        if (
          existing?.pin !== undefined &&
          incoming.pin !== undefined &&
          (existing.pin.ownerId !== incoming.pin.ownerId ||
            existing.pin.kind !== incoming.pin.kind)
        )
          throw new Error(`The recorded pin on ${reference.digest} does not match the stated pin ${incoming.pin!.ownerId}:${incoming.pin!.kind}; nothing was recorded.`);
        const lifecycle: VaultLifecycle = { ...existing, ...incoming };
        if (existing !== undefined && canonicalJson(lifecycle) === canonicalJson(existing))
          return;
        db.prepare(
          "INSERT INTO retention VALUES(?,?,?,?) ON CONFLICT(workspace,digest) DO UPDATE SET record=excluded.record, at=excluded.at",
        ).run(workspace, reference.digest, canonicalJson(lifecycle), new Date().toISOString());
      });
    },
    async releaseVaultPin(workspace, reference, request) {
      identity(workspace);
      if (!/^[a-f0-9]{64}$/.test(reference.digest))
        throw new Error(`Invalid recovery reference; ${JSON.stringify(reference.digest)} is not a sha256 hex digest.`);
      if (!/^[\w-]{1,120}$/.test(request.operatorId))
        throw new Error(
          `Recovery pin release operator is ${JSON.stringify(request.operatorId)}: it must be 1 to 120 word or hyphen characters.`,
        );
      const held = vaultPin(request.pin);
      return transaction((db) => {
        const existing = readRetentionRecord(db, workspace, reference.digest);
        // Absent evidence means "protect", not "nothing to do": releasing an
        // artifact whose pin state this store cannot prove would convert
        // unknown into collectable, which is the one inference retention must
        // never make.
        if (existing === undefined)
          throw new Error(
            `The artifact ${reference.digest} in ${workspace} has no recorded pin; a release cannot prove what protection to remove.`,
          );
        if (existing.pin === undefined)
          throw new Error(
            `The recorded lifecycle of ${reference.digest} in ${workspace} names no pin; it is already released for retention.`,
          );
        if (existing.pin.ownerId !== held.ownerId || existing.pin.kind !== held.kind)
          throw new Error(
            `The recorded pin ${existing.pin.ownerId}:${existing.pin.kind} does not match the stated pin ${held.ownerId}:${held.kind}; nothing was released.`,
          );
        const release: VaultRelease = {
          operatorId: request.operatorId,
          at: (request.clock ?? (() => new Date()))().toISOString(),
          released: { ownerId: held.ownerId, kind: held.kind },
        };
        db.prepare(
          "INSERT INTO retention VALUES(?,?,?,?) ON CONFLICT(workspace,digest) DO UPDATE SET record=excluded.record, at=excluded.at",
        ).run(
          workspace,
          reference.digest,
          canonicalJson({ release: { ...existing.release, ...release } }),
          new Date().toISOString(),
        );
        return release;
      });
    },
    async retentionEntries(workspace) {
      identity(workspace);
      return transaction((db) => {
        const rows: unknown = db
          .prepare(
            "SELECT a.digest AS digest, LENGTH(a.data) AS bytes, a.at AS at, r.record AS record FROM artifacts a LEFT JOIN retention r ON r.workspace=a.workspace AND r.digest=a.digest WHERE a.workspace=?",
          )
          .all(workspace);
        if (!Array.isArray(rows))
          throw new Error("Recovery artifact cannot be verified.");
        return rows.map((row) => toRetentionRow(row));
      });
    },
    async deleteRetained(workspace, digests) {
      identity(workspace);
      let deleted = 0,
        freedBytes = 0;
      const errors: string[] = [];
      await transaction((db) => {
        for (const target of digests) {
          if (!/^[a-f0-9]{64}$/.test(target)) {
            errors.push(`${target} is not a digest this vault holds; not deleted`);
            continue;
          }
          // The record is re-checked inside this transaction, so a pin that
          // landed between the collector's snapshot and this statement stops
          // the delete. The file vault re-reads for the same reason; the
          // SQLite shape just re-reads inside the writer lock instead.
          const record = readRetentionRecord(db, workspace, target);
          if (record === undefined || record.pin !== undefined) {
            errors.push(
              `${target} gained evidence or a pin after the scan; not deleted`,
            );
            continue;
          }
          const row: unknown = db
            .prepare("SELECT LENGTH(data) AS bytes FROM artifacts WHERE workspace=? AND digest=?")
            .get(workspace, target);
          if (
            typeof row !== "object" ||
            row === null ||
            !("bytes" in row) ||
            typeof row.bytes !== "number"
          ) {
            errors.push(`${target} disappeared after the scan; not deleted`);
            continue;
          }
          db.prepare("DELETE FROM artifacts WHERE workspace=? AND digest=?").run(
            workspace,
            target,
          );
          deleted += 1;
          freedBytes += row.bytes;
          // The record goes with the artifact: a stub left behind would read
          // as protection for something that no longer exists.
          db.prepare("DELETE FROM retention WHERE workspace=? AND digest=?").run(
            workspace,
            target,
          );
        }
      });
      return { deleted, freedBytes, errors };
    },
    async get(workspace, reference) {
      identity(workspace);
      if (!/^[a-f0-9]{64}$/.test(reference.digest))
        throw new Error(`Invalid recovery reference; ${JSON.stringify(reference.digest)} is not a sha256 hex digest.`);
      const row = await transaction((db) =>
        db
          .prepare("SELECT data FROM artifacts WHERE workspace=? AND digest=?")
          .get(workspace, reference.digest),
      );
      return row
        ? decode(workspace, reference, Buffer.from(row.data as Uint8Array))
        : legacy.get(workspace, reference);
    },
  };
}

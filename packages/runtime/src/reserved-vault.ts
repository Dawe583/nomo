import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdir, readdir, lstat, chmod, open } from "node:fs/promises";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { DatabaseSync } from "node:sqlite";
import { canonicalJson } from "../../ledger/src/canonical.ts";
import { digest } from "./journal.ts";
import {
  localRecoveryVault,
  VaultCapacityError,
  type RecoveryVault,
  type VaultReference,
  type VaultAllocation,
  type VaultSlot,
} from "./vault.ts";
import type { Json } from "../../connectors/src/recovery.ts";
const slots: readonly VaultSlot[] = ["capture", "outcome", "recovery"];
type LegacyState = {
  bytes: number;
  sample?: { workspace: string; reference: VaultReference };
};
const identity = (value: string) => {
  if (typeof value !== "string" || !/^[\w-]{1,120}$/.test(value))
    throw new Error("Invalid vault identity.");
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
}

const capacityOf = (capacity: VaultCapacity): VaultCapacity => {
  for (const value of [capacity.maxArtifactBytes, capacity.maxTotalBytes])
    if (
      !Number.isSafeInteger(value) ||
      value < 1 ||
      value > Number.MAX_SAFE_INTEGER / 4
    )
      throw new Error("Invalid vault capacity.");
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
        throw new Error("Unexpected entry in legacy vault.");
      for (const file of await readdir(join(rootPath, entry.name), {
        withFileTypes: true,
      })) {
        if (!file.isFile()) throw new Error("Unexpected legacy artifact.");
        const stat = await lstat(join(rootPath, entry.name, file.name));
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
        throw new Error("Recovery key unavailable or incorrect for retained vault.");
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
          throw new Error("Recovery key unavailable or incorrect for retained vault.");
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
            throw new Error("Recovery key unavailable or incorrect for retained vault.");
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
    await mkdir(rootPath, { recursive: true, mode: 0o700 });
    const old = await legacyState(),
      path = join(rootPath, "vault.sqlite"),
      db = new DatabaseSync(path);
    try {
      await chmod(path, 0o600);
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
      if (schemaVersion > 1)
        throw new Error("Unsupported recovery vault schema version.");
      db.exec(`CREATE TABLE IF NOT EXISTS settings(id INTEGER PRIMARY KEY CHECK(id=1),capacity TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS artifacts(workspace TEXT NOT NULL,digest TEXT NOT NULL,key_id TEXT NOT NULL,data BLOB NOT NULL,operation_id TEXT,slot TEXT,content_digest TEXT NOT NULL,PRIMARY KEY(workspace,digest),UNIQUE(workspace,operation_id,slot));
    CREATE TABLE IF NOT EXISTS reservations(workspace TEXT NOT NULL,operation_id TEXT NOT NULL,slot TEXT NOT NULL,bytes INTEGER NOT NULL,PRIMARY KEY(workspace,operation_id,slot));
    CREATE TABLE IF NOT EXISTS key_checks(key_id TEXT PRIMARY KEY,proof TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS artifacts_key_id ON artifacts(key_id);
    CREATE TABLE IF NOT EXISTS capacity_migrations(at TEXT NOT NULL,operator_id TEXT NOT NULL,from_capacity TEXT NOT NULL,to_capacity TEXT NOT NULL,used_bytes INTEGER NOT NULL,reservations INTEGER NOT NULL);
    PRAGMA user_version=1;`);
      const limits = canonicalJson({ maxArtifactBytes, maxTotalBytes });
      db.prepare("INSERT OR IGNORE INTO settings VALUES(1,?)").run(limits);
      const expected = migrate
        ? canonicalJson(capacityOf(migrate.from))
        : limits;
      const persisted: unknown = db
        .prepare("SELECT capacity FROM settings WHERE id=1")
        .get();
      if (
        typeof persisted !== "object" ||
        persisted === null ||
        !("capacity" in persisted) ||
        persisted.capacity !== expected
      )
        throw new Error(
          migrate
            ? "Recovery vault capacity migration does not match the capacity the vault holds."
            : "Vault capacity differs from its persisted configuration.",
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
      throw new Error("Recovery artifact digest or size mismatch.");
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
        throw new Error("Invalid vault slot.");
    }
    if (!Number.isSafeInteger(bytes) || bytes < 1)
      throw new Error("A recovery artifact declares a positive byte count.");
    if (bytes > maxArtifactBytes)
      throw new VaultCapacityError("Recovery artifact exceeds quota.");
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
        throw new Error("Vault slot belongs to different evidence.");
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
      throw new Error("Recovery slot is not reserved.");
    const reference = {
      digest: streamedBase64Digest(data),
      keyId: currentKey,
      bytes: data.byteLength,
    };
    if (
      data.byteLength > Number(reserved?.bytes ?? maxTotalBytes) ||
      used - Number(reserved?.bytes ?? 0) + data.byteLength > maxTotalBytes
    )
      throw new VaultCapacityError("Recovery vault total quota exhausted.");
    db.prepare("INSERT INTO artifacts VALUES(?,?,?,?,?,?,?)").run(
      workspace,
      reference.digest,
      currentKey,
      data,
      allocation?.operationId ?? null,
      allocation?.slot ?? null,
      contentDigest,
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
          throw new VaultCapacityError("Recovery vault total quota exhausted.");
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
        throw new Error("A streamed recovery artifact declares its byte count.");
      // The declared length is proved against the quota before the source is
      // touched, so an oversized capture costs no chunk of reading.
      if (
        !Number.isSafeInteger(request.bytes) ||
        request.bytes < 1 ||
        request.bytes > maxArtifactBytes
      )
        throw new VaultCapacityError("Recovery artifact exceeds quota.");
      return transaction((db, used) =>
        write(db, used, workspace, source, request.bytes, request.allocation),
      );
    },
    async *getStream(workspace, reference) {
      identity(workspace);
      if (!/^[a-f0-9]{64}$/.test(reference.digest))
        throw new Error("Invalid recovery reference.");
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
        throw new Error("Recovery artifact digest or size mismatch.");
      const stored: Buffer = view(blob);
      // The stored payload arrives as one SQLite blob, which is the last
      // full-size allocation on this path. Verifying and decrypting it in place
      // is what removes the four plaintext-sized copies the value reader made.
      if (
        stored.byteLength !== reference.bytes ||
        streamedBase64Digest(stored) !== reference.digest
      )
        throw new Error("Recovery artifact digest or size mismatch.");
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
    async get(workspace, reference) {
      identity(workspace);
      if (!/^[a-f0-9]{64}$/.test(reference.digest))
        throw new Error("Invalid recovery reference.");
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

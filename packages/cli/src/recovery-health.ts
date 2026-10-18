import { lstat, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { jsonlStore } from "../../ledger/src/store.ts";
import { retainedKeyProvider } from "../../ledger/src/sign.ts";
import { recoveryKeyProof } from "../../runtime/src/reserved-vault.ts";
import type { KeyProvider } from "../../ledger/src/index.ts";
import {
  assertPrivateDirectoryPath,
  assertPrivateFileIfPresent,
  assertPrivateFilePath,
} from "../../ledger/src/hardening.ts";

export type RecoveryHealthStatus = "healthy" | "degraded" | "unavailable" | "unsafe";
export type RecoveryHealthReport = {
  status: RecoveryHealthStatus;
  adapter: { id: string; version: string };
  state: {
    present: boolean;
    signingKey: "available" | "missing" | "invalid" | "unavailable";
    journal: "verified" | "missing" | "invalid" | "incomplete" | "unavailable";
    vault: "verified" | "unmarked" | "mismatch" | "missing" | "invalid" | "unavailable";
  };
  capacity: {
    maxArtifactBytes: number | null;
    maxTotalBytes: number | null;
    usedBytes: number;
    artifactBytes: number;
    reservationBytes: number;
    legacyBytes: number;
    artifacts: number;
    reservations: number;
  };
  /** One shell summary of the vault's retention evidence, counted the same
   * unfiltered way capacity is. `withoutEvidence` counts artifacts whose
   * (workspace, digest) has no recorded lifecycle: they are still protected,
   * but by nothing an operator can read, which is exactly what a collector
   * run would refuse to reason about. */
  retention: {
    present: boolean;
    evidence: number;
    pinned: number;
    released: number;
    withoutEvidence: number;
  };
  jobs: { paused: number; unknown: number };
  repairs: string[];
};

type HealthInput = {
  stateDir: string;
  workspace: string;
  adapter: { id: string; version: string };
  encryptionKey?: Uint8Array;
  keyId?: string;
};

const isMissing = (error: unknown): boolean =>
  typeof error === "object" &&
  error !== null &&
  "code" in error &&
  error.code === "ENOENT";
const numberField = (row: unknown, key: string): number | null => {
  if (typeof row !== "object" || row === null || Array.isArray(row)) return null;
  const value = Object.entries(row).find(([name]) => name === key)?.[1];
  return typeof value === "number" ? value : null;
};
const addRepair = (repairs: Set<string>, code: string): void => {
  repairs.add(code);
};
const markUnavailable = (report: { status: RecoveryHealthStatus }): void => {
  if (report.status !== "unsafe") report.status = "unavailable";
};

async function legacyBytes(root: string): Promise<number> {
  let bytes = 0;
  const visit = async (directory: string): Promise<void> => {
    await assertPrivateDirectoryPath(directory, "legacy recovery vault directory");
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (
        entry.name === "vault.sqlite" ||
        entry.name.startsWith("vault.sqlite-")
      )
        continue;
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile()) {
        await assertPrivateFilePath(path, "legacy recovery vault artifact");
        bytes += (await lstat(path)).size;
      }
      else throw new Error("Unexpected legacy vault entry.");
    }
  };
  await assertPrivateDirectoryPath(root, "recovery vault directory");
  await visit(root);
  return bytes;
}

async function readJournal(
  input: HealthInput,
  signer: KeyProvider | undefined,
): Promise<{
  status: RecoveryHealthReport["state"]["journal"];
  paused: number;
  unknown: number;
}> {
  const journalPath = join(input.stateDir, "journal", `${input.workspace}.jsonl`);
  try {
    await lstat(journalPath);
  } catch (error) {
    return {
      status: isMissing(error) ? "missing" : "unavailable",
      paused: 0,
      unknown: 0,
    };
  }
  if (!signer) return { status: "unavailable", paused: 0, unknown: 0 };
  try {
    const stat = await lstat(journalPath);
    if (!stat.isFile()) return { status: "invalid", paused: 0, unknown: 0 };
    const store = jsonlStore(signer, { dir: join(input.stateDir, "journal") });
    const verification = await store.verify(input.workspace);
    if (!verification.ok) return { status: "invalid", paused: 0, unknown: 0 };
    if (verification.checked === 0)
      return { status: "incomplete", paused: 0, unknown: 0 };
    const operations = new Map<string, string>();
    const jobs = new Map<string, string>();
    for await (const entry of store.read(input.workspace)) {
      const body = entry.body;
      if (typeof body !== "object" || body === null || Array.isArray(body))
        return { status: "invalid", paused: 0, unknown: 0 };
      const schema = "schema" in body ? body.schema : undefined;
      const operationId = "operationId" in body ? body.operationId : undefined;
      const operationStage = "stage" in body ? body.stage : undefined;
      const jobId = "jobId" in body ? body.jobId : undefined;
      const jobStage = "stage" in body ? body.stage : undefined;
      if (
        schema === "void.operation.v1" &&
        typeof operationId === "string" &&
        typeof operationStage === "string"
      )
        operations.set(operationId, operationStage);
      if (
        schema === "void.recovery-job.v1" &&
        typeof jobId === "string" &&
        typeof jobStage === "string"
      )
        jobs.set(jobId, jobStage);
    }
    let paused = 0;
    let unknown = 0;
    for (const stage of jobs.values()) {
      if (stage === "paused") paused += 1;
      if (stage === "unknown") unknown += 1;
    }
    for (const stage of operations.values()) if (stage === "unknown") unknown += 1;
    return { status: "verified", paused, unknown };
  } catch (error) {
    return {
      status: isMissing(error) ? "missing" : "invalid",
      paused: 0,
      unknown: 0,
    };
  }
}

async function readVault(
  input: HealthInput,
): Promise<{
  status: RecoveryHealthReport["state"]["vault"];
  capacity: RecoveryHealthReport["capacity"];
  retention: RecoveryHealthReport["retention"];
}> {
  const root = join(input.stateDir, "vault");
  const path = join(root, "vault.sqlite");
  const empty: RecoveryHealthReport["capacity"] = {
    maxArtifactBytes: null,
    maxTotalBytes: null,
    usedBytes: 0,
    artifactBytes: 0,
    reservationBytes: 0,
    legacyBytes: 0,
    artifacts: 0,
    reservations: 0,
  };
  const emptyRetention: RecoveryHealthReport["retention"] = {
    present: false,
    evidence: 0,
    pinned: 0,
    released: 0,
    withoutEvidence: 0,
  };
  try {
    await assertPrivateDirectoryPath(root, "recovery vault directory");
    await assertPrivateFilePath(path, "recovery vault database");
    for (const suffix of ["-journal", "-wal", "-shm"])
      await assertPrivateFileIfPresent(
        `${path}${suffix}`,
        "recovery vault SQLite sidecar",
      );
  } catch (error) {
    return {
      status: isMissing(error) ? "missing" : "invalid",
      capacity: empty,
      retention: emptyRetention,
    };
  }
  let db: DatabaseSync;
  try {
    db = new DatabaseSync(path, { readOnly: true });
  } catch (error) {
    return {
      status: isMissing(error) ? "missing" : "unavailable",
      capacity: empty,
      retention: emptyRetention,
    };
  }
  try {
    const settings = db.prepare("SELECT capacity FROM settings WHERE id=1").get();
    if (
      typeof settings !== "object" ||
      settings === null ||
      Array.isArray(settings) ||
      !("capacity" in settings) ||
      typeof settings.capacity !== "string"
    )
      return { status: "invalid", capacity: empty, retention: emptyRetention };
    const parsed: unknown = JSON.parse(settings.capacity);
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      Array.isArray(parsed) ||
      !("maxArtifactBytes" in parsed) ||
      !("maxTotalBytes" in parsed) ||
      typeof parsed.maxArtifactBytes !== "number" ||
      typeof parsed.maxTotalBytes !== "number" ||
      !Number.isSafeInteger(parsed.maxArtifactBytes) ||
      !Number.isSafeInteger(parsed.maxTotalBytes) ||
      parsed.maxArtifactBytes < 1 ||
      parsed.maxTotalBytes < 1
    )
      return { status: "invalid", capacity: empty, retention: emptyRetention };
    const artifacts = db
      .prepare("SELECT count(*) AS count,COALESCE(SUM(length(data)),0) AS bytes FROM artifacts")
      .get();
    const reservations = db
      .prepare("SELECT count(*) AS count,COALESCE(SUM(bytes),0) AS bytes FROM reservations")
      .get();
    // Retention evidence exists from schema 2 on. A schema 1 vault reports
    // present: false rather than zeroes that would read as "nothing is
    // pinned", because its rows are still protected and there is no surface
    // that could ever say which.
    const retentionTable = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='retention'")
      .get();
    let retention: RecoveryHealthReport["retention"];
    if (retentionTable === undefined) {
      retention = { ...emptyRetention };
    } else {
      const records = db
        .prepare(
          "SELECT count(*) AS count,SUM(CASE WHEN json_extract(record,'$.pin.ownerId') IS NOT NULL THEN 1 ELSE 0 END) AS pinned,SUM(CASE WHEN json_extract(record,'$.release.released') IS NOT NULL THEN 1 ELSE 0 END) AS released FROM retention",
        )
        .get();
      const orphaned = db
        .prepare(
          "SELECT count(*) AS count FROM artifacts a WHERE NOT EXISTS (SELECT 1 FROM retention r WHERE r.workspace=a.workspace AND r.digest=a.digest)",
        )
        .get();
      retention = {
        present: true,
        evidence: numberField(records, "count") ?? 0,
        pinned: numberField(records, "pinned") ?? 0,
        released: numberField(records, "released") ?? 0,
        withoutEvidence: numberField(orphaned, "count") ?? 0,
      };
    }
    const artifactBytes = numberField(artifacts, "bytes") ?? 0;
    const reservationBytes = numberField(reservations, "bytes") ?? 0;
    const legacy = await legacyBytes(root);
    const capacity: RecoveryHealthReport["capacity"] = {
      maxArtifactBytes: parsed.maxArtifactBytes,
      maxTotalBytes: parsed.maxTotalBytes,
      usedBytes: artifactBytes + reservationBytes + legacy,
      artifactBytes,
      reservationBytes,
      legacyBytes: legacy,
      artifacts: numberField(artifacts, "count") ?? 0,
      reservations: numberField(reservations, "count") ?? 0,
    };
    const keyId = input.keyId ?? "local";
    const encryptionKey = input.encryptionKey;
    if (encryptionKey === undefined || encryptionKey.byteLength !== 32)
      return { status: "unavailable", capacity, retention };
    const marker = db
      .prepare("SELECT proof FROM key_checks WHERE key_id=?")
      .get(keyId);
    if (!marker) return { status: "unmarked", capacity, retention };
    if (
      typeof marker !== "object" ||
      marker === null ||
      Array.isArray(marker) ||
      !("proof" in marker) ||
      typeof marker.proof !== "string"
    )
      return { status: "invalid", capacity, retention };
    const expected = recoveryKeyProof(encryptionKey, keyId);
    if (marker.proof !== expected) return { status: "mismatch", capacity, retention };
    return { status: "verified", capacity, retention };
  } catch {
    // A partial read reports the empty retention shell, the way capacity
    // degrades: an unprovable vault is one an operator inspects.
    return { status: "invalid", capacity: empty, retention: emptyRetention };
  } finally {
    db.close();
  }
}

export async function inspectRecoveryHealth(
  input: HealthInput,
): Promise<RecoveryHealthReport> {
  if (!/^[\w-]{1,100}$/.test(input.workspace))
    throw new Error("Invalid recovery workspace.");
  const report: RecoveryHealthReport = {
    status: "healthy",
    adapter: input.adapter,
    state: {
      present: false,
      signingKey: "unavailable",
      journal: "unavailable",
      vault: "unavailable",
    },
    capacity: {
      maxArtifactBytes: null,
      maxTotalBytes: null,
      usedBytes: 0,
      artifactBytes: 0,
      reservationBytes: 0,
      legacyBytes: 0,
      artifacts: 0,
      reservations: 0,
    },
    retention: {
      present: false,
      evidence: 0,
      pinned: 0,
      released: 0,
      withoutEvidence: 0,
    },
    jobs: { paused: 0, unknown: 0 },
    repairs: [],
  };
  const repairs = new Set<string>();
  let signer: KeyProvider | undefined;
  try {
    signer = await retainedKeyProvider({
      dir: join(resolve(input.stateDir), "keys"),
      env: {},
    });
    report.state.signingKey = "available";
  } catch (error) {
    report.state.signingKey = isMissing(error) ? "missing" : "invalid";
    addRepair(repairs, "restore-original-signing-key");
    markUnavailable(report);
  }
  const journal = await readJournal(
    { ...input, stateDir: resolve(input.stateDir) },
    signer,
  );
  report.state.journal = journal.status;
  report.jobs = { paused: journal.paused, unknown: journal.unknown };
  if (journal.status === "missing" || journal.status === "unavailable") {
    addRepair(repairs, "restore-complete-signed-history");
    markUnavailable(report);
  } else if (journal.status !== "verified") {
    addRepair(repairs, "verify-and-restore-signed-history");
    report.status = "unsafe";
  }
  if (journal.paused || journal.unknown) {
    addRepair(repairs, "review-retained-unknown-work");
    if (report.status === "healthy") report.status = "degraded";
  }
  const vault = await readVault({
    ...input,
    stateDir: resolve(input.stateDir),
  });
  report.state.vault = vault.status;
  report.capacity = vault.capacity;
  report.retention = vault.retention;
  if (vault.status === "missing") {
    addRepair(repairs, "restore-vault-snapshot");
    markUnavailable(report);
  } else if (vault.status === "mismatch" || vault.status === "invalid") {
    addRepair(repairs, "restore-matching-vault-state");
    report.status = "unsafe";
  } else if (vault.status === "unavailable") {
    addRepair(repairs, "provide-original-encryption-key");
    markUnavailable(report);
  } else if (vault.status === "unmarked") {
    addRepair(repairs, "migrate-and-verify-vault-key");
    if (report.status === "healthy") report.status = "degraded";
  }
  if (
    report.capacity.maxTotalBytes !== null &&
    report.capacity.usedBytes > report.capacity.maxTotalBytes
  ) {
    addRepair(repairs, "free-or-review-vault-capacity");
    if (report.status === "healthy") report.status = "degraded";
  }
  report.state.present =
    report.state.signingKey !== "missing" ||
    report.state.journal !== "missing" ||
    report.state.vault !== "missing";
  report.repairs = [...repairs].sort();
  return report;
}

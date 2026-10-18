/** A dry-run prediction for the legacy file vault collector. It reads the
 * artifact tree and the lifecycle evidence exactly the way collectVaultGarbage
 * reads them, and writes nothing: no journal chain, no sidecar, no artifact.
 * A prediction that left a signed chain behind would read as a deletion that
 * happened, which is the one lie this surface must never tell. The rules are
 * the file vault's own, verbatim: absent evidence protects because the pin
 * state is unknown, a recorded pin protects until an operator's named
 * release, and only unpinned artifacts with a provably past write time
 * expire. Manual policies expire nothing. */
import { readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { GarbageReport } from "../../connectors/src/snapshot/store.ts";
import {
  evidenceDir,
  MANUAL_RETENTION_POLICY,
  parseVaultLifecycle,
  validateRetentionPolicy,
  vaultFiles,
  type RetentionPolicy,
  type VaultFile,
} from "./retention.ts";

export function evaluateFileVaultRetentionPolicy(
  files: readonly VaultFile[],
  policy: RetentionPolicy,
  now: number,
): {
  readonly deleting: readonly VaultFile[];
  readonly skippedPinned: number;
  readonly retained: number;
} {
  const ttl = policy.ttlByKind.unpinned;
  // The file collector keys expiration on the artifact's recorded mtime, not
  // on lifecycle evidence: an unknown age is not a passed age, and a pinned
  // artifact never expires until the release is recorded.
  const expired =
    ttl === null ? [] : files.filter((file) => now - file.mtimeMs >= ttl);
  const deleting = expired.filter((file) => !file.pinned);
  const skippedPinned = expired.length - deleting.length;
  return {
    deleting,
    skippedPinned,
    retained: files.length - deleting.length - skippedPinned,
  };
}

export async function auditFileVaultCollection(options: {
  readonly root: string;
  readonly index: string;
  readonly workspace: string;
  readonly policy?: RetentionPolicy;
  readonly clock?: () => Date;
}): Promise<GarbageReport & { readonly digests: readonly string[] }> {
  if (!/^[\w-]{1,120}$/.test(options.workspace))
    throw new Error("Invalid vault retention identity.");
  const policy = validateRetentionPolicy(
    options.policy ?? MANUAL_RETENTION_POLICY,
  );
  const evidence = evidenceDir(options.index, options.workspace, options.root);
  const files = await vaultFiles(
    join(resolve(options.root), options.workspace),
    evidence,
  );
  const { deleting, skippedPinned, retained } =
    evaluateFileVaultRetentionPolicy(
      files,
      policy,
      (options.clock ?? (() => new Date()))().getTime(),
    );
  return {
    skippedPinned,
    retained,
    deleted: deleting.length,
    freedBytes: deleting.reduce((sum, file) => sum + file.size, 0),
    digests: deleting.map((file) => file.artifact.digest),
  };
}

export type FileVaultRetentionSummary = {
  readonly present: boolean;
  readonly evidence: number;
  readonly pinned: number;
  readonly released: number;
  readonly withoutEvidence: number;
};

/** One health-shaped view of the legacy file half, read from the very same
 * records the collector reads. An evidence tree nobody ever wrote leaves
 * present false with every recorded count zero, while files the tree would
 * have described land in withoutEvidence: protected, by nothing readable.
 * The counts mirror the collector rather than reinterpreting it, and a
 * record the reader cannot prove is a refusal through parseVaultLifecycle,
 * never a guessed zero. */
export async function summarizeFileVaultRetention(options: {
  readonly root: string;
  readonly index: string;
  readonly workspace: string;
}): Promise<FileVaultRetentionSummary> {
  const evidence = evidenceDir(options.index, options.workspace, options.root);
  const names = await readdir(evidence, { withFileTypes: true }).catch(
    (error: unknown) => {
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "ENOENT"
      )
        return null;
      throw error;
    },
  );
  // The artifact list stands on its own: a vault whose evidence tree was
  // never written still holds files, and each one is protected by nothing
  // an operator can read, so its count lands in withoutEvidence even while
  // present stays false.
  const files = await vaultFiles(
    join(resolve(options.root), options.workspace),
    evidence,
  );
  if (names === null)
    return {
      present: false,
      evidence: 0,
      pinned: 0,
      released: 0,
      withoutEvidence: files.length,
    };
  const covered = new Set<string>();
  let pinned = 0,
    released = 0,
    sidecars = 0;
  for (const entry of names) {
    if (!entry.isFile() || !/^[a-f0-9]{64}\.meta$/.test(entry.name)) continue;
    const digest = entry.name.replace(/\.meta$/, "");
    covered.add(digest);
    sidecars += 1;
    const record = parseVaultLifecycle(
      await readFile(join(evidence, `${digest}.meta`), "utf8"),
    );
    if (record === undefined)
      throw new Error("Recovery artifact lifecycle is invalid; retention refused.");
    // Marking with no pin is the documented release-for-retention record on
    // the file side, so every sidecar without a pin counts as released and
    // only recorded pins count as pinned, which is the collector's own
    // reading of the record.
    if (record.pin !== undefined) pinned += 1;
    else released += 1;
  }
  return {
    present: true,
    evidence: sidecars,
    pinned,
    released,
    withoutEvidence: files.filter((file) => !covered.has(file.artifact.digest))
      .length,
  };
}

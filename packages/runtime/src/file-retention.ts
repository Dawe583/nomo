/** A dry-run prediction for the legacy file vault collector. It reads the
 * artifact tree and the lifecycle evidence exactly the way collectVaultGarbage
 * reads them, and writes nothing: no journal chain, no sidecar, no artifact.
 * A prediction that left a signed chain behind would read as a deletion that
 * happened, which is the one lie this surface must never tell. The rules are
 * the file vault's own, verbatim: absent evidence protects because the pin
 * state is unknown, a recorded pin protects until an operator's named
 * release, and only unpinned artifacts with a provably past write time
 * expire. Manual policies expire nothing. */
import { join, resolve } from "node:path";
import type { GarbageReport } from "../../connectors/src/snapshot/store.ts";
import {
  evidenceDir,
  MANUAL_RETENTION_POLICY,
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

/** Retention operator commands over both vault halves.
 *
 * WHY this file: markVaultLifecycle and releaseVaultPin are library APIs
 * with zero consumers, so the retention contract's own words, a pinned
 * artifact stays until a named release, had no surface an operator could
 * act on. This module is that surface. Every refusal it can produce is a
 * library refusal, never a CLI re-statement of the rule, and a record the
 * reader cannot prove is a parse refusal, never a guessed row. */
import { readdir, readFile, stat } from "node:fs/promises";
import type { Dirent } from "node:fs";
import { join, resolve } from "node:path";
import {
  evidenceDir,
  markVaultLifecycle,
  parseVaultLifecycle,
  releaseVaultPin,
  vaultFiles,
  type VaultLifecycle,
  type VaultPin,
} from "../../runtime/src/retention.ts";
import type {
  ManagedRecoveryVault,
} from "../../runtime/src/reserved-vault.ts";
import type { VaultReference } from "../../runtime/src/vault.ts";

/** The key id both vault halves the CLI constructs name. The reference
 * travels with the row, so a different label here would read as a second
 * key while the stores hold exactly one. */
export const VAULT_KEY_ID = "local";

export type RetentionRow = {
  readonly digest: string;
  /** Bytes of the artifact when it exists; null for a record whose artifact
   * collection already removed, which is how collection's evidence survives
   * the delete it funded. */
  readonly bytes: number | null;
  readonly artifact: boolean;
  /** Reserved rows carry the stored write time; the file half states the
   * artifact's mtime. A null here is the schema 1 state and stays protected
   * because an unknown age is not a passed age. */
  readonly writtenAt: string | null;
  readonly lifecycle: VaultLifecycle | undefined;
};

const sidecarName = /^[a-f0-9]{64}\.meta$/;
const isMissing = (error: unknown): boolean =>
  typeof error === "object" && error !== null && "code" in error &&
  error.code === "ENOENT";

/** The evidence tree lives outside the artifact root on purpose, and
 * evidenceDir is the same resolver every consumer uses, so an operator
 * listing records cannot read a tree the collector would not. */
export async function listFileVaultRetention(options: {
  readonly root: string;
  readonly index: string;
  readonly workspace: string;
}): Promise<RetentionRow[]> {
  const evidence = evidenceDir(
    options.index,
    options.workspace,
    options.root,
  );
  const rows = new Map<string, RetentionRow>();
  for (const file of await vaultFiles(
    join(resolve(options.root), options.workspace),
    evidence,
  ))
    rows.set(file.artifact.digest, {
      digest: file.artifact.digest,
      bytes: file.size,
      artifact: true,
      writtenAt: new Date(file.mtimeMs).toISOString(),
      lifecycle: undefined,
    });
  const names = await readdir(evidence, { withFileTypes: true }).catch(
    (error: unknown): Dirent[] => {
      if (isMissing(error)) return [];
      throw error;
    },
  );
  for (const entry of names) {
    if (!entry.isFile() || !sidecarName.test(entry.name)) continue;
    const digest = entry.name.replace(/\.meta$/, "");
    const existing = rows.get(digest);
    rows.set(digest, {
      digest,
      bytes: existing?.bytes ?? null,
      artifact: existing !== undefined,
      writtenAt: existing?.writtenAt ?? null,
      lifecycle: parseVaultLifecycle(
        await readFile(join(evidence, entry.name), "utf8"),
      ),
    });
  }
  return [...rows.values()].sort((a, b) => (a.digest < b.digest ? -1 : 1));
}

export async function listReservedVaultRetention(
  vault: Pick<ManagedRecoveryVault, "retentionEntries">,
  workspace: string,
): Promise<RetentionRow[]> {
  return (await vault.retentionEntries(workspace))
    .map((row) => ({
      digest: row.digest,
      bytes: row.bytes,
      // retentionEntries reads the artifact table itself, so a row here
      // always names an artifact the store holds.
      artifact: true,
      writtenAt: row.at,
      lifecycle: row.lifecycle,
    }))
    .sort((a, b) => (a.digest < b.digest ? -1 : 1));
}

const fileVaultReference = async (
  root: string,
  workspace: string,
  digest: string,
): Promise<VaultReference> => {
  let size: number;
  try {
    size = (await stat(join(resolve(root), workspace, digest))).size;
  } catch {
    // The mark itself refuses the same absence inside its lock; naming it
    // here too means the operator reads one reason wherever the call is
    // made.
    throw new Error(
      "Recovery artifact is unavailable; lifecycle was not recorded.",
    );
  }
  return { digest, keyId: VAULT_KEY_ID, bytes: size };
};

export async function pinFileVaultLifecycle(options: {
  readonly root: string;
  readonly index: string;
  readonly workspace: string;
  readonly digest: string;
  readonly pin: VaultPin;
}): Promise<void> {
  await markVaultLifecycle({
    root: options.root,
    index: options.index,
    workspace: options.workspace,
    reference: await fileVaultReference(
      options.root,
      options.workspace,
      options.digest,
    ),
    pin: options.pin,
  });
}

export async function markFileVaultUnpinned(options: {
  readonly root: string;
  readonly index: string;
  readonly workspace: string;
  readonly digest: string;
}): Promise<void> {
  // No pin in the request is the documented release-for-retention record:
  // the operator reviews the artifact and marks the past-TTL state the
  // policy may act on.
  await markVaultLifecycle({
    root: options.root,
    index: options.index,
    workspace: options.workspace,
    reference: await fileVaultReference(
      options.root,
      options.workspace,
      options.digest,
    ),
  });
}

export async function releaseFileVaultPin(options: {
  readonly root: string;
  readonly index: string;
  readonly workspace: string;
  readonly digest: string;
  readonly pin: VaultPin;
  readonly operatorId: string;
}): Promise<void> {
  await releaseVaultPin({
    root: options.root,
    index: options.index,
    workspace: options.workspace,
    reference: await fileVaultReference(
      options.root,
      options.workspace,
      options.digest,
    ),
    pin: options.pin,
    operatorId: options.operatorId,
  });
}

export async function reservedVaultReference(
  vault: Pick<ManagedRecoveryVault, "retentionEntries">,
  workspace: string,
  digest: string,
): Promise<VaultReference> {
  const row = (await vault.retentionEntries(workspace)).find(
    (entry) => entry.digest === digest,
  );
  if (!row)
    throw new Error(
      "Recovery artifact is unavailable; lifecycle was not recorded.",
    );
  return { digest, keyId: VAULT_KEY_ID, bytes: row.bytes };
}

/** Retention collection for the reserved SQLite vault. The file-vault
 * collector only ever walked workspace directories, which left the reserved
 * vault without any way to free capacity: a store whose confirmed failures
 * release their slots but whose artifacts are never collected would hold
 * every byte it ever touched forever. The invariants are the file vault's
 * verbatim: absent or conflicting evidence protects, an unknown age is not a
 * passed age, only a recorded release names the protection it removed, and
 * the run is a signed operation journal chain so a delete is never silent. */
import type { GarbageReport } from "../../connectors/src/snapshot/store.ts";
import { canonicalJson } from "../../ledger/src/canonical.ts";
import {
  digest,
  type OperationEvent,
  type OperationJournal,
  type Stage,
} from "./journal.ts";
import type { RetentionReport } from "../../connectors/src/snapshot/store.ts";
import type { ManagedRecoveryVault } from "./reserved-vault.ts";
import {
  MANUAL_RETENTION_POLICY,
  validateRetentionPolicy,
  type RetentionRequest,
  type RetentionPolicy,
  type VaultLifecycle,
} from "./retention.ts";
import type { Json } from "../../connectors/src/recovery.ts";

export type ReservedVaultGarbageOptions = {
  readonly workspace: string;
  readonly operationId: string;
  readonly agentId: string;
  readonly runId: string;
  readonly policy?: RetentionPolicy;
  readonly clock?: () => Date;
  readonly authorize: (request: RetentionRequest) => Promise<boolean>;
  readonly journal: OperationJournal;
  readonly vault: ManagedRecoveryVault;
};

/** R03 garbage collection for the reserved vault. It reuses the same stage
 * protocol as the file collector: received, authorized, prepared, dispatched,
 * then succeeded or failed, with the policy digest recorded at every stage so
 * the chain can be replayed against the later policy state. */
export async function collectReservedVaultGarbage(
  options: ReservedVaultGarbageOptions,
): Promise<GarbageReport> {
  const policy = validateRetentionPolicy(
    options.policy ?? MANUAL_RETENTION_POLICY,
  );
  const { workspace, operationId, agentId, runId } = options;
  for (const value of [workspace, operationId, agentId, runId])
    if (!/^[\w-]{1,120}$/.test(value))
      throw new Error("Invalid vault retention identity.");
  const clock = options.clock ?? (() => new Date());
  const policyDigest = digest(canonicalJson(policy));
  const identity: OperationEvent = {
    schema: "void.operation.v1",
    workspace,
    operationId,
    requestDigest: digest(canonicalJson({ workspace, policyDigest })),
    adapterId: "vault.retention",
    adapterVersion: "1",
    agentId,
    runId,
    at: clock().toISOString(),
    stage: "received",
    data: {
      policy: JSON.parse(canonicalJson(policy)) as Json,
      policyDigest,
    },
  };
  return options.journal.transaction(workspace, async (tx) => {
    const record = async (stage: Stage, data: Json = null) => {
      await tx.append({ ...identity, stage, data, at: clock().toISOString() });
    };
    await record("received", identity.data);
    if (!(await options.authorize({ workspace, operationId, policyDigest }))) {
      await record("denied");
      throw new Error("Vault retention was denied; no artifact was collected.");
    }
    await record("authorized");
    // The snapshot refuses as a whole when any evidence is unreadable, so a
    // pin this store cannot prove is never resolved in favour of deleting.
    const rows = await options.vault.retentionEntries(workspace);
    const ttl = policy.ttlByKind.unpinned,
      now = clock().getTime();
    // The file vault's rules, verbatim: absent evidence protects because the
    // pin state is unknown, a recorded pin protects until an operator's named
    // release, and only unpinned artifacts with a provably past write time
    // are expired. A schema 1 artifact carries no write time and an
    // unparseable one is treated the same way: an unknown age is not a
    // passed age.
    const pinnedOf = (row: { lifecycle: VaultLifecycle | undefined }): boolean =>
      row.lifecycle === undefined || row.lifecycle.pin !== undefined;
    const pastTtl = (row: { at: string | null }): boolean =>
      ttl !== null &&
      row.at !== null &&
      Number.isFinite(Date.parse(row.at)) &&
      now - Date.parse(row.at) >= ttl;
    // A manual policy expires nothing, exactly as the file collector does.
    const expired = rows.filter(pastTtl);
    const skippedPinned = expired.filter(pinnedOf).length;
    await record("prepared", {
      policyDigest,
      expired: expired.length,
      skippedPinned,
      retained: rows.length - skippedPinned,
    });
    await record("dispatched", {
      policyDigest,
      deleting: expired.length - skippedPinned,
    });
    let report: RetentionReport;
    try {
      report = await options.vault.deleteRetained(
        workspace,
        expired.filter((row) => !pinnedOf(row)).map((row) => row.digest),
      );
    } catch (error) {
      await record("failed", {
        policyDigest,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
    if (report.errors.length) {
      await record("failed", { policyDigest, errors: [...report.errors] });
      throw new Error("Recovery vault garbage collection failed.");
    }
    // The report keeps the file collector's arithmetic: what was seen at the
    // start is exactly what stayed, what was protected, and what was deleted.
    const garbage: GarbageReport = {
      skippedPinned,
      retained: rows.length - report.deleted - skippedPinned,
      deleted: report.deleted,
      freedBytes: report.freedBytes,
    };
    await record("succeeded", { policyDigest, ...garbage });
    return garbage;
  });
}

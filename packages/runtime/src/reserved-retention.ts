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
import type { ManagedRecoveryVault, ReservedRetentionRow } from "./reserved-vault.ts";
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

/** The pure policy evaluation the collector and a dry run share: which rows
 * the policy would delete, which expired rows were protected, and nothing
 * more. It decides from one snapshot; the collector still re-proves inside
 * its own transaction, and a manual policy expires nothing, exactly as the
 * file collector does. */
export function evaluateReservedVaultRetentionPolicy(
  rows: ReservedRetentionRow[],
  policy: RetentionPolicy,
  now: number,
): {
  deleting: ReadonlyArray<ReservedRetentionRow>;
  skippedPinned: number;
  retained: number;
} {
  const ttl = policy.ttlByKind.unpinned;
  const pinnedOf = (row: { lifecycle: VaultLifecycle | undefined }): boolean =>
    row.lifecycle === undefined || row.lifecycle.pin !== undefined;
  const pastTtl = (row: { at: string | null }): boolean =>
    ttl !== null &&
    row.at !== null &&
    Number.isFinite(Date.parse(row.at)) &&
    now - Date.parse(row.at) >= ttl;
  // The file vault's rules, verbatim: absent evidence protects because the
  // pin state is unknown, a recorded pin protects until an operator's named
  // release, and only unpinned artifacts with a provably past write time
  // are expired. A schema 1 artifact carries no write time and an
  // unparseable one is treated the same way: an unknown age is not a
  // passed age.
  const expired = rows.filter(pastTtl);
  const deleting = expired.filter((row) => !pinnedOf(row));
  const skippedPinned = expired.length - deleting.length;
  return { deleting, skippedPinned, retained: rows.length - deleting.length - skippedPinned };
}

/** A dry run: everything the collector reads and evaluates, and nothing it
 * writes. It opens no journal chain, because there is nothing to audit, and
 * it never proves inside a transaction the collector will later hold, which
 * is why its report is a prediction an operator reads before invoking the
 * real one rather than a report of something that happened. */
export async function auditReservedVaultCollection(options: {
  readonly workspace: string;
  readonly policy?: RetentionPolicy;
  readonly clock?: () => Date;
  readonly vault: ManagedRecoveryVault;
}): Promise<GarbageReport & { readonly digests: readonly string[] }> {
  const { workspace } = options;
  if (!/^[\w-]{1,120}$/.test(workspace))
    throw new Error(
      `Recovery retention identity workspace is ${JSON.stringify(workspace)}: it must be 1 to 120 word or hyphen characters.`,
    );
  const policy = validateRetentionPolicy(
    options.policy ?? MANUAL_RETENTION_POLICY,
  );
  const rows = await options.vault.retentionEntries(workspace);
  const { deleting, skippedPinned, retained } = evaluateReservedVaultRetentionPolicy(
    rows,
    policy,
    (options.clock ?? (() => new Date()))().getTime(),
  );
  return {
    skippedPinned,
    retained,
    deleted: deleting.length,
    freedBytes: deleting.reduce((sum, row) => sum + row.bytes, 0),
    digests: deleting.map((row) => row.digest),
  };
}

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
  const identityFields: [string, string][] = [
    ["workspace", workspace],
    ["operationId", operationId],
    ["agentId", agentId],
    ["runId", runId],
  ];
  for (const [field, value] of identityFields)
    if (!/^[\w-]{1,120}$/.test(value))
      throw new Error(
        `Recovery retention identity ${field} is ${JSON.stringify(value)}: it must be 1 to 120 word or hyphen characters.`,
      );
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
    const { deleting, skippedPinned, retained } =
      evaluateReservedVaultRetentionPolicy(rows, policy, clock().getTime());
    await record("prepared", {
      policyDigest,
      expired: deleting.length + skippedPinned,
      skippedPinned,
      retained,
    });
    await record("dispatched", {
      policyDigest,
      deleting: deleting.length,
    });
    // A journal failure after dispatched strands the chain at dispatched, so
    // an error that reached the caller may read as a refusal while the
    // deletes the next statement made stand recorded in no journal. That
    // state is self-healing, not lost work: deleteRetained re-reads inside
    // its own transaction, so an already committed delete comes back as the
    // named "disappeared after the scan" failure instead of a second delete,
    // and a failed rerun carries that name in its own journal.
    let report: RetentionReport;
    try {
      report = await options.vault.deleteRetained(
        workspace,
        deleting.map((row) => row.digest),
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
      throw new Error(
        `Reserved vault garbage collection failed: ${[...report.errors].join("; ")}`,
      );
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

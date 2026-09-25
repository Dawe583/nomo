/**
 * R14: the smallest metrics surface that can be honest.
 *
 * No client library, no scrape endpoint, no new persisted state. Every counter
 * is recomputed from the ledger, the journal and the vault directory that
 * already exist, so the numbers can be thrown away and recomputed at any time
 * and a counter can never drift away from the evidence it claims to summarise.
 *
 * Two rules shape the shape of the output. Labels are closed sets only
 * (`decision` from the policy type, `stage` from the journal transition
 * table), because an open label set is how a metrics endpoint turns into a
 * memory leak and a privacy problem. And unsuccessful work is counted, never
 * skipped: refused ledgers, unreadable ledgers, `failed`, `unknown`,
 * `conflict` and `recovery-unknown` events all appear with their real counts,
 * including the zero counts of the stages that never happened, so a low
 * success rate cannot be made to look like an idle system.
 *
 * A single named ledger must verify before it is counted. A directory scan is
 * the opposite: it exists precisely to count the ledgers that do not verify,
 * so a bad file is counted as unreadable or rejected and the scan continues.
 */

import { readdir, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import {
  LEDGER_READ_MAX_BYTES,
  LEDGER_READ_MAX_ENTRIES,
  readLedgerEntries,
  verifyChain,
  type PublicKeyLookup,
} from "../../ledger/src/verify.ts";
import type { Decision } from "../../policy/src/index.ts";
import {
  jobStageNames,
  operationStageNames,
  readSignedSection,
  readVaultManifest,
  terminalJobStageNames,
  terminalOperationStageNames,
} from "./export-bundle.ts";
import {
  jobStageTable,
  operationStageTable,
  type OperationEvent,
  type RecoveryJobEvent,
} from "../../runtime/src/journal.ts";

export const METRICS_SCHEMA = "void.metrics.v1";

/** Closed label sets. A decision outside the policy union lands in `other`. */
const DECISIONS: readonly Decision[] = ["allow", "deny", "hold"];
const OTHER_DECISION = "other";

export type MetricSample = {
  readonly name: string;
  readonly labels?: Readonly<Record<string, string>>;
  readonly value: number;
};

export type MetricsReport = {
  readonly schema: typeof METRICS_SCHEMA;
  readonly workspace: string;
  readonly sources: {
    readonly ledger: string;
    readonly journal: string;
    readonly vault: string;
  };
  /** Whether the counted entries were authenticated, not merely hash linked. */
  readonly signed: { readonly ledger: boolean; readonly journal: boolean };
  readonly samples: readonly MetricSample[];
};

export type CollectMetricsOptions = {
  /** A workspace ledger file, or a directory of `<workspace>.jsonl` files. */
  readonly ledgerPath: string;
  /** Root holding `journal/` and `vault/`; omitted counters stay out of the report. */
  readonly stateDir?: string | undefined;
  readonly publicKey: PublicKeyLookup;
  readonly journalPublicKey?: PublicKeyLookup | undefined;
};

type LedgerScan = {
  readonly files: number;
  readonly verified: number;
  readonly unreadable: number;
  readonly rejected: number;
  readonly entries: number;
  readonly bytes: number;
  readonly decisions: Readonly<Record<string, number>>;
};

const decisionOf = (body: unknown): string => {
  const value =
    typeof body === "object" && body !== null
      ? (body as Record<string, unknown>).decision
      : undefined;
  return typeof value === "string" && (DECISIONS as readonly string[]).includes(value)
    ? value
    : OTHER_DECISION;
};

export async function collectMetrics(
  options: CollectMetricsOptions,
): Promise<MetricsReport> {
  const info = await stat(options.ledgerPath);
  const directory = info.isDirectory();
  // A directory name is not a workspace identity. In directory-scan mode this
  // is a scan label and the report says so, rather than attributing every
  // counter to something that looks like a workspace and is not one.
  const workspace = directory
    ? `scan:${basename(options.ledgerPath)}`
    : basename(options.ledgerPath, ".jsonl");
  const scan = directory
    ? await scanLedgerDirectory(options.ledgerPath, options.publicKey)
    : await scanLedgerFile(options.ledgerPath, options.publicKey);

  const samples: MetricSample[] = [
    { name: "void_ledger_files_total", value: scan.files },
    { name: "void_ledger_files_verified_total", value: scan.verified },
    { name: "void_ledger_files_unreadable_total", value: scan.unreadable },
    { name: "void_ledger_files_rejected_total", value: scan.rejected },
    { name: "void_ledger_entries_total", value: scan.entries },
    { name: "void_ledger_bytes_total", value: scan.bytes },
    ...DECISIONS.map((decision) => ({
      name: "void_ledger_decisions_total",
      labels: { decision },
      value: scan.decisions[decision] ?? 0,
    })),
    { name: "void_ledger_decisions_total", labels: { decision: OTHER_DECISION }, value: scan.decisions[OTHER_DECISION] ?? 0 },
    { name: "void_ledger_read_max_bytes", value: LEDGER_READ_MAX_BYTES },
    { name: "void_ledger_read_max_entries", value: LEDGER_READ_MAX_ENTRIES },
    { name: "void_transition_operation_states_total", value: operationStageNames().length },
    {
      name: "void_transition_operation_edges_total",
      value: Object.values(operationStageTable).reduce(
        (total, next) => total + next.length,
        0,
      ),
    },
    {
      name: "void_transition_operation_terminal_states_total",
      value: terminalOperationStageNames().length,
    },
    { name: "void_transition_recovery_job_states_total", value: jobStageNames().length },
    {
      name: "void_transition_recovery_job_edges_total",
      value: Object.values(jobStageTable).reduce(
        (total, next) => total + next.length,
        0,
      ),
    },
    {
      name: "void_transition_recovery_job_terminal_states_total",
      value: terminalJobStageNames().length,
    },
  ];

  // Basenames, not absolute paths. `void metrics` writes this to stdout, and a
  // report pasted into a tracker or a support thread should not carry the
  // operator's home directory and username.
  const sources = {
    ledger: basename(options.ledgerPath),
    journal: directory
      ? "not scanned: a directory scan has no single workspace journal"
      : options.stateDir
        ? "absent"
        : "not requested: pass --state <dir> holding journal/ and vault/",
    vault: directory
      ? "not scanned: a directory scan has no single workspace vault"
      : options.stateDir
        ? "absent"
        : "not requested: pass --state <dir> holding journal/ and vault/",
  };

  let journalSigned = false;
  if (!directory && options.stateDir) {
    if (options.journalPublicKey) {
      const journal = await journalSamples(
        options.stateDir,
        workspace,
        options.journalPublicKey,
      );
      samples.push(...journal.samples);
      journalSigned = journal.signed;
      sources.journal = join("journal", `${basename(options.ledgerPath, ".jsonl")}.jsonl`);
    }
    const vault = await readVaultManifest(options.stateDir, workspace);
    samples.push(
      { name: "void_vault_present", value: vault.store === "absent" ? 0 : 1 },
      {
        name: "void_vault_artifacts_total",
        labels: { store: vault.store },
        value: vault.artifacts.length,
      },
      {
        name: "void_vault_bytes_total",
        value: vault.artifacts.reduce((total, item) => total + item.bytes, 0),
      },
      { name: "void_vault_unsettled_total", value: vault.unsettled },
      { name: "void_vault_reservations_total", value: vault.reservations },
    );
    sources.vault = "vault";
  }

  return {
    schema: METRICS_SCHEMA,
    workspace,
    sources,
    // Derived. A directory scan deliberately counts files that failed
    // verification, so claiming the whole report is authenticated would be a
    // claim about files this report never aggregated from.
    signed: { ledger: directory ? scan.rejected === 0 : true, journal: journalSigned },
    samples,
  };
}

async function journalSamples(
  stateDir: string,
  workspace: string,
  journalPublicKey: PublicKeyLookup,
): Promise<{ samples: MetricSample[]; signed: boolean }> {
  const path = join(stateDir, "journal", `${workspace}.jsonl`);
  const present = await stat(path).then(
    (info) => info.isFile(),
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return false;
      throw error;
    },
  );
  if (!present)
    return {
      signed: false,
      samples: [
        { name: "void_journal_present", value: 0 },
        ...operationStageNames().map((stage) => ({
          name: "void_journal_operation_stage_events_total",
          labels: { stage },
          value: 0,
        })),
      ],
    };
  // An unreadable or unverifiable journal is a refusal, not a quiet zero: the
  // caller asked about this workspace and the evidence is broken.
  const section = await readSignedSection(path, workspace, {
    publicKey: journalPublicKey,
    missing: "journal_missing",
    unreadable: "journal_invalid",
    unverifiable: "journal_unverifiable",
    replay: "journal",
  });
  const operations = new Map<string, OperationEvent>();
  const jobs = new Map<string, RecoveryJobEvent>();
  const stageEvents: Record<string, number> = {};
  for (const stage of operationStageNames()) stageEvents[stage] = 0;
  for (const stage of jobStageNames()) stageEvents[stage] = 0;
  for (const entry of section.entries) {
    const event = entry.body as OperationEvent | RecoveryJobEvent;
    if (event.schema === "void.operation.v1") {
      stageEvents[event.stage] = (stageEvents[event.stage] ?? 0) + 1;
      operations.set(event.operationId, event);
    } else {
      stageEvents[event.stage] = (stageEvents[event.stage] ?? 0) + 1;
      jobs.set(event.jobId, event);
    }
  }
  const terminal = new Set(terminalOperationStageNames());
  const terminalJobs = new Set(terminalJobStageNames());
  const open = [...operations.values()].filter((event) => !terminal.has(event.stage));
  const openJobs = [...jobs.values()].filter((event) => !terminalJobs.has(event.stage));
  return {
    signed: section.signed,
    samples: [
      { name: "void_journal_present", value: 1 },
      { name: "void_journal_events_total", value: section.entries.length },
      { name: "void_journal_operations_total", value: operations.size },
      { name: "void_journal_recovery_jobs_total", value: jobs.size },
      { name: "void_journal_operations_open_total", value: open.length },
      { name: "void_journal_recovery_jobs_open_total", value: openJobs.length },
      ...operationStageNames().map((stage) => ({
        name: "void_journal_operation_stage_events_total",
        labels: { stage },
        value: stageEvents[stage] ?? 0,
      })),
      ...jobStageNames().map((stage) => ({
        name: "void_journal_recovery_job_stage_events_total",
        labels: { stage },
        value: stageEvents[stage] ?? 0,
      })),
    ],
  };
}

/** One explicitly named ledger: it verifies or the command refuses. */
async function scanLedgerFile(
  path: string,
  publicKey: PublicKeyLookup,
): Promise<LedgerScan> {
  const entries = await readLedgerEntries(path);
  const chain = await verifyChain(entries, { publicKey });
  if (!chain.ok) throw new Error(`ledger chain invalid: ${chain.reason}`);
  return {
    files: 1,
    verified: 1,
    unreadable: 0,
    rejected: 0,
    entries: entries.length,
    bytes: (await stat(path)).size,
    decisions: countDecisions(entries.map((entry) => entry.body)),
  };
}

/**
 * A directory of ledgers. Reading one that is too large or malformed and a
 * chain that does not verify are counted apart, because "could not read it"
 * and "read it and it was forged" are different operational problems.
 */
async function scanLedgerDirectory(
  path: string,
  publicKey: PublicKeyLookup,
): Promise<LedgerScan> {
  const names = (await readdir(path))
    .filter((name) => name.endsWith(".jsonl"))
    .sort();
  let verified = 0;
  let unreadable = 0;
  let rejected = 0;
  let entries = 0;
  let bytes = 0;
  const decisions: Record<string, number> = {};
  for (const name of names) {
    const file = join(path, name);
    try {
      const read = await readLedgerEntries(file);
      const chain = await verifyChain(read, { publicKey });
      if (!chain.ok) {
        rejected += 1;
        continue;
      }
      verified += 1;
      entries += read.length;
      bytes += (await stat(file)).size;
      for (const [decision, count] of Object.entries(countDecisions(read.map((entry) => entry.body))))
        decisions[decision] = (decisions[decision] ?? 0) + count;
    } catch {
      unreadable += 1;
    }
  }
  return { files: names.length, verified, unreadable, rejected, entries, bytes, decisions };
}

function countDecisions(bodies: readonly unknown[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const body of bodies) {
    const decision = decisionOf(body);
    counts[decision] = (counts[decision] ?? 0) + 1;
  }
  return counts;
}

/** `name{label="value"} value`, one sample per line, in report order. */
export function renderMetricsText(report: MetricsReport): string {
  return [
    `# ${report.schema} workspace=${report.workspace} ledger=${report.sources.ledger}`,
    ...report.samples.map((sample) => {
      const labels = Object.entries(sample.labels ?? {})
        .map(([key, value]) => `${key}="${value}"`)
        .join(",");
      return `${sample.name}${labels ? `{${labels}}` : ""} ${sample.value}`;
    }),
  ].join("\n");
}

export const renderMetricsJson = (report: MetricsReport): string =>
  `${JSON.stringify(report, null, 2)}\n`;


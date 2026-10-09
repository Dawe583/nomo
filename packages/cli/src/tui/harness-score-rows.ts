/**
 * The measured harness score, as rows on the ledger tab.
 *
 * Two things this refuses to do, both because the number would be confident and
 * wrong. It never shows `first_pass_rate` unless the chain carries an observed
 * correction signal, because the module derives that metric from the allow
 * rate, and an allow rate is not a first-pass rate: a call the operator
 * allowed and then had to roll back is counted as a pass. With no rollback or
 * retry anywhere in the chain there is no evidence the metric means what its
 * name says, so it is reported as unavailable rather than rendered as a
 * number nobody checked.
 *
 * It never invents a grouping. A case is one operation and the attempts made
 * on it, keyed by `operationId`, because that is the only grouping the chain
 * itself records; grouping by tool or by session would produce an interval
 * about a set of cases nobody defined.
 *
 * Nothing here changes a gate, a policy or a permission. The score is
 * descriptive and this module is the only place that decides what an operator
 * is shown.
 */
import {
  measureBoard,
  type ScoreBoard,
  type SplitSummary,
} from "../../../workbench/src/harness-scores.ts";

type Entry = { readonly body: unknown; readonly seq?: number };

export type ScoreRow = {
  readonly id: string;
  readonly label: string;
  readonly lines: string[];
};

/** How a metric is rendered: a percentage with its interval, or an excuse. */
const percent = (summary: SplitSummary): string | undefined => {
  if (summary.mean === null || summary.n === 0) return undefined;
  const centre = (summary.mean * 100).toFixed(1);
  // Below two cases there is no interval. Saying so is the difference between
  // a measurement and a number.
  const interval =
    summary.half === null
      ? `${centre}% of ${summary.n} case(s), no interval below two cases`
      : `${centre}% +/- ${(summary.half * 100).toFixed(1)} over ${summary.n} cases`;
  return interval;
};

/**
 * Group entries into cases: one operation and everything attempted on it.
 *
 * Entries with no `operationId` are their own case rather than being dropped,
 * because dropping them would silently shrink the denominator and make a
 * chain with missing provenance look better than one with it.
 */
function casesOf(entries: readonly Entry[]): Entry[][] {
  const byOperation = new Map<string, Entry[]>();
  const cases: Entry[][] = [];
  for (const entry of entries) {
    const body = entry.body as Record<string, unknown> | null;
    const id =
      body !== null && typeof body === "object" && typeof body.operationId === "string"
        ? body.operationId
        : undefined;
    if (id === undefined) {
      cases.push([entry]);
      continue;
    }
    const bucket = byOperation.get(id);
    if (bucket === undefined) byOperation.set(id, [entry]);
    else bucket.push(entry);
  }
  for (const bucket of byOperation.values()) cases.push(bucket);
  return cases;
}

/**
 * Whether the chain carries a signal that an allowed call was later corrected.
 *
 * A rollback record is the direct evidence. A repeated `operationId` is the
 * indirect evidence: the same operation attempted twice means the first attempt
 * did not stand.
 */
const correctionObserved = (entries: readonly Entry[]): boolean => {
  const seen = new Set<string>();
  for (const entry of entries) {
    const body = entry.body as Record<string, unknown> | null;
    if (body === null || typeof body !== "object") continue;
    if (body.event === "rollback") return true;
    if (typeof body.operationId === "string") {
      if (seen.has(body.operationId)) return true;
      seen.add(body.operationId);
    }
  }
  return false;
};

const rowsFor = (workspace: string, entries: readonly Entry[]): ScoreRow[] => {
  const board: ScoreBoard = measureBoard(casesOf(entries), new Date().toISOString());
  const hold = percent(board.metrics.hold_rate!);
  const deny = percent(board.metrics.deny_rate!);
  const pass = percent(board.metrics.first_pass_rate!);
  const lines: string[] = [];

  lines.push(
    hold === undefined
      ? "Calls waiting on a human: not measured."
      : `Calls waiting on a human: ${hold}.`,
  );
  lines.push(
    deny === undefined ? "Calls refused: not measured." : `Calls refused: ${deny}.`,
  );
  // The honesty rule: the metric is named but withheld unless the chain shows
  // what it would take to distinguish "allowed and correct" from "allowed and
  // corrected afterwards".
  lines.push(
    pass === undefined || !correctionObserved(entries)
      ? "First-pass rate: unavailable. It needs an observed rollback or a repeated operation, and this chain has neither."
      : `First-pass rate: ${pass}.`,
  );
  for (const reason of board.reasons) lines.push(reason);

  return [
    {
      id: `harness-score:${workspace}`,
      label: `◆ harness score ${workspace.slice(0, 8)}`,
      lines,
    },
  ];
};

/**
 * One score row per workspace that has a verified chain.
 *
 * A workspace with no verified entry is not given a row: the ledger tab already
 * distinguishes "nothing verified yet" from "verified and nothing learned", and
 * a score row with no cases would be a third, worse answer to the same
 * question.
 */
export function harnessScoreRows(
  proofs: ReadonlyMap<string, readonly Entry[]>,
): readonly ScoreRow[] {
  const rows: ScoreRow[] = [];
  for (const [workspace, entries] of proofs) {
    if (entries.length === 0) continue;
    rows.push(...rowsFor(workspace, entries));
  }
  return rows;
}
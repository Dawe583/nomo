// Usage panel visuals: the shape of provider reported token use over the
// retained records, the input/output split of those same records, the model
// breakdown and the cost line.
//
// Every figure here comes from a record the provider wrote. The activity
// layer types token counts and cost as unknown because a run that reported
// nothing has no value, and absent is not zero: a conversation that spent
// nothing and one whose cost was never recorded must not render the same
// number. Unreported metrics therefore print n/a, and a partial split names
// which side is missing instead of drawing an empty segment as zero.
import { barChart, sparkline, stackedBar } from "./charts.ts";
import { fit, sanitizeText } from "./layout.ts";
import type { MotionContext } from "./motion.ts";

/** The fields the panel reads. Unknown is deliberate: the activity layer
 * hands the same shape with nullable counts, and a caller that adds cost or a
 * split later needs no type change. */
export interface UsageRecordView {
  readonly inputTokens?: unknown;
  readonly outputTokens?: unknown;
  readonly totalTokens?: unknown;
  readonly model?: unknown;
  readonly cost?: unknown;
}

/** A count as a measurement, or undefined when the record did not report it.
 * Negative and non-finite values are not measurements either. */
export function usageReportedNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : undefined;
}

/** Totals from records that reported one, oldest first as the caller ordered
 * them. A record without a total contributes no sample: a gap is not a zero. */
export function usageReportedTotals(
  records: readonly UsageRecordView[],
): number[] {
  const totals: number[] = [];
  for (const record of records) {
    const total = usageReportedNumber(record.totalTokens);
    if (total !== undefined) totals.push(total);
  }
  return totals;
}

/** The one number the panel leads with: how much was spent and over how many
 * records, so a partial report cannot read as the whole bill. */
export function usageTotalLine(
  records: readonly UsageRecordView[],
  width: number,
): string {
  const totals = usageReportedTotals(records);
  if (totals.length === 0)
    return fit(sanitizeText("no token counts reported · n/a"), width);
  const sum = totals.reduce((left, right) => left + right, 0);
  return fit(
    sanitizeText(
      `${sum.toLocaleString("en-US")} reported tokens · ${totals.length}/${records.length} records`,
    ),
    width,
  );
}

/**
 * One sparkline over the reported totals. The scale comes from the data, so a
 * slow drift stays visible, and the record count beside it says how much of
 * the list the shape actually covers. Undefined when nothing was reported:
 * a flat line of zeros would claim a measurement nobody made.
 */
export function usageSparklineLine(
  records: readonly UsageRecordView[],
  width: number,
  motion?: MotionContext,
): string | undefined {
  const totals = usageReportedTotals(records);
  if (totals.length === 0) return undefined;
  const cells = Math.max(1, Math.min(24, Math.floor(width) - 11));
  const samples = totals.slice(-cells);
  return fit(
    sanitizeText(
      `Recent ${String(samples.length).padEnd(2)} ${sparkline({ values: samples }, samples.length, { motion })}  →`,
    ),
    width,
  );
}

/**
 * The input/output split of the reported records, as one stacked bar plus its
 * legend. Only sides that were reported become segments: drawing output at
 * zero because the provider omitted the field would be a fabricated
 * measurement. When neither side was reported the line says n/a.
 */
export function usageInputOutputLines(
  records: readonly UsageRecordView[],
  width: number,
  motion?: MotionContext,
): string[] {
  let inputTotal = 0;
  let outputTotal = 0;
  let inputRecords = 0;
  let outputRecords = 0;
  for (const record of records) {
    const input = usageReportedNumber(record.inputTokens);
    const output = usageReportedNumber(record.outputTokens);
    if (input !== undefined) {
      inputTotal += input;
      inputRecords += 1;
    }
    if (output !== undefined) {
      outputTotal += output;
      outputRecords += 1;
    }
  }
  if (inputRecords === 0 && outputRecords === 0)
    return [fit(sanitizeText("input/output n/a · no record reported a split"), width)];
  const covered = records.filter(
    (record) =>
      usageReportedNumber(record.inputTokens) !== undefined ||
      usageReportedNumber(record.outputTokens) !== undefined,
  ).length;
  const missing = [
    ...(inputRecords === 0 ? ["input"] : []),
    ...(outputRecords === 0 ? ["output"] : []),
  ];
  const head =
    `input/output · ${covered}/${records.length} records` +
    (missing.length ? ` · ${missing.join(" and ")} n/a` : "");
  const segments = [
    ...(inputRecords > 0 ? [{ label: "input", value: inputTotal }] : []),
    ...(outputRecords > 0 ? [{ label: "output", value: outputTotal }] : []),
  ];
  const barWidth = Math.max(1, Math.floor(width) - 2);
  const bar = stackedBar(segments, barWidth, { motion }).split("\n");
  return [
    fit(sanitizeText(head), width),
    ...bar.map((line) => fit(`  ${sanitizeText(line)}`, width)),
  ];
}


/** Cost text for one record. Missing, negative and non-finite values are all
 * unmeasured rather than zero or unknown-but-possibly-free. */
export function usageCostText(value: unknown): string {
  const cost = usageReportedNumber(value);
  if (cost === undefined) return "unmeasured";
  return Number.isInteger(cost) ? String(cost) : String(Math.round(cost * 1e6) / 1e6);
}

/** Cost as reported, or n/a. No record in the activity layer carries a cost
 * today, so this line exists to name that absence rather than print a zero. */
export function usageCostLine(
  records: readonly UsageRecordView[],
  width: number,
): string {
  let total = 0;
  let reported = 0;
  for (const record of records) {
    const cost = usageReportedNumber(record.cost);
    if (cost === undefined) continue;
    total += cost;
    reported += 1;
  }
  if (reported === 0)
    return fit(sanitizeText("cost unmeasured · no producer reported a cost"), width);
  const text = usageCostText(total);
  return fit(
    sanitizeText(`cost ${text} · ${reported}/${records.length} records`),
    width,
  );
}

/**
 * Tokens per model, from the records that reported both a model and a total.
 * The bar chart prints each number beside its bar, so the breakdown survives a
 * monochrome terminal. Returns no rows when nothing was reported.
 */
export function usageModelLines(
  records: readonly UsageRecordView[],
  width: number,
  limit: number,
  motion?: MotionContext,
): string[] {
  const totals = new Map<string, number>();
  for (const record of records) {
    const model = typeof record.model === "string" ? record.model.trim() : "";
    const total = usageReportedNumber(record.totalTokens);
    if (!model || total === undefined) continue;
    totals.set(model, (totals.get(model) ?? 0) + total);
  }
  if (totals.size === 0) return [];
  const ranked = [...totals.entries()]
    .sort((left, right) =>
      left[1] - right[1] || left[0].localeCompare(right[0]),
    )
    .slice(-Math.max(1, limit));
  return [
    `TOP ${ranked.length} MODELS BY TOKENS`,
    ...barChart(
      {
        values: ranked.map(([, total]) => total),
        labels: ranked.map(([model]) =>
          fit(sanitizeText(model), Math.max(8, Math.floor(width / 3))),
        ),
      },
      Math.max(1, Math.min(64, width - 2)),
      { motion },
    ).map((line) => `  ${line}`),
  ];
}

/** Median of a non-empty numeric list. */
function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = sorted.length >> 1;
  return sorted.length % 2
    ? sorted[middle]!
    : Math.round((sorted[middle - 1]! + sorted[middle]!) / 2);
}

/**
 * Everything above the record list, in reading order: the total, the shape of
 * the series, the cost, the split, the spread and the model breakdown.
 * `height` is the body rows available, so a short frame keeps the total and
 * the sparkline and drops the sections that would only half fit.
 */
export function usageSummaryLines(
  records: readonly UsageRecordView[],
  width: number,
  height: number,
  motion?: MotionContext,
): string[] {
  const cells = Math.max(1, Math.floor(width));
  const rows = Math.max(0, Math.floor(height));
  const totals = usageReportedTotals(records);
  const lines: string[] = [usageTotalLine(records, cells)];
  const spark = usageSparklineLine(records, cells, motion);
  if (spark !== undefined) lines.push(spark);
  lines.push(usageCostLine(records, cells));
  if (rows >= 12) lines.push(...usageInputOutputLines(records, cells, motion));
  if (rows >= 12 && totals.length > 0)
    lines.push(
      fit(
        sanitizeText(
          `Median ${median(totals)} · peak ${totals.reduce((top, value) => Math.max(top, value), 0)}`,
        ),
        cells,
      ),
    );
  if (rows >= 8)
    lines.push(
      ...usageModelLines(
        records,
        cells,
        rows >= 16 ? 5 : 2,
        motion,
      ).map((line) => fit(line, cells)),
    );
  return lines;
}

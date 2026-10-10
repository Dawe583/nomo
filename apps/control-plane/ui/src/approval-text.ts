/** Approval actions in plain language, risk ordering, and blast-radius
 * summaries. The UI reads server rows only; nothing here decides policy. */
import type { Row } from "./api";

/** Plain-language action for an approval record. */
export function plainAction(record: Row): string {
  const tool = record.call?.tool ?? record.tool ?? "unknown tool";
  const decision = record.decision ?? record.status;
  if (decision === "denied" || record.status === "denied") return `NOMO denied ${tool}`;
  if (decision === "approved" || record.status === "approved") return `Approve ${tool}`;
  return `Run ${tool}`;
}

/** Highest risk class of a record; unknown stays unknown. */
export function riskOf(record: Row): string {
  const klass = record.call?.klass ?? record.klass ?? "unknown";
  if (String(klass).startsWith("r3")) return "r3";
  if (String(klass).startsWith("r2")) return "r2";
  if (String(klass).startsWith("r1")) return "r1";
  if (String(klass).startsWith("r0")) return "r0";
  return "unknown";
}

/** Sort records risk-first: r3, r2, r1, r0, unknown last. */
export function sortRiskFirst<T>(rows: readonly T[], risk: (row: T) => string): readonly T[] {
  const order: Record<string, number> = { r3: 0, r2: 1, r1: 2, r0: 3, unknown: 4 };
  return [...rows].sort((left, right) => (order[risk(left)] ?? 4) - (order[risk(right)] ?? 4));
}

/** Human blast-radius summary; unknown radius stays unknown. */
export function blastSummary(record: Row): string {
  const radius = record.call?.blastRadius ?? record.blastRadius;
  if (typeof radius !== "number") return "unknown";
  if (radius === 0) return "0 targets";
  return `${radius} target${radius === 1 ? "" : "s"}`;
}

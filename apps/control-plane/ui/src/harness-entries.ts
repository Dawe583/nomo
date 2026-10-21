/**
 * What the harness holds, as the operator reads it.
 *
 * Pure, so the operator's view of the harness is testable without a browser:
 * a field that is silently dropped here is a field the operator never saw
 * and never approved.
 */
import type { Row } from "./api";

export type HarnessEntryView = {
  readonly id: string;
  readonly kind: string;
  readonly title: string;
  readonly content: string;
  readonly tool: string;
  readonly klass: string;
  readonly repeats: number;
  readonly decidedByOperator: boolean;
  readonly derivedFromSeq: number[];
  /** The decision a mined rule proposes, and the hold's window. Empty on a
   * lesson: a lesson states an observation and proposes no decision. */
  readonly ruleDecision: string;
  readonly ruleSeconds: number;
};

/**
 * The entries in the shape the panel reads them.
 *
 * Pure, so the operator's view of the harness is testable without a
 * browser: a field that is silently dropped here is a field the operator
 * never saw and never approved.
 */
export function harnessEntries(
  data: Row | undefined,
): HarnessEntryView[] {
  const entries = Array.isArray(data?.entries) ? data.entries : [];
  return entries.map((item) => {
    const entry = (item ?? {}) as Row;
    const rule =
      entry.rule !== null && typeof entry.rule === "object"
        ? (entry.rule as Row)
        : undefined;
    return {
      id: typeof entry.id === "string" ? entry.id : "",
      kind: typeof entry.kind === "string" ? entry.kind : "",
      title: typeof entry.title === "string" ? entry.title : "",
      content: typeof entry.content === "string" ? entry.content : "",
      tool: typeof entry.tool === "string" ? entry.tool : "",
      klass: typeof entry.klass === "string" ? entry.klass : "",
      repeats: typeof entry.repeats === "number" ? entry.repeats : 0,
      decidedByOperator: entry.decidedByOperator === true,
      derivedFromSeq: Array.isArray(entry.derivedFromSeq)
        ? entry.derivedFromSeq.filter(
            (seq): seq is number => typeof seq === "number",
          )
        : [],
      ruleDecision: typeof rule?.decision === "string" ? rule.decision : "",
      ruleSeconds: typeof rule?.seconds === "number" ? rule.seconds : 0,
    };
  });
}

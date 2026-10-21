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
  /** The mined rule as policy file text, built by the workbench beside the
   * rule. The panel shows it so an operator working in the browser can copy
   * the rule into their own policy file, which is the only way it enters
   * policy. Empty on a lesson. */
  readonly policyText: string[];
};

export type HarnessRatchetGuardrailView = {
  readonly key: string;
  readonly n: number;
  readonly unmeasured: number;
  readonly measured: boolean;
};

export type HarnessRatchetView = {
  readonly baselineSeq: number | null;
  readonly verdict: string;
  readonly caseCount: number;
  readonly guardrailBreaches: readonly string[];
  readonly guardrails: readonly HarnessRatchetGuardrailView[];
  readonly empty: boolean;
};

/**
 * The ratchet report as the panel reads it. Pure, so a guardrail that is
 * silently dropped here is a guardrail the operator never saw.
 */
export function harnessRatchetView(
  data: Row | undefined,
): HarnessRatchetView | null {
  if (data === undefined || data === null) return null;
  if (data.empty === true || data.after == null) {
    return {
      baselineSeq: null,
      verdict: typeof data.verdict === "string" ? data.verdict : "insufficient-data",
      caseCount: 0,
      guardrailBreaches: [],
      guardrails: [],
      empty: true,
    };
  }
  const after = data.after as Row;
  const metrics = (after.metrics ?? {}) as Row;
  const keys = ["deny_rate", "rollback_count", "unknown_tool_rate"];
  const guardrails = keys.map((key) => {
    const metric = (metrics[key] ?? {}) as Row;
    const n = typeof metric.n === "number" ? metric.n : 0;
    const unmeasured = typeof metric.unmeasured === "number" ? metric.unmeasured : 0;
    return { key, n, unmeasured, measured: n > 0 };
  });
  return {
    baselineSeq: typeof data.baselineSeq === "number" ? data.baselineSeq : null,
    verdict: typeof data.verdict === "string" ? data.verdict : "insufficient-data",
    caseCount: typeof data.caseCount === "number" ? data.caseCount : 0,
    guardrailBreaches: Array.isArray(data.guardrailBreaches)
      ? data.guardrailBreaches.filter((item): item is string => typeof item === "string")
      : [],
    guardrails,
    empty: false,
  };
}

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
      policyText: Array.isArray(entry.policyText)
        ? entry.policyText.filter(
            (line): line is string => typeof line === "string",
          )
        : [],
    };
  });
}

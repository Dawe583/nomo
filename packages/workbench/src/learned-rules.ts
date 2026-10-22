/**
 * Mining the signed chain for a rule the operator has not written yet.
 *
 * A learned rule is *evidence, not authority*. Two consequences are load-bearing
 * and both are enforced by the caller rather than here:
 *
 * - Learned rules are appended after the operator's own rules, because `decide`
 *   takes the first matching rule. Anything earlier could shadow a deliberate
 *   operator decision with an observation made by a model.
 * - The decision is `hold`, never `deny`. A refusal the operator did not ask
 *   for should pause for a human who can undo it, not permanently forbid an
 *   action on the strength of one pattern.
 *
 * Nothing here writes. Promotion — recording the rule into the chain so it
 * survives a restart — is the caller's job, and it goes through `commitWorkspace`
 * so the record is signed by the same key as everything else.
 *
 * This is deliberately a pure function over entries. It cannot be trusted to
 * decide anything on its own, and giving it no way to reach state is what makes
 * that true rather than merely intended.
 */

import type { Rule } from "../../policy/src/rules.ts";

/** How many refusals of the same shape make a pattern worth an operator's
 * attention. One refusal is noise; a model that keeps being refused is a fact. */
export const LEARNED_RULE_MIN_REPEATS = 3;

/** Provenance marker a signed ledger entry must carry before the miner will
 *  treat it as evidence. An entry without it is operational noise, not a
 *  verified harness run, and teaching from it would let a single unreviewed
 *  refusal manufacture a standing hold. */
export const HARNESS_EVIDENCE_SOURCE = "harness";

/** True when an entry body carries harness provenance. Mirrored stdio-proxy
 *  entries count when they name the harness run they came from, because the
 *  upstream decision was made on the harness path even though the workbench
 *  records it as a delegated proxy outcome. */
export function isHarnessEvidence(body: unknown): boolean {
  if (body === null || typeof body !== "object" || Array.isArray(body))
    return false;
  const record = body as Record<string, unknown>;
  if (record.source === HARNESS_EVIDENCE_SOURCE) return true;
  if (record.harness === true) return true;
  return typeof record.harnessRunId === "string" && record.harnessRunId.length > 0;
}

type Entry = { readonly body: unknown };

/**
 * Whether a recorded decision is a refusal.
 *
 * `execute:unknown` is excluded on purpose: it means "this tool ran and I do not
 * know what happened", which is a safety outcome rather than evidence that the
 * model keeps doing the same wrong thing. Teaching a rule from it would turn a
 * gap in our knowledge into a standing prohibition. `proxy` is excluded because
 * the upstream decided it and the ledger already records that it delegated.
 */
function isRefusal(decision: string): boolean {
  return (
    decision.startsWith("deny") ||
    decision === "hold:denied" ||
    decision === "hold:expired"
  );
}

function field(body: Record<string, unknown>, key: string): string {
  const value = body[key];
  return typeof value === "string" ? value : "";
}

/**
 * Refusals grouped by the shape that caused them, promoted to `hold` rules once
 * a group repeats. Ordering is deterministic so two runs over the same chain
 * produce the same rules and the same digests.
 */
export function mineLearnedRules(
  entries: readonly Entry[],
  minRepeats: number = LEARNED_RULE_MIN_REPEATS,
): Rule[] {
  if (!Number.isInteger(minRepeats) || minRepeats < 1)
    throw new Error("minRepeats must be a positive integer.");

  const counts = new Map<
    string,
    { tool: string; klass: string; repeats: number; runs: Set<string> }
  >();
  for (const entry of entries) {
    const body = entry.body;
    if (body === null || typeof body !== "object" || Array.isArray(body)) continue;
    const record = body as Record<string, unknown>;
    // Provenance gate: only verified harness runs may teach. An entry without
    // harness provenance is operational data, and a rule mined from it would
    // be a claim about behaviour we never observed on the harness path.
    if (!isHarnessEvidence(record)) continue;
    if (!isRefusal(field(record, "decision"))) continue;
    const tool = field(record, "tool");
    const klass = field(record, "klass");
    if (!tool || !klass) continue;
    const runId =
      typeof record.runId === "string"
        ? record.runId
        : typeof record.harnessRunId === "string"
          ? record.harnessRunId
          : "";
    // JSON, not a raw NUL between the two parts: a literal NUL in a source
    // file makes git treat the whole file as binary, and then no diff of it is
    // ever shown again. Neither a tool name nor a class can contain a quote or
    // a backslash, so this cannot collide either.
    const key = JSON.stringify([klass, tool]);
    const seen = counts.get(key);
    if (seen) {
      seen.repeats += 1;
      if (runId) seen.runs.add(runId);
    } else {
      counts.set(key, {
        tool,
        klass,
        repeats: 1,
        runs: new Set(runId ? [runId] : []),
      });
    }
  }

  return [...counts.values()]
    .filter((group) => group.repeats >= minRepeats)
    .sort((a, b) =>
      a.klass === b.klass
        ? a.tool < b.tool
          ? -1
          : a.tool > b.tool
            ? 1
            : 0
        : a.klass < b.klass
          ? -1
          : 1,
    )
    .map((group) => ({
      match: { class: group.klass, tool: group.tool },
      decision: "hold",
      seconds: 300,
      notify: ["cli"],
      // The model reads this in the hold message, so it states the observation
      // rather than claiming a conclusion the chain does not support.
      rationale: `Refused ${group.repeats} times across ${group.runs.size || 1} harness run(s) on the signed ledger. Not written by an operator.`,
    }));
}

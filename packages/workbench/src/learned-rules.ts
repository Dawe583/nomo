/**
 * Mining the signed chain for a rule the operator has not written yet.
 *
 * A learned rule is *evidence, not authority*. Two consequences are load-bearing
 * and both are enforced by the caller rather than here:
 *
 * - A learned rule never enters a decided policy. The policy loader requires
 *   the terminal catch-all as the last rule and `decide` takes the first
 *   match, so anything appended behind it can never fire; merging would only
 *   suggest that learning governs calls. The rule is shown to the operator and
 *   the operator copies it into their own file, where it is reviewed.
 * - The decision is `hold`, never `deny`. A refusal the operator did not ask
 *   for should pause for a human who can undo it, not permanently forbid an
 *   action on the strength of one pattern.
 *
 * Nothing here writes and nothing here decides. `learnedRuleGroups` is the one
 * counting pass; the rule and the entry the operator reads are built from the
 * same group, so the number beside the rule is the number behind it.
 *
 * This is deliberately a pure function over entries. It cannot be trusted to
 * decide anything on its own, and giving it no way to reach state is what makes
 * that true rather than merely intended.
 */

import type { Rule } from "../../policy/src/rules.ts";

/** How many refusals of the same shape make a pattern worth an operator's
 * attention. One refusal is noise; a model that keeps being refused is a fact. */
export const LEARNED_RULE_MIN_REPEATS = 3;

/**
 * The sentence a mined rule carries as its rationale.
 *
 * One builder owns the wording so the miner and the matcher below cannot
 * drift apart: a second copy of this sentence elsewhere would let one copy
 * change while the other still matches, and self-caused refusals would then
 * either leak back into the count or genuine evidence would be dropped.
 */
export function learnedRuleRationale(repeats: number): string {
  return `Refused ${repeats} times on the signed ledger. Not written by an operator.`;
}

/**
 * Matches exactly the sentence the builder above produces, for any count.
 *
 * Fully anchored on purpose: an operator rationale that merely quotes the
 * sentence with extra text around it is a human note about the pattern, not
 * the pattern echoing itself, so it stays evidence.
 */
const SELF_CAUSED_RATIONALE =
  /^Refused \d+ times on the signed ledger\. Not written by an operator\.$/;

type Entry = { readonly body: unknown; readonly seq?: number };

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

export type LearnedRuleGroup = {
  readonly tool: string;
  readonly klass: string;
  readonly repeats: number;
  /** Chain sequences the group was counted from, in chain order. */
  readonly seqs: readonly number[];
};

/**
 * Refusals grouped by the shape that caused them.
 *
 * Exported so the rule and the entry the operator reads carry the same count
 * and the same sequences. A second counting pass could disagree with the
 * miner, and the number beside a rule would then not be the number behind it.
 *
 * Ordering is deterministic so two runs over the same chain produce the same
 * rules and the same entry ids.
 */
export function learnedRuleGroups(
  entries: readonly Entry[],
  minRepeats: number = LEARNED_RULE_MIN_REPEATS,
): LearnedRuleGroup[] {
  if (!Number.isInteger(minRepeats) || minRepeats < 1)
    throw new Error("minRepeats must be a positive integer.");

  const counts = new Map<
    string,
    { tool: string; klass: string; repeats: number; seqs: number[] }
  >();
  for (const entry of entries) {
    const body = entry.body;
    if (body === null || typeof body !== "object" || Array.isArray(body)) continue;
    const record = body as Record<string, unknown>;
    if (!isRefusal(field(record, "decision"))) continue;
    const tool = field(record, "tool");
    const klass = field(record, "klass");
    if (!tool || !klass) continue;

    // A refusal produced by firing a learned rule carries that rule's own
    // rationale in body.attribution.rule.rationale. Counting it would let the
    // rule vote for itself, so it is dropped here, never deleted. Any other
    // shape, missing attribution, a non-object rule, a missing or non-string
    // rationale, or a rationale that merely quotes the sentence, is genuine
    // evidence and counts. Only raw body fields are read; the ledger's
    // readLedgerReason interprets records for display and has no say in what
    // teaches.
    //
    // The closure is scoped to writers that stamp the template. A foreign
    // writer firing learned holds without that stamp still feeds the loop,
    // and an operator rule whose rationale is a verbatim copy of the sentence
    // would have its genuine refusals dropped; both are recorded limitations
    // of matching by content rather than by an additive ledger marker.
    const attribution = record["attribution"];
    if (
      attribution !== null &&
      typeof attribution === "object" &&
      !Array.isArray(attribution)
    ) {
      const fired = (attribution as Record<string, unknown>)["rule"];
      if (
        fired !== null &&
        typeof fired === "object" &&
        !Array.isArray(fired)
      ) {
        const rationale = (fired as Record<string, unknown>)["rationale"];
        if (
          typeof rationale === "string" &&
          SELF_CAUSED_RATIONALE.test(rationale)
        )
          continue;
      }
    }
    // JSON, not a raw NUL between the two parts: a literal NUL in a source
    // file makes git treat the whole file as binary, and then no diff of it is
    // ever shown again. Neither a tool name nor a class can contain a quote or
    // a backslash, so this cannot collide either.
    const key = JSON.stringify([klass, tool]);
    const seen = counts.get(key);
    if (seen) {
      seen.repeats += 1;
      if (typeof entry.seq === "number") seen.seqs.push(entry.seq);
    } else {
      counts.set(key, {
        tool,
        klass,
        repeats: 1,
        seqs: typeof entry.seq === "number" ? [entry.seq] : [],
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
      tool: group.tool,
      klass: group.klass,
      repeats: group.repeats,
      seqs: group.seqs,
    }));
}

/**
 * The rule a group mints. One builder, because `mineLearnedRules` and the entry
 * the operator reads must carry the same text: a second construction could
 * print a rule nobody minted.
 */
export function learnedRule(group: LearnedRuleGroup): Rule {
  return {
    match: { class: group.klass, tool: group.tool },
    decision: "hold",
    seconds: 300,
    notify: ["cli"],
    rationale: learnedRuleRationale(group.repeats),
  };
}

export function mineLearnedRules(
  entries: readonly Entry[],
  minRepeats: number = LEARNED_RULE_MIN_REPEATS,
): Rule[] {
  return learnedRuleGroups(entries, minRepeats).map(learnedRule);
}

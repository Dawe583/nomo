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
 * Nothing here writes. Promotion, recording the rule into the chain so it
 * survives a restart, is the caller's job, and it goes through `commitWorkspace`
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

  const counts = new Map<string, { tool: string; klass: string; repeats: number }>();
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
    if (seen) seen.repeats += 1;
    else counts.set(key, { tool, klass, repeats: 1 });
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
      rationale: learnedRuleRationale(group.repeats),
    }));
}
/**
 * Promoted rules: the refusals an operator never wrote, mined into a rule the
 * operator has to approve.
 *
 * A promoted rule is evidence, never authority, and the same five rules that
 * govern a learned rule govern it:
 *
 * - The decision is `deny`, not `hold`, because a promoted rule names a
 *   pattern the operator has refused three or more times. The operator
 *   approves the rule; the rule does not approve itself.
 * - Learned rules are appended after the operator's own rules, so the
 *   operator's intent still wins. The ordering is the caller's job, and the
 *   rationale carries the provenance so the operator can see which records
 *   taught it.
 * - The rule is replayable from the chain alone: the record that promotes it
 *   carries the whole `Rule`, and loading includes a pass over the chain.
 *   Nothing here writes; promotion is the caller's job.
 * - A refusal produced by firing a promoted rule carries its own rationale in
 *   `attribution.rule.rationale`, so the promoted rule does not vote for
 *   itself. The same self-caused filter the learned miner uses applies here.
 * - What counts as a failure is `hold:denied`: the operator said no. An
 *   `execute:failed` is a tool failing, not a decision, and an
 *   `execute:unknown` is a safety outcome. Neither teaches a rule about what
 *   the operator wants.
 *
 * What counts as recurring: the same `(class, tool)` refused at least
 * `minRepeats` times since the last promotion. The "since the last
 * promotion" window is the caller's to compute from the chain; this
 * function takes the entries it is given and counts them all.
 */
export const PROMOTED_RULE_MIN_REPEATS = LEARNED_RULE_MIN_REPEATS;

/** The sentence a promoted rule carries as its rationale. */
export function promotedRuleRationale(repeats: number): string {
  return `Promoted from ${repeats} refusals on the signed ledger. Not written by an operator.`;
}

const SELF_CAUSED_PROMOTED_RATIONALE =
  /^Promoted from \d+ refusals on the signed ledger\. Not written by an operator\.$/;

/**
 * Refusals grouped by the shape that caused them, promoted to `deny` rules
 * once a group repeats. Ordering is deterministic so two runs over the same
 * chain produce the same rules and the same digests.
 */
export function minePromotedRules(
  entries: readonly Entry[],
  minRepeats: number = PROMOTED_RULE_MIN_REPEATS,
): Rule[] {
  if (!Number.isInteger(minRepeats) || minRepeats < 1)
    throw new Error("minRepeats must be a positive integer.");

  const counts = new Map<string, { tool: string; klass: string; repeats: number }>();
  for (const entry of entries) {
    const body = entry.body;
    if (body === null || typeof body !== "object" || Array.isArray(body)) continue;
    const record = body as Record<string, unknown>;
    // Only operator denials teach a promoted rule: a hold the operator let
    // through is evidence of the opposite, and a deny from policy is the
    // policy's own decision, not the operator's.
    if (field(record, "decision") !== "hold:denied") continue;
    const tool = field(record, "tool");
    const klass = field(record, "klass");
    if (!tool || !klass) continue;
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
          SELF_CAUSED_PROMOTED_RATIONALE.test(rationale)
        )
          continue;
      }
    }
    const key = JSON.stringify([klass, tool]);
    const seen = counts.get(key);
    if (seen) seen.repeats += 1;
    else counts.set(key, { tool, klass, repeats: 1 });
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
      decision: "deny",
      // A denied call does not wait for a human: the pattern is settled, and
      // the rule carries the provenance so the operator can see why.
      rationale: promotedRuleRationale(group.repeats),
    }));
}

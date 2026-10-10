/**
 * The gate that decides whether a learning pass is worth paying for.
 *
 * The whole reason this file exists is the token budget. A refinement pass
 * costs a model call, so the question is not "can we learn" but "is there
 * anything here worth learning", and that question has to be answerable
 * without asking anybody. Every check below is deterministic and free. The
 * model is only consulted after all of them have passed, which means a session
 * that teaches nothing pays nothing.
 *
 * The separation is deliberate and it is the safety property, not an
 * optimisation. `prime-src` does the same thing with the same ordering, and
 * the reason it is written the way it is appears in its own source comment:
 * gates first, then the review, and only an approving review does any work. A
 * gate that ran after the review would be a gate that has already spent the
 * tokens it was supposed to save.
 *
 * Three checks are load-bearing and all three fail in the direction of *not*
 * learning, which is the direction this repository is willing to be wrong in:
 *
 * - A trigger under cooldown is held, not dropped. Dropping it would mean the
 *   window between the review and the next trigger produces no learning at
 *   all, and the trigger would have to be re-armed from outside.
 * - An in-flight round is never joined. Two concurrent refinements would write
 *   the same entries twice, and the second would be derived from a chain the
 *   first had already changed.
 * - A session with nothing new to report is declined. This is the check that
 *   does the most work in practice: most turns teach nothing, and saying so
 *   without a model call is the whole point.
 *
 * Every refusal names itself. A gate that rejects silently reads as a bug in
 * the caller's next debugging session, and "why did it not learn?" is a
 * question this file exists to make answerable.
 */

import type { HarnessEntry } from "./learned-harness.ts";

/** Where a trigger is serviced, mirroring the two boundaries prime uses. */
export type GateSurface = "checkpoint" | "dispose";

/**
 * The settings that decide whether refinement may run at all.
 *
 * Defaults match `prime-src` (`session_engine/refine.rs:39-72`) rather than
 * being invented here: `enabled` on, a turn interval of 25 and a cooldown of
 * 20 minutes. The interval is clamped to at least 1 because a trigger that can
 * fire on every turn is a trigger with no interval.
 *
 * There is deliberately no `compact` flag here. One existed, was resolved
 * from settings and was named in the defaults, but no decision ever read it:
 * a boolean on an operator-facing surface that reads like a switch and does
 * nothing is worse than no boolean at all. Compaction arms the trigger.
 */
export type RefineGates = {
  readonly enabled: boolean;
  /** Settled turns between reviews. Clamped to at least 1. */
  readonly turnInterval: number;
  /** Milliseconds an attempt blocks the next one. Zero is allowed and means no
   * wait, which is a deliberate setting rather than a default. */
  readonly cooldownMs: number;
};

export const DEFAULT_REFINE_GATES: RefineGates = {
  enabled: true,
  turnInterval: 25,
  cooldownMs: 20 * 60 * 1000,
};

/** Resolve gates from a partial block, clamping rather than trusting. */
export function resolveRefineGates(raw: Partial<RefineGates> | undefined): RefineGates {
  if (raw === undefined) return DEFAULT_REFINE_GATES;
  const fallback = DEFAULT_REFINE_GATES;
  const turnInterval = raw.turnInterval ?? fallback.turnInterval;
  const cooldownMs = raw.cooldownMs ?? fallback.cooldownMs;
  return {
    enabled: raw.enabled ?? fallback.enabled,
    turnInterval: Number.isFinite(turnInterval) ? Math.max(1, Math.floor(turnInterval)) : fallback.turnInterval,
    cooldownMs: Number.isFinite(cooldownMs) ? Math.max(0, Math.floor(cooldownMs)) : fallback.cooldownMs,
  };
}

export type GateInput = {
  /** Gates resolved from settings. */
  readonly gates: RefineGates;
  /** The trigger is armed — by a compaction, or by a manual request. */
  readonly pending: boolean;
  /** A review is already retained from an earlier boundary. */
  readonly hasPendingReview: boolean;
  /** A round is in flight. */
  readonly inFlight: boolean;
  /** Settled, non-error turns since the last review. */
  readonly settledTurns: number;
  /** Milliseconds since the last review attempt, or null if there was none. */
  readonly msSinceLastReview: number | null;
  /** Entries mined since the last review. */
  readonly candidates: readonly HarnessEntry[];
  /** The session can hold harness state at all. A session that cannot is one
   * whose trigger would never run, so it must never be armed. */
  readonly harnessStateAvailable: boolean;
  readonly surface: GateSurface;
};

export type GateRefusal = "not-armed" | "disabled" | "no-harness-state" | "in-flight" | "under-cooldown" | "too-soon" | "nothing-new";

export type GateDecision =
  | { readonly proceed: true; readonly instructions: string }
  | { readonly proceed: false; readonly reason: GateRefusal; readonly held: boolean };

const REFUSAL_TEXT: Record<GateRefusal, string> = {
  "not-armed": "no trigger is armed and no review is retained",
  disabled: "refinement is disabled by settings",
  "no-harness-state": "this session cannot hold harness state, so a trigger would never run",
  "in-flight": "a round is already in flight, and a second would derive from a chain the first changed",
  "under-cooldown": "the cooldown from the last attempt has not elapsed",
  "too-soon": "fewer settled turns than the configured interval",
  "nothing-new": "nothing has been mined since the last review",
};

/**
 * Decide whether to pay for a review.
 *
 * `held: true` means the trigger survives to a later boundary; `held: false`
 * means it is cleared. Only `disabled` and `no-harness-state` clear it, and both
 * are settings problems rather than timing ones — a cooldown or a short turn
 * count will pass, and dropping the trigger on the way would throw away the
 * evidence that something was worth learning.
 *
 * That distinction is the difference between a harness that learns eventually
 * and one that silently stops, and it is why the return value carries both.
 */
export function cheapGate(input: GateInput): GateDecision {
  if (!input.pending && !input.hasPendingReview) return refuse("not-armed", false);

  // Gates before arithmetic. A disabled harness must not even measure how long
  // ago the last review was, because nothing about its history matters.
  if (!input.gates.enabled) return refuse("disabled", false);
  if (!input.harnessStateAvailable) return refuse("no-harness-state", false);

  if (input.inFlight) return refuse("in-flight", true);

  if (
    input.msSinceLastReview !== null &&
    input.gates.cooldownMs > 0 &&
    input.msSinceLastReview < input.gates.cooldownMs
  ) {
    return refuse("under-cooldown", true);
  }

  if (input.surface === "dispose") {
    // Disposal runs its review even when the interval has not elapsed: the
    // session is ending and this is the last boundary there will be. The
    // cooldown above still applies, so a dispose cannot double up on an attempt
    // that just failed.
    if (input.hasPendingReview) return { proceed: true, instructions: "" };
    if (input.candidates.length === 0) return refuse("nothing-new", true);
    return { proceed: true, instructions: "" };
  }

  if (input.settledTurns < input.gates.turnInterval) return refuse("too-soon", true);
  if (input.candidates.length === 0) return refuse("nothing-new", true);

  return { proceed: true, instructions: "" };
}

function refuse(reason: GateRefusal, held: boolean): GateDecision {
  return { proceed: false, reason, held };
}

/** The sentence a surface shows for a refusal. Never empty. */
export function gateReason(decision: GateDecision): string {
  return decision.proceed ? "refinement may run" : REFUSAL_TEXT[decision.reason];
}

/**
 * What a review should be asked, without asking it.
 *
 * Kept here rather than in the trigger so the prompt a model receives is
 * assembled next to the checks that decide whether it receives one at all.
 * The wording follows `prime-src`'s review prompt on its three refusals: one-off
 * noise, unsupported hypotheses, and transient tool output are all to be
 * declined.
 */
export function buildReviewRequest(input: {
  readonly entries: readonly HarnessEntry[];
  readonly rules: number;
  readonly settledTurns: number;
  /** The operator's prompt ceiling. Candidates are dropped whole, never cut,
   * and the question says how many were dropped so a reader cannot take a
   * bounded list for the whole set. */
  readonly maxCharacters?: number;
}): { readonly question: string; readonly candidates: readonly string[] } {
  const total = input.entries.length;
  const budget = input.maxCharacters ?? Infinity;
  const preamble = [
    "These observations were mined from a signed ledger without a model call.",
    "",
    "Decide whether there is a durable lesson here worth an operator reading.",
    "Decline one-off noise, unsupported hypotheses, and transient tool output.",
    "The chain records what happened; it does not record why, so an explanation",
    "of a cause is unsupported however plausible it sounds.",
    "",
  ];
  const tally =
    `${input.rules} refusal rule(s) and ${total} candidate(s) were derived ` +
    `across ${input.settledTurns} settled turns.`;
  const notice = (shown: number, dropped: number) =>
    ` Showing the first ${shown}; the other ${dropped} were dropped to fit ` +
    `the ${input.maxCharacters}-character ceiling, so this is a sample and not ` +
    `the whole set.`;
  const overhead = preamble.join("\n").length + tally.length;
  const candidates: string[] = [];
  let used = overhead;
  for (const entry of input.entries) {
    const line = `- [${entry.kind}] ${entry.tool} (${entry.klass}): ${entry.title}`;
    if (used + line.length + 1 > budget) break;
    candidates.push(line);
    used += line.length + 1;
  }
  // The notice is part of the request, so it has to fit too. Dropping from the
  // end until it does keeps the ceiling a ceiling rather than an allowance the
  // last sentence spends. It is emitted only when something was really dropped:
  // with no ceiling the loop would otherwise announce a truncation that did not
  // happen, which is the one thing a truncation notice must never do.
  let headline = "";
  if (candidates.length < total) {
    while (candidates.length > 0) {
      const candidate = notice(candidates.length, total - candidates.length);
      if (used + candidate.length <= budget) {
        headline = candidate;
        break;
      }
      used -= candidates.pop()!.length + 1;
    }
    if (headline === "")
      headline = notice(candidates.length, total - candidates.length);
  }
  const question = [
    preamble[0],
    tally + headline,
    ...preamble.slice(1),
    ...candidates,
  ].join("\n");
  return { question, candidates };
}
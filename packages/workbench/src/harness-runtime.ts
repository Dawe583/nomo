/**
 * The turn boundary where the harness may spend one model call on learning.
 *
 * The three modules it composes each hold one decision and none of them reach
 * for a model: `refine-gate` decides whether a round is worth paying for,
 * `refine-trigger` decides when and what to run, and `refine-pass` decides what
 * a reply may change. This file owns the order they run in, and nothing else:
 * the gate is asked first, so a refusal costs no provider request at all, and
 * the proposal is validated before a single byte of it can reach the chain.
 *
 * Every dependency is injected, including the clock and the asker. That is what
 * makes the interesting claim testable: a settled turn with no candidates must
 * make zero provider requests, and the only way to prove a count rather than
 * assert one is to hand in an asker that counts.
 */

import {
  buildReviewRequest,
  cheapGate,
  gateReason,
  type GateSurface,
  type RefineGates,
} from "./refine-gate.ts";
import type { HarnessEntry } from "./learned-harness.ts";
import {
  REFINEMENT_INSTRUCTIONS,
  buildRefineRequest,
  extractJsonObject,
  extractJsonValue,
  validateProposal,
  type RefinementProposal,
} from "./refine-pass.ts";
import {
  serviceTrigger,
  type ReviewVerdict,
  type ServiceResult,
  type TriggerState,
} from "./refine-trigger.ts";

/**
 * The reviewer's protocol, appended to the request rather than baked into the
 * shared instruction text: the refinement instructions describe a proposal,
 * and only the runtime knows that this call also has to carry a verdict.
 */
const VERDICT_PROTOCOL = [
  "",
  "Answer with JSON only, in one of two shapes:",
  '{ "approve": false, "reason": "why this is noise" }',
  '{ "approve": true, "proposal": { "summary": "", "rationale": "",',
  '    "expectedOutcome": "", "edits": [] } }',
  "",
  "An approval carrying no proposal is treated as a decline. An empty edits",
  "array is a valid answer and stamps nothing durable.",
].join("\n");

export type HarnessRuntimeDeps = {
  readonly gates: RefineGates;
  /** Which boundary this is. Disposal is the last one a session gets. */
  readonly surface: GateSurface;
  /** Injected so a cooldown can be tested without waiting for it to elapse. */
  readonly now: () => number;
  /** The entries mined from the verified chain, plus approved refinements. */
  readonly entries: () => Promise<readonly HarnessEntry[]>;
  /** Refusal rules currently in force, reported to the reviewer as context. */
  readonly rules: () => number;
  /** The one model call. Never reached unless the gate proceeds. */
  readonly ask: (request: string) => Promise<string>;
  /** Validate-and-apply, which is the only path into the signed chain. */
  readonly apply: (proposal: RefinementProposal) => Promise<void>;
  /** Read the live branch version so stale reviews are discarded. */
  readonly currentBranchVersion?: () => number;
  /**
   * A session that cannot persist harness state is never armed: its trigger
   * would fire, cost a model call and then have nowhere to record what it
   * learned. Defaults to true, so a caller that knows nothing about this is
   * not silently refusing to learn.
   */
  readonly harnessStateAvailable?: boolean;
};

/**
 * What the gate said, in the shape the trigger consumes.
 *
 * The trigger takes a plain decision rather than a gate verdict so the two
 * modules stay independently testable; the refusal text travels as the reason
 * because an operator reading a status line wants the sentence, not the code.
 */
function toTriggerDecision(
  gates: RefineGates,
  state: TriggerState,
  entries: readonly HarnessEntry[],
  surface: GateSurface,
  now: number,
  harnessStateAvailable: boolean,
): { proceed: true; instructions: string } | { proceed: false; reason: string; held: boolean } {
  const decision = cheapGate({
    gates,
    pending: state.pending,
    hasPendingReview: state.pendingReview !== null,
    inFlight: state.inFlight,
    settledTurns: state.settledTurnsSinceReview,
    msSinceLastReview: state.lastReviewAt === null ? null : now - state.lastReviewAt,
    candidates: entries,
    harnessStateAvailable,
    surface,
  });
  if (decision.proceed) return { proceed: true, instructions: decision.instructions };
  return { proceed: false, reason: gateReason(decision), held: decision.held };
}

/**
 * Read a reviewer verdict out of a model reply.
 *
 * A reply that is not the agreed JSON declines rather than throws. The gate has
 * already been paid for at that point, and a model that answered in prose has
 * not approved anything; treating that as an error would burn the cooldown on a
 * formatting problem and report it as a provider failure.
 *
 * Approval without a proposal is a decline for the same reason: there is
 * nothing to apply, and a round that ran nothing must not stamp the cooldown as
 * though a lesson had been earned.
 */
export function parseReviewVerdict(reply: string): ReviewVerdict {
  const parsed = extractJsonValue(reply);
  if (!parsed.ok)
    return { approve: false, reason: `Reviewer reply was not JSON: ${parsed.message}` };
  const record = parsed.value as Record<string, unknown>;
  if (record.approve !== true)
    return {
      approve: false,
      reason:
        typeof record.reason === "string" && record.reason !== ""
          ? record.reason
          : "Reviewer declined without giving a reason.",
    };
  const proposal = record.proposal;
  if (typeof proposal !== "object" || proposal === null || Array.isArray(proposal))
    return { approve: false, reason: "Reviewer approved without a proposal to apply." };
  return { approve: true, instructions: JSON.stringify(proposal) };
}

/**
 * One boundary: gate, review, refine.
 *
 * Returns the trigger state the caller must retain. The caller owns persistence
 * because only it knows which session a state belongs to; this function never
 * stores anything, so a crash between two boundaries costs a delay and not a
 * decision.
 */
export async function serviceHarnessBoundary(
  state: TriggerState,
  deps: HarnessRuntimeDeps,
): Promise<ServiceResult> {
  const entries = await deps.entries();

  const review = async (): Promise<ReviewVerdict> => {
    const settledTurns = state.settledTurnsSinceReview;
    const rules = deps.rules();
    const evidence = buildRefineRequest({ entries, rules, settledTurns });
    const question = buildReviewRequest({ entries, rules, settledTurns }).question;
    const reply = await deps.ask(
      `${REFINEMENT_INSTRUCTIONS}\n${VERDICT_PROTOCOL}\n\n${question}\n\n${evidence}`,
    );
    return parseReviewVerdict(reply);
  };

  const run = async (instructions: string): Promise<void> => {
    const parsed = extractJsonObject(instructions);
    if (!parsed.ok)
      throw new Error(`Refinement reply was not a proposal: ${parsed.message}`);
    const validated = validateProposal(parsed.proposal);
    if (!validated.ok)
      throw new Error(`Invalid refinement proposal: ${validated.rejections.join("; ")}`);
    await deps.apply(validated.proposal);
  };

  return serviceTrigger(
    state,
    (current) =>
      toTriggerDecision(
        deps.gates,
        current,
        entries,
        deps.surface,
        deps.now(),
        deps.harnessStateAvailable ?? true,
      ),
    review,
    { now: deps.now, run, currentBranchVersion: deps.currentBranchVersion },
  );
}

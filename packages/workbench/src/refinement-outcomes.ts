/**
 * What became of the harness's own proposals, read from the chain.
 *
 * The learning loop used to run one way. The chain was mined into entries, a
 * review turned entries into a proposal, an operator settled the proposal, and
 * nothing read that settlement back. A reviewer that cannot see an operator
 * already said no asks again, and a harness that keeps asking the same
 * question has not learned anything from the answer.
 *
 * This module is the return path, and it inherits the discipline of
 * `learned-rules.ts` and `learned-harness.ts` rather than restating it: an
 * outcome is evidence, not authority, and nothing here writes or decides.
 *
 * Three constraints shaped the file:
 *
 * - **One outcome per proposal digest.** The loop reads records it caused, so
 *   it must not be able to amplify itself. However many times a digest is
 *   proposed and settled, it yields one outcome, and the count of outcomes is
 *   bounded by the proposals the chain holds.
 * - **Outcomes are not harness entries.** `harnessEntries` feeds the agent's
 *   prompt, and retrieval there is bounded to approved, verified records. A
 *   note that an operator rejected something is neither, so outcomes have
 *   their own type and reach only the reviewer.
 * - **The repeat check trusts no model.** Whether a proposal repeats a settled
 *   one is decided from the edits and the sequences they cite, never from the
 *   reason or the summary, because those are the parts a model rewords.
 */

import type { RefinementProposal } from "./refine-pass.ts";
import {
  computeReward,
  measureRefinementEffect,
  REWARD_SCHEMA,
  type RefinementEffect,
  type RewardRecord,
  type SplitSummary,
} from "./harness-scores.ts";

/**
 * An entry as this module reads it. A record with no sequence cannot be placed
 * in order, and order is what turns four record kinds into a status, so such
 * a record is skipped rather than guessed at.
 */
type Entry = { readonly body: unknown; readonly seq?: number };

export type RefinementOutcomeStatus = "pending" | "rejected" | "activated" | "rolled-back";

export type OutcomeEdit = {
  readonly action: string;
  readonly kind: string;
  /** The title, id or profile id an operator would recognise the edit by. */
  readonly label: string;
  /** What the edit would change, without the parts a model rewords. */
  readonly fingerprint: string;
};

export type RefinementOutcome = {
  readonly digest: string;
  readonly status: RefinementOutcomeStatus;
  readonly summary: string;
  readonly edits: readonly OutcomeEdit[];
  /** The latest record that proposed this digest. Null when a chain carries an
   * activation whose proposal record it no longer holds. */
  readonly createdSeq: number | null;
  /** The record that activated this digest, preserved even if a later record
   * rolled it back. Null when never activated. */
  readonly activatedSeq?: number | null;
  /** The record that settled it. Null while it is pending. */
  readonly settledSeq: number | null;
  readonly timesProposed: number;
  readonly timesRejected: number;
};

const DIGEST = /^[a-f0-9]{64}$/;
const SUMMARY_CHARACTERS = 160;
const EDITS_NAMED = 3;

function object(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** Key order must not change a fingerprint, or the same profile written twice
 * by a model would read as two different edits. */
function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  const record = object(value);
  if (record === null) return JSON.stringify(value ?? null);
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stable(record[key])}`)
    .join(",")}}`;
}

/**
 * What an edit would change. `reason` and `derivedFromSeq` are left out on
 * purpose: the first is prose a model rewords freely, and the second is the
 * evidence, which is compared separately so that newer evidence can reopen a
 * question the same wording cannot.
 */
function fingerprint(edit: Record<string, unknown>): string {
  return JSON.stringify([
    text(edit.action),
    text(edit.kind),
    text(edit.id),
    text(edit.title),
    text(edit.content),
    text(edit.promptAddendum),
    edit.profile === undefined ? "" : stable(edit.profile),
  ]);
}

function outcomeEdits(proposal: Record<string, unknown>): OutcomeEdit[] {
  if (!Array.isArray(proposal.edits)) return [];
  const edits: OutcomeEdit[] = [];
  for (const raw of proposal.edits) {
    const edit = object(raw);
    if (edit === null) continue;
    edits.push({
      action: text(edit.action),
      kind: text(edit.kind),
      label: text(edit.title) || text(edit.id) || text(object(edit.profile)?.id),
      fingerprint: fingerprint(edit),
    });
  }
  return edits;
}

type Tracked = {
  digest: string;
  status: RefinementOutcomeStatus;
  summary: string;
  edits: OutcomeEdit[];
  firstSeq: number;
  createdSeq: number | null;
  activatedSeq: number | null;
  settledSeq: number | null;
  timesProposed: number;
  timesRejected: number;
};

/**
 * One outcome per proposal digest, in the order the proposals first appeared.
 *
 * Records are replayed in sequence order whatever order they arrive in, so two
 * readers of the same chain agree. A settlement for a digest the chain never
 * described is skipped: there is nothing to say about a proposal nobody can
 * read, and inventing an outcome for it would be a claim without a record.
 */
export function mineRefinementOutcomes(entries: readonly Entry[]): RefinementOutcome[] {
  const ordered = entries
    .filter((entry) => typeof entry.seq === "number" && Number.isInteger(entry.seq))
    .slice()
    .sort((a, b) => a.seq! - b.seq!);
  const tracked = new Map<string, Tracked>();

  for (const entry of ordered) {
    const body = object(entry.body);
    if (body === null) continue;
    const decision = text(body.decision);
    const stored = object(body.harnessProposal);
    const lifecycle = object(body.harnessLifecycle);
    const refinement = object(body.harnessRefinement);
    const digest =
      text(stored?.digest) ||
      text(lifecycle?.digest) ||
      text(refinement?.digest) ||
      text(refinement?.rolledBackDigest);
    if (!DIGEST.test(digest)) continue;
    const seq = entry.seq!;
    const described = object(stored?.proposal);
    const existing = tracked.get(digest);

    if (decision === "proposal:created") {
      if (described === null) continue;
      tracked.set(digest, {
        digest,
        status: "pending",
        summary: text(described.summary),
        edits: outcomeEdits(described),
        firstSeq: existing?.firstSeq ?? seq,
        createdSeq: seq,
        activatedSeq: existing?.activatedSeq ?? null,
        settledSeq: null,
        timesProposed: (existing?.timesProposed ?? 0) + 1,
        timesRejected: existing?.timesRejected ?? 0,
      });
      continue;
    }

    if (decision === "proposal:rejected") {
      if (existing === undefined) continue;
      existing.status = "rejected";
      existing.settledSeq = seq;
      existing.timesRejected += 1;
      continue;
    }

    // `refinement:approved` is the older name for an activation. Chains that
    // carry it still replay, so it settles a proposal the same way.
    if (decision === "proposal:activated" || decision === "refinement:approved") {
      if (existing !== undefined) {
        existing.status = "activated";
        existing.activatedSeq = seq;
        existing.settledSeq = seq;
      } else if (described !== null) {
        tracked.set(digest, {
          digest,
          status: "activated",
          summary: text(described.summary),
          edits: outcomeEdits(described),
          firstSeq: seq,
          createdSeq: null,
          activatedSeq: seq,
          settledSeq: seq,
          timesProposed: 0,
          timesRejected: 0,
        });
      }
      continue;
    }

    if (decision === "refinement:rolled-back") {
      if (existing === undefined) continue;
      existing.status = "rolled-back";
      existing.settledSeq = seq;
    }
  }

  return [...tracked.values()]
    .sort((a, b) => a.firstSeq - b.firstSeq || (a.digest < b.digest ? -1 : 1))
    .map(({ firstSeq: _first, ...outcome }) => outcome);
}

/**
 * The settled proposal this one repeats, or null.
 *
 * A repeat is exact and narrow. The new proposal must carry the same set of
 * edits as one an operator rejected or rolled back, and cite no record after
 * that decision. A subset is not a repeat: an operator who refused two edits
 * together has not been asked about one of them alone. A proposal that cites a
 * newer record is not a repeat either, and goes to the operator as before;
 * citing a newer record is the floor for asking again, not proof the answer
 * changed, and deciding that is the operator's job.
 */
export function repeatsSettledProposal(
  proposal: RefinementProposal,
  outcomes: readonly RefinementOutcome[],
): RefinementOutcome | null {
  if (proposal.edits.length === 0) return null;
  const wanted = new Set(
    proposal.edits.map((edit) => fingerprint(edit as unknown as Record<string, unknown>)),
  );
  let newest = -Infinity;
  for (const edit of proposal.edits)
    for (const seq of edit.derivedFromSeq) if (seq > newest) newest = seq;

  let repeated: RefinementOutcome | null = null;
  for (const outcome of outcomes) {
    if (outcome.status !== "rejected" && outcome.status !== "rolled-back") continue;
    if (outcome.settledSeq === null || newest > outcome.settledSeq) continue;
    const settled = new Set(outcome.edits.map((edit) => edit.fingerprint));
    if (settled.size !== wanted.size) continue;
    let same = true;
    for (const item of wanted)
      if (!settled.has(item)) {
        same = false;
        break;
      }
    if (!same) continue;
    if (repeated === null || outcome.settledSeq > repeated.settledSeq!) repeated = outcome;
  }
  return repeated;
}

/** The sentence a refused repeat is reported with. Names the decision and the
 * sequence, because a refusal that does not say what it rests on reads as a
 * fault rather than as the operator's earlier answer. */
export function repeatRefusal(outcome: RefinementOutcome): string {
  const decided = outcome.status === "rejected" ? "rejected" : "rolled back";
  return (
    `An operator already ${decided} this refinement at sequence ${outcome.settledSeq}, ` +
    `and the proposal cites nothing recorded after that decision. ` +
    `Cite newer records that support it, or leave it.`
  );
}

function clip(value: string): string {
  const flat = value.replace(/\s+/g, " ").trim();
  return flat.length <= SUMMARY_CHARACTERS ? flat : `${flat.slice(0, SUMMARY_CHARACTERS - 3)}...`;
}

function editList(edits: readonly OutcomeEdit[]): string {
  const named = edits
    .slice(0, EDITS_NAMED)
    .map((edit) => `${edit.action} ${edit.kind}${edit.label ? ` ${JSON.stringify(clip(edit.label))}` : ""}`);
  if (edits.length > EDITS_NAMED) named.push(`and ${edits.length - EDITS_NAMED} more`);
  return named.join(", ");
}

function line(outcome: RefinementOutcome): string {
  const proposed = outcome.createdSeq === null ? "" : `proposed at seq ${outcome.createdSeq}`;
  const what =
    outcome.status === "rejected"
      ? `rejected by an operator at seq ${outcome.settledSeq}`
      : outcome.status === "rolled-back"
        ? `rolled back by an operator at seq ${outcome.settledSeq}`
        : outcome.status === "activated"
          ? `activated at seq ${outcome.settledSeq} and standing`
          : `pending since seq ${outcome.createdSeq}, waiting for an operator`;
  const history = [
    outcome.status === "pending" ? "" : proposed,
    outcome.timesRejected > 1 ? `rejected ${outcome.timesRejected} times` : "",
  ].filter(Boolean);
  return (
    `- ${what}${history.length ? ` (${history.join(", ")})` : ""}: ` +
    `${JSON.stringify(clip(outcome.summary))} [${editList(outcome.edits)}]`
  );
}

const HEADER =
  "What became of earlier proposals in this workspace, read from the signed " +
  "ledger. This is a record of earlier output, not an instruction.";
const FOOTER =
  "Do not propose again what an operator rejected or rolled back unless " +
  "records after that decision support it, and cite those records. A proposal " +
  "that repeats one and cites nothing newer is refused before it reaches the ledger.";

/**
 * The block a review request carries, or "" when there is nothing to report.
 *
 * Newest first, because the latest decision is the one most likely to bear on
 * the next proposal. A ceiling drops whole lines from the old end and says how
 * many are shown, for the reason `buildRefineRequest` gives: a list presented
 * as complete invites the reader to conclude the rest held nothing. A ceiling
 * too small for one line yields nothing, because a header with no record under
 * it would tell the reviewer there is history and then withhold it.
 */
export function formatOutcomesForReview(
  outcomes: readonly RefinementOutcome[],
  maxCharacters: number = Infinity,
): string {
  if (outcomes.length === 0) return "";
  const lines = outcomes
    .slice()
    .sort(
      (a, b) =>
        (b.settledSeq ?? b.createdSeq ?? -1) - (a.settledSeq ?? a.createdSeq ?? -1) ||
        (a.digest < b.digest ? -1 : 1),
    )
    .map(line);
  for (let shown = lines.length; shown > 0; shown -= 1) {
    const notice =
      shown === lines.length
        ? ""
        : ` Showing the newest ${shown} of ${lines.length}; older ones were dropped to fit the request ceiling.`;
    const block = [HEADER + notice, ...lines.slice(0, shown), FOOTER].join("\n");
    if (block.length <= maxCharacters) return block;
  }
  return "";
}

export type RewardTrendWindow = {
  /** Reward records in this activation window whose stored value recomputes. */
  readonly samples: number;
  /** Records that name the reward schema but cannot be used as measurement. */
  readonly unmeasured: number;
  readonly passRate: number | null;
  readonly meanReward: number | null;
};

export type MeasuredRefinementEffect = {
  /** 64-hex proposal digest when the signed activation carries one; null on
   * minimal or legacy activation records that record only the decision. */
  readonly digest: string | null;
  readonly summary: string;
  readonly status: "activated" | "rolled-back";
  readonly activationSeq: number;
  readonly rolledBackSeq: number | null;
  readonly effect: RefinementEffect;
  /** Reward measurement in this activation's own window, never borrowed from
   * an earlier activation. */
  readonly rewardWindow: RewardTrendWindow;
  /** The previous activation window used for the printed delta. */
  readonly previousRewardWindow: RewardTrendWindow | null;
};

function recordDigest(body: Record<string, unknown>): string | null {
  const stored = object(body.harnessProposal);
  const lifecycle = object(body.harnessLifecycle);
  const refinement = object(body.harnessRefinement);
  const digest =
    text(stored?.digest) ||
    text(lifecycle?.digest) ||
    text(refinement?.digest) ||
    text(refinement?.rolledBackDigest);
  return DIGEST.test(digest) ? digest : null;
}


const EMPTY_REWARD_WINDOW: RewardTrendWindow = {
  samples: 0,
  unmeasured: 0,
  passRate: null,
  meanReward: null,
};

/**
 * Recomputable reward records in one inclusive activation window.
 *
 * The command prints only measurements that can be checked from the record
 * itself. A malformed record, a nonnumeric reward and a reward whose stored
 * value does not recompute are counted as unmeasured, never as zero.
 */
function rewardTrendWindow(
  entries: readonly Entry[],
  startSeq: number,
  endSeq: number,
): RewardTrendWindow {
  let samples = 0;
  let unmeasured = 0;
  let passes = 0;
  let rewardTotal = 0;
  for (const entry of entries) {
    if (typeof entry.seq !== "number" || entry.seq <= startSeq || entry.seq > endSeq)
      continue;
    const body = object(entry.body);
    if (body === null || body.schema !== REWARD_SCHEMA) continue;
    try {
      const record = body as unknown as RewardRecord;
      if (
        computeReward(record) === record.reward &&
        typeof record.reward === "number" &&
        typeof record.passed === "boolean"
      ) {
        samples += 1;
        rewardTotal += record.reward;
        if (record.passed) passes += 1;
      } else {
        unmeasured += 1;
      }
    } catch {
      unmeasured += 1;
    }
  }
  if (samples === 0) return { ...EMPTY_REWARD_WINDOW, unmeasured };
  return {
    samples,
    unmeasured,
    passRate: passes / samples,
    meanReward: rewardTotal / samples,
  };
}

/**
 * Measure the before-and-after ratchet effect of every signed refinement
 * activation in a chain.
 *
 * Pure, deterministic and order-independent. Only signed `proposal:activated`
 * and legacy `refinement:approved` records produce effects; arbitrary text or
 * rejected proposals never do. When a later `refinement:rolled-back` record
 * carries the same digest, the post-activation window ends at that rollback
 * sequence so post-rollback traffic does not distort what happened while the
 * refinement was active. Bounded by one effect per signed activation record.
 */
export function mineRefinementEffects(
  entries: readonly Entry[],
  generatedAt = "",
): MeasuredRefinementEffect[] {
  const ordered = entries
    .filter((entry) => typeof entry.seq === "number" && Number.isInteger(entry.seq))
    .slice()
    .sort((a, b) => a.seq! - b.seq!);
  const summaries = new Map<string, string>();
  const rollbacks = new Map<string, number[]>();
  const activations: { seq: number; digest: string | null; summary: string }[] = [];

  for (const entry of ordered) {
    const body = object(entry.body);
    if (body === null) continue;
    const decision = text(body.decision);
    const digest = recordDigest(body);
    const stored = object(body.harnessProposal);
    const described = object(stored?.proposal);
    const summary = described ? text(described.summary) : "";
    if (digest && summary) summaries.set(digest, summary);

    if (decision === "refinement:rolled-back" && digest) {
      const seqs = rollbacks.get(digest) ?? [];
      seqs.push(entry.seq!);
      rollbacks.set(digest, seqs);
      continue;
    }

    if (decision === "proposal:activated" || decision === "refinement:approved") {
      activations.push({
        seq: entry.seq!,
        digest,
        summary: summary || (digest ? summaries.get(digest) ?? "" : ""),
      });
    }
  }

  const windows = activations.map((activation, index) => {
    const rollbackSeqs = activation.digest ? rollbacks.get(activation.digest) ?? [] : [];
    const rolledBackSeq = rollbackSeqs.find((seq) => seq > activation.seq) ?? null;
    const nextActivationSeq = activations[index + 1]?.seq ?? null;
    const endSeq = Math.min(
      rolledBackSeq ?? Number.POSITIVE_INFINITY,
      nextActivationSeq === null ? Number.POSITIVE_INFINITY : nextActivationSeq - 1,
    );
    return {
      activation,
      rolledBackSeq,
      endSeq,
      rewardWindow: rewardTrendWindow(ordered, activation.seq, endSeq),
    };
  });
  return windows.map(({ activation, rolledBackSeq, endSeq, rewardWindow }, index) => {
    const effect = measureRefinementEffect(ordered, activation.seq, {
      untilSeq: Number.isFinite(endSeq) ? endSeq : rolledBackSeq,
      generatedAt,
    });
    return {
      digest: activation.digest,
      summary: activation.summary,
      status: rolledBackSeq !== null ? "rolled-back" : "activated",
      activationSeq: activation.seq,
      rolledBackSeq,
      effect,
      rewardWindow,
      previousRewardWindow: index === 0 ? null : windows[index - 1]!.rewardWindow,
    };
  });
}

function splitNumber(summary: SplitSummary): string {
  return summary.mean === null ? "unmeasured" : summary.mean.toFixed(3);
}


function signedDelta(before: number, after: number): string {
  const delta = after - before;
  return `${delta >= 0 ? "+" : ""}${delta.toFixed(3)}`;
}

function rewardTrendText(item: MeasuredRefinementEffect): string {
  const current = item.rewardWindow;
  const previous = item.previousRewardWindow;
  const samples = `${previous?.samples ?? 0}->${current.samples}`;
  if (
    previous === null ||
    previous.samples === 0 ||
    current.samples === 0 ||
    previous.passRate === null ||
    current.passRate === null ||
    previous.meanReward === null ||
    current.meanReward === null
  ) {
    const gap = current.unmeasured ? `, ${current.unmeasured} unmeasured` : "";
    return `pass_rate insufficient-data | reward insufficient-data | reward_samples ${samples}${gap}`;
  }
  return (
    `pass_rate ${previous.passRate.toFixed(3)}->${current.passRate.toFixed(3)} ` +
    `delta ${signedDelta(previous.passRate, current.passRate)} | ` +
    `reward ${previous.meanReward.toFixed(3)}->${current.meanReward.toFixed(3)} ` +
    `delta ${signedDelta(previous.meanReward, current.meanReward)} | ` +
    `reward_samples ${samples}`
  );
}

function effectLine(item: MeasuredRefinementEffect): string {
  const state =
    item.status === "rolled-back"
      ? `rolled back at seq ${item.rolledBackSeq}`
      : "standing";
  const label = item.summary ? `: ${JSON.stringify(clip(item.summary))}` : "";
  const hold = `${splitNumber(item.effect.before.metrics.hold_rate)}->${splitNumber(item.effect.after.metrics.hold_rate)}`;
  const guardrails = item.effect.guardrails
    .map((guardrail) => {
      if (guardrail.before.mean === null && guardrail.after.mean === null) {
        return `${guardrail.key} unmeasured`;
      }
      return `${guardrail.key} ${splitNumber(guardrail.before)}->${splitNumber(guardrail.after)}${guardrail.regressed ? " REGRESSED" : ""}`;
    })
    .join(", ");
  const unmeasured =
    item.effect.unmeasuredGuardrails.length > 0
      ? `unmeasured guardrails: ${item.effect.unmeasuredGuardrails.join(", ")}`
      : "all guardrails measured";
  return (
    `- activated at seq ${item.activationSeq} (${state})${label} | ` +
    `verdict ${item.effect.verdict} | ` +
    `cases ${item.effect.before.caseCount}->${item.effect.after.caseCount} | ` +
    `${rewardTrendText(item)} | ` +
    `hold_rate ${hold} | ${guardrails} | ${unmeasured}`
  );
}

const EFFECT_HEADER =
  "Measured effect of activated refinements from the signed ledger (strictly " +
  "before vs after activation). Descriptive only; never triggers a rollback " +
  "or changes a decision, policy or permission.";
const EFFECT_FOOTER =
  "Use as descriptive evidence only. Unmeasured guardrails are gaps, not " +
  "passes; scores never authorize or roll back a change.";

/**
 * The descriptive effect block a review request carries, or "" when no
 * activated refinement exists.
 *
 * Newest activation first; obeys `maxCharacters` by dropping whole older lines
 * and never emitting a header with zero records under it.
 */
export function formatEffectsForReview(
  effects: readonly MeasuredRefinementEffect[],
  maxCharacters: number = Infinity,
): string {
  if (effects.length === 0) return "";
  const lines = effects
    .slice()
    .sort((a, b) => b.activationSeq - a.activationSeq)
    .map(effectLine);
  for (let shown = lines.length; shown > 0; shown -= 1) {
    const notice =
      shown === lines.length
        ? ""
        : ` Showing the newest ${shown} of ${lines.length}; older ones were dropped to fit the request ceiling.`;
    const block = [EFFECT_HEADER + notice, ...lines.slice(0, shown), EFFECT_FOOTER].join("\n");
    if (block.length <= maxCharacters) return block;
  }
  return "";
}

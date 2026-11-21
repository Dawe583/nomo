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
        existing.settledSeq = seq;
      } else if (described !== null) {
        tracked.set(digest, {
          digest,
          status: "activated",
          summary: text(described.summary),
          edits: outcomeEdits(described),
          firstSeq: seq,
          createdSeq: null,
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

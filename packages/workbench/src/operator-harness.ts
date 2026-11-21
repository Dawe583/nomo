/**
 * Operator scope for approved refinements (HP1).
 *
 * Every conversation, branch and subagent signs into its own workspace chain,
 * so an entry an operator approved in one conversation was read only there.
 * The operator chain is one more workspace in the same encrypted snapshot,
 * signed with the same key. A promotion copies the entries one activated
 * refinement produced into it, every run reads them back from the verified
 * chain, and a demotion ends them. Nothing reaches every conversation that an
 * operator did not decide twice: once as a refinement of the conversation it
 * came from, and once as a promotion of that exact digest.
 *
 * Pure on purpose. The workbench verifies, signs and persists; this module
 * decides what a promotion carries and how the operator chain replays. Like
 * every learned entry, nothing here reaches `decide`, policy or the catalog.
 */
import type { HarnessEntry } from "./learned-harness.ts";
import { contentAddressedId, type AppliedEdit } from "./refine-pass.ts";
import { mineRefinementOutcomes } from "./refinement-outcomes.ts";

/** The workspace name of the operator chain. Session workspaces are
 * `agent-<uuid>`, so the name cannot collide with one. */
export const OPERATOR_HARNESS_WORKSPACE = "nomo-operator-harness";

type Entry = { readonly body: unknown; readonly seq?: number };

export type OperatorPromotionStatus = "promoted" | "demoted";

export type OperatorPromotion = {
  /** The promotion's own digest: the hash of its source and entries. */
  readonly digest: string;
  readonly status: OperatorPromotionStatus;
  /** The conversation workspace the refinement was activated in. */
  readonly sourceWorkspace: string;
  /** The refinement digest the operator approved there. */
  readonly sourceDigest: string;
  /** The activation record in the source chain. */
  readonly sourceSeq: number;
  readonly entries: readonly HarnessEntry[];
  /** The latest promotion record in the operator chain. */
  readonly promotedSeq: number;
  /** The demotion that ended it, null while it stands. */
  readonly demotedSeq: number | null;
};

const DIGEST = /^[a-f0-9]{64}$/;

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function malformed(): Error {
  return new Error("The signed operator promotion is malformed.");
}

/**
 * The ids of the entries an activation created or superseded. A deleted
 * entry is not something to carry anywhere. An id-less create is named the
 * way `applyProposal` named it, which is the same derivation a rollback uses.
 */
export function activatedEntryIds(applied: readonly AppliedEdit[]): string[] {
  const ids: string[] = [];
  for (const { edit, outcome } of applied) {
    if (outcome === "deleted") continue;
    const text = edit.kind === "prompt" ? (edit.promptAddendum ?? "") : (edit.content ?? "");
    const id = edit.id ?? contentAddressedId(edit.kind, edit.title ?? "", text);
    if (!ids.includes(id)) ids.push(id);
  }
  return ids;
}

/** Only an operator-approved lesson is carried. A refinement never produces a
 * rule, and a record holding one was not written by a promotion. */
function promotedEntry(raw: unknown): HarnessEntry {
  const entry = object(raw);
  if (
    entry === null ||
    typeof entry.id !== "string" ||
    entry.id === "" ||
    entry.kind !== "lesson" ||
    typeof entry.title !== "string" ||
    typeof entry.content !== "string" ||
    typeof entry.tool !== "string" ||
    typeof entry.klass !== "string" ||
    !Array.isArray(entry.derivedFromSeq) ||
    !entry.derivedFromSeq.every((seq) => Number.isInteger(seq)) ||
    typeof entry.repeats !== "number" ||
    typeof entry.createdAt !== "string"
  )
    throw malformed();
  return {
    id: entry.id,
    kind: "lesson",
    scope: "operator",
    tool: entry.tool,
    klass: entry.klass,
    title: entry.title,
    content: entry.content,
    derivedFromSeq: [...(entry.derivedFromSeq as number[])],
    repeats: entry.repeats,
    createdAt: entry.createdAt,
    decidedByOperator: true,
  };
}

/**
 * Replay the operator chain. A promotion of a digest the chain already holds
 * stands again from its latest record; a demotion ends the promotion it names.
 * A record that does not parse throws rather than being skipped: this chain
 * feeds every conversation's prompt, and a guess here is a guess everywhere.
 */
export function minePromotions(chain: readonly Entry[]): OperatorPromotion[] {
  const byDigest = new Map<string, OperatorPromotion>();
  for (const entry of chain) {
    const record = object(object(entry.body)?.harnessPromotion);
    if (record === null) continue;
    const digest = typeof record.digest === "string" ? record.digest : "";
    if (!DIGEST.test(digest) || !Number.isInteger(entry.seq)) throw malformed();
    if (record.status === "promoted") {
      if (
        typeof record.sourceWorkspace !== "string" ||
        record.sourceWorkspace === "" ||
        typeof record.sourceDigest !== "string" ||
        !DIGEST.test(record.sourceDigest) ||
        !Number.isInteger(record.sourceSeq) ||
        !Array.isArray(record.entries) ||
        record.entries.length === 0
      )
        throw malformed();
      byDigest.delete(digest);
      byDigest.set(digest, {
        digest,
        status: "promoted",
        sourceWorkspace: record.sourceWorkspace,
        sourceDigest: record.sourceDigest,
        sourceSeq: record.sourceSeq as number,
        entries: record.entries.map(promotedEntry),
        promotedSeq: entry.seq!,
        demotedSeq: null,
      });
      continue;
    }
    if (record.status === "demoted") {
      const existing = byDigest.get(digest);
      if (existing === undefined)
        throw new Error("The signed operator chain demotes a promotion it never made.");
      byDigest.set(digest, { ...existing, status: "demoted", demotedSeq: entry.seq! });
      continue;
    }
    throw malformed();
  }
  return [...byDigest.values()];
}

/** The entries every conversation reads: those of the standing promotions,
 * where a later promotion of the same id wins. */
export function operatorEntries(promotions: readonly OperatorPromotion[]): HarnessEntry[] {
  const byId = new Map<string, HarnessEntry>();
  const standing = promotions
    .filter((promotion) => promotion.status === "promoted")
    .sort((a, b) => a.promotedSeq - b.promotedSeq);
  for (const promotion of standing)
    for (const entry of promotion.entries) {
      byId.delete(entry.id);
      byId.set(entry.id, entry);
    }
  return [...byId.values()];
}

/** A conversation's own entry wins over an operator entry with the same id:
 * the conversation's chain is the more specific decision. */
export function withOperatorScope(
  own: readonly HarnessEntry[],
  operator: readonly HarnessEntry[],
): HarnessEntry[] {
  const ids = new Set(own.map((entry) => entry.id));
  return [...own, ...operator.filter((entry) => !ids.has(entry.id))];
}

/** The parts of an entry an operator reads. The stamp and the provenance are
 * not part of what was decided. */
function sameText(a: HarnessEntry, b: HarnessEntry): boolean {
  return (
    a.id === b.id &&
    a.kind === b.kind &&
    a.title === b.title &&
    a.content === b.content &&
    a.tool === b.tool &&
    a.klass === b.klass
  );
}

/**
 * What a promotion of `digest` carries, from the source conversation's
 * verified chain and the entries it reads now.
 *
 * Exact on purpose. Only the entries the named activation produced are
 * candidates, each as the text that activation signed, and each only while the
 * conversation still reads that same text as an operator decision. An entry a
 * later refinement changed belongs to that later digest; an entry a rollback
 * restored is labelled a rollback, not an operator decision, and stays home.
 */
export function promotionCandidate(
  chain: readonly Entry[],
  current: readonly HarnessEntry[],
  digest: string,
  promotions: readonly OperatorPromotion[],
): { readonly sourceSeq: number; readonly entries: readonly HarnessEntry[] } {
  const outcome = mineRefinementOutcomes(chain).find((item) => item.digest === digest);
  if (outcome === undefined)
    throw new Error("No refinement matches that digest in this conversation.");
  if (outcome.status !== "activated")
    throw new Error(
      `Only an activated refinement can be promoted; ${digest.slice(0, 8)} is ${outcome.status}.`,
    );
  let activation: { readonly seq: number; readonly record: Record<string, unknown> } | undefined;
  for (const entry of chain) {
    const body = object(entry.body);
    const record = object(body?.harnessRefinement);
    if (record === null || record.digest !== digest) continue;
    if (body!.decision !== "proposal:activated" && body!.decision !== "refinement:approved")
      continue;
    activation = { seq: entry.seq!, record };
  }
  if (
    activation === undefined ||
    activation.record.approvedBy !== "operator" ||
    !Array.isArray(activation.record.applied) ||
    !Array.isArray(activation.record.overrides)
  )
    throw new Error("No operator approval of that refinement is in this conversation's chain.");
  const signed = new Map(
    (activation.record.overrides as HarnessEntry[]).map((entry) => [entry.id, entry]),
  );
  const standing = new Map(current.map((entry) => [entry.id, entry]));
  const entries: HarnessEntry[] = [];
  for (const id of activatedEntryIds(activation.record.applied as AppliedEdit[])) {
    const activated = signed.get(id);
    const now = standing.get(id);
    if (activated === undefined || activated.kind !== "lesson") continue;
    if (now === undefined || now.decidedByOperator !== true || !sameText(activated, now)) continue;
    entries.push(promotedEntry(activated));
  }
  if (entries.length === 0)
    throw new Error("Nothing that refinement activated is still in effect in this conversation.");
  const held = new Map(operatorEntries(promotions).map((entry) => [entry.id, entry]));
  if (entries.every((entry) => held.has(entry.id) && sameText(held.get(entry.id)!, entry)))
    throw new Error("That refinement is already promoted to every conversation.");
  return { sourceSeq: activation.seq, entries };
}

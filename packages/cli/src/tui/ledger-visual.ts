// Ledger panel visuals: the chain as a shape, and headings that say what each
// group of rows is evidence of.
//
// The ledger tab mixes signed entries with records derived from them. A
// reader scanning for a refusal was stepping over mined rules, scores, hooks
// and agents to find the entries, and nothing on screen said which rows were
// signed evidence and which were computed afterwards. The chain line answers
// "is this chain intact" with a glyph row plus a word, and the group heading
// says "derived, not evidence" in words, so neither state is carried by
// colour alone.
//
// The counts here are the entries the verifier actually returned. A workspace
// whose chain failed verification contributes no entries at all, so it is
// named as a degraded workspace with its exact reason rather than drawn as an
// empty chain that looks merely quiet.
import { fit, sanitizeText } from "./layout.ts";

/** One chain as the tab knows it. `entries` is the verified count, never an
 * estimate; a failed verification has no count to show. */
export interface ChainView {
  readonly label: string;
  readonly entries: number;
  readonly verified: boolean;
  /** Workspaces whose chain failed to verify. Their entries are unknown. */
  readonly failedWorkspaces?: number;
  /** The exact failure the verifier or the workbench reported. */
  readonly reason?: string;
}

/** Marks one entry. A single cell, so a chain row stays countable. */
const NODE = "●";
/** Marks an entry the verifier could not confirm. */
const FAILED_NODE = "×";
/** Connects two entries. */
const LINK = "─";
/** The most nodes a row draws before it counts the rest instead. Eight nodes
 * and seven links is 15 cells, which leaves room for the count and the
 * verdict at 40 columns. */
const MAX_NODES = 8;

/**
 * The chain shape for a count: `●─●─●`. A failed chain ends in `×` so the
 * break is visible where it happened, and a chain longer than the row can
 * draw keeps its count as text rather than dropping entries silently.
 */
export function chainGlyphs(
  entries: number,
  options?: { readonly verified?: boolean; readonly maxNodes?: number },
): string {
  const total =
    Number.isFinite(entries) && entries > 0 ? Math.floor(entries) : 0;
  if (total === 0) return "";
  const max = Math.max(
    1,
    Math.floor(options?.maxNodes ?? MAX_NODES) || MAX_NODES,
  );
  const drawn = Math.min(total, max);
  const verified = options?.verified !== false;
  const nodes: string[] = [];
  for (let index = 0; index < drawn; index += 1) {
    const last = index === drawn - 1;
    nodes.push(!verified && last ? FAILED_NODE : NODE);
  }
  const chain = nodes.join(LINK);
  const hidden = total - drawn;
  return hidden > 0 ? `${chain}${LINK}…+${hidden}` : chain;
}

/**
 * One chain status row. The word carries the verdict; the glyphs carry the
 * shape. A chain with no entries says so rather than drawing nothing, because
 * an empty row reads as a rendering failure and not as "nothing was signed".
 *
 * `verified` describes the entries that were drawn. A workspace whose chain
 * failed contributes no entries at all, so it is counted separately and never
 * turns the drawn, verified entries into a broken chain.
 */
export function chainStatusLine(view: ChainView, width: number): string {
  const label = sanitizeText(view.label);
  const entries =
    Number.isFinite(view.entries) && view.entries > 0
      ? Math.floor(view.entries)
      : 0;
  const failed = Math.max(0, Math.floor(view.failedWorkspaces ?? 0));
  const parts: string[] = [];
  if (entries > 0) {
    const glyphs = chainGlyphs(entries, { verified: view.verified });
    parts.push(`${label} ${glyphs} ${entries} signed`);
    parts.push(view.verified ? "verified" : "DEGRADED");
  } else if (failed > 0) {
    parts.push(`${label} ${FAILED_NODE} DEGRADED · no verified entries`);
  } else {
    parts.push(`${label} no entries · no chain`);
  }
  if (failed > 0)
    parts.push(
      `${failed} workspace${failed === 1 ? "" : "s"} DEGRADED`,
    );
  return fit(sanitizeText(parts.join(" · ")), width);
}

/**
 * The chain rows for the CHAIN STATUS summary, plus the exact failure text
 * under a degraded chain. The reason is printed in full: "1 issue" does not
 * tell an operator that recovery cannot be trusted, and a truncated reason
 * can hide which workspace it belongs to.
 */
export function ledgerChainLines(
  managed: ChainView,
  proxy: ChainView,
  width: number,
): string[] {
  const lines = [
    chainStatusLine(managed, width),
    chainStatusLine(proxy, width),
  ];
  const reasons = [managed, proxy]
    .filter(
      (view) =>
        !view.verified &&
        typeof view.reason === "string" &&
        view.reason.trim() !== "",
    )
    .map(
      (view) =>
        `${view.label} degraded: ${sanitizeText(view.reason!.trim())}`,
    );
  return [...lines, ...reasons];
}

/** What each group of ledger rows is evidence of. Signed entries are the
 * record itself; everything below them was computed from it afterwards. */
const GROUP_NOTE: Record<string, string> = {
  verification: "chain check",
  entry: "signed evidence",
  proxy: "proxy evidence",
  learned: "derived, not evidence",
  score: "descriptive only",
};

/**
 * The heading above a run of rows of one kind. The note is what keeps the
 * signed section and the derived section distinct in a monochrome terminal:
 * a glyph difference alone would be lost, and both sections print numbers.
 */
export function ledgerGroupHeading(input: {
  readonly kind: string;
  readonly title: string;
  readonly icon: string;
  readonly count: number;
}): string {
  const note = GROUP_NOTE[input.kind];
  const head = `${input.icon} ${sanitizeText(input.title)} · ${input.count}`;
  return note === undefined ? head : `${head} · ${note}`;
}

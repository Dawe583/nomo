/**
 * Pending prompt proposals, as rows on the ledger tab.
 *
 * A proposal the model made and no operator decided yet: the exact diff
 * (title, content, reason per edit), the chain sequences it rests on, and the
 * digest an approval must name. Nothing here approves anything by being
 * shown; activation happens only through an explicit approve carrying the
 * exact digest, and the row says so.
 */
import {
  pendingProposalsFromEntries,
  type RefinementEdit,
} from "../../../workbench/src/refine-pass.ts";

type Entry = { readonly seq: number; readonly body: unknown };

export type ProposalRow = {
  readonly id: string;
  readonly label: string;
  readonly lines: string[];
  readonly digest: string;
};

const editLines = (edit: RefinementEdit): string[] => [
  `Edit [${edit.kind}] ${edit.action}: ${edit.title ?? edit.id ?? "(untitled)"}`,
  `  Content: ${edit.content ?? "(none)"}`,
  `  Reason: ${edit.reason}`,
  `  Provenance: chain seq ${edit.derivedFromSeq.join(", ")}`,
];

export function harnessProposalRows(
  proofs: ReadonlyMap<string, readonly Entry[]>,
): readonly ProposalRow[] {
  const rows: ProposalRow[] = [];
  for (const [sessionId, entries] of proofs) {
    for (const pending of pendingProposalsFromEntries(entries)) {
      const lines: string[] = [
        "PROPOSAL awaiting operator decision. Showing it approves nothing.",
        `Digest: ${pending.digest}`,
        `Summary: ${pending.proposal.summary}`,
        `Rationale: ${pending.proposal.rationale}`,
        `Expected outcome: ${pending.proposal.expectedOutcome}`,
        "",
        ...pending.proposal.edits.flatMap(editLines),
        "",
        `/refine approve ${pending.digest} approves exactly this text.`,
        `/refine reject ${pending.digest} [reason] refuses it on the record.`,
      ];
      rows.push({
        id: `proposal:${sessionId}:${pending.digest}`,
        label: `proposal ${sessionId.slice(0, 8)} ${pending.proposal.summary.slice(0, 40)}`,
        lines,
        digest: pending.digest,
      });
    }
  }
  return rows;
}

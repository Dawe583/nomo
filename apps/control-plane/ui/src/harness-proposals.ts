/**
 * The harness proposal as the operator reads it.
 *
 * Pure, so the operator's view of a proposal is testable without a browser:
 * a field that is silently dropped here is a field the operator never saw
 * and never approved. The component that renders it lives in
 * `harness-proposals.tsx`, because a component cannot be imported by the
 * node test runner.
 */
export type ProposalEditView = {
  readonly action: string;
  readonly kind: string;
  readonly id: string;
  readonly title: string;
  readonly body: string;
  /** A prompt edit carries an addendum, not content. */
  readonly prompt: boolean;
  readonly reason: string;
  readonly records: string;
};

/**
 * The edits of a proposal, in the shape the panel reads them.
 *
 * Pure, so the operator's view of the proposal is testable without a
 * browser: a field that is silently dropped here is a field the operator
 * never saw.
 */
export function proposalEdits(proposal: Row | undefined): ProposalEditView[] {
  const edits = Array.isArray(proposal?.edits) ? proposal.edits : [];
  return edits.map((item) => {
    const edit = (item ?? {}) as Row;
    const prompt = edit.kind === "prompt";
    const body =
      typeof edit.content === "string" && edit.content
        ? edit.content
        : typeof edit.promptAddendum === "string"
          ? edit.promptAddendum
          : "";
    const records = Array.isArray(edit.derivedFromSeq)
      ? edit.derivedFromSeq.map((seq) => String(seq)).join(", ")
      : "";
    return {
      action: typeof edit.action === "string" ? edit.action : "",
      kind: typeof edit.kind === "string" ? edit.kind : "",
      id: typeof edit.id === "string" ? edit.id : "",
      title: typeof edit.title === "string" ? edit.title : "",
      body,
      prompt,
      reason: typeof edit.reason === "string" ? edit.reason : "",
      records,
    };
  });
}

import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { api, type Row } from "./api";
import { Dialog, ErrorBox, useApi, useText } from "./ui";
import { proposalEdits } from "./harness-proposals";

/**
 * The harness proposals of this conversation, and the decision.
 *
 * The harness proposes and the operator decides, and the decision binds to
 * the exact digest the operator was shown. The panel therefore shows the
 * proposal the digest covers, not a summary of it: a summary is exactly the
 * thing the operator cannot check, and an approval of a summary is an
 * approval of something nobody read.
 *
 * The server stays the authority. A refusal from it is shown as its own
 * sentence, because a second decision on a proposal the server has already
 * settled is a conflict and not a quiet no-op.
 */
export function HarnessProposals({ sessionId }: { sessionId?: string }) {
  const t = useText(),
    client = useQueryClient();
  const [open, setOpen] = useState<Row>();
  const [busy, setBusy] = useState(false),
    [error, setError] = useState<unknown>(),
    [reason, setReason] = useState("");
  const path = "/api/sessions/" + sessionId + "/harness/proposals";
  const query = useApi(path, !!sessionId, 5000);
  const proposals = Array.isArray(query.data?.proposals)
    ? (query.data.proposals as Row[])
    : [];
  if (!sessionId || !proposals.length) return null;

  async function decide(digest: string, action: "approve" | "reject") {
    if (action === "reject" && !reason.trim()) {
      setError(
        t(
          "Zamítnutí vyžaduje krátký důvod pro auditní záznam.",
          "Denials require a short reason for the audit record.",
        ),
      );
      return;
    }
    setBusy(true);
    setError(undefined);
    try {
      await api(
        path + "/" + digest + "/" + action,
        "POST",
        action === "reject" ? { reason } : undefined,
      );
      setOpen(undefined);
      setReason("");
      await client.invalidateQueries({ queryKey: [path] });
    } catch (failure) {
      // The server's own sentence, kept whole: a conflict is a conflict, and
      // the operator has to read why.
      setError(failure);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      {proposals.map((proposal) => (
        <div className="inline-approval" key={proposal.digest}>
          <span>
            {t("Harness navrhuje změnu", "The harness proposes a change")}:{" "}
            <strong>{proposal.summary}</strong>
          </span>
          <button onClick={() => setOpen(proposal)}>
            {t("Zkontrolovat a rozhodnout", "Review and decide")}
          </button>
        </div>
      ))}
      {open && (
        <Dialog
          title={t("Návrh harnesse", "Harness proposal")}
          close={() => setOpen(undefined)}
        >
          <p className="muted">
            {t(
              "Rozhodnutí se váže na tento přesný digest:",
              "The decision binds to this exact digest:",
            )}{" "}
            <code>{open.digest}</code>
          </p>
          {open.rationale && <p className="approval-rationale">{open.rationale}</p>}
          {open.expectedOutcome && (
            <p className="muted">
              {t("Očekávaný výsledek", "Expected outcome")}: {open.expectedOutcome}
            </p>
          )}
          {proposalEdits(open.proposal).map((edit, index) => (
            <div className="approval-card" key={edit.id || index}>
              <div className="approval-card-head">
                <strong>
                  {t("Úprava", "Edit")}: {edit.action} {edit.kind}
                </strong>
              </div>
              {edit.id && (
                <p className="muted">
                  {t("položka", "entry")} {edit.id}
                </p>
              )}
              {edit.title && <p>{edit.title}</p>}
              {edit.body && (
                <p className="approval-rationale">
                  {edit.prompt
                    ? t("Dodatek ke(instrukci", "Addendum to the instruction")
                    : t("Obsah", "Content")}
                  : {edit.body}
                </p>
              )}
              {edit.reason && (
                <p className="muted">
                  {t("proč", "why")}: {edit.reason}
                </p>
              )}
              {edit.records && (
                <p className="muted">
                  {t("odvozeno ze záznamů", "derived from records")}: {edit.records}
                </p>
              )}
            </div>
          ))}
          <label className="muted" htmlFor="harness-reject-reason">
            {t("Důvod zamítnutí", "Reason for rejection")}
          </label>
          <input
            id="harness-reject-reason"
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            placeholder={t(
              "Proč tento návrh neplatí",
              "Why this proposal does not hold",
            )}
          />
          <ErrorBox error={error} />
          <div className="toolbar" role="group" aria-label={t("Rozhodnutí", "Decision")}>
            <button
              disabled={busy}
              onClick={() => void decide(open.digest, "approve")}
            >
              {t("Schválit", "Approve")}
            </button>
            <button
              disabled={busy}
              onClick={() => void decide(open.digest, "reject")}
            >
              {t("Zamítnout", "Reject")}
            </button>
          </div>
        </Dialog>
      )}
    </>
  );
}

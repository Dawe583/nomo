import { useState, useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { api, ApiError, type Row } from "./api";
import { Badge, Dialog, ErrorBox, JsonDetail, useText } from "./ui";
import { blastSummary, plainAction } from "./approval-text";

/**
 * Detail schválení (B1). Napojeno na server jako autoritu: jedno rozhodnutí je
 * jeden zápis, pozdní/druhé rozhodnutí server odmítne (409) a UI ukáže
 * konflikt místo tichého zdvojení. Zamítnutí vyžaduje důvod.
 */
export function ApprovalReview({
  record,
  close,
}: {
  record: Row;
  close: () => void;
}) {
  const t = useText(),
    client = useQueryClient();
  const [busy, setBusy] = useState(false),
    [error, setError] = useState<unknown>(),
    [conflict, setConflict] = useState<string>(),
    [note, setNote] = useState(""),
    [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const expired = new Date(record.expiresAt).getTime() <= now;
  const settled = record.status !== "pending";
  const blocked = busy || expired || settled || !!conflict;

  async function decide(kind: "approved" | "denied") {
    if (kind === "denied" && !note.trim()) {
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
        "/api/approvals/" + encodeURIComponent(record.holdId) + "/decision",
        "POST",
        {
          kind,
          by: "control-plane",
          ...(note.trim() ? { reason: note.trim().slice(0, 500) } : {}),
        },
      );
      await client.invalidateQueries();
      close();
    } catch (e) {
      // Druhé rozhodnutí ke stejnému holdu = jeden commit, druhý vidí konflikt.
      if (
        (e instanceof ApiError && (e.status === 409 || e.status === 404)) ||
        /already resolved|expired|not found|Hold already/i.test(
          e instanceof Error ? e.message : String(e),
        )
      ) {
        setConflict(
          t(
            "Toto schválení již bylo rozhodnuto jinde nebo vypršelo. Žádný druhý zápis se neprovedl — obnovte seznam.",
            "This approval was already decided elsewhere or expired. No second write was made — refresh the list.",
          ),
        );
        await client.invalidateQueries();
      } else {
        setError(e);
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      title={record.call?.tool ?? t("Rozhodnutí", "Decision")}
      close={close}
    >
      <Badge
        value={
          expired && record.status === "pending" ? "expired" : record.status
        }
      />
      <p className="approval-plain">
        <strong>{plainAction(record)}</strong>
      </p>
      <div className="approval-facts">
        <span>
          {t("Třída", "Class")}:{" "}
          <strong>{record.call?.klass ?? record.klass ?? "unknown"}</strong>
        </span>
        <span>
          {t("Workspace", "Workspace")}: {record.call?.workspace ?? "unknown"}
        </span>
        <span>
          {t("Rozsah", "Blast radius")}: {blastSummary(record)}
        </span>
      </div>
      <p className="approval-rationale">
        <strong>{t("Důvod politiky", "Policy rationale")}:</strong>{" "}
        {record.reason ??
          record.rationale ??
          record.call?.rule ??
          t(
            "Server důvod neposkytl.",
            "The server did not provide a rationale.",
          )}
      </p>
      {(settled || conflict) && (
        <p className="notice" role="alert">
          {conflict ??
            t(
              "Záznam již není čekající. Další rozhodnutí se neodesílá, aby nevznikl dvojí zápis.",
              "This record is no longer pending. No further decision is sent, so no duplicate write occurs.",
            )}
        </p>
      )}
      {expired && !settled && (
        <p className="notice" role="status">
          {t(
            "Expirace rozhoduje server. Pozdní rozhodnutí server odmítne.",
            "Expiry is decided by the server. A late decision is rejected by the server.",
          )}
        </p>
      )}
      <label>
        {t("Důvod zamítnutí (povinný při zamítnutí)", "Denial reason (required to deny)")}
        <textarea
          rows={3}
          maxLength={500}
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder={t(
            "Např. maže produkční tabulku bez zálohy.",
            "E.g. deletes a production table without backup.",
          )}
        />
      </label>
      <JsonDetail value={record} />
      <ErrorBox error={error} />
      <div className="actions">
        <button
          className="primary"
          disabled={blocked}
          onClick={() => void decide("approved")}
        >
          {t("Schválit", "Approve")}
        </button>
        <button disabled={blocked} onClick={() => void decide("denied")}>
          {t("Zamítnout", "Deny")}
        </button>
      </div>
    </Dialog>
  );
}

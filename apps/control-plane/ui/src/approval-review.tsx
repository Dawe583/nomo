import { useState, useEffect, useMemo } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { api, ApiError, type Row } from "./api";
import { Badge, Dialog, ErrorBox, RedactedJson, useText } from "./ui";
import { blastSummary, plainAction } from "./approval-text";
import {
  diffLines,
  extractBeforeAfter,
  requiresConfirm,
} from "./approval-diff";

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
  const binding = record.binding as Row | undefined;
  const fullIdentityBinding =
    binding !== undefined &&
    [
      "principalId",
      "agentId",
      "runId",
      "workspaceId",
      "upstreamId",
      "schemaDigest",
    ].every(
      (key) => typeof binding[key] === "string" && binding[key] !== "",
    );
  // B2: R3 and unknown holds arm first and confirm second. The server stays
  // authoritative; this only slows the hand on destructive approvals.
  const gate = requiresConfirm(record);
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    if (!armed) return;
    const timer = setTimeout(() => setArmed(false), 8000);
    return () => clearTimeout(timer);
  }, [armed]);
  // B1: before and after images come from the record only. An absent before
  // image renders as unknown, never as an invented baseline.
  const change = useMemo(() => extractBeforeAfter(record), [record]);
  const changeLines = useMemo(
    () =>
      change.empty || change.beforeMissing
        ? []
        : diffLines(change.before, change.after),
    [change],
  );
  const blocked = busy || expired || settled || !!conflict;

  function approve() {
    if (gate && !armed) {
      setArmed(true);
      return;
    }
    setArmed(false);
    void decide("approved");
  }

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
          // The hold identifier is derived from public session counters, so a
          // decision also has to present the token minted with the hold.
          token: record.decisionToken,
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
      <section className="approval-operation" aria-label={t("Souhrn operace", "Operation summary")}>
        <h3>{t("Cílová operace", "Target operation")}</h3>
        <p>{t("Redigovaný souhrn argumentů", "Redacted argument summary")}</p>
        <code>{record.operationSummary ?? t("Bezpečný souhrn není dostupný.", "No safe summary is available.")}</code>
      </section>
      {binding ? (
        <section className="approval-binding" aria-label={t("Kontext schválení", "Approval context")}>
          <h3>{t("Kontext schválení", "Approval context")}</h3>
          <dl>
            {[
              [t("Profil operace", "Operation profile"), binding.operationId],
              [t("Digest operace", "Operation digest"), binding.operationDigest],
              [t("Verze politiky", "Policy version"), binding.policyVersion],
              [t("Digest politiky", "Policy digest"), binding.policyDigest],
              [t("Účet OS procesu", "Local process OS account"), binding.operatorId],
              [t("Principal", "Principal"), binding.principalId],
              [t("Agent", "Agent"), binding.agentId],
              [t("Běh", "Run"), binding.runId],
              [t("Workspace", "Workspace"), binding.workspaceId],
              [t("Upstream", "Upstream"), binding.upstreamId],
              [t("Digest schématu", "Schema digest"), binding.schemaDigest],
            ].map(([label, value]) => (
              <div key={String(label)}>
                <dt>{label}</dt>
                <dd><code>{String(value ?? "unknown")}</code></dd>
              </div>
            ))}
          </dl>
          {!fullIdentityBinding && (
            <p className="notice" role="status">
              {t(
                "Toto schválení Workbenche váže operaci, politiku, běh, pracovní prostor a účet OS procesu. Neobsahuje ověřený principal, agenta, upstream ani schéma. Tyto chybějící údaje se nepovažují za ověřené.",
                "This Workbench approval binds the operation, policy, run, workspace, and process OS account. It does not bind a verified principal, agent, upstream, or schema. Missing context is not treated as verified.",
              )}
            </p>
          )}
          <p className="notice" role="status">
            {t(
              "Toto ID je účet OS místního procesu NOMO. Kontrola loopbacku a Origin neověřuje volajícího. Bez sdíleného control tokenu může rozhodnutí odeslat každý místní proces, který dosáhne portu.",
              "This is the local NOMO process OS account. Loopback and Origin checks do not authenticate the caller. Without a shared control token, any local process that can reach the port may submit a decision.",
            )}
          </p>
        </section>
      ) : (
        <p className="notice" role="status">
          {t("Toto schválení nemá vazbu identity. Neověřujte je jako schválení konkrétní identity.", "This approval has no identity binding. Do not treat it as an identity-bound approval.")}
        </p>
      )}
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
      <section className="approval-diff" aria-label={t("Změna", "Change")}>
        <h3>{t("Navrhovaná změna", "Proposed change")}</h3>
        {change.empty ? (
          <p className="muted">
            {t(
              "Server k tomuto schválení neposlal žádný předchozí ani navrhovaný stav. Rozhodněte podle nástroje, třídy a rozsahu výše.",
              "The server sent no before or proposed state for this approval. Decide from the tool, class and blast radius above.",
            )}
          </p>
        ) : change.beforeMissing ? (
          <>
            <p className="notice" role="status">
              {t(
                "Předchozí stav server neposkytl, nelze porovnat. Níže je navrhované volání.",
                "The server provided no before image, so there is nothing to compare. The proposed call is below.",
              )}
            </p>
            <RedactedJson value={change.after} />
          </>
        ) : (
          <div className="diff">
            <pre aria-label={t("Porovnání", "Comparison")}>
              {changeLines.map((line, index) => (
                <span
                  key={index}
                  className={
                    line.kind === "add"
                      ? "added"
                      : line.kind === "del"
                        ? "removed"
                        : undefined
                  }
                >
                  {line.kind === "add" ? "+" : line.kind === "del" ? "-" : " "}
                  {line.text}
                </span>
              ))}
            </pre>
          </div>
        )}
      </section>
      <details>
        <summary>
          {t("Úplný záznam (tajemství maskována)", "Full record (secrets masked)")}
        </summary>
        <RedactedJson value={record} />
      </details>
      <ErrorBox error={error} />
      <div className="actions">
        <button
          className="primary"
          disabled={blocked}
          data-armed={gate && armed ? "true" : undefined}
          aria-describedby={gate ? "approve-gate-hint" : undefined}
          onClick={approve}
        >
          {gate && !armed
            ? t("Schválit (potvrdit)", "Approve (confirm)")
            : gate && armed
              ? t("Potvrdit schválení", "Confirm approval")
              : t("Schválit", "Approve")}
        </button>
        <button disabled={blocked} onClick={() => void decide("denied")}>
          {t("Zamítnout", "Deny")}
        </button>
      </div>
      {gate && !settled && (
        <p id="approve-gate-hint" className="muted" role="status">
          {armed
            ? t(
                "Destruktivní schválení: stiskněte znovu do 8 sekund. Jinak vyprší.",
                "Destructive approval: press again within 8 seconds. Otherwise it lapses.",
              )
            : t(
                "Destruktivní nebo neznámá třída: schválení vyžaduje druhé potvrzení.",
                "Destructive or unknown class: approval needs a second confirmation.",
              )}
        </p>
      )}
    </Dialog>
  );
}

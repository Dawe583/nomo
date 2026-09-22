import { useEffect, useReducer, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { api } from "./api";
import { Dialog, ErrorBox, RedactedJson, useText } from "./ui";
import {
  recoveryApplyBody,
  recoveryReview,
  type RecoveryPlan,
} from "./recovery-review";
import type { DocumentOperation } from "./document-history";

export function RecoveryReview({
  sessionId,
  operationIds,
  operations,
  close,
}: {
  sessionId: string;
  operationIds: string[];
  operations: DocumentOperation[];
  close: () => void;
}) {
  const t = useText(),
    client = useQueryClient();
  const [selection] = useState(() => ({
    kind: "operations",
    operationIds: [...operationIds],
  }));
  const [labels] = useState(
    () =>
      new Map(operations.map((operation) => [operation.id, operation.path])),
  );
  const [jobId, setJobId] = useState(() => crypto.randomUUID());
  const [review, dispatch] = useReducer(recoveryReview, { phase: "planning" });
  const [error, setError] = useState<unknown>(),
    [checking, setChecking] = useState(false);
  const submitting = useRef(false);
  const base =
    "/api/sessions/" + encodeURIComponent(sessionId) + "/recovery-jobs";
  useEffect(() => {
    let active = true;
    // Focus and query invalidation must never replace an operator's review.
    api(base + "/plan", "POST", { jobId, selection })
      .then((response) => {
        if (!active) return;
        if (
          response.jobId !== jobId ||
          typeof response.planDigest !== "string" ||
          !Array.isArray(response.steps) ||
          !Array.isArray(response.residuals)
        )
          throw new Error("Invalid recovery plan response.");
        dispatch({ type: "planned", plan: response as RecoveryPlan });
      })
      .catch((error) => {
        if (active) {
          setError(error);
          dispatch({ type: "failed" });
        }
      });
    return () => {
      active = false;
    };
  }, [base, jobId, selection]);
  async function apply() {
    const body = recoveryApplyBody(review);
    if (!body || submitting.current) return;
    submitting.current = true;
    dispatch({ type: "applying" });
    setError(undefined);
    try {
      const result = await api(base + "/apply", "POST", body);
      dispatch({ type: "observed", result });
      await client.invalidateQueries();
    } catch (error) {
      setError(error);
      dispatch({ type: "failed" });
    } finally {
      submitting.current = false;
    }
  }
  async function observe() {
    if (checking) return;
    setChecking(true);
    setError(undefined);
    try {
      dispatch({
        type: "observed",
        result: await api(base + "/" + encodeURIComponent(jobId)),
      });
    } catch (error) {
      setError(error);
    } finally {
      setChecking(false);
    }
  }
  const busy = review.phase === "applying" || checking;
  return (
    <Dialog
      title={t("Plán obnovy", "Recovery plan")}
      close={() => {
        if (!busy) close();
      }}
    >
      <div className="recovery-review">
        <p>
          {t(
            "Náhled se nemění bez výslovného obnovení. Server před provedením znovu ověří zdroje, revize a policy.",
            "The preview stays fixed until you explicitly refresh it. The server rechecks resources, revisions and policy before applying it.",
          )}
        </p>
        <ErrorBox error={error} />
        <p>
          <code>{jobId}</code>
        </p>
        {review.phase === "planning" && (
          <p role="status">{t("Připravuji náhled…", "Preparing preview…")}</p>
        )}
        {review.plan && (
          <>
            <p>
              {t("Digest schvalovaného plánu", "Reviewed plan digest")}:{" "}
              <code>{review.plan.planDigest}</code>
            </p>
            <ol>
              {review.plan.steps.map((step) => (
                <li key={step.operationId}>
                  <strong>
                    {labels.get(step.operationId) ?? step.operationId}
                  </strong>
                  <p>
                    <code>{step.operationId}</code> · {t("Pořadí", "Sequence")}:{" "}
                    {step.sequence}
                  </p>
                  {step.resources?.map((resource) => (
                    <p key={resource}>
                      <code>{resource}</code>
                    </p>
                  ))}
                  {step.scope && (
                    <p>
                      {t("Rozsah", "Scope")}: {step.scope}
                    </p>
                  )}
                </li>
              ))}
            </ol>
            {!review.plan.steps.length && (
              <p>
                {t(
                  "Žádné proveditelné kroky obnovy.",
                  "No executable recovery steps.",
                )}
              </p>
            )}
            {!!review.plan.residuals.length && (
              <>
                <h3>
                  {t(
                    "Nevrácené nebo nejisté operace",
                    "Residual or uncertain operations",
                  )}
                </h3>
                <ul>
                  {review.plan.residuals.map((row) => (
                    <li key={row.operationId}>
                      {labels.get(row.operationId) ?? row.operationId}:{" "}
                      {row.status}
                    </li>
                  ))}
                </ul>
              </>
            )}
            <details>
              <summary>
                {t("Hranice a výběr plánu", "Plan boundary and selection")}
              </summary>
              <RedactedJson
                value={{
                  boundary: review.plan.boundary,
                  selection: review.plan.selection,
                }}
              />
            </details>
          </>
        )}
        {review.phase === "applying" && (
          <p role="status">
            {t(
              "Obnova probíhá. Požadavek se znovu neodesílá.",
              "Recovery is running. The request will not repeat.",
            )}
          </p>
        )}
        {review.phase === "blocked" && (
          <p className="notice" role="status">
            {t(
              "Plán nelze znovu potvrdit. Ověřte stav úlohy a před novým potvrzením výslovně obnovte náhled.",
              "This plan cannot be confirmed again. Check job status and explicitly refresh the preview before a new confirmation.",
            )}
          </p>
        )}
        {review.result && (
          <section>
            <h3>
              {t("Stav úlohy", "Job status")}:{" "}
              {String(
                review.result.status ??
                  t("Výsledek nepotvrzen", "Outcome unconfirmed"),
              )}
            </h3>
            <RedactedJson value={review.result} />
            <p>
              {t(
                "Konflikt nebo neznámý výsledek se automaticky neopakuje. Evidence zůstává zachovaná.",
                "A conflict or unknown outcome never automatically retries. Evidence remains preserved.",
              )}
            </p>
          </section>
        )}
        <div className="actions">
          <button
            className="primary"
            disabled={busy || !recoveryApplyBody(review)}
            onClick={() => void apply()}
          >
            {t("Schválit a provést tento plán", "Approve and apply this plan")}
          </button>
          <button
            disabled={busy || review.phase === "planning"}
            onClick={() => {
              setError(undefined);
              dispatch({ type: "refresh" });
              setJobId(crypto.randomUUID());
            }}
          >
            {t("Obnovit náhled", "Refresh preview")}
          </button>
          <button
            disabled={busy || review.phase === "planning" || review.phase === "ready"}
            onClick={() => void observe()}
          >
            {t("Ověřit stav úlohy", "Check job status")}
          </button>
        </div>
      </div>
    </Dialog>
  );
}

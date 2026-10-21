import { useState } from "react";
import { api, type Row } from "./api";
import { ErrorBox, useApi, useText } from "./ui";
import { harnessEntries } from "./harness-entries";

/**
 * What the harness holds for this conversation.
 *
 * The proposal list is the inbox, and this is the shelf: the entries the
 * harness reads on every future turn, with the text the operator approved by
 * digest, the tool and class the lesson is about, and the records it was
 * mined from. A mined lesson and an operator-approved one are shown apart,
 * because the difference is the difference between a pattern the harness
 * noticed and a rule a human wrote.
 */
export function HarnessEntries({ sessionId }: { sessionId?: string }) {
  const t = useText();
  const [open, setOpen] = useState(false);
  const path = "/api/sessions/" + sessionId + "/harness/entries";
  const query = useApi(path, !!sessionId, 15000);
  const entries = harnessEntries(query.data);
  if (!sessionId || !entries.length) return null;
  return (
    <>
      <div className="inline-approval" role="group" aria-label={t("Harnesse", "Harness")}>
        <span>
          {t("Harness drží", "The harness holds")} {entries.length}{" "}
          {t("záznamů", "entries")}.
        </span>
        <button onClick={() => setOpen((value) => !value)}>
          {open
            ? t("Skrýt", "Hide")
            : t("Co harness drží", "What the harness holds")}
        </button>
      </div>
      {open && (
        <div className="approval-card">
          {entries.map((entry) => (
            <div className="approval-card-head" key={entry.id}>
              <strong>
                {entry.title || entry.id}{" "}
                {entry.decidedByOperator
                  ? t("(operátor schválil)", "(operator approved)")
                  : t("(vzorek, který harness všiml)", "(mined pattern)")}
              </strong>
              {entry.tool && (
                <span className="muted">
                  {" "}
                  {entry.tool} {entry.klass}
                </span>
              )}
              {entry.ruleDecision && (
                <p className="muted">
                  {t("navrhuje pravidlo", "proposes a rule")}: {entry.ruleDecision}
                  {entry.ruleSeconds > 0 ? ` ${entry.ruleSeconds}s` : ""}
                </p>
              )}
              <p className="approval-rationale">{entry.content}</p>
              {entry.derivedFromSeq.length > 0 && (
                <p className="muted">
                  {t("odvozeno ze záznamů", "derived from records")}:{" "}
                  {entry.derivedFromSeq.join(", ")}
                </p>
              )}
            </div>
          ))}
        </div>
      )}
    </>
  );
}

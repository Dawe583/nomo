import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { api, type Row } from "./api";
import { ErrorBox, useText } from "./ui";
import {
  compactionResult,
  runBlocksInput,
  type CompactionResult,
} from "./workspace-state";

export function SessionContext({
  session,
  events,
  supported,
}: {
  session: Row;
  events: Row[];
  supported: boolean;
}) {
  const t = useText(),
    client = useQueryClient();
  const [busy, setBusy] = useState(false),
    [error, setError] = useState<unknown>(),
    [result, setResult] = useState<CompactionResult | null>(null);
  const last = [...events]
    .reverse()
    .find((event) => event.type === "context.compacted");
  const retained =
    result ??
    compactionResult(session) ??
    (last?.payload ? compactionResult(last.payload) : null);
  async function compact() {
    if (busy || !supported || runBlocksInput(session)) return;
    setBusy(true);
    setError(undefined);
    try {
      const response = await api(
        "/api/sessions/" + encodeURIComponent(session.id) + "/compact",
        "POST",
      );
      const value = compactionResult(response);
      if (!value)
        throw new Error(
          t(
            "Server nevrátil metadata kompakce. Obnovte konverzaci.",
            "The server did not return compaction metadata. Refresh the conversation.",
          ),
        );
      setResult(value);
      await client.invalidateQueries();
    } catch (error) {
      setError(error);
    } finally {
      setBusy(false);
    }
  }
  return (
    <details className="session-context">
      <summary>{t("Kontext konverzace", "Conversation context")}</summary>
      <p className="muted">
        {t(
          "Sbalení mění pouze kontext dalšího modelového tahu. Podepsaný ledger zůstává zachován.",
          "Compaction changes only the context of the next model turn. The signed ledger remains unchanged.",
        )}
      </p>
      {supported ? (
        <button
          type="button"
          disabled={busy || runBlocksInput(session)}
          onClick={() => void compact()}
        >
          {busy
            ? t("Sbaluji…", "Compacting…")
            : t("Sbalit kontext", "Compact context")}
        </button>
      ) : (
        <p>
          {t(
            "Tento host nepodporuje sbalení kontextu.",
            "This host does not support context compaction.",
          )}
        </p>
      )}
      <ErrorBox error={error} />
      {retained ? (
        <div role="status">
          <p>
            {t("Vynechané zprávy", "Omitted messages")}:{" "}
            {retained.omittedMessageCount}.{" "}
            {t("Zachované zprávy", "Retained messages")}:{" "}
            {retained.retainedMessageIds.length}.
          </p>
          <time dateTime={retained.createdAt}>
            {new Date(retained.createdAt).toLocaleString()}
          </time>
          <details>
            <summary>
              {t("Shrnutí a zachované ID", "Summary and retained IDs")}
            </summary>
            <pre className="json">
              {retained.summary ||
                t(
                  "Žádné zprávy nebyly vynechány.",
                  "No messages were omitted.",
                )}
            </pre>
            <ul>
              {retained.retainedMessageIds.map((id) => (
                <li key={id}>
                  <code>{id}</code>
                </li>
              ))}
            </ul>
          </details>
        </div>
      ) : (
        <p>
          {t(
            "Žádná zaznamenaná kompakce. Počet tokenů kontextu je neznámý.",
            "No recorded compaction. Context token count is unknown.",
          )}
        </p>
      )}
    </details>
  );
}

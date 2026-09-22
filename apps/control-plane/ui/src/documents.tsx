import { useEffect, useRef, useState } from "react";
import { RecoveryReview } from "./recovery-dialog";
import { useQueryClient } from "@tanstack/react-query";
import { api, download, type Row } from "./api";
import { DataTable, Dialog, Empty, ErrorBox, useApi, useText } from "./ui";
import { RichText } from "./chat";
import {
  documentHistory,
  documentContentState,
  type DocumentOperation,
} from "./document-history";
export function Documents({
  sessionId,
  initialPath,
}: {
  sessionId?: string;
  initialPath?: string;
  navigate?: (path: string) => void;
  appearance?: string;
  setAppearance?: (s: string) => void;
  locale?: "cs" | "en";
  setLocale?: (s: "cs" | "en") => void;
}) {
  const t = useText();
  const [selected, setSelected] = useState<Row | undefined>(() => {
    const params = new URLSearchParams(location.search);
    const path = initialPath ?? params.get("document");
    const id = sessionId ?? params.get("documentSession");
    return path && id ? { path, sessionId: id } : undefined;
  });
  return (
    <div className="documents">
      {sessionId && <DocumentHistory key={sessionId} sessionId={sessionId} />}
      <DataTable
        endpoint={
          "/api/documents" +
          (sessionId ? "?sessionId=" + encodeURIComponent(sessionId) : "")
        }
        columns={[
          { key: "path", label: t("Dokument", "Document") },
          { key: "bytes", label: t("Velikost", "Size") },
          { key: "revision", label: t("Revize", "Revision") },
          { key: "updatedAt", label: t("Změněno", "Updated") },
          { key: "sessionId", label: t("Konverzace", "Conversation") },
        ]}
        onRow={(row) => {
          setSelected(row);
          const url = new URL(location.href);
          url.searchParams.set("document", row.path);
          url.searchParams.set("documentSession", row.sessionId);
          window.history.replaceState(window.history.state, "", url);
        }}
      />
      {selected && (
        <DocumentEditor
          selected={selected}
          close={() => {
            setSelected(undefined);
            const url = new URL(location.href);
            url.searchParams.delete("document");
            url.searchParams.delete("documentSession");
            window.history.replaceState(window.history.state, "", url);
          }}
        />
      )}
    </div>
  );
}
function DocumentHistory({ sessionId }: { sessionId: string }) {
  const t = useText();
  const query = useApi(
    "/api/sessions/" + encodeURIComponent(sessionId) + "/workspace",
  );
  const capabilities = useApi("/api/capabilities");
  const [search, setSearch] = useState(""),
    [selected, setSelected] = useState<DocumentOperation>();
  const [selection, setSelection] = useState<string[]>([]), [reviewing, setReviewing] = useState(false);
  const operations = documentHistory<DocumentOperation>(
    query.data?.workspace?.operations ?? [],
    search,
  );
  return (
    <section
      className="document-history"
      aria-label={t("Historie dokumentů", "Document history")}
    >
      <h3>{t("Historie dokumentů", "Document history")}</h3>
      <p className="muted">
        {t(
          "Zachované změny této konverzace včetně smazaných dokumentů. Možnost Undo ověří server v náhledu.",
          "Retained changes in this conversation, including deleted documents. The server checks Undo availability in the preview.",
        )}
      </p>
      <ErrorBox error={query.error ?? capabilities.error} />
      {capabilities.data?.recoveryJobs === true ? <div className="actions">
        <button disabled={!selection.length || query.isPending || !!query.error} onClick={() => setReviewing(true)}>{t("Náhled obnovy vybraných změn", "Preview recovery of selected changes")} ({selection.length})</button>
        <button disabled={!selection.length} onClick={() => setSelection([])}>{t("Zrušit výběr", "Clear selection")}</button>
      </div> : <p className="muted">{t("Obnova více změn není na tomto hostu dostupná.", "Multi-operation recovery is not available on this host.")}</p>}
      <label>
        {t("Hledat cestu nebo ID operace", "Find path or operation ID")}
        <input
          type="search"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
        />
      </label>
      {query.isPending ? (
        <p role="status">{t("Načítání historie…", "Loading history…")}</p>
      ) : operations.length ? (
        <ul className="document-operation-list">
          {operations.map((operation) => (
            <li key={operation.id}>
              {capabilities.data?.recoveryJobs === true && <label>
                <input type="checkbox" checked={selection.includes(operation.id)} onChange={event => setSelection(ids => event.target.checked ? [...ids, operation.id] : ids.filter(id => id !== operation.id))} />
                {t("Vybrat změnu", "Select change")}: {operation.path} <code>{operation.id}</code>
              </label>}
              <button onClick={() => setSelected(operation)}>
                <strong>{operation.path}</strong>
                <span>
                  {operation.kind} ·{" "}
                  {new Date(operation.at).toLocaleString(t("cs-CZ", "en-GB"))}
                </span>
                <span>{t("Zkontrolovat změnu", "Review change")}</span>
              </button>
            </li>
          ))}
        </ul>
      ) : (
        !query.error && (
          <p>
            {search
              ? t("Žádné odpovídající změny.", "No matching changes.")
              : t("Zatím žádné zaznamenané změny.", "No recorded changes yet.")}
          </p>
        )
      )}
      {reviewing && <RecoveryReview sessionId={sessionId} operationIds={selection} operations={query.data?.workspace?.operations ?? []} close={() => setReviewing(false)} />}
      {selected && (
        <OperationReview
          sessionId={sessionId}
          operationId={selected.id}
          path={selected.path}
          close={() => setSelected(undefined)}
        />
      )}
    </section>
  );
}

function OperationReview({
  sessionId,
  operationId,
  path,
  close,
  onRestored,
}: {
  sessionId: string;
  operationId: string;
  path: string;
  close: () => void;
  onRestored?: () => Promise<void>;
}) {
  const t = useText(),
    client = useQueryClient();
  const base = "/api/sessions/" + encodeURIComponent(sessionId);
  const [undo, setUndo] = useState<Row>(),
    [checking, setChecking] = useState(true),
    [previewError, setPreviewError] = useState<unknown>(),
    [reviewVersion, setReviewVersion] = useState(0);
  useEffect(() => {
    let active = true;
    setChecking(true);
    setUndo(undefined);
    setPreviewError(undefined);
    // Operator review must not change under focus, polling or cache invalidation.
    api(base + "/undo/" + encodeURIComponent(operationId))
      .then(
        (result) => {
          if (active) setUndo(result);
        },
        (error) => {
          if (active) setPreviewError(error);
        },
      )
      .finally(() => {
        if (active) setChecking(false);
      });
    return () => {
      active = false;
    };
  }, [base, operationId, reviewVersion]);
  const session = useApi(base + "?events=false");
  const [busy, setBusy] = useState(false),
    [applied, setApplied] = useState(false),
    [error, setError] = useState<unknown>(),
    [failed, setFailed] = useState(false);
  async function apply() {
    if (busy || applied || failed || undo?.canApply !== true || checking)
      return;
    setBusy(true);
    setError(undefined);
    try {
      await api(base + "/undo/" + encodeURIComponent(operationId), "POST", {
        confirm: operationId,
      });
      setApplied(true);
      await client.invalidateQueries();
      await onRestored?.();
    } catch (error) {
      setError(error);
      setFailed(true);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog
      title={t("Vrácení změny: ", "Undo change: ") + path}
      close={() => {
        if (!busy) close();
      }}
    >
      <p className="muted">
        {t("Operace", "Operation")}:{" "}
        <code className="operation-id">{operationId}</code>
      </p>
      <ErrorBox error={error ?? previewError} />
      {checking && (
        <p role="status">{t("Ověřuji náhled…", "Checking preview…")}</p>
      )}
      {applied ? (
        <p role="status">
          {t(
            "Změna byla vrácena. Evidence zůstává zachovaná.",
            "Change reversed. Evidence remains preserved.",
          )}
        </p>
      ) : (
        undo && (
          <>
            <p>
              {undo.reason ??
                t(
                  "Zkontrolujte přesnou změnu před potvrzením.",
                  "Review the exact change before confirming.",
                )}
            </p>
            <Diff before={undo.before} after={undo.after} />
          </>
        )
      )}
      {session.data?.session?.workspace && (
        <a
          className="button"
          aria-disabled={busy}
          tabIndex={busy ? -1 : undefined}
          href={
            busy
              ? undefined
              : "/ledger?workspace=" +
                encodeURIComponent(session.data.session.workspace)
          }
        >
          {t("Ledger této konverzace", "Conversation ledger")}
        </a>
      )}
      <div className="actions">
        {!applied && (
          <button
            className="primary"
            disabled={
              busy ||
              failed ||
              checking ||
              !!previewError ||
              undo?.canApply !== true
            }
            onClick={apply}
          >
            {busy
              ? t("Vracím změnu…", "Applying Undo…")
              : t("Potvrdit Undo", "Confirm Undo")}
          </button>
        )}
        {!applied && (failed || !!previewError) && (
          <button
            disabled={busy || checking}
            onClick={() => {
              setFailed(false);
              setError(undefined);
              setChecking(true);
              setReviewVersion((version) => version + 1);
            }}
          >
            {t("Obnovit náhled", "Refresh preview")}
          </button>
        )}
        <button disabled={busy} onClick={close}>
          {applied ? t("Zavřít", "Close") : t("Zrušit", "Cancel")}
        </button>
      </div>
    </Dialog>
  );
}

function Diff({
  before,
  after,
}: {
  before?: string | null;
  after?: string | null;
}) {
  const t = useText();
  const left = (before ?? "").split("\n"),
    right = (after ?? "").split("\n");
  let prefix = 0,
    suffix = 0;
  while (
    prefix < left.length &&
    prefix < right.length &&
    left[prefix] === right[prefix]
  )
    prefix++;
  while (
    suffix < left.length - prefix &&
    suffix < right.length - prefix &&
    left[left.length - 1 - suffix] === right[right.length - 1 - suffix]
  )
    suffix++;
  return (
    <div className="diff">
      {[
        [
          t("Před změnou", "Before"),
          left,
          "removed",
          documentContentState(before),
        ],
        [t("Po změně", "After"), right, "added", documentContentState(after)],
      ].map(([label, lines, tone, state]) => (
        <section key={String(tone)}>
          <h3>{String(label)}</h3>
          {state === "absent" ? (
            <p>{t("Dokument neexistuje", "Document does not exist")}</p>
          ) : state === "empty" ? (
            <p>{t("Prázdný dokument (0 bajtů)", "Empty document (0 bytes)")}</p>
          ) : state === "unavailable" ? (
            <p>{t("Obsah není dostupný", "Content unavailable")}</p>
          ) : (
            <pre>
              {(lines as string[]).map((line, i) => (
                <span
                  key={i}
                  className={
                    i >= prefix && i < (lines as string[]).length - suffix
                      ? String(tone)
                      : "unchanged"
                  }
                >
                  <span className="line-number">{i + 1}</span>
                  {i >= prefix && i < (lines as string[]).length - suffix
                    ? tone === "removed"
                      ? "− "
                      : "+ "
                    : "  "}
                  {line}
                  {"\n"}
                </span>
              ))}
            </pre>
          )}
        </section>
      ))}
    </div>
  );
}
function DocumentEditor({
  selected,
  close,
}: {
  selected: Row;
  close: () => void;
}) {
  const t = useText(),
    client = useQueryClient();
  const previewTab = useRef<HTMLButtonElement>(null);
  const base = "/api/sessions/" + encodeURIComponent(selected.sessionId);
  const detail = useApi(
    base + "/documents?path=" + encodeURIComponent(selected.path),
  );
  const workspace = useApi(base + "/workspace");
  const document = detail.data?.document;
  const [baseline, setBaseline] = useState(""),
    [comparison, setComparison] = useState("");
  const [content, setContent] = useState(""),
    [revision, setRevision] = useState<string | number>(),
    [mode, setMode] = useState("preview"),
    [busy, setBusy] = useState(false),
    [error, setError] = useState<unknown>(),
    [undo, setUndo] = useState<Row>();
  useEffect(() => {
    if (document && (revision === undefined || content === baseline)) {
      setContent(document.content ?? "");
      setBaseline(document.content ?? "");
      setRevision(document.revision);
    }
  }, [document]);
  async function save() {
    setBusy(true);
    setError(undefined);
    try {
      const result = await api(base + "/documents", "PATCH", {
        path: selected.path,
        content,
        expectedRevision: revision,
      });
      setRevision(result.document.revision);
      setContent(result.document.content ?? "");
      setBaseline(result.document.content ?? "");
      await client.invalidateQueries();
      setMode("preview");
      requestAnimationFrame(() => previewTab.current?.focus());
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog title={selected.path} close={close}>
      <div className="toolbar">
        {["preview", "edit", "diff", "history"].map((tab) => (
          <button
            key={tab}
            ref={tab === "preview" ? previewTab : undefined}
            aria-pressed={mode === tab}
            onClick={() => setMode(tab)}
          >
            {
              (
                {
                  preview: t("Náhled", "Preview"),
                  edit: t("Upravit", "Edit"),
                  diff: t("Porovnat", "Compare"),
                  history: t("Historie", "History"),
                } as Record<string, string>
              )[tab]
            }
          </button>
        ))}
        <button
          onClick={() => download(selected.path.split("/").at(-1), content)}
        >
          {t("Stáhnout", "Download")}
        </button>
      </div>
      <ErrorBox error={error ?? detail.error} />
      {document && revision !== undefined && document.revision !== revision && (
        <p className="notice">
          {t(
            "Na serveru existuje novější revize. Váš koncept je zachován; před uložením porovnejte změny.",
            "A newer revision exists on the server. Your draft is preserved; compare changes before saving.",
          )}
          <button
            onClick={() => {
              setContent(document.content ?? "");
              setBaseline(document.content ?? "");
              setRevision(document.revision);
            }}
          >
            {t(
              "Načíst novější a zahodit koncept",
              "Load newer and discard draft",
            )}
          </button>
        </p>
      )}
      {document && (
        <p className="muted">
          {t("Revize", "Revision")}: {String(revision)} · {document.bytes} B
        </p>
      )}
      {mode === "edit" ? (
        <>
          <textarea
            className="document-editor"
            aria-label={t("Obsah dokumentu", "Document content")}
            value={content}
            onChange={(e) => setContent(e.target.value)}
          />
          <button
            className="primary"
            disabled={busy || content === document?.content}
            onClick={save}
          >
            {t("Uložit novou revizi", "Save new revision")}
          </button>
        </>
      ) : mode === "diff" ? (
        <>
          <label>
            {t("Porovnávaná revize", "Compare revision")}
            <select
              value={comparison}
              onChange={(e) => setComparison(e.target.value)}
            >
              <option value="">
                {t("Aktuální dokument a koncept", "Current document and draft")}
              </option>
              {(workspace.data?.workspace?.operations ?? [])
                .filter((op: Row) => op.path === selected.path)
                .map((op: Row) => (
                  <option key={op.id} value={op.id}>
                    {new Date(op.at).toLocaleString(t("cs-CZ", "en-GB"))} ·{" "}
                    {op.kind}
                  </option>
                ))}
            </select>
          </label>
          {comparison ? (
            <Diff
              before={
                (workspace.data?.workspace?.operations ?? []).find(
                  (op: Row) => op.id === comparison,
                )?.before
              }
              after={
                (workspace.data?.workspace?.operations ?? []).find(
                  (op: Row) => op.id === comparison,
                )?.after
              }
            />
          ) : (
            <Diff before={document?.content} after={content} />
          )}
        </>
      ) : mode === "history" ? (
        <div className="history-list">
          {(workspace.data?.workspace?.operations ?? [])
            .filter((op: Row) => op.path === selected.path)
            .slice()
            .reverse()
            .map((op: Row) => (
              <article key={op.id}>
                <div>
                  <strong>{op.kind}</strong>
                  <p className="muted">
                    {new Date(op.at).toLocaleString(t("cs-CZ", "en-GB"))}
                  </p>
                </div>
                <button onClick={() => setUndo({ operation: op.id })}>
                  {t("Náhled Undo", "Preview Undo")}
                </button>
              </article>
            ))}
        </div>
      ) : document ? (
        <div className="prose document-preview">
          <RichText text={content} />
        </div>
      ) : (
        <Empty>{t("Načítání dokumentu…", "Loading document…")}</Empty>
      )}
      {undo && (
        <OperationReview
          sessionId={selected.sessionId}
          operationId={undo.operation}
          path={selected.path}
          close={() => setUndo(undefined)}
          onRestored={async () => {
            const refreshed = await detail.refetch();
            if (refreshed.data?.document) {
              setContent(refreshed.data.document.content ?? "");
              setBaseline(refreshed.data.document.content ?? "");
              setRevision(refreshed.data.document.revision);
            }
          }}
        />
      )}
    </Dialog>
  );
}

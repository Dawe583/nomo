import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { api } from "./api";
import { Dialog, Empty, ErrorBox, useApi, useText } from "./ui";
import {
  projectWorkspaceApplyRequest,
  projectWorkspaceDiff as parseProjectWorkspaceDiff,
  projectWorkspaceDiffUrl,
  projectWorkspaceErrorKind,
  projectWorkspacePage,
  projectWorkspaceSummary,
} from "./project-workspace-state.ts";
import { AgentRunnerConsent } from "./agent-runner-consent";

type Confirmation =
  | { kind: "apply"; path: string; digest: string }
  | { kind: "delete"; rootDigest: string; displayName: string; hasChanges: boolean }
  | { kind: "revoke" };

const API = "/api/project-workspace";

function formatBytes(value: number, locale: "cs" | "en"): string {
  if (!Number.isFinite(value) || value < 0)
    return locale === "cs" ? "neznámá velikost" : "unknown size";
  return new Intl.NumberFormat(locale, { style: "unit", unit: "byte", unitDisplay: "narrow", maximumFractionDigits: 1 }).format(value);
}

export function ProjectWorkspace() {
  const t = useText();
  const queryClient = useQueryClient();
  const [rootPath, setRootPath] = useState("");
  const [cursorStack, setCursorStack] = useState<Array<string | null>>([null]);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();
  const [notice, setNotice] = useState("");

  const summary = useApi(API, true, 0, false);
  const workspaceState = projectWorkspaceSummary(summary.data);
  const active = workspaceState?.project;
  const cursor = cursorStack.at(-1) ?? null;
  const pageUrl = API + "/diff?limit=50" + (cursor ? "&cursor=" + encodeURIComponent(cursor) : "");
  const page = useApi(pageUrl, !!active, 0, false);
  const pageState = projectWorkspacePage(page.data);
  const files = pageState?.files ?? [];
  const selectedChange = files.find((file) => file.path === selectedPath) ?? null;
  const diff = useApi(
    projectWorkspaceDiffUrl(selectedPath ?? ""),
    !!active && !!selectedPath,
    0,
    false,
  );
  const diffState = parseProjectWorkspaceDiff(diff.data);
  const applyRequest = projectWorkspaceApplyRequest(active ?? null, selectedChange, diffState);
  const savedOnly = (workspaceState?.savedWorkspaces ?? [])
    .filter((entry) => entry.rootDigest !== active?.rootDigest);
  const hasActiveChanges = Object.values(workspaceState?.workspace?.changes ?? {})
    .some((value) => value > 0);

  function refresh() {
    setCursorStack([null]);
    setSelectedPath(null);
    setNotice("");
    void queryClient.invalidateQueries({
      predicate: (query) => query.queryKey.some(
        (key) => typeof key === "string" && key.startsWith(API),
      ),
    });
  }

  async function confirmAccess(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError(undefined);
    setNotice("");
    try {
      await api(API + "/access", "POST", { path: rootPath.trim() });
      setRootPath("");
      refresh();
      setNotice(t("Projektová kopie je připravena. Zdrojový repozitář zůstává mimo sandbox.", "The project copy is ready. The source repository stays outside the sandbox."));
    } catch (cause) {
      if (projectWorkspaceErrorKind(cause) === "conflict") {
        refresh();
        setNotice(t("Projekt se změnil nebo již není dostupný. Znovu zkontrolujte cestu.", "The project changed or is no longer available. Check the path again."));
      } else {
        setError(cause);
      }
    } finally {
      setBusy(false);
    }
  }

  async function performConfirmation() {
    if (!confirmation) return;
    setBusy(true);
    setError(undefined);
    setNotice("");
    let successMessage: string;
    try {
      if (confirmation.kind === "apply") {
        await api(API + "/apply", "POST", {
          path: confirmation.path,
          digest: confirmation.digest,
        });
        successMessage = t("Změna byla aplikována do zdrojového repozitáře.", "The change was applied to the source repository.");
      } else if (confirmation.kind === "delete") {
        await api(API + "/workspace", "DELETE", { rootDigest: confirmation.rootDigest });
        successMessage = t("Uložená pracovní kopie byla smazána.", "The saved workspace was deleted.");
      } else {
        await api(API, "DELETE");
        successMessage = t("Přístup agenta byl odebrán. Uložená kopie zůstala zachována.", "Agent access was revoked. The saved copy was retained.");
      }
      setConfirmation(null);
      refresh();
      setNotice(successMessage);
    } catch (cause) {
      setConfirmation(null);
      if (projectWorkspaceErrorKind(cause) === "conflict") {
        refresh();
        setNotice(t("Stav se změnil. Zkontrolujte aktuální seznam a znovu otevřete diff.", "The state changed. Refresh the list and review the diff again."));
      } else {
        setError(cause);
      }
    } finally {
      setBusy(false);
    }
  }

  const pageConflict = projectWorkspaceErrorKind(page.error) === "conflict";
  const pageInvalid = !!page.data && !pageState;
  const nextCursor = pageState?.nextCursor ?? null;

  return (
    <section className="project-workspace" aria-label={t("Projektový pracovní prostor", "Project workspace")}>
      <p className="project-workspace-warning" role="note">
        {t(
          "Projekt se zkopíruje do soukromé filtrované pracovní kopie. Agent neuvidí zdrojový repozitář ani vyloučené soubory. I běžný zdrojový kód může obsahovat tajemství; zkontrolujte každou změnu před jejím použitím.",
          "The project is copied into a private filtered workspace. The agent cannot see the source repository or excluded files. Ordinary source code can still contain inline secrets; review every change before applying it.",
        )}
      </p>
      <ErrorBox error={error} />
      {notice && <p className="project-workspace-notice" role="status">{notice}</p>}

      <section className="project-workspace-section" aria-labelledby="project-workspace-access-heading">
        <h2 id="project-workspace-access-heading">{t("Přístup k projektu", "Project access")}</h2>
        <form className="project-workspace-form" onSubmit={confirmAccess}>
          <label htmlFor="project-workspace-path">
            {t("Absolutní cesta ke kořeni Git repozitáře", "Absolute path to the Git repository root")}
          </label>
          <input
            id="project-workspace-path"
            type="text"
            autoComplete="off"
            spellCheck={false}
            required
            value={rootPath}
            onChange={(event) => setRootPath(event.target.value)}
            placeholder={t("Např. /Users/jana/projects/aplikace", "For example, /Users/alex/projects/app")}
          />
          <div className="project-workspace-actions">
            <button className="primary" disabled={busy || !rootPath.trim()}>
              {busy ? t("Pracuji…", "Working…") : t("Připravit filtrovanou kopii", "Prepare filtered copy")}
            </button>
            <button type="button" onClick={refresh} disabled={busy}>
              {t("Obnovit stav", "Refresh status")}
            </button>
          </div>
        </form>

        <p className="project-workspace-caveat muted">
          {t(
            "Cesta se neposílá do URL ani neukládá v prohlížeči. Kopie vylučuje například .env, klíče, certifikáty, VCS, cache a TUI. Agent smí projektové nástroje použít pouze při jejich výslovném povolení v profilu.",
            "The path is not put in the URL or saved by the browser. The copy excludes items such as .env files, keys, certificates, VCS data, caches and TUI. Project tools are available to an agent only when explicitly allowed by its profile.",
          )}
        </p>
      </section>

      {summary.isPending && <p role="status">{t("Načítám stav…", "Loading workspace…")}</p>}
      {summary.error && <ErrorBox error={summary.error} />}
      {summary.data && !workspaceState && (
        <p role="alert">{t("Server vrátil neplatný stav pracovního prostoru.", "The server returned an invalid workspace state.")}</p>
      )}

      {active && (
        <section className="project-workspace-section" aria-labelledby="project-workspace-active-heading">
          <div className="project-workspace-heading-row">
            <h2 id="project-workspace-active-heading">{t("Aktivní kopie", "Active copy")}</h2>
            <div className="project-workspace-actions">
              <button type="button" onClick={() => setConfirmation({ kind: "revoke" })} disabled={busy}>
                {t("Odebrat přístup agenta", "Revoke agent access")}
              </button>
              <button type="button" className="danger-button" onClick={() => setConfirmation({
                kind: "delete",
                rootDigest: active.rootDigest,
                displayName: active.displayName,
                hasChanges: hasActiveChanges,
              })} disabled={busy}>
                {t("Smazat kopii", "Delete copy")}
              </button>
            </div>
          </div>
          <div className="project-workspace-meta">
            <strong>{active.displayName}</strong>
            <span>{t("Souborů", "Files")}: {workspaceState?.workspace?.fileCount ?? t("neznámý počet", "unknown")}</span>
            <span>{t("Velikost", "Size")}: {formatBytes(workspaceState?.workspace?.totalBytes ?? -1, document.documentElement.lang === "cs" ? "cs" : "en")}</span>
            <code title={active.rootDigest}>{active.rootDigest}</code>
          </div>
          <div className="project-workspace-counts" aria-label={t("Počty změn", "Change counts")}>
            <span>{t("Přidané", "Added")}: {workspaceState?.workspace?.changes.added ?? 0}</span>
            <span>{t("Upravené", "Modified")}: {workspaceState?.workspace?.changes.modified ?? 0}</span>
            <span>{t("Smazané", "Deleted")}: {workspaceState?.workspace?.changes.deleted ?? 0}</span>
          </div>
          <div className="project-workspace-heading-row">
            <h3>{t("Změny ke kontrole", "Changes to review")}</h3>
            <button type="button" onClick={refresh} disabled={busy}>{t("Načíst znovu", "Reload")}</button>
          </div>
          {pageConflict ? (
            <div className="project-workspace-conflict" role="alert">
              <p>{t("Seznam změn se mezitím změnil. Znovu načtěte aktuální stav.", "The change list changed. Reload the current state before reviewing.")}</p>
              <button type="button" onClick={refresh}>{t("Obnovit seznam", "Refresh list")}</button>
            </div>
          ) : page.error ? (
            <ErrorBox error={page.error} />
          ) : page.isPending ? (
            <p role="status">{t("Načítám změny…", "Loading changes…")}</p>
          ) : pageInvalid ? (
            <p role="alert">{t("Server vrátil neplatný seznam změn.", "The server returned an invalid change list.")}</p>
          ) : files.length === 0 ? (
            <Empty>{t("Pracovní kopie nemá žádné změny.", "The workspace has no changes.")}</Empty>
          ) : (
            <>
              <ul className="project-workspace-file-list">
                {files.map((file) => (
                  <li key={file.path}>
                    <code>{file.path}</code>
                    <span className="muted">{file.operation === "add"
                      ? t("Přidáno", "Added")
                      : file.operation === "update"
                        ? t("Upraveno", "Updated")
                        : t("Smazáno", "Deleted")}</span>
                    <button type="button" aria-pressed={selectedPath === file.path} onClick={() => setSelectedPath(file.path)}>
                      {t("Zobrazit diff", "Review diff")}
                    </button>
                  </li>
                ))}
              </ul>
              <div className="project-workspace-actions">
                {cursorStack.length > 1 && (
                  <button type="button" onClick={() => {
                    setSelectedPath(null);
                    setCursorStack((stack) => stack.slice(0, -1));
                  }}>
                    {t("Předchozí stránka", "Previous page")}
                  </button>
                )}
                {nextCursor && (
                  <button type="button" onClick={() => {
                    setSelectedPath(null);
                    setCursorStack((stack) => [...stack, nextCursor]);
                  }}>
                    {t("Další stránka", "Next page")}
                  </button>
                )}
              </div>
            </>
          )}

          {selectedPath && (
            <section className="project-workspace-diff" aria-labelledby="project-workspace-diff-heading" aria-live="polite">
              <div className="project-workspace-heading-row">
                <h3 id="project-workspace-diff-heading">{t("Diff", "Diff")}: <code className="muted">{selectedPath}</code></h3>
                <button type="button" onClick={() => setSelectedPath(null)}>{t("Zavřít diff", "Close diff")}</button>
              </div>
              {diff.isPending ? (
                <p role="status">{t("Načítám diff…", "Loading diff…")}</p>
              ) : diff.error ? (
                <div role="alert">
                  <ErrorBox error={diff.error} />
                  {projectWorkspaceErrorKind(diff.error) === "conflict" && (
                    <button type="button" onClick={refresh}>{t("Obnovit stav", "Refresh status")}</button>
                  )}
                </div>
              ) : diff.data && !diffState ? (
                <p role="alert">{t("Server vrátil neplatný diff.", "The server returned an invalid diff.")}</p>
              ) : diffState ? (
                <>
                  <pre className="project-workspace-diff-text">{diffState.file.diff}</pre>
                  <p className="project-workspace-digest">
                    {t("Digest změny", "Change digest")}: <code>{diffState.digest}</code>
                  </p>
                  <button
                    type="button"
                    className="primary"
                    disabled={!applyRequest || busy}
                    onClick={() => applyRequest && setConfirmation({ kind: "apply", ...applyRequest })}
                  >
                    {t("Potvrdit a aplikovat pouze tuto změnu", "Confirm and apply only this change")}
                  </button>
                </>
              ) : null}
            </section>
          )}
        </section>
      )}
      <AgentRunnerConsent enabled={!!active} />

      <section className="project-workspace-section" aria-labelledby="project-workspace-saved-heading">
        <h2 id="project-workspace-saved-heading">{t("Uložené pracovní kopie", "Saved workspaces")}</h2>
        <p className="project-workspace-caveat muted">
          {t("Katalog obsahuje jen metadata, ne původní cesty. Otevření projektu vyžaduje opětovné zadání jeho kořene.", "The catalog contains metadata only, never original paths. Reopening a project requires entering its root again.")}
        </p>
        {savedOnly.length === 0 ? (
          <Empty>{t("Žádné další uložené kopie.", "No other saved workspaces.")}</Empty>
        ) : (
          <ul className="project-workspace-saved-list">
            {savedOnly.map((entry) => (
              <li key={entry.rootDigest}>
                <div>
                  <strong>{entry.displayName}</strong>
                  <span className="muted">{entry.fileCount} {t("souborů", "files")} · {formatBytes(entry.totalBytes, document.documentElement.lang === "cs" ? "cs" : "en")}</span>
                  {entry.hasChanges && <span className="project-workspace-warning-text muted">{t("Obsahuje neaplikované změny", "Contains unapplied changes")}</span>}
                  {entry.requiresConfirmation && <span className="muted">{t("Před použitím vyžaduje nové potvrzení", "Requires renewed confirmation before use")}</span>}
                  <code title={entry.rootDigest}>{entry.rootDigest}</code>
                </div>
                <button type="button" className="danger-button" disabled={busy} onClick={() => setConfirmation({
                  kind: "delete",
                  rootDigest: entry.rootDigest,
                  displayName: entry.displayName,
                  hasChanges: entry.hasChanges,
                })}>
                  {t("Smazat kopii", "Delete workspace")}
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      {confirmation && (
        <Dialog
          title={confirmation.kind === "apply"
            ? t("Potvrdit aplikaci změny", "Confirm applying change")
            : confirmation.kind === "delete"
              ? t("Smazat pracovní kopii", "Delete workspace")
              : t("Odebrat přístup agenta", "Revoke agent access")}
          close={() => { if (!busy) setConfirmation(null); }}
        >
          <div className="project-workspace-confirmation">
            {confirmation.kind === "apply" ? (
              <>
                <p>{t("Do zdrojového repozitáře se zapíše pouze tento přesně zobrazený soubor a digest. Operace nevytvoří commit ani neprovede push nebo merge.", "Only this exact reviewed file and digest will be written to the source repository. This does not create a commit, push or merge.")}</p>
                <code>{confirmation.path}</code>
                <code>{confirmation.digest}</code>
              </>
            ) : confirmation.kind === "delete" ? (
              <>
                <p>{t("Smazání je nevratné a odstraní pracovní kopii včetně jejích změn.", "Deletion is permanent and removes the workspace, including its changes.")}</p>
                <strong>{confirmation.displayName}</strong>
                {confirmation.hasChanges && <p className="project-workspace-warning-text">{t("Tato kopie obsahuje neaplikované změny, které budou ztraceny.", "This copy contains unapplied changes that will be lost.")}</p>}
                <code>{confirmation.rootDigest}</code>
              </>
            ) : (
              <p>{t("Agent ztratí přístup. Uložená pracovní kopie a její změny zůstanou zachovány.", "The agent will lose access. The saved workspace and its changes will remain.")}</p>
            )}
            <div className="project-workspace-actions">
              <button type="button" onClick={() => setConfirmation(null)} disabled={busy}>{t("Zrušit", "Cancel")}</button>
              <button type="button" className={confirmation.kind === "delete" ? "danger-button" : "primary"} onClick={() => void performConfirmation()} disabled={busy}>
                {busy ? t("Pracuji…", "Working…") : confirmation.kind === "apply" ? t("Potvrdit aplikaci", "Apply reviewed change") : confirmation.kind === "delete" ? t("Trvale smazat", "Delete permanently") : t("Odebrat přístup", "Revoke access")}
              </button>
            </div>
          </div>
        </Dialog>
      )}
    </section>
  );
}

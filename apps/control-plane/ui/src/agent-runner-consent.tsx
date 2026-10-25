import { useState } from "react";
import { api } from "./api";
import { Empty, ErrorBox, useApi, useText } from "./ui";
import { agentRunnerConsentView, canStartAgentRun } from "./agent-runner-consent-state.ts";

type Runner = {
  id: string;
  displayName: string;
  provider: string;
  endpoint: string;
  dataTransfer: "local-only" | "remote";
  dataSent: string[];
  profiles: string[];
  execution: "local" | "remote";
  toolAccess: "mediated" | "unmediated";
  workspaceMode: "approved-copy" | "opaque";
  cancellation: "confirmed" | "may-be-unknown";
};
type AgentProfile = { id: string; name: string; systemPrompt?: string; allowedTools?: string[] };
type Preview = {
  id: string;
  consentDigest: string;
  task: string;
  runner: Pick<Runner, "id" | "displayName" | "provider" | "endpoint" | "dataTransfer" | "dataSent" | "execution" | "toolAccess" | "workspaceMode" | "cancellation">;
  runnerProfileId?: string;
  profile: { id: string; name: string; systemPrompt: string; allowedTools: string[] };
  project: {
    displayName: string;
    manifest: { digest: string; fileCount: number; totalBytes: number; files: Array<{ path: string; size: number }>; hasMore: boolean };
    changeCount: number;
  };
  tools: Array<{ name: string; description: string }>;
};

export function AgentRunnerConsent({ enabled }: { enabled: boolean }) {
  const t = useText();
  const runnersQuery = useApi("/api/agent-runners", enabled, 0, false);
  const agentsQuery = useApi("/api/agents", enabled, 0, false);
  const runners = (Array.isArray(runnersQuery.data?.runners) ? runnersQuery.data.runners : []) as Runner[];
  const profiles = (Array.isArray(agentsQuery.data?.profiles) ? agentsQuery.data.profiles : []) as AgentProfile[];
  const [runnerId, setRunnerId] = useState("");
  const [runnerProfileId, setRunnerProfileId] = useState("");
  const [profileId, setProfileId] = useState("");
  const [task, setTask] = useState("");
  const [preview, setPreview] = useState<Preview | null>(null);
  const [accepted, setAccepted] = useState(false);
  const [sessionId, setSessionId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();
  const [notice, setNotice] = useState("");
  const selectedRunner = runners.find((runner) => runner.id === runnerId) ?? runners[0];
  const selectedProfile = profiles.find((profile) => profile.id === profileId) ?? profiles[0];
  const selectedRunnerProfileId =
    selectedRunner?.profiles.includes(runnerProfileId)
      ? runnerProfileId
      : selectedRunner?.profiles[0] ?? "";
  const sessionQuery = useApi(
    sessionId ? `/api/sessions/${encodeURIComponent(sessionId)}?events=false` : "",
    !!sessionId,
    (data) => data?.session?.status === "running" ? 2000 : 0,
    false,
  );
  const sessionStatus = sessionQuery.data?.session?.status as string | undefined;
  const viewState = agentRunnerConsentView({
    enabled,
    loading: runnersQuery.isPending || agentsQuery.isPending,
    error: !!runnersQuery.error || !!agentsQuery.error,
    runnerCount: runners.length,
    profileCount: profiles.length,
  });

  function invalidatePreview() {
    setPreview(null);
    setAccepted(false);
    setNotice("");
  }

  async function prepare(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selectedRunner || !selectedProfile || !task.trim()) return;
    setBusy(true);
    setError(undefined);
    setNotice("");
    try {
      const result = await api("/api/agent-runs/preview", "POST", {
        runnerId: selectedRunner.id,
        profileId: selectedProfile.id,
        task: task.trim(),
        ...(selectedRunnerProfileId ? { runnerProfileId: selectedRunnerProfileId } : {}),
      });
      setPreview(result as unknown as Preview);
      setAccepted(false);
    } catch (cause) {
      setError(cause);
    } finally {
      setBusy(false);
    }
  }

  async function start() {
    if (!preview || !canStartAgentRun(preview, accepted, busy)) return;
    setBusy(true);
    setError(undefined);
    setNotice("");
    try {
      const result = await api("/api/agent-runs", "POST", {
        consentId: preview.id,
        consentDigest: preview.consentDigest,
      });
      const started = result.session as { id?: unknown } | undefined;
      if (typeof started?.id !== "string") throw new Error("Server nevrátil ID běhu.");
      setSessionId(started.id);
      setPreview(null);
      setAccepted(false);
      setNotice(t("Běh byl předán Workbenchi. Výsledek a stav sledujte zde nebo v chatu.", "The run was handed to Workbench. Follow its result and status here or in chat."));
    } catch (cause) {
      setError(cause);
    } finally {
      setBusy(false);
    }
  }

  async function stop() {
    if (!sessionId) return;
    setBusy(true);
    setError(undefined);
    try {
      await api(`/api/runs/${encodeURIComponent(sessionId)}/stop`, "POST");
      setNotice(t("Požadavek na zastavení přijal tento proces. Stav běhu se dál ověřuje; potvrzení požadavku neznamená potvrzené ukončení.", "This process accepted the stop request. Run status is still being checked; acceptance does not confirm termination."));
      await sessionQuery.refetch();
    } catch (cause) {
      setError(cause);
    } finally {
      setBusy(false);
    }
  }

  if (!enabled) return null;
  return (
    <section className="project-workspace-section" aria-labelledby="agent-runner-heading">
      <h2 id="agent-runner-heading">{t("Spustit coding agenta", "Run a coding agent")}</h2>
      <p className="project-workspace-caveat muted">
        {t("Agent pracuje pouze s filtrovanou kopií. Změny zůstávají v kopii, dokud každou zvlášť nezkontrolujete a nepotvrdíte aplikaci.", "The agent works only in the filtered copy. Changes stay there until you review each one and explicitly apply it.")}
      </p>
      <ErrorBox error={error} />
      {notice && <p role="status">{notice}</p>}
      {viewState === "loading" ? (
        <p role="status">{t("Načítám běhové adaptéry a profily…", "Loading runner adapters and profiles…")}</p>
      ) : viewState === "error" ? (
        <><ErrorBox error={runnersQuery.error} /><ErrorBox error={agentsQuery.error} /></>
      ) : viewState === "no-runner" ? (
        <Empty>{t("Není povolen žádný běhový adaptér. Běh nelze spustit.", "No runner adapter is enabled. A run cannot be started.")}</Empty>
      ) : viewState === "no-profile" ? (
        <Empty>{t("Není dostupný žádný profil agenta.", "No agent profile is available.")}</Empty>
      ) : viewState === "ready" ? (
        <>
          <form className="project-workspace-form" onSubmit={(event) => void prepare(event)}>
            <label htmlFor="agent-runner-choice">{t("Běhový adaptér", "Runner adapter")}</label>
            <select id="agent-runner-choice" value={selectedRunner?.id ?? ""} onChange={(event) => { setRunnerId(event.target.value); setRunnerProfileId(""); invalidatePreview(); }}>
              {runners.map((runner) => <option key={runner.id} value={runner.id}>{runner.displayName} · {runner.provider}</option>)}
            </select>
            {!!selectedRunner?.profiles.length && (
              <>
                <label htmlFor="agent-runner-profile">{t("Profil adaptéru", "Runner profile")}</label>
                <select id="agent-runner-profile" value={selectedRunnerProfileId} onChange={(event) => { setRunnerProfileId(event.target.value); invalidatePreview(); }}>
                  {selectedRunner.profiles.map((profile) => <option key={profile} value={profile}>{profile}</option>)}
                </select>
              </>
            )}
            <label htmlFor="agent-profile-choice">{t("Profil agenta", "Agent profile")}</label>
            <select id="agent-profile-choice" value={selectedProfile?.id ?? ""} onChange={(event) => { setProfileId(event.target.value); invalidatePreview(); }}>
              {profiles.map((profile) => <option key={profile.id} value={profile.id}>{profile.name}</option>)}
            </select>
            <label htmlFor="agent-run-task">{t("Úkol", "Task")}</label>
            <textarea id="agent-run-task" required maxLength={32000} rows={4} value={task} onChange={(event) => { setTask(event.target.value); invalidatePreview(); }} />
            <button className="primary" disabled={busy || !task.trim()}>{busy ? t("Pracuji…", "Working…") : t("Zobrazit, co bude odesláno", "Preview what will be sent")}</button>
          </form>
          {preview && (
            <section className="project-workspace-diff" aria-labelledby="agent-run-consent-heading">
              <h3 id="agent-run-consent-heading">{t("Přesný souhlas před spuštěním", "Exact consent before start")}</h3>
              <dl className="project-workspace-meta">
                <dt>{t("Úkol", "Task")}</dt><dd>{preview.task}</dd>
                <dt>{t("Adaptér", "Adapter")}</dt><dd>{preview.runner.displayName} · {preview.runner.provider} · {preview.runner.endpoint}</dd>
                <dt>{t("Profil adaptéru", "Runner profile")}</dt><dd>{preview.runnerProfileId ?? t("výchozí", "default")}</dd>
                <dt>{t("Přenos", "Transfer")}</dt><dd>{preview.runner.dataTransfer} · {preview.runner.execution}</dd>
                <dt>{t("Odesílaná data", "Data sent")}</dt><dd>{preview.runner.dataSent.join(", ") || t("žádná", "none")}</dd>
                <dt>{t("Přístup k nástrojům", "Tool access")}</dt><dd>{preview.runner.toolAccess} · {preview.runner.workspaceMode}</dd>
                <dt>{t("Zastavení", "Cancellation")}</dt><dd>{preview.runner.cancellation === "confirmed" ? t("adaptér potvrzuje ukončení", "adapter confirms cancellation") : t("ukončení může zůstat neznámé", "termination may remain unknown")}</dd>
                <dt>{t("Profil", "Profile")}</dt><dd>{preview.profile.name} · {preview.profile.id}</dd>
                <dt>{t("Systémový prompt", "System prompt")}</dt><dd>{preview.runner.dataSent.includes("system-prompt") ? preview.profile.systemPrompt : t("není uveden mezi odesílanými daty", "not listed as transferred data")}</dd>
                <dt>{t("Povolené nástroje", "Allowed tools")}</dt><dd>{preview.profile.allowedTools.join(", ") || t("žádné", "none")}</dd>
                <dt>{t("Nástroje runneru", "Runner tools")}</dt><dd>{preview.tools.map((tool) => tool.name).join(", ") || t("žádné", "none")}</dd>
                <dt>{t("Pracovní kopie", "Workspace copy")}</dt><dd>{preview.project.displayName} · {preview.project.manifest.fileCount} {t("souborů", "files")} · {preview.project.changeCount} {t("změn", "changes")}</dd>
                <dt>{t("Manifest digest", "Manifest digest")}</dt><dd><code>{preview.project.manifest.digest}</code></dd>
              </dl>
              <ul className="project-workspace-file-list">{preview.project.manifest.files.map((file) => <li key={file.path}><code>{file.path}</code><span>{file.size} B</span></li>)}</ul>
              {preview.project.manifest.hasMore && <p>{t("Zobrazeno prvních 100 souborů; souhlas zahrnuje celý manifest.", "Showing the first 100 files; consent covers the full manifest.")}</p>}
              <p>{t("Runner může změnit pouze svou pracovní kopii. Uplatnění změn vyžaduje samostatnou kontrolu a potvrzení jednotlivých souborů.", "The runner can change only its workspace copy. Applying changes requires separate review and confirmation for each file.")}</p>
              <label><input type="checkbox" checked={accepted} onChange={(event) => setAccepted(event.target.checked)} /> {t("Zkontroloval(a) jsem uvedený úkol, přenos dat, profil, nástroje a manifest a výslovně souhlasím se spuštěním.", "I reviewed the task, data transfer, profile, tools and manifest, and explicitly consent to starting this run.")}</label>
              <div className="project-workspace-actions">
                <button type="button" onClick={invalidatePreview} disabled={busy}>{t("Zrušit", "Cancel")}</button>
                <button type="button" className="primary" onClick={() => void start()} disabled={!canStartAgentRun(preview, accepted, busy)}>{t("Spustit agenta", "Start agent")}</button>
              </div>
            </section>
          )}
        </>
      ) : null}
      {sessionId && (
        <section aria-labelledby="agent-run-status-heading">
          <h3 id="agent-run-status-heading">{t("Stav běhu", "Run status")}</h3>
          {sessionQuery.error ? <ErrorBox error={sessionQuery.error} /> : <p role="status">{sessionQuery.isPending ? t("Načítám…", "Loading…") : sessionStatus ?? t("Neznámý", "Unknown")}</p>}
          <a href={`/chat/${encodeURIComponent(sessionId)}`}>{t("Otevřít běh v chatu", "Open run in chat")}</a>
          {sessionStatus === "running" && <button type="button" onClick={() => void stop()} disabled={busy}>{t("Požádat o zastavení", "Request stop")}</button>}
        </section>
      )}
    </section>
  );
}

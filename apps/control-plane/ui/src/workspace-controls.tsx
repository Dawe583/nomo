import { useState, type FormEvent } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { api, items, type Row } from "./api";
import { ErrorBox, JsonDetail, useApi, useText } from "./ui";
import { agentInput, DEFAULT_AGENT_CONTEXT_TOKENS } from "./agent-input";

export function WorkspaceControls() {
  const t = useText(),
    client = useQueryClient();
  const capabilities = useApi("/api/capabilities");
  const projects = useApi(
    "/api/projects",
    capabilities.data?.projects === true,
  );
  const agents = useApi("/api/agents");
  const [project, setProject] = useState<Row>(),
    [profile, setProfile] = useState<Row>(),
    [hook, setHook] = useState<Row>();
  const [busy, setBusy] = useState(false),
    [error, setError] = useState<unknown>(),
    [saved, setSaved] = useState(false);
  async function toggleHook(row: Row) {
    if (busy) return;
    setBusy(true);
    setSaved(false);
    setError(undefined);
    try {
      await api("/api/hooks", "POST", { ...row, enabled: !row.enabled });
      await client.invalidateQueries();
      setSaved(true);
    } catch (error) {
      setError(error);
    } finally {
      setBusy(false);
    }
  }
  async function save(
    event: FormEvent<HTMLFormElement>,
    path: string,
    payload: (fields: Record<string, string>) => unknown,
  ) {
    event.preventDefault();
    if (busy) return;
    const form = event.currentTarget;
    setBusy(true);
    setSaved(false);
    setError(undefined);
    try {
      const fields = Object.fromEntries(
        [...new FormData(form)].map(([key, value]) => [key, String(value)]),
      );
      await api(path, "POST", payload(fields));
      await client.invalidateQueries();
      setSaved(true);
    } catch (error) {
      setError(error);
    } finally {
      setBusy(false);
    }
  }
  const policyProfiles: string[] = agents.data?.policyProfiles ?? [];
  return (
    <>
      <ErrorBox
        error={error ?? capabilities.error ?? projects.error ?? agents.error}
      />
      {saved && (
        <p role="status">
          {t(
            "Nastavení uloženo. Existující konverzace se nemění.",
            "Settings saved. Existing conversations are unchanged.",
          )}
        </p>
      )}
      <section>
        <h2>{t("Projekty", "Projects")}</h2>
        <p className="muted">
          {t(
            "Projekt seskupuje konverzace. Kořenová cesta neuděluje nástrojům přístup k souborům.",
            "A project groups conversations. Its root path does not grant filesystem access.",
          )}
        </p>
        {capabilities.isPending ? (
          <p role="status">{t("Ověřuji podporu…", "Checking support…")}</p>
        ) : capabilities.data?.projects === true ? (
          <>
            {projects.isPending ? (
              <p role="status">
                {t("Načítání projektů…", "Loading projects…")}
              </p>
            ) : (
              <ul>
                {items(projects.data).map((row) => (
                  <li key={row.id}>
                    <button type="button" onClick={() => setProject(row)}>
                      {row.name}
                    </button>{" "}
                    <code>{row.root}</code>
                  </li>
                ))}
              </ul>
            )}
            {!projects.isPending && !items(projects.data).length && (
              <p>{t("Zatím žádné projekty.", "No projects yet.")}</p>
            )}
            <form
              key={project?.id ?? "new-project"}
              onSubmit={(event) =>
                void save(event, "/api/projects", (fields) => ({
                  ...(project ? { id: project.id } : {}),
                  name: fields.name,
                  root: fields.root,
                }))
              }
            >
              <label>
                {t("Název projektu", "Project name")}
                <input
                  name="name"
                  required
                  maxLength={160}
                  defaultValue={project?.name ?? ""}
                />
              </label>
              <label>
                {t("Kořenová cesta", "Root path")}
                <input
                  name="root"
                  required
                  defaultValue={project?.root ?? ""}
                />
              </label>
              <div className="actions">
                <button disabled={busy}>
                  {t("Uložit projekt", "Save project")}
                </button>
                {project && (
                  <button type="button" onClick={() => setProject(undefined)}>
                    {t("Nový projekt", "New project")}
                  </button>
                )}
              </div>
            </form>
          </>
        ) : (
          <p>
            {t(
              "Správa projektů není na tomto hostu dostupná.",
              "Project management is not available on this host.",
            )}
          </p>
        )}
      </section>
      <section>
        <h2>{t("Vlastní agenti", "Custom agents")}</h2>
        <p className="muted">
          {t(
            "Prompt nikdy neuděluje oprávnění. Nástroje a limity ověřuje server a policy.",
            "A prompt never grants permission. The server and policy check tools and bounds.",
          )}
        </p>
        {capabilities.isPending ? (
          <p role="status">{t("Ověřuji podporu…", "Checking support…")}</p>
        ) : capabilities.data?.customAgents === true ? (
          <>
            <ul>
              {(agents.data?.profiles ?? []).map((row: Row) => (
                <li key={row.id}>
                  <button type="button" onClick={() => setProfile(row)}>
                    {row.name}
                  </button>
                </li>
              ))}
            </ul>
            {!agents.data?.profiles?.length && (
              <p>
                {t("Zatím žádné vlastní profily.", "No custom profiles yet.")}
              </p>
            )}
            <form
              key={profile?.id ?? "new-agent"}
              onSubmit={(event) => void save(event, "/api/agents", agentInput)}
            >
              <label>
                ID
                <input
                  name="id"
                  required
                  defaultValue={profile?.id ?? ""}
                  readOnly={!!profile}
                />
              </label>
              <label>
                {t("Název agenta", "Agent name")}
                <input
                  name="name"
                  required
                  maxLength={160}
                  defaultValue={profile?.name ?? ""}
                />
              </label>
              <label>
                {t("Systémový prompt", "System prompt")}
                <textarea
                  name="systemPrompt"
                  required
                  defaultValue={profile?.systemPrompt ?? ""}
                />
              </label>
              <label>
                {t(
                  "Povolené nástroje, jedno přesné ID na řádek",
                  "Allowed tools, one exact ID per line",
                )}
                <textarea
                  name="allowedTools"
                  defaultValue={(profile?.allowedTools ?? []).join("\n")}
                />
              </label>
              <p className="muted">
                {t(
                  "Prázdný seznam nepovoluje žádné nástroje.",
                  "An empty list allows no tools.",
                )}
              </p>
              <label>
                {t("Profil policy", "Policy profile")}
                <select
                  name="policyProfile"
                  required
                  defaultValue={
                    profile?.policyProfile ?? policyProfiles[0] ?? ""
                  }
                >
                  {policyProfiles.map((value) => (
                    <option key={value}>{value}</option>
                  ))}
                </select>
              </label>
              <label>
                {t("Maximum tahů", "Maximum turns")}
                <input
                  name="maxTurns"
                  type="number"
                  min="1"
                  step="1"
                  required
                  defaultValue={profile?.maxTurns ?? 8}
                />
              </label>
              <label>
                {t(
                  "Maximum tokenů kontextu (vstup a rezerva výstupu)",
                  "Maximum context tokens (input and reserved output)",
                )}
                <input
                  name="maxContextTokens"
                  type="number"
                  min="1"
                  step="1"
                  required
                  defaultValue={
                    profile?.maxContextTokens ?? DEFAULT_AGENT_CONTEXT_TOKENS
                  }
                />
              </label>
              <div className="actions">
                <button disabled={busy || !policyProfiles.length}>
                  {t("Uložit agenta", "Save agent")}
                </button>
                {profile && (
                  <button type="button" onClick={() => setProfile(undefined)}>
                    {t("Nový agent", "New agent")}
                  </button>
                )}
              </div>
            </form>
          </>
        ) : (
          <p>
            {t(
              "Vlastní agenti nejsou na tomto hostu dostupní.",
              "Custom agents are not available on this host.",
            )}
          </p>
        )}
      </section>
      <section>
        <h2>{t("Hooky", "Hooks")}</h2>
        {agents.isPending ? (
          <p role="status">{t("Načítání hooků…", "Loading hooks…")}</p>
        ) : agents.data?.hooksSupported === true ? (
          <p className="muted">
            {t(
              "Hooky se spouštějí jen s příkazy na allowlistu operátora. Uložení hooku jej samo nespustí.",
              "Hooks run only with commands on the operator allowlist. Saving a hook does not execute it.",
            )}
          </p>
        ) : (
          <p>
            {t(
              "Spouštění hooků není na tomto hostu podporované. Žádný příkaz se nespustí.",
              "Hook execution is not supported on this host. No command will execute.",
            )}
          </p>
        )}
        {agents.data?.hooksSupported === true && (
          <p className="muted">
            {t("Povolené příkazy", "Allowed commands")}:{" "}
            {agents.data.hookCommands?.join(", ") || t("žádné", "none")}
          </p>
        )}
        {(agents.data?.hooks ?? []).map((row: Row) => (
          <details key={row.id}>
            <summary>
              {row.id} ({row.enabled ? t("zapnutý", "on") : t("vypnutý", "off")}
              )
            </summary>
            <div className="actions">
              <button
                type="button"
                disabled={busy}
                onClick={() => void toggleHook(row)}
              >
                {row.enabled ? t("Vypnout", "Disable") : t("Zapnout", "Enable")}
              </button>
              <button type="button" onClick={() => setHook(row)}>
                {t("Upravit", "Edit")}
              </button>
            </div>
            <JsonDetail value={row} />
          </details>
        ))}
        {agents.data?.hooksSupported === true &&
          (agents.data.hookCommands?.length ?? 0) > 0 && (
            <form
              key={hook?.id ?? "new-hook"}
              onSubmit={(event) =>
                void save(event, "/api/hooks", (fields) => ({
                  id: fields.id,
                  event: fields.event,
                  command: fields.command,
                  enabled: fields.enabled === "on",
                }))
              }
            >
              <label>
                ID
                <input
                  name="id"
                  required
                  maxLength={160}
                  defaultValue={hook?.id ?? ""}
                  readOnly={!!hook}
                />
              </label>
              <label>
                {t("Událost", "Event")}
                <select name="event" required defaultValue={hook?.event ?? ""}>
                  <option value="before-run">before-run</option>
                  <option value="after-tool">after-tool</option>
                  <option value="after-run">after-run</option>
                </select>
              </label>
              <label>
                {t("Příkaz z allowlistu", "Command from the allowlist")}
                <select
                  name="command"
                  required
                  defaultValue={hook?.command ?? ""}
                >
                  {(agents.data.hookCommands ?? []).map((command: string) => (
                    <option key={command}>{command}</option>
                  ))}
                </select>
              </label>
              <label>
                {t("Zapnutý", "Enabled")}
                <input
                  name="enabled"
                  type="checkbox"
                  defaultChecked={hook?.enabled ?? true}
                />
              </label>
              <p className="muted">
                {t(
                  "Allowlist se mění jen v konfiguraci hostitele, nikoli přes toto rozhraní.",
                  "The allowlist changes in the host's configuration only, never through this interface.",
                )}
              </p>
              <div className="actions">
                <button disabled={busy}>{t("Uložit hook", "Save hook")}</button>
                {hook && (
                  <button type="button" onClick={() => setHook(undefined)}>
                    {t("Nový hook", "New hook")}
                  </button>
                )}
              </div>
            </form>
          )}
      </section>
    </>
  );
}

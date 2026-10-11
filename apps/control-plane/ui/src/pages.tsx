import { ProviderNotice, RunStatus } from "./workspace-status";
import { runCanStop, runState, RUN_STATES } from "./workspace-state";
import { ApprovalReview } from "./approval-review";
import { plainAction, riskOf, sortRiskFirst } from "./approval-text";
import { LedgerVerify } from "./ledger-verify";
import { LedgerDetail } from "./ledger-detail";
import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { api, items, json, type Row } from "./api";
import { Icon } from "./icons";
import { overviewState } from "./overview-state";
import {
  Badge,
  DataTable,
  Dialog,
  Empty,
  ErrorBox,
  JsonDetail,
  useApi,
  useText,
} from "./ui";
export function Sessions({ navigate }: { navigate: (path: string) => void }) {
  const t = useText(),
    client = useQueryClient();
  const [archived, setArchived] = useState(false),
    [edit, setEdit] = useState<Row>(),
    [confirmArchive, setConfirmArchive] = useState<Row>(),
    [title, setTitle] = useState(""),
    [error, setError] = useState<unknown>();
  async function patch(row: Row, body: Row) {
    try {
      await api("/api/sessions/" + row.id, "PATCH", body);
      await client.invalidateQueries();
    } catch (e) {
      setError(e);
    }
  }
  return (
    <>
      <ErrorBox error={error} />
      <DataTable
        key={String(archived)}
        endpoint={"/api/sessions?archived=" + archived}
        legacyKey="sessions"
        toolbar={
          <button
            aria-pressed={archived}
            onClick={() => setArchived(!archived)}
          >
            {t("Archiv", "Archive")}
          </button>
        }
        columns={[
          {
            key: "title",
            label: t("Konverzace", "Conversation"),
            render: (r) => (
              <button
                className="text-button"
                onClick={() => navigate("/chat/" + r.id)}
              >
                {r.pinned ? "⌖ " : ""}
                {r.title ?? r.model}
              </button>
            ),
          },
          { key: "model", label: "Model" },
          { key: "project", label: t("Projekt", "Project") },
          {
            key: "status",
            label: t("Stav", "Status"),
            render: (r) => <Badge value={r.status} />,
          },
          { key: "updatedAt", label: t("Změněno", "Updated") },
          { key: "messageCount", label: t("Zprávy", "Messages") },
          {
            key: "actions",
            label: t("Akce", "Actions"),
            render: (r) => (
              <div className="row-actions">
                <button
                  onClick={() => {
                    setEdit(r);
                    setTitle(r.title ?? "");
                  }}
                >
                  {t("Název", "Rename")}
                </button>
                <button onClick={() => patch(r, { pinned: !r.pinned })}>
                  {r.pinned ? t("Odepnout", "Unpin") : t("Připnout", "Pin")}
                </button>
                <button onClick={() => setConfirmArchive(r)}>
                  {r.archived
                    ? t("Obnovit", "Restore")
                    : t("Archivovat", "Archive")}
                </button>
              </div>
            ),
          },
        ]}
        onRow={(r) => navigate("/chat/" + r.id)}
      />
      {confirmArchive && (
        <Dialog
          title={
            confirmArchive.archived
              ? t("Obnovit konverzaci", "Restore conversation")
              : t("Archivovat konverzaci", "Archive conversation")
          }
          close={() => setConfirmArchive(undefined)}
        >
          <p>
            {confirmArchive.archived
              ? t(
                  "Konverzace se vrátí mezi aktivní. Podepsaný ledger se nemění.",
                  "The conversation returns to active. The signed ledger is unchanged.",
                )
              : t(
                  "Archivace konverzaci jen skryje. Běžící práci nevypne a podepsaný ledger nesmaže.",
                  "Archiving only hides the conversation. It never stops running work and never deletes the signed ledger.",
                )}
          </p>
          <button
            className="primary"
            onClick={async () => {
              await patch(confirmArchive, {
                archived: !confirmArchive.archived,
              });
              setConfirmArchive(undefined);
            }}
          >
            {confirmArchive.archived
              ? t("Obnovit", "Restore")
              : t("Archivovat", "Archive")}
          </button>
        </Dialog>
      )}
      {edit && (
        <Dialog
          title={t("Přejmenovat konverzaci", "Rename conversation")}
          close={() => setEdit(undefined)}
        >
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              await patch(edit, { title });
              setEdit(undefined);
            }}
          >
            <label>
              {t("Název", "Title")}
              <input
                autoFocus
                required
                maxLength={160}
                value={title}
                onChange={(e) => setTitle(e.target.value)}
              />
            </label>
            <button className="primary">{t("Uložit", "Save")}</button>
          </form>
        </Dialog>
      )}
    </>
  );
}
export function Overview({ navigate }: { navigate: (path: string) => void }) {
  const t = useText();
  const query = useApi("/api/overview");
  const data = query.data;
  const metrics =
    data?.counts ?? data?.overview?.counts ?? data?.overview ?? data ?? {};
  const state = overviewState(metrics);
  const priorityLabel =
    state.kind === "decisions"
      ? t("Vyžaduje rozhodnutí", "Needs a decision")
      : state.kind === "failures"
        ? t("Vyžaduje zásah", "Needs attention")
        : state.kind === "running"
          ? t("Práce probíhá", "Work in progress")
          : state.kind === "clear"
            ? t("Bez čekající práce", "No work waiting")
            : t("Stav není k dispozici", "Status unavailable");
  return (
    <>
      <p className="page-intro">
        {t(
          "Co se právě děje ve vašem pracovním prostoru.",
          "What is happening in your workspace.",
        )}
      </p>
      <ErrorBox error={query.error} />
      <section className="overview-priority" data-tone={state.tone} aria-live="polite">
        <span className="overview-priority-icon" aria-hidden="true">
          <Icon name={state.tone === "attention" ? "warning" : state.tone === "active" ? "runs" : state.tone === "clear" ? "verified" : "more"} />
        </span>
        <div>
          <span>{t("Teď", "Now")}</span>
          <strong>{priorityLabel}</strong>
        </div>
        {state.count !== undefined && <b>{state.count}</b>}
      </section>
      <div className="metrics">
        {[
          [t("Konverzace", "Conversations"), "sessions", "/sessions"],
          [t("Aktivní běhy", "Active runs"), "running", "/runs"],
          [
            t("Čeká na rozhodnutí", "Awaiting decision"),
            "pendingApprovals",
            "/approvals",
          ],
          [t("Dokumenty", "Documents"), "documents", "/documents"],
        ].map(([label, key, path]) => (
          <button key={key} onClick={() => navigate(path)}>
            <span>{label}</span>
            <strong>{metrics[key] ?? "—"}</strong>
            <span aria-hidden="true">↗</span>
          </button>
        ))}
      </div>
      <section className="fleet-status">
        <h2>{t("Registrovaný agent", "Registered agent")}</h2>
        <ul className="fleet-meta">
          <li>
            <span>{t("Agent", "Agent")}</span>
            <strong>{data?.agentId ?? "—"}</strong>
          </li>
          <li>
            <span>{t("Stav běhu", "Run state")}</span>
            <strong>{data?.runState ?? t("neznámý", "unknown")}</strong>
          </li>
          <li>
            <span>{t("Běhy v chodu nebo při zastavení", "Running or stopping runs")}</span>
            <strong>{data?.inFlight ?? "—"}</strong>
            {typeof data?.inFlight === "number" && data.inFlight > 0 && (
              <small>
                {t(
                  "Jde o počet běhů, ne jednotlivých volání. Volání už odeslaná upstreamu zůstávají neznámá, dokud nepřijde výsledek.",
                  "Run count, not call count. Calls already dispatched upstream stay unknown until their result confirms.",
                )}
              </small>
            )}
          </li>
          <li>
            <span>{t("Potvrzení zastavení", "Stop acknowledgement")}</span>
            <strong>
              {data?.stopAck === "acknowledged"
                ? t("potvrzeno", "acknowledged")
                : data?.stopAck === "pending"
                  ? t("čeká", "pending")
                  : t("neznámý", "unknown")}
            </strong>
          </li>
        </ul>
        <h3>{t("Poslední události", "Latest events")}</h3>
        <ul className="fleet-events">
          {(data?.latestEvents ?? []).slice(0, 5).map((event: Row) => {
            // Metadata allow-list only (kind/at/label/verdict): render each
            // field by name so no prompt content can slip in even if the
            // server sent more.
            const fields: [string, unknown][] = [
              ["kind", event.kind],
              ["at", event.at],
              ["label", event.label],
              ["verdict", event.verdict],
            ];
            return (
              <li key={event.seq ?? String(event.at) + String(event.label)}>
                {fields
                  .filter(([, value]) => value !== undefined)
                  .map(([name, value]) => (
                    <span key={name} data-field={name}>
                      {String(value)}
                    </span>
                  ))}
              </li>
            );
          })}
        </ul>
      </section>
      <h2>{t("Nedávná práce", "Recent work")}</h2>
      <DataTable
        endpoint="/api/sessions?archived=false"
        legacyKey="sessions"
        columns={[
          { key: "title", label: t("Konverzace", "Conversation") },
          {
            key: "status",
            label: t("Stav", "Status"),
            render: (r) => <Badge value={r.status} />,
          },
          { key: "model", label: "Model" },
          { key: "updatedAt", label: t("Změněno", "Updated") },
        ]}
        onRow={(r) => navigate("/chat/" + r.id)}
      />
      <details>
        <summary>
          {t("Stav a rozsah přehledu", "Overview status and scope")}
        </summary>
        <JsonDetail value={data} />
      </details>
    </>
  );
}
export function Runs({ navigate }: { navigate: (path: string) => void }) {
  const t = useText(), client = useQueryClient();
  const [state, setState] = useState(""), [selected, setSelected] = useState<Row>(),
    [stopping, setStopping] = useState(false), [error, setError] = useState<unknown>(),
    [ack, setAck] = useState<"pending" | "acknowledged" | "unknown">("unknown");
  const overview = useApi("/api/overview");
  const detail = useApi("/api/runs?sessionId=" + encodeURIComponent(selected?.sessionId ?? ""), !!selected, 3000);
  const run = items(detail.data).find(row => row.id === selected?.id) ?? selected;
  const running = overview.data?.running ?? overview.data?.overview?.running ?? null;
  async function stop() {
    if (!run || stopping || !runCanStop(run)) return;
    setStopping(true); setError(undefined); setAck("pending");
    try {
      const result = await api("/api/runs/" + encodeURIComponent(run.sessionId) + "/stop", "POST") as Row;
      // The server's acknowledgement names this process's scope. UI success
      // follows the server response, never a local guess.
      setAck(result.ack === "acknowledged" ? "acknowledged" : "unknown");
      await client.invalidateQueries();
    } catch (error) { setError(error); setAck("unknown"); }
    finally { setStopping(false); }
  }
  return <>
    <p className="page-intro" role="status">{running === null
      ? t("Počet aktivních běhů je neznámý.", "Active run count is unknown.")
      : t(`Aktivní běhy: ${running}.`, `Active runs: ${running}.`)}</p>
    <ErrorBox error={overview.error} />
    <DataTable key={state} endpoint={"/api/runs?state=" + state}
      columns={[
        { key: "id", label: t("Běh", "Run") },
        { key: "sessionId", label: t("Konverzace", "Conversation"), render: row => <button className="text-button" onClick={() => navigate("/chat/" + row.sessionId)}>{row.title ?? row.sessionId}</button> },
        { key: "state", label: t("Stav", "State"), render: row => <RunStatus run={row} /> },
        { key: "progress", label: t("Průběh", "Progress"), render: row => typeof row.progress === "number" ? `${Math.round(row.progress * 100)}%` : t("Neznámý", "Unknown") },
        { key: "reconcileRequired", label: t("Kontrola výsledku", "Reconciliation"), render: row => runState(row) === "unknown" ? t("Nutná kontrola, neopakovat", "Check required, do not retry") : row.reconcileRequired === false ? t("Nevyžadována", "Not required") : t("Neznámá", "Unknown") },
        { key: "model", label: "Model" },
        { key: "createdAt", label: t("Začátek", "Started") },
        { key: "durationMs", label: "ms" },
        { key: "steps", label: t("Kroky", "Steps") },
      ]}
      onRow={row => { setSelected(row); setError(undefined); }}
      toolbar={<select aria-label={t("Stav běhu", "Run state")} value={state} onChange={event => setState(event.target.value)}>
        <option value="">{t("Všechny stavy", "All states")}</option>
        {RUN_STATES.map(value => <option key={value}>{value}</option>)}
      </select>}
    />
    {run && <Dialog title={t("Detail běhu", "Run details")} close={() => { if (!stopping) setSelected(undefined); }}>
      <RunStatus run={run} />
      <ErrorBox error={error ?? detail.error} />
      {(runState(run) === "unknown" || run.reconcileRequired) && <p className="notice" role="status">{t("Výsledek není potvrzen. Zkontrolujte nástroje a ledger. Běh se automaticky neopakuje.", "The outcome is not confirmed. Inspect tools and the ledger. The run will not automatically repeat.")}</p>}
      {runState(run) === "stopping" && <p role="status">{t("Požadavek na zastavení byl odeslán. Dříve spuštěný nástroj může ještě dokončit práci.", "Stop requested. An already dispatched tool may still finish.")}</p>}
      {ack !== "unknown" && <p role="status">{ack === "acknowledged"
        ? t("Tento proces potvrdil zastavení. Kill platí jen pro tento proces; volání už odeslaná upstreamu zůstávají ve stavu neznámo, dokud nepřijde výsledek.", "This process acknowledged the stop. Kill scope is this process only; calls already dispatched upstream stay unknown until their result confirms.")
        : t("Potvrzení zastavení zatím nepřišlo. Nezobrazuji úspěch.", "No stop acknowledgement yet. Success is not shown.")}</p>}
      <JsonDetail value={run} />
      <div className="actions">
        <button onClick={() => navigate("/chat/" + run.sessionId)}>{t("Otevřít konverzaci", "Open conversation")}</button>
        <button disabled={stopping || !!detail.error || !runCanStop(run)} onClick={() => void stop()}>{stopping ? t("Žádám zastavení…", "Requesting stop…") : t("Zastavit běh", "Stop run")}</button>
      </div>
    </Dialog>}
  </>;
}
export function Approvals() {
  const t = useText();
  const [selected, setSelected] = useState<Row>();
  const [filter, setFilter] = useState<"pending" | "all">("pending");
  // Server je autorita; seznam se obnovuje, aby druhý operátor viděl konflikt.
  const query = useApi("/api/approvals?history=true", true, 5000);
  const rows = items(query.data, "approvals");
  const visible = sortRiskFirst(
    filter === "pending" ? rows.filter((r: Row) => r.status === "pending") : rows,
    (r: Row) => String(r.call?.klass ?? r.klass ?? "unknown"),
  );
  const pendingCount = rows.filter((r: Row) => r.status === "pending").length;
  return (
    <>
      <p className="page-intro">
        {t(
          `Riziko první: R3 a R2 nahoře. Čeká ${pendingCount}. Expiraci a druhé rozhodnutí hlídá server — pozdní volba skončí konfliktem, ne dvojím zápisem.`,
          `Risk first: R3 and R2 on top. ${pendingCount} pending. Expiry and double decisions are guarded by the server — a late choice ends in conflict, not a duplicate write.`,
        )}
      </p>
      <ErrorBox error={query.error} />
      <div className="toolbar" role="group" aria-label={t("Filtr", "Filter")}>
        <button
          aria-pressed={filter === "pending"}
          onClick={() => setFilter("pending")}
        >
          {t("Čekající", "Pending")} ({pendingCount})
        </button>
        <button aria-pressed={filter === "all"} onClick={() => setFilter("all")}>
          {t("Vše včetně vyřešených", "All including resolved")}
        </button>
        <button onClick={() => void query.refetch()}>
          {t("Obnovit", "Refresh")}
        </button>
      </div>
      {query.isLoading ? (
        <p role="status">{t("Načítání schválení…", "Loading approvals…")}</p>
      ) : !visible.length ? (
        <Empty>
          {filter === "pending"
            ? t(
                "Nic nečeká na rozhodnutí. R0 a schválené běhy pokračují bez přerušení.",
                "Nothing awaits decision. R0 and approved runs continue uninterrupted.",
              )
            : t("Žádné záznamy.", "No records.")}
        </Empty>
      ) : (
        <div className="approval-inbox">
          {visible.map((r) => {
            const klass = riskOf(r);
            const settled = r.status !== "pending";
            return (
              <article
                key={r.holdId ?? r.id ?? r.seq}
                className="approval-card"
                data-risk={klass}
              >
                <div className="approval-card-head">
                  <strong>{plainAction(r)}</strong>
                  <Badge value={klass} />
                  <Badge value={r.status} />
                </div>
                <p className="muted">
                  {r.call?.tool ?? r.tool ?? "—"} ·{" "}
                  {t("prostor", "workspace")}{" "}
                  {r.call?.workspace ?? "unknown"} ·{" "}
                  {t("vyprší", "expires")}{" "}
                  {r.expiresAt
                    ? new Date(r.expiresAt).toLocaleString(t("cs-CZ", "en-GB"))
                    : "—"}
                </p>
                <p className="approval-rationale">
                  {r.reason ??
                    r.rationale ??
                    t("Server důvod neposkytl.", "The server gave no rationale.")}
                </p>
                <div className="actions">
                  <button
                    className={settled ? "" : "primary"}
                    onClick={() => setSelected(r)}
                  >
                    {settled
                      ? t("Zobrazit (vyřešeno)", "View (resolved)")
                      : t("Zkontrolovat a rozhodnout", "Review and decide")}
                  </button>
                </div>
              </article>
            );
          })}
        </div>
      )}
      {selected && (
        <ApprovalReview
          record={selected}
          close={() => setSelected(undefined)}
        />
      )}
    </>
  );
}
export function Ledger() {
  const t = useText();
  const readFilters = () => {
    const p = new URLSearchParams(location.search);
    return Object.fromEntries(
      ["workspace", "decision", "klass", "outcome", "from", "to"].map((k) => [
        k,
        p.get(k) ?? "",
      ]),
    );
  };
  const [filters, setFilters] = useState(readFilters),
    [detail, setDetail] = useState<Row>(),
    [error, setError] = useState<unknown>(),
    [scopeSearch, setScopeSearch] = useState("");
  const scopes = useApi(
    "/api/sessions?archived=all&limit=100&q=" + encodeURIComponent(scopeSearch),
  );
  const workspace = filters.workspace;
  const query = workspace ? "workspace=" + encodeURIComponent(workspace) : "";
  const filterQuery = new URLSearchParams(
    Object.entries(filters).filter(([, value]) => value),
  ).toString();
  function changeFilter(key: string, value: string) {
    const next = { ...filters, [key]: value };
    setFilters(next);
    const url = new URL(location.href);
    for (const [name, v] of Object.entries(next)) {
      if (v) url.searchParams.set(name, v);
      else url.searchParams.delete(name);
    }
    url.searchParams.delete("cursor");
    window.history.pushState({}, "", url);
  }
  useEffect(() => {
    const pop = () => {
      setFilters(readFilters());
    };
    window.addEventListener("popstate", pop);
    return () => window.removeEventListener("popstate", pop);
  }, []);
  return (
    <>
      <ErrorBox error={error} />
      <LedgerVerify key="ledger-verify" query={query} />
      <DataTable
        key={"ledger-feed:" + filterQuery}
        endpoint={"/api/feed?" + filterQuery}
        legacyKey="entries"
        toolbar={
          <>
            <input
              type="search"
              aria-label={t(
                "Hledat pracovní prostor v celé historii",
                "Find workspace in all history",
              )}
              placeholder={t("Hledat pracovní prostor…", "Find workspace…")}
              value={scopeSearch}
              onChange={(e) => setScopeSearch(e.target.value)}
            />
            <select
              aria-label={t("Pracovní prostor", "Workspace")}
              value={workspace}
              onChange={(e) => changeFilter("workspace", e.target.value)}
            >
              <option value="">
                {t("Výchozí prostor serveru", "Server default workspace")}
              </option>
              {workspace &&
                !items(scopes.data, "sessions").some(
                  (r) => r.workspace === workspace,
                ) && <option value={workspace}>{workspace}</option>}
              {items(scopes.data, "sessions").map((row) => (
                <option key={row.id} value={row.workspace}>
                  {row.title ?? row.workspace}
                </option>
              ))}
            </select>
            <select
              aria-label={t("Třída rizika", "Risk class")}
              value={filters.klass}
              onChange={(e) => changeFilter("klass", e.target.value)}
            >
              <option value="">{t("Všechny třídy", "All classes")}</option>
              {["r0", "r1", "r2", "r3"].map((value) => (
                <option key={value}>{value}</option>
              ))}
            </select>
            <select
              aria-label={t("Výsledek operace", "Operation outcome")}
              value={filters.outcome}
              onChange={(e) => changeFilter("outcome", e.target.value)}
            >
              <option value="">{t("Všechny výsledky", "All outcomes")}</option>
              {["completed", "failed", "undo:completed"].map((value) => (
                <option key={value}>{value}</option>
              ))}
            </select>
            <label>
              {t("Od", "From")}
              <input
                type="date"
                value={filters.from.slice(0, 10)}
                onChange={(e) =>
                  changeFilter(
                    "from",
                    e.target.value ? e.target.value + "T00:00:00.000Z" : "",
                  )
                }
              />
            </label>
            <label>
              {t("Do", "To")}
              <input
                type="date"
                value={filters.to.slice(0, 10)}
                onChange={(e) =>
                  changeFilter(
                    "to",
                    e.target.value ? e.target.value + "T23:59:59.999Z" : "",
                  )
                }
              />
            </label>
            <select
              aria-label={t("Rozhodnutí", "Decision")}
              value={filters.decision}
              onChange={(e) => changeFilter("decision", e.target.value)}
            >
              <option value="">
                {t("Všechna rozhodnutí", "All decisions")}
              </option>
              <option>allow</option>
              <option>hold</option>
              <option>deny</option>
            </select>
            <a className="button" href={"/api/ledger/export?" + query}>
              {t("Podepsaný export", "Signed export")}
            </a>
          </>
        }
        columns={[
          { key: "seq", label: "#" },
          { key: "at", label: t("Čas", "Time") },
          { key: "tool", label: t("Nástroj", "Tool") },
          {
            key: "klass",
            label: t("Třída", "Class"),
            render: (r) => <Badge value={r.klass} />,
          },
          { key: "decision", label: t("Rozhodnutí", "Decision") },
          {
            key: "digest",
            label: "Digest",
            render: (r) => <code>{String(r.digest ?? "").slice(0, 14)}…</code>,
          },
        ]}
        onRow={setDetail}
      />
      {detail && (
        <LedgerDetail row={detail} close={() => setDetail(undefined)} />
      )}
    </>
  );
}
export function Models({ navigate }: { navigate: (path: string) => void }) {
  const t = useText();
  const provider = useApi("/api/provider"),
    client = useQueryClient();
  const [error, setError] = useState<unknown>(),
    [search, setSearch] = useState("");
  return (
    <>
      <ErrorBox error={provider.error ?? error} />
      <ProviderNotice provider={provider.data} setup={() => navigate("/settings")} />
      <p className="page-intro">
        {t(
          "Katalog aktuálně připojeného poskytovatele. Ceny a limity bez zdroje jsou neověřené.",
          "Catalog of the connected provider. Prices and limits without a source are unverified.",
        )}
      </p>
      <input
        type="search"
        aria-label={t("Hledat model", "Search models")}
        placeholder={t("Hledat model…", "Search models…")}
        value={search}
        onChange={(e) => setSearch(e.target.value)}
      />
      <div className="model-catalog">
        {items(provider.data, "models")
          .filter((m) =>
            (m.id + " " + m.name).toLowerCase().includes(search.toLowerCase()),
          )
          .map((m) => (
            <article key={m.id}>
              <div>
                <h3>{m.name ?? m.id}</h3>
                <code>{m.id}</code>
                <p className="muted">
                  {t("Cena", "Price")}:{" "}
                  {m.pricing ? json(m.pricing) : t("neověřena", "unverified")} ·{" "}
                  {t("Kontext", "Context")}: {m.contextLength ?? "—"}
                </p>
              </div>
              <button
                onClick={async () => {
                  try {
                    await api("/api/preferences", "PATCH", {
                      defaultModel: m.id,
                    });
                    await client.invalidateQueries();
                  } catch (e) {
                    setError(e);
                  }
                }}
              >
                {t("Nastavit výchozí", "Set default")}
              </button>
            </article>
          ))}
      </div>
      <h2>{t("Spotřeba", "Usage")}</h2>
      <DataTable
        endpoint="/api/usage"
        columns={[
          { key: "sessionId", label: t("Konverzace", "Conversation") },
          { key: "model", label: "Model" },
          { key: "inputTokens", label: t("Vstupní tokeny", "Input tokens") },
          { key: "outputTokens", label: t("Výstupní tokeny", "Output tokens") },
          { key: "cost", label: t("Náklad", "Cost") },
          { key: "source", label: t("Zdroj ceny", "Price source") },
        ]}
        empty={t(
          "Zatím žádná zaznamenaná spotřeba. Chybějící údaje nejsou nulová spotřeba.",
          "No recorded usage yet. Missing data does not mean zero usage.",
        )}
      />
    </>
  );
}

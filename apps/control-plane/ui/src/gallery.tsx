/**
 * Internal component and state gallery (D02.07).
 *
 * D02.07 asks for a lightweight internal gallery built from the existing app
 * and dev tooling, with no Storybook and no new UI kit. That is exactly what
 * this file is: it imports the components the application already ships and
 * renders them with representative state, so the gallery cannot drift from
 * the real surfaces.
 *
 * Every family below is listed only because it has a real consumer elsewhere
 * in `apps/control-plane/ui/src`. The consumer is named in the section
 * heading, so this page doubles as the D03 inventory and nothing here is a
 * mock of a component nobody uses.
 *
 * The gallery is not a route of its own. `apps/control-plane/api/server.ts`
 * and `vercel.json` both enumerate the served SPA paths, and neither file
 * belongs to the UI package, so a new `/gallery` path would 404 in the
 * control plane and on Vercel. It is therefore a query-gated view on a
 * served route: `isGalleryRequest` is the single source of truth for the
 * gate, used by `main.tsx` and by the tests.
 */
import { useState } from "react";
import {
  Badge,
  Dialog,
  Empty,
  ErrorBox,
  RedactedJson,
  useAppliedAppearance,
  useText,
} from "./ui";
import { Icon } from "./icons";
import { BrandMark } from "./brand";
import {
  PermissionBanner,
  PermissionModeSwitch,
  type PermissionMode,
} from "./permission-mode";
import { ProviderNotice, RunStatus } from "./workspace-status";
import type { Row } from "./api";

/**
 * Representative run rows. The states are the ones `runState` in
 * `workspace-state.ts` can return, so `RunStatus` renders exactly what the
 * application renders for the same server row.
 */
const RUNS: readonly Row[] = [
  { state: "running" },
  { status: "queued" },
  { state: "awaiting-approval" },
  { state: "stopping" },
  { status: "cancelled" },
  { status: "completed" },
  { status: "failed" },
  { state: "unknown" },
  { reconcileRequired: true },
];

/** Representative provider rows for `providerStatus`. */
const PROVIDERS: readonly Row[] = [
  { status: "ready" },
  { status: "setup-required" },
  { status: "rate-limited", retryAt: "2026-09-25T14:30:00.000Z" },
  { status: "unavailable" },
  { connected: false },
];

/**
 * Policy decisions as `Badge` renders them in a ledger row
 * (`ledger-detail.tsx:63`). The label comes from `status-label.ts`, so the
 * gallery never invents vocabulary the application does not ship.
 */
const DECISIONS = ["allow", "hold", "deny", "compensated", "expired"] as const;

const ICON_NAMES = [
  "menu",
  "close",
  "compose",
  "more",
  "theme",
  "motion",
  "context",
  "download",
  "language",
  "chat",
  "overview",
  "sessions",
  "runs",
  "documents",
  "approvals",
  "ledger",
  "connections",
  "models",
  "settings",
  "undo",
  "send",
  "plus",
  "search",
  "pin",
  "warning",
  "verified",
  "recovery",
  "panel",
  "collapse",
  "stop",
  "chevron",
] as const;

const EVIDENCE = {
  tool: "postgres.row.delete",
  workspace: "default",
  decision: "hold",
  seconds: 300,
  // Synthetic only, and shaped so redact.ts catches it by value as well as by
  // key name (redact.ts:58). The gallery measurement asserts this string never
  // reaches the DOM.
  credential: "sk-live-0000111122223333",
  nested: { apiKey: "Bearer abcdef0123456789", keep: "public-value" },
};

function Section({
  id,
  title,
  consumer,
  children,
}: {
  id: string;
  title: string;
  consumer: string;
  children: React.ReactNode;
}) {
  return (
    <section className="gallery-section" id={id} aria-labelledby={id + "-heading"}>
      <h2 id={id + "-heading"}>{title}</h2>
      <p className="gallery-consumer">
        <span className="muted">Konzument / consumer: </span>
        <code>{consumer}</code>
      </p>
      {children}
    </section>
  );
}
export function ComponentGallery() {
  const t = useText();
  // The gallery mounts without the shell, so it applies the appearance
  // contract itself. Without this /gallery would always render light.
  useAppliedAppearance(localStorage.getItem("void-appearance") ?? "system");
  const [dialog, setDialog] = useState(false);
  const [mode, setMode] = useState<PermissionMode>("normal");
  const [pending, setPending] = useState(false);
  const [consent, setConsent] = useState(false);
  const [query, setQuery] = useState("postgres");
  const [secret, setSecret] = useState("sk-live-0000");
  const [page, setPage] = useState("50");

  return (
    <div className="gallery" data-gallery="components">
      <header className="gallery-header">
        <p className="gallery-internal" role="note" data-internal-gallery>
          <Badge value="unknown">{t("Interní", "Internal")}</Badge>{" "}
          {t(
            "Interní galerie komponent. Není součástí uživatelské navigace a nesmí být prezentována jako hotový produkt.",
            "Internal component gallery. Not part of the user navigation and not to be presented as finished product.",
          )}
        </p>
        <h1>{t("Galerie komponent", "Component gallery")}</h1>
        <p className="muted">
          {t(
            "Každá sekce renderuje komponentu, kterou aplikace skutečně používá, v reálných stavech. Sekce bez konzumenta zde nejsou.",
            "Every section renders a component the application actually uses, in real states. Sections without a consumer are absent.",
          )}
        </p>
        <p>
          <a className="button" href="/settings">
            {t("Zpět do nastavení", "Back to settings")}
          </a>
        </p>
      </header>

      <Section
        id="buttons"
        title={t("Tlačítka a ikony (D03.01, D02.06)", "Buttons and icons (D03.01, D02.06)")}
        consumer="styles.css:70-97 + chat.tsx:846, main.tsx:812"
      >
        <div className="gallery-row">
          <button className="primary">
            {t("Primární", "Primary")}
          </button>
          <button>{t("Sekundární", "Secondary")}</button>
          <button
            className="danger"
            disabled={pending}
            aria-busy={pending}
            onClick={() => setPending(!pending)}
          >
            <Icon name="stop" />
            {pending
              ? t("Zastavuji…", "Stopping…")
              : t("Přepnout čekající stav", "Toggle pending state")}
          </button>
          <button disabled>{t("Vypnuto", "Disabled")}</button>
          <button
            aria-label={t("Obnovit", "Refresh")}
            title={t("Obnovit data", "Refresh data")}
          >
            <Icon name="search" />
          </button>
          <button
            aria-label={t("Zavřít", "Close")}
            title={t("Zavřít panel", "Close panel")}
          >
            <Icon name="close" />
          </button>
        </div>
        <p className="muted">
          {t(
            "Ikonová tlačítka mají přístupný název i tooltip. Zničující akce není pouze ikona.",
            "Icon-only buttons carry an accessible name and a tooltip. A destructive action is never icon-only.",
          )}
        </p>
      </Section>

      <Section
        id="fields"
        title={t("Vstupní pole (D03.02)", "Text fields (D03.02)")}
        consumer="ui.tsx:339 search, ui.tsx:361 select, settings.tsx:216 secure field"
      >
        <div className="gallery-fields">
          <label>
            {t("Hledat v celé historii", "Search all history")}
            <input
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
          </label>
          <label>
            {t("Klíč poskytovatele", "Provider key")}
            <input
              type="password"
              value={secret}
              onChange={(event) => setSecret(event.target.value)}
              aria-describedby="gallery-field-error"
              aria-invalid={secret.length < 10}
            />
          </label>
          <p className="error" id="gallery-field-error" role="alert">
            {secret.length < 10
              ? t(
                  "Klíč je příliš krátký. Je potřeba alespoň 10 znaků.",
                  "The key is too short. At least 10 characters are required.",
                )
              : t("Klíč má přijjatelnou délku.", "The key length is acceptable.")}
          </p>
          <label>
            {t("Počet řádků", "Page size")}
            <select value={page} onChange={(event) => setPage(event.target.value)}>
              <option>25</option>
              <option>50</option>
              <option>100</option>
            </select>
          </label>
        </div>
      </Section>

      <Section
        id="choices"
        title={t(
          "Zaškrtávací pole a segmentový přepínač (D03.03)",
          "Checkbox and segmented control (D03.03)",
        )}
        consumer="permission-mode.tsx:59 PermissionModeSwitch, chat.tsx:1160, ui.tsx:383"
      >
        <label className="gallery-check">
          <input
            type="checkbox"
            checked={consent}
            onChange={(event) => setConsent(event.target.checked)}
          />
          {t("Zobrazit redigované důkazy", "Show redacted evidence")}
        </label>
        <PermissionModeSwitch mode={mode} source="server" onChange={setMode} />
        <div className="gallery-row">
          {(["normal", "plan", "read-only"] as const).map((entry) => (
            <button
              key={entry}
              className="primary"
              aria-pressed={mode === entry}
              onClick={() => setMode(entry)}
            >
              {entry}
            </button>
          ))}
        </div>
        <PermissionBanner mode={mode} source="server" />
      </Section>

      <Section
        id="status"
        title={t(
          "Stavové štítky a run identity (D03.04, D03.11, D03.14, D03.21)",
          "Status labels and run identity (D03.04, D03.11, D03.14, D03.21)",
        )}
        consumer="ui.tsx:40 Badge, workspace-status.tsx:45 RunStatus, pages.tsx:272"
      >
        <div className="gallery-badges">
          {RUNS.map((run, index) => (
            <span className="gallery-badge" key={index}>
              <RunStatus run={run} />
            </span>
          ))}
        </div>
        <p className="muted">
          {t(
            "Stav se nikdy nerozpoznává jen barvou: každý štítek nese text a datový stav.",
            "State is never signalled by colour alone: every badge carries text and a data state.",
          )}
        </p>
        <div className="gallery-badges">
          {DECISIONS.map((decision) => (
            <span className="gallery-badge" key={decision}>
              <Badge value={decision} />
            </span>
          ))}
        </div>
      </Section>

      <Section
        id="provider"
        title={t(
          "Stav poskytovatele (D03.14, D03.27)",
          "Provider status (D03.14, D03.27)",
        )}
        consumer="workspace-status.tsx:5 ProviderNotice, settings.tsx:195, chat.tsx:835"
      >
        <div className="gallery-notices">
          <ProviderNotice provider={PROVIDERS[0]} />
          <ProviderNotice provider={PROVIDERS[1]} setup={() => undefined} />
          <ProviderNotice provider={PROVIDERS[2]} />
          <ProviderNotice provider={PROVIDERS[3]} setup={() => undefined} />
        </div>
      </Section>

      <Section
        id="surfaces"
        title={t(
          "Prázdno, chyba a důkaz (D03.08, D03.10, D03.19)",
          "Empty, error and evidence (D03.08, D03.10, D03.19)",
        )}
        consumer="ui.tsx:108 Empty, ui.tsx:99 ErrorBox, ui.tsx:199 RedactedJson, pages.tsx:337"
      >
        <Empty>{t("Zatím bez běhů", "No runs yet")}</Empty>
        <ErrorBox error={new Error("HTTP 503: provider unavailable")} />
        <RedactedJson value={EVIDENCE} />
      </Section>

      <Section
        id="dialog"
        title={t("Dialog (D03.06)", "Dialog (D03.06)")}
        consumer="ui.tsx:116 Dialog, chat.tsx:1129, documents.tsx:430, settings.tsx:630"
      >
        <div className="gallery-row">
          <button className="primary" onClick={() => setDialog(true)}>
            {t("Otevřít dialog", "Open dialog")}
          </button>
        </div>
        {dialog && (
          <Dialog
            title={t("Potvrzení obnovy", "Recovery confirmation")}
            close={() => setDialog(false)}
          >
            <p>
              {t(
                "Obnova se dotkne 3 dokumentů. Akce je zvratná pouze před potvrzením.",
                "Recovery touches 3 documents. The action is reversible only before confirmation.",
              )}
            </p>
            <div className="actions">
              <button className="primary" onClick={() => setDialog(false)}>
                {t("Potvrdit obnovu", "Confirm recovery")}
              </button>
              <button onClick={() => setDialog(false)}>
                {t("Zrušit", "Cancel")}
              </button>
            </div>
          </Dialog>
        )}
      </Section>

      <Section
        id="icons"
        title={t("Ikonová slovní zásoba (D02.04, D02.05)", "Icon vocabulary (D02.04, D02.05)")}
        consumer="icons.tsx:36 Icon, 39 call sites across the UI"
      >
        <div className="gallery-icons">
          {ICON_NAMES.map((name) => (
            <span className="gallery-icon" key={name}>
              <Icon name={name} />
              <code>{name}</code>
            </span>
          ))}
        </div>
        <p className="muted">
          <BrandMark />{" "}
          {t(
            "Značka VOID zůstává jediným znakem značky.",
            "The VOID aperture stays the only brand mark.",
          )}
        </p>
      </Section>

      <footer className="gallery-footer">
        <p className="muted">
          {t(
            "Tato stránka je vývojový nástroj. Rodiny bez skutečného konzumenta v aplikaci zde záměrně nejsou.",
            "This page is a development tool. Families without a real consumer are intentionally absent.",
          )}
        </p>
      </footer>
    </div>
  );
}

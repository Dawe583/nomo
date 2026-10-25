import { ProviderNotice } from "./workspace-status";
import { WorkspaceControls } from "./workspace-controls";
import { Integrations } from "./integrations";
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api, items, json, type Row } from "./api";
import { Badge, Dialog, ErrorBox, JsonDetail, useApi, useText } from "./ui";
import { DESKTOP_DOWNLOADS } from "./desktop-downloads";
import { GALLERY_PATH } from "./gallery-path";
// NOMO has no default provider and no default model. The panel below reports
// what is connected and, when nothing is, says that.
export function Settings({
  appearance,
  setAppearance,
  locale,
  setLocale,
}: {
  appearance: string;
  setAppearance: (s: string) => void;
  locale: "cs" | "en";
  setLocale: (s: "cs" | "en") => void;
}) {
  const t = useText(),
    client = useQueryClient();
  const provider = useApi("/api/provider"),
    preferences = useApi("/api/preferences"),
    agents = useApi("/api/agents"),
    capabilities = useApi("/api/capabilities");
  const agentPreference = capabilities.data?.mode === "cloud" ? "defaultAgent" : "defaultAgentPreset";
  const [baseUrl, setBaseUrl] = useState(""),
    [kind, setKind] = useState("compatible"),
    [key, setKey] = useState(""),
    [error, setError] = useState<unknown>(),
    [busy, setBusy] = useState(false),
    [message, setMessage] = useState<"" | "connected" | "disconnected">("");
  const [descriptorFields, setDescriptorFields] = useState({
    id: "",
    endpoint: "",
    model: "",
    projectId: "",
    location: "",
    apiKey: "",
    accessKeyId: "",
    secretAccessKey: "",
    sessionToken: "",
  });
  const selectedDescriptor = provider.data?.availableProviderDescriptors?.find(
    (descriptor: Row) => descriptor.id === descriptorFields.id,
  );
  const capabilityPath =
    selectedDescriptor && descriptorFields.model
      ? `/api/provider/model-capabilities?${new URLSearchParams({
          descriptorId: selectedDescriptor.id,
          modelId: descriptorFields.model,
        })}`
      : "";
  const modelCapabilitiesQuery = useQuery({
    queryKey: [
      "provider-model-capabilities",
      selectedDescriptor?.id,
      descriptorFields.model,
    ],
    queryFn: () => api(capabilityPath),
    enabled: Boolean(selectedDescriptor && descriptorFields.model),
    retry: false,
  });
  const capabilityValue = modelCapabilitiesQuery.data;
  const inputModalities = Array.isArray(capabilityValue?.input)
    ? capabilityValue.input.filter(
        (value): value is string => typeof value === "string",
      )
    : [];
  const describeSupport = (value: unknown) =>
    value === true
      ? t("podporováno", "supported")
      : value === false
        ? t("nepodporováno", "unsupported")
        : t("neznámé", "unknown");
  const inputSupport = (modality: string) =>
    Array.isArray(capabilityValue?.input)
      ? inputModalities.includes(modality)
      : null;
  const describeLimit = (value: unknown) =>
    typeof value === "number" && Number.isSafeInteger(value) && value > 0
      ? value.toLocaleString(locale)
      : t("neznámé", "unknown");
  async function preference(body: Row) {
    try {
      await api("/api/preferences", "PATCH", body);
      await client.invalidateQueries();
    } catch (e) {
      setError(e);
    }
  }
  return (
    <div className="settings">
      <DesktopSetup />
      <WorkspaceControls />
      <section aria-labelledby="install-heading">
        <h2 id="install-heading">{t("Aplikace NOMO", "NOMO apps")}</h2>
        <h3>macOS</h3>
        <p>
          {t(
            "Lokální desktopová beta 4 pro Apple Silicon. macOS 13.5 nebo novější. Obsahuje vlastní NOMO runtime.",
            "Local desktop beta 4 for Apple Silicon. Requires macOS 13.5 or later. Includes its own NOMO runtime.",
          )}
        </p>
        <a className="button" href={DESKTOP_DOWNLOADS.macos}>
          {t("Stáhnout pro macOS (.dmg)", "Download for macOS (.dmg)")}
        </a>
        <p className="muted">
          {t(
            "Beta zatím nemá notarizaci Apple. Gatekeeper může instalaci zablokovat. Verze pro Intel zatím není dostupná.",
            "This beta is not Apple-notarized. Gatekeeper may block installation. An Intel build is not available yet.",
          )}
        </p>
        <h3>Windows</h3>
        <p>
          {t(
            "Lokální desktopová beta 4 pro Windows 10 nebo 11 na x64. Vyžaduje WebView2 a obsahuje vlastní NOMO runtime.",
            "Local desktop beta 4 for Windows 10 or 11 on x64. Requires WebView2 and includes its own NOMO runtime.",
          )}
        </p>
        <a className="button" href={DESKTOP_DOWNLOADS.windows}>
          {t("Stáhnout pro Windows (.exe)", "Download for Windows (.exe)")}
        </a>
        <p className="muted">
          {t(
            "Beta není podepsaná. Windows SmartScreen může zobrazit varování. Klíče pracovního prostoru zůstávají ve Windows Credential Manageru.",
            "This beta is unsigned. Windows SmartScreen may warn. Workspace keys stay in Windows Credential Manager.",
          )}
        </p>
        <h3>iOS / iPadOS</h3>
        <details>
          <summary>
            {t("Jak přidat NOMO na plochu", "Install NOMO on your Home Screen")}
          </summary>
          <ol>
            <li>
              {t(
                "Otevřete void-tui.vercel.app v Safari.",
                "Open void-tui.vercel.app in Safari.",
              )}
            </li>
            <li>
              {t(
                "Klepněte na Sdílet a Přidat na plochu.",
                "Tap Share, then Add to Home Screen.",
              )}
            </li>
            <li>
              {t(
                "Zapněte Otevřít jako webovou aplikaci, pokud se tato volba zobrazí, a potvrďte Přidat.",
                "Enable Open as Web App if shown, then tap Add.",
              )}
            </li>
          </ol>
          <p>
            {t(
              "Toto je webová verze a potřebuje internet. Nativní Swift aplikace zatím není vydaná. Lokální nástroje Prime potřebují zapnutý Mac s bridge službou.",
              "This is the web version and requires internet. The native Swift app has not been released yet. Prime local tools require your Mac and its bridge service to stay online.",
            )}
          </p>
        </details>
      </section>
      <section>
        <h2>{t("Váš pracovní prostor", "Your workspace")}</h2>
        {agents.data?.supported !== false && agents.data && (
          <>
            <label>
              {t("Výchozí agent", "Default agent")}
              <select
                value={
                  agents.data.agents?.some(
                    (agent: Row) => agent.id === preferences.data?.preferences?.[agentPreference],
                  )
                    ? preferences.data?.preferences?.[agentPreference]
                    : ""
                }
                disabled={capabilities.isPending || preferences.isPending}
                onChange={(e) => preference({ [agentPreference]: e.target.value })}
              >
                <option value="" disabled>{t("Vyberte dostupného agenta", "Choose an available agent")}</option>
                {(agents.data.agents ?? []).map((agent: Row) => (
                  <option key={agent.id} value={agent.id}>
                    {agent.name}
                  </option>
                ))}
              </select>
            </label>
            <p className="muted">
              {t(
                "Agent určuje pracovní styl. Nástroje a oprávnění stále řídí NOMO policy.",
                "The agent selects working style. Tools and permissions remain governed by NOMO policy.",
              )}
            </p>
          </>
        )}

        <label>
          {t("Vzhled", "Appearance")}
          <select
            value={appearance}
            onChange={(e) => {
              setAppearance(e.target.value);
              void preference({ appearance: e.target.value });
            }}
          >
            <option value="system">{t("Podle systému", "System")}</option>
            <option value="light">{t("Světlý", "Light")}</option>
            <option value="dark">{t("Tmavý", "Dark")}</option>
          </select>
        </label>
        <label>
          {t("Jazyk", "Language")}
          <select
            value={locale}
            onChange={(e) => {
              setLocale(e.target.value as "cs" | "en");
              void preference({ locale: e.target.value });
            }}
          >
            <option value="cs">{t("Čeština", "Czech")}</option>
            <option value="en">English</option>
          </select>
        </label>
        <label>
          {t("Odesílání na počítači", "Desktop send behavior")}
          <select
            value={preferences.data?.preferences?.sendBehavior ?? "mod-enter"}
            onChange={(e) => preference({ sendBehavior: e.target.value })}
          >
            <option value="mod-enter">⌘ / Ctrl + Enter</option>
            <option value="enter">Enter</option>
          </select>
        </label>
        <p className="muted">
          {t(
            "Na telefonu Enter vždy vloží nový řádek.",
            "On mobile, Enter always inserts a new line.",
          )}
        </p>
      </section>
      <section>
        <h2>{t("Poskytovatel modelu", "Model provider")}</h2>
        <ProviderNotice provider={provider.data} />
        <ErrorBox error={provider.error} />
        <p>
          {provider.data?.baseUrl ||
            t(
              "Zatím není připojen žádný poskytovatel.",
              "No model provider is connected yet.",
            )}
        </p>
        {provider.data?.vertexOptions && (
          <p className="muted">
            Google Vertex AI Standard: {provider.data.vertexOptions.projectId} /{" "}
            {provider.data.vertexOptions.location}
          </p>
        )}
        {provider.data?.setupRequired && (
          <p className="notice">
            {t(
              "NVIDIA NIM čeká na NVIDIA_API_KEY. Hosted API má účetní trial/free kvótu; nejde o garantované neomezené bezplatné použití.",
              "NVIDIA NIM needs NVIDIA_API_KEY. The hosted API may provide an account-scoped trial/free quota; this is not guaranteed unlimited free usage.",
            )}
          </p>
        )}
        <p className="muted">
          {t("Model pro nové konverzace", "Model for new conversations")}:{" "}
          {preferences.data?.preferences?.defaultModel ||
            t(
              "zatím nevýchozí, vyberte ho v konverzaci",
              "none chosen yet, select one in a conversation",
            )}
          .{" "}
          {t(
            "Existující konverzace si ponechají původní nastavení.",
            "Existing conversations retain their settings.",
          )}
        </p>
        <h3>{t("Manifestoví poskytovatelé", "Manifest providers")}</h3>
        <p className="muted">
          {t(
            "Zde lze připojit pouze manifestované transporty, které NOMO skutečně implementuje.",
            "Only manifest-listed transports implemented by NOMO can be connected here.",
          )}
        </p>
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            if (!selectedDescriptor) return;
            setBusy(true);
            setError(undefined);
            setMessage("");
            const auth =
              selectedDescriptor.authKind === "aws-credentials"
                ? {
                    kind: "aws-credentials",
                    accessKeyId: descriptorFields.accessKeyId,
                    secretAccessKey: descriptorFields.secretAccessKey,
                    ...(descriptorFields.sessionToken
                      ? { sessionToken: descriptorFields.sessionToken }
                      : {}),
                  }
                : selectedDescriptor.authKind === "none"
                  ? { kind: "none" }
                  : { kind: "api-key", apiKey: descriptorFields.apiKey };
            try {
              const vertexOptions =
                selectedDescriptor.endpointRule === "google-vertex-standard"
                  ? {
                      mode: "standard",
                      projectId: descriptorFields.projectId,
                      location: descriptorFields.location,
                    }
                  : undefined;
              await api("/api/provider", "POST", {
                providerId: selectedDescriptor.providerId,
                transport: selectedDescriptor.transport,
                ...(vertexOptions
                  ? { vertexOptions }
                  : { endpoint: descriptorFields.endpoint }),
                model: descriptorFields.model,
                auth,
              });
              setMessage("connected");
              await client.invalidateQueries();
            } catch (e) {
              setError(e);
            } finally {
              setDescriptorFields((current) => ({
                ...current,
                apiKey: "",
                accessKeyId: "",
                secretAccessKey: "",
                sessionToken: "",
              }));
              setBusy(false);
            }
          }}
        >
          <label>
            {t("Implementovaný poskytovatel", "Implemented provider")}
            <select
              required
              value={descriptorFields.id}
              onChange={(e) => {
                const descriptor =
                  provider.data?.availableProviderDescriptors?.find(
                    (item: Row) => item.id === e.target.value,
                  );
                setDescriptorFields({
                  id: descriptor?.id ?? "",
                  endpoint: descriptor?.endpoint ?? "",
                  model: descriptor?.model ?? "",
                  projectId: "",
                  location: "",
                  apiKey: "",
                  accessKeyId: "",
                  secretAccessKey: "",
                  sessionToken: "",
                });
              }}
            >
              <option value="">
                {t("Vyberte poskytovatele…", "Choose a provider…")}
              </option>
              {provider.data?.availableProviderDescriptors?.map(
                (descriptor: Row) => (
                  <option key={descriptor.id} value={descriptor.id}>
                    {descriptor.providerId} ({descriptor.transport})
                    {descriptor.endpoint ? ` (${descriptor.endpoint})` : ""}
                  </option>
                ),
              )}
            </select>
          </label>
          {selectedDescriptor?.endpointRule === "google-vertex-standard" && (
            <>
              <p className="muted">
                {t(
                  "Google Vertex AI Standard používá projekt a region; klíč se posílá pouze v hlavičce x-goog-api-key.",
                  "Google Vertex AI Standard uses a project and location; the key is sent only in the x-goog-api-key header.",
                )}
              </p>
              <label>
                Google Cloud project ID
                <input
                  required
                  autoComplete="off"
                  value={descriptorFields.projectId}
                  onChange={(e) =>
                    setDescriptorFields((current) => ({
                      ...current,
                      projectId: e.target.value,
                    }))
                  }
                />
              </label>
              <label>
                {t("Umístění", "Location")}
                <input
                  required
                  autoComplete="off"
                  placeholder="us-central1"
                  value={descriptorFields.location}
                  onChange={(e) =>
                    setDescriptorFields((current) => ({
                      ...current,
                      location: e.target.value,
                    }))
                  }
                />
              </label>
            </>
          )}
          {selectedDescriptor?.endpointRule !== "google-vertex-standard" && (
            <label>
              {t("Adresa API", "API endpoint")}
              <input
                type="url"
                required
                value={descriptorFields.endpoint}
                readOnly={
                  selectedDescriptor?.endpoint !== null &&
                  selectedDescriptor?.transport !== "bedrock-converse-stream"
                }
                onChange={(e) =>
                  setDescriptorFields((current) => ({
                    ...current,
                    endpoint: e.target.value,
                  }))
                }
              />
            </label>
          )}
          <label>
            {t("Model z manifestu", "Manifest model")}
            <select
              required
              disabled={!selectedDescriptor}
              value={descriptorFields.model}
              onChange={(e) =>
                setDescriptorFields((current) => ({
                  ...current,
                  model: e.target.value,
                }))
              }
            >
              {selectedDescriptor?.models?.map((model: string) => (
                <option key={model} value={model}>
                  {model}
                </option>
              ))}
            </select>
          </label>
          {selectedDescriptor && descriptorFields.model && (
            <section aria-labelledby="model-capability-heading">
              <h4 id="model-capability-heading">
                {t("Schopnosti modelu", "Model capabilities")}
              </h4>
              {modelCapabilitiesQuery.isPending ? (
                <p role="status">
                  {t("Načítám schopnosti z manifestu…", "Loading manifest capabilities…")}
                </p>
              ) : modelCapabilitiesQuery.isError ? (
                <p role="alert">
                  {t(
                    "Metadata schopností nejsou dostupná; považujte je za neznámá.",
                    "Capability metadata are unavailable; treat them as unknown.",
                  )}
                </p>
              ) : capabilityValue?.status === "conflict" ? (
                <p role="status">
                  {t(
                    "Připnuté katalogy se rozcházejí; schopnosti považujte za neznámé.",
                    "Pinned catalogs disagree; treat this model's capabilities as unknown.",
                  )}
                </p>
              ) : capabilityValue?.status === "known" ? (
                <ul className="muted">
                  <li>
                    {t("Volání nástrojů", "Tool calls")}:{" "}
                    {describeSupport(capabilityValue.tools)}
                  </li>
                  <li>
                    {t("Reasoning", "Reasoning")}:{" "}
                    {describeSupport(capabilityValue.reasoning)}
                  </li>
                  <li>
                    {t("Textový vstup", "Text input")}:{" "}
                    {describeSupport(inputSupport("text"))}
                  </li>
                  <li>
                    {t("Obrazový vstup", "Image input")}:{" "}
                    {describeSupport(inputSupport("image"))}
                  </li>
                  <li>
                    {t("Vstupní modality", "Input modalities")}:{" "}
                    {inputModalities.length
                      ? inputModalities.join(", ")
                      : t("neznámé", "unknown")}
                  </li>
                  <li>
                    {t("Kontextové okno", "Context window")}:{" "}
                    {describeLimit(capabilityValue.contextWindow)}
                  </li>
                  <li>
                    {t("Maximální výstup", "Maximum output")}:{" "}
                    {describeLimit(capabilityValue.maxTokens)}
                  </li>
                </ul>
              ) : (
                <p role="status">
                  {t(
                    "Metadata schopností nejsou dostupná; považujte je za neznámá.",
                    "Capability metadata are unavailable; treat them as unknown.",
                  )}
                </p>
              )}
            </section>
          )}
          {selectedDescriptor?.authKind === "api-key" && (
            <label>
              API key
              <input
                type="password"
                required
                autoComplete="off"
                value={descriptorFields.apiKey}
                onChange={(e) =>
                  setDescriptorFields((current) => ({
                    ...current,
                    apiKey: e.target.value,
                  }))
                }
              />
            </label>
          )}
          {selectedDescriptor?.authKind === "aws-credentials" && (
            <>
              <label>
                AWS access key ID
                <input
                  required
                  autoComplete="off"
                  value={descriptorFields.accessKeyId}
                  onChange={(e) =>
                    setDescriptorFields((current) => ({
                      ...current,
                      accessKeyId: e.target.value,
                    }))
                  }
                />
              </label>
              <label>
                AWS secret access key
                <input
                  type="password"
                  required
                  autoComplete="off"
                  value={descriptorFields.secretAccessKey}
                  onChange={(e) =>
                    setDescriptorFields((current) => ({
                      ...current,
                      secretAccessKey: e.target.value,
                    }))
                  }
                />
              </label>
              <label>
                AWS session token ({t("volitelné", "optional")})
                <input
                  type="password"
                  autoComplete="off"
                  value={descriptorFields.sessionToken}
                  onChange={(e) =>
                    setDescriptorFields((current) => ({
                      ...current,
                      sessionToken: e.target.value,
                    }))
                  }
                />
              </label>
            </>
          )}
          {selectedDescriptor?.authKind === "none" && (
            <p className="muted">
              {t("Tento transport nepoužívá přihlašovací údaje.", "This transport does not use credentials.")}
            </p>
          )}
          <button className="primary" disabled={busy || !selectedDescriptor}>
            {busy
              ? t("Připojuji…", "Connecting…")
              : t("Připojit manifestovaného poskytovatele", "Connect provider")}
          </button>
        </form>
        <details>
          <summary>
            {t("Vlastní nebo starší konfigurace API", "Custom or legacy API configuration")}
          </summary>
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            setError(undefined);
            setMessage("");
            try {
              await api("/api/provider", "POST", {
                baseUrl,
                kind,
                apiKey: key,
              });
              setMessage("connected");
              await client.invalidateQueries();
            } catch (e) {
              setError(e);
            } finally {
              setKey("");
              setBusy(false);
            }
          }}
        >
          {!!provider.data?.presets?.length && (
            <label>
              {t("Poskytovatel", "Provider")}
              <select
                aria-describedby="provider-availability"
                value={
                  provider.data.presets.find((p: Row) => p.baseUrl === baseUrl)
                    ?.id ?? (baseUrl ? "custom" : "")
                }
                onChange={(e) => {
                  const preset = provider.data?.presets.find(
                    (p: Row) => p.id === e.target.value,
                  );
                  if (preset) {
                    setBaseUrl(preset.baseUrl);
                    setKind(preset.kind);
                    setKey("");
                  }
                }}
              >
                <option value="">
                  {t("Vyberte poskytovatele…", "Choose a provider…")}
                </option>
                {provider.data.presets.map((p: Row) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
                {!!provider.data?.unavailableProviders?.length && (
                  <optgroup label={t("Poskytovatelé nedostupní", "Unavailable providers")}>
                    {provider.data.unavailableProviders.map((provider: Row) => (
                      <option
                        key={`${provider.source}:${provider.apiId}`}
                        value={`unavailable:${provider.source}:${provider.apiId}`}
                        disabled={provider.disabled}
                      >
                        {provider.name} ({provider.source})
                      </option>
                    ))}
                  </optgroup>
                )}
                <option value="custom">{t("Vlastní API", "Custom API")}</option>
              </select>
            </label>
          )}
          {!!provider.data?.unavailableProviders?.length && (
            <ul
              id="provider-availability"
              aria-label={t("Dostupnost API poskytovatelů", "Provider API availability")}
              className="muted"
            >
              {provider.data.unavailableProviders.map((provider: Row) => (
                <li key={`${provider.source}:${provider.apiId}`}>
                  <strong>{provider.name}</strong>: {provider.reason} ({provider.apiId}, {provider.source}, {provider.status})
                </li>
              ))}
            </ul>
          )}
          <label>
            {t("Adresa API", "API URL")}
            <input
              type="url"
              required
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
            />
          </label>
          <label>
            {t("Protokol", "Protocol")}
            <select value={kind} onChange={(e) => setKind(e.target.value)}>
              <option value="compatible">Chat Completions</option>
              <option value="anthropic">Anthropic</option>
            </select>
          </label>
          <label>
            API key
            <input
              type="password"
              autoComplete="off"
              value={key}
              onChange={(e) => setKey(e.target.value)}
            />
          </label>
          <div className="actions">
            <button className="primary" disabled={busy}>
              {busy
                ? t("Připojuji…", "Connecting…")
                : t("Připojit a ověřit", "Connect and validate")}
            </button>
            <button
              type="button"
              disabled={busy || !provider.data?.connected}
              onClick={async () => {
                try {
                  await api("/api/provider", "DELETE");
                  await client.invalidateQueries();
                  setMessage("disconnected");
                } catch (e) {
                  setError(e);
                }
              }}
            >
              {t("Odpojit", "Disconnect")}
            </button>
          </div>
        </form>
        </details>
      </section>
      <ErrorBox error={error} />
      {message && (
        <p role="status" className="notice">
          {message === "connected"
            ? t(
                "Poskytovatel připojen. Klíč je uložen šifrovaně na serveru.",
                "Provider connected. The key is encrypted on the server.",
              )
            : t(
                "Poskytovatel odpojen pro nové konverzace.",
                "Provider disconnected for new conversations.",
              )}
        </p>
      )}
      <section className="internal-tools">
        <h2>{t("Vývojářské nástroje", "Developer tools")}</h2>
        <p className="muted">
          {t(
            "Interní stránka pro vývojáře. Není součástí uživatelské navigace.",
            "An internal page for developers. Not part of the user navigation.",
          )}
        </p>
        <a className="button" href={GALLERY_PATH}>
          <Badge value="unknown">{t("Interní", "Internal")}</Badge>
          {t("Galerie komponent", "Component gallery")}
        </a>
      </section>
      <section>
        <h2>{t("Schopnosti a připojení", "Capabilities and connection")}</h2>
        <Capabilities />
      </section>
    </div>
  );
}
function DesktopSetup() {
  const t = useText(),
    client = useQueryClient();
  const capabilities = useApi("/api/capabilities");
  const setup = useApi(
    "/api/desktop/setup",
    capabilities.data?.desktopSetup === true,
    60000,
  );
  const provider = useApi("/api/provider");
  const [busy, setBusy] = useState(false),
    [error, setError] = useState<unknown>(),
    [done, setDone] = useState(false);
  if (!capabilities.data?.desktopSetup) return null;
  async function importProvider(source: string) {
    setBusy(true);
    setError(undefined);
    setDone(false);
    try {
      await api("/api/desktop/setup", "POST", { source });
      await client.invalidateQueries();
      setDone(true);
    } catch (error) {
      setError(error);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section aria-labelledby="desktop-setup-heading" aria-busy={busy}>
      <h2 id="desktop-setup-heading">
        {t("Začněte na tomto Macu", "Get started on this Mac")}
      </h2>
      <p>
        {t(
          "Importujte uložený API klíč z OpenCode nebo Prime. NOMO ověří poskytovatele a vybere dostupný model pro nové konverzace.",
          "Import a saved API key from OpenCode or Prime. NOMO validates the provider and selects an available model for new conversations.",
        )}
      </p>
      <p className="muted">
        {t(
          "Import přepne aktivního poskytovatele. Klíč zůstane v šifrovaném lokálním úložišti a odešle se pouze jeho poskytovateli, nikoli do NOMO Cloud. OAuth přihlášení se nepřenášejí.",
          "Import switches the active provider. The key stays in encrypted local storage and is sent only to its provider, not to NOMO Cloud. OAuth logins are not transferred.",
        )}
      </p>
      <ErrorBox error={setup.error ?? error} />
      {!setup.data && !setup.error && (
        <p role="status">
          {t("Hledám místní nastavení…", "Checking local setup…")}
        </p>
      )}
      {setup.data && (
        <ul>
          {items(setup.data, "sources").map((source) => (
            <li key={source.id}>
              {source.name} · {source.source}{" "}
              {source.available ? (
                <button
                  disabled={busy}
                  onClick={() => void importProvider(source.id)}
                >
                  {t("Importovat", "Import")} {source.name} ({source.source})
                </button>
              ) : (
                <span className="muted">
                  {t(
                    "Podporovaný API klíč nenalezen",
                    "No supported API key found",
                  )}
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
      <p role="status">
        {done
          ? t(
              "Hotovo. Můžete otevřít nový projekt v chatu.",
              "Ready. You can start a new project in chat.",
            )
          : provider.data?.connected
            ? t("Poskytovatel je připojený.", "Provider is connected.")
            : t(
                "Bez místního nastavení připojte poskytovatele níže.",
                "No local setup? Connect a provider below.",
              )}
      </p>
      <p>
        {t(
          "Dokumenty NOMO: lokální ukládání a řízené Undo jsou připravené. Libovolné soubory na disku a externí nástroje zatím nemají automatické Undo.",
          "NOMO documents: local storage and guarded Undo are ready. Arbitrary disk files and external tools do not yet have automatic Undo.",
        )}
      </p>
      {provider.data?.connected && (
        <a className="button" href="/chat/new">
          {t("Začít projekt v chatu", "Start a project in chat")}
        </a>
      )}
    </section>
  );
}
function Capabilities() {
  const query = useApi("/api/capabilities");
  const t = useText();
  return (
    <>
      <ErrorBox error={query.error} />
      {query.data && (
        <>
          <dl>
            <dt>{t("Prostředí", "Environment")}</dt>
            <dd>
              {query.data.mode === "cloud"
                ? "Vercel"
                : t("Lokální počítač", "Local computer")}
            </dd>
            <dt>{t("Současné běhy", "Concurrent runs")}</dt>
            <dd>{query.data.maxActiveRuns ?? ", "}</dd>
            <dt>{t("Fronta běhů", "Run queue")}</dt>
            <dd>
              {query.data.backgroundQueue
                ? t("Dostupná", "Available")
                : t("Není dostupná", "Unavailable")}
            </dd>
            <dt>{t("Velikost zprávy", "Message size")}</dt>
            <dd>
              {query.data.maxPromptCharacters ?? ", "} {t("znaků", "characters")}
            </dd>
            <dt>{t("Přílohy", "Attachments")}</dt>
            <dd>
              {query.data.binaryAttachments
                ? t("Textové a binární", "Text and binary")
                : t("Textové soubory do 24 KB", "Text files up to 24 KB")}
            </dd>
          </dl>
          <details>
            <summary>{t("Technické podrobnosti", "Technical details")}</summary>
            <JsonDetail value={query.data} />
          </details>
        </>
      )}
    </>
  );
}
const defaultPolicy =
  "version: 1\nrules:\n  - match:\n      class: r0\n    decision: allow\n  - match: {}\n    decision: hold\n    seconds: 300\n    notify: [cli]\n";
export function Connections() {
  const t = useText(),
    client = useQueryClient();
  const query = useApi("/api/connectors");
  const [editing, setEditing] = useState<Row>(),
    [testResult, setTestResult] = useState<Row>();
  const [error, setError] = useState<unknown>(),
    [busy, setBusy] = useState(false),
    [search, setSearch] = useState(""),
    [name, setName] = useState(""),
    [url, setUrl] = useState(""),
    [token, setToken] = useState(""),
    [policy, setPolicy] = useState(defaultPolicy),
    [facts, setFacts] = useState("{}"),
    [mapping, setMapping] = useState("{}");
  return (
    <>
      <Integrations />
      <h2>{t("Vlastní MCP konektory", "Custom MCP connectors")}</h2>
      <ErrorBox error={query.error ?? error} />
      <input
        type="search"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        placeholder={t(
          "Hledat konektor nebo nástroj…",
          "Search connectors or tools…",
        )}
        aria-label={t(
          "Hledat konektor nebo nástroj",
          "Search connectors or tools",
        )}
      />
      <div className="connector-list">
        {items(query.data, "connectors")
          .filter((c) =>
            (c.name + " " + json(c.tools))
              .toLowerCase()
              .includes(search.toLowerCase()),
          )
          .map((c) => (
            <article key={c.id ?? c.name}>
              <div className="connector-heading">
                <h2>{c.name}</h2>
                <Badge
                  value={
                    c.builtin
                      ? t("Vestavěný", "Built-in")
                      : t("Připojený", "Connected")
                  }
                />
              </div>
              <p>
                {c.url ??
                  c.endpoint ??
                  t("Spravovaný pracovní prostor", "Managed workspace")}
              </p>
              <p className="muted">
                {c.tools?.length ?? 0} {t("nástrojů", "tools")} ·{" "}
                {c.undo
                  ? t("Podporuje Undo", "Supports Undo")
                  : t("Bez automatického Undo", "No automatic Undo")}
              </p>
              <details>
                <summary>
                  {t("Katalog nástrojů a schémata", "Tool catalog and schemas")}
                </summary>
                {(c.toolDetails ?? c.tools ?? []).map((tool: string | Row) => (
                  <details
                    key={typeof tool === "string" ? tool : tool.name}
                    className="tool-card"
                  >
                    <summary>
                      {typeof tool === "string" ? tool : tool.name}
                    </summary>
                    {typeof tool === "string" ? (
                      <p>
                        {t(
                          "Tento endpoint neposkytuje schéma ani klasifikaci nástroje.",
                          "This endpoint does not provide a tool schema or classification.",
                        )}
                      </p>
                    ) : (
                      <JsonDetail value={tool} />
                    )}
                  </details>
                ))}
              </details>
              {!c.builtin && (
                <div className="actions">
                  <button
                    disabled={busy}
                    onClick={() => {
                      setEditing(c);
                      setName(c.name);
                      setUrl(c.url ?? c.endpoint ?? "");
                      setPolicy(c.policy ?? defaultPolicy);
                      setFacts(json(c.facts ?? {}));
                      setMapping(json(c.mapping ?? {}));
                      setToken("");
                    }}
                  >
                    {t("Upravit", "Edit")}
                  </button>
                  <button
                    disabled={busy}
                    onClick={async () => {
                      setBusy(true);
                      try {
                        setTestResult(
                          await api(
                            "/api/connectors/" + c.id + "/test",
                            "POST",
                          ),
                        );
                        await client.invalidateQueries();
                      } catch (e) {
                        setError(e);
                      } finally {
                        setBusy(false);
                      }
                    }}
                  >
                    {t("Ověřit spojení", "Test connection")}
                  </button>
                  <button
                    disabled={busy}
                    onClick={async () => {
                      setBusy(true);
                      try {
                        await api("/api/connectors/" + c.id, "DELETE");
                        await client.invalidateQueries();
                      } catch (e) {
                        setError(e);
                      } finally {
                        setBusy(false);
                      }
                    }}
                  >
                    {t("Odpojit", "Disconnect")}
                  </button>
                </div>
              )}
            </article>
          ))}
      </div>
      {testResult && (
        <Dialog
          title={t("Výsledek ověření", "Connection test result")}
          close={() => setTestResult(undefined)}
        >
          <JsonDetail value={testResult} />
        </Dialog>
      )}
      {editing && (
        <Dialog
          title={t("Upravit konektor", "Edit connector")}
          close={() => setEditing(undefined)}
        >
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              setBusy(true);
              setError(undefined);
              try {
                await api("/api/connectors/" + editing.id, "PATCH", {
                  name,
                  url,
                  token,
                  policy,
                  facts: JSON.parse(facts),
                  mapping: JSON.parse(mapping),
                });
                setEditing(undefined);
                await client.invalidateQueries();
              } catch (e) {
                setError(e);
              } finally {
                setToken("");
                setBusy(false);
              }
            }}
          >
            <label>
              {t("Název", "Name")}
              <input
                required
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            </label>
            <label>
              URL
              <input
                type="url"
                required
                value={url}
                onChange={(e) => setUrl(e.target.value)}
              />
            </label>
            <label>
              {t(
                "Nový token (prázdný zachová původní)",
                "New token (leave empty to keep current)",
              )}
              <input
                type="password"
                autoComplete="off"
                value={token}
                onChange={(e) => setToken(e.target.value)}
              />
            </label>
            <label>
              {t("Politika", "Policy")}
              <textarea
                rows={9}
                value={policy}
                onChange={(e) => setPolicy(e.target.value)}
              />
            </label>
            <label>
              Registry facts JSON
              <textarea
                value={facts}
                onChange={(e) => setFacts(e.target.value)}
              />
            </label>
            <label>
              Tool mapping JSON
              <textarea
                value={mapping}
                onChange={(e) => setMapping(e.target.value)}
              />
            </label>
            <ErrorBox error={error} />
            <button className="primary" disabled={busy}>
              {t("Uložit a ověřit", "Save and validate")}
            </button>
          </form>
        </Dialog>
      )}
      <details className="connect-form">
        <summary>
          {t("Připojit nový MCP konektor", "Connect a new MCP connector")}
        </summary>
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            setError(undefined);
            try {
              await api("/api/connectors", "POST", {
                name,
                url,
                token,
                policy,
                facts: JSON.parse(facts),
                mapping: JSON.parse(mapping),
              });
              await client.invalidateQueries();
              setName("");
              setUrl("");
            } catch (e) {
              setError(e);
            } finally {
              setToken("");
              setBusy(false);
            }
          }}
        >
          <label>
            {t("Název", "Name")}
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
            />
          </label>
          <label>
            URL
            <input
              type="url"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              required
            />
          </label>
          <label>
            Token
            <input
              type="password"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              autoComplete="off"
            />
          </label>
          <label>
            {t("Politika", "Policy")}
            <textarea
              rows={9}
              value={policy}
              onChange={(e) => setPolicy(e.target.value)}
            />
          </label>
          <label>
            Registry facts JSON
            <textarea
              value={facts}
              onChange={(e) => setFacts(e.target.value)}
            />
          </label>
          <label>
            Tool mapping JSON
            <textarea
              value={mapping}
              onChange={(e) => setMapping(e.target.value)}
            />
          </label>
          <button disabled={busy} className="primary">
            {busy
              ? t("Připojuji…", "Connecting…")
              : t("Připojit a objevit nástroje", "Connect and discover tools")}
          </button>
        </form>
      </details>
    </>
  );
}

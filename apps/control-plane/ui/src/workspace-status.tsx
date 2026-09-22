import { Badge, useText } from "./ui";
import { providerStatus, runState } from "./workspace-state";
import type { Row } from "./api";

export function ProviderNotice({
  provider,
  setup,
}: {
  provider?: Row;
  setup?: () => void;
}) {
  const t = useText();
  if (!provider)
    return (
      <p role="status">{t("Ověřuji poskytovatele…", "Checking provider…")}</p>
    );
  const status = providerStatus(provider);
  const labels = {
    ready: t("Připraven", "Ready"),
    "setup-required": t("Vyžaduje nastavení", "Setup required"),
    "rate-limited": t("Limit poskytovatele", "Rate limited"),
    unavailable: t("Nedostupný", "Unavailable"),
  };
  return (
    <div className="provider-state" role="status">
      <Badge value={status}>{labels[status]}</Badge>
      {provider.detail && <p>{provider.detail}</p>}
      {status === "rate-limited" && provider.retryAt && (
        <p>
          {t("Další pokus nejdříve", "Retry no earlier than")}:{" "}
          <time dateTime={provider.retryAt}>
            {new Date(provider.retryAt).toLocaleString()}
          </time>
        </p>
      )}
      {status !== "ready" && setup && (
        <button type="button" onClick={setup}>
          {t("Nastavit poskytovatele", "Set up provider")}
        </button>
      )}
    </div>
  );
}

export function RunStatus({ run }: { run: Row }) {
  const t = useText(),
    state = runState(run);
  const labels = {
    idle: t("Neaktivní", "Idle"),
    running: t("Běží", "Running"),
    "awaiting-approval": t("Čeká na schválení", "Awaiting approval"),
    stopping: t("Zastavuje se", "Stopping"),
    stopped: t("Zastaven", "Stopped"),
    failed: t("Selhal", "Failed"),
    unknown: t("Výsledek neznámý", "Outcome unknown"),
    paused:
      run.status === "queued"
        ? t("Ve frontě", "Queued")
        : t("Pozastaven", "Paused"),
  };
  return <Badge value={state}>{labels[state]}</Badge>;
}

/**
 * Ledger integrity banner. The server stays authoritative; this only reads
 * the verify endpoint and reports its verdict.
 *
 * B4: the banner shows the verified scope (entries checked, head digest,
 * key id when the server names one, time of the check) and honest progress
 * while the one shot request runs. The last scope is cached per filter
 * query and tied to the head it was verified against: a new head visibly
 * replaces the old line instead of reusing it.
 */
import { useEffect, useState } from "react";
import { ErrorBox, useApi, useText } from "./ui";
import { Icon } from "./icons";
import {
  cacheMatchesHead,
  readCachedVerify,
  verifyScope,
  writeCachedVerify,
  type CachedVerify,
} from "./verify-scope";

export function LedgerVerify({ query }: { query: string }) {
  const t = useText();
  const verify = useApi(
    "/api/ledger/verify" + (query ? "?" + query : ""),
    true,
    30000,
    0,
  );
  const scope = verifyScope(verify.data);
  const [cached, setCached] = useState<CachedVerify | undefined>(() =>
    readCachedVerify(localStorage, query),
  );
  useEffect(() => {
    if (!scope || scope.head === "") return;
    const entry: CachedVerify = {
      query,
      head: scope.head,
      checked: scope.checked,
      at: new Date().toISOString(),
    };
    writeCachedVerify(localStorage, entry);
    setCached(entry);
  }, [query, verify.data]);
  const verified = scope?.verified;
  const fresh = scope !== undefined && scope.head !== "";
  const staleCache =
    cached !== undefined &&
    (!fresh || !cacheMatchesHead(cached, scope?.head ?? ""));
  return (
    <>
      <ErrorBox error={verify.error} />
      {verify.isLoading && !fresh && (
        <p className="ledger-verify" role="status">
          <span className="activity-dot" aria-hidden="true" />{" "}
          {t(
            "Ověřuji ledger, rozsah zatím neznámý…",
            "Verifying the ledger, scope unknown yet…",
          )}
          <progress aria-label={t("Ověřování", "Verifying")} />
        </p>
      )}
      {verified !== undefined && !verified && (
        <p className="ledger-verify warning" role="alert">
          {t(
            "Ledger integrita se nepotvrdila. Data mohou být neúplná.",
            "Ledger integrity unverified. Data may be incomplete.",
          )}
        </p>
      )}
      {scope && (
        <section className="trust-proof" data-proof={scope.proof} aria-live="polite">
          <Icon name={scope.proof === "verified" ? "verified" : scope.proof === "failed" ? "warning" : "more"} />
          <div>
            <span>{t("Důkaz integrity", "Integrity proof")}</span>
            <strong>
              {scope.proof === "verified"
                ? t("Podpis a integrita ověřeny", "Signature and integrity verified")
                : scope.proof === "failed"
                  ? t("Ověření se nezdařilo", "Verification failed")
                  : scope.proof === "partial"
                    ? t("Rozsah důkazu je neúplný", "Proof scope is incomplete")
                    : t("Důkaz není dostupný", "Proof unavailable")}
            </strong>
          </div>
        </section>
      )}
      {fresh && (
        <dl className="ledger-verify-scope" data-verified={String(verified)}>
          <div>
            <dt>{t("Zkontrolováno", "Checked")}</dt>
            <dd>
              {scope.checked === undefined
                ? t("neznámý počet", "unknown count")
                : t(`${scope.checked} záznamů.`, `${scope.checked} entries.`)}
            </dd>
          </div>
          <div>
            <dt>Head</dt>
            <dd>
              <code title={scope.head}>
                {scope.headShort === "" ? "-" : scope.headShort}
              </code>
            </dd>
          </div>
          <div>
            <dt>{t("Podpis", "Signature")}</dt>
            <dd>{scope.signed === true ? t("ověřen", "verified") : scope.signed === false ? t("neověřen", "not verified") : t("neznámý", "unknown")}</dd>
          </div>
          <div>
            <dt>{t("Integrita", "Integrity")}</dt>
            <dd>{scope.integrity === true ? t("ověřena", "verified") : scope.integrity === false ? t("nepotvrzena", "not confirmed") : t("neznámá", "unknown")}</dd>
          </div>
          <div>
            <dt>{t("Klíč", "Key")}</dt>
            <dd>
              {scope.keyId ?? (
                <span className="muted">
                  {t("server klíč neuvedl", "not reported by the server")}
                </span>
              )}
            </dd>
          </div>
          <div>
            <dt>{t("Čas", "Time")}</dt>
            <dd>
              {new Date(
                cached && cacheMatchesHead(cached, scope.head)
                  ? cached.at
                  : Date.now(),
              ).toLocaleString(t("cs-CZ", "en-GB"))}
            </dd>
          </div>
        </dl>
      )}
      {staleCache && (
        <p className="ledger-verify muted" role="status">
          {t(
            `Naposledy ověřeno: ${cached.checked ?? "?"} záznamů, head ${cached.head.slice(0, 20)}… Vztahuje se ke starší hlavě, ne k aktuální.`,
            `Last verified: ${cached.checked ?? "?"} entries, head ${cached.head.slice(0, 20)}… Against an older head, not the current one.`,
          )}
        </p>
      )}
    </>
  );
}

export type LedgerVerifyProps = { query: string };

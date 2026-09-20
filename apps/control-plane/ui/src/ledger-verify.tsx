/** Ledger integrity banner. The server stays authoritative; this only reads
 * the verify endpoint and reports its verdict. */
import { ErrorBox, useApi, useText } from "./ui";

export function LedgerVerify({ query }: { query: string }) {
  const t = useText();
  const verify = useApi(
    "/api/ledger/verify" + (query ? "?" + query : ""),
    true,
    30000,
    0,
  );
  const verified = verify.data?.verified ?? verify.data?.ok;
  return (
    <>
      <ErrorBox error={verify.error} />
      {verified !== undefined && !verified && (
        <p className="ledger-verify warning" role="alert">
          {t(
            "Ledger integrita se nepotvrdila. Data mohou být neúplná.",
            "Ledger integrity unverified. Data may be incomplete.",
          )}
        </p>
      )}
      {verify.data?.checked !== undefined && (
        <p className="ledger-verify muted" role="status">
          {t(
            `Ledger ověřen: ${verify.data.checked} záznamů.`,
            `Ledger verified: ${verify.data.checked} entries.`,
          )}
        </p>
      )}
    </>
  );
}

export type LedgerVerifyProps = { query: string };

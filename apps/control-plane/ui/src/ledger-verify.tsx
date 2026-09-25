import { useState } from "react";
import { api, type Row } from "./api";
import { ErrorBox, JsonDetail, useText } from "./ui";

/**
 * Ledger verify with an honest scope (plan B4).
 *
 * The endpoint answers HTTP 200 in both cases, so `ok` decides the verdict and
 * an error is reserved for a request that produced no payload at all. The
 * result is cached against the head digest: re-verifying a head that has not
 * moved keeps the earlier verdict with its own timestamp instead of presenting
 * a second check that proved nothing new. Hash integrity and signatures are
 * reported as two separate claims, because a hash chain that closes is not an
 * authenticated record (packages/ledger/src/feed.ts says so at the lookup).
 */
type Check = {
  readonly data: Row;
  readonly head: string;
  readonly at: number;
  /** True when the last run returned the same head, so this is the older result. */
  readonly reused: boolean;
};

type Translate = (cs: string, en: string) => string;

export function LedgerVerify({ query }: { query: string }) {
  const t = useText();
  const [busy, setBusy] = useState(false),
    [error, setError] = useState<unknown>(),
    [check, setCheck] = useState<Check>();

  async function run() {
    setBusy(true);
    setError(undefined);
    try {
      // The filter string the table below uses, so the check covers exactly the
      // records on screen rather than another workspace.
      const data = await api("/api/ledger/verify?" + query);
      const head = digest(data.head);
      setCheck((previous) =>
        previous !== undefined && previous.head === head
          ? { ...previous, reused: true }
          : { data, head, at: Date.now(), reused: false },
      );
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }

  const data = check?.data;
  const setup = data !== undefined && data.setup === true;
  const reason = text(data?.reason);
  const genesis = check !== undefined && /^0{64}$/.test(check.head);

  return (
    <div className="verify-block">
      <button className="primary" disabled={busy} onClick={() => void run()}>
        {t("Ověřit ledger", "Verify ledger")}
      </button>
      {busy && (
        <p className="verify-progress" role="status">
          <span>
            {t(
              "Kontrola podpisů a hash řetězce běží…",
              "Checking signatures and the hash chain…",
            )}
          </span>
          {/* No value attribute: the endpoint reports no total, so an
              indeterminate bar is the only honest progress there is. */}
          <progress aria-label={t("Kontrola běží", "Check in progress")} />
        </p>
      )}
      <ErrorBox error={error} />
      {check && (
        <>
          {setup ? (
            <p className="notice" role="status">
              <strong>{t("Ledger zatím neexistuje", "No ledger yet")}</strong>
              {reason ? ": " + reason : null}
            </p>
          ) : (
            <>
              <p>
                <strong>{t("Podpisy", "Signatures")}:</strong>{" "}
                {signatureVerdict(t, data)}
              </p>
              <p>
                <strong>
                  {t("Integrita hash řetězce", "Hash chain integrity")}:
                </strong>{" "}
                {integrityVerdict(t, data)}
              </p>
              {reason && (
                <p className="notice" role="alert">
                  {reason}
                </p>
              )}
            </>
          )}
          <dl className="verify-facts">
            <div>
              <dt>{t("Ověřená sekvence", "Checked sequence")}</dt>
              <dd>{rangeText(t, data)}</dd>
            </div>
            <div>
              <dt>{t("Head digest", "Head digest")}</dt>
              <dd>
                {check.head === "" ? (
                  t("neznámý", "unknown")
                ) : (
                  <code>{check.head}</code>
                )}
                {genesis
                  ? " " +
                    t(
                      "(genesis, zatím bez záznamů)",
                      "(genesis, no entries yet)",
                    )
                  : null}
              </dd>
            </div>
            <div>
              <dt>{t("Klíč kontroly", "Verification key")}</dt>
              <dd>{keyText(t, data)}</dd>
            </div>
            <div>
              <dt>{t("Čas kontroly", "Checked at")}</dt>
              <dd>
                <time dateTime={new Date(check.at).toISOString()}>
                  {new Date(check.at).toLocaleString(t("cs-CZ", "en-GB"))}
                </time>
              </dd>
            </div>
          </dl>
          {check.reused && (
            <p className="notice" role="status">
              {t(
                "Head se nezměnil. Níže je předchozí výsledek s vlastním časem kontroly, ne nová kontrola.",
                "The head is unchanged. Below is the previous result with its own check time, not a new check.",
              )}
            </p>
          )}
          <details>
            <summary>{t("Zdrojová evidence", "Source evidence")}</summary>
            <JsonDetail value={check.data} />
          </details>
        </>
      )}
    </div>
  );
}

/**
 * The endpoint returns a count, not a range. Printing "1" as the first checked
 * sequence would invent a boundary, so the count is stated and the range is
 * reported as unknown until the server sends one.
 */
function rangeText(t: Translate, data: Row | undefined): string {
  const from = sequenceField(data, "from", "seqFrom", "firstSeq");
  const to = sequenceField(data, "to", "seqTo", "lastSeq");
  if (from !== undefined && to !== undefined)
    return `${t("sekvence", "seq")} ${from} to ${to}`;
  const checked = countField(data, "checked");
  return t(
    `neznámé: server vrátil ${checked === undefined ? "?" : checked} zkontrolovaných záznamů, ne rozpětí sekvencí`,
    `unknown: the server returned ${checked === undefined ? "?" : checked} checked entries, not a sequence range`,
  );
}

function signatureVerdict(t: Translate, data: Row | undefined): string {
  if (data?.signed === true) {
    const key = keyId(data);
    if (key === undefined)
      return t(
        "podepsáno, ale server neposlal ID klíče",
        "signed, but the server returned no key id",
      );
    if (key.startsWith("dev-"))
      return t("platné, vývojový klíč", "valid, development key");
    return t(`platné pod klíčem ${key}`, `valid under ${key}`);
  }
  if (data?.signed === false)
    return t(
      "nekontrolováno: server neměl veřejný klíč, ověřena byla jen hash integrita",
      "not checked: the server had no public key, so only hash integrity was checked",
    );
  return t(
    "neznámé: server nevrátil nic o podpisech",
    "unknown: the server returned nothing about signatures",
  );
}

function integrityVerdict(t: Translate, data: Row | undefined): string {
  if (data?.integrity === true)
    return t("řetězec hashů celý", "hash chain intact");
  if (data?.integrity === false)
    return t(
      "selhalo: server našel rozbitý řetězec",
      "failed: the server found a broken chain",
    );
  return t(
    "neznámé: server nevrátil nic o integritě",
    "unknown: the server returned nothing about integrity",
  );
}

function keyText(t: Translate, data: Row | undefined): string {
  const key = keyId(data);
  if (key === undefined)
    return t(
      "neznámé: server neposlal ID klíče",
      "unknown: the server returned no key id",
    );
  return key.startsWith("dev-")
    ? `${key} ${t("(vývojový klíč)", "(development key)")}`
    : key;
}

function keyId(data: Row | undefined): string | undefined {
  const value = data?.keyId ?? data?.key_id ?? data?.key;
  return typeof value === "string" && value.trim() !== ""
    ? value.trim()
    : undefined;
}

function digest(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== ""
    ? value.trim()
    : undefined;
}

function countField(data: Row | undefined, name: string): number | undefined {
  const value = data?.[name];
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function sequenceField(
  data: Row | undefined,
  ...names: string[]
): number | undefined {
  for (const name of names) {
    const value = countField(data, name);
    if (value !== undefined) return value;
  }
  return undefined;
}

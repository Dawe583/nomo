/**
 * Ledger verify scope line and its head tied cache.
 *
 * The verify endpoint answers one shot: checked count plus a head digest
 * string, and no progress events. The scope line therefore renders exactly
 * what the server reported (checked entries, head digest, key id when the
 * server names one, time of the check) and labels anything else unknown.
 * The cache is keyed by the request query and stores the head it was
 * verified against, so a new head visibly invalidates the old line.
 */
import type { Row } from "./api.ts";

export type VerifyScope = {
  readonly checked: number | undefined;
  readonly head: string;
  readonly headShort: string;
  readonly keyId: string | undefined;
  readonly verified: boolean | undefined;
  readonly signed: boolean | undefined;
  readonly integrity: boolean | undefined;
  readonly proof: "verified" | "partial" | "failed" | "unknown";
};

export function verifyScope(data: Row | undefined): VerifyScope | undefined {
  if (data === null || typeof data !== "object" || data === undefined)
    return undefined;
  const rawHead = data.head;
  const head =
    typeof rawHead === "string"
      ? rawHead
      : typeof rawHead === "object" && rawHead !== null
        ? String(
            (rawHead as Row).digest ??
              (rawHead as Row).hash ??
              JSON.stringify(rawHead),
          )
        : "";
  const checked = typeof data.checked === "number" ? data.checked : undefined;
  const keyId =
    typeof data.keyId === "string"
      ? data.keyId
      : typeof data.key_id === "string"
        ? data.key_id
        : undefined;
  const verified =
    typeof data.verified === "boolean"
      ? data.verified
      : typeof data.ok === "boolean"
        ? data.ok
        : undefined;
  const signed = typeof data.signed === "boolean" ? data.signed : undefined;
  const integrity =
    typeof data.integrity === "boolean" ? data.integrity : undefined;
  const proof =
    verified === true && signed === true && integrity === true
      ? "verified"
      : verified === false || signed === false || integrity === false
        ? "failed"
        : verified === true
          ? "partial"
          : "unknown";
  return {
    checked,
    head,
    headShort: head.length > 20 ? head.slice(0, 20) + "…" : head,
    keyId,
    verified,
    signed,
    integrity,
    proof,
  };
}

export type CachedVerify = {
  readonly query: string;
  readonly head: string;
  readonly checked: number | undefined;
  /** Client wall time of the successful check, ISO string. */
  readonly at: string;
};

const CACHE_KEY = "nomo-ledger-verify";

function readAll(
  store: Pick<Storage, "getItem">,
): Record<string, CachedVerify> {
  try {
    const raw = store.getItem(CACHE_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object") return {};
    return parsed as Record<string, CachedVerify>;
  } catch {
    return {};
  }
}

/** Last verified scope for this filter query, whatever its head was. */
export function readCachedVerify(
  store: Pick<Storage, "getItem">,
  query: string,
): CachedVerify | undefined {
  return readAll(store)[query];
}

/** True when the cached entry was verified against this exact head. */
export function cacheMatchesHead(
  cached: CachedVerify | undefined,
  head: string,
): boolean {
  return cached !== undefined && cached.head === head;
}

export function writeCachedVerify(
  store: Pick<Storage, "getItem" | "setItem">,
  entry: CachedVerify,
): void {
  try {
    store.setItem(
      CACHE_KEY,
      JSON.stringify({ ...readAll(store), [entry.query]: entry }),
    );
  } catch {
    // A full or blocked store must never break the verify banner.
  }
}

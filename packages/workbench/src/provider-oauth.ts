/**
 * Explicit OAuth/subscription credential profiles for local provider imports.
 *
 * A profile is a value an importer keeps in memory. It is never written to a
 * diagnostic, a log line or an HTTP response, and it is never sent anywhere by
 * this module: parsing and freshness are the whole contract. `expiresAt` is
 * epoch milliseconds, the form both Prime's `auth.json` and Claude Code's
 * credential file store.
 *
 * There is no refresh lifecycle here. A caller that cannot refresh must report
 * the source unavailable and keep the token unused rather than sending a token
 * it cannot renew, and every consumer must check freshness before use.
 */

/** An OAuth access token with the metadata a transport would need to decide
 * whether it may be sent. Optional members appear only when the source stored
 * them. */
export type ProviderOAuthAuthProfile = {
  readonly kind: "oauth";
  readonly accessToken: string;
  readonly expiresAt: number;
  readonly refreshToken?: string;
  readonly accountId?: string;
};

/** Why a discovered OAuth entry cannot become an importable credential. */
export type ProviderOAuthUnavailableReason =
  | "oauth-entry-malformed"
  | "oauth-expired"
  | "oauth-source-not-supported";

export type ProviderOAuthImport =
  | { readonly status: "ready"; readonly profile: ProviderOAuthAuthProfile }
  | {
      readonly status: "unavailable";
      readonly reason: ProviderOAuthUnavailableReason;
    };

/** An access token is an opaque bearer value: no whitespace, no environment or
 * file references, no command substitution. Same rule the API-key importer
 * applies, because both end up in an Authorization header. */
const MAX_TOKEN_LENGTH = 16_384;
const MAX_ACCOUNT_LENGTH = 256;

function opaqueValue(value: unknown, limit: number): string | undefined {
  if (typeof value !== "string" || value.length === 0 || value.length > limit)
    return undefined;
  if (/\s|\$\{|^!|^\{env:|^\{file:/.test(value)) return undefined;
  return value;
}

function epochMilliseconds(value: unknown): number | undefined {
  return typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value > 0
    ? value
    : undefined;
}

function profile(
  access: unknown,
  expires: unknown,
  refresh: unknown,
  accountId: unknown,
  now: number,
): ProviderOAuthImport {
  const accessToken = opaqueValue(access, MAX_TOKEN_LENGTH);
  const expiresAt = epochMilliseconds(expires);
  if (!accessToken || expiresAt === undefined)
    return { status: "unavailable", reason: "oauth-entry-malformed" };
  let refreshToken: string | undefined;
  if (refresh !== undefined && refresh !== null) {
    refreshToken = opaqueValue(refresh, MAX_TOKEN_LENGTH);
    if (!refreshToken)
      return { status: "unavailable", reason: "oauth-entry-malformed" };
  }
  let account: string | undefined;
  if (accountId !== undefined && accountId !== null) {
    account = opaqueValue(accountId, MAX_ACCOUNT_LENGTH);
    if (!account)
      return { status: "unavailable", reason: "oauth-entry-malformed" };
  }
  // An expired token is never usable: nothing here can renew it.
  if (expiresAt <= now)
    return { status: "unavailable", reason: "oauth-expired" };
  return {
    status: "ready",
    profile: {
      kind: "oauth",
      accessToken,
      expiresAt,
      ...(refreshToken ? { refreshToken } : {}),
      ...(account ? { accountId: account } : {}),
    },
  };
}

function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** Read one Prime `auth.json` OAuth entry:
 * `{ type: "oauth", access, refresh, expires, accountId }`. The entry name is
 * the provider id and is resolved by the caller. */
export function parsePrimeOAuthEntry(
  value: unknown,
  now: number,
): ProviderOAuthImport {
  const entry = object(value);
  if (entry.type !== "oauth")
    return { status: "unavailable", reason: "oauth-entry-malformed" };
  return profile(entry.access, entry.expires, entry.refresh, entry.accountId, now);
}

/** Read the Claude Code subscription credential file:
 * `{ claudeAiOauth: { accessToken, refreshToken, expiresAt } }`. */
export function parseClaudeCodeOAuth(
  value: unknown,
  now: number,
): ProviderOAuthImport {
  const oauth = object(object(value).claudeAiOauth);
  if (!Object.keys(oauth).length)
    return { status: "unavailable", reason: "oauth-entry-malformed" };
  return profile(
    oauth.accessToken,
    oauth.expiresAt,
    oauth.refreshToken,
    undefined,
    now,
  );
}

/** Freshness guard every consumer must pass before sending a token. */
export function oauthProfileFresh(
  profile: ProviderOAuthAuthProfile,
  now: number,
): boolean {
  return (
    Number.isSafeInteger(profile.expiresAt) &&
    profile.expiresAt > now &&
    profile.accessToken.length > 0
  );
}

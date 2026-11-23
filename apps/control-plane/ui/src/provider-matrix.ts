/**
 * The provider source matrix shown in Settings.
 *
 * One row per discovered source, not per vendor: availability belongs to a
 * source, so the same vendor can be importable from one store and unusable from
 * another. The API already reports the auth method and a fixed availability
 * reason (apps/control-plane/api/desktop-setup.ts:publicSource); this module only
 * shapes that report for the table and guarantees that nothing else reaches the
 * screen.
 *
 * A host subscription is a source whose login lives in an installed host CLI.
 * NOMO never reads it, so the row is marked host-only and is never importable,
 * even when the host probe says the host can run the provider.
 */

/** The three ways a discovered source can carry a credential. */
export type ProviderAuthMethod = "api-key" | "oauth" | "host-subscription";

export type ProviderSourceRow = {
  readonly id: string;
  readonly name: string;
  readonly source: string;
  readonly authMethod: ProviderAuthMethod;
  /** The installed host that owns a host-subscription login. */
  readonly host?: string;
  readonly available: boolean;
  /** A fixed availability word. Never a raw server string, path or token. */
  readonly availability: string;
  readonly hostOnly: boolean;
  /** True only when this row can actually become the active provider. */
  readonly importable: boolean;
};

/**
 * Fixed words for the probe and import reasons the API can report. Every value
 * is a description of a state, never an account name, a token or a file path.
 */
const REASON_WORDS: Readonly<Record<string, string>> = {
  "api-key-route-unavailable": "no import route for this API key",
  "host-api-key-only": "host login is API key only, not a subscription",
  "host-login-required": "host login required",
  "host-login-unknown": "host login could not be verified",
  "host-not-installed": "host CLI not installed",
  "host-probe-failed": "host probe failed",
  "host-provider-unavailable": "provider not in the host catalog",
  "oauth-entry-malformed": "OAuth entry malformed",
  "oauth-expired": "OAuth session expired",
  "oauth-source-not-supported": "OAuth source not supported",
  "oauth-transport-unimplemented": "OAuth transport not implemented",
};

/**
 * A future reason code is echoed only when it is a bare code word. A path, a
 * URL, a token or a sentence cannot match this shape, so an unexpected value
 * degrades to a generic word instead of reaching the operator.
 */
const REASON_CODE = /^[a-z][a-z0-9-]{0,63}$/;

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function authMethod(source: Record<string, unknown>): ProviderAuthMethod {
  const declared = source.authMethod;
  if (
    declared === "api-key" ||
    declared === "oauth" ||
    declared === "host-subscription"
  )
    return declared;
  // Older payloads carry the flag but not the method. The host probe reason is
  // the remaining signal, because discovery reports an OAuth entry only through
  // an oauth-prefixed reason.
  if (source.hostOnly === true) return "host-subscription";
  return text(source.reason).startsWith("oauth") ? "oauth" : "api-key";
}

function availability(
  available: boolean,
  reason: string,
): string {
  if (available) return "available";
  if (!reason) return "unavailable";
  const word =
    REASON_WORDS[reason] ??
    (REASON_CODE.test(reason) ? reason : "unknown reason");
  return `unavailable: ${word}`;
}

/** Shape the discovered sources into the Settings matrix rows. */
export function providerMatrix(sources: readonly unknown[]): ProviderSourceRow[] {
  const rows: ProviderSourceRow[] = [];
  for (const value of sources) {
    const source = record(value);
    const id = text(source?.id);
    if (!source || !id) continue;
    const method = authMethod(source);
    const hostOnly = source.hostOnly === true || method === "host-subscription";
    const available = source.available === true;
    const host = text(source.host);
    rows.push({
      id,
      name: text(source.name) || id,
      source: text(source.source),
      authMethod: method,
      ...(hostOnly && host ? { host } : {}),
      available,
      availability: availability(available, text(source.reason)),
      hostOnly,
      // A host subscription has no token this application may read, so it is
      // never importable regardless of what the probe reports.
      importable: available && method === "api-key",
    });
  }
  return rows;
}

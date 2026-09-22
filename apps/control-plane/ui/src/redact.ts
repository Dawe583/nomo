/**
 * Secret redaction for rendered evidence.
 *
 * Tool payloads and approval records pass through connector output the UI
 * must treat as untrusted. A value that looks like a credential must never
 * reach the DOM in cleartext, even inside a collapsed detail block, because
 * copy and screenshot carry it further. Redaction is display only; the
 * server record is untouched.
 */
export const REDACTED = "[redacted]";

/** Key parts that mark a value as credential bearing. Compared against the
 * parts of one key name, never against free text, so "keyboard" stays. */
const SECRET_PARTS = new Set([
  "token",
  "tokens",
  "secret",
  "secrets",
  "password",
  "passwd",
  "pwd",
  "apikey",
  "accesskey",
  "clientsecret",
  "apisecret",
  "authorization",
  "credential",
  "credentials",
  "privatekey",
  "bearer",
  "cookie",
  "cookies",
  "setcookie",
  "sessiontoken",
  "refreshtoken",
  "idtoken",
  "accesstoken",
  "auth",
  "key",
]);

/** Split one key name into lowercase parts on separators and case changes. */
export function keyParts(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[^A-Za-z0-9]+/)
    .map((part) => part.toLowerCase())
    .filter((part) => part.length > 0);
}

/** True when the key name itself claims the value is a credential. */
export function isSecretKey(name: string): boolean {
  return keyParts(name).some((part) => SECRET_PARTS.has(part));
}

/** Bearer tokens, well known API key prefixes, and basic auth userinfo. */
const SECRET_VALUE =
  /\b(bearer\s+[A-Za-z0-9\-._~+/=]{8,}|sk-(live|test)-[A-Za-z0-9]{8,}|xox[bpras]-[A-Za-z0-9-]{8,}|gh[pousr]_[A-Za-z0-9]{8,}|AKIA[0-9A-Z]{16})\b/gi;

/** Redact userinfo passwords in URLs: scheme://user:pass@host keeps the user. */
function redactUrlAuth(text: string): string {
  return text.replace(
    /([a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^/\s:@]+:)[^/\s@]+(@)/g,
    `$1${REDACTED}$2`,
  );
}

function redactText(text: string): string {
  SECRET_VALUE.lastIndex = 0;
  const masked = SECRET_VALUE.test(text)
    ? text.replace(SECRET_VALUE, REDACTED)
    : text;
  return redactUrlAuth(masked);
}

const MAX_DEPTH = 50;

/**
 * Deep clone with secret looking values replaced by "[redacted]".
 * Never mutates the input. Cycles are preserved by identity through a
 * side table. Non plain values (Date, Map, class instances) pass by
 * reference; only plain objects, arrays and strings are rewritten.
 */
export function redactValue(
  value: unknown,
  seen: Map<object, object> = new Map(),
  depth = 0,
): unknown {
  if (typeof value === "string") return redactText(value);
  if (value === null || typeof value !== "object") return value;
  if (depth >= MAX_DEPTH) return REDACTED;
  const known = seen.get(value);
  if (known !== undefined) return known;
  if (Array.isArray(value)) {
    const out: unknown[] = [];
    seen.set(value, out);
    for (const item of value) out.push(redactValue(item, seen, depth + 1));
    return out;
  }
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return value;
  const out: Record<string, unknown> = {};
  seen.set(value, out);
  for (const [name, item] of Object.entries(value)) {
    // A secret named key redacts wholesale: nested credential objects often
    // carry their secret under an odd inner name, and this is display only.
    out[name] = isSecretKey(name)
      ? REDACTED
      : redactValue(item, seen, depth + 1);
  }
  return out;
}

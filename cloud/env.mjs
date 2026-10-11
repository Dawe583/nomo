/**
 * NOMO first lookup for the `VOID_*` names the hosted runtime still answers to.
 *
 * The product was renamed. The names an operator typed into a shell, a launch
 * agent, a systemd unit or a `.env` file were not renamed with it, and a
 * machine configured before the rename keeps those settings. Reading only
 * `NOMO_*` therefore reports an unconfigured product on a configured machine,
 * which looks like data loss and loses nothing: the operator's settings are
 * still there under the old names.
 *
 * The rule is deliberately one line. A `NOMO_*` name that is present wins,
 * including when its value is the empty string, because an operator who
 * exported an empty value chose it and a silent fallback to the legacy value
 * would run with a setting nobody typed. Only an absent `NOMO_*` name falls
 * back to the matching `VOID_*` name.
 *
 * This is the plain Node ESM twin of `packages/ledger/src/env-compat.ts`. It
 * exists because the hosted runtime is deployed and debugged as `.mjs` and
 * cannot import a TypeScript package, and because two copies of one rule drift.
 * The rule itself is duplicated, not the reasoning: this comment is the single
 * statement of why it reads the way it does, and the tests below pin every
 * clause of it.
 *
 * Every lookup is a pure function over an injected object. Nothing here reads
 * `process.env` by itself, nothing writes to the object it is given and nothing
 * prints a value, so the seal keys, the control token and the bridge token
 * resolve the same way as the public origin and no call site has to remember to
 * redact. Callers that want a blank or untrimmed value treated as absent layer
 * that on top: this module answers "which name is set", not "is it usable".
 */

export const NOMO_ENV_PREFIX = "NOMO_";
export const LEGACY_ENV_PREFIX = "VOID_";

/**
 * The legacy spelling of `nomoKey`, or a thrown error when the key is not an
 * owned name.
 *
 * Refusing a key that does not start with `NOMO_` is what stops this from
 * silently aliasing an unrelated variable: `VOID_HOME` would otherwise answer a
 * lookup for a `HOME` the product does not own, and a helper that guessed would
 * change what the process reads without anyone choosing it.
 */
export function legacyEnvKey(nomoKey) {
  if (!nomoKey.startsWith(NOMO_ENV_PREFIX)) {
    throw new Error(`env-compat: key must start with ${NOMO_ENV_PREFIX}, got ${nomoKey}`);
  }
  return `${LEGACY_ENV_PREFIX}${nomoKey.slice(NOMO_ENV_PREFIX.length)}`;
}

/**
 * Read `nomoKey` from `env`, falling back to its legacy spelling.
 *
 * The input is never written to, so a caller holding a frozen or shared
 * `process.env` snapshot gets the same answer as everybody else.
 */
export function envValue(env, nomoKey) {
  const current = env[nomoKey];
  if (current !== undefined) return current;
  return env[legacyEnvKey(nomoKey)];
}

/**
 * Return `env` with every listed legacy value also present under its `NOMO_*`
 * name, for entry points that cannot thread an injected environment through
 * every call.
 *
 * The returned object is the source itself when there is nothing to add, so the
 * common path allocates nothing and a caller can assert identity. A key that
 * already resolves to a `NOMO_*` value is not rewritten, and a key that is
 * absent under both spellings is not invented.
 */
export function normalizeEnv(env, keys) {
  let result;
  for (const key of keys) {
    if (env[key] !== undefined) continue;
    const legacy = env[legacyEnvKey(key)];
    if (legacy === undefined) continue;
    result ??= { ...env };
    result[key] = legacy;
  }
  return result ?? env;
}

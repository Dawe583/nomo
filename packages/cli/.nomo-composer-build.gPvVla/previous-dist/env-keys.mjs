/**
 * NOMO first lookup for the owned `VOID_*` configuration names.
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
 * This is a pure lookup over an injected object. It never reads `process.env`
 * itself, never mutates the object it is given and never prints a value, so
 * the secret carrying names resolve the same way as the rest and no call site
 * has to remember to redact.
 */

/** An environment key this product owns, and whose legacy spelling it aliases. */
                                          
/** The prefix an owned key must carry for the legacy fallback to apply. */
const NOMO_ENV_PREFIX = "NOMO_";
/** The prefix the same key carried before the rename. */
const LEGACY_ENV_PREFIX = "VOID_";

/**
 * The legacy spelling of `nomoKey`, or a thrown error when the key is not an
 * owned name.
 *
 * Refusing a key that does not start with `NOMO_` is what stops this from
 * silently aliasing an unrelated variable: `VOID_HOME` would otherwise answer
 * a lookup for a `HOME` the product does not own.
 */
function legacyEnvKey(nomoKey        )         {
  if (!nomoKey.startsWith(NOMO_ENV_PREFIX))
    throw new Error(`env-compat: key must start with ${NOMO_ENV_PREFIX}, got ${nomoKey}`);
  return `${LEGACY_ENV_PREFIX}${nomoKey.slice(NOMO_ENV_PREFIX.length)}`;
}

/**
 * Read `nomoKey` from `env`, falling back to its legacy spelling.
 *
 * The input is never written to. Callers holding a frozen or shared
 * `process.env` snapshot get the same answer as everybody else.
 */
function envValue(
  env                                              ,
  nomoKey            ,
)                     {
  const current = env[nomoKey];
  if (current !== undefined) return current;
  return env[legacyEnvKey(nomoKey)];
}

/**
 * Return `env` with every listed legacy value also present under its `NOMO_*`
 * name, so code that reads only the current spelling sees the same
 * configuration.
 *
 * This is the boundary form for entry points that cannot thread an injected
 * environment through every call: one normalization before dispatch, and every
 * reader below it keeps its single `NOMO_*` lookup. The returned object is the
 * source itself when there is nothing to add, so the common path allocates
 * nothing and a test can assert identity.
 *
 * Unrelated keys are never touched, and a key that already resolves to a
 * `NOMO_*` value is not rewritten.
 */
function normalizeEnv                                              (
  env   ,
  keys                       ,
)              {
  let result                                                ;
  for (const key of keys) {
    if (env[key] !== undefined) continue;
    const legacy = env[legacyEnvKey(key)];
    if (legacy === undefined) continue;
    result ??= { ...env };
    result[key] = legacy;
  }
  return (result ?? env)               ;
}

/**
 * Every operator-configurable setting the product owns, and whose legacy
 * spelling it therefore aliases.
 *
 * The list is the answer to "which names do we own", and a list rather than a
 * scan because a scan would alias everything: `PATH`, `HOME` and `TERM` are
 * not ours, `VOID_HOME` is a spelling of a variable we never owned, and a
 * helper that guessed would silently change what the process reads.
 *
 * Absent on purpose are the names a process passes to its own children for one
 * call rather than settings an operator configures: the hook context
 * (`NOMO_HOOK_EVENT`, `NOMO_HOOK_TOOL`, and the rest), the exercise keys the
 * reverse harness mints for itself, and the env probe. Each has a known
 * writer inside a single run, so a second spelling would only be another name
 * to keep in step.
 */
const OWNED_ENV_KEYS                        = [
  "NOMO_APPROVALS_DIR",
  "NOMO_DATA_DIR",
  "NOMO_EXPORT_DIR",
  "NOMO_FACTS_PATH",
  "NOMO_HOME",
  "NOMO_HOOK_COMMANDS",
  "NOMO_HOOK_TIMEOUT_MS",
  "NOMO_LEDGER_DIR",
  "NOMO_MODEL",
  "NOMO_PALETTE",
  "NOMO_PERMISSION_MODE",
  "NOMO_PG_URL",
  "NOMO_POLICY_PATH",
  "NOMO_PROVIDER_URL",
  "NOMO_PROXY_KEYS",
  "NOMO_S3_ENABLED",
  "NOMO_S3_ENDPOINT",
  "NOMO_SIGNING_KEY",
  "NOMO_TUI_COLOR",
  "NOMO_TUI_EDITOR",
  "NOMO_TUI_MOTION",
  "NOMO_TUI_SYMBOLS",
  "NOMO_TUI_THEME",
  "NOMO_UPSTREAM_COMMAND",
  "NOMO_VAULT_KEY",
  "NOMO_VERIFY_ALLOW_SIGNING_KEY",
  "NOMO_VERIFY_KEY",
  "NOMO_VERIFY_KEY_FILE",
  "NOMO_TRUST_DIR",
  "NOMO_WORKSPACE",
  "NOMO_WORKSPACE_KEY",
];

/**
 * Return `env` with every legacy owned value also present under its current
 * name.
 *
 * This is the boundary form for entry points that cannot thread an injected
 * environment through every call: one normalization before dispatch, and every
 * reader below keeps its single `NOMO_*` lookup. The returned object is the
 * source itself when there is nothing to add, so the common path allocates
 * nothing and a test can assert identity.
 */
function normalizeOwnedEnv(
  env                    = process.env,
)                              {
  return normalizeEnv(env, OWNED_ENV_KEYS);
}


//# sourceURL=packages/ledger/src/env-compat.ts

export { OWNED_ENV_KEYS, envValue, legacyEnvKey, normalizeEnv, normalizeOwnedEnv };

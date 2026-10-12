/** NOMO-first aliases for product-owned settings, not child-process environment copying. */
export const OWNED_NOMO_ENV_KEYS = Object.freeze(
  [
  "NOMO_ACCOUNT_SEAL_KEY",
  "NOMO_ACCOUNT_SIGNUP",
  "NOMO_APPROVALS_DIR",
  "NOMO_AUTH_SEAL_KEY",
  "NOMO_BRIDGE_TOKEN",
  "NOMO_COMPANION_DIR",
  "NOMO_COMPANION_WRITE_PAIRING",
  "NOMO_CONTROL_HOST",
  "NOMO_CONTROL_ORIGIN",
  "NOMO_CONTROL_TOKEN",
  "NOMO_DATABASE_URL",
  "NOMO_DATA_DIR",
  "NOMO_DEMO_NVIDIA_KEY",
  "NOMO_EXPORT_DIR",
  "NOMO_FACTS_PATH",
  "NOMO_HOME",
  "NOMO_HOOK_COMMANDS",
  "NOMO_HOOK_TIMEOUT_MS",
  "NOMO_LEDGER_DIR",
  "NOMO_MODEL",
  "NOMO_PERMISSION_MODE",
  "NOMO_PG_URL",
  "NOMO_POLAR_ACCESS_TOKEN",
  "NOMO_POLAR_ENVIRONMENT",
  "NOMO_POLAR_ORGANIZATION_ID",
  "NOMO_POLAR_PRODUCT_TEAM",
  "NOMO_POLAR_WEBHOOK_SECRET",
  "NOMO_POLICY_PATH",
  "NOMO_PROJECT_RECOVERY_KEY",
  "NOMO_PROVIDER_URL",
  "NOMO_PROXY_KEYS",
  "NOMO_PUBLIC_DEMO",
  "NOMO_PUBLIC_ORIGIN",
  "NOMO_RECOVERY_KEY",
  "NOMO_S3_ENABLED",
  "NOMO_S3_ENDPOINT",
  "NOMO_SECRET_KEY",
  "NOMO_SIGNING_KEY",
  "NOMO_SNAPSHOT_DIR",
  "NOMO_TRUST_DIR",
  "NOMO_TUI_COLOR",
  "NOMO_TUI_EDITOR",
  "NOMO_TUI_MOTION",
  "NOMO_UPSTREAM_COMMAND",
  "NOMO_VERIFY_ALLOW_SIGNING_KEY",
  "NOMO_VERIFY_KEY",
  "NOMO_VERIFY_KEY_FILE",
  "NOMO_WORKSPACE",
  "NOMO_WORKSPACE_KEY",
  ] as const,
);

export type OwnedNomoEnvKey = (typeof OWNED_NOMO_ENV_KEYS)[number];
export type Environment = Readonly<Record<string, string | undefined>>;

const NOMO_PREFIX = "NOMO_";
const VOID_PREFIX = "VOID_";

const isOwnedNomoEnvKey = (name: string): name is OwnedNomoEnvKey =>
  (OWNED_NOMO_ENV_KEYS as readonly string[]).includes(name);

const readOwnEnvValue = (env: Environment, name: string): string | undefined =>
  Object.hasOwn(env, name) ? env[name] : undefined;

export function legacyEnvKey(nomoKey: string): string {
  if (!nomoKey.startsWith(NOMO_PREFIX))
    throw new Error("NOMO environment name must start with NOMO_");
  return `${VOID_PREFIX}${nomoKey.slice(NOMO_PREFIX.length)}`;
}

/** A selected value includes the actual variable name used. */
export type ConfiguredEnvEntry = Readonly<{ name: string; value: string }>;

/** Resolve an allowlisted name without changing the supplied environment. */
export function configuredEnvEntry(env: Environment, name: string): ConfiguredEnvEntry | undefined {
  const nomoKey = name.startsWith(NOMO_PREFIX)
    ? name
    : name.startsWith(VOID_PREFIX)
      ? `${NOMO_PREFIX}${name.slice(VOID_PREFIX.length)}`
      : undefined;
  if (nomoKey === undefined || !isOwnedNomoEnvKey(nomoKey)) {
    const value = readOwnEnvValue(env, name);
    return value === undefined ? undefined : { name, value };
  }
  const current = readOwnEnvValue(env, nomoKey);
  if (current !== undefined) return { name: nomoKey, value: current };
  const legacyName = legacyEnvKey(nomoKey);
  const legacy = readOwnEnvValue(env, legacyName);
  return legacy === undefined ? undefined : { name: legacyName, value: legacy };
}

/** An explicitly empty NOMO value is selected and must not fall back to VOID. */
export function envValue(env: Environment, nomoKey: OwnedNomoEnvKey): string | undefined {
  if (!isOwnedNomoEnvKey(nomoKey))
    throw new Error(`${nomoKey} is not an owned NOMO environment name`);
  return configuredEnvEntry(env, nomoKey)?.value;
}

export function configuredEnvValue(env: Environment, name: string): string | undefined {
  return configuredEnvEntry(env, name)?.value;
}

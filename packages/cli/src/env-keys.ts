/**
 * The CLI's environment boundary.
 *
 * The owned key list and the lookup itself live in `@void/ledger` so the CLI,
 * the Workbench, the hosted runtime and the native clients cannot drift into
 * four different answers to "which settings does this product own". This
 * module is only the CLI's use of them.
 */
export {
  OWNED_ENV_KEYS,
  envValue,
  legacyEnvKey,
  normalizeEnv,
  normalizeOwnedEnv,
  type NomoEnvKey,
} from "../../ledger/src/env-compat.ts";
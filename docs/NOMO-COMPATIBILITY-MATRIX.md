# NOMO and VOID compatibility matrix

**Status:** Implementation contract for Milestone C, 2026-10-11

This matrix freezes the compatibility rules. It does not claim that public `@nomo/*` packages or the `nomo` command have shipped. Existing names remain supported until the matching NOMO replacement is released and verified.

## Environment names

Only the product-owned settings listed here receive a prefix alias. The suffix stays unchanged. A defined `NOMO_*` value wins over its paired `VOID_*` value, including an empty string. Only an absent `NOMO_*` value falls back. Consumer-specific validation treats the selected empty value as invalid or unconfigured; it never uses that as a reason to retry the `VOID_*` value.

Alias lookup is pure. It does not mutate `process.env`, print values, or copy resolved values to child processes. This matters because hooks and upstream processes can inherit their parent environment. Secret values must remain out of those child environments unless a separate contract requires them.

| Surface | NOMO name | VOID compatibility name |
| --- | --- | --- |
| CLI, Workbench, ledger | `NOMO_APPROVALS_DIR`, `NOMO_DATA_DIR`, `NOMO_EXPORT_DIR`, `NOMO_FACTS_PATH`, `NOMO_HOME`, `NOMO_HOOK_COMMANDS`, `NOMO_HOOK_TIMEOUT_MS`, `NOMO_LEDGER_DIR`, `NOMO_MODEL`, `NOMO_PERMISSION_MODE`, `NOMO_PG_URL`, `NOMO_POLICY_PATH`, `NOMO_PROVIDER_URL`, `NOMO_PROXY_KEYS`, `NOMO_S3_ENABLED`, `NOMO_S3_ENDPOINT`, `NOMO_SIGNING_KEY`, `NOMO_TRUST_DIR`, `NOMO_TUI_COLOR`, `NOMO_TUI_EDITOR`, `NOMO_TUI_MOTION`, `NOMO_UPSTREAM_COMMAND`, `NOMO_VERIFY_ALLOW_SIGNING_KEY`, `NOMO_VERIFY_KEY`, `NOMO_VERIFY_KEY_FILE`, `NOMO_WORKSPACE`, `NOMO_WORKSPACE_KEY` | Same suffix with `VOID_` prefix |
| Control plane and Companion | `NOMO_COMPANION_DIR`, `NOMO_COMPANION_WRITE_PAIRING`, `NOMO_CONTROL_HOST`, `NOMO_CONTROL_ORIGIN`, `NOMO_CONTROL_TOKEN`, `NOMO_SNAPSHOT_DIR` | Same suffix with `VOID_` prefix |
| Cloud account, demo, and billing | `NOMO_ACCOUNT_SEAL_KEY`, `NOMO_ACCOUNT_SIGNUP`, `NOMO_AUTH_SEAL_KEY`, `NOMO_BRIDGE_TOKEN`, `NOMO_DEMO_NVIDIA_KEY`, `NOMO_POLAR_ACCESS_TOKEN`, `NOMO_POLAR_ENVIRONMENT`, `NOMO_POLAR_ORGANIZATION_ID`, `NOMO_POLAR_PRODUCT_TEAM`, `NOMO_POLAR_WEBHOOK_SECRET`, `NOMO_PUBLIC_DEMO`, `NOMO_PUBLIC_ORIGIN`, `NOMO_SECRET_KEY` | Same suffix with `VOID_` prefix |
| Recovery configuration fields that name an environment variable | `NOMO_DATABASE_URL`, `NOMO_RECOVERY_KEY`, `NOMO_PROJECT_RECOVERY_KEY` | `VOID_DATABASE_URL`, `VOID_RECOVERY_KEY`, `VOID_PROJECT_RECOVERY_KEY` |

`NOMO_HOME` names the installed CLI tree. It is not the user state directory. `NOMO_DATA_DIR` names the Workbench data directory. Recovery configuration may name any environment key in `encryptionKeyEnv` or `postgres.urlEnv`. Existing examples use `VOID_RECOVERY_KEY`, `VOID_PROJECT_RECOVERY_KEY`, and `VOID_DATABASE_URL`. These are names, not secret values. When a configured name matches a pair in this matrix, lookup uses NOMO precedence even if the config still spells the legacy name. Other names are read exactly as written. Standard variables such as `HOME`, `PATH`, `TERM`, `NODE_ENV`, `DATABASE_URL`, `AWS_*`, `APPWRITE_*`, `NVIDIA_API_KEY`, and `OPENROUTER_API_KEY` keep their current names.

Generated process values are not configuration aliases. This includes the hook invocation fields `VOID_HOOK_EVENT`, `VOID_HOOK_ID`, `VOID_HOOK_TOOL`, `VOID_HOOK_DECISION`, and `VOID_HOOK_OUTCOME`; Windows ACL probe fields; exercise keys; and test, build, and QA variables. `VOID_DESKTOP_WEB_ROOT` and `VOID_DISTRIBUTION` remain internal launch and build fields. Names found only in old documentation without an active reader, including `VOID_LEDGER_URL` and `VOID_MCP_ENDPOINT`, are not supported configuration keys and must not be introduced by this migration.

## Package imports

| Stage | Canonical name | Compatibility rule |
| --- | --- | --- |
| Current private workspace | `@void/*` | Keep current workspace imports. Do not rename private packages in place during this task. |
| First public NOMO release | `@nomo/*` | Publish canonical NOMO packages first. Publish `@void/*` compatibility wrappers only after their matching NOMO package exists; wrappers forward to NOMO and never reverse the dependency. |
| Later breaking release | `@nomo/*` | Remove a legacy wrapper only in a separately versioned breaking release with a migration notice. |

Keep the current private `@void/*` workspace names during this task. At public release, publish the canonical `@nomo/*` package before its `@void/*` compatibility wrapper, then move consumers only after a fresh install test resolves both names. The source currently has a `connectors` and `runtime` dependency cycle; resolve or bundle that boundary before publishing either package. Verify package-scope ownership, licensing, and publish access before release. No package rename or publication is part of this task.

## CLI commands and install tree

`nomo` is the target command. `void` remains an alias to the same implementation. `nomo-proxy` is the target standalone proxy command; `void-proxy` remains its alias. The `nomo verify` subcommand replaces no separate binary. Existing install scripts and launchers continue to work until a versioned migration provides the new names.

`NOMO_HOME` wins over `VOID_HOME`, including when explicitly empty. An empty selected path is rejected with a clear error, not treated as absent. The existing install-tree default remains unchanged until the installer migration is verified. The `VOID_HOME` installer variable never selects the `.void` or `.nomo` user state directory.

## User state and migration

The canonical state root for a new install is `~/.nomo`. The legacy root is `~/.void`. Existing state is not copied or deleted at startup.

| `~/.nomo` | `~/.void` | Runtime choice |
| --- | --- | --- |
| Absent | Absent | Use `~/.nomo` for a new install. |
| Absent | Present | Continue using `~/.void`; preserve current reads and writes until explicit migration. |
| Present | Absent | Use `~/.nomo`. |
| Present with a valid migration marker | Present | Use `~/.nomo`; leave `~/.void` untouched as an inactive source copy. |
| Present without a valid migration marker | Present | Refuse startup with a conflict message. Do not guess which tree is current. |

Migration is an explicit `nomo state migrate` operation. Version 1 copies the complete `.void` tree to a same-filesystem staging directory. It rejects symlinks and special files instead of following or copying them. It validates supported encrypted state and every supported ledger, then compares canonical manifests of the source and staged copy. The manifest contains each regular file's relative path, byte size, and SHA-256 digest. A versioned marker stores that manifest digest; the marker itself is excluded from the digest. Publish the validated tree atomically without replacing any existing path. If a destination appears after the initial check, refuse rather than overwrite it. Until publication, the resolver refuses an unmarked `.nomo` when `.void` exists. Migration never deletes or edits `.void`. A failed validation or install leaves `.void` intact and never makes a partial `.nomo` tree active.

The resolver accepts the marker only when its format is valid and its stored digest matches the installed destination tree. An existing `.nomo` tree with a missing, malformed, or mismatched marker is not proof of completed migration when `.void` also exists. The operator must inspect and reconcile both trees before retrying.

An explicit `NOMO_DATA_DIR` or `VOID_DATA_DIR` remains an operator-selected path and is not relocated by default-root migration. NOMO precedence applies to that pair. Custom ledger, key, trust, approval, and Companion directories follow the same explicit-path rule and are never copied unless the operator selects a future migration that names them.

## Ledger data

Migration copies ledger bytes, file names, workspace names, key files, and trust files without rewriting, re-signing, or changing record order. It validates the hash chain and signatures using the existing verifier and the configured trust material. Invalid or unverifiable signed history blocks installation. Legacy unsigned history remains byte-preserved and is reported as unauthenticated; migration never upgrades its trust claim. The source ledger remains available in `.void` after a successful migration.

## Required tests

Use `node:test` to prove NOMO precedence, VOID fallback, empty-value precedence, and no mutation of the input environment. Test the path-choice table, valid and invalid markers, encrypted-state validation, signed-ledger validation, atomic install failure, destination conflict, idempotent retry, and byte-for-byte source preservation. Tests use temporary directories and synthetic keys only. Never run migration against a user's home directory during verification.

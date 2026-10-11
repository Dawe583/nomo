# NOMO naming and state migration contract

**Status:** Approved product rename contract for Milestone C, 2026-10-11

NOMO is the only active product identity. Current commands, workspace packages,
public code APIs, environment names, generated process values, app identifiers,
build files and active documentation must use NOMO. Do not ship old command
aliases, `VOID_*` environment aliases, `@void/*` wrappers or API aliases. The
rename is intentionally breaking; no compatibility layer is planned for those
surfaces.

The only active legacy product path is the explicit migration source
`~/.void`. Historical decision records and dated evidence keep their original
wording. Do not rename the TypeScript `void` type or a third-party domain action
such as Stripe's `invoice.void`.

## Environment names

Product-owned configuration uses these canonical names. Code reads the NOMO
name only. An old `VOID_*` value never acts as a fallback. An explicitly empty
NOMO value remains selected and is handled by the setting's validation rules.
Standard operating-system and provider variables keep their standard names.

| Surface | Canonical NOMO names |
| --- | --- |
| CLI, Workbench and ledger | `NOMO_APPROVALS_DIR`, `NOMO_DATA_DIR`, `NOMO_EXPORT_DIR`, `NOMO_FACTS_PATH`, `NOMO_HOME`, `NOMO_HOOK_COMMANDS`, `NOMO_HOOK_TIMEOUT_MS`, `NOMO_LEDGER_DIR`, `NOMO_MODEL`, `NOMO_PERMISSION_MODE`, `NOMO_PG_URL`, `NOMO_POLICY_PATH`, `NOMO_PROVIDER_URL`, `NOMO_PROXY_KEYS`, `NOMO_S3_ENABLED`, `NOMO_S3_ENDPOINT`, `NOMO_SIGNING_KEY`, `NOMO_TRUST_DIR`, `NOMO_TUI_COLOR`, `NOMO_TUI_EDITOR`, `NOMO_TUI_MOTION`, `NOMO_UPSTREAM_COMMAND`, `NOMO_VERIFY_ALLOW_SIGNING_KEY`, `NOMO_VERIFY_KEY`, `NOMO_VERIFY_KEY_FILE`, `NOMO_WORKSPACE`, `NOMO_WORKSPACE_KEY` |
| Control plane and Companion | `NOMO_COMPANION_DIR`, `NOMO_COMPANION_WRITE_PAIRING`, `NOMO_CONTROL_HOST`, `NOMO_CONTROL_ORIGIN`, `NOMO_CONTROL_TOKEN`, `NOMO_SNAPSHOT_DIR` |
| Cloud account, demo and billing | `NOMO_ACCOUNT_SEAL_KEY`, `NOMO_ACCOUNT_SIGNUP`, `NOMO_AUTH_SEAL_KEY`, `NOMO_BRIDGE_TOKEN`, `NOMO_DEMO_NVIDIA_KEY`, `NOMO_POLAR_ACCESS_TOKEN`, `NOMO_POLAR_ENVIRONMENT`, `NOMO_POLAR_ORGANIZATION_ID`, `NOMO_POLAR_PRODUCT_TEAM`, `NOMO_POLAR_WEBHOOK_SECRET`, `NOMO_PUBLIC_DEMO`, `NOMO_PUBLIC_ORIGIN`, `NOMO_SECRET_KEY` |
| Recovery configuration fields that name an environment variable | `NOMO_DATABASE_URL`, `NOMO_RECOVERY_KEY`, `NOMO_PROJECT_RECOVERY_KEY` |

`NOMO_HOME` selects the installed CLI tree. `NOMO_DATA_DIR` selects the
Workbench data directory. Recovery config fields such as `encryptionKeyEnv`
and `postgres.urlEnv` must name their current NOMO variable explicitly. They do
not translate old names. Generated hook fields, Windows ACL probes, test
fixtures, exercise keys and build settings must also use NOMO names; they are
not fallback aliases.

Standard names such as `HOME`, `PATH`, `TERM`, `NODE_ENV`, `DATABASE_URL`,
`AWS_*`, `APPWRITE_*`, `NVIDIA_API_KEY` and `OPENROUTER_API_KEY` are not renamed.
Child processes receive only the values required by their contract. A launcher
may reject inherited legacy `VOID_*` entries before spawning a child, but this is
deny-only: it never reads them as configuration or forwards them. Negative
security tests may name old keys to prove rejection. Never copy resolved secrets
into a child environment merely to support an old name.

## Workspace packages and APIs

All workspace package names and internal imports use `@nomo/*`. The root
workspace name is `@nomo/workspace`. Public exports and product-owned types,
functions, error names and schemas use `Nomo` naming. Remove the old package
scope and symbol names in the same change as their consumers. Do not publish
compatibility wrapper packages. Package publication and scope ownership remain
separate release checks; this rename does not publish anything.

## Commands and install tree

The supported command names are `nomo`, `nomo-proxy` and `nomo-verify`.
`nomo verify` remains the integrated verifier subcommand. Remove old binaries,
script aliases, installer names and help text. `NOMO_HOME` is the only product
variable for the install tree; an empty selected value is rejected rather than
silently defaulted.

## Other product identifiers

Current tool names, serialized product schema names, runtime IDs, UI labels,
Swift symbols, package metadata, temporary-file prefixes and storage prefixes
use NOMO when they identify this product. Third-party names and language
constructs remain unchanged. Historical documents retain their original text.
Signed ledger bytes are evidence and must never be rewritten during migration;
copy them byte-for-byte and verify their signatures. New records use NOMO names.

## User state and migration

New installs use `~/.nomo`. Product defaults for workspace data, ledgers, keys,
approvals, trust and exports resolve beneath the NOMO state root unless the
corresponding explicit `NOMO_*` path is set. Startup never reads or writes
`~/.void`.

| `~/.nomo` | `~/.void` | Runtime behavior |
| --- | --- | --- |
| Absent | Absent | Create or use `~/.nomo`. |
| Present | Absent | Use `~/.nomo`. |
| Absent | Present | Fail closed and instruct the operator to run the explicit migration. Do not read or write the source. |
| Present with a valid migration marker | Present | Use `~/.nomo`; leave `~/.void` unchanged. |
| Present without a valid marker | Present | Fail closed as an ambiguous dual-root state. |

The explicit command `nomo state migrate` copies the legacy tree to a temporary
location, rejects symlinks and special files, validates encrypted Workbench
state and signed ledgers, and writes a canonical manifest over relative paths
and file bytes. It installs into an absent destination without overwriting,
rechecks the destination manifest, and writes a versioned marker last. The
source is never deleted or changed. A retry is safe only when the marker and
manifest validate. An interrupted or conflicting migration stops without
activating a partial destination. A custom legacy source requires an explicit
migration option; no old environment variable selects it.

## Identifier and history boundaries

Product-owned names in active source, tests, manifests, generated files,
commands, deployment config and current documentation use NOMO. Preserve
historical records as records. Preserve language-level `void` and third-party
operation names when they are not product identifiers. Keep `.void` only in
the explicit state migration implementation, its tests and safety rules that
protect the source from overwrite or deletion. A deny-only child-environment
scrub and its negative tests may reject old `VOID_*` inputs; they must never
interpret or forward those values.

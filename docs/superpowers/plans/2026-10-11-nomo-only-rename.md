# NOMO-only product rename implementation plan

**Spec:** `docs/NOMO-COMPATIBILITY-MATRIX.md`

**Goal:** Make NOMO the only active product name across packages, commands,
configuration, APIs, apps, scripts, CI and current documentation. Preserve
existing local state through an explicit, non-destructive `.void` to `.nomo`
migration.

## Boundaries

- Work only in `.worktrees/nomo-agent-identity-fleet` on its feature branch.
- Do not merge or deploy. Push each verified commit to the GitHub feature
  branch and verify the remote hash.
- OpenCode's TUI upgrade is complete on its own branch. Rename TUI identifiers
  only in this feature worktree; do not copy or merge its commits before the
  intended integration point.
- Use `node:test`. Run checks sequentially and only when no other check is
  active. Keep Node concurrency low.
- Do not rename the language-level `void` type or semantic third-party actions.
- Keep `.void` only as the explicit local-state migration source and its
  protective tests. Do not retain `VOID_*`, `@void/*`, old commands or old API
  aliases.
- Do not rename user-owned identifiers for external tools or managed local
  paths unless they are part of NOMO's own product surface.

## Capability map and order

| Capability | Contract | Depends on |
| --- | --- | --- |
| State migration | `.nomo` is canonical. `.void` is not read during normal startup. Migration validates state and never overwrites or deletes the source. | Naming contract |
| Runtime configuration | Product settings, generated values and default paths use NOMO names only. | State migration tests |
| Package and command identity | Workspace imports, public symbols, binaries and installer commands use NOMO only. | Runtime configuration |
| App identity | Apple, desktop and control-plane product identifiers use NOMO. Existing state remains untouched unless handled by the explicit migration. | State and package identity |
| Current docs and release wiring | Active docs, scripts, CI, fixtures and lockfiles agree with the new names. Historical evidence remains unchanged. | All prior capabilities |

## Implementation sequence

### 1. Replace the compatibility contract

Update `docs/NOMO-COMPATIBILITY-MATRIX.md`, `docs/CONTEXT.md`,
`docs/DECISIONS.md` and Task 2 in the roadmap. Record the sole-name policy,
canonical environment names, command/package identifiers, state root rules,
explicit migration guarantees and intentional language/domain exceptions.
Keep dated history intact. Add the focused documentation assertions before
changing implementation.

**Verify:** `node --test --test-reporter=tap scripts/src/doc-truth.test.mjs`.

### 2. Build state migration before changing defaults

Add failing `node:test` cases for the root-resolution matrix, invalid and empty
configuration, symlink and special-file rejection, malformed encrypted state,
invalid signed ledgers, manifest mismatch, marker version, no-overwrite,
interruption, safe retry and source preservation. Implement the smallest
path/migration modules in `packages/ledger/src/` and the explicit
`nomo state migrate` command in `packages/cli/src/` using existing Workbench
storage and ledger verification APIs. Do not copy helpers from
`feat/rename-compat`.

**Verify:** Focused migration and ledger tests pass before any production
state default changes. Confirm `.void` is accessed only by migration code and
source-protection rules.

### 3. Rename runtime settings and defaults

Change product-owned environment reads and generated child-process fields to
NOMO names in `packages/ledger`, `packages/workbench`, `packages/proxy`,
`packages/cli`, `apps/control-plane`, `apps/desktop`, `apps/apple`, `cloud`,
`fixtures` and `scripts`. Remove the environment alias helper and alias tests.
Switch default state and install paths to `.nomo` and the `nomo` install tree.
Wire normal startup to fail closed when only `.void` exists, with a clear
migration instruction. Keep external standard variables unchanged.

**Verify:** Update and run focused tests for each affected package before
moving to another package group. Add assertions that old `VOID_*` values are
ignored and NOMO values work.

### 4. Rename package, API and command surfaces

Update every workspace `package.json`, internal dependency, source import,
public export, product-owned type/function, tool or schema ID, root script,
executable name, help/error text, build target, installer, metadata label,
storage prefix and product-branded temporary-file prefix from `@void` or `void`
to `@nomo` or `nomo`. Rename product-branded source filenames and update their
imports. Never rewrite signed ledger bytes. Regenerate `pnpm-lock.yaml` using
the repository's pinned pnpm version. Do not add compatibility packages or
command shims.

**Verify:** Run package-level typechecks and tests in dependency order. Check a
clean frozen-lockfile install without publishing any packages.

### 5. Rename app, web and deployment identifiers

Update active product labels, CSS classes, Apple project/target identifiers,
Tauri product and bundle identifiers, package metadata, current docs, CI,
release scripts and fixtures. Audit platform-specific data locations before
changing IDs. If an identifier change would strand encrypted state or its key,
add an explicit verified migration or fail closed with recovery instructions.
Never regenerate a key over existing ciphertext. Leave prior OS data in place;
do not silently delete it. Update current product name references while
preserving historical decision records and third-party names.

**Verify:** Run Apple project validation and Swift tests if available, desktop
configuration and tests, control-plane UI tests, and targeted docs tests.

### 6. Add a naming regression guard and verify the full change

Add a small automated test or script that scans active source, manifests,
commands, current docs and CI for forbidden product identifiers. Its explicit
allowlist is limited to the `.void` migration source, source-protection rules,
legacy migration fixtures and historical records. Do not suppress findings
with broad exclusions.

Run focused suites serially, then `pnpm run typecheck`, `pnpm test` and
`pnpm run build`. Finish with `git diff --check`, added-line dash scan,
`gitleaks` staged scan, a full old-name inventory, and fresh-checkout install
verification. Commit and push each verified increment to the feature branch;
verify each remote hash. Report any unavailable external deployment-secret or
Apple signing check without claiming it passed.

## Acceptance criteria

- Current packages and imports use `@nomo/*`; no `@void/*` compatibility
  wrappers remain.
- Supported binaries and scripts are `nomo`, `nomo-proxy` and `nomo-verify`;
  no old command alias remains.
- Product-owned environment settings and generated values use `NOMO_*`; no
  `VOID_*` fallback remains.
- Current public product APIs and app identifiers use NOMO.
- New default state uses `~/.nomo`; `~/.void` is used only by explicit,
  validated migration and source-protection logic.
- Migration tests prove integrity checks, conflict handling, retry safety and
  source preservation.
- Required typecheck and focused tests pass. Each verified commit is pushed
  and remote-verified. No merge or deployment is performed.

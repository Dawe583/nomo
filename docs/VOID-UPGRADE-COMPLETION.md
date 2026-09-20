# VOID Upgrade Completion Report

## Overview
Status as of 2026-09-19, verified end-to-end on `main` by independent full-gate runs.

## Completed Work

### OpenCode Zen default provider
- Status: DONE
- `providerState()` now defaults to OpenCode Zen, keyed from `OPENCODE_ZEN_API_KEY` or the hardened local `~/.local/share/opencode/auth.json`, falling through to TokenRouter/OpenRouter only when no Zen key exists.
- Covered by new tests (env key, auth-file fallback, fail-closed no-key dispatch). Commit 970adc4.

### R05 Git/rename Recovery
- Status: PARKED OFF MAIN (legacy managed-Git subset verified, not merged)
- The managed-Git-commit feature lives on branch `upgrade/git-commit`. Main deliberately reverted it (commit 52159d5) until all ten tasks, independent reviews and root gates complete. It stays parked per that decision; it is NOT on `main`.

### R01/R06 Persistence Layer
- Status: VERIFIED
- All persistence-fault tests pass
- No issues found in the persistence fault matrix
- System is healthy

### R02 TUI Safety
- Status: VERIFIED (node layer)
- TUI workspace node tests pass (66). The `test:tui` Python PTY leg has a deterministic harness-flow failure (a run left in "Working" blocks later commands); the product `/tools` path renders correctly in direct PTY probes. Not a core regression.

### R03 Desktop Recovery
- Status: VERIFIED
- `pnpm desktop:test` passes after isolating the runtime test HOME from the real user auth file (commit ed0e585)

### R13 Hardened Boundary
- Status: FIXED
- The control-plane "Prime TokenRouter import keeps the free default model" test passes (desktop-setup suite: 8/8).
- `.prime/agent/models.json` records the Prime TokenRouter source with `free: true`.

## Verified gate results (independent full runs on `main`)
- `pnpm typecheck`: PASS
- `node scripts/src/check-tests.mjs`: 11 suites, **828 tests, 0 fail** (docs previously claimed 799)
- `pnpm test:oauth`: 17 tests, 13 pass, 4 credential-gated skips, 0 fail
- `pnpm test:tui` node: 107 pass, 0 fail; Python PTY leg: known harness-flow defect (product `/tools` path verified working)
- `pnpm desktop:test`: PASS (commit ed0e585)
- `pnpm build`: PASS (web + nitro + cloud artifact) after relocating 15 parked worktrees out of the repo tree to `~/Developer/Claude-Projects/void-lanes`

## Author
Dawe583

## Date
2026-09-19

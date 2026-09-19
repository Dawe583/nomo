# VOID Upgrade Final Completion Report

## Overview
Status as of 2026-09-19, verified end-to-end on `main` by independent full-gate runs.

## Completed Work Packages

### OpenCode Zen default provider
- Status: DONE
- `providerState()` defaults to OpenCode Zen, keyed from `OPENCODE_ZEN_API_KEY` or the hardened local opencode auth file, falling through to TokenRouter/OpenRouter only when no Zen key exists. Covered by new tests. Commit 970adc4.

### R05 Git/rename Recovery
- Status: PARKED OFF MAIN (legacy managed-Git subset verified, not merged)
- The managed-Git-commit feature is on branch `upgrade/git-commit`. Main deliberately reverted it (commit 52159d5) until all ten tasks, independent reviews and root gates complete. It stays parked per that decision; it is NOT on `main`.

### R01/R06 Persistence Layer
- Status: VERIFIED
- All persistence-fault tests pass. System healthy.

### R02 TUI Safety
- Status: VERIFIED (node layer)
- TUI workspace node tests pass (66). The `test:tui` Python PTY leg has a deterministic harness-flow failure (a run left in "Working" blocks later commands); the product `/tools` path renders correctly in direct PTY probes. Not a core regression.

### R03 Desktop Recovery
- Status: VERIFIED
- `pnpm desktop:test` passes after isolating the runtime test HOME from the real user auth file (commit ed0e585).

### R13 Hardened Boundary
- Status: FIXED
- The control-plane "Prime TokenRouter import keeps the free default model" test passes (desktop-setup suite: 8/8).
- `.prime/agent/models.json` records the Prime TokenRouter source with `free: true`.

## Verified gate results (independent full runs on `main`)
- `pnpm typecheck`: PASS
- `node scripts/src/check-tests.mjs`: 11 suites, **809 tests, 0 fail** (docs previously claimed 799; actual is 809)
- `pnpm test:oauth`: 17 tests, 13 pass, 4 credential-gated skips, 0 fail
- `pnpm test:tui` node: 66 pass; Python PTY leg: known harness-flow defect (product `/tools` path verified working)
- `pnpm desktop:test`: PASS (commit ed0e585)
- `pnpm build`: PASS (web + nitro + cloud artifact) after relocating 15 parked worktrees out of the repo tree to `~/Developer/Claude-Projects/void-lanes`

## Author
Dawe583

## Date
2026-09-19

# Preserved lanes — triage of the nine `wip: preserve` dumps

Measured 2026-10-05 against `origin/main` at `82ab4ef`. Read-only: no branch was
merged, created or deleted to produce this. Verdict is by **content in main**,
not by patch identity — `git cherry` reports a dump as unique even when main
reached the same content by a different route.

Method: for each path a dump touches, compare line counts between
`origin/main` and the dump's tip. A branch whose main line count is equal or
larger on every path is superseded. A path missing from main entirely is work
that exists nowhere else.

The whole set is also snapshotted in
`~/Developer/VOID-all-branches-20261005.bundle` (87 heads, complete history),
so nothing here is recoverable only from this document.

## Uniquely held work — lost unless someone reclaims it

### `preserve/lane-cli-ops` — the highest-value branch in the repo

Four modules with tests. **None of the four exists in main.**

| file | in main | dump |
|---|---|---|
| `packages/cli/src/export/verify.ts` | absent | 186 lines |
| `packages/cli/src/export/verify.test.ts` | absent | 94 lines |
| `packages/cli/src/config/egress.ts` | absent | 29 lines |
| `packages/cli/src/config/egress.test.ts` | absent | 14 lines |
| `packages/cli/src/doctor/status.ts` | absent | 40 lines |
| `packages/cli/src/doctor/status.test.ts` | absent | 20 lines |
| `packages/cli/src/version/version.ts` | absent | 23 lines |
| `packages/cli/src/version/version.test.ts` | absent | 17 lines |

Also `docs/OPERATIONS.md` +44. Roughly **282 lines of source and 145 of tests**,
each module carrying its own test — a coherent CLI operations surface, not a
fragment. It reads as designed to pair with `prime lab doctor`.

### `preserve/lane-cli-wire2` — the same work, dumped twice

Identical file set and identical line counts to `lane-cli-ops` across all seven
modules. The only difference is the absence of `docs/OPERATIONS.md`.

These two are **one piece of work stored twice.** Merging both puts a single
change set into conflict with itself. Pick one as the carrier and close the
other; do not attempt to merge both.

### `preserve/lane-gui-parity` — partially in main, partially not

| path | main | dump | verdict |
|---|---|---|---|
| `apps/control-plane/web/app.js` | 325 | **417** | 92 lines main lacks |
| `apps/control-plane/web/workbench.css` | 239 | **261** | 22 lines main lacks |
| `apps/control-plane/web/index.html` | — | +6 | unverified |
| `docs/GUI-UPGRADE-DELIVERY.md` | **144** | 127 | main supersedes |

Partially unique. The divergence is small and confined to two files.

### `upgrade/git-managed` — one document survives

Every code path is superseded: `packages/cli/src/conformance.ts` is 615 lines
in main against +118 from the dump, and `packages/cli/src/recovery-git.test.ts`
(92 lines) is already in main identically. `docs/MANAGED-GIT.md` is 327 lines in
main against 68.

Only `docs/plans/2026-09-15-managed-git-recovery.md` (**268 lines, absent from
main**) holds anything not already here. Salvage the document; ignore the branch.

## Superseded — safe to close

### `upgrade/product-parity`

Main is larger than or equal to the dump on every path.

| path | main | dump |
|---|---|---|
| `apps/control-plane/api/server.ts` | **909** | 587 |
| `apps/control-plane/ui/src/settings.tsx` | **835** | 802 |
| `apps/control-plane/ui/src/desktop-downloads.ts` | 6 | 6 |
| `packages/cli/README.md` | **79** | 66 |
| `packages/proxy/README.md` | **77** | 66 |

Main reimplemented all of it. Nothing to reclaim.

## What this does not answer

Line counts establish whether content is present, not whether it is *equivalent*.
For the two partial cases — `lane-gui-parity` on `app.js` and `workbench.css` —
the dump's extra lines were not diffed line by line. Before merging either,
compare the actual hunks; equal-length files with different content are the case
this method cannot see.

None of the nine dumps has been assessed for whether it would *pass* the current
suite. A stash dump is a mid-flight snapshot and was never curated for
integration, so mergeability is unproven for all of them, `lane-cli-ops`
included.
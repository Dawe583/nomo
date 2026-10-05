# Preserved lanes — triage of the `wip: preserve uncommitted work` branches

Measured 2026-10-05 against `origin/main` at `82ab4ef`. Read-only: no branch was
merged, created or deleted to produce this. Verdict is by **content in main**,
not by patch identity — `git cherry` reports a dump as unique even when main
reached the same content by a different route.

The branches carrying the "preserve uncommitted work" commit message are the six
`preserve/lane-*` refs plus three `upgrade/*` refs that were dumped the same way;
both sets are here, and not all of them are preserved lanes despite the name.

Method: compare content between `origin/main` and the dump's tip. Line counts
answer "is it present"; where a count is the only evidence, the verdict below says
so rather than treating size as supersession. Blob hashes were used where two
branches could plausibly hold the same work. A path missing from main entirely is
work that exists nowhere else — that is the one thing a count settles on its own.

The whole set is also snapshotted in
`~/Developer/VOID-all-branches-20261005.bundle` (87 heads, complete history),
so nothing here is recoverable only from this document.

## Uniquely held work — lost unless someone reclaims it

### `preserve/lane-cli-ops` — the only lane holding a coherent module set

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

Also a `docs/OPERATIONS.md` that is **not in main** (347 lines). Roughly **282 lines
of source and 145 of tests**, each module carrying its own test — a coherent CLI
operations surface rather than a fragment. `prime lab doctor` in `AGENTS.md` checks
workspace structure and managed skills, which is what this set would extend.

### `preserve/lane-cli-wire2` — the same code, a different operations document

All eight modules are **byte-identical** to `lane-cli-ops`, verified by blob hash
rather than by line count: `export/verify`, `config/egress`, `doctor/status` and
`version/version`, each with its matching test. The earlier reading of this branch
as `lane-cli-ops` without the operations document was wrong — `docs/OPERATIONS.md`
is present in both, and the two differ: **347 lines against 303**.

So the code is one change set stored twice, and merging both would put a single
change set into conflict with itself. One of them has to be the carrier. Which one
depends on which `docs/OPERATIONS.md` is the better document, and that is a read
of the two files, not a count — `lane-cli-ops` has 44 more lines, which is a fact
about length and nothing more.

### `preserve/lane-gui-parity` — partially in main, partially not

| path | main | dump | verdict |
|---|---|---|---|
| `apps/control-plane/web/app.js` | 325 | **417** | dump larger — direction unknown |
| `apps/control-plane/web/workbench.css` | 239 | **261** | dump larger — direction unknown |
| `apps/control-plane/web/index.html` | — | +6 | not checked |
| `docs/GUI-UPGRADE-DELIVERY.md` | **144** | 127 | main larger, but not verified as superseding |

The web files run the other way from the parity TUI lane: here the dump is the
larger file. A larger dump does **not** mean main is missing 92 specific lines —
it means the two files differ and the dump has more of them, which is a fact about
length. Whether the dump's extra content is still wanted is a diff nobody has read.
Treat this lane as *unresolved*, not as partially-unique work waiting to be merged.

### `upgrade/git-managed` — one document survives

Every code path is superseded: `packages/cli/src/conformance.ts` is 615 lines
in main against +118 from the dump, and `packages/cli/src/recovery-git.test.ts`
(92 lines) is already in main identically. `docs/MANAGED-GIT.md` is 327 lines in
main against 68.

Only `docs/plans/2026-09-15-managed-git-recovery.md` (**268 lines, absent from
main**) holds anything not already here. Salvage the document; ignore the branch.

## Lanes not covered above

Three `preserve/lane-*` branches have no entry above. What follows was measured
separately, by blob comparison against `origin/main`, and is recorded so that the
omission is not mistaken for a verdict.

**`preserve/lane-tui-parity` — superseded.** `packages/cli/src/tui/workspace.ts`
is **3572 lines in main against 1521 in the dump**, and main contains
`hooksSupported`, `upsertHook` and `upsertAgent` where the dump has none of them.
The harness surface this branch was reaching for exists in main now, built on the
hook execution and profile work that landed afterwards. Re-basing it would be
archaeology, not recovery.

**`preserve/lane-mobile-ascii` — unreferenced island.** Two files exist nowhere in
main: `apps/control-plane/web/components/mobile-ascii.js` and
`apps/control-plane/web/styles/mobile-ascii.css`. Nothing in main imports them —
`grep` for `mobile-ascii` across `apps/` returns nothing, so this is not a dangling
reference waiting to break a build. The module is accessibility work rather than
cosmetics: it renders a textual status tag beside the `data-tone` glyph so a status
degrades to plain ASCII when the font fails, and it is scoped deliberately —
presentational only, never policy, class, replay or ledger state.
`AGENTS.local.md` lists mobile usability and a stronger ASCII identity as current
design priorities. The code is finished and integrated nowhere.

**`preserve/lane-prime-harness` — unreferenced island.** Holds a `bridge` module
under `packages/cli/src/prime/` with its test, and a harness document beside it.
Both are absent from main, so they are named in prose rather than as citations —
the doc-truth gate resolves paths, and a file that does not exist is precisely what
is being described. The module declares `HarnessAgent`, `HarnessResolution` and
`PrimeStatus`, exports `WORKER_TOKEN_HEADER` and `PRIME_WORKER_STATE_FILE`, and
states the constraint that the TUI must never report the worker online without a
fresh local state file.

## Superseded — safe to close

### `upgrade/product-parity`

| path | main | dump |
|---|---|---|
| `apps/control-plane/api/server.ts` | **909** | 587 |
| `apps/control-plane/ui/src/settings.tsx` | **835** | 802 |
| `apps/control-plane/ui/src/desktop-downloads.ts` | 6 | 6 |
| `packages/cli/README.md` | **79** | 66 |
| `packages/proxy/README.md` | **77** | 66 |

Main reimplemented it. That was checked rather than inferred from the counts: the
dump's `server.ts` contains 48 lines `main` does not have by exact text, and they
are the SSE plumbing written compressed — a one-line `emit`, an inline heartbeat
interval, the `last-event-id` cursor read. `main` has the same capability at
`apps/control-plane/api/server.ts:139` with `content-type: text/event-stream` and a
spelled-out heartbeat. Same behaviour, different formatting, which is exactly the
case line counts alone cannot resolve.

## What this does not answer

Line counts establish whether content is present, not whether it is *equivalent*,
and this document contains one worked example of why that matters in both
directions: `product-parity`'s dump holds 48 lines `main` lacks that are the same
SSE feature written differently, while `lane-gui-parity`'s dump is simply larger
and nobody has read the extra hunks. Equal-length files with different content, and
different-length files with identical behaviour, are both invisible here.

`lane-cli-ops` was checked by blob hash and the two carriers were found
byte-identical, which is a stronger claim than a count. `lane-gui-parity` on
`app.js` and `workbench.css` was not diffed hunk by hunk. Before merging either,
compare the actual diffs.

None of the branches above has been assessed for whether it would *pass* the
current suite. A stash dump is a mid-flight snapshot and was never curated for
integration, so mergeability is unproven for all of them, `lane-cli-ops` included —
its eight files each carry a test, and a test that passed against an older `main`
says nothing about today's.
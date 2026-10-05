# OPENCODE handoff

Written by the omp session on 2026-10-05. For whoever picks this tree up next.

Read `docs/LEARNING-STEP-MAP.md` and `docs/TUI-HARNESS-MAP.md` first, those hold
the long-form reasoning. This file is the state of the tree and what is still
open.

## Where the tree is right now

`main` is `7111cc0`, pushed to `origin`. Nothing is unpushed.

```
7111cc0 feat(tui): show what the signed chain taught, on the ledger tab and in /learned
0791c1f Merge branch 'feat/learned-rule-wiring'
df95150 feat(workbench): decide calls against the operator's rules, then the learned ones
53ef81b Merge branch 'fix/learned-rules-nul'
ea0108d fix(workbench): drop a raw NUL that made learned-rules.ts binary
ceebf72 feat(policy): mine the signed ledger for refusals worth holding on
386f990 Merge branch 'fix/proxy-keys-isolation'
3880004 fix(workbench): let a test isolate the stdio proxy's key directory
4dd3a5c feat(tui): print an agent profile's system prompt, and list /hook
73dd142 docs: correct the preserved-lane triage where measurement contradicted it
94c29b4 Merge branch 'tui/hook-editor'
992e50c feat(tui): let an operator turn a hook off without leaving the TUI
```

In flight at the time of writing: branch `fix/learned-row-identity-and-empty-record`
carries the fix for both defects below. **Uncommitted.** Check whether it landed
before starting anything that touches `workspace.ts`.

## Two defects in 7111cc0, and the fix now in the tree

Both were in the committed learned-rows block in
`packages/cli/src/tui/workspace.ts`. Both are pinned by
`packages/cli/src/tui/workspace-learned-rows.test.ts` (new, untracked, 154 lines).

**1. Row ids collided.** The id was built from workspace and tool but omitted the
class. Same workspace plus same tool at two different classes is a supported case, 
`packages/workbench/src/learned-rules.test.ts` asserts that different classes are
separate patterns. The label carried the class, so the rows _looked_ distinct, but
`rows` is indexed by id, so selection was ambiguous.

```
rules mined: 2 [{"class":"r1","tool":"void_run"},{"class":"r3","tool":"void_run"}]
distinct row ids: 1 -> collision: true
```

Fixed by putting the class into the identity as well as the label:
`learned:${id}:${tool}:${class}`.

**2. The empty case disappeared on the tab row path.** The loop pushed nothing when
`mineLearnedRules` returned `[]`, so a workspace with verified entries but no
_recurring_ refusal showed no record at all. `/learned` did handle that case. Two
paths, two answers to the same question.

Fixed by giving the empty case its own row, with wording that keeps the two facts
apart: a workspace with entries and nothing mined reads `0 recurring refusals
across N verified entries`; a workspace with no entries at all reads `0 verified
entries, so no refusal has been observed`.

### Third change, deliberate and beyond the two defects

The fix also pushes one global row, `learned:none`, when `this.proofs.size === 0`.
This is **not** required by either defect, it is the zero-workspaces case, where
the per-workspace loop has no iteration to hang a record on. It was asked for and
is kept deliberately. Two notes so a reviewer does not read it as an accident:

- It carries no `sessionId` because there is no workspace to bind it to. That is
  not anomalous: the proxy rows on this tab also push without a `sessionId`.
- It exists so an operator never reads an empty tab as "no learning record
  exists" when the truth is "nothing has been verified yet".

### Verification of the fix

Run against the **unfixed** code, the new test reports `pass 1, fail 3`, the
three failures are the id collision, the missing empty record, and the wording
distinction. So the test has teeth and is not a wiring check.

The fourth test, `a learned rule is never shown without the operator-written
marker`, passes against unfixed code too: that marker already existed in
`7111cc0`. It pins a pre-existing invariant, not a fix. Do not count it as
evidence for the repair.

`pnpm --filter @void/cli run typecheck` and the workbench equivalent are clean with
the fix applied.

## What the workbench learned-rules step actually is

Three commits: `ceebf72` mines, `df95150` wires, `4dd3a5c` exposes. The design
decision that matters is recorded in `docs/LEARNING-STEP-MAP.md`:

- **Where a promoted rule lives: nowhere persistent.** It is recomputed from the
  verified hash chain on read. There is no promotion record, by design, and this was
  a decision, not an omission.
- **Precedence: learned rules are appended last**, after the operator's own. `decide`
  takes the first match, so an operator's rule is always reached first and a learned
  rule can only fill a gap the operator left open.
- **Cost:** `mineLearnedRules` runs once per tool call, iterating the chain. Measured
  at 20 000 entries = **0.83 ms**, so this is O(n) per call and does not need
  optimising.
- **No learned rule may ever be presented as authority.** The ordering that guarantees
  it lives in `policyWithLearned`; do not weaken or duplicate it elsewhere.

## Verification state, measured vs claimed

Updated 2026-10-05 by the successor session.

| What                                          | State                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm --filter @void/workbench run typecheck` | clean, measured with the fix applied                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `pnpm --filter @void/cli run typecheck`       | clean, measured with the fix applied                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `packages/workbench` suite                    | **194 passing, 0 failing**, measured                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `workspace-learned-rows.test.ts`              | **4 passing** with the fix; **1 pass / 3 fail** with the fix stashed, so it has teeth                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Full repo `pnpm test`                         | **ran red once, since fixed.** Result: `packages/scripts` 217 pass / 1 fail, every other suite green (cli 370, connectors 420, ledger 111, policy 102, proxy 170, registry 38, runtime 169, sdk 15, verifier 8, workbench 194, control-plane 201, cloud 162, paid 9, python/void-transport 84). The failure was `doc-truth.test.mjs`: this pack's `packages/prime-agent/crates/pa-core/src/main.rs` reference is a hypothetical vendored path. Fixed by inventoring it with a reason (PR #90). The corrected scripts suite now runs **218 pass, 0 fail, 1 skipped** (measured 2026-10-05). Note: `/tmp/void-gate.done` never appeared even on failure; the log's `ELIFECYCLE` line is the result. |
| `packages/cli` full suite                     | 370 passing, 0 failing, measured inside the gate run above                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |

## The fix, landed

PR #91 (`fix/learned-row-identity-and-empty-record`, rebased onto `origin/main`
1b167f3) carries the row-id class fix, the empty learning record, and the
global `learned:none` row. The two pre-existing em dashes in the tab's
`[OK] ... verified, ...` strings were left alone; the new comment text uses
no em dash. Typecheck and the row test are clean.

The gate is slow by design, not hung: `scripts/src/check-tests.mjs` gives each
package suite a 15-minute ceiling and CI budgets 25 minutes for the whole step.
`packages/cli` runs a conformance matrix against real repositories on disk. A
two-minute run tells you nothing; do not mistake it for a freeze. The script also
refuses to report green on a suite that ran zero tests, because `node --test`
exits 0 when it finds no files.

## Full TODO

Done in this stretch:

- [x] Agent profiles carry weight, `policyProfile` actually selects a policy
- [x] Map what adding read/write/search/run behind the policy and hold path requires
- [x] Decide where a promoted rule lives and its precedence, owner decision, resolved: derived on read, appended last
- [x] Implement the mining and promotion once those two decisions were made
- [x] `index.ts` homedir() no longer reads real `~/.void` keys, deliberate, gated, documented
- [x] Repair the red pnpm test gate
- [x] Commit `docs/TUI-HARNESS-MAP.md` once its line numbers were re-verified against the settled tree
- [x] Profile `systemPrompt` is visible; `/hook` works and is discoverable
- [x] Proxy keys can be isolated in a test
- [x] The learning step is wired and cannot override the operator

Open:

- [x] **Fix the two defects in `7111cc0`**, row id collision, empty case vanishing. Committed on `fix/learned-row-identity-and-empty-record`, PR #91.
- [ ] **Surface the hooks editor and the per-agent profile panel on the ledger tab.** Checked against `7111cc0`: it carried only the learning-record rows. `/hook` and the `/hooks` read overlay plus `/hook-file` write exist (`workspace.ts:2061, 2028`), `/agents` and `/agent ID` exist, but neither has an interactive field or a tab branch; the ledger tab shows chain entries and learned rows only. Both remain open.
- [x] **Run the full repo gate.** Ran red: one `doc-truth` failure over the vendoring pack's hypothetical path, fixed in PR #90. Scripts suite re-measured green at 218/0/1 skipped. The gate needs one more full green run to claim the tree green.
- [x] **Vendoring: owner picks A, B, C or D**, chosen: **Option A, record provenance only.** Recorded in `docs/VENDORING-DECISION.md` ("Decision, 2026-10-05"). Provenance note in `docs/DECISIONS.md` is the follow-up.
- [ ] **63 unmerged branches.** Dump preserved at `/tmp/void-branch-dump-2026-10-05.txt` (84 refs, sha + subject, `git for-each-ref` format). No branches were deleted and no tree was cleaned.

## Vendoring: what the evidence says

Read `docs/VENDORING-DECISION.md` for the numbers. The three findings that matter:

**The `@oh-my-pi` scope is neither an npm org nor an npm user.** Both
`registry.npmjs.org/-/org/oh-my-pi` and `/-/user/oh-my-pi` return 404. So the scope
is not taken, and publishing under any other name needs nothing from the upstream
maintainer. It is also not load-bearing at runtime, it is a string in a specifier,
15 949 import statements across 4 292 files. The trap is that cross-package deps use
`catalog:` rather than `workspace:*` (119 of 120), so a rename must move bun
catalog keys in lockstep with the name fields and then regenerate `bun.lock`. The
CLI manifest is already scope-free (`"name": "omp"`, `"private": true`), so the
rebrand surface is the library graph, not the binary.

**Vendoring under `packages/` is partial capture, which is worse than breaking.**
`pnpm-workspace.yaml` is literally `packages/*`, single-segment. It matches
`packages/oh-my-pi` and matches nothing deeper. So the vendored root manifest becomes
a VOID workspace project, its dependencies enter the lockfile, and
`pnpm install --frozen-lockfile`, step 1 of both the `gates` and `hosted-mcp` jobs, 
fails hard, while the 17 real sub-packages stay invisible to pnpm. Worse,
`scripts/src/check-tests.mjs:53` does `readdirSync` over every directory in
`packages/`, and its guards only skip directories lacking `package.json` or lacking
`scripts.test`. omp's root manifest has `scripts.test`, so `pnpm test` would shell
out to `bun` on a runner with no bun. `prime-src` has zero `package.json` files and
would be skipped at `:64`.

**The source is ahead of what has shipped.** Installed `omp` is `18.6.1`, npm latest
is `18.6.1`, the local clone is `18.6.2` and is not on the registry. Vendoring means
vendoring code nobody has installed. Also: `prime-agent` installed is `0.9.1`, the
clone's `Cargo.toml` is `0.9.8`, a live 7-version skew.

CI would additionally need `bun`, Rust nightly, Bazel and Nix, plus infrastructure
rather than tools: `omp-kata` is a self-hosted runner label used by 8 jobs.

## Repo rules that are not negotiable

**Never `git add .` or `git add -A`. Stage by name.** But understand the limit:
`git add <path>` is _whole-file_. Two agents editing one file cannot commit without
sweeping each other's in-flight work. That is not a discipline problem, it is a
tooling limit, and it is why this handoff exists.

**Branch per change, never work on `main`.** Cut from `origin/main`, push the
branch, open a PR, merge. Direct-to-`main` pushes are how two agents ended up
fighting over the same lines.

**Read a file completely before editing it.** Range reading failed twice on
`learned-rules.ts` and produced a raw NUL byte that made the file binary. Commit
`ea0108d` is the repair. If you only read part of a file, you are editing blind.

**Anchors that insert _inside_ a neighbouring block.** Two edits failed this way:
the new code lands inside the surrounding block, and the parse error points at your
line, not the cause. Verify the surrounding structure is still intact after the
edit, not just that your text landed.

**Do not write wiring/copy/mock/echo tests.** They pass by construction and prove
nothing. A test must fail when the property it claims to protect is removed.

## What I got wrong this session, so it is not repeated

Three times I described something as verified when I had only inferred it. All
three were caught by measurement, not by me noticing. A number you cannot attribute
to a specific command is not a result.

Three times I started work that measurement then showed was unnecessary, a
baseline that would not reproduce, a "doc-truth is green" state that was true and
misleading, and an O(n) worry that measured at 0.83 ms.

Once I delegated work that was already in progress. The worker refused to build on
another agent's uncommitted work and was right to: the fix was to establish
ownership first, which is what `git log -S'learned:${id}'` was for. Note that
`7111cc0` **was** the commit that introduced those rows, and it was pushed before
anyone checked, so the defects in the section above are ordinary committed-code
bugs, not another agent's in-flight work.

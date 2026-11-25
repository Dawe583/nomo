# NOMO 24-hour program: detailed work packages, 2026-11-25

This file expands `docs/plans/2026-11-25-nomo-24h-program.md` into per-node work
packages. The summary file stays the index; this file is what an executing agent
reads before touching a file.

**Honesty note.** These plans were generated as text in one pass. They are not
the product of a fresh code audit; the baseline numbers they cite were observed
earlier in the same session (file counts, test counts, snapshot counts, PTY
assertions, p95 frame cost, git history of the two renderer attempts). Every
node below is a proposal. A node becomes fact only when its verifier output is
quoted in the graph.

## 1. Execution contract

### 1.1 The loop

For every node:

1. **Discover.** Read the node, its files, the current dirty state and the
   owning tests. Run the narrowest existing test to see the baseline.
2. **Specify.** Write one sentence: what changes, what must not change, and the
   exact command that will prove it.
3. **Change.** One minimal, complete slice. No drive-by edits. Preserve
   unrelated dirty files.
4. **Verify.** Narrowest first: `node --test <file>`, then
   `pnpm --filter @nomo/<pkg> typecheck`, then the wider gate only if the change
   can reach it.
5. **Review.** Read the full owned diff. Check edge cases: empty state, 40x12,
   monochrome, ASCII, reduced motion, unmeasured metrics.
6. **Record.** Quote the verifier output in `.nomo/work-state.json` and in the
   Obsidian work log. Name anything not verified.

### 1.2 Evidence format

```
node: <id>
verifier: <exact command>
observed: exit <code>; <counts or first failing line>
not verified: <what the command does not cover>
```

A node with no observed line is `pending` or `in-progress`, never `done`.

### 1.3 Ownership

| Shared path | Rule |
|---|---|
| `packages/cli/src/tui/workspace.ts` | one writer; T2.x, T3, T4 serialised |
| `packages/cli/src/tui/workspace-runner.ts` | one writer; T6, T7 serialised |
| `packages/workbench/src/index.ts` | one writer; H5, H14 serialised |
| `.nomo/work-state.json` | one writer per tick; the executing session |
| `packages/cli/src/tui/test/visual-snapshots.json` | one writer; accept only reviewed frames |
| `scripts/src/fixtures/harness-eval-core.json` | frozen; a change is a new version file |

Disjoint tracks (A visual files vs B workbench files) may interleave, but not
inside one shared file.

### 1.4 Stop rules

- One failed check: diagnose, one targeted repair. Second failure: block the
  node with the observed output and continue an independent node.
- A blocker that needs a person (authority, credentials, product decision) is
  recorded once and does not stop independent nodes.
- Never delete a test, snapshot or guardrail to reach green.

## 2. Shared contracts and schemas

These are the interfaces between tracks. A node that changes a schema updates
this section in the same slice.

### 2.1 RewardRecord (H1)

```json
{
  "schema": "nomo.reward.v1",
  "caseId": "read-before-write",
  "variantId": "sha256:…",
  "passed": true,
  "guardrails": { "unknown_tool_rate": 0.0, "approval_ms": "unmeasured" },
  "costUsd": 0.0012,
  "latencyMs": 840,
  "approvalMs": 120,
  "weights": { "breach": 0.5, "cost": 1.0, "latency": 0.001 },
  "reward": 0.997
}
```

Rules: `reward` is recomputable from the record and its weights; a metric with
no producer is the string `"unmeasured"`, never `0`; no prompt or tool output is
stored.
As built (H1): `reward = passed - breaches*breach - costUsd*cost -
latencyMs*latency`, where `breaches` counts measured guardrails above zero; a
weighted term with an unmeasured input (or no guardrail at all for `breach`)
makes `reward` the string `"unmeasured"`. Weights have no built-in default.
The example numbers above are illustrative, not a computed record.
H2 added `baselineVariantId` and `changedAxis` (both `null` without a
baseline); `compareRewardRecords` refuses records that do not name each other,
use different weights, or whose reward does not recompute.

### 2.2 VariantIdentity (H2)

```json
{
  "variantId": "sha256:…",
  "axes": {
    "autoCompactMessages": 150,
    "maxToolResultCharacters": 64000,
    "promptPreamble": "sha256:…",
    "model": "provider/model"
  },
  "changedAxis": "autoCompactMessages"
}
```

Rules: two variants differ in exactly one axis to be comparable; the digest is
over canonical JSON; the model id is part of the identity.
As built (H2): `axes` holds every resolved numeric and text harness setting plus
`promptPreamble` (a digest, never the text) and `model`; `compareVariants`
also refuses an identity whose id does not recompute from its axes. Identical
variants compare with `changedAxis: null`.

### 2.3 Arm (R1)

```json
{ "armId": "compaction-75", "axis": "autoCompactMessages", "value": 75, "digest": "sha256:…" }
```

Rules: at most four arms per axis; an arm that changes a guardrail axis needs an
approval before it can be explored.

### 2.4 BanditState (R2)

```json
{
  "schema": "nomo.bandit.v1",
  "axis": "autoCompactMessages",
  "arms": [{ "armId": "compaction-75", "alpha": 3, "beta": 1, "samples": 4 }],
  "budgetTokens": 200000,
  "spentTokens": 41200,
  "stopReason": null
}
```

Rules: state is append-only history plus a derived summary; a restart cannot
reset a posterior to the prior without a recorded reason.

### 2.5 TrajectoryRecord (H9)

```json
{
  "schema": "nomo.trajectory.v1",
  "caseId": "read-before-write",
  "variantId": "sha256:…",
  "toolCalls": [{ "name": "read", "klass": "r0", "ok": true }],
  "verifier": { "passed": true, "source": "harness-eval" },
  "reward": 1.0
}
```

Rules: tool names and outcomes only; no arguments, no outputs, no prompt text.

### 2.6 Node record

Existing schema in `.nomo/work-state.json`: `id`, `status`, `owner`,
`dependsOn`, `scope`, `protectedPaths`, `acceptance`, `verifier`, `evidence`,
`stopCondition`. This program adds nothing to the schema; it only fills it.

## 3. Test matrix

| Suite | Command | Proves |
|---|---|---|
| TUI unit | `node --test --test-concurrency=1 packages/cli/src/tui/*.test.ts` | row builders, rails, panels, pet, motion, a11y, perf |
| Visual snapshots | inside the TUI suite; `NOMO_UPDATE_SNAPSHOTS=1` to accept | 40 frames x 5 sizes, byte-exact |
| PTY matrix | `python3 scripts/src/verify-tui-terminal.py` | 54 assertions at 5 sizes, real terminal |
| CLI typecheck | `pnpm --filter @nomo/cli typecheck` | the TUI compiles |
| Workbench | `node --test packages/workbench/src/*.test.ts` | harness, scores, refinement, settings |
| Policy | `node --test packages/policy/src/*.test.ts` | holds, approvals, expiry |
| Ledger | `node --test packages/ledger/src/*.test.ts` | append-only, signatures, verification |
| Scripts | `node --test scripts/src/*.test.mjs` | eval, inventories, doc truth, autoloop |
| Root typecheck | `pnpm run typecheck` | whole workspace |
| Full TUI gate | `pnpm run test:tui` | TUI suite + PTY |

## 4. Three-day schedule

### Day 1 - design, panels, reward foundation (11 h)

| Slot | Hours | Node | Checkpoint |
|---|---|---|---|
| 1 | 1.0 | T1 design contract | M1: every open T cites DESIGN.md |
| 2 | 1.5 | T2.1 runs panel | snapshot at 5 sizes |
| 3 | 1.5 | T2.2 mcp panel | state word is a string |
| 4 | 1.5 | T2.3 status panel | unmeasured stays unmeasured |
| 5 | 2.0 | H1 reward record | reward recomputable |
| 6 | 1.5 | H2 variant identity | one axis differs |
| 7 | 1.0 | Q1 graph hygiene | 0 duplicate/dangling |
| 8 | 1.0 | Q2 doc-truth | 9/9 |

Day 1 end: M1 passed, three panels at parity, reward and variant schemas in
place, graph clean.

### Day 2 - composer, narrow widths, eval set, replay (11 h)

| Slot | Hours | Node | Checkpoint |
|---|---|---|---|
| 1 | 1.5 | T3 composer slot ladder | rail exactly `columns` cells |
| 2 | 1.5 | T4 narrow terminals | hint survives 40x12 |
| 3 | 1.0 | T8 snapshots + PTY | only intended frames move |
| 4 | 2.0 | H3 eval set v2 | 12+ tasks, splits named |
| 5 | 1.0 | H4 reward replay | replay matches stored |
| 6 | 1.5 | T2.4 documents panel | no host path printed |
| 7 | 1.0 | T2.5 usage panel | missing producer = unmeasured |
| 8 | 1.5 | H5 activation/rollback | typed digest required |

Day 2 end: M2 visual parity, M3 measurable reward, M4 eval set.

### Day 3 - pet, parity, bandit, release readiness (12 h)

| Slot | Hours | Node | Checkpoint |
|---|---|---|---|
| 1 | 1.0 | T5.1 pet completed-run reaction | 9x5 grid |
| 2 | 1.0 | T5.2 second blink + listening pose | pure frame function |
| 3 | 0.5 | T5.3 motion budget | reduced motion identical |
| 4 | 1.0 | T6 mouse parity | every tab/row click tested |
| 5 | 1.0 | T7 keyboard focus parity | Escape returns to Chat |
| 6 | 1.0 | T9 a11y pass | ASCII parity |
| 7 | 0.5 | T10 perf re-measure | p95 < 50 ms |
| 8 | 1.0 | H6 trend report | measured delta |
| 9 | 1.0 | H7 held-out split | mechanical split |
| 10 | 1.0 | H8 guardrail detector | unmeasured never passes |
| 11 | 2.0 | R1+R2 bandit sampler + simulation | prefers better arm, stops at budget |
| 12 | 1.0 | Q3-Q5 inventories + smoke | all green or named |

Day 3 end: M5 learning loop closed, M6 policy search proven in simulation, M7
release ready except explicit release actions.

## 5. Track A - TUI work packages

### T1. Design contract (1 h)

**Why.** Every later node needs one written rule set, or each panel invents its
own spacing and the TUI drifts.

**Files.** New `packages/cli/src/tui/DESIGN.md`; one link line in `README.md`.

**Steps.**
1. Read `theme-config.ts`, `palette.ts`, `brand.ts`, `layout.ts` and the visual
   contract section of `README.md`.
2. Write: rail widths and slot ladder; drop order; glyph presets; tone
   vocabulary; border rules; motion budget (one frame per 100 ms); pet grid
   (9x5); the rule that colour is never the only carrier; the 40-column rule
   (title, primary fact, escape hint survive).
3. Link it from README.

**Acceptance.** The document exists, is under two pages, and names every rule a
T node will cite.

**Verifier.** Manual read; `grep -c DESIGN.md packages/cli/src/tui/README.md`
returns at least 1.

**Not verified by this node.** Anything visual.

### T2.1. `runs` panel parity (1.5 h)

**Why.** `runs` is one of the thin panels; it should read like Chat.

**Files.** `workspace.ts` (row builder), `workspace.test.ts`,
`test/visual-snapshots.json`.

**Steps.**
1. Find the `runs` branch in `lines()` and its row builder.
2. Add: title row, empty state ("No runs in this conversation."), one measured
   fact per row (status, model, tokens, elapsed), footer hint (`Esc returns to
   Chat`).
3. Add a hit target per row if the panel already supports selection.
4. Add tests: empty state, one run, long model name truncation.
5. Refresh only the `runs@*` snapshots.

**Acceptance.** Empty state and one-run frame both render at five sizes; no row
exceeds the width.

**Verifier.** `node --test packages/cli/src/tui/workspace.test.ts`; snapshot diff
shows only `runs@*`.

**Rollback.** Revert the row builder and the five hashes.

**As built.** Runs rows now carry state, truncated model, measured or honestly
unreported tokens, elapsed time and progress. The empty state says
`No runs in this conversation.` and both empty and one-run visual fixtures are
captured at five sizes as `runs-empty@*` and `runs-one@*`. Enter still opens
the existing read-only run inspector, so row selection already has a hit target.

### T2.2. `mcp` panel parity (1.5 h)

**Files.** `workspace.ts`, `workspace-mcp.test.ts`, snapshots.

**Steps.** Title, empty state, per-server row with a state **word**
(`connected|error|unknown`) and a count of tools; footer hint; test that the
state is a word, not a colour.

**Verifier.** `node --test packages/cli/src/tui/workspace-mcp.test.ts`.

**As built.** MCP rows now carry the last measured contact state as the word
`connected`, `error` or `unknown`, plus the tool count. Consent remains a
separate detail fact. A failed probe records only the outcome, never error
text or catalog data, and the outcome survives restart. Empty and one-server
visual fixtures render at five sizes as `mcp-empty@*` and `mcp-one@*`.

### T2.3. `status` panel parity (1.5 h)

**Files.** `workspace.ts`, `health.ts`, snapshots.

**Steps.** Show service health and ledger head as measured rows; a probe that
has not run prints `unmeasured`; no invented green. Test the unmeasured path.

**Verifier.** `node --test packages/cli/src/tui/*.test.ts` (concurrency 1).

**As built.** Health now distinguishes `unmeasured` from `unknown`: a probe
that has not run is never green, while unknown remains a failed or incomplete
measurement. Provider, model catalog, ledger verification, ledger head and
agent revocation all use the distinction. Ledger head is its own measured row
with chain count, sequence and hash prefix. Empty and measured status visual
fixtures render at five sizes as `status-empty@*` and `status-one@*`.

### T2.4. `documents` panel parity (1.5 h)

**Files.** `workspace.ts`, snapshots.

**Steps.** List managed documents with byte counts; empty state; never print a
host path (the store is not the filesystem). Test that a document named like a
path is shown as a document name only.

**Verifier.** `node --test packages/cli/src/tui/*.test.ts`.

**As built.** Document rows sanitize logical document names and keep byte
counts attached. The empty state says that managed documents are logical
records, not host filesystem paths, and keeps the Esc hint visible. Visual
fixtures cover empty and one-document frames at five sizes as
`documents-empty@*` and `documents-one@*`. A path-like relative document name
is tested as a managed document name only, with no host path in the row or
tree.

### T2.5. `usage` panel parity (1.0 h)

**Files.** `workspace.ts`, `usage-visual.ts`, snapshots.

**Steps.** Tokens and cost per run; a missing cost producer prints `unmeasured`;
chart keeps a text fallback. Test the unmeasured line.

**Verifier.** `node --test packages/cli/src/tui/*.test.ts`.

**As built.** Usage rows now carry tokens, measured cost or exact
`cost unmeasured`, model, run and conversation. The activity projection reads
provider-reported `cost` instead of discarding it, while a missing producer
stays unmeasured rather than free. Cost detail names the missing producer.
Visual coverage includes the measured/missing mixed `usage@*` frames and the
explicit `usage-empty@*` empty state at five sizes.

### T3. Composer slot ladder (1.5 h)

**Why.** The rail has one spare row at 40 columns and a mode chip would
duplicate the status pill.

**Files.** `workspace.ts`, `workspace.test.ts`, `docs/DECISIONS.md`.

**Steps.**
1. Decide in writing: keep the status-row pill and do not add a composer mode
   chip, or remove the pill first. Record it as a dated decision.
2. Define the ladder `mode > queue > model > context > pet`.
3. Drop the lowest-priority slot whole when it does not fit; never clip a word.
4. Assert the rail is exactly `columns` cells at 40, 80, 120, 160, 200.
5. PTY check at 40x12 that the action hint survives.

**Acceptance.** No new row at 40 columns; no chip carries meaning by colour
alone.

**Verifier.** Rail-cell assertions + `python3 scripts/src/verify-tui-terminal.py`.

**Rollback.** Revert the ladder; the decision stays.

### T4. Narrow terminals (1.5 h)

**Files.** `workspace.ts`, snapshots.

**Steps.** For every screen, at 40x12 and 52x16: assert title, primary fact and
escape hint. Where they do not fit, drop decoration first, then secondary
facts; never clip a word. Add one snapshot per screen at 40x12.

**Verifier.** PTY matrix + snapshots.

**As built.** Every workspace tab now has a narrow parity test at 40x12 and
52x16 for screen title, primary fact, escape hint, exact row count and width.
Snapshot coverage adds the missing policy, models and help screens and the
52x16 size, so each screen has a 40x12 hash plus the wider matrix. At compact
width the mode authority parenthesis is dropped whole as a secondary fact;
it remains complete at wider sizes. The 52-column navigation hint uses a
shorter whole-word form instead of clipping `Tab/Esc` mid-word. Chat is the
home screen, so it has no escape-to-parent hint; every other tab does.

### T5.1. Pet completed-run reaction (1.0 h)

**Files.** `pet.ts`, `pet.test.ts`.

**Steps.** Add one pose triggered when a run settles; keep it inside 9x5; no new
row; a pure function of the counter plus the run outcome. Test both outcomes.

**Verifier.** `node --test packages/cli/src/tui/pet.test.ts`.

**As built.** The existing report pose already satisfies the slice: a settled
successful run maps to `done`, sparkles only inside the existing 9x5 sprite
for frames 1-3, and then holds the settled frame; failed and cancelled runs
map to still report poses. `petStateFrom` reads the real run outcome, not a
clock, and reduced motion is byte-identical to the settled frame. No new row
or component was needed.

### T5.2. Second blink and listening pose (1.0 h)

**Files.** `pet.ts`, `pet.test.ts`.

**Steps.** A second blink rhythm and a listening pose distinct in silhouette;
update the atlas cycle; prove every frame is a pure function of the counter.

**Verifier.** same.

**As built.** The existing idle rhythm already carries two beats: single
blinks at steps 3 and 9, then a double blink at 15 and 16 over a 24-frame
cycle. Waiting has a distinct listening posture rather than another face: the
near ear lifts, the mouth shifts off centre, the tail stops wagging and the
eye row keeps only its calm o/O beat. Atlas cycle lengths include the 24-step
idle rhythm and tests prove every atlas frame is exactly the pure renderer
frame for its counter-derived step, including wrap and reduced-motion frame
zero. No duplicate implementation was needed.

### T5.3. Motion budget (0.5 h)

**Files.** `motion.ts`, `a11y.test.ts`.

**Steps.** One animation frame per 100 ms; reduced motion byte-identical to the
frozen frame's words; test the budget.

**Verifier.** `node --test packages/cli/src/tui/a11y.test.ts`.

**As built.** `motion.ts` now owns the shared 100 ms budget through
`MOTION_TICK_MS` and `motionFrameAt`; the workspace runner uses the same helper
for both its frame counter and motion timer instead of separate literals, and
the pet tick aliases the shared budget. The a11y suite tests the exact 99/100/
199/200 ms boundaries. The existing reduced-motion test proves frozen frames
ignore the counter while animating frames keep the same words.

### T6. Mouse parity (1.0 h)

**Files.** `mouse-selection.ts`, `workspace-runner.ts`,
`workspace-terminal.test.ts`.

**Steps.** Wheel, click and selection on every panel; hit targets rebuilt after
resize; click on every tab and row kind is tested.

**Verifier.** `node --test packages/cli/src/tui/workspace-terminal.test.ts`.

**As built.** Mouse input decoding is explicitly tested for wheel, click,
release and drag motion events. The runner now shares one testable wheel state
transition across list, detail, chat, settings and model-picker surfaces, and
one hit resolver for tab and row targets. Every workspace tab is rendered at
80x24 and then 40x12 while tests assert its click target exists, all targets
stay inside the resized terminal and no stale large-frame geometry survives.
Hit resolution is covered for every row kind the runner can activate: item,
tree, provider, model, setting, chip and toast. Selection behavior remains
covered by the existing rail/transcript selection tests.

### T7. Keyboard focus parity (1.0 h)

**Files.** `workspace-runner.ts`, `workspace-input-parity.test.ts`.

**Steps.** Tab order, Escape return, no stale focus after a panel closes through
Escape, mouse or a command result. Test each close path.

**Verifier.** `node --test packages/cli/src/tui/workspace-input-parity.test.ts`.

**As built.** Chat composer focus is derived from the visible surface through
one exported invariant instead of being remembered by individual close paths.
The runner uses that invariant on every redraw and after command results, so
Escape, Tab, mouse and command-result closes cannot leave stale focus. The
model picker pane cycle is one exported transition; Tab alternates providers
and models while preserving query, cursor and selection, and a closed picker
has no focus owner. Tests cover panel return plus detail, confirmation,
settings, palette, diff, keybinding and cheat-sheet overlays.

### T8. Snapshot and PTY refresh (1.0 h)

**Files.** `test/visual-snapshots.json`, `scripts/src/verify-tui-terminal.py`.

**Steps.** Run with `NOMO_UPDATE_SNAPSHOTS=1`; diff the JSON key by key; accept
only frames a T node names; run the PTY matrix at all five sizes; record counts.

**Verifier.** `node --test packages/cli/src/tui/visual-snapshots.test.ts`; PTY.

**As built.** The snapshot refresh was run with `NOMO_UPDATE_SNAPSHOTS=1`; it
rewrote the same 120 frame hashes and produced zero diff lines, so no frame was
accepted without a named T-node change. The real PTY matrix passed all eight
interactive scenarios at all five terminal sizes, plus the termination and
Ctrl+D restore cases.

### T9. Accessibility pass (1.0 h)

**Files.** `a11y.test.ts`.

**Steps.** For every fact added in T2-T5: monochrome, ASCII preset and frozen
motion carry the same words. Add one assertion per new fact.

**Verifier.** `node --test packages/cli/src/tui/a11y.test.ts`.

**As built.** Every workspace tab now has a monochrome, truecolour and ASCII
frame comparison. Colour changes no text and the ASCII preset keeps the same
word multiset. One assertion table covers the T2 through T5 facts visible on
each panel: empty run/document/usage states, measured or unmeasured status,
MCP connection, policy and tool counts, model inventory, escape hints and the
Chat composer. The frozen-motion invariant remains separately asserted.

### T10. Performance re-measure (0.5 h)

**Files.** `perf-budget.test.ts` (read-only unless it regresses).

**Steps.** Run; record p50/p95 at 200x48 and 80x24; if p95 > 50 ms, profile the
row builder before changing anything.

**Verifier.** `node --test packages/cli/src/tui/perf-budget.test.ts`.

**As built.** The budget did not regress, so the test file stayed read-only.
Measured 200x48 cold 166.13 ms, p50 1.70 ms, p95 2.06 ms, max 3.37 ms over 40
frames with 12,799 transcript rows and 31 visible. Measured 80x24 cold 130.61
ms, p50 1.36 ms, p95 1.71 ms, max 2.55 ms over 40 frames with 14,399 transcript
rows and 6 visible. Cold build scaling was 2.09x time for 2.00x rows.

### T11. Optional Ink parity spike (2 h)

**Gate.** Owner asks for it after T1-T10.

**Files.** New spike under `packages/cli/src/tui/spike/`, not wired to the
runner, not in package.json until the diff is empty.

**Steps.** Render one screen (Help) through the candidate library; strip ANSI;
compare against the committed snapshot at five sizes; record the diff. If the
diff is not empty, remove the spike and record why.

**Verifier.** byte diff against `visual-snapshots.json`.

**As built.** Rejected and removed. The negative-control spike fed the exact
current Help frame through Ink 8.0.0, so no layout mistake could explain the
result. All five required hashes differed, all lines differed, trailing padding
was missing, and the two wide sizes doubled row count through wrapping. Ink's
renderer hard-codes `trimEnd()` per line, while the TUI contract requires every
row padded to terminal width. The spike directory and temporary dependency
links were removed; no production switch or package dependency was added.

### T12. Optional orphan verifier retirement (0.5 h)

**Files.** `scripts/src/verify-opentui-terminal.py`.

**Steps.** Confirm no caller (`grep` across package.json, docs, scripts); delete
it with the reason in the graph, or keep it with a recorded reason.

**Verifier.** `git diff --check`; no caller remains.

**As built.** The orphaned OpenTUI verifier was deleted. It had no caller in
package scripts, docs instructions, CI or other scripts; remaining mentions are
historical memory and decision records. The decision log now records that T12
retired the orphan instead of claiming it is still in the tree.

## 6. Track B - harness work packages

### H1. Reward record (2 h)

**Why.** Outcomes exist but nothing turns them into one number a policy can
optimise. Without it, "learning" is a story.

**Files.** `packages/workbench/src/harness-scores.ts`,
`packages/workbench/src/harness-scores.test.ts`,
`scripts/src/harness-eval.mjs`.

**Steps.**
1. Add the `RewardRecord` type from section 2.1.
2. Compute `reward = passed - breach*0.5 - cost*lambda - latency*mu`; take
   weights from settings, not constants.
3. A guardrail without a producer is the string `unmeasured`, never zero.
4. Write one record per evaluated case; store no prompt or output text.
5. Test: a fixture case with two runs produces one record; recomputing the
   reward from the record equals the stored value.

**Acceptance.** Reward is reproducible from the record and its weights.

**Verifier.** `node --test packages/workbench/src/harness-scores.test.ts`.

**Rollback.** Remove the record type and its test; no other module reads it yet.

### H2. Variant identity (1.5 h)

**Files.** `harness-settings.ts`, `harness-eval.mjs`, new test.

**Steps.**
1. Canonicalise `{settings, promptPreamble, model}` and hash it.
2. Write `variantId` and `changedAxis` with each case.
3. Refuse to compare two records whose digests differ in more than one axis.
4. Test: two variants differing only in `autoCompactMessages` are comparable;
   differing in two axes are not.

**Acceptance.** "A beat B on case X" is checkable from records.

**Verifier.** eval run with two variants + unit test.

### H3. Eval set v2 (2 h)

**Files.** New `scripts/src/fixtures/harness-eval-v2.json` (do not edit v1).

**Steps.**
1. Add tasks for: read-before-write, approval hold, tool timeout, truncated
   result, compaction, SSRF refusal, plan use, todo use, unknown tool.
2. At least 12 tasks, each with `id`, `prompt`, `expectedTool`,
   `expectedClass`, and `split: "train"|"eval"`.
3. Freeze: a change is a new file, never an edit.
4. Run the eval with a fixture runner and record the pass rate.

**Acceptance.** 12+ tasks, both splits named, no task edited after freezing.

**Verifier.** `node scripts/src/harness-eval.mjs scripts/src/fixtures/harness-eval-v2.json -- <fixture runner>`.

**As built.** 14 tasks (7 `train`, 7 `eval`); a refusal is the decision
`{"tool":"none","class":"refused"}`. The freeze is a pinned sha256 in
`scripts/src/harness-eval.test.mjs`. The fixture runner is
`scripts/src/fixtures/harness-eval-oracle-runner.mjs`, which echoes the
taskset's own expectation: its 14/14 proves the plumbing, not a model.

### H4. Reward replay (1 h)

**Files.** New `scripts/src/harness-replay.mjs` + test.

**Steps.** Read a chain, find reward records, recompute each from its weights,
report mismatches. Test with a fixture chain containing one good and one
tampered record.

**Acceptance.** Replay matches the stored reward for every untouched record and
names the tampered one.

**Verifier.** `node --test scripts/src/harness-replay.test.mjs`.

**As built.** Reads a ledger chain (`body` per entry) or bare eval record
lines, recomputes with `computeReward`, prints `OK`/`MISMATCH`/`INVALID`/
`UNREADABLE` per record with ids only. An unmeasured reward must stay
unmeasured. Exit 1 on any non-match or when no reward record exists. Replay
checks rewards only; hashes and signatures stay with the ledger verifier.

### H5. Activation and rollback (1.5 h)

**Files.** `refine-trigger.ts`, `workspace.ts`, `refine-trigger.test.ts`.

**Steps.** Activation requires the exact digest typed; rollback triggers on any
measured guardrail regression; a rolled-back variant cannot be re-activated
without a new digest. Test both paths.

**Acceptance.** No activation without a typed digest; rollback is one command.

**Verifier.** `node --test packages/workbench/src/refine-trigger.test.ts`.

**As built.** Pure decisions in `refine-trigger.ts`; the workbench still writes
every signed record. `activationGate(digest, typed, rolledBack)` activates only
on a byte-exact typed digest (no prefix, trim or case fold) and refuses a digest
in `rolledBackDigests(entries)`, the set read from signed
`harnessRefinement.rolledBackDigest` records. `rollbackOnGuardrailRegression`
runs H8's gate and calls the injected rollback (`rollbackHarnessProposal`) only
when a measured guardrail regressed; an unmeasured guardrail returns
`insufficient-data` and rolls nothing back. The integration test activates a
real proposal, rolls it back on a regression, refuses the old digest and
accepts a new proposal's digest. `workspace.ts` and the CLI are unchanged: the
TUI still resolves a prefix to one proposal and confirms the full digest, and
`nomo harness approve` still accepts a unique prefix.

### H6. Trend report (1 h)

**Files.** `packages/cli/src/harness.ts` (or a workbench view).

**Steps.** Per activation: pass rate, reward, guardrail state, sample count,
delta from the previous activation. Insufficient data prints
`insufficient-data`.

**Verifier.** fixture chain with two activations prints a measured delta.

**As built.** `nomo harness trend` now prints per activation: pass rate, mean
recomputable reward, measured reward sample count, numeric delta from the
previous activation, guardrail state and `insufficient-data` when either side
cannot be measured. Reward records count only when their stored reward
recomputes; malformed or mismatched records are counted as unmeasured, never
zero. Activation reward windows end before the next activation or rollback so
one activation cannot borrow another activation's measurement.

### H7. Held-out split (1 h)

**Files.** `harness-eval.mjs`.

**Steps.** Split by task id; selection reads only `train`; the report prints
`eval` separately; a training task cannot score eval.

**Verifier.** unit test that mixes the lists and expects a refusal.

**As built.** `heldOutSplit` refuses a task without a split, an empty side,
or an eval task sharing an id or prompt with a train task, before anything
runs. `trainResults` is the only selection input and refuses eval or unknown
ids. The report prints `train:` and `eval (held-out):` from `splitTotals`;
`--split train|eval` runs one side. v2 splits 7/7.

### H8. Guardrail regression detector (1 h)

**Files.** `harness-scores.ts`.

**Steps.** Compare each measured guardrail with the previous activation; any
worse value blocks; `unmeasured` is never a pass.

**Verifier.** fixture regression fails the gate.

**As built.** `guardrailRegressionGate(previous, current)` takes two boards'
guardrail summaries and checks `deny_rate`, `rollback_count` and
`unknown_tool_rate` by mean with no noise band: any worse value is
`regressed`, a missing mean on either side is `unmeasured`, and either blocks.
It is a pure report; H5 `rollbackOnGuardrailRegression` consumes it.

### H9. Trajectory export (1.5 h)

**Files.** New `scripts/src/trajectory-export.mjs` + test.

**Steps.** Export `TrajectoryRecord` from section 2.5; tool names and outcomes
only; assert no prompt text or tool output reaches the file.

**Verifier.** `node --test scripts/src/trajectory-export.test.mjs`.

**As built.** `exportTrajectories` reads a ledger chain or bare JSONL; the
terminal tool entries since the previous `nomo.reward.v1` record form that
case's `toolCalls`, built from an allowlist (`name`, `klass`, `ok`). A name or
class that is not an identifier refuses the case; a reward that does not
recompute is refused. `ok` is `"unmeasured"` for `execute:unknown`. Grouping is
positional until tool entries carry a case id. It exports data; it trains
nothing.

### H10. Cost and latency weights (1 h)

**Files.** `harness-settings.ts`, `harness-settings.test.ts`,
`scripts/src/harness-inventory.test.mjs`.

**Steps.** Two documented settings with consumers; inventory gap list stays
empty.

**Verifier.** `node --test scripts/src/harness-inventory.test.mjs`.

**As built.** `rewardCostWeight` and `rewardLatencyWeight` are documented
numeric harness settings. They clamp as decimal weights to six places, zero
means that measured term is ignored, and `rewardCostLatencyWeights` exposes the
resolved pair to reward consumers. `variantIdentity` includes both axes. The
breach weight stays explicit at the reward call site. Missing measurements
remain `unmeasured`; the settings never turn an absent producer into zero.

### H11. Eval runner adapter (1.5 h)

**Files.** New `scripts/src/harness-eval-runner.mjs`.

**Steps.** A local runner that answers the taskset through the governed path;
no model grading; no network without approval; prints one JSON decision line.

**Verifier.** eval run prints per-task results.

**As built.** `scripts/src/harness-eval-runner.mjs` is a deterministic offline
adapter. It proposes one first action from the prompt, validates the tool
against the governed catalog, classifies it with `workspaceToolClass`, and
fails closed for unknown tools and unsafe web requests. It prints one JSON
decision line. It is plumbing and governance evidence only, not model
capability evidence; no provider or network is called.

### H12. Learning-loop documentation (0.5 h)

**Files.** New `docs/HARNESS-LEARNING.md`.

**Steps.** One page: proposal -> approval -> activation -> measurement ->
rollback, with the record names and the commands.

**Verifier.** manual read.

**As built.** `docs/HARNESS-LEARNING.md` is the one-page operator contract. It
names proposal, approval, activation, measurement, replay, trend and rollback;
lists the signed record names and commands; and states that the loop is a
contextual bandit and policy search, not reinforcement learning.

### H13. Reward record schema versioning (1 h)

**Files.** `packages/ledger/src/store.ts`, ledger tests.

**Steps.** A versioned record type; old records still verify; a reader that sees
an unknown version reports it instead of guessing.

**Verifier.** `node --test packages/ledger/src/*.test.ts`.

**As built.** `REWARD_RECORD_SCHEMA_V1` is the only reward schema this binary
interprets. `readRewardRecordSchema` treats schema-less chain history as legacy,
accepts exact `nomo.reward.v1`, and makes the store, strict verifier and per-record
verifier report an unknown reward version instead of guessing. The finding is
bounded and terminal escaped. Other schema families remain outside this reward
reader.

### H14. Operator commands (1.5 h)

**Files.** `packages/cli/src/harness.ts`, CLI test.

**Steps.** `nomo harness reward <case>` and `nomo harness trend`; measured or
unmeasured, never a guess.

**Verifier.** CLI test.

**As built.** `nomo harness trend` already prints signed activation effects.
`nomo harness reward --session <id> <caseId>` now reads matching
`nomo.reward.v1` records from the verified workspace chain, recomputes each
stored reward before printing it, refuses a mismatch, prints measured fields
or `unmeasured`, and separately rescoring under the operator's current
`rewardCostWeight` and `rewardLatencyWeight`. A missing case prints no record;
it never guesses.

### H15. End-to-end fixture dry run (1 h)

**Files.** scripts + fixture.

**Steps.** A fixture proposal activates, is measured, and rolls back, with no
model call.

**Verifier.** `node --test scripts/src/harness-*.test.mjs`.

**As built.** `scripts/src/harness-e2e-fixture.test.mjs` starts an isolated
Workbench against the in-memory fixture provider, activates one exact-digest
proposal, runs the frozen eval through the deterministic offline runner, writes
the first measured reward into the workspace chain through
`recordHarnessReward`, reads it back with `nomo harness reward`, and rolls the
activation back. There is no live model, provider or network call.

## 7. Track C - RL policy search work packages

Honest scope: a contextual bandit over harness variants. Not gradient RL.

### R1. Arm definition (1 h)

**Files.** New `packages/workbench/src/harness-arms.ts` + test.

**Steps.** At most four arms per axis for `autoCompactMessages`,
`maxToolResultCharacters`, `promptPreamble`; each arm has an id, value and
digest; a guardrail-changing axis is marked.

**Verifier.** unit test.

### R2. Thompson sampler (2 h)

**Files.** New `harness-bandit.ts` + test.

**Steps.** Beta posterior per arm; sample; budget in tokens; stop when the
posterior separates or the budget is spent; persist state append-only.

**Verifier.** simulation over fixture rewards prefers the better arm and stops
at the budget.

### R3. Reward aggregation (1 h)

**Files.** `harness-scores.ts`.

**Steps.** Aggregate per arm with cost and latency penalties; weights from
settings.

**Verifier.** unit test.

As built (R3): `aggregateArmRewards(armIds, observations, weights)` refuses a
record whose stored reward does not recompute, rescores each record under the
operator's weights, and reports per arm the measured/unmeasured counts, mean
reward and mean cost and latency penalties. `toBanditReward` floors a reward
below 0 to 0 (a reward is never above 1) and the aggregate counts each floored
record; an unmeasured reward stays `"unmeasured"` and is never fed to the
bandit or averaged as zero.

### R4. Exploration guard (1 h)

**Files.** `harness-bandit.ts`.

**Steps.** Refuse to explore an axis that changes a guardrail without an
approval; the refusal is explicit in the record.

**Verifier.** test refuses that axis.

As built (R4): `openBandit` on an axis marked `guardrail` (today
`promptPreamble`) without an approval whose `armsDigest` equals
`armsDigest(arms)` writes a `refusal` line after the start and returns a state
stopped with `unapproved-guardrail`. Replay derives the refusal from the start
event, so neither a reset nor deleting the refusal line lifts it; a later
approval needs a new history.

### R5. Activation from a sampled arm (1.5 h)

**Files.** `refine-trigger.ts`.

**Steps.** Activation names the arm and digest; goes through the existing gate.

**Verifier.** integration test.

**As built.** `activateSampledArm(arms, sampledArmId, typed, rolledBack)` takes
the id `sampleArm` returned, requires the arm to verify against its own digest,
and passes the typed digest through `activationGate`; the result names `armId`,
`axis`, `value` and `digest`. The integration test runs a real bandit file
through `sampleArm`. Nothing applies the arm's value to settings yet, and R4's
approval guard for guardrail axes is not part of this gate. A bandit, not RL.

### R6. Simulation report (1 h)

**Files.** New `scripts/src/harness-bandit-sim.mjs`.

**Steps.** Print regret, samples per arm and the stop reason; no model call.

**Verifier.** run prints a table.

**As built.** `scripts/src/harness-bandit-sim.mjs` runs a deterministic
two-arm compaction simulation with no model or network. It prints cumulative
simple regret, samples per arm, spent and budgeted tokens, and the stop reason;
`harness-bandit-sim.test.mjs` proves the better arm receives more samples and
the command prints the table.

### R7. Wording guard (0.5 h)

**Files.** `docs/HARNESS-LEARNING.md`.

**Steps.** State the difference between bandit, policy search and gradient RL;
no claim of RL training.

**Verifier.** manual read.

**As built.** `docs/HARNESS-LEARNING.md` now separates bandit, policy search
and gradient RL. It states that this repository has no trainable local model,
GPU budget or training path, so no NOMO surface may claim RL training.

## 8. Track D - quality work packages

| id | steps | verifier | acceptance |
|---|---|---|---|
| Q1 | Node script: duplicate ids, dangling deps, done without evidence | node script | 0 / 0 / 0 |

Q1 as built: `scripts/src/work-graph-check.mjs` checks duplicate ids, dangling dependencies and done nodes without evidence. It prints only counts and exits nonzero when any count is nonzero.
| Q2 | Fix dead-path inventory and stale inventory named by doc-truth | `node --test scripts/src/doc-truth.test.mjs` | 9/9 |
| Q3 | `test-fixture.ts`: wire it or allowlist with a reason | `node --test scripts/src/module-inventory.test.mjs` | 2/2 |
| Q4 | Regenerate harness inventory | `node --test scripts/src/harness-inventory.test.mjs` | every documented key present, empty gap list |
| Q5 | Provider smoke against local Zen; never print the key | `node scripts/src/provider-smoke.mjs` | PASS or SKIP with a reason |
| Q6 | Rebuild dist; check `nomo --version` and that dist is newer than source | `node scripts/src/bundle-cli.mjs` | version matches package |
| Q7 | Dependency audit; lockfile clean; no new dep without a reason | `pnpm install --frozen-lockfile --offline` | no drift |
| Q8 | Local CI in documented order: typecheck, TUI, workbench, scripts | those commands | green or named pre-existing |
| Q9 | Update CONTEXT/STANDARDS only if a contract changed | manual read | no contradiction |
| Q10 | Handoff page: shipped, blocked, next ready node | manual read | new session can start |

## 9. Track E - gated work

| id | gate | steps | verifier |
|---|---|---|---|
| G1 | Trainable local model + GPU budget | SFT then DPO over H9 trajectories; held-out eval before/after; activation only through H5 | held-out eval does not regress |
| G2 | Owner asks after T1-T10 | parity adapter for one screen, then a second, byte-diffed at 5 sizes | empty diff |
| G3 | Owner approves a paid benchmark | frozen taskset against a hosted model; record cost | per-task results |
| G4 | Owner approves release | tag, changelog, push, deploy | release notes |

## 10. Rollback plan

| Change | Rollback |
|---|---|
| Any T panel node | revert the row builder and its five hashes |
| Snapshot refresh | `git checkout` the JSON and re-run the suite |
| Reward schema | remove the record type; nothing reads it until H6 |
| Bandit state | delete the state file; the prior is the documented default |
| Activation | the existing rollback command, by digest |
| Dependency | `pnpm remove <pkg>`; lockfile diff must be empty |
| Dist rebuild | rebuild from the previous commit; the launcher reads dist |

## 11. Expansion backlog beyond 24 hours

These are real, scoped follow-ups, not wishes. ~40 h.

1. **T13 Session browser**: fold sections, keyboard-only navigation, inspector
   at 120+ columns, empty state. 3 h.

   As built: already present and verified. Enter folds section headings, arrow
   keys and paging keys navigate without a mouse, the inspector is side by side
   at 120 or more columns and replaces the list below that threshold until Esc,
   and empty plus filtered states are explicit.
2. **T14 Diff panel**: per-hunk staging, split/unified, side-by-side at 160+.
   3 h.

   As built: the diff panel already owned immutable hunk cursor/staging state;
   this node added the missing acceptance proof. At 160 columns unified and
   split render with hunk counts, two-column before/after rows and width
   bounds, while per-hunk staging changes the reported scope.
3. **T15 Model picker**: provider groups, capability disclosure, refusal when a
   session is running. 2 h.

   As built: provider grouping already existed as configured provider sections
   plus the picker's provider pane. The missing disclosure path is now fixed:
   compatible provider catalogs preserve direct `contextWindow`, `maxTokens`,
   `capabilities`, `inputPrice` and `outputPrice` fields, and the Workbench
   projection no longer strips them before the picker renders them. Session
   model changes were already guarded by Workbench; a test now proves a running
   conversation refuses the change and keeps its model.
4. **T16 Ledger view**: signed/derived split, chain status, filter by class.
   3 h.

   As built: the signed/derived split and chain status were already grouped,
   ordered and verified. Managed and proxy rows now show their risk class in
   the row label, so typing `r1` or another class into the existing filter is a
   visible, explainable filter rather than a search over hidden JSON detail.
   Four intentional ledger snapshot hashes were refreshed after review.
5. **T17 Command palette**: fuzzy ranking, recent commands, no hidden action.
   2 h.

   As built: the palette already draws from `TUI_COMMANDS` rather than a second
   command list, so no hidden action can exist there. Tests now pin exact,
   prefix, substring and subsequence ranking, frecency order and the invariant
   that recency reorders commands without hiding any of them.
6. **T18 Theme system**: one token file, contrast test for every pair, no
   colour-only meaning. 3 h.

   As built: `theme-config.ts` remains the single token source. Text-bearing
   tokens in paper and both solarized themes were adjusted within their hue
   families until every non-decorative token/background pair reaches WCAG
   normal-text contrast 4.5:1. Border and rule remain decorative separators.
   Existing monochrome/ASCII/frozen-motion tests pin the no-colour-only
   contract.
7. **H16 Evaluation corpus from real runs**: opt-in, content-minimised,
   reviewed before freezing. 4 h.
8. **H17 Reward model**: only after H16 and a human-labelled subset; a model
   that grades is not a measurement until it is validated against humans. 6 h.
9. **H18 Multi-axis bandit**: two axes at once with interaction terms. 4 h.

   As built: `harness-factorial-bandit.ts` composes a complete 2x2 factorial
   treatment set from two harness axes, verifies every component digest,
   explores the joint treatments with Thompson sampling and keeps append-only
   replayable state. Main effects and the interaction contrast are computed
   only when all four cells have measured reward; any empty cell is
   `unmeasured`, never zero. A guardrail axis still needs approval bound to
   the exact treatment digest set, and prompt text remains outside the record.
10. **R8 Offline policy evaluation**: importance weighting for a new arm without
    deploying it. 3 h.

    As built: `offline-policy.ts` evaluates deterministic candidate arms from
    logged rounds with inverse propensity scoring, coverage and effective
    sample size. A candidate outside logging-policy support is explicitly
    `unmeasured`, never zero, so absence of support cannot be read as failure
    or success. No arm is deployed and no model is trained.
11. **Q11 Packaging**: install from a tarball, run the TUI, verify the launcher.
    2 h.

    As built: every versioned manifest now moves together at 1.0.1, closing
    the previously named release packaging mismatch. The CLI clean-install
    integration packs the built tarball, installs it outside the workspace,
    executes the installed `.bin/nomo` launcher for `--version`, then smoke
    tests that same launcher in a real PTY: the TUI renders the NOMO composer,
    double Ctrl+D exits cleanly, and alternate screen, bracketed paste and
    termios are restored. The npm-registry integration remains explicitly
    opt-in through `NOMO_NETWORK_PACKAGING_TEST=1`.
12. **Q12 Docs**: operator handbook refresh for the new commands. 2 h.

    As built: both handbook editions now document `/health`, `/discover`,
    `/usage`, `/diff-next`, `/pet`, `/settings` and `/revoke-agent`, including
    the exact local-only boundary of agent revocation. The handbook gate now
    imports the TUI command registry itself, so a newly registered command that
    is absent from either edition fails the test instead of drifting silently.
    The retired OpenTUI verifier is explicitly inventoried as history, keeping
    the documentation truth gate green after T12.
13. **Q13 Security review**: threat model for the eval runner and trajectory
    export. 3 h.

    As built: `docs/THREAT-MODEL.md` section 9 reviews both artifacts as
    hostile-input offline measurement plumbing. The eval runner proposes and
    classifies but never executes, networks or calls a provider. Trajectory
    export copies only an allowlisted schema, bounds identifiers, refuses
    non-recomputing rewards and reports unattributed positional evidence. The
    review names the remaining same-user signature ceiling, positional
    misattribution, future provider-adapter gate and the explicit absence of
    training or gradient RL.
14. **H19 Reward ingestion**: bare eval reward files enter the signed workspace
    chain through an operator command. 2 h.

    As built: `nomo harness ingest-rewards --session <id> <records.jsonl>`
    validates the whole file before writing. It accepts only bounded
    `nomo.reward.v1` fields, exact weights and rewards that recompute exactly;
    prompt or tool-content side channels are refused without being printed.
    Valid records are appended through `recordHarnessReward` with sha256 file
    digest plus record position as signed ingestion metadata. An exact rerun
    skips positions already written, a partial write resumes missing positions,
    and an independent measurement file with equal values remains new evidence.
    Files are bounded to 1 MiB. No tool, provider, network or model execution
    is part of ingestion.
15. **H20b Tool-using eval attribution**: explicit measurement records from a
    truthful offline tool execution fixture. 3 h.

    As built: `scripts/src/fixtures/harness-eval-v3-tools.json` is frozen.
    `harness-eval --execute-workspace --measurements <path>` executes governed
    managed-document decisions through `executeWorkspaceTool` against fresh
    in-memory fixture state only. It writes `nomo.eval-tool.v1` records with
    case, variant, run, tool name, class and completion, never prompts,
    arguments, results or document content. `nomo harness ingest-eval` validates
    and signs mixed reward/tool measurement files with the same file digest and
    position provenance as reward ingestion. Trajectory export uses explicit
    ingestion-linked attribution when present and otherwise preserves the H20
    no-adoption boundary. Direct production-chain attribution is implemented
    for explicitly started eval runs through bounded `harnessEval` identity on
    chain entries; only legacy entries without that identity keep positional
    grouping.
16. **H20c Production eval attribution surface**: operator API and CLI access
    to attributed production eval runs. 2 h.

    As built: `POST /api/sessions` accepts optional `harnessEval` with exactly
    case, variant and run, rejects malformed identity as
    `invalid_session_eval` before session creation, and includes the validated
    identity in idempotency identity. `nomo harness run-eval` starts one real
    production run through `startHarnessEval`, waits for the terminal state,
    prints it and returns nonzero outside `idle`. It can incur provider cost
    only through that explicit invocation. It does not compute reward or claim
    a passed eval by itself. H20c4 adds `--idempotency-key`, so an exact CLI
    retry reuses the same run and a different request under that key is
    refused before another provider run starts. H20c5 exposes the same bounded
    identity on session views and API reads after restart, without widening it
    to prompt or tool content.

## 12. Program checklist

- [x] T1 design contract linked from README
- [x] Five panels at parity with empty states and 40x12 snapshots
- [x] Composer rail exactly `columns` cells at five widths
- [x] 40+ snapshots and 54+ PTY assertions green
- [x] Reward record reproducible from the chain
- [x] Variant identity comparable on one axis
- [x] 12+ frozen eval tasks with train/eval split
- [x] Activation requires a typed digest; rollback on guardrail regression
- [x] Trend command answers "is it learning?" with a number
- [x] Bandit simulation prefers the better arm and stops at budget
- [x] Inventories, doc-truth and smoke green or named
- [x] Handoff page names the next ready node
- [x] No secret, no prompt text and no tool output in any record
- [x] No test, snapshot or guardrail deleted to reach green

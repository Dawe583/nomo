# TUI improvement plan, 2026-11-25

Status: proposal. Nothing here is implemented by this document.

## What exists (verified)

- 49 production files in `packages/cli/src/tui/`, 32,207 lines; 20,191 lines of
  tests. `workspace.ts` alone is 16,430 lines and `WorkspaceTui` has 93 methods.
- `renderWorkspace(ui, columns, rows, input, editing, busy, visuals)` is a pure
  function: exactly `rows` lines, each padded to `columns`. The frame string is
  the contract.
- The adapter already diffs rows and writes only changed lines
  (`workspace-terminal.ts:221-255`).
- 40 visual snapshots at five sizes, SHA-256 of the ANSI-stripped frame;
  `NOMO_UPDATE_SNAPSHOTS=1` accepts an intended change.
- PTY matrix: 1,280 lines, 54 assertions, sizes 40x12, 80x24, 120x40, 160x45,
  200x48.
- Measured frame cost: p95 2.98 ms at 200x48 over a 12,799-row transcript,
  2.41 ms at 80x24, against a 50 ms ceiling.
- Accessibility contract: every fact a frame prints is a string; monochrome,
  ASCII preset and frozen motion carry the same words.
- Glyph presets `unicode|ascii|nerd`, 59 bundled icons, Kitty graphics for the
  Ghostty path.
- An Ink component skeleton was tried on 2026-11-25 and removed the same day:
  it carried none of the rails, chips, pet, icons or panels, so it was
  visually worse than the renderer it would replace.

## What is actually weak

1. **Panels are uneven.** Chat is the mature surface. `runs`, `mcp`, `status`,
   `documents` and `usage` are thinner, and the tab bar gives them the same
   weight as Chat.
2. **Composer density.** The rail has about one spare row at 40 columns; a mode
   chip duplicates the status pill (the blocked `composer-mode-chip` node).
   Chip overflow drops whole slots, but there is no rule for which slot is
   least useful.
3. **Narrow terminals.** 40x12 is verified, but Chat at 40 columns loses the
   action hint and the pet dock is cramped.
4. **Motion and pet.** The pet has one blink rhythm and no reaction to a
   completed run; motion frames are pinned but not budgeted per second.
5. **Mouse and keyboard parity.** Hit targets exist; selection, wheel and
   focus behaviour are covered unevenly across panels.
6. **No visual design document.** Tokens live in code (`theme-config.ts`,
   `palette.ts`, `brand.ts`) but there is no one-page rule set a contributor
   reads before adding a screen, which is how drift starts.

## Proposals, in priority order

### T1. Design contract for the TUI (one page)

Write `packages/cli/src/tui/DESIGN.md`: rail widths, slot ladder and drop order,
glyph presets, tone vocabulary, border rules, motion budget, pet grid, and the
rule that colour is never the only carrier. Every later node cites it.
Verifier: manual read plus a link check from README.
Stop: the document exists and every open TUI node names a rule it follows.

### T2. Panel parity pass

Bring `runs`, `mcp`, `status`, `documents` and `usage` to the Chat standard:
title row, empty state, one measured fact per row, footer hint, hit targets.
Scope: `workspace.ts` row builders plus their tests. One panel per node, one
writer per file.
Verifier per node: the panel's test file plus
`node --test --test-concurrency=1 packages/cli/src/tui/*.test.ts`.
Stop: each panel has a snapshot at five sizes and an empty-state test.

### T3. Composer density rules

Decide the blocked mode-chip question in writing: either drop the status-row
pill first or accept one claim in two places. Then implement a slot priority
ladder (`mode > queue > model > context > pet`) and drop the lowest-priority
slot whole. No new rows at 40 columns.
Verifier: `workspace.test.ts` rail-cell assertions, PTY at 40x12.
Stop: the rail is exactly `columns` cells at every size and the action hint
survives at 40 columns.

### T4. Narrow-terminal pass

Audit 40x12 and 52x16: every screen must show its title, its primary fact and
its escape hint. Fix by dropping decoration, never by clipping a word.
Verifier: PTY matrix plus one snapshot per screen at 40x12.
Stop: no screen loses its hint at 40x12.

### T5. Motion and pet budget

Add a completed-run reaction, a second blink rhythm and a listening pose; cap
animation work at one frame per 100 ms and prove reduced motion is
byte-identical.
Verifier: `pet.test.ts`, `perf-budget.test.ts`, `a11y.test.ts`.
Stop: every pose fits 9x5, every frame is a pure function of the counter.

### T6. Library components, parity-first (optional, gated)

Only if the owner still wants a library after T1-T5. Rule: a candidate must
reproduce all 40 snapshot hashes and the 54 PTY assertions byte for byte behind
an adapter before it is offered as a surface. Start with one screen (Help or
Models), not the frame. No dependency lands in `packages/cli` until that diff
is empty.
Stop: the diff is empty, or the attempt is recorded as failed and removed.

## Workflow

```
T1 design contract
   └─> T2 panel parity (runs, mcp, status, documents, usage - one node each)
   └─> T3 composer density ──> T4 narrow terminals
   └─> T5 motion and pet
   └─> T6 library parity gate (only on request)
```

Each node runs Discover -> Specify -> Change -> Verify -> Review -> Record. A
node is done only with the verifier output quoted in `.nomo/work-state.json`
and the Obsidian work log. One writer per file; `workspace.ts` is the shared
path, so T2 nodes are serialised or split by panel builder.

## What this plan refuses

- A big-bang renderer rewrite.
- A library surface that looks worse than the current one, even temporarily.
- Deleting a snapshot or a PTY assertion to reach green.

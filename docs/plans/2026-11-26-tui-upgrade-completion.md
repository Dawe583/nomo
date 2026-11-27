# TypeScript TUI upgrade completion audit, 2026-11-26

Status: verified audit. This is not a claim that the upgrade is complete.

## Already complete and not to be duplicated

The original TUI improvement plan is implemented: T1 design contract, T2 panel parity for runs/MCP/status/documents/usage, T3 composer density, T4 narrow terminals, T5 motion/pet, T6 mouse parity, T7 keyboard/focus parity, T8 snapshot/PTY refresh, T9 accessibility, T10 performance, T11/T12 library spike verdicts, T13 session browser, T14 diff panel, T15 model picker, T16 ledger view, T17 command palette and T18 theme system are all done in `.nomo/work-state.json`. The later TypeScript transcript position indicator and palette aliases are also done.

The command palette already has fuzzy ranking, aliases, frecency and a width-gated preview pane. Approvals already have evidence, risk classes, countdowns, sticky banner and review detail. Mouse selection, clipboard copy, visual snapshots, PTY coverage, monochrome/ASCII/reduced-motion parity and row-level diffed terminal writes already exist.

## Verified remaining gaps

1. `packages/cli/src/tui/minimap.ts` is a real minimap implementation integrated from older OMP work, but no production source imports it and it has no focused test. It is orphaned rather than user-visible.
2. `packages/cli/src/tui/chat-markdown.ts` is also unimported. Its safe inline-Markdown behavior is now duplicated inside `workspace.ts`; keeping both invites drift. Either wire the shared module or retire it deliberately.
3. `packages/cli/src/tui/run-activity.ts` is unimported in this checkout. It carries useful redaction/activity formatting but needs an ownership and integration decision before reuse.
4. Terminal writes are row-damaged, not cell-damaged, and do not use scroll regions. This is a performance optimization only; current measured frame cost already has a large margin.
5. Clipboard uses OS commands, not OSC52. OSC52 would be a useful terminal-native fallback but must not replace the working OS path blindly.
6. There is no chat minimap, unread/new-output marker, or unified application chrome beyond the existing tab/status surfaces. These are product additions beyond the original completed plan, not unfinished T1-T18 work.
7. Rust remains a bounded spike and is explicitly deferred by the owner. No production Rust wiring is part of this TypeScript completion track.

## Completion order

U2 wire or retire the orphaned chat markdown module without changing user-authored text.
U3 wire the minimap into Chat with exact frame geometry and monochrome parity, or retire it if integration cannot preserve the design contract.
U4 decide `run-activity.ts` integration/retirement against the existing tool-detail renderer.
U5 add terminal-native fallback only where evidence shows a real gap.
U6 audit application chrome/unread indicators and implement only gaps not already covered.
U7 final audit, documentation and handoff.

Each implementation slice must keep exact rows/columns, never paint a terminal background, preserve ASCII/monochrome/reduced-motion facts, update visual snapshots only for intended visual changes, and commit atomically after focused verification.

## U2 shared inline Markdown wiring

`chat-markdown.ts` is no longer orphaned: it now owns the safe strong/code inline-Markdown span splitter and `workspace.ts` consumes it. The obsolete unused whole-line helper was removed in-place; user-authored text and rendered frames are unchanged. Evidence: CLI typecheck exit 0; focused workspace/a11y/visual snapshot tests 144/144. No visual snapshot accepted.

## U3a minimap primitives

The orphaned minimap module is now a tested primitive: exact-height one-cell rendering, row-to-event mapping, approval precedence, sequence gaps, unicode and complete ASCII glyphs. Evidence: CLI typecheck exit 0; focused minimap tests 4/4. It is not yet wired into Chat.

## U3b Chat minimap wiring

Chat now wires the tested minimap as a one-cell positional edge from 72 columns when a real conversation exists. The transcript is wrapped one cell narrower, mouse selection treats the edge as chrome, ASCII uses ASCII glyphs, and 40-column frames are unchanged. Intended visual change reviewed at 80x24 before accepting snapshots. Evidence: CLI typecheck exit 0; focused workspace/parity/a11y/visual/minimap tests 251/251; 120 visual snapshot hashes accepted intentionally.

## U4 shared run activity helpers

`run-activity.ts` is no longer an orphaned duplicate formatter: it now owns shared tool-payload record guarding, secret redaction, private-reasoning key filtering and output extraction used by `workspace.ts`. The canonical redaction preserves private-key-block and credential/token handling. Evidence: CLI typecheck exit 0; run-activity tests 2/2; focused workspace/parity/a11y/visual tests 247/247; frames unchanged.

## Full PTY matrix checkpoint

Full TypeScript TUI PTY matrix after the minimap and run-activity consolidation: PASS for every scenario at 40x12, 80x24, 120x40, 160x45 and 200x48, including terminal restore, bracketed paste, mouse and exit paths.

## U5a OSC52 clipboard primitive

OSC52 clipboard primitive added and tested: exact UTF-8 round trip through base64, safe payload alphabet, explicit empty/oversize refusal. It is not yet wired into the runner fallback. Evidence: CLI typecheck exit 0; clipboard tests 2/2.

## U5b OSC52 clipboard fallback

Prompt and mouse-selection copy now use the OS clipboard first and fall back to a bounded user-initiated OSC52 terminal sequence only after system clipboard failure. The UI says “sent to terminal clipboard” for OSC52 because the terminal does not acknowledge acceptance. Oversize copies fail closed. `writeGraphics` now treats Node backpressure as queued output rather than failure. Evidence: CLI typecheck exit 0; clipboard/runner/terminal unit tests 7/7; focused workspace/parity/a11y/visual/terminal tests 258/258; full PTY matrix PASS at every scenario and size.

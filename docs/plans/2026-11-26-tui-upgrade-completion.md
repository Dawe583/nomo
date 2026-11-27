# TypeScript TUI upgrade completion audit, 2026-11-26

Status: completed scoped TypeScript TUI upgrade audit. The gaps below were the audit baseline; U2-U7 record their resolution or deliberate deferral. This is not a claim that NOMO is release-ready or that the Rust migration is complete.

## Already complete and not to be duplicated

The original TUI improvement plan is implemented: T1 design contract, T2 panel parity for runs/MCP/status/documents/usage, T3 composer density, T4 narrow terminals, T5 motion/pet, T6 mouse parity, T7 keyboard/focus parity, T8 snapshot/PTY refresh, T9 accessibility, T10 performance, T11/T12 library spike verdicts, T13 session browser, T14 diff panel, T15 model picker, T16 ledger view, T17 command palette and T18 theme system are all done in `.nomo/work-state.json`. The later TypeScript transcript position indicator and palette aliases are also done.

The command palette already has fuzzy ranking, aliases, frecency and a width-gated preview pane. Approvals already have evidence, risk classes, countdowns, sticky banner and review detail. Mouse selection, clipboard copy, visual snapshots, PTY coverage, monochrome/ASCII/reduced-motion parity and row-level diffed terminal writes already exist.

## Verified remaining gaps at the audit baseline

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

## U6a minimap navigation geometry

Minimap mouse-navigation geometry is now published and tested: exact outermost column/body band, proportional inverse mapping, endpoint clamping and drag clamping. No mouse behavior or frame output changed yet. Evidence: CLI typecheck exit 0; minimap mouse tests 3/3; focused workspace/parity/visual tests 233/233.

## U6b interactive minimap navigation

Chat minimap is now interactive: a plain left click or drag on the one-cell edge proportionally jumps/centres the transcript, clamps drags inside the band and restores live-follow at the bottom. Text selection still treats the edge as chrome. Evidence: CLI typecheck exit 0; minimap mouse/terminal lifecycle tests 7/7; focused workspace/parity/terminal/visual tests 244/244; no visual snapshot change.

## U6c minimap navigation discoverability

Interactive minimap navigation is now discoverable in Help and the design contract: chat help names minimap click/drag, scroll help names it beside PgUp/PgDn and /bottom, and DESIGN.md records that the edge is both non-selection chrome and a proportional navigation control. The 80x24 frame was reviewed and text shortened to avoid needless wrapping. Evidence: CLI typecheck exit 0; focused workspace/a11y/visual/minimap-mouse tests 148/148; 120 visual snapshots intentionally refreshed for the four Help text changes.

## U6d application chrome and unread audit verdict

Application chrome/unread audit verdict: no additional chrome layer is justified. Unread/new-output coverage already exists through the sticky transcript breadcrumb, exact `first-last/total` position and explicit `N below` count while scrolled up; unified chrome already exists through the persistent `NOMO <panel>` frame title across panels and the Chat header/footer/task rail. Adding another bar or unread pill would duplicate existing facts and cost rows. The real implementation gap found in this audit was minimap discoverability/navigation, completed in U6a-U6c.

## U7a atomic PTY fixture state

PTY fixture state is now published atomically with temp-file write plus rename. Root cause of the two intermittent matrix failures was a non-atomic state rewrite every 100 ms: the Python reader could catch a partial JSON file, treat it as `{}` and misread missing `undos`/`dispatched` fields as a mutation or double dispatch. Isolated Undo reproduction passed 5/5 before the fix, but the full matrix then exposed the same race in Approval. After the atomic-write fix the full PTY matrix passed every scenario at every size.

## U7b paired perf scaling measurement

Perf scaling measurement is now paired and median-based. The full CLI suite exposed a harness measurement flake: one unpaired cold-build phase could run under different CPU load and produce a false superlinear ratio even though isolated runs passed 5/5 at 1.57x-2.06x. The test now interleaves small/large cold builds across five pairs and compares the paired median; a real quadratic pass still approaches 4x. Evidence: CLI typecheck exit 0; focused perf budget 2/2, rows exactly 2.00x and paired median time 2.02x.

## U7 final verification and scoped completion verdict

The scoped TypeScript TUI upgrade track is complete. The formerly orphaned modules are integrated, Chat has a positional interactive minimap, clipboard copy has a bounded OSC52 terminal fallback, unread/context state remains covered by the existing sticky positional breadcrumb and panel chrome, and the two harness races found during final verification were fixed at their root causes rather than hidden.

Final evidence on this checkout: CLI typecheck exit 0; full CLI suite 901/901 passing; focused perf budget 2/2 with steady-state p95 4.44 ms at 200x48 and 3.38 ms at 80x24 against a 50 ms budget; transcript row scaling exactly 2.00x with paired median time 2.02x; full PTY matrix PASS for every scenario at 40x12, 80x24, 120x40, 160x45 and 200x48, including bracketed paste, mouse, terminal restore and exit paths; work graph 0/0/0; doc-truth 9/9; `git diff --check` exit 0. The only dirty worktree entry is the protected `nomo-web` submodule/dirty marker, which was not touched.

Deliberate residual non-goals: cell-level damage tracking and scroll-region optimization remain deferred because measured frame cost has a large margin; terminal-specific tmux/OSC52 passthrough negotiation and clipboard readback remain out of scope because terminals do not portably acknowledge clipboard acceptance; production Rust wiring and R16 reconnect/backpressure remain deferred by owner direction. These are documented non-goals, not hidden incomplete work.

Out-of-scope product blockers remain unchanged: H16 needs explicit operator opt-in and reviewed real runs; H17 depends on H16 and human-labelled validation; G1 needs trainable model/hardware; G3 needs explicit paid-benchmark authorization; G4 needs owner release/version/tag/deploy decisions. Real-service E2E, distribution/publication and physical device evidence are separate release-readiness lanes, not missing pieces of this TypeScript TUI track.

# NOMO cloud session handoff

> Canonical bootstrap for any session continuing NOMO work, especially Devin Cloud.
> Written 2026-11-25. The task graph `.nomo/work-state.json` is the work record;
> this file is the orientation. If they disagree, the graph wins.

## Read first, in this order

1. `AGENTS.md`, `AGENTS.local.md`, `.opencode/prompts/nomo-system.md`, `docs/agent-work-system.md`
2. `.nomo/work-state.json` - the task graph. A node is done only when its verifier output is quoted in its evidence.
3. `docs/plans/2026-11-25-nomo-24h-program-detailed.md` and `docs/plans/2026-11-25-nomo-master-workflow.md` - the active programs (TUI, harness, bandit/policy search, quality, product gates, measurement wiring)
4. `docs/superpowers/specs/2026-10-08-nomo-agent-identity-fleet-capability-map.md` - the product spec: run stop vs agent revoke vs fleet revoke, identity registry as revocation authority
5. `docs/memory/vault/start-here/NOMO Project Home.md` and `docs/memory/vault/governance/NOMO Memory Rules.md` - the project memory imported from the Obsidian vault

## Memory layout in this repo

- `.nomo/work-state.json` - task graph, one authorized writer per session
- `docs/memory/vault/` - snapshot of the Obsidian NOMO vault memory (start-here, governance, work-log). The vault itself is local-only; cloud sessions MUST write memory here or in the graph, never assume vault access
- `.ua/knowledge-graph.json` - understand-anything index of the codebase (5 598 nodes). Query it before grepping: nodes carry file paths, summaries, tags
- `.agents/skills/`, `.devin/skills/` - the full local skill set, copied for cloud parity
- `docs/CONTEXT.md`, `docs/DECISIONS.md`, `docs/STANDARDS.md` - authoritative repository contracts

## Verified state after the F2 audit (2026-11-26)

- Implementation heads before this handoff refresh: `tui-merge-main` `87044f9c`; `origin/main` `87044f9c`
- Graph: `.nomo/work-state.json` has 110 nodes, 110 done, including C1-C2, D1-D4, F1-F4, Q1-Q23, H1-H15, H18-H26, R1-R8 and T1-T18 as applicable
- Latest TUI gate: `pnpm run test:tui` → 549 tests, 549 pass, 0 fail; terminal verifier PASS every scenario at every size
- Latest typechecks from that gate: `pnpm --filter @nomo/cli typecheck` → exit 0; `pnpm --filter @nomo/workbench typecheck` → exit 0
- Latest Workbench wide evidence before the test-only TUI repairs: 1434 tests, 1431 pass, 0 fail, 3 skipped
- HP1 operator-scope promotions and HP2 automatic run-loop compaction are done. C2 retrieval hit accounting is production-reachable as one bounded content-free `harness.retrieval` record per provider turn
- Oracle eval proves plumbing only, not model capability; R2 is a contextual bandit, not RL
- Do not trust these numbers without re-running the gate you depend on.

## Product gates status (Track F)

- F1 later-session retrieval: DONE - opt-in `NOMO_SHARED_LEARNING_WORKSPACES` read-only union, digest names entry id + chain seqs, and retrieval hit accounting names carried entry ids without content
- F2 approval end-to-end: DONE - governed hold waits for confirmation, approval dispatches once, signed hold:approved evidence carries approvedBy, denial/restart/cancellation cannot release, and the TUI decision notice is pinned in the integration test
- F3 identity/fleet truth: DONE as the local-truth slice. TUI status shows the binding, `/revoke-agent` is confirmed and local, durable restart is tested including revocation without local session evidence; fleet-wide revoke remains honestly documented as unavailable until registry, node inventory, ack barrier and reconcile exist
- F4 provider release path: DONE - real provider smoke is verified through OpenRouter using locally configured credential material. Final output: `PASS provider-smoke: nvidia/nemotron-3.5-lightning:free answered in 1084 ms; reply 5 chars; usage prompt_tokens=23 completion_tokens=138 total_tokens=161.` No credential, prompt or response content is recorded

## Release decision after provider smoke (2026-11-26)

- Provider smoke is verified only for the OpenAI-compatible OpenRouter path named in F4. This is not a benchmark and not proof of OpenCode Zen availability.
- No release, tag, deploy, npm publication or hosted job was performed. G4 still needs an explicit owner decision on version target, changelog, tag and deploy path immediately before release.


## R0 terminal protocol boundary (2026-11-26)

- `packages/workbench/src/tui-protocol.ts` now defines the first versioned boundary for a future Rust or other terminal frontend: server-owned snapshots, paged transcript content, usage/provider/approval/palette state, validated operator intents and versioned server-event envelopes.
- Active panel and terminal capabilities are client-owned render context, not workbench state. Static session metadata deliberately excludes transcript text and event payloads.
- This is a contract only: no Rust implementation, production wiring, release, benchmark or migration has started. The byte-parity and strangler adoption gates are documented in `docs/plans/2026-11-26-tui-protocol-boundary.md`.
- Verified after the slice: focused protocol tests 8/8, `@nomo/workbench` typecheck exit 0, `@nomo/cli` typecheck exit 0.


## T20 transcript position indicator (2026-11-26)

- The sticky transcript breadcrumb now carries the exact visible row range and the number of transcript rows below the viewport while scrolled, without spending another frame row.
- This is a position indicator, not a minimap or virtual scrollback rewrite. The composer, review keys and exact frame shape are unchanged.
- Verified: focused TUI workspace suite 128/128, accessibility plus visual snapshots 16/16, `@nomo/cli` typecheck exit 0.


## T21 command palette aliases (2026-11-26)

- Palette fuzzy search now accepts a small audited set of operator aliases while rows still show only canonical slash commands. Preview data exposes aliases beside the command summary and usage shape.
- Verified: palette visual tests 4/4, palette-focused workspace tests pass, `@nomo/cli` typecheck exit 0.


## R1 bounded Rust Help spike (2026-11-26)

- `scripts/tui-rs-spike` is an isolated experiment using `ratatui` and `crossterm`; it is not wired into production launch paths.
- Verified byte-for-byte against committed canonical monochrome Help hashes at 40x12, 52x16, 80x24, 120x40, 160x45 and 200x48 for ascii, unicode and nerd arguments. The presets are identical because this Help surface uses shared glyphs.
- Honest limit: fixture content is hardcoded and there is no protocol client, input loop, scrollback, mouse, bracketed paste, approval flow or real PTY evidence. Rust is not adopted beyond this spike.
- Verified: `cargo test --offline --quiet` 1/1 and `node --test scripts/src/tui-rs-parity.test.mjs` 1/1.


## R1b Rust spike interactive PTY smoke (2026-11-26)

- The isolated Rust spike now also has an interactive `ratatui`/`crossterm` mode with raw mode, alternate screen, resize redraw and `q`/Esc exit. This is still not production wiring.
- Real PTY smoke passes at 40x12, 80x24 and 120x40: frame renders, terminal width does not overflow, alternate screen enters and restores, and `q` exits cleanly.
- Static byte parity remains green after the interactive-mode change.
- Honest limit: still no typed protocol client, transcript interaction, scrollback, mouse, bracketed paste, approval flow or adoption decision.


## R1c Rust snapshot-shaped input seam (2026-11-26)

- The isolated spike can read a versioned JSON snapshot shaped after the R0 contract. Serde validates the wire shape and version; the Help footer uses the snapshot session model and usage or session run-token count.
- Canonical fixture input preserves exact byte parity at all six sizes and for ascii, unicode and nerd arguments. Interactive PTY smoke now passes the fixture through the real terminal path as well.
- Rust unit evidence also proves changed snapshot values change the footer and an unknown protocol version is rejected.
- Honest limit: this is not a protocol client. There is no shared TypeScript/Rust schema validator, transport, transcript channel, intents, server events or production wiring.
- Verified: cargo test 3/3, `node --test scripts/src/tui-rs-parity.test.mjs` 1/1, `python3 scripts/src/verify-rust-spike-pty.py` matrix PASS.


## R0b read-only workbench snapshot adapter (2026-11-26)

- `tuiSnapshotFromWorkbench` adapts `allViews` and `approvals` into the protocol snapshot. Explicit session selection is required for a transcript; unknown sessions fail closed.
- The adapter normalizes approvals through the existing boundary, does not probe providers and keeps active view plus terminal capabilities outside server-owned state.
- Verified: protocol tests 10/10 and `@nomo/workbench` typecheck exit 0.
- Honest limit: in-process adaptation only; no transport server, event stream or production Rust wiring.


## R0c versioned NDJSON wire codec (2026-11-26)

- TypeScript now serializes and parses the versioned protocol envelope. Parsing validates the envelope and server-event wire shape; malformed JSON, wrong versions, unknown event types and invalid transcript event shape fail closed.
- The isolated Rust spike accepts either a bare snapshot or the same versioned snapshot envelope.
- Cross-language proof: TypeScript serialized the envelope, the TypeScript parser validated it, Rust consumed the file and reproduced the canonical 80x24 Help hash exactly.
- Verified: protocol tests 12/12, Rust cargo tests 5/5, Rust parity test 1/1.
- Honest limit: codec only; no streaming transport, intent channel, transcript subscription or production wiring.


## R2 bounded TCP transport proof (2026-11-26)

- `scripts/src/tui-protocol-fixture-server.mjs` serves validated versioned snapshot envelopes over loopback TCP using fixture data only.
- The isolated Rust interactive spike can connect to that server, consume NDJSON snapshots on a reader thread and redraw the footer when the model and run-token count change.
- Real PTY proof passes at 80x24: `fixture-model` appears first, then `transport-model` and `tokens 777`, width stays bounded, and `q` exits with terminal restore.
- Existing evidence remains green: protocol 12/12, cargo 5/5, parity 1/1, original PTY matrix PASS.
- Honest limit: fixture-only transport; no real Workbench event source, intents, transcript subscription, authentication, reconnect/backpressure policy or production wiring.


## R0d client intent envelope codec (2026-11-26)

- TypeScript now serializes and parses versioned client intent envelopes. Intent shape and idempotency remain owned by the existing `parseTuiIntent` validator.
- The isolated Rust spike can emit a versioned `view.select` intent for a validated protocol view. Cross-language proof parses the Rust output with the TypeScript codec and recovers the exact intent.
- Verified: protocol tests 14/14, cargo tests 6/6, parity test 1/1, TCP transport proof PASS.
- Honest limit: codec only; no server executes intents, no intent acknowledgement semantics are final and no production wiring exists.


## R2a adapter-backed fixture transport (2026-11-26)

- The TCP fixture server now generates snapshots by passing an in-memory `SessionView` projection through `tuiSnapshotFromWorkbench` rather than reading a hand-written JSON snapshot as truth.
- Real PTY transport proof remains green: `fixture-model` changes to `transport-model` and `tokens 777` over loopback TCP.
- Full TUI regression after the protocol and Rust slices: `pnpm run test:tui` exit 0, 550/550 Node tests pass, every PTY scenario at every size passes.
- Honest limit: still synthetic fixture state; no live Workbench event subscription, intent execution or production wiring.


## R2b real Workbench-backed bounded transport (2026-11-26)

- The fixture TCP server now creates a real isolated `Workbench`, registers two contract-shaped fixture host runners and starts two real host-only sessions through the normal consent path.
- Served snapshots are produced by `tuiSnapshotFromWorkbench(app, ...)`, so Rust consumes real Workbench projections rather than hand-built session objects.
- Real PTY proof passes at 80x24: footer changes from `host-fixture-a/host` to `host-fixture-b/host` and truthfully renders `tokens 0`.
- Verified: protocol 14/14, cargo 6/6, Rust parity 1/1, original PTY matrix PASS, real-Workbench transport proof PASS.
- Honest limit: host runners are local contract doubles; snapshots are selected after settlement rather than live event subscription; no intent execution, authentication, reconnect/backpressure policy or production wiring.


## R2c live Workbench status stream surface (2026-11-26)

- Rust now parses optional transcript pages and carries session status, page event count and latest sequence. Connected interactive mode renders those facts; the non-connected Help frame preserves exact canonical byte parity.
- The bounded server starts one real host-only Workbench run with delayed fixture events, polls the real projection every 100 ms and emits only changed validated snapshots.
- Real PTY proof passes: `host-fixture-live/host` appears, `status running` becomes `status idle`, truthful page count renders, rows stay bounded and terminal restore succeeds.
- Verified: protocol 14/14, cargo 6/6, parity 1/1, original PTY matrix PASS, live transport proof PASS.
- Honest limit: polling rather than subscription/invalidation; full snapshots only; transcript text not rendered; no intent execution, authentication, reconnect/backpressure policy or production wiring.


## R3 bounded bidirectional run.stop proof (2026-11-26)

- Rust connected mode now carries the active session id and sends a versioned `run.stop` client envelope when `s` is pressed. Protocol bytes share the TCP connection while terminal input remains local.
- The server buffers partial NDJSON lines, validates them with `parseTuiClientMessage`, executes only `run.stop` through the real Workbench and sends validated `intent.rejected` for unsupported or failing intents.
- Real PTY proof passes: `status running` appears, pressing `s` changes the live footer to `status cancelled`, token count stays truthful, width bounds and terminal restore hold.
- Verified: protocol 14/14, cargo 7/7, parity 1/1, original PTY matrix PASS, bidirectional transport proof PASS.
- Honest limit: exactly one control intent; no prompt submission, approvals, palette execution, generic acknowledgement semantics, authentication, reconnect/backpressure policy or production wiring.


## R4 bounded transcript text surface (2026-11-26)

- Rust connected mode now extracts the latest assistant transcript text from protocol pages and renders it live. Non-connected Help output preserves canonical byte parity.
- The real Workbench fixture emits `live transcript visible` before waiting; the PTY proof sees that text while running, then pressing `s` cancels the run through the validated `run.stop` intent.
- Verified: cargo 8/8, Rust parity 1/1, transport proof PASS, protocol 14/14, original PTY matrix PASS.
- Honest limit: narrow proof surface only; no scrolling chat, role separation, markdown rendering, paging, composer or production wiring.


## R5 bounded transcript rows (2026-11-26)

- Connected Rust mode now carries and renders the newest eight non-empty transcript rows in ascending order as bounded `kind text` rows.
- The rows use the same cell-width wrapping/padding pipeline and remain inside exact terminal bounds; non-connected canonical Help parity stays unchanged.
- Verified: cargo 8/8, transport proof PASS, Rust parity 1/1, original PTY matrix PASS, protocol 14/14.
- Honest limit: proof surface only; no scrolling, role styling, markdown, pagination controls, composer or production wiring.


## R6 connected transcript viewport (2026-11-26)

- Connected Rust mode is now a live Chat proof surface: protocol transcript rows replace static Help content, are wrapped through the same cell-width pipeline and start pinned to the bottom.
- The client keeps the newest 100 non-empty transcript events and supports `Up/Down`, `k/j`, `PageUp/PageDown`, `Home/End` and `g/G`; footer shows compact scroll state and correct live keys.
- The fixture run emits 30 assistant rows. Real PTY proof scrolls to `tool Host run started` / `live transcript 00`, returns to bottom, then cancels through `run.stop`.
- Verified: cargo 9/9, transport proof PASS, Rust parity 1/1, original PTY matrix PASS, protocol 14/14. Canonical non-connected Help parity is unchanged.
- Honest limit: transcript viewport proof only; no markdown, role styling, focus model, composer, horizontal virtualization or production wiring.


## R7 incremental transcript and session streaming (2026-11-26)

- Server sends one initial full snapshot, then granular validated `transcript.appended` and `session.updated` events while the selected session remains append-only. Session change or sequence regression falls back to a full snapshot.
- Rust now stores sequence-bearing transcript rows, deduplicates/applies incremental events, caps retained rows at 100 and updates session facts without replacing the whole projection.
- Real PTY proof passes after scroll top/bottom and `run.stop`; because later full snapshots are not sent in the normal path, the visible incrementally arriving rows prove the granular wire path.
- Verified: cargo 10/10, transport proof PASS, Rust parity 1/1, original PTY matrix PASS, protocol 14/14.
- Honest limit: still polling-based; no Workbench invalidation subscription, usage/provider/approval increments, composer, authentication, reconnect/backpressure policy or production wiring.


## R8 event-driven Workbench invalidation (2026-11-26)

- Workbench now has additive `subscribe(listener)`: notifications are coalesced into a later microtask, never fired inside a partial mutation, and listener failures are contained.
- Persistence and session transcript events invalidate subscribers. The fixture server no longer polls; subscription invalidation drives projection diffing and granular `transcript.appended` / `session.updated` transport events.
- Real PTY proof passes with polling removed: transcript rows arrive, `g/G` scrolling works, `s` cancels and terminal restore holds.
- Verified: Workbench typecheck PASS, subscription test 1/1, host-run tests 2/2, protocol 14/14, cargo 10/10, Rust parity 1/1, original PTY matrix PASS, transport proof PASS.
- Honest limit: invalidation is coalesced rather than typed end-to-end; usage/provider/approval incremental handling, composer, authentication, reconnect/backpressure policy and production wiring remain absent.


## R9 bounded composer and session.create proof (2026-11-26)

- Rust connected mode now supports `i` prompt input with bounded editing, Escape cancel and Enter submit. Submission serializes validated `session.create` with a fresh idempotency key; `q` remains text while composing.
- The fixture server deduplicates creation by idempotency key, starts a real host-only Workbench run using the prompt as its task, switches the projected active session and emits validated `intent.accepted` after the run exists.
- Real PTY proof passes the full chain: scroll/cancel initial run, type `hello rust composer`, submit it and observe `assistant live transcript visible: hello rust composer`.
- Verified: protocol 14/14, cargo 11/11, Rust parity 1/1, original PTY matrix PASS, transport proof PASS.
- Honest limit: fixture executor proves protocol/idempotency/projection switching, not provider-backed session creation; no cursor movement, paste, multiline input, validation display, model selection or concurrent-create ordering.


## R10 bounded session selection and projection switching (2026-11-26)

- Protocol now validates `session.select` as projection control, without an idempotency key because it is not a domain mutation.
- Rust keeps the snapshot session list, cycles it with `[`/`]`, sends versioned selection envelopes and resets scroll when projection changes.
- Fixture server validates the selected id, switches active projection and publishes immediately; creation publish is deterministic too.
- Real PTY proof creates a second session, moves to the initial cancelled run with `[` and back to the created run with `]`, observing distinct final transcript rows across wrapping.
- Verified: protocol 14/14, Workbench typecheck PASS, cargo 12/12, Rust parity 1/1, original PTY matrix PASS, transport proof PASS.
- Honest limit: no session manager, fuzzy search, titles, ordering control, multi-client ownership, unread markers, transcript paging or production semantics.


## R11 composer editing, bracketed paste and control-safe rendering (2026-11-26)

- Rust composer is cursor-aware: Left/Right/Home/End, Backspace/Delete, Ctrl+U clear, Unicode-boundary-safe insertion and shared bounded typing/paste path. Display uses `▏` as insertion marker.
- Interactive mode enables bracketed paste and disables it before terminal restore. `Event::Paste` inserts payloads instead of interpreting them as keystrokes.
- Control-safe rendering maps newline/carriage return to `⏎` and other controls to spaces, preventing exact-row corruption. Real PTY proof pastes `hello\nrust composer`, submits it and observes the sanitized row in the live Workbench transcript.
- Verified: protocol 14/14, cargo 13/13, Rust parity 1/1, original PTY matrix PASS, transport proof PASS.
- Honest limit: no terminal cursor positioning, selection, undo, clipboard integration, word movement, multiline editor viewport or soft-wrapped editing. Alt+Enter is terminal-dependent; bracketed paste is the proven multiline path.


## R12 semantic transcript label styling (2026-11-26)

- Connected Rust mode now styles first transcript role tokens semantically: assistant/user/tool/error/usage get distinct foreground colors when enabled and bold/dim emphasis otherwise. No background is painted; continuation text and user-authored content stay unstyled.
- Static canonical rendering remains plain and byte-stable; styling exists only in connected interactive mode.
- TestBackend proof verifies exact text preservation and expected role-label style. Real PTY transport, original PTY matrix, cargo, protocol and parity gates pass.
- Verified: protocol 14/14, cargo 14/14, Rust parity 1/1, original PTY matrix PASS, transport proof PASS.
- Honest limit: no theme palette/configuration, markdown highlighting, style-aware wrapping, contrast audit or theme persistence.


## R13 transcript scrollbar and viewport position (2026-11-26)

- Connected Rust transcript view now renders a bounded right-edge scrollbar only when content overflows: `│` track and `█` proportional thumb. Bottom-pinned scroll puts the thumb at the bottom; maximum scroll puts it at the top.
- The marker uses existing trailing padding, so transcript width and exact terminal geometry are unchanged. Canonical non-connected Help parity remains unchanged.
- Unit assertions cover thumb position and exact width; real PTY transport asserts the thumb in the live scrolling transcript.
- Verified: cargo 14/14, transport proof PASS, Rust parity 1/1, original PTY matrix PASS, protocol 14/14.
- Honest limit: positional scrollbar only; no minimap content, mouse hit target, drag behavior or unread marker.


## R14 anchored scrollback under live append (2026-11-26)

- Rust connected viewport now keeps a nonzero scroll position anchored when new wrapped rows arrive; scroll `0` still follows the bottom. Session changes reset to bottom because they replace the transcript.
- Fixture host emits bounded heartbeat rows while waiting. Real PTY proof scrolls to the oldest row, waits through live appends and verifies the oldest row remains visible before returning to bottom.
- Verified: cargo 15/15, transport proof PASS, Rust parity 1/1, original PTY matrix PASS, protocol 14/14.
- Honest limit: row anchoring only; no unread/new-message pill, per-event anchoring across width/wrapping changes, mouse interaction or production chat behavior.

## R15 live application chrome (2026-11-26)

Live application chrome now shows status and session position in the connected Rust header, with compact key hints. Canonical Help parity is unchanged. Evidence: cargo 15/15; transport PASS; parity 1/1; PTY matrix PASS; protocol 14/14. Limit: proof chrome only, no production wiring.

## R16 mouse wheel scrollback (2026-11-26)

The connected Rust proof now enables mouse capture, maps wheel up/down to three-line scrollback movement, and disables capture before terminal restore. Real PTY proof uses SGR wheel sequences to reach the oldest transcript rows and return to bottom. Evidence: cargo 15/15; transport PASS including mouse wheel; PTY matrix PASS; parity 1/1. Limit: wheel scrolling only, no click/drag/selection/production wiring.

## U1 TypeScript TUI completion audit (2026-11-26)

TypeScript TUI completion audit recorded. Original T1-T18 plus transcript-position and palette-alias work is already done; remaining work is integration/retirement of orphaned minimap/chat-markdown/run-activity modules, selective terminal-native gaps, unread/application-chrome polish and final audit. Rust is deferred by owner decision.

## U2 shared inline Markdown wiring (2026-11-26)

`chat-markdown.ts` is no longer orphaned: it now owns the safe strong/code inline-Markdown span splitter and `workspace.ts` consumes it. The obsolete unused whole-line helper was removed in-place; user-authored text and rendered frames are unchanged. Evidence: CLI typecheck exit 0; focused workspace/a11y/visual snapshot tests 144/144. No visual snapshot accepted.

## U3a minimap primitives (2026-11-26)

The orphaned minimap module is now a tested primitive: exact-height one-cell rendering, row-to-event mapping, approval precedence, sequence gaps, unicode and complete ASCII glyphs. Evidence: CLI typecheck exit 0; focused minimap tests 4/4. It is not yet wired into Chat.

## U3b Chat minimap wiring (2026-11-26)

Chat now wires the tested minimap as a one-cell positional edge from 72 columns when a real conversation exists. The transcript is wrapped one cell narrower, mouse selection treats the edge as chrome, ASCII uses ASCII glyphs, and 40-column frames are unchanged. Intended visual change reviewed at 80x24 before accepting snapshots. Evidence: CLI typecheck exit 0; focused workspace/parity/a11y/visual/minimap tests 251/251; 120 visual snapshot hashes accepted intentionally.

## U4 shared run activity helpers (2026-11-26)

`run-activity.ts` is no longer an orphaned duplicate formatter: it now owns shared tool-payload record guarding, secret redaction, private-reasoning key filtering and output extraction used by `workspace.ts`. The canonical redaction preserves private-key-block and credential/token handling. Evidence: CLI typecheck exit 0; run-activity tests 2/2; focused workspace/parity/a11y/visual tests 247/247; frames unchanged.

## Full PTY matrix checkpoint (2026-11-26)

Full TypeScript TUI PTY matrix after the minimap and run-activity consolidation: PASS for every scenario at 40x12, 80x24, 120x40, 160x45 and 200x48, including terminal restore, bracketed paste, mouse and exit paths.

## U5a OSC52 clipboard primitive (2026-11-26)

OSC52 clipboard primitive added and tested: exact UTF-8 round trip through base64, safe payload alphabet, explicit empty/oversize refusal. It is not yet wired into the runner fallback. Evidence: CLI typecheck exit 0; clipboard tests 2/2.

## U5b OSC52 clipboard fallback (2026-11-26)

Prompt and mouse-selection copy now use the OS clipboard first and fall back to a bounded user-initiated OSC52 terminal sequence only after system clipboard failure. The UI says “sent to terminal clipboard” for OSC52 because the terminal does not acknowledge acceptance. Oversize copies fail closed. `writeGraphics` now treats Node backpressure as queued output rather than failure. Evidence: CLI typecheck exit 0; clipboard/runner/terminal unit tests 7/7; focused workspace/parity/a11y/visual/terminal tests 258/258; full PTY matrix PASS at every scenario and size.

## U6a minimap navigation geometry (2026-11-26)

Minimap mouse-navigation geometry is now published and tested: exact outermost column/body band, proportional inverse mapping, endpoint clamping and drag clamping. No mouse behavior or frame output changed yet. Evidence: CLI typecheck exit 0; minimap mouse tests 3/3; focused workspace/parity/visual tests 233/233.

## U6b interactive minimap navigation (2026-11-26)

Chat minimap is now interactive: a plain left click or drag on the one-cell edge proportionally jumps/centres the transcript, clamps drags inside the band and restores live-follow at the bottom. Text selection still treats the edge as chrome. Evidence: CLI typecheck exit 0; minimap mouse/terminal lifecycle tests 7/7; focused workspace/parity/terminal/visual tests 244/244; no visual snapshot change.

## Rules that are not negotiable

- No push, merge, deploy, hosted CI, dependency install, or provider-costing call unless the user explicitly asks in the current task. (This push was explicitly authorized by the user on 2026-11-25.)
- Never print, copy, or persist a secret. Provider credentials live in the user's local OpenCode config; cloud sessions must not invent or embed them.
- Do not weaken tests, delete assertions, or add suppressions to reach green.
- One writer per file; preserve unrelated dirty changes; nomo-web is a protected submodule.
- Do not re-introduce the autonomous loop (launchd autoloop) - it was deliberately removed on 2026-11-25.
- Do not replace the hand-rendered TUI with a component-library skeleton. The documented decision (docs/DECISIONS.md) is not-adopted unless byte-for-byte parity is proven first.
- Verify with the narrowest meaningful command first, then typecheck, then the wider suite. Quote observed output in the graph before marking a node done.

## Honest limits a cloud session must know

- The harness is NOT RL. It is measurement, frozen evaluation and (planned) contextual bandit/policy search. Gradient RL requires a trainable local model + GPU and does not exist.
- Fleet-wide revocation does not exist; only local single-process agent revoke. `docs/CONTEXT.md` names the registry, node inventory, acknowledgement, fail-closed disconnected-node and reconciliation requirements.
- GUI plans exist but are undecided (v1 vs post-v1) - do not build GUI work without a user decision.
- The vault memory in docs/memory/ is a snapshot from 2026-11-25; it does not update itself.

# TUI protocol boundary and Rust migration gate

## Decision

NOMO does not start with a full Rust rewrite. It first gains a versioned terminal boundary in the existing TypeScript workbench package. The boundary separates three kinds of data:

1. static session metadata, which never contains transcript text or event payloads, while active panel and terminal capabilities remain client-owned render context;
2. paged transcript content, which uses the existing redacted `SessionEvent` channel;
3. validated operator intent, which is the only way a frontend asks the workbench to mutate state.

The first contract lives in `packages/workbench/src/tui-protocol.ts`. It is not production wiring yet. It is the narrow schema a Rust terminal client can implement against without sharing the TypeScript object graph.

## Strangler path

1. **R0 contract, this slice:** typed state snapshot, paged transcript, usage and provider status, approvals, palette metadata, terminal capability metadata and validated operator intents. Server messages are versioned envelopes for snapshots, transcript additions, session or approval changes, provider changes, intent results and diagnostics.
2. **R1 parity spike:** one simple screen in Rust with `ratatui` and `crossterm`, compared byte-for-byte against the existing renderer at 40x12, 80x24, 120x40, 160x45 and 200x48. No production launcher wiring.
3. **R2 hybrid frontend:** Rust owns terminal input and paint while the TypeScript workbench remains the orchestrator, ledger writer, policy boundary and provider adapter host.
4. **R3 selective core port:** only after parity and production-shaped evidence. Read-only ledger verification is first. Orchestration and provider adapters move last, if ever.

## Adoption gate

A Rust frontend may replace the existing frontend only when all of these are true:

- exact row count and exact column width at every matrix size;
- byte-for-byte matching snapshots for the selected fixture set;
- ASCII, unicode and nerd symbol presets match;
- monochrome and `NO_COLOR` behavior match;
- reduced motion is byte-stable;
- no terminal default background is painted;
- bracketed paste, mouse behavior, focus behavior and scrollback behavior are proven in a real PTY matrix;
- no prompt, credential, document content or unredacted tool output crosses static metadata.

If any gate fails, the spike remains an experiment and the hand-written TypeScript renderer stays canonical.

## Security boundary

The protocol does not make prompt content safe by omission. Prompt content exists only in the explicit transcript or prompt-submit channel. Static snapshots carry identity, state, counters and status. Approval decisions require an explicit decision and operator identity. Prompt submission and session creation require client-generated idempotency keys so a terminal retry cannot silently become two user intents.


## R1 spike result, 2026-11-26

A bounded spike now exists at `scripts/tui-rs-spike`. It uses `ratatui` and `crossterm`, renders the canonical monochrome Help fixture, and matches the committed TypeScript frame hash byte-for-byte at 40x12, 52x16, 80x24, 120x40, 160x45 and 200x48 for the ascii, unicode and nerd arguments. The three presets are byte identical because the canonical Help surface uses shared glyphs in all three.

This is not adoption evidence. The spike still has hardcoded fixture content, no typed protocol client, no input loop, no scrollback, no mouse or bracketed-paste behavior, no approval flow and no real PTY matrix. It proves only that a narrow static Help surface can be reproduced exactly with the current layout rules.


## R1c snapshot-shaped input seam, 2026-11-26

The isolated Rust spike now accepts a versioned JSON snapshot shaped after the R0 protocol contract. It validates the version and required wire fields with Serde, reads the session model and usage or session run-token count, and drives the Help footer from that input rather than from compile-time-only facts. The canonical fixture still reproduces every committed Help hash exactly.

This remains a narrow seam, not a protocol client. There is no snapshot runtime validator shared with TypeScript, no websocket or IPC transport, no transcript channel, no intent submission, no server events and no production wiring.


## R0b read-only workbench adapter, 2026-11-26

`tuiSnapshotFromWorkbench` now adapts the read-only `allViews` and `approvals` projections into the wire snapshot. It requires the active session id explicitly, fails closed for an unknown session, normalizes approvals through the existing boundary and never probes providers or copies active view or terminal capabilities into server state.

This is still in-process adaptation only. There is no transport server, no event stream and no production Rust wiring.


## R0c versioned NDJSON wire codec, 2026-11-26

The TypeScript boundary now has a versioned protocol envelope codec: `serializeTuiProtocolMessage` writes exactly one JSON object without owning transport newlines, and `parseTuiProtocolMessage` validates the envelope plus server-event wire shape before returning it. Required malformed versions, unknown event types and malformed transcript event shape fail closed.

The isolated Rust spike accepts either the original bare snapshot fixture or the same versioned snapshot envelope. The cross-language proof serializes an envelope in TypeScript, validates it with the TypeScript parser, passes that file to Rust and reproduces the canonical 80x24 Help hash exactly.

This is a codec only. There is still no streaming transport, intent channel, transcript subscription or production wiring.


## R2 bounded TCP transport proof, 2026-11-26

A fixture-only transport prototype now connects the isolated Rust spike to a Node TCP server. The server serializes versioned snapshot envelopes through the TypeScript codec, validates each line before writing it, sends an initial snapshot and then a changed snapshot, and the Rust interactive mode updates the visible footer in a real PTY. The proof uses only loopback TCP and fixture data.

This is not a production transport. There is no real Workbench event source, intent channel, transcript subscription, authentication, reconnect policy, backpressure policy or production wiring.


## R0d client intent envelope codec, 2026-11-26

The client direction now has the same versioned NDJSON envelope discipline as the server direction. `serializeTuiClientMessage` emits exactly one JSON object and `parseTuiClientMessage` validates the envelope before delegating intent shape and idempotency rules to the existing `parseTuiIntent` authority.

The isolated Rust spike can emit a versioned `view.select` intent for a validated protocol view. The cross-language proof runs the Rust binary, parses its output with the TypeScript client codec and recovers the exact intent. This is codec evidence only; no server executes the intent yet.


## R2a adapter-backed fixture transport, 2026-11-26

The fixture TCP server no longer treats a hand-written JSON file as the source of truth. It constructs an in-memory `SessionView` fixture and passes the read-only projection through `tuiSnapshotFromWorkbench` before serializing and validating each snapshot envelope. The Rust transport proof still observes `fixture-model` followed by `transport-model` and `tokens 777` in a real PTY.

This remains fixture-backed transport, not a real Workbench server. The projection is synthetic, there is no live event subscription, no intent execution and no production wiring.


## R2b real Workbench-backed bounded transport, 2026-11-26

The transport fixture now instantiates a real `Workbench` in isolated temporary storage, registers two contract-shaped fixture host runners and starts two real host-only sessions through the normal consent path. Snapshots served over loopback TCP are produced by `tuiSnapshotFromWorkbench(app, ...)`, so the Rust client consumes real Workbench projections rather than a hand-built `SessionView` object.

The Rust real-PTY proof sees the first host session footer (`host-fixture-a/host`) and then the second (`host-fixture-b/host`) with the truthful zero token count. Protocol, Rust unit, parity and original PTY checks remain green.

This is still not production transport. The host runners are local contract doubles, the snapshots are selected after the runs have settled rather than pushed from a live event subscription, there is no intent execution, authentication, reconnect or backpressure policy, and no production wiring.


## R2c live Workbench status stream surface, 2026-11-26

The isolated Rust spike now parses the optional transcript page and carries session status, page event count and latest sequence in addition to model and token facts. These extra facts are shown only in connected interactive mode; the non-connected Help frame still uses the canonical footer and preserves byte parity.

The bounded server now starts one real host-only Workbench run whose fixture runner emits delayed events, polls the real projection at 100 ms, and writes a new validated snapshot only when the wire payload changes. The real PTY proof observes `status running` become `status idle` with a truthful transcript page count while exact terminal bounds hold.

This is live polling, not a Workbench subscription or event-driven invalidation. Full snapshots are still sent, transcript text is not rendered, there is no intent execution, authentication, reconnect/backpressure policy or production wiring.


## R3 bounded bidirectional run.stop proof, 2026-11-26

The loopback transport is now bidirectional for one deliberately narrow control intent. The Rust interactive client carries the active session id from the snapshot, serializes a versioned `run.stop` client envelope when the operator presses `s`, writes it as NDJSON on the same TCP connection and keeps terminal input separate from protocol input.

The fixture server buffers partial client lines, validates them with `parseTuiClientMessage`, executes only `run.stop` through the real Workbench and rejects every other intent with a validated `intent.rejected` event. The cancellable fixture host runner observes the abort signal and terminates cancelled; the polling snapshot stream carries the truthful status back to Rust. No generic acknowledgement semantic is claimed for control intents: state transition or explicit rejection is the evidence.


## R4 bounded transcript text surface, 2026-11-26

The isolated Rust client now carries the latest assistant transcript text from the protocol page and renders it only in connected interactive mode. The non-connected Help frame remains the canonical byte-parity surface. The fixture host runner emits an early bounded assistant message before it waits, so the real PTY proof sees `live transcript visible` while the run is active and then verifies `run.stop` cancellation.

This is a narrow proof surface, not a chat view: no scrolling transcript, role separation, markdown rendering, paging, prompt composer or production wiring exists.


## R5 bounded transcript rows, 2026-11-26

The connected Rust surface now carries the newest eight non-empty transcript rows in ascending order and renders each as a bounded `kind text` row before the static Help reference content. Rows are wrapped through the same cell-width pipeline and remain inside the exact terminal frame. Canonical non-connected Help parity is unchanged.

This is still a proof surface rather than a chat view: no scrolling, role styling, markdown, pagination controls, composer or production wiring exists.


## R6 connected transcript viewport, 2026-11-26

Connected interactive mode is now a separate live Chat proof surface rather than Help content with transcript rows prepended. It renders only protocol transcript rows in the body, keeps the newest 100 non-empty events bounded by the protocol page, wraps through the same cell-width pipeline and starts pinned to the bottom. `Up/Down`, `k/j`, `PageUp/PageDown`, `Home/End` and `g/G` scroll the wrapped viewport; the footer carries a compact `sc` offset and live key help no longer claims Escape returns to Chat.

The fixture host runner emits thirty small assistant rows before the visible final row. The real PTY proof scrolls to the oldest row with `g`, returns to the bottom with `G`, and then proves `run.stop` cancellation. Canonical non-connected Help parity remains unchanged.

This is a transcript viewport proof, not the product chat composer: no markdown, role styling, horizontal virtualization, keyboard focus model, prompt input or production wiring exists.


## R7 incremental transcript and session streaming, 2026-11-26

The bounded server now sends exactly one full snapshot when a client connects. While the selected session remains append-only, subsequent wire traffic is granular: each new transcript row is emitted as a validated `transcript.appended` event and each changed session summary as a validated `session.updated` event. A session change or sequence regression falls back to a fresh full snapshot rather than silently patching mismatched state.

The Rust client now keeps sequence-bearing transcript rows, applies transcript and session updates incrementally, deduplicates by sequence, caps the retained page at 100 rows and preserves canonical non-connected Help parity. The real PTY proof still scrolls through incrementally supplied rows and cancels through `run.stop`, so the granular wire path is required for the observed transcript.

The transport is still polling-based. There is no Workbench invalidation subscription, usage/provider/approval incremental event, composer, authentication, reconnect/backpressure policy or production wiring.


## R8 event-driven Workbench invalidation, 2026-11-26

Workbench now exposes a narrow additive `subscribe(listener)` invalidation API. Notifications are coalesced into a later microtask, so observers never run inside a partially applied mutation; listener failures are contained. State persistence and session transcript events both invalidate subscribers. This is an invalidation signal, not a mutable event stream and not a promise that every future domain object will have its own event type.

The bounded transport server no longer polls at 100 ms. Each connection still receives one initial full snapshot, then a subscription causes the projection diff to emit granular `transcript.appended` and `session.updated` events when Workbench state changes. The real PTY proof passes with polling removed, including scrollback and `run.stop` cancellation.

Remaining limits are explicit: invalidation is coalesced rather than typed end-to-end, usage/provider/approval changes do not yet have dedicated incremental transport handling, and there is still no composer, authentication, reconnect/backpressure policy or production wiring.


## R9 bounded composer and session.create proof, 2026-11-26

The connected Rust proof surface now has a deliberately narrow composer. `i` enters prompt input, printable ASCII/Unicode characters and Backspace edit a bounded 500-byte buffer, Escape cancels the composer, and Enter serializes one validated `session.create` client envelope with a fresh protocol-shaped idempotency key. While composing, `q` is input rather than quit; outside the composer `q` and Escape retain their existing meanings.

The fixture server executes only this explicit creation intent by starting another real host-only Workbench run whose task is the supplied prompt. Creations are deduplicated by idempotency key, the active projected session switches to the created run and the server emits a validated `intent.accepted` after the run exists. The Rust client ignores the acknowledgement visually; the real PTY proof instead observes the created prompt in the live transcript. This exercises the envelope, idempotency boundary, server validation and projection switching, not provider-backed session creation.

This is not production chat input: no cursor movement, paste handling, editing keys, multiline input, validation display, model selection or provider semantics exist. Concurrent creation ordering is deliberately outside the single-client fixture proof.


## R10 bounded session selection and projection switching, 2026-11-26

The protocol now validates a narrow `session.select` client intent. It is projection control, like the existing view intent, not a domain mutation and therefore carries no idempotency key. The Rust client keeps the snapshot session list, cycles it with `[` and `]`, sends the selected session id as a versioned envelope and resets scroll to the bottom when a snapshot changes the projected session.

The fixture server validates the id against the current snapshot session list, switches only its active projection and publishes immediately because projection selection is server-local rather than a Workbench mutation. Session creation also publishes deterministically after creation. The real PTY proof creates a second session, moves back to the initial cancelled host run with `[`, returns to the created run with `]`, and observes each transcript's distinct final row across terminal wrapping.

This is bounded selection, not a session manager: no fuzzy search, titles, ordering control, multi-client ownership, unread markers, transcript paging across the wire or production semantics exist.


## R11 composer editing, bracketed paste and control-safe rendering, 2026-11-26

The Rust composer is now cursor-aware rather than append-only. Left/Right/Home/End move by Unicode scalar boundaries, Backspace/Delete edit at the cursor, Ctrl+U clears the buffer, Alt+Enter inserts a newline where the terminal reports it, and a bounded 500-byte insert path is shared by typing and paste. The composer display uses an explicit `▏` insertion marker; `q` remains text while composing.

Interactive mode enables bracketed paste and disables it before restoring the terminal. `Event::Paste` inserts the pasted payload at the cursor instead of interpreting it as keystrokes. Control characters can no longer corrupt exact row geometry: rendering maps newline/carriage return to `⏎` and other control characters to spaces. The real PTY proof pastes `hello
rust composer` as one bracketed paste, submits it, and observes the sanitized transcript row through real Workbench projection.

This is still not a full editor: no terminal cursor positioning, selection, undo, clipboard integration, word movement, multi-line viewport or soft-wrapped editing exists. Alt+Enter depends on terminal key encoding; bracketed paste is the proven multiline path.


## R12 semantic transcript label styling, 2026-11-26

The connected Rust surface now applies semantic terminal styling to the first transcript role token while preserving the exact rendered text. `assistant`, `user`, `tool`, `error` and `usage` labels receive distinct foreground colors when color is enabled; role emphasis degrades to bold/dim modifiers when `NO_COLOR` is set. No background is painted and continuation text remains unstyled, so user-authored content is not recolored or rewritten.

Static canonical rendering intentionally stays plain and byte-stable. The styled path exists only in connected interactive mode. A TestBackend unit check proves that the role label carries the expected style while the emitted cells keep the same text. Real PTY transport and parity gates remain green.

This is semantic label styling, not full theme support: no palette configuration, markdown syntax highlighting, style-aware wrapping, contrast audit or theme persistence exists.

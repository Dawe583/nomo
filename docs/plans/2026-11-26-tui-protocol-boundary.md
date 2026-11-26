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

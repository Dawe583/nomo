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

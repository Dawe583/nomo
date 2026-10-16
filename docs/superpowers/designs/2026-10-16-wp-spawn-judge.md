# WP-SPAWN judge (2026-10-16)

Base: proposal B. Proposal A contributes named items only. No half blend.

## Scorecard

| Criterion | A (minimal blast radius) | B (value first) |
| --- | --- | --- |
| fail-direction safety | 3: exhaustive refuse list plus phantom cleanup on ledger failure; no orphans possible. | 2: strong refuse list, but entry-first ordering leaves a dangling-entry window it never names. |
| ledger integrity | 1: parent chain and digest-only, but delegates to `startSession(background=false)` which sends inline, so ledger-before-wire is asserted not sequenced; identifiers sit in `args`, which `commitWorkspace` stores as digest-only (index.ts:3645). | 2: explicit entry, create, dispatch order; same `args`-placement flaw, cleaner `spawn:completed` decision. |
| minimal blast radius | 2: suffix-only TUI and no queue interaction, but the result-union refusal and required key invent conventions `start`/`branch`/`send` never use. | 2: reuses the existing queued set and `drainQueued` with no new limits, but adds row token display and a `children` count. |
| cost honesty | 3: child-only usage, no row numbers, nothing invented. | 2: child-only and one writer per number, but the row token example needs the unknown-vs-zero care its own risk note admits. |
| testability | 3: every claim pinnable in `node:test`, including stub-fetch order for ledger-before-wire. | 3: same strength, plus queued-park and branch-untouched pins. |
| value honesty | 2: real spawn/watch/steer, but refuse-while-parent-runs fails the headline delegate-while-working flow under the default cap. | 3: parking keeps spawn usable mid-conversation; watch via status/title/inspect, steer via `send()`. |
| contract clarity | 2: exact types, but the union says "returns refusal" while the text throws for bad parent and bad prompt. | 3: positional signature mirrors `send(id, prompt)`; throw matches `start`/`branch`; optional key matches `start`/`send`. |

Totals: A 16, B 17. B is base.

## Ruling (all 10 brief questions)

1. What it is: Session with `parentId`, fresh history (system plus one task prompt), fresh workspace. Spawn differs from `branch()` by no transcript import. Rejected: new object (parallel roster/run/ledger for no gain).
2. Who may spawn: operator-only API, surfaced as TUI `/spawn` (adopted from A). Rejected: model-callable tool this WP (needs a policy class and gate; bypass-shaped risk).
3. Steering: reuse `send(childId, ...)`; no inbox. Parent reads child turns in the child session. Rejected: queued inbox, turn callbacks. `cancel()` stopping a running child is existing path, not new scope.
4. Cost: child session only, no rollup. Rejected: parent counters, shared cost fields.
5. Admission: share `maxConcurrentRuns`. When full, park the child in the existing queued set (bounded by `maxQueuedRuns`, dispatched by `drainQueued`); throw the existing concurrency message only when the queue is also full. Parent running or queued never blocks spawn; `branch()`'s settle rule is explicitly not copied. Rejected (from A): hard refuse whenever anything runs.
6. Tool scope: default to the parent's agent; child tools equal parent effective tools intersected with `toolAllowedInMode` at spawn time, never wider even under `options` overrides. Rejected: subset picker UI, independent allowlist.
7. TUI: sessions-tab rows only, grouping by status unchanged, Enter behavior unchanged (inspects). Label gains suffix ` [child of <parent8>]` with no live tokens (adopted from A; usage tab already reports per-session tokens). Inspector gains `parent` on child rows and `children` count on parent rows (kept from B). Rejected: separate tab/section, token-in-label churn.
8. Ledger: one entry on the parent chain via `commitWorkspace` before any child wire time, `tool: "void_subagent_spawn"`, `decision: "spawn:completed"` (rejects A's `execute:completed`: no policy execution happened). Readable identifiers MUST live in `metadata` because `args` persist as digest-only: `{childId, parentId, childWorkspace, promptSha256, model, agent?}`. Rejected: child-chain entry, raw prompt in body, A's `spawnedAt`/`parentSeq`/duplicate model, B's `promptChars` (ambiguous units, no consumer).
9. Workspace: child owns fresh `agent-<childId>`, no document copy. `parentId` keeps its single lineage meaning; spawn-vs-branch lives in the ledger entry plus TUI marker. Rejected: shared workspace, `snapshotDocuments` default-on, new `origin` field.
10. Refinement `subagent` kind: stays refusing, untouched. Rejected: storable now (schema with no consumer).

## Frozen contract

```ts
spawnSubagent(
  parentId: string,
  prompt: string,
  options?: {
    readonly model?: string;
    readonly agent?: string;
    readonly idempotencyKey?: string;
  },
): Promise<SessionView>
```

Refusal shape: throws `Error`, never a result union. Reuse existing texts verbatim where they exist (concurrency limit, prompt bounds, provider, key collision). New messages name the reason: unknown parent, unresolved parent outcome (unknown status or recovery block only), queue also full, ledger failure. A refused spawn creates no session, writes no entry, makes no provider call, retains no idempotency mapping.

Order (verified against `startSession` wiring inline at index.ts:1630, so delegation unchanged cannot hold): validate, pre-generate child id, create child idle with no wire, `commitWorkspace` on the parent chain, then dispatch via the existing `send()` path or park queued. Ledger-write failure destroys the pre-created child (phantom cleanup adopted from A). No provider call precedes the parent-chain entry; the child carries exactly system plus one user message, so dispatch must not duplicate it.

## Build instructions

Files touched: `packages/workbench/src/index.ts` (one `spawnSubagent` method; a minimal private split of create-vs-dispatch is allowed only if delegation proves impossible, with no signature changes to `startSession`/`send`); `packages/workbench/src/subagents.ts` (new: validation plus pure helpers); `packages/workbench/src/subagents.test.ts` (new); `packages/cli/src/tui/workspace.ts` (sessions-tab rows and session inspect fields only). Forbidden list from the brief stands.

Run one at a time: `npx tsc -p packages/workbench/tsconfig.json --noEmit`; `npx tsc -p packages/cli/tsconfig.json --noEmit`; `node --test --test-concurrency=1 packages/workbench/src/subagents.test.ts`; `node --test --test-concurrency=1 packages/workbench/src/workbench.test.ts packages/workbench/src/lifecycle.test.ts`; `node --test --test-concurrency=1 packages/cli/src/tui/workspace*.test.ts`.

## D-1 row

| D-1 | WP-SPAWN frozen on proposal B (throw, park-via-queue, spawn:completed) with A's /spawn surface, token-free row suffix and phantom cleanup; readable ledger identifiers in metadata, digest never text | A's result union, hard-refuse-when-busy, execute:completed, args-placed identifiers, row tokens |

## Open assumptions

- The exact `queued` condition in `startSession` (index.ts:1585, unread) parks without wire; build verifies before reusing it, else parks manually through the same queued set and `drainQueued`.
- `workspaceToolClass("void_subagent_spawn")` returns undefined so `klass` falls back to `r3` (follows index.ts:3641-3643, untested for this tool name).
- No party outside `commitWorkspace` persists `args` in clear; metadata is the only readable channel (follows index.ts:3618-3662).
- A private create-vs-dispatch split, if needed, stays inside the files-in-play and changes no existing signature.

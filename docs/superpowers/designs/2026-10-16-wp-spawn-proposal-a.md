# WP-SPAWN proposal A: minimal blast radius (2026-10-16)

Designer A mandate: smallest honest diff, maximal reuse, testable with existing suites.

## 1. The contract

Spawn API (new file `packages/workbench/src/subagents.ts`, thin method on `Workbench` in `index.ts`):

```ts
export type SpawnInput = {
  readonly parentId: string;
  readonly prompt: string;
  readonly idempotencyKey: string;
  readonly model?: string;
  readonly agent?: string;
};
export type SpawnRefusal = { readonly ok: false; readonly reason: string };
export type SpawnResult = { readonly ok: true; readonly child: SessionView } | SpawnRefusal;
export async function spawnSubagent(input: SpawnInput): Promise<SpawnResult>;
```

Rules: operator API only (called from TUI `/spawn` or future HTTP, never a model tool). Validates prompt (nonempty, within `maxPromptCharacters`), parent exists, provider connected, then delegates to the existing `startSession` path with `background=false` so `maxConcurrentRuns` admission, catalog check, tool assembly, and `run()` apply unchanged. On refusal returns `SpawnRefusal`, creates no session, writes no ledger entry, spends no provider call.

Ledger entry shape (written through existing `commitWorkspace` on the PARENT workspace, before any child wire time):

```ts
// tool: "void_subagent_spawn", klass: "r1", decision: "execute:completed"
// args: { childId, childWorkspace, parentId, promptDigest, model }
// metadata: { spawnedModel, spawnedAt, parentSeq }
```

Prompt text is never stored; only `sha256Hex(canonicalJson(prompt))`. Restart reconstructs nothing except the fact: child is a normal persisted session with `parentId`; the spawn entry is provenance, not state to replay.

TUI row: sessions tab only, no new tab. Label gains one suffix for children: `[subagent of <parent8>]` appended to the existing label. `buildSessionTree` already groups by status; a child groups under its own status like any session (no regrouping). Enter behavior unchanged: inspects the conversation (inspector plus raw record). Steering is `/resume <child>` then existing chat input, which calls existing `send()`.

Refusal: same text as the concurrent limit today: `Concurrent run limit reached (N). ...`. Plus parent-missing and bad-prompt errors thrown before admission. Refusal never arms anything and never writes.

## 2. Decision per open question

1. What a subagent IS: a Session with `parentId` set. Choice: reuse Session, spawn differs from `branch()` by fresh history (system prompt plus one user message) instead of cloned transcript. Why: no new type, no new store, persistence and `get/list` work untouched. Rejected: new object (a second session store doubles every reader).
2. Who may spawn: operator-only API first, no model-callable tool. Choice: `spawnSubagent` on `Workbench`, surfaced as TUI `/spawn`. Why: a model tool needs a new policy class and gate; this WP ships value without them. Rejected: tool class now (policy surface belongs in a later WP with kill/revive).
3. Steering: reuse `send()` on the child, no inbox. Choice: parent sees child turns by opening the child session; no forwarding. Why: `send()` already gates unknown/recovery/context/admission; a queue is a second scheduling discipline. Rejected: queued inbox (unread-message semantics with no consumer this WP).
4. Cost attribution: child usage recorded to the child session only, no roll-up. Choice: usage events stay where `run()` already emits them. Why: roll-up rewrites usage rows and the spend tab; a parent total can be summed by `parentId` in a later WP. Rejected: roll-up now (touches usage aggregation for zero operator need).
5. Admission: share `maxConcurrentRuns`, no dedicated cap. Choice: spawn calls the same check; when parent runs and child is spawned the spawn is refused with the existing message. Why: one limit means one mental model and zero new settings keys; fail-closed falls out. Rejected: dedicated cap (a new key with no named consumer violates harness-settings rule 1).
6. Tool scope: inherit the parent's effective allowlist intersected with current availability. Choice: child tools equal `parent.tools` filtered by `toolAllowedInMode` at spawn time. Why: narrowest option that needs no new allowlist UI; a child can never exceed its parent. Rejected: subset picker (new UI) and independent allowlist (privilege escalation by delegation).
7. TUI surface: read-only suffix on sessions-tab rows. Choice: label suffix plus inspector field `parent`. Why: `list()` already carries `parentId`; one format string is the whole change. Rejected: separate tab/section (a new tab for a filter is chrome without function).
8. Ledger shape: as in section 1. Choice: parent-workspace entry, prompt digest only. Why: ledger-before-wire holds (entry precedes child `run()`), restart needs no replay, prompt text stays out of a second record. Rejected: child-workspace entry (child has no chain yet at order time) and full prompt storage (duplicates the transcript).
9. Workspace scoping: child gets its own fresh workspace (`agent-<childId>`), same as `branch()`. Choice: no sharing, and `parentId` keeps its single meaning (the session this one was spawned or branched from). Why: sharing a workspace merges two ledgers and breaks per-workspace verification. Rejected: shared workspace (ledger ownership ambiguity) and a second parent-kind field (new concept for no reader).
10. Refinement `subagent` edit kind: stays refusing. Choice: leave the throw in `refineHarness` untouched. Why: the default is leave, and spawn creates live sessions, not reusable specs; storing a spec schema is its own WP. Rejected: making it storable now (schema with no consumer).

## 3. Test list

New file `packages/workbench/src/subagents.test.ts`; TUI assertions extend `workspace*.test.ts` patterns only (no new harness):

- spawn creates a child with `parentId` equal to the parent id and an empty-then-prompt history (not a transcript clone).
- fail-closed admission: at `maxConcurrentRuns` spawn returns `{ok:false}`, creates no session, appends no ledger entry, makes no fetch call.
- fail-closed parent: unknown parent id refuses with no side effects.
- fail-closed prompt: empty and over-limit prompts refuse with no side effects.
- idempotency: same key returns the same child id twice; key bound to another request throws.
- ledger-before-wire ordering: parent chain holds the spawn entry with `childId` before the child session emits any provider request (assert via stub fetch order).
- ledger shape: entry tool `void_subagent_spawn`, decision `execute:completed`, args carry digest not text, payload names child workspace.
- tool scope: child tools are a subset of parent tools; child never gains a tool the parent lacks.
- restart: reloaded workbench still shows `parentId` on the child and the spawn entry in the parent chain.
- TUI: child row label contains the subagent suffix; Enter on a child row inspects (does not jump, does not send).
- refinement still refuses `subagent` edits after this WP.

## 4. Failure direction

Every ambiguity fails toward NOT spawning: unknown parent, bad prompt, no provider, full concurrency, unsettled parent run, closing workbench, or ledger write failure all refuse before any child exists. A ledger write failure after session creation removes the child session (same phantom-key cleanup `commitWorkspace` already does). No orphan children, no silent spawns, no partial records. `send()` on a child keeps its existing guards (unknown outcome, recovery block, context limit).

## 5. Files touched

- `packages/workbench/src/subagents.ts` (new): input/result types, validation, ledger payload builder.
- `packages/workbench/src/index.ts`: one `spawnSubagent` method delegating to `startSession` plus `commitWorkspace`; no other method changes.
- `packages/cli/src/tui/workspace.ts`: session row label suffix and one inspector field.
- Tests: `packages/workbench/src/subagents.test.ts` (new).

## 6. Risks

- `startSession` sends immediately (non-background calls `send` inline); spawn inherits whatever scheduling quirks that has under concurrency.
- Prompt digest in the ledger proves linkage but not content; a dispute about what the child was asked needs the child transcript, which retention may trim.
- Inheriting the parent allowlist snapshots availability at spawn time; later connector consent changes do not propagate to live children.
- Two designers may both pick operator-only spawn; if the judge wants model-initiated spawn, this proposal under-delivers and says so.

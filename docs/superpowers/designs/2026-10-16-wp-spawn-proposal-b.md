# WP-SPAWN proposal B: spawn-and-track (value first)

Design goal: a child worth watching, steering that steers, a roster that
answers "what is it doing", cost that is visible and honest.

## 1. The contract

Spawn API (new file `packages/workbench/src/subagents.ts`, called from one
new `Workbench` method in `index.ts`):

```ts
export type SpawnSubagentOptions = {
  readonly model?: string;
  readonly agent?: string;
  readonly idempotencyKey?: string;
};
spawnSubagent(parentId: string, prompt: string, options?: SpawnSubagentOptions): Promise<SessionView>
```

Behavior: validates, admits through the existing `maxConcurrentRuns` path,
writes the spawn entry to the PARENT workspace chain through
`commitWorkspace`, creates the child `Session` with `parentId` set and a
fresh workspace `agent-<childId>`, then dispatches via the existing
`send()` path when no run is active or parks the child in `queued`
otherwise (existing `drainQueued` picks it up). The child runs through the
same `run()`/policy/alias path as any session. Steering is `send(childId,
prompt)`; nothing new.

Ledger entry shape (parent chain, via `commitWorkspace`, before any wire):

```ts
tool: "void_subagent_spawn", decision: "spawn:completed",
args: { childId, parentId },
metadata: { childWorkspace, promptSha256, promptChars, model, agent }
```

The raw prompt is NOT in the ledger body: its sha256 links to the child
session's first user event, which holds the text. Restart reconstructs
nothing new: the storage snapshot already persists views including
`parentId`, and the spawn entry is evidence, not restore source.

TUI row (sessions tab only, no new rows or bands): existing label plus a
child marker and live cost, e.g.
`[running] Draft the plan [child of a1b2c3d4] 12 tokens`.
Grouping stays by status. Enter keeps the existing sessions-tab inspect and
gains two fields in the same inspector: `parent` (short id) and `children`
(count on a parent row). No navigation change.

Refusal: `spawnSubagent` throws, spends nothing, records nothing as
spawned: no child session, no ledger entry, no queued item. Every refusal
names the reason (unknown parent, bad prompt, cap reached, no provider,
parent outcome unresolved). Idempotent replay returns the prior child view.

How the operator knows what the child is doing: the child is a normal
session row with status, title, token count and last event; Enter inspects
message/tool/error counts plus parent link; the usage tab already reports
per session tokens; the parent chain ledger tab shows the spawn entry.

## 2. Decision per open question

1. WHAT IT IS. Choice: a `Session` with `parentId` set. Why: roster, run,
policy, ledger and TUI all work with zero new machinery, which is the
whole value bet of the slice. Spawn differs from `branch()` clone
semantics: fresh messages (system plus the one task prompt), fresh empty
workspace, no history import. Rejected: a new object, which would need a
parallel roster, run and ledger path for no operator gain.
2. WHO MAY SPAWN. Choice: operator-only API first, no model-callable tool.
Why: a tool needs a class, a policy gate and a blast radius, and any wrong
choice there is a bypass shaped hole; the operator path delivers the demo
value with none of that risk. Rejected: model tool this WP.
3. STEERING. Choice: reuse `send()` on the child, no queued inbox. Why:
`send()` already serializes turns and refuses while running, which is the
steering contract; a second inbox would double it. The parent sees child
turns as normal session events. Rejected: inbox queue, child turn
callbacks.
4. COST. Choice: child usage recorded on the child session only, shown on
its row; no rollup field. Why: one writer per number keeps cost honest and
auditable; a rollup is derived display and can come later without touching
the ledger. Rejected: parent rollup counters, shared cost fields.
5. ADMISSION. Choice: share `maxConcurrentRuns`, fail closed when full
(throw, no session, no entry). A spawn while another run is active parks
the child as `queued` through the existing set and `drainQueued`. Why:
one cap means one mental model and no new limit; parking reuses tested
code. Rejected: dedicated cap (forbidden by the slice and needless).
6. TOOL SCOPE. Choice: inherit the parent's resolved scope snapshot at
spawn: same agent profile id plus the parent's tool list filtered by the
server permission mode. Why: a child that can do more than its parent is a
privilege escalation with a nice name. Rejected: subset picker UI and
independent allowlist (later WP surface).
7. TUI SURFACE. Choice: read-only roster rows on the sessions tab, child
marker plus tokens in the label, Enter inspects with parent/children
fields. Why: the operator already looks there; a new tab spends row budget
and attention for a second list of the same objects. Rejected: separate
section or tab.
8. LEDGER SHAPE. Choice: `void_subagent_spawn` / `spawn:completed` on the
parent chain with child id, workspace, prompt digest, model and agent.
Why: the parent chain is where an auditor asks "why does this child
exist"; the digest links to the child's first event without stuffing
prompt text into a signed body. Rejected: child chain entry (child may not
exist yet at write time), raw prompt in body.
9. WORKSPACE SCOPING. Choice: child lives in its own fresh workspace, no
document copy by default. `parentId` keeps one meaning (lineage) and the
ledger spawn entry plus the TUI marker carry the spawn-vs-branch
distinction, so no second field. Why: shared writes would tangle undo and
provenance; a copy flag can arrive later. Rejected: shared workspace,
`snapshotDocuments` default on, new `origin` field.
10. REFINEMENT SUBAGENT KIND. Choice: leave refusing. Why: the schema has
no consumer and this WP adds none; storing what nothing reads is how a
chain fills with claims nobody checks. Rejected: making it storable now.

## 3. Boundary moves

None. Kill/revive is not needed for safety on day one because `cancel()`
already stops a running child through the existing path and a stopped
child simply stays readable. Child-initiated messaging is not needed for
usefulness on day one because the child finishes its task prompt and the
operator reads the transcript; the fallback that stays inside the slice is
polling the sessions row plus Enter to inspect. If either proves wrong in
review, the smallest move is a child completion notice (event only, no
messaging), not full messaging.

## 4. Test list

In `packages/workbench/src/subagents.test.ts`, node:test, one process:

- spawn creates a child with `parentId`, fresh workspace, system plus one
  user message, and no imported history.
- fail closed on cap: at `maxConcurrentRuns` the call throws, session
  count unchanged, parent chain length unchanged.
- fail closed on unknown parent, empty prompt, overlong prompt, missing
  provider: each throws with a naming message and writes nothing.
- ledger-before-wire: parent chain holds `spawn:completed` with child id
  and prompt digest before the child dispatches any provider call.
- idempotent replay with the same key returns the same child, no second
  entry and no second session.
- steering: `send(childId, ...)` appends a turn served by the normal path.
- queued park: spawn during an active run leaves the child `queued` and
  `drainQueued` dispatches it after settle.
- tool scope: child tools are a subset of the parent snapshot, never wider.
- prompt privacy: ledger body carries the digest, never the raw prompt.
- branch untouched: `branch()` clone semantics and `parentId` behavior
  unchanged (existing lifecycle tests stay green).

## 5. Failure direction

Any ambiguity fails toward NOT spawning: unknown parent state, unresolved
parent outcome (unknown status, recovery block), unreadable provider state,
cap reached, invalid prompt, idempotency key collision, ledger write
failure (child is never created if the entry cannot be signed first). A
spawn that cannot prove where it came from does not happen.

## 6. Files touched

- `packages/workbench/src/index.ts`: one `spawnSubagent` method only.
- `packages/workbench/src/subagents.ts`: new, validation plus pure helpers.
- `packages/workbench/src/subagents.test.ts`: new, the list above.
- `packages/cli/src/tui/workspace.ts`: sessions-tab rows and session
  inspect fields only. Nothing else.

## 7. Risks

- One global `send()` gate means an operator steering a child while the
  parent runs waits; parking covers spawn but mid run steering still
  serializes, which may feel slow.
- `parentId` double meaning (branch clone vs spawn delegate) lives only in
  the ledger entry and TUI marker; a reader of raw storage sees one field.
- No child completion signal means a finished child waits to be noticed;
  acceptable for day one, first thing to revisit.
- Token counts on rows depend on provider usage reports; absent reports
  render as unknown, never as zero.

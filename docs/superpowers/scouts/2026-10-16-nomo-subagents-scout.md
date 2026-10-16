# Scout: subagent orchestration (2026-10-16)

Read-only map. No design, no build. Paths relative to worktree root.

## 1. Existing state (what is there)

- Session model already has lineage: `SessionView.parentId?: string`
  (`packages/workbench/src/index.ts:195`). Only writer today is `branch()`
  (`index.ts:2185`), which clones a session as `(branch)`.
- Closest thing to "spawn a second agent": `Workbench.start()` /
  `startSession()` (`index.ts:1414`, `1461`) plus `run()` (`index.ts:4202`).
  Admission already exists: `maxConcurrentRuns`, `maxQueuedRuns`
  (`index.ts:1478-1490`), provider-from-validated-catalog check, per-turn
  `agentProfile` revalidation with policy profile (`index.ts:4223-4232`).
- Agent profiles exist but are static configs, not running children:
  `AGENT_PRESETS` + `agentProfiles`, `upsertAgent()` (`index.ts:297-325`,
  `1151-1184`), surfaced via `agents()` (`index.ts:1123-1150`) and
  `GET /api/agents` (`apps/control-plane/api/server.ts:458`).
- Only `spawn` in workbench is hooks: `agents.ts:1,237` spawns an
  allowlisted command (`hookAllowlist`, `NOMO_HOOK_COMMANDS`) with timeout
  and output ceiling. No PTY anywhere; no child-agent process machinery.
- Refinement schema names `subagent` but refuses it:
  `REFINEMENT_KINDS` includes `"subagent"` (`refine-pass.ts:42`), yet
  `refineHarness()` throws on skill/subagent edits
  (`index.ts:2896-2897`); `HARNESS_KINDS` in `learned-harness.ts:65` is
  only `rule | lesson`. Subagent specs have no storage, no schema, no UI.
- External runtimes NOMO drives: none in-process. `omp` is unconsumed
  (no import, no spawn per `docs/AGENT-BINARIES.md:19-23`); `prime` only
  via `scripts/src/prime-bridge.mjs`, `cloud/prime.mjs`,
  `scripts/team/prime-spawn.sh` (see `docs/AGENT-BINARIES.md:34-46`).
  TUI `execFile` use is shell/git helpers only (`workspace.ts:2,930`).
- Control plane session surface: `/api/sessions/:id/{events,stream,
  documents,branches,compact}`, `/api/runs/:id/stop`
  (`apps/control-plane/api/server.ts:430-736`). No child/roster endpoint.
- TUI: 11 tabs, no agent roster (`workspace.ts:148-160`). Sessions tab +
  session-tree exist; `/harness` commands and ledger/harness tabs show
  scores and proposals. Branch demo: `workspace.ts:4801-4822`.
- Identity primitive that a spawn design could reuse:
  `LocalAgentIdentityIssuer` short-lived scoped grants
  (`agent-identity.ts:1-60`, TTL 60s, audience-bound).

## 2. References (second-hand where noted)

- omp Agent Hub (read directly, `upstream/omp-src/docs/agent-hub.md`):
  TUI roster (status, identity, parent, lineage, cost/usage), flat/tree
  views, filter, inspector, revive/kill, focus-to-steer, pinned jump list,
  `agent://` and `history://` URLs for messaging/transcript. Spawn itself
  is the Task tool (`@oh-my-pi/pi-tui/tools/task`, `BeforeSubagentSpawnEvent`
  in `coding-agent/src/tools/index.ts:15-16`), second-hand, not read deep.
- prime `rlm.spawn` (read directly, `prime-agent-runtime/src/rlm/`):
  `handle = await rlm.spawn('sub-task', name='worker')` returns immediately
  with `rlm_child_id, name, session_dir, model`, never the answer
  (`__init__.py:27-33`, `harness.py:1094-1099`). Results arrive only via
  `agent_message.send(..., receiver_role='parent')` replies or files;
  follow-ups via `receiver_role='child'`. Python kernel runtime , 
  explicitly rejected for NOMO by the harness spec.
- prime `agent_message` (read directly,
  `pa-core/src/session_engine/agent_messaging.rs`, 568 lines):
  role-addressed sends (parent/sibling/child), broadcast one-per-member,
  per-sender token bucket (3 burst, 1/s refill), 16k char cap, 20 pending
  per session, queued-vs-delivered receipts, family roster via
  `agent_observe.list_agents`. Ledger-before-wire discipline noted.

## 3. Where it would live

`packages/workbench` owns it: session store, `run()` loop, ledger writes,
limits (`harness-settings.ts`, each key names consumers). A subagent fits
as a `Session` with `parentId` set, not a new object class. Display in
existing sessions tab / session-tree (`packages/cli/src/tui/`), roster
read in `apps/control-plane/api/server.ts`. No new package, no PTY, no
Python kernel.

## 4. Candidate first slice

Spawn-and-track, model-driven turn reuse: `Workbench.spawnSubagent(
parentId, prompt, {agent?})` creates a child `Session` (`parentId` set),
admitted by existing `maxConcurrentRuns` accounting, run through the same
`run()`/policy/ledger path, spawn recorded as a signed ledger entry.
Steering = existing `send()` on the child id. TUI: read-only roster rows
under the parent on the sessions tab. No kill/revive, no child-initiated
messages, no new limits, no schema change to refinement.
- Exit: `npx tsc -p packages/workbench/tsconfig.json --noEmit`,
  `npx tsc -p packages/cli/tsconfig.json --noEmit`,
  `node --test --test-concurrency=1 packages/workbench/src/subagent*.test.ts`,
  plus regressions `packages/workbench/src/workbench.test.ts`
  `packages/workbench/src/lifecycle.test.ts`
  `packages/cli/src/tui/workspace*.test.ts`.
- In play: `packages/workbench/src/index.ts` (spawn method only),
  new `packages/workbench/src/subagents.ts` + test,
  `packages/cli/src/tui/workspace.ts` (sessions-tab rows only).
- Forbidden: `packages/policy/*`, `packages/ledger/*`,
  `packages/registry/*`, `packages/runtime/*`, `provider.ts`,
  `refine-pass.ts`, `learned-harness.ts`, `agent-identity.ts`,
  `scripts/src/prime-bridge.mjs`, `cloud/*`, `upstream/*`,
  `harness-settings.ts` (no new key in slice 1).

## 5. Open decisions for DESIGN

1. What a subagent IS: session with `parentId` vs new object type.
2. Who may spawn: operator-only vs model-callable tool (latter needs
   policy class + ledger gate).
3. Messaging: reuse `send()` steering vs `agent_message`-style queued
   inbox with receipts and caps.
4. Lifecycle: kill/revive semantics; does parent cancel kill children.
5. Cost attribution: child usage metered to parent or standalone.
6. Admission: share `maxConcurrentRuns` or a dedicated subagent cap.
7. Tool scope: inherit, subset, or independent `agentProfile` allowlist.
8. TUI surface: sessions-tab section vs new tab vs hub overlay.
9. Ledger shape: spawn/steer/kill as which signed events.
10. Refinement interlock: when `subagent` edit kind becomes storable.

## 6. Risks and unknowns

- Concurrent runs multiply provider cost; admission must fail closed.
- Child turns cross the same `decide` + alias-gate path; any shortcut is
  a safety hole. Ledger-before-wire ordering must hold for spawn records.
- Steering a running child races the turn loop; needs the same
  boundary discipline as manual harness review.
- `branch()` is the only `parentId` writer; its semantics (clone) differ
  from spawn (fresh session, shared workspace?), workspace scoping open.
- env: `NOMO_*` with `VOID_*` fallback; no glm models anywhere.

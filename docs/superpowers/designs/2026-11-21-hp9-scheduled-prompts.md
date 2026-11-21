# HP9 design record: operator-owned scheduled prompts

Date: 2026-11-21. Decided by the controller session under the standing
authorization in `docs/HARNESS-LOOP-PLAN.md` section 3.4. Node `HP9` in
`.nomo/work-state.json`.

`docs/superpowers/designs/2026-11-21-hp0-harness-parity.md` closed its gap
matrix with a deliberate deferral: "Scheduling, web tools and agent messaging
each change what runs without an operator in the loop or what leaves the
machine. They are designed after HP1 to HP8 and need an owner decision before
code: HP9 has no daemon to run in." This record is that decision.

## The gap

Both reference agents ship scheduling, and neither ships it inside their
policy boundary:

- Hermes Agent has `cronjob_manage`, `/loop` and `/heartbeat`. The model can
  create its own recurring job, and the job store is the agent's own file.
- Prime Agent has `/heartbeat`, agent-owned heartbeats and a `schedule`
  command. A heartbeat is the agent asking to be woken again.
- NOMO at `1ec1e5d` has none. A run starts when an operator or an API client
  calls `Workbench.start` or `Workbench.send`, and a conversation ends when the
  model stops calling tools.

What NOMO cannot copy is the part where the model decides its own next run.
Principle 1 (only operator-approved learning reaches a prompt), Principle 2
(nothing learned reaches policy, the tool catalog or a permission) and
Principle 3 (a new model tool is classed and runs through policy and holds)
all assume a person is the origin of unattended work. A self-waking agent
would be a loop nobody approved, and NOMO's digest-approval machinery covers
learning, not scheduling.

So HP9 has to answer two questions at once: what runs without a person
watching, and what may start it.

## Constraints the context pack already fixes

- Decision D6 in `docs/HARNESS-LOOP-PLAN.md`: no new dependency, store or
  transport. HP9 therefore may not add a scheduler process, a queue service, a
  database table or a new wire protocol.
- `docs/CONTEXT.md`: unknown identity, scope, policy, broker, revocation or
  ledger state fails closed. A firing whose target state cannot be read is an
  unknown, not a guess.
- `docs/CONTEXT.md`: "Token, prompt and secret values never enter logs, events,
  ledger payloads, screenshots or durable workspace state". Conversation text
  the operator already owns is the one place NOMO persists prose today, so a
  schedule prompt is recorded by digest in the signed chain, exactly as
  `spawnSubagent` already records `promptSha256`, and the prompt text itself
  lives only where a conversation's own messages live: the encrypted snapshot.
- `packages/workbench/src/harness-settings.ts`: "a limit nobody can change is a
  limit nobody chose", and "Bounds are clamped, not trusted".
- `packages/workbench/src/goals.ts` (HP7): the rules of a governed loop belong
  in a pure module, so the integration cannot quietly restate them.

## Options considered

A. **Operator-owned schedule records driven by one callable evaluation.**
   Schedules are records in the existing encrypted workspace snapshot. The
   rules are a pure module, `packages/workbench/src/schedules.ts`. The only
   entry point that starts work is `Workbench.runDueSchedules(nowMs)`, which a
   one-shot `nomo schedule run-due`, a host cron entry, a systemd timer or an
   opt-in control-plane tick may call. Each firing goes through the existing
   `Workbench.start` or `Workbench.send` path, so policy, holds, turn limits,
   the queue and the signed ledger are the same ones a person's run uses.

B. **A schedule daemon with its own timer and store.** A separate process owns
   the clock, persists jobs and calls the workbench over a socket.

C. **A model-callable scheduling tool.** `nomo_schedule` lets the model create
   its own recurring prompt, as `cronjob_manage` does.

## Selected: A

Rejected B on D6 and on governance. A second process is a second lifecycle to
supervise, authenticate, stop and revoke, a second store to encrypt and back up,
and a firing path that either bypasses `Workbench` or duplicates it. NOMO's
existing run lifecycle is the only place policy, holds and ledger evidence are
correct, so a scheduler that talks to it from outside buys nothing a host
scheduler does not already provide.

Rejected C on Principles 1 to 3 and on the trust model in `docs/CONTEXT.md`.
Text a model wrote must never become unattended work. A model-proposed schedule
would have to be inert until an operator approves the exact record by digest,
which is the H10 proposal pattern and not this slice. HP9 adds no model tool at
all, so no registry class is needed and no tool can widen a run.

## The record

A schedule is one operator record. Every field is stated by the operator; none
is derived from model text.

| Field | Rule |
| --- | --- |
| `id` | Minted by the workbench (`randomUUID`). Never accepted from a body. |
| `name` | Trimmed, 1 to 80 characters, no control character. |
| `prompt` | Trimmed, 1 to the operator's `maxPromptCharacters`, no control character other than tab, newline and carriage return. |
| `cadence` | `{ kind: "interval", everySeconds }` with 60 to 604800, or `{ kind: "once", at }` with an ISO instant in the future. |
| `sessionId` | Optional canonical UUID of an existing conversation. Absent means each firing starts a new session. |
| `model` | Optional provider model id, shape checked only: the catalog still decides membership. |
| `agent` | Optional agent preset or profile id under the existing `agents.ts` rule. |
| `maxRuns` | Required integer, 1 to 1000. |
| `tokenBudget` | Optional integer, 1 to 1000000. |
| `enabled` | Optional boolean, default true. The operator's own switch. |
| `status` | Governance state, written by the rules below and never by a request body. |
| `runCount`, `tokensUsed`, `createdAt`, `nextRunAt`, `lastRunAt`, `lastSessionId`, `lastOutcome` | Record state. A body that names any of them is refused by name. |

`SCHEDULE_LIMITS` in the module holds the fixed caps: `schedules: 32`,
`minIntervalSeconds: 60`, `maxIntervalSeconds: 604_800`, `maxRuns: 1_000`,
`tokenBudgetMax: 1_000_000`, `nameCharacters: 80`. The table bound
(`schedules: 32`) is enforced where the table is visible, in the wiring node's
`createSchedule`; the rules module decides one record at a time and never sees
the table. The prompt bound is not a constant because the honest bound is the
operator's own prompt limit, which is known only at the call site, exactly as
`parseGoalInput` takes it. A caller that cannot state it gets 0, which refuses
every prompt rather than accepting one against no bound.

The parser is strict about keys. A body carrying `id`, `status`, `runCount`,
`tokensUsed`, `nextRunAt` or `createdAt` is refused by name, because a silently
dropped field reads to the caller as accepted and this record decides when
unattended work starts. `once` instants that are not in the future are refused
for the same reason: they would fire on the next tick for a moment the operator
cannot have meant.

## Cadence and the next slot

- An interval schedule first fires one full interval after it is created, so
  creating a schedule never starts work the operator has not yet seen listed.
- `nextRunAt` is computed from a caller-supplied `nowMs`, so two calls with the
  same clock return byte-identical records and a test can pin the result.
- After a firing, the next slot is the previous `nextRunAt` advanced by whole
  intervals until it is strictly later than the firing. The cadence is anchored,
  so a run that starts five seconds late still keeps the operator's cadence
  instead of drifting five seconds per firing.
- Slots missed while nothing was running are skipped, not replayed. NOMO does
  not fire a catch-up burst nobody asked for; the operator sees the record as
  overdue instead.
- A `once` schedule has no next slot, so after its firing it keeps the instant
  it ran and can never be due again.

## What a firing is

`Workbench.runDueSchedules(nowMs)` is the only entry point that starts work. It:

1. Reads the workspace schedule table from the encrypted snapshot.
2. Calls `dueSchedules(records, nowMs)`: only a record that is `active` **and**
   `enabled` **and** whose readable `nextRunAt` is at or before `nowMs` is
   returned, ordered by `nextRunAt` then `id`, so a caller that only fires the
   head of the list is deterministic and a tie cannot depend on insertion
   order. A `nextRunAt` that cannot be parsed is skipped, because a firing
   nobody can explain afterwards is not a firing NOMO performs.
3. For each due record, in order, checks the target before starting anything:
   - No `sessionId`: `Workbench.start(prompt, model, key, project, agent)` with
     the record's `model` and `agent` and no project binding starts a new
     session, which is the only shape that cannot overlap another run.
   - `sessionId` present: the session view must exist, and its `status` (the
     `SessionView` union in `index.ts`) decides. `running` and `queued` mean
     the target is busy, so the firing is skipped, nothing is counted and the
     record stays due for the next evaluation. `unknown` means the state cannot
     be proved, so the record is parked as `paused_unknown` with
     `enabled: false`. `idle`, `paused`, `cancelled` and `failed` are settled
     states, so the firing proceeds. A target that no longer exists is a
     resolved fact, so the record is parked as `paused` for the operator to
     retarget. A firing is never queued behind another one on the same
     conversation and never overlaps one.
   - The run then goes through the existing path unchanged: `Workbench.start`
     or `Workbench.send(sessionId, prompt)`, with the same policy evaluation,
     the same holds and approvals, the same turn, token and wall-clock limits,
     the same queue bound (`maxQueuedRuns`, `maxConcurrentRuns`) and the same
     signed ledger. A firing that the queue refuses is skipped like a busy
     target. `send` returns nothing, so a firing's outcome is read from the
     settled session view and the signed chain, never from a return value.
4. When the firing settles, calls `recordScheduleRun` with the outcome and
   writes the updated record back to the same snapshot field. The firing is
   awaited inside that one evaluation, because an outcome nobody waited for is
   an outcome that cannot be recorded. That is why a tick that is still running
   when the next one is due is skipped rather than overlapped.

Outcome mapping is deliberately coarse, because only these four claims are
provable from the run: a settled run with no pending tool call is `idle`, a
provider or policy refusal is `failed`, an operator stop or cancel is
`cancelled`, and a timeout or any state that cannot be verified is `unknown`.
An `unknown` stays `unknown`; it is never rounded to a failure.

## State transitions

`recordScheduleRun(schedule, event)` is pure and its order is the contract:

1. `outcome === "unknown"` parks the record: `status: "paused_unknown"`,
   `enabled: false`. This is the strongest state, because a schedule is a loop
   and repeating a firing whose result nobody could verify multiplies an
   unknown side effect. The counters still move: the run happened and spent
   tokens.
2. A record the operator already stopped (`status !== "active"` or
   `enabled === false`) keeps its status and switch. A run that settles after a
   pause must never put the schedule back to work. Its slot still advances, so
   a resume does not immediately re-fire a stale slot.
3. A `once` cadence, or `runCount >= maxRuns`, completes the record. Calling
   finished work budget limited would be false, which is the same precedence
   `evaluateGoal` uses when a passing gate beats a spent budget.
4. `tokensUsed >= tokenBudget` stops the record as `budget_limited`.
5. Otherwise the record stays `active` with its next anchored slot.

`runCount` increments on every recorded firing, `tokensUsed` accumulates the
reported tokens (an event without a count adds nothing), and `lastRunAt`,
`lastSessionId` and `lastOutcome` describe the most recent firing.

`paused_unknown` is the single reconciliation state, whether the unknown came
from a run outcome or from a target whose state could not be read. The operator
reconciles it by resuming the record, which is an explicit operator act and the
only thing that clears the state.

## Surfaces

- Workbench: `schedules()`, `createSchedule(input)`, `pauseSchedule(id)`,
  `resumeSchedule(id)`, `deleteSchedule(id)` and `runDueSchedules(nowMs)`.
  Creation, pause, resume and delete are the operator's acts; none of them is
  reachable from a model turn.
- HTTP: `GET /api/schedules`, `POST /api/schedules`,
  `POST /api/schedules/:id/pause`, `POST /api/schedules/:id/resume`,
  `DELETE /api/schedules/:id`, `POST /api/schedules/run-due`, in the existing
  API shape and behind the existing operator session. Request bodies go through
  `parseScheduleInput`; a refusal names the field.
- CLI: `nomo schedule list`, `nomo schedule add`, `nomo schedule pause <id>`,
  `nomo schedule resume <id>`, `nomo schedule rm <id>`,
  `nomo schedule run-due`.
- Resume recomputes the next slot from the resume moment (one interval later),
  so resuming never fires immediately. A `once` record whose instant has passed
  refuses resume by name, because the only honest repair is a new record.
  A `completed` or `budget_limited` record is not resumed: the operator raises
  `maxRuns` or `tokenBudget` with an explicit edit, which is a new decision
  rather than a silent continuation.
- The opt-in tick: the control plane may call `runDueSchedules(Date.now())` on
  an interval when `NOMO_SCHEDULE_TICK_MS` seeds it or the operator setting is
  active. It is off by default, the operator setting wins once written, a value
  below one second is clamped, and a tick that is still running when the next
  one is due is skipped rather than overlapped. The tick is not a daemon: it
  lives inside the control plane process that is already running, it holds no
  credential of its own, and if the control plane is down nothing fires. That is
  a stated property, not a defect, and the one-shot command, cron and a systemd
  timer are the supported ways to get a clock NOMO does not own.

## Storage

The schedule table is one additive array in the existing encrypted workspace
snapshot, next to the sessions, settings and harness state the workbench already
writes. No new store, file format, table or dependency: D6 holds. The prompt
text is stored there and nowhere else; every event, log line and ledger payload
carries the schedule id, the run count, the model and agent, and the prompt
digest (`sha256`), the same way `spawnSubagent` records `promptSha256` instead
of the prompt.

## What this slice implements

`packages/workbench/src/schedules.ts`, with
`packages/workbench/src/schedules.test.ts` written first:

- `SCHEDULE_LIMITS`
- `ScheduleStatus`, `ScheduleCadence`, `ScheduleOutcome`, `Schedule`,
  `ScheduleInput`, `ScheduleRunEvent`
- `parseScheduleInput(input: unknown, maxPromptCharacters: number, nowMs?: number): ScheduleInput`
- `dueSchedules(schedules: readonly Schedule[], nowMs: number): readonly Schedule[]`
- `recordScheduleRun(schedule: Schedule, event: ScheduleRunEvent): Schedule`

The module imports nothing. It has no clock, no timer, no store and no session;
it decides, and `Workbench` acts.

## What this slice does not implement

The workbench wiring (`schedules()`, `createSchedule`, `pauseSchedule`,
`resumeSchedule`, `deleteSchedule`, `runDueSchedules`), the `/api/schedules`
routes, the `nomo schedule` commands and the opt-in tick are specified here and
belong to the wiring node that follows. Until that node lands, no schedule can
be created and no firing can start, which is the fail-closed default: the rules
exist and nothing calls them.

## Acceptance and verification

- Rules layer: `NO_COLOR=1 node --test --test-reporter=tap packages/workbench/src/schedules.test.ts`
  covers the limits, the exact key set, every bound and refusal, the canonical
  UUID target, the future `once` instant, deterministic `nextRunAt`, due
  ordering and filtering, the anchored non-drifting slot, the four outcome
  paths, the operator-stop precedence, budget and run-count stops, and that
  neither function mutates its input. 37 tests, all passing at this record.
- `npx tsc -p packages/workbench/tsconfig.json --noEmit` reports no error in
  either new file.
- Wiring node acceptance: a schedule fires once at its slot through the normal
  governed run; a busy target is skipped and not counted; an unreadable target
  state parks the record; an `unknown` outcome parks it; the budget stops it;
  a paused record never fires; the ledger carries the schedule id and the
  prompt digest but never the prompt.
- Then the workbench suite, the CLI harness tests, the documentation tests,
  `pnpm run typecheck` and the full gate at the accepted Linux baseline.

## Out of scope

- Any model-callable scheduling tool. A future proposal would have to be inert
  until an operator approves the exact record by digest, which is the H10
  pattern.
- A daemon, a queue service, a hosted cron or a new store.
- Catch-up firing, jittered cadence, cron expressions, per-schedule
  concurrency, and any edit to `packages/cli/src/tui/*`.
- Any change to `decide`, policy, the registry, permissions or the ledger
  format.

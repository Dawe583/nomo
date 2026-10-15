# The harness workstream as a graph (2026-10-15)

Directive: from now on this workstream is run as a graph, not as a chain of
prompts. The structure decides what happens next; models contribute judgment
only at nodes that need it. Prompt chaining feeds each node only its own
inputs, so no node carries the whole conversation forward.

This file is the control surface. It is updated at every checkpoint, and it
is the first thing a next session reads.

## Output, in one sentence

Every harness work package ends merged or explicitly deferred, with a signed,
operator-gated evaluator-optimizer loop in the Workbench and evidence that was
produced by running the real commands, never by claiming them.

## Nodes

One node, one job. Executors are this session, the operator, or a subagent.

| Node     | Job                                                        | Executor                                     | Cost          | Exit artifact                                  |
| -------- | ---------------------------------------------------------- | -------------------------------------------- | ------------- | ---------------------------------------------- |
| SCOUT    | Map the WP: files, prerequisites, forbidden files, exit commands | this session or `nomo-scout`         | free          | WP brief with the exact commands                |
| DESIGN   | For a material decision, two independent proposals plus a judge | two designers + judge subagents         | model calls   | frozen contract, rejected alternatives recorded |
| FREEZE   | Pin the contract in the WP brief before code               | this session                                 | free          | WP brief marked frozen                          |
| BUILD    | One writer per worktree, failing test first                | this session or builder subagent             | free          | red test, then green test                       |
| VERIFY   | Run every exit command, capture real output                | `nomo-verify-runner` or this session         | free          | pasted command output                           |
| REVIEW   | Adversarial lenses, parallel, default to refuted           | `nomo-skeptic`, `nomo-review-*`              | model calls   | findings JSON `{file,line,severity,claim,repro,recommendation}` |
| FIX      | Address confirmed findings; refute the rest with evidence  | this session                                 | free          | diff plus rerun output                          |
| EVIDENCE | Commit, changelog line, coordination note refresh          | this session or `nomo-docs`                  | free          | commit with trailer, note updated               |
| HUMAN    | Operator gate where a mistake is durable (merge, prompt)   | the operator                                 | -             | approval or refusal recorded                    |

A node that finds nothing still writes its artifact. Silence is not evidence.

## Edges

| Edge          | In this workstream                                                                 |
| ------------- | ---------------------------------------------------------------------------------- |
| Direct        | VERIFY passes -> REVIEW. REVIEW clean -> EVIDENCE.                                 |
| Conditional   | REVIEW findings confirmed -> FIX; all refuted -> EVIDENCE with refutations.        |
| Parallel      | Independent lenses run at once in REVIEW. Builders fan out only when two WPs share nothing. |
| Looping       | FIX -> VERIFY -> one more REVIEW. Hard cap: two review rounds, then defer or accept with recorded risk. |
| Error         | Rate limit or dead endpoint -> park the node, resume on a later boundary; never fake the artifact. |
| Human         | Merging, prompt-affecting changes, anything durable: the operator decides.          |
| Event         | `main` moves (the TUI lane) -> rebase checkpoint before INTEGRATE.                  |

## State and checkpoints

State lives in three places, in order of truth: the signed repo history, the
coordination note (`.prime-coordination-note.md`), and this file's queue
below. Reducers: findings merge by `(file, line, claim)` keeping the highest
severity; evidence appends, never rewrites; a state block updates in place.

Checkpoint after every node that ran: one line in the queue, one commit once
BUILD and VERIFY are green. Subagent nodes get only the WP brief, never the
conversation, and return JSON, never prose.

## Stopping rules

- The cheap gate runs before every model call, exactly as the product's own
  gate does. No subagent is spawned for a job deterministic code or a single
  command can answer.
- Two review rounds per WP. A third would be repetition, not iteration.
- A WP that cannot name its exit command in the brief is not ready to build.

## The product's own graph (what the harness implements)

The harness is itself an evaluator-optimizer graph, and the module names are
the nodes. This mapping is honest about what exists:

| Pattern              | In the product                                                                   | Status |
| -------------------- | -------------------------------------------------------------------------------- | ------ |
| Routing              | `refine-gate.ts`: held, no-candidate, cooldown, disabled all decide before any model call | done |
| Evaluator-optimizer  | reviewer (`harness-runtime.ts` review) checks evidence; refiner proposes; operator approves | done |
| Chaining             | review request -> `extractJsonObject` -> `validateProposal` -> `applyProposal`; each step sees only its input | done |
| Checkpoints          | signed ledger records, per-session trigger state, restart reconstruction          | done |
| Reducers             | `applyProposal` merges edits; approvals bind to the proposal digest               | done |
| Human gate           | `kind: "prompt"` edits are withheld until an operator signature exists            | done |
| Loop cap             | cooldown on every attempt, branch invalidation discards stale rounds              | done |
| Manual arm (human edge into the loop) | `refine-trigger.ts` `requestManualReview`, `refine-gate.ts` `GateInput.manual`, Workbench `requestHarnessReview`, TUI `/harness review` | done |
| Parallel review lenses | one reviewer today                                                   | candidate, needs a cost decision |

## Work package queue

| WP      | Scope                                                                 | Status                                            |
| ------- | --------------------------------------------------------------------- | ------------------------------------------------- |
| WP-CATALOG | A provider without a model catalog (404 or empty) accepts the model the operator named; every other probe failure surfaces as itself | done: `aff5ee6`, VERIFY green (447/447 + tsc), skeptic findings 1+2 fixed, 3 refused (D-4), EVIDENCE landed |
| WP-MANUAL  | `/harness review` arms the trigger on demand: the missing caller the refine docblocks point at | done: contract frozen (D-5), open items settled (D-6); BUILD+VERIFY green (463/463 workbench, TUI 194/195 with the one pre-existing stderr-warning failure proven on `aff5ee6`); EVIDENCE in this commit |
| WP-MANUAL REVIEW | adversarial lenses over `7e79fe8` | parked: both reviewer subagents hit the rate limit on first attempt; resume on a later boundary (error edge), never fake the artifact. A deterministic pass over the diff confirmed every frozen-contract claim in the meantime |
| WP-MERGE   | Land `feat/agent-harness` on `main` after the TUI lane settles; rebase checkpoint on event edge; `nomo-merger` | queued, gated by the TUI lane |

## Decision log

| Decision | Choice | Rejected because |
| -------- | ------ | ---------------- |
| D-2026-10-15-1 Catalog-less providers | Fallback to the operator-named model only on HTTP 404 or an empty catalog; every other probe failure rethrows | Swallow-all hid a refused connection and a 401 behind "configured" (caught by the pinned logout test); merging the named model into a non-empty catalog would invent entries the provider never served |
| D-2026-10-15-2 The workstream graph itself | This file, updated at checkpoints | A framework (LangGraph and friends) adds infrastructure this repo does not need: the nodes are git, node:test, worktrees and subagents already |
| D-2026-10-15-3 Environment credential probing | Probe failures are tracked per source, keyed by preset URL; a refused key still counts as a credential for `hasCredential`; an explicit reconnect clears the set | The single global failure gate let one rejected NVIDIA key silence the DashScope attempt behind it, and a DashScope-only 401 reported setup-required instead of the recorded failure; retrying on every poll would repeat requests against the same refused key |
| D-2026-10-15-4 A 200 whose entries all fail the shape filter | It stays the same `[]` as an endpoint that lists only embedding models: the operator-named model stands | After the filter runs, both arrive as `[]`, so any distinction would guess the provider's intent; the fallback serves only a name the operator typed, and a name the endpoint cannot serve fails on first use |
| D-2026-10-15-5 Manual review arm (judge ruling) | `TriggerState.manualReviewRequested: boolean`; `requestManualReview` sets manual only; `GateInput.manual` passes not-armed and skips only too-soon, keeping cooldown, in-flight, disabled and nothing-new; served at once when idle, otherwise armed; terminal outcomes clear, a held refusal stays | A new GateSurface duplicates the gate; reusing `pending` would claim the settled-turn threshold was reached, which is exactly what a manual arm has not happened; bypassing cooldown or the in-flight check could stack model calls |
| D-2026-10-15-6 Manual review arm (open items) | The `/harness review` confirmation is one dialog titled "REQUEST A HARNESS REVIEW?" naming spend, the still-applying checks, the running case and the approval gate; `harness.review.requested` carries only `{outcome:"armed"}` and is emitted only for the busy-arm case, an idle held refusal going through `harness.review` not-run; the note is the gate sentence for refusals | A separate busy screen would promise progress the gate can still refuse; a cooldown expiration on the event would restate state the operator cannot act on; a success-shaped note for a refusal would read as a review that happened |

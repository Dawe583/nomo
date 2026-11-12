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
| Parallel review lenses | `harness-runtime.ts` review runs K identical lenses (unanimous merge, `refinementLensCount` 1..3 default 1) | done: WP-LENSES, `c7054cd` + `61220be` |

## Work package queue

| WP      | Scope                                                                 | Status                                            |
| ------- | --------------------------------------------------------------------- | ------------------------------------------------- |
| WP-CATALOG | A provider without a model catalog (404 or empty) accepts the model the operator named; every other probe failure surfaces as itself | done: `aff5ee6`, VERIFY green (447/447 + tsc), skeptic findings 1+2 fixed, 3 refused (D-4), EVIDENCE landed |
| WP-MANUAL  | `/harness review` arms the trigger on demand: the missing caller the refine docblocks point at | done: contract frozen (D-5), open items settled (D-6); BUILD+VERIFY green (463/463 workbench, TUI 194/195 with the one pre-existing stderr-warning failure proven on `aff5ee6`); EVIDENCE in this commit |
| WP-MANUAL REVIEW | adversarial lenses over `7e79fe8` | done: resumed as part of the WP-MERGE REVIEW round over the merged surface (the manual-arm code is in that diff). The correctness and skeptic lenses attacked the D-5/D-6 contract: the contract itself held; the skeptic found two wiring defects (double-served concurrent requests, a refused no-provider request staying armed), both fixed and re-proven |
| WP-MERGE   | Land `feat/agent-harness` on `main`; merge (not rebase), `nomo-merger` | merger complete on `merge/origin-main-into-lane` (merge `53f8bef` + port `08bc041`, D-7). REVIEW round 2026-10-16: 4 parallel lenses over `git diff origin/main..HEAD`, correctness 0, security 0, truthfulness 7 findings, skeptic 2, plus 1 found during FIX (the merge had dropped 4 lane score tests). All 10 fixed: per-session boundary lock + join (D-8), no-provider refusal never arms, write-back merge, `/refine` legend removed and `/harness` legend completed, CHANGELOG wording restored, ruling-doc pointers re-pointed, guard alias tightened to real lookups, 4 score tests restored. Fresh verification: WB 487/487, TUI 233/234 (the 1 failure is the pre-existing SQLite stderr warning), control-plane 42/42, guard 12/12, tsc clean both. **LANDED 2026-10-16** on the operator's go: `origin/main` fast-forwarded to this branch's tip (the TUI lane gate was waived by the operator; the main checkout was left untouched, still dirty with the prime session's work) |
| WP-LENSES  | Parallel review lenses: the review step can run K identical reviews over one evidence packet and merge their verdicts; default 1 lens = today's behavior | done 2026-10-16: DESIGN (two proposals + judge ruling in `docs/superpowers/designs/`, D-9), BUILD (`c7054cd`), REVIEW (3 lenses over `c7054cd`: 7 findings, none major), FIX (`61220be`), re-VERIFY. Unanimity over K identical samples, `refinementLensCount` 1..3 default 1 (consumer `serveHarnessBoundary`), throw fails naming the lens. Cost honesty wording: one usage record per reply that reports usage (the untouched closure never invents one), pinned by a K=2 wiring test. VERIFY: WB 503/503, TUI 233/234 (the 1 failure is the pre-existing SQLite stderr warning), control-plane 42/42 (no surface change), tsc clean both. Build-time refinement (recorded): the frozen ran-note branch was built as the exported pure helper `reviewRanNote` so the exact string is testable inside the allowed files. Landed with the lane 2026-10-16 (`origin/main` fast-forwarded to this branch's tip) |
| WP-REGRESS | The mined-rule self-reinforcement loop from harness spec section 7: a denied learned hold must not count as fresh evidence for the same rule | done 2026-10-16: scout brief, DESIGN round (A minimal blast radius, B value first, judge ruling D-10), BUILD (tests T1-T6 first, then the shared-builder exclusion in `learned-rules.ts`), VERIFY (WB 517/517, workbench+cli tsc clean, TUI 233/234 the known pre-existing SQLite stderr warning, dash check clean), REVIEW (3 lenses: 0 major, 4 minor, all addressed: the test comment and graph brief stated the proxy-import premise wrong, the miner comment now records the writer-scope residual, the operator-copy limitation accepted as documented), re-VERIFY 517/517. On `feat/wp-regress` from `origin/main` @ 151b8cb |
| WP-GUARD    | Connector and stdio surfaces: deliberate asymmetry pinned by tests, honest kernel | done 2026-10-16: empirical finding that appended mined rules are UNREACHABLE through decide (catch-all last + first-match-wins + append after) reframed the WP. Builder implemented T1-T8 in packages/workbench/src/{learned-rules,connector,workbench}.test.ts plus a comment at index.ts:4402 and two TUI sentence fixes, WB 525/525, workbench+cli tsc clean, TUI 233/234 (one pre-existing SQLite stderr warning). Reviewed manually (rate limits): clean, with two recorded limits (T8 forged half not honestly drivable; only the positive receipt-shape half asserted). On `feat/wp-regress` @ 0953f10 |
| WP-ENV      | Control-plane env migration: NOMO-first via envValue, raw VOID fallbacks removed; no-dash gate expanded to exclude third-party dirs; binary stderr contract green (234/234) | done 2026-10-16: env alias fixes in apps/control-plane/api/server.ts, desktop tests green (53/53), no-dash gate now green across authored files, TUI suite 234/234. On `feat/wp-regress` |
| WP-DISPLAY  | Display-only host classification in toolCatalog (spec section 7 candidate, scouted directly; rate limits) | closed honestly 2026-10-16: scoping the candidate confirms that classifying a connector or stdio tool from name + read-only shape would display a PREVIEW class that can disagree with the execution-time classifyTool (which has the real tool facts in args), and `toolCatalog` legitimately carries only shape + description. Displaying `policy` (meaning: classified by your configured policy at execution time) stays the honest contract. No code change, D-13. Host security surface remains open owner decision. Skill drift is explicitly "neuvažováno" in the spec and has no code: deferred by deferring its definition, not by omission (a later requirement or pilot demand re-opens it) |

## WP-MERGE brief (the artifact the merger node consumes)

Rehearsal was run in a throwaway worktree on 2026-10-15, then aborted;
nothing here was written by guessing.

- **Geometry**: merge-base `b39a7b0`; 51 lane commits, 76 main commits;
  53 overlapping files, **49 conflicted**, 4 auto-merged.
- **Why merge, not rebase**: a rebase would replay the same 49-file
  surface 51 times; one merge resolves it once.
- **Main's harness core is the superseded cut.**
  `packages/workbench/src/{harness-scores.ts,harness-ranking.ts,learned-harness.ts,refine-pass.ts,harness-runtime.ts,refine-gate.ts,refine-trigger.ts}`
  on `origin/main` are **byte-identical** to `harness/settled-review-race`.
  The retired OMP superseded-cut note recorded that line's score contract
  forbade the verdict this lane required and its test said so on purpose.
  Resolution rule: **this lane's side for all seven modules and
  their tests**; `index.ts` evolved on the main side (TUI changes) and is
  merged per hunk.
- **File groups for the merger**:
  - Lane only: everything under `packages/workbench/src` not in the overlap
    list, plus `packages/cli/src/tui/workspace-harness-proposals.test.ts`
    and `harness-manual-review.test.ts`.
  - Main only (TUI upgrade): `brand.ts`, `live.ts`, `watch.ts`,
    `visual-states.test.ts`, and the untouched rest of the 163 main files.
  - Per-hunk: `workspace.ts`, `workspace.test.ts`,
    `workspace-harness-rows.test.ts`, `workspace-learned-rows.test.ts`,
    `workspace-parity.test.ts`, `workspace-controls.test.ts`,
    `workspace-approval.test.ts`, `workspace-settings.test.ts`,
    `workspace-mcp.test.ts`, `agent.ts`.
  - Do not port the settled-review-race harness tests; they assert the
    opposing contract by design.
- **Exit for the merge node**: `npx tsc -p packages/workbench/tsconfig.json
  --noEmit`, `npx tsc -p packages/cli/tsconfig.json --noEmit`,
  `node --test --test-concurrency=1 packages/workbench/src/*.test.ts`,
  `node --test --test-concurrency=1 packages/cli/src/tui/*.test.ts` (one
  node process at a time). The pre-existing `workspace-terminal` stderr
  warning failure is known and stays.
- **Gate**: landing on `main` is the HUMAN edge; prepare everything, ask
  before pushing to main.

## WP-REGRESS brief (frozen 2026-10-16)

Scout brief and a DESIGN round (designer A minimal blast radius, designer B
value first, judge ruling) ran over the self-reinforcement loop the harness
spec section 7 names: mined learned rules fire as real holds, a denied learned
hold writes a fresh refusal record, and the miner counts that record as fresh
evidence for the same rule, inflating `repeats` forever.

- **Frozen contract**: exclusion by template match inside the miner only.
  `learnedRuleRationale(repeats: number): string` becomes the single source of
  the writer text and the anchored matcher
  `/^Refused \d+ times on the signed ledger\. Not written by an operator\.$/`
  (N-agnostic, full anchor, substring quotes do not match). Detection walks
  raw `body.attribution.rule.rationale` only; the miner never calls
  `readLedgerReason`. `mineLearnedRules` keeps its signature; no new output
  fields; the rationale N renders the post-exclusion count.
- **Ambiguity table**: unattributed refusals count as evidence (the
  `syncStdio` proxy-import channel re-commits upstream bodies, which carry
  operator-policy attribution whose rationale is never the learned template,
  and is the only `hold:expired` source; starving it would be the wrong fail
  direction).
  Attribution present, rule absent: evidence. Non-object rule or non-string
  rationale: evidence. String rationale matching the template: not evidence.
  Operator text merely quoting the template: evidence.
- **Rejected**: the additive `attribution.rule.learned` marker (opens the
  strict-additive validator in `packages/ledger/src/attribution.ts` for zero
  loop-closure gain, and its write plumbing would thread an operator rule
  count into `sessionAttribution`); `ruleIndex >= operatorRuleCount`
  threading (positional, unstable between decide and mine); a separate
  self-caused bucket (API change for observability alone).
- **Files in play**: `packages/workbench/src/learned-rules.ts` and
  `learned-rules.test.ts` only. `packages/verifier` shares no attribution
  validator, so no verifier change. Forbidden: index.ts, packages/ledger,
  packages/policy, the main checkout, new dependencies.
- **Exit commands**: `npx tsc -p packages/workbench/tsconfig.json --noEmit`,
  `node --test packages/workbench/src/learned-rules.test.ts
  packages/workbench/src/learned-harness.test.ts`,
  `node --test --test-concurrency=1 packages/workbench/src/*.test.ts`.

## WP-GUARD brief (frozen 2026-10-16)

The scout found one real code asymmetry (connector path at index.ts:4402
uses loadPolicy and a RAW policy; workspace path uses policyWithLearned) plus
a test gap (a guard canary was deliberately refused earlier, CODING-TOOLS-MAP
Appendix 2). The judge's second-round scout of the facts produced a sharper
finding: the appended learned rules cannot ever fire, because validatePolicyFile
forces the terminal catch-all to be the last rule and decide is first-match-wins,
while policyWithLearned appends after it. So the wrap at 4402 would change
nothing and only churn connector digests. The WP therefore pins the deliberate
inertness and pins the guard with honest tests, without touching decide paths.

- **Frozen contract**: no code change in policyWithLearned or decide; index.ts
  gets only a comment at 4402 stating the reason. T1-T8 (listed in the WP-GUARD
  decision above) pin: terminal-catch-all inertness, connector decision
  continuity, raw-operator digest, unclassified fail-closed, stdio delegation
  recorded not decided, unverifiable proxy ledger -> unknown, stdio ignores
  learned rules, verified proxy denial surfaces / receiptless one does not.
- **Files in play**: packages/workbench/src/index.ts (comment only),
  learned-rules.test.ts, connector.test.ts, workbench.test.ts,
  packages/cli/src/tui/workspace.ts (two sentences).
- **Files governing**: docs/NOMO-AGENT-HARNESS-SPEC.md section 7,
  docs/CODING-TOOLS-MAP.md Appendix 2.
- **Inertness fact**: both proposals accepted it; decision: leave deliberate,
  do not make mined rules bind silently.
- **Exit commands**: node --test packages/workbench/src/connector.test.ts
  packages/workbench/src/workbench.test.ts packages/workbench/src/learned-rules.test.ts;
  npx tsc both; node --test --test-concurrency=1 packages/cli/src/tui/workspace*.test.ts.

## WP-LENSES brief (the artifact the designers consume)

Scout read `harness-runtime.ts`, `refine-gate.ts`, `refine-trigger.ts`,
`harness-settings.ts` and the `index.ts` wiring on 2026-10-16.

- **Goal**: `review()` in `harness-runtime.ts` runs exactly one model call
  today. WP-LENSES lets the review step run K independent lenses over the
  same evidence packet and merge their verdicts deterministically. K is an
  operator-tunable harness setting; **default K = 1 reproduces today's
  behavior exactly** (one ask, same prompt, same outcome vocabulary). The
  cost decision is the operator's: the WP adds the dial, it never turns it
  up.
- **Frozen constraints** (not open for redesign):
  - The cheap gate still runs first, once per round; a held gate costs zero
    provider requests and the manual-arm/cooldown semantics (D-5, D-8) are
    untouched.
  - Lenses live inside one boundary; the per-session boundary lock (D-8)
    stays the only concurrency gate.
  - The round outcome vocabulary (`ran|declined|failed|not-run`) and the
    ledger event shapes do not change.
  - Lens prompts are fixed strings in code, never operator text.
  - Cost honesty: K calls produce K usage records through the existing ask
    closure; a lens that never ran is never billed or claimed.
  - Failure direction: any ambiguity must fail toward NOT learning (the
    repo's stated bias).
  - No new dependencies; node:test only; the settings rule "a setting with
    no consumer does not exist" holds, including its consumer assertion in
    `harness-settings.test.ts`.
- **Open for the designers** (each proposal must decide all of these):
  1. What a lens is: K identical samples, K different fixed angles, or a
     proposer plus checkers.
  2. Merge policy and its fail direction: unanimity, any-approve, or
     first-approve in a fixed order; what happens when lenses disagree on
     the proposal text.
  3. Where the fan-out lives: `harness-runtime.ts` `review()` calling the
     injected `ask` K times, or the `ask` closure in `index.ts`.
  4. The setting: key, range, default, and which consumer file reads it
     (the consumerFile union in `harness-settings.ts` may need widening;
     say how).
  5. Per-lens failure: one lens erroring, timing out, or returning garbage
     JSON, round failed, retried, or degraded; and how the report says so.
  6. What the operator sees: how a multi-lens round reports which lens
     declined and why, without new event types.
- **Exit commands** (one `node --test` at a time):
  `npx tsc -p packages/workbench/tsconfig.json --noEmit`,
  `npx tsc -p packages/cli/tsconfig.json --noEmit`,
  `node --test --test-concurrency=1 packages/workbench/src/*.test.ts`,
  `node --test --test-concurrency=1 packages/cli/src/tui/*.test.ts`.
- **Files in play**: `packages/workbench/src/harness-runtime.ts`,
  `harness-settings.ts` and its test, `packages/workbench/src/index.ts`
  (wiring only), `packages/cli/src/tui/workspace.ts` only if the settings
  row needs it (the settings panel renders `harnessSettingsView` rows
  automatically). Forbidden: the main checkout, any new dependency, glm
  models, flipping the default.

## WP-LENSES review round (2026-10-16)

Three lenses over `c7054cd` (`git show c7054cd`): correctness, truthfulness,
skeptic. Seven findings, none major; every claim they could not reproduce
was refuted with observed output. Fixes in `61220be`:

- **S1** A branch move mid-round kept paying for lenses whose verdict the
  trigger discards. The loop now re-checks the branch before each lens after
  the first and stops; the post-review check still discards without
  stamping, so the round costs less and the fail direction is unchanged.
- **S2/C1** The ran note re-read the live setting, so a mid-round
  `patchHarnessSettings` made it name a count the round never billed. The
  count is now captured before the round awaits and threaded to the event
  log.
- **S3** The manual result note stayed bare while the event log named the
  count. Both surfaces now carry the same `reviewRanNote` sentence, and the
  in-flight map remembers the count so a joiner names it too.
- **S4** A decline reason carrying `; ` or a newline read as phantom lenses
  in the tally; parts are flattened before joining.
- **T1** The commit message's "K calls = K usage records" overstated the
  closure, which emits only `if (reply.usage)`. The honest line is one usage
  record per reply that reports usage, and a K=2 wiring test now pins two
  usage events through the real closure.
- **T2** One test name over-claimed what it pinned; renamed and given the
  provenance assertion.

Re-VERIFY after the fixes: WB 503/503, TUI 233/234 (the pre-existing SQLite
stderr warning), control-plane 42/42 (no surface change), tsc clean both.

## Decision log

| Decision | Choice | Rejected because |
| -------- | ------ | ---------------- |
| D-2026-10-15-1 Catalog-less providers | Fallback to the operator-named model only on HTTP 404 or an empty catalog; every other probe failure rethrows | Swallow-all hid a refused connection and a 401 behind "configured" (caught by the pinned logout test); merging the named model into a non-empty catalog would invent entries the provider never served |
| D-2026-10-15-2 The workstream graph itself | This file, updated at checkpoints | A framework (LangGraph and friends) adds infrastructure this repo does not need: the nodes are git, node:test, worktrees and subagents already |
| D-2026-10-15-3 Environment credential probing | Probe failures are tracked per source, keyed by preset URL; a refused key still counts as a credential for `hasCredential`; an explicit reconnect clears the set | The single global failure gate let one rejected NVIDIA key silence the DashScope attempt behind it, and a DashScope-only 401 reported setup-required instead of the recorded failure; retrying on every poll would repeat requests against the same refused key |
| D-2026-10-15-4 A 200 whose entries all fail the shape filter | It stays the same `[]` as an endpoint that lists only embedding models: the operator-named model stands | After the filter runs, both arrive as `[]`, so any distinction would guess the provider's intent; the fallback serves only a name the operator typed, and a name the endpoint cannot serve fails on first use |
| D-2026-10-15-5 Manual review arm (judge ruling) | `TriggerState.manualReviewRequested: boolean`; `requestManualReview` sets manual only; `GateInput.manual` passes not-armed and skips only too-soon, keeping cooldown, in-flight, disabled and nothing-new; served at once when idle, otherwise armed; terminal outcomes clear, a held refusal stays | A new GateSurface duplicates the gate; reusing `pending` would claim the settled-turn threshold was reached, which is exactly what a manual arm has not happened; bypassing cooldown or the in-flight check could stack model calls |
| D-2026-10-15-6 Manual review arm (open items) | The `/harness review` confirmation is one dialog titled "REQUEST A HARNESS REVIEW?" naming spend, the still-applying checks, the running case and the approval gate; `harness.review.requested` carries only `{outcome:"armed"}` and is emitted only for the busy-arm case, an idle held refusal going through `harness.review` not-run; the note is the gate sentence for refusals | A separate busy screen would promise progress the gate can still refuse; a cooldown expiration on the event would restate state the operator cannot act on; a success-shaped note for a refusal would read as a review that happened |
| D-2026-10-15-7 WP-MERGE strategy | One `git merge` of `origin/main` into the lane, never a rebase; the harness semantic core keeps this lane's contracts, only TUI-upgrade-only files take main's side, mixed files (`workspace.ts`, `workspace.test.ts`, `workspace-harness-rows.test.ts`) are decided per hunk by the merger node | A rebase replays 51 commits, each stopping on the same 49-file surface; main's harness core is byte-identical to the superseded `harness/settled-review-race` cut, whose tests assert the opposite contract (a verdict row is required here and forbidden there), so a symmetric merge would import tests whose stated job is to break this lane |
| D-2026-10-16-8 Concurrent manual reviews | One harness boundary per session at a time: a manual request that arrives while a round runs joins that round and reads its outcome (the joiner never writes); a settled turn landing mid-round joins too and its counted turn survives the write-back; a request refused for a missing provider never arms; the write-back merges a manual arm or settled count recorded during the round instead of overwriting it | Two concurrent requests raced the gate and paid twice for one intent (reproduced: 2 model calls), and `armed` would have lied about a request the running round was already answering; a refused request that stayed armed spent a model call on a later settled turn (reproduced); dropping a concurrent record silently breaks the busy-arm promise |
| D-2026-10-16-9 WP-LENSES merge rule | Unanimous K identical samples, throw-fails, range 1..3, consumer index.ts, default K=1 byte-identical; falsification experiment (measure the K=2 veto rate; near-zero leaves the dial at 1) | Any-approve inverts fail-toward-NOT-learning and leaves dissents decorative; fixed angles add unvalidated prompt surface with no measured buyer; degrade-to-decline masks provider failure; max 5 spends beyond the veto's value; widening the consumer union buys nothing |
| D-2026-10-16-10 WP-REGRESS self-cause detection | Template match on `attribution.rule.rationale` inside the miner, via one shared builder for writer and matcher; unattributed refusals still count as evidence; no format change, no API change | The additive `attribution.rule.learned` marker opens the strict ledger validator and threads an operator rule count through the write path for zero loop-closure gain, because the current writer set stamps every self-caused record with the template rationale; excluding unattributed refusals would starve the syncStdio proxy-import channel, the only source of `hold:expired`; a separate self-caused bucket changes the return shape for observability alone |

| D-2026-10-16-11 Mined rules never bind | The mined-rule append lives after the mandatory terminal catch-all, so a mined rule can never fire through decide; turning mined rules into binding decisions would be an owner semantics change against the MVP spec, not a guard fix | A placement before the catch-all would override an operator allow catch-all with a model-mined hold, which the index.ts comment deliberately forbids and which is a product decision outside this WP |
| D-2026-10-16-12 Connector/stdio guard asymmetry | Raw operator policy on connector, operator-plus-inert-mined on workspace, delegation-only on stdio; persisted digests stay honest, no cosmetic wrap | A wrap of policyWithLearned at index.ts:4402 changes no decision and only churns digests, so it is rejected; the canary on a host built on an operator-configured upstream is rejected as before (CODING-TOOLS-MAP Appendix 2) |

| D-2026-10-16-13 Display honesty over preview classification | `policy` stays the connector/stdio display class, with a comment stating the reason; the tool-browser can render unclassified ('?') for anything it cannot rank, and the real class evolves at execution against facts | A display-only preview based on name/shape would show a class that can disagree with the executed verdict, and a wrong class on a write tool is worse than the honest label that defers to execution |
| D-2026-10-16-14 Bind learned rules (WP-A) | Recorded as owner decision, decision: keep them evidence-only. The mined RULES (hold rules) never reach `decide` and stay appended after the terminal catch-all; the binding surface already exists elsewhere as LESSONS, which `harnessEntries` rebuilds into bounded same-workspace context and which cannot change `decide`, per Milestone C item 6. A placement that lets mined rules override an operator allow catch-all would be authority, not evidence, and is refused by the index.ts:4050-4053 contract | A request to bind them is fulfilled at the lesson level (lessons already injected as governed context), without converting mined holds into decisions, which would violate D-11 and the MVP spec Milestone C item 6 |
| D-2026-10-16-15 Host execution surface (WP-B) | Recorded as owner decision: deferred. Adding a model-callable shell/fs/git tool is a product-security decision (`packages/security-notes.md:12-14`, CODING-TOOLS-MAP.md Appendix 2 already refused the host-untouched canary), not a work package. No code added; toolCatalog keeps `policy` as the honest resolution for external surfaces; the MCP host for the model remains the prompt-only and stdio-delegation path | A gateway added without an operator-defined sandbox boundary reopens the question the work package system was designed to keep deferred |
| D-2026-10-16-16 Skill drift definition (WP-C) | Recorded as owner decision: undefined, and thereby not a work package. Global store is not a defined surface in this repository (no global store exists; profiles are workspace-scoped or operator=yaml); what drift would mean, across which boundary, is undefined. Decision deferred to requirement/pilot instead of silent implementation of drift that may then be the wrong shape | An implementation of undefined drift would at least have to invent a target store, which is a bigger claim than the item stating it |

| D-2026-10-16-17 Env alias migration | NOMO-first via envValue with VOID fallback for all remaining control-plane reads; redundant VOID fallbacks removed once envValue is in place | Direct VOID_* reads in the API path were a silent migration gap; the alias helper already exists in packages/ledger/src/env-compat.ts and auth.ts already used it |
| D-2026-10-17-18 Ledger SQL migrator is documented, not yet built | packages/ledger/README.md and DECISIONS.md section 2 describe the forward-only raw SQL DDL migrator with a digest table, but no migrator code exists in the tree yet; the item is recorded rather than fabricated | Adding a migration mechanism without the implementation would invent a surface with no exit command to verify |

| D-2026-10-17-19 Gate coverage closed over the two silent suites, keychain name kept | check-tests.mjs now runs the control-plane UI suite (123 tests) and apps/desktop (12 tests) that pnpm test never executed; the desktop gate demanded the warning name dev.nomo.desktop.workspace, but the Keychain service the app actually reads is dev.void.desktop.workspace and the migration rule forbids a silent rename of durable state, so the test now pins the real name | Renaming the Keychain service would strand every existing install's workspace key, exactly the failure the ad-hoc warning describes |

| D-2026-10-17-20 Correction to D-19, ui half | apps/control-plane bare node --test discovery already ran ui/src and the server rendered web suite: measured api top level 54 + api/companion 32 + ui 123 + web 21 = 230, the exact bare total, proven by the account paths are same-origin and extract prefers the record sitting inside the bare run at ok 71 and ok 89. The dedicated control-plane-ui suite entry therefore ran 123 of those tests twice per gate and double-counted them in the totals, so the entry is removed and this row records why it must not come back | A suite counted twice looks like 3044 covered tests when 2921 are real, and a reader re-adding the row would re-double it;
| D-2026-10-17-21 Design tests moved to Swift Testing, joined the gate | `apple:design:test` failed on the pinned toolchain (CLT 6.4 has no XCTest framework; measured: NomoDesignSystemTests/NomoContrastTests.swift unresolved XCTest compile error, `swift -xctest` absent) while the same toolchain ships Swift Testing, so the six suites in `apps/apple/NomoDesignSystem/Tests/NomoDesignSystemTests/` (31 tests, counted per file before and after) now import Testing (#expect, #require) and `swift test` is 31/31 in 7 suites in 6 s on CLT. The root gate gets a `swift/apple-design` suite with the module-resolution failure mapped to UNRUN rather than a lie; gate totals 2952 = 3044 minus the double-run ui 123 plus 31 | A root package.json script that always exits 1 is a product claim the tree contradicts; moving to Testing makes the design token measurements run where the operator works, and CompanionProtocolKit stays untouched because its recorded 34/34 evidence lines are a historical measurement, not a build script |

| D-2026-10-17-22 The Apple project check was dead since landing, now runs and the rename is complete | The 10-11 squash renamed the Apple app tree and check-apple-project.mjs constants to NOMO but left project.yml naming VOID, so the script generated VOID.xcodeproj and crashed on a raw ENOENT for NOMO.xcodeproj (reproduced before the fix: the crash named a scratch path and nothing else). project.yml now names NOMO with NOMOApp sources and NOMO usage strings while the bundle identifiers stay com.void.companion on purpose (durable device and store state is not renamed by a surface rename); the spec regenerates the committed NOMO.xcodeproj byte for byte (pbxproj diff empty, Info.plist identical, check green with the matrix's recorded message), the unreferenced VOID.xcodeproj, VOIDApp, VOIDTests and VOIDUITests copies are removed, and a spec versus artifact name mismatch now exits 1 with both sides named (verified by restoring the VOID spec against the emptied tree: named missing source directories, no stack) | A committed root script that always dies on a stack is a gate nobody can act on, and a half-finished rename with two parallel app trees is how the next agent rebuilds the wrong half; RELEASE-1.0.1-MATRIX already recorded project.yml as the source of truth and NOMO.xcodeproj as the generated artifact, so this repair makes the tree satisfy the recorded contract rather than change it |

| D-2026-10-17-23 The PTY regression joined the gate, and a document-undo shortcut it caught is fixed | `test:tui` was manual only, and it was dead: the 10-11 TUI upgrade left four of its markers stale and disabled the documents-tab undo shortcut with nothing watching. Measured before the fix: Enter on a documents row shows the inspector with documentPath unset (the inspect branch returns deliberately), so the footer hint "u undo" threw "Select a document with an outstanding change" and NO confirmation ever opened (repro: keypress log shows u processed with busy=false, notice rendered, no UNDO panel). Fixed in workspace.ts prepareUndo: a documents-tab selection is itself the undo target, so documentPath and the session derive from the selected row; the fix is covered by a new workspace-controls test (u from the list alone, UNDO undo.md?, confirm reverts to absent). The verifier's stale markers were refreshed against what the TUI actually renders (revision inspector field, the Undid transcript row for post-search close because the search filter keeps the YOU row visible, PROPERTIES for the schema panel that used to print INPUT SCHEMA) and its observer now dumps the last full frame for future failure reads. The verifier expected nomo_workspace_write but the executor registers void_workspace_write (workbench index.ts:2083, workspace.ts:28, managed-documents.ts:34), so the verifier now pins the code's registered identity and CODING-TOOLS-MAP.md plus the desktop smoke (src-tauri main.rs:332) still name nomo_: recorded as a named leak, an explicit versioned migration, not a silent rename. The verifier joined check-tests as script/tui-pty (8 PASS lines, UNRUN only for a python3/POSIX pty absence with the reason named), gate total 2968 in 21 suites | Leaving the regression manual is exactly the failure this row records: a manual command rots silently for six days; renaming the registered MCP tool surface inside a check would be a silent identity rename that strands existing agents, desks and desktop smokes pointed at the old name |
| D-2026-10-17-24 The desktop Rust tests joined the gate, prepared-tree absence named | `apps/desktop/src-tauri` carries 24 inline `#[test]` fns (keychain naming, diagnostics allowlist, runtime readiness) and no gate ever compiled them: cargo test failed at the Tauri build step with a bare "resource path `resources` doesn't exist" (reproduced), then on a missing icons/32x32.png inside `tauri::generate_context!` (also reproduced), because both the sidecar resources and the icon set are generated by `apps/desktop/scripts/prepare.mjs` and gitignored. Measured now: `pnpm --dir apps/desktop install --ignore-workspace && pnpm --dir apps/desktop run prepare:runtime` produces both (pinned sha256-verified Node 24.21.0 sidecar) and `cargo test` is 22 passed 0 failed on this machine. The new `scripts/src/check-desktop-rust.mjs` runs the real cargo test and prints one parseable line; it maps a missing cargo or an unprepared icon set to exit 0 UNRUN with the two setup commands named (verified by renaming icons away and back), creates only the empty resources directory the compile-time check requires, and sums every cargo `test result: N passed` line so later doc-tests add to the total honestly. It gates as script/desktop-rust with UNRUN only for toolchain or prepared-tree absence | Gating cargo unconditionally would red every fresh clone over generated artifacts the tree intentionally does not commit, which is the same lie as counting an absent suite as pass; leaving the 24 Rust tests manual would repeat the rot the PTY regression just proved |
| D-2026-10-17-25 CLT swiftbuild macro plugin flake bounded, no-dash scan excludes generated desktop artifacts | The first gate after the desktop-rust round failed twice with facts worth recording: (1) the no-dash scan flagged exactly one file, `apps/desktop/src-tauri/resources/runtime/backend.mjs`, an esbuild bundle this round created by running prepare.mjs for the first time on this checkout, whose bundled npm dependency comment carries an em dash no repository-authored source contains (tree-wide byte scan clean in apps sources), so the scan skip-list now names the two generated desktop dirs (resources, gen) and the never-authored .build/.cache directories; (2) `swift test` measured green, red, green, red, green over identical clean runs of apps/apple/NomoDesignSystem: the red runs compile every test file against a plugin server that never receives the TestingMacros plugin ("plugin for module 'TestingMacros' not found", zero tests execute), the deprecated `--build-system native` path cannot even import Testing (no such module, 3/3 deterministic red), `-j 1` stays flaky (1/1/0), and the complete string-scanned SWIFTPM environment list of the pinned CLT 6.4 toolchain carries no plugin server switch, so runSwiftSuite now re-runs at most 5 attempts after clearing .build, but only for a run that executed no tests at all and carries exactly the plugin-not-found signature; real test failures and real compile errors pass through unremarked and the last failing attempt's output is what the gate reports | A gate that fails on nondeterministic toolchain scheduling cannot be pushed or pulled honestly, while a retry that covered any run whose tests actually failed would be manufacturing green, so the trigger is the narrowest observable combination: duplication of effort in a bundle is the cost of keeping build artifacts out of the repository |

| D-2026-10-18-26 The swift flake retry trigger is gate-on-gate tested | The retry condition moved out of runSwiftSuite into `isSwiftMacroFlake` in check-tests-swift-result.mjs, the same module the gate-on-gate already tests the mapping from, and three new tests cover the retryable shape (plugin signature, no verdict, no tests run), the same signature after a real verdict (final, never retryable) and the ordinary-failure and timeout shapes (never retryable); 16 gate-on-gate tests pass, no gate behaviour changed | A retry whose trigger lives inline is the one D-25 branch a regression could delete without any test failing, and the house pattern is exactly that the mapping module carries the verdict so no test needs a compiler |
| D-2026-10-18-27 desktop:build verified end to end: release-only E0463 heals per crate, codesign duplicate resolved by hash | The first complete desktop:build run on any gate round measured three independent facts: (1) release-only `can't find crate for \`X\`` (E0463) on freshly written proc-macro dylibs (phf_macros 33bac, then derive_more_impl and zerofrom_derive, then tauri_macros fd59), each time with the artifact present and each time healed by `cargo clean --release -p <crate>` and a rebuild; a forced-clean rebuild is green and stays green, debug never fails, and a from-scratch `rm -rf target/release` full build (238 crates) was green, so the defect is a first-pass-in-a-mode artifact the toolchain then refuses to re-read, mechanism unidentified, reproduced with plain cargo (no tauri-cli involvement) via `cargo build --bins --features tauri/custom-protocol --release`; (2) after healing, cargo and link complete and NOMO.app assembles; (3) codesign then refused the keychain identity: this machine holds two valid Apple Development certificates sharing one name, and codesign rejects the ambiguous name outright, so build-policy.mjs now returns the SHA-1 (first listed) when a discovered name maps to several identities, source `keychain-hash`, one warning naming the duplicates, with tests over fabricated hashes and string-only fakes unchanged. Final measured evidence: desktop:build exit 0 producing NOMO.app plus NOMO_1.0.1_aarch64.dmg (42 MB), `codesign --verify --deep --strict` OK | An auto-healing wrapper is refused for now: build.mjs spawns tauri with stdio inherit, so the signature cannot be parsed without piping, and a self-healing loop whose mechanism is unidentified could mask real breakage; instead the README names the remedy where the operator hits it, and the codesign half is a policy defect with a code fix rather than a toolchain mystery |
| D-2026-10-18-28 Project execution (supersedes D-15 for this approved surface) | A project root is opt-in per TUI process and requires a visible operator confirmation before any file or skill content reaches the model. `nomo_project_exec` is available only to an explicitly configured custom profile, classified R3, and decided by that profile's existing policy/approval path. Commands run only through Docker/Podman in a one-shot container pinned by local image ID; network is disabled, the project is the only writable host mount, and resource/time/output bounds apply. Missing runtime/image refuses; never execute on the host. | A model-callable host shell without isolation crosses the deferred security boundary; a silent default root, network access, inherited host environment, or fallback would widen the capability beyond the operator-approved project. |
| D-2026-10-18-29 Workspace skill scope (supersedes D-16 definition) | Skills are read only from the selected project’s `.agents/skills/<id>/SKILL.md`, indexed by its root `skills-lock.json`, explicitly selected with `--skill`, and snapshotted for that session. SHA-256 drift is disclosed and requires the same explicit project confirmation; skill text is untrusted instruction context, never executable, and cannot change policy or tool allowlists. No global skill store. | A global store does not exist in NOMO; loading every skill silently or executing learned skill code would create unreviewed prompt and runtime authority. |

| D-2026-10-18-30 The desktop smoke verdict leaves through a direct exit | The three deciding paths (the 20s watchdog, the download verdict and the runtime-exit monitor) stop the sidecar and call std::process::exit(code) from the deciding thread, because AppHandle::exit(code) was measured to terminate the process inside the macOS run loop with 0 whatever the code was, so both release smokes and one debug smoke had printed the timeout text and exited 0, a false pass on a packaging-level check; after the fix the same hidden-window runs report exit 1 with the watchdog timing, 22 rust tests stay green, the release rebuild produces the bundle and dmg, and the visible --smoke-mobile run passes fully including the blob download reaching on_download, which isolates the hidden probe's remaining red to App Nap stalling the timers of a never-shown window, kept open in the coordination note until the probe is redesigned | A smoke that reports 0 on a verified failure verifies nothing forever, and the direct exit is house precedent from the --smoke-runtime-exit monitor that already worked this way |
| D-2026-10-18-31 Visible, provider-independent desktop smoke | The default `--smoke-test` opens a visible desktop-sized WebView, selects built-in `/plan`, verifies its prepared prompt and unclipped palette, then verifies the real Blob download. The hidden-window experiment proved synchronous eval by hash navigation, but App Nap prevented the timer-driven UI probe from progressing. The prior `/nomo_workspace_write` assertion was invalid for a fresh workspace with a rejected/unconfigured provider; `/plan` tests the local UI contract without a model call. If the run loop returns before the download verdict, smoke exits 1; `--smoke-mobile` retains mobile toolbar checks and `--smoke-runtime-exit` retains hidden lifecycle coverage. Verified: desktop smoke passed; desktop Rust tests 22/22; no new dependency. | NSActivity bindings add platform-specific machinery, and a timer-free Rust-driven DOM workflow duplicates UI logic; a visible smoke is the smallest path that exercises the real interface and download. |
| D-2026-10-18-32 Runtime-exit monitor has a process-level regression test | `apps/desktop/src-tauri/tests/runtime_exit_smoke.rs` launches the real binary with `--smoke-runtime-exit`, bounds the child to 20s, and requires both the monitor's fixed failure diagnostic and exit code 1; this rejects startup failures that also exit nonzero. `cargo test -- --test-threads=1`: 23 tests across unit and integration suites passed; the standalone smoke also reported the monitor sentinel and status 1. macOS-only because this is a native Tauri process test. | An in-process unit test cannot observe `std::process::exit`; a child-process test covers the actual monitor and process verdict without extracting a mockable copy of the branch. |
| D-2026-10-18-33 Blob origin lookalikes stay outside the local download allowlist | `downloads::allowed` compares parsed origin serialization. A regression test rejects `blob:http://127.0.0.1:4567@attacker.invalid/uuid` (userinfo authority trap) and `blob:http://127.0.0.1.evil:4567/uuid` (host suffix), while the existing test keeps exact local Blob and HTTP cases allowed. No production policy change or dependency. Focused edge test 1/1; desktop Rust gate 24/24. | An origin is structured authority, not a string prefix; these cases prevent accepting an attacker-controlled authority if a future edit weakens equality. |

## WP-PROJECT-CAPABILITIES brief (frozen 2026-10-18)

- **Authority**: the operator approved the project sandbox and workspace-only
  skill design in chat. This supersedes D-15/D-16 only for this bounded scope.
- **Goal**: a local coding session can inspect and modify one explicitly selected
  project through a bounded container command, and can attach only explicitly
  selected workspace skills to new sessions.
- **Project root**: `nomo tui --project PATH [--skill ID ...]`. Resolve and
  validate the directory before startup. An interactive confirmation names the
  canonical path, selected skills, and the fact that project files, tool
  arguments and results can be sent to the configured model and retained in
  local session history. No TTY/`--once` means no consent and no project tool.
  Consent is process-local and is never restored from saved state.
- **Sandbox**: `nomo_project_exec` has a closed JSON schema and is registered
  only after consent for a custom agent profile that explicitly allowlists it.
  Every call uses the existing R3 policy/approval/ledger path. The launcher
  uses a direct argv spawn, never a host shell; Docker/Podman is mandatory,
  image input is an immutable local `sha256:` image ID, and there is no
  host-execution fallback. Container constraints: network off, root filesystem
  read-only, only the selected project bind-mounted read-write, no host home,
  Docker socket, or host variables passed into the container; non-root user,
  CPU/memory/PID/time/output limits, bounded cleanup.
- **Workspace skills**: only IDs in the selected project's lock file can be
  named. Read the corresponding `.agents/<skillPath>` file with path/symlink
  containment and size bounds, compute SHA-256, disclose lock drift, and pass
  an immutable snapshot to the model only after project confirmation. Skills
  cannot execute code, add tools, or widen policy. No cross-project/global
  lookup. Existing `/compact` remains manual and makes no model call.
- **Data risk**: the operator chose whole-project visibility. A mounted project
  may contain secrets; the sandbox prevents direct host-path/network access but
  cannot prevent a command from printing a project file to the model or the
  session history. The confirmation must say this plainly; never pass host
  environment variables or mount host credentials.
- **Build order**: tests for skill lock/path/snapshot first; tests for command
  validation/process bounds and fail-closed runtime next; then Workbench policy,
  ledger, profile and TUI consent wiring; update the spec and changelog after
  smoke evidence. Keep Node checks sequential to cap CPU.
- **Exit**: focused new Workbench and CLI tests; `npx tsc -p
  packages/workbench/tsconfig.json --noEmit`; `npx tsc -p
  packages/cli/tsconfig.json --noEmit`; then
  `node --test --test-concurrency=1 packages/workbench/src/*.test.ts` and
  `node --test --test-concurrency=1 packages/cli/src/tui/*.test.ts`, one Node
  process at a time. Runtime smoke must exercise the actual container when a
  local image is available; if no image is available, record the exact blocker,
  never substitute a host shell.

- **Verification, 2026-10-18**: local Docker image
  `sha256:62973d3f02b0f031c8260837373f25d6c79da7ffce6ff066bbeec9b5a70169c6`
  built from `packages/workbench/sandbox/Dockerfile`; actual-container
  sandbox tests 4/4 and Workbench R3/ledger integration tests 2/2 passed.
  Workbench full suite: 550 passed, 0 failed, 2 gated runtime tests skipped;
  CLI TUI suite: 243 passed, 0 failed. Workbench and CLI typechecks exited 0.
  Tests ran one Node process at a time. The runtime CLI uses the operator's
  selected Docker/Podman context; NOMO pins the image ID and never pulls but
  does not independently attest the daemon endpoint, so configure a local
  engine context.

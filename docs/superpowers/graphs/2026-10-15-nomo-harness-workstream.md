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
  `docs/OMPHARNESS-SUPERSEDED-KUS7.md` rules that line superseded: its score
  contract forbids the verdict this lane requires and its test says so on
  purpose. Resolution rule: **this lane's side for all seven modules and
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
| D-2026-10-15-7 WP-MERGE strategy | One `git merge` of `origin/main` into the lane, never a rebase; the harness semantic core keeps this lane's contracts (`docs/OMPHARNESS-SUPERSEDED-KUS7.md` is the ruling), only TUI-upgrade-only files take main's side, mixed files (`workspace.ts`, `workspace.test.ts`, `workspace-harness-rows.test.ts`) are decided per hunk by the merger node | A rebase replays 51 commits, each stopping on the same 49-file surface; main's harness core is byte-identical to the superseded `harness/settled-review-race` cut, whose tests assert the opposite contract (a verdict row is required here and forbidden there), so a symmetric merge would import tests whose stated job is to break this lane |
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
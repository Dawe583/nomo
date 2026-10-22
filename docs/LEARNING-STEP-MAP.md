# Implementation map: the ledger-reading learning step

Todo item: *"after-tool hook mines recurring failures and promotes them to
signed, replayable policy rules"*.

This is a reconnaissance, not an implementation. Nothing here is wired. Every
line reference below was read on 2026-10-05; verify before trusting it.

## What already exists

| piece | where | state |
|---|---|---|
| Hook contract | `packages/workbench/src/agents.ts:13` | `event: before-run \| after-tool \| after-run`, `command: string` |
| Hook validation | `packages/workbench/src/agents.ts:75` | allowlist-gated, 5s timeout |
| Hook firing | `packages/workbench/src/index.ts:2451` | in the `finally` of `execute()`; cannot mask the tool outcome |
| Hook payload | `packages/workbench/src/index.ts:2454` | `{tool, decision, outcome, callId, workspace, runId}` |
| Signed chain | `packages/workbench/src/index.ts:2215` | `commitWorkspace`, single chokepoint, rolls back on persist failure |
| Chain entries | `packages/workbench/src/index.ts:2242` | body carries `tool`, `klass`, `decision`, `argsDigest`, `operationId` |
| Rule shape | `packages/policy/src/rules.ts:34` | `{match, decision, seconds?, notify?, rationale?}` |
| Decision | `packages/policy/src/decide.ts:163` | pure; iterates `policy.policy.rules` **in order** |
| Policy call site | `packages/workbench/src/index.ts:2481` | resolves the profile's policy; unresolvable denies |

`Rule.rationale` already exists and is documented as *"Why the rule exists,
shown in the hold message the model reads."* A learned rule's evidence belongs
there, and no new field is needed for provenance.

## What does not exist

There is no learning concept anywhere. `grep -rn "learning" packages/workbench/src`
returns nothing; `policy` has only `candidate` inside `packages/policy/src/approvals.ts:348`, which
is the hold queue and unrelated. The rule file is `{match, decision}` pairs
loaded from operator YAML. Everything below is new.

## Five decisions, in order

1. **What counts as a failure.** `decision` is a free string that already
   carries `execute:failed`, `deny:*`, `hold:denied`, `execute:unknown`,
   `proxy`, `mode:*`. `outcome` is separate. Decide whether "recurring failure"
   means the decision alone, the outcome alone, or the pair. `execute:unknown`
   is a *safety* outcome, not a model mistake, and probably should not teach a
   rule.

2. **What counts as recurring.** Over the whole chain is wrong — old resolved
   incidents stay in the chain forever. Needs a window: recent N entries, a time
   span, or a repeat count since the last promotion. Decide and write down which.

3. **Where a promoted rule lives.** `decide()` takes an immutable
   `LoadedPolicy`. Two options: append to the in-memory rule list, or write
   into the operator's YAML. In-memory loses durability; writing YAML mutates
   operator configuration behind their back. This is the decision that most
   affects the operator, and it should not be made silently.

4. **What "replayable" requires.** For replay to mean anything, the rule must be
   reconstructible from the signed chain alone. That means the ledger entry has
   to carry the whole `Rule`, and loading has to include a pass over the chain —
   which means `decide()` can no longer be pure over YAML alone.

5. **Rule precedence.** `decide()` takes the **first** matching rule. A learned
   rule appended after the operator's rules never fires for a tool the operator
   already matches; placed before, it can shadow deliberate operator intent.
   A learned rule is evidence, not authority, so it should not be allowed to
   override — but then it only ever fires in gaps, which is also where it is
   useful.

## The hook is the wrong place for this, today

Hooks are external processes allowlisted by the operator. The payload at
`packages/workbench/src/index.ts:2454` carries no `argsDigest`, no entry `hash`, and no ledger path, so
an external process cannot correlate anything across runs — it sees one event,
with no history and nothing to key on.

Either the learner is in-process (a method on `Workbench`, reading
`this.evidence[workspace]` directly), or the hook payload has to grow to carry
the ledger location and the entry digest. The first is simpler and is what the
"mines recurring failures" wording implies.

## Adjacent defect found while mapping this

`packages/workbench/src/index.ts:2308` calls `retainedSigner(join(homedir(), ".void",
"keys"))` with the operator's home hardcoded — it ignores `VOID_LEDGER_DIR`,
which line 2287 in the same function respects. `~/.void/keys/dev-ed25519.pkcs8`
exists on this machine, so any test that reaches the stdio branch reads real
signing key material, and `devKeyProvider` will create one if it is missing.
Whether that hardcoding is deliberate (the proxy's keys always live there) is
unresolved. Fix or document it before adding a code path that reads the chain.


## Implemented: provenance-bound mining (Milestone C, item 2)

`mineLearnedRules` now refuses any entry that does not carry harness provenance.
An entry is eligible only when its body has `source: "harness"`, `harness: true`,
or a non-empty `harnessRunId`. Mirrored stdio-proxy entries become eligible by
carrying `harnessRunId` naming the run they came from.

Self-injection is prevented in `policyWithLearned`: entries whose `runId` or
`harnessRunId` equals the current run id are excluded before mining, so a run
never teaches itself. `policyWithLearned` takes an optional `currentRunId`
third argument.

Each mined rule's rationale records the distinct harness run count that
produced the pattern, so an operator can see the provenance rather than a
bare repeat count.

Mutation check: removing the provenance gate in `isHarnessEvidence` makes the
eligibility tests fail, because entries without provenance no longer produce
rules.


## Implemented: review gate and subsequent-session retrieval (Milestone C, items 3 and 5)

`canProposeHarnessLearning` refuses while a harness run is in flight or before
the cooldown elapses. `proposeHarnessLearningGated` wraps proposal creation with
that gate.

`retrieveHarnessContext` rebuilds bounded context from activated proposals of
the same workspace, ranked deterministically, with token and entry budgets. It
excludes the producing run (no self-injection) and expired proposals. It returns
context only and never mutates policy or permissions.

`harnessEvaluation` reports counts and an explicitly unavailable
`firstPassRate`; no fabricated metric.

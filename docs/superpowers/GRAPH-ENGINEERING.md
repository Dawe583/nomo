# Graph engineering: the agreed execution model

This document defines the graph engineering method used for harness work in this
repository. Every node produces an artifact, every edge is conditional or
human, and the repository history is the canonical state. It is written in
English because it is a contract; operator-facing text stays in Czech as before.

## Why a graph, not a chain

A prompt chain hands the NEXT model the whole conversation; a graph hands a
node only its inputs, so no node carries authority it does not need. The state
lives in three places, in order of truth:

1. signed repo history (commits, determinism: byte-identical inputs -> outputs);
2. this graph's queue and reducer lives (`2026-10-15-nomo-harness-workstream.md`);
3. the coordination note.

A node that finds nothing still writes its artifact. Silence is not evidence.

## State schema

```ts
type State = {
  branch: string;            // current working branch
  base: string;              // origin/main head the branch was cut from
  queue: WorkPackage[];      // ranked candidate work packages (highest score first)
  inFlight: WorkPackage | null;  // exactly one BUILD at a time
  findings: Finding[];        // (file, line, claim, severity, repro)
  evidence: CommandOutput[];   // pasted real command output, never prose
  decisions: Decision[];      // D-YYYY-MM-DD-# appended only, never rewritten
  blocked: string[];          // gate<rfl:parameter name="er restrictions (HUMAN edge)
};
```

A single `State` snapshot is stored in the graph markdown at the top of each
work session. A subagent receives only its WP brief, never the whole state.

## Nodes

| Node      | Purpose                                          | Executor                         | Exit artifact                            |
| --------- | ------------------------------------------------ | -------------------------------- | ---------------------------------------- |
| SCOUT     | files, prerequisites, forbidden files, exit cmds  | `nomo-scout` or this session     | WP brief + exact commands                |
| DESIGN    | material decision: two proposals + judge         | two designer subagents + judge   | frozen contract + rejected alternatives  |
| FREEZE    | pin the contract into the WP brief before code   | this session                     | brief marked frozen                      |
| BUILD     | one writer per worktree, failing test first      | `nomo-builder` or this session   | red test -> green test                   |
| VERIFY    | run every exit command, capture real output      | `nomo-verify-runner` or this      | pasted command output                    |
| REVIEW    | adversarial lenses, parallel, default refuted    | `nomo-skeptic` and `nomo-review-*`<|start|> findings JSON `{file,line,severity,claim,repro,recommendation}` |
| FIX       | confirmed findings addressed, others refuted     | this session                     | diff plus rerun output                   |
| EVIDENCE  | commit, changelog, coordination note, graph      | this session or `nomo-docs`      | commit with trailer, note updated        |
| HUMAN     | durable decisions, merges, prompt-affecting edits | the operator                     | approval or refusal recorded             |
| DEFER     | honest "out of scope" record; closes a WP node  | this session                     | decision row + justification             |

Reducer: findings merge by `(file, line, claim)`, highest severity wins.
Decision rows append, never rewrite. Evidence appends, never edits.

## Edges

| Edge        | In this workstream                                             |
| ----------- | -------------------------------------------------------------- |
| Direct       | VERIFY passes -> REVIEW; REVIEW clean -> EVIDENCE              |
| Conditional  | REVIEW findings confirmed -> FIX; all refuted -> EVIDENCE with refutations |
| Parallel     | REVIEW lenses run in parallel; BUILD fans out only when WPs share nothing |
| Looping     | FIX -> VERIFY -> REVIEW, hard cap two review rounds, then DEFER or accept with recorded risk |
| Error        | rate limit or dead endpoint -> park node, resume later boundary; never fabricate the artifact |
| Human        | merges and prompt-affecting changes: operator decides            |
| Event        | `main` moves -> rebase checkpoint before INTEGRATE              |

## Reducers and single-source discipline

- One writer per worktree at a time.
- Imports inside packages keep `.ts` extensions.
- Assertions from `node:assert/strict`.
- No `enum`, `namespace`, parameter properties or dynamic imports inside the new packages.
- Dash characters forbidden: `—` and `–`.
- Comment earns its place by carrying a constraint, not a restatement of the line.

## Stopping and honesty rules

- The cheap gate runs before every model call.
- A work package that cannot name its exit command in the FREEZE artifact is
  not ready to BUILD. There is no BUILD without the command list.
- Two review rounds per work package boundary. A third would be repetition.
- Unattributed output (no paste, no command output, no repro) is not evidence.
- Two review findings that cannot be reproduced are refused with evidence, not
  accepted.

## Continuous work loop

The operator asked for uninterrupted work. In graph terms, that is a polling
loop over the queue, never over invented work:

```
while queue nonempty or main-moves:
    wp = queue.peek()
    run SCOUT(wp) -> brief
    if decision material: run DESIGN(wp) -> defer to operator if rejected
    run FREEZE(wp) -> commit brief
    run BUILD(wp) -> red then green
    run VERIFY(wp) -> run every exit command, paste output
    run REVIEW(wp) -> JSON findings or refutation report
    if findings: FIX -> VERIFY -> (looped REVIEW once more)
    run EVIDENCE(wp) -> commit, push, update coordination note, graph row
    if landing allowed: HUMAN merge -> main -> push
    queue.pop()
    if main moved: rebase checkpoint
```

The loop's halting condition is `queue empty AND no observable independent
defect`. When that holds, the graph halts honestly rather than prompting for
busywork.

## Review lenses used

- `nomo-review-correctness` (by construction)
- `nomo-review-truthfulness` (claim vs measured output)
- `nomo-review-protocol` (transport/state invariants)
- `nomo-review-performance` (perf)
- `nomo-review-security` (safety)
- `nomo-review-usability` (a11y/usage)
- `nomo-skeptic` (defaults to finding counterexamples; 12/12 in the last run
  was a clean result, not an empty one)

The minimum lens set per WP review is three: correctness, truthfulness, skeptic.
Security and performance are added when the diff touches the write path, ledger,
or transport. Usability is added when the diff touches a TUI or GUI surface.

## Skill and tool use

The graph does not replace skills or tools. It orchestrates them:

- Scout: `nomo-scout` + grep/glob/read.
- Build: `nomo-builder`, `nomo-tui-builder`, etc., depending on module.
- Verification: `nomo-verify-runner` plus exact exit commands.
- Knowledge: read the repo's `docs/superpowers/specs` and `docs/CONTEXT.md`
  first; web access is used to verify external facts *before* asserting them.
- Memory: timestamps are not authoritative; commit hashes and pasted test
  output are.

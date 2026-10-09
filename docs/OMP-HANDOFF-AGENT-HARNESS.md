# OMP Session Handoff — Agent Harness (2026-10-07)

> **Superseded 2026-10-09.** Kus 6 (chain integration) and kus 7 (TUI score
> row) landed on the main checkout, branch `harness/settled-review-race`:
> `f939ca8` wires retrieval, signed proposal persistence and operator review
> (`pendingProposals`, digest-bound `approveHarnessProposal`,
> `rejectHarnessProposal`, TUI proposal rows and `/refine approve|reject`),
> and `30d4583` closes the silent review paths and arms the trigger on
> compaction. The TUI ledger tab carries `harness-score-rows.ts`
> (score, CI, case count) and `harness-proposal-rows.ts` (pending diffs).
> Workbench suite: 421/421 green, typecheck clean. The live tracking
> document is `docs/superpowers/plans/2026-10-08-nomo-agent-harness.md`.
> Kus 8 is decided by the implementation spec, rule 9: skill and subagent
> edits stay proposal-only; `refineHarness` refuses them. Everything below
> describes the old `feat/agent-harness` worktree and is historical.

Written by the omp session on 2026-10-07. For whoever picks this tree up next.

Read `docs/NOMO-AGENT-HARNESS-SPEC.md` first — that holds the frozen contract. This file is the state of the `feat/agent-harness` worktree and what is still open.

---

## Where the tree is right now

**Worktree:** `/Users/dawe/Developer/Claude-Projects/NOMO/.worktrees/agent-harness`  
**Branch:** `feat/agent-harness` (cut from `b39a7b0`, before the VOID→NOMO rename)  
**Head:** `01b7b6b` — "Model the refinement pass: parse, validate, apply with operator approval for prompt edits"

The `main` branch is **dirty with ~771 uncommitted changes** from the VOID→NOMO rename and a second OpenCode session may be active there. **Do not touch `main`.** All work stays in the worktree. Merge/rebase is blocked until the rename lands on `main`.

---

## What this session delivered — the Agent Harness (kus 1–5)

Five commits on `feat/agent-harness`, each with its own test file. All typecheck clean, all tests pass.

| Commit | Module | What it does | Tests |
|--------|--------|--------------|-------|
| `0c5d656` | `harness-scores.ts` | Case-mean 95% CI (Student-t table), `unmeasured` bucket, guardrails (`minSamples`, `maxCIWidth`, `maxFailureRate`), `ScoreBoard` | 27 |
| `4d58fe9` | `learned-harness.ts` | Mine approvals + refusals + classification drift → lessons/rules, provenance from chain, `HARNESS_KINDS: rule|lesson`, threshold=5, driftMin=2 | 22 |
| `4234acd` | `refine-gate.ts`, `refine-trigger.ts` | Cheap gate before model call (defaults: 25 turns, 20 min cooldown), cooldown on failure too, live branch invalidation via `currentBranchVersion` | 37 |
| `87d2b28` | `harness-ranking.ts` | IDF relevance ranking, field weights, prompt terms weighted > ledger terms, deterministic tie-break | 27 |
| `01b7b6b` | `refine-pass.ts` | **Model refinement pass**: JSON parse (bare/fenced/prose/truncated/malformed), validation, in-memory apply. **Key invariants:** empty `edits: []` = valid no-op; `kind: "prompt"` edits withheld in `awaitingApproval` (operator approval required — fail-closed). | 33 |

**Total workbench suite:** **180 passing, 0 failing**  
**Typecheck:** `npx tsc -p packages/workbench/tsconfig.json` → clean

---

## The three non-negotiable invariants in the code

1. **Only the signed chain is truth.** Files are cache. `learned-harness.ts` and `refine-pass.ts` both demand `derivedFromSeq` on every edit.
2. **Prompt addendum = operator approval only.** `applyProposal` **withholds** `kind: "prompt"` edits in `awaitingApproval`. A caller that forgets the check still cannot change the prompt. `promptEdits(proposal)` exists for pre-flight inspection; it must agree with `awaitingApproval`.
3. **Scoring never enters `decide`.** Learned rules are `hold` only, appended after operator rules, provenance mandatory. `learned-rules.ts` enforces this.

---

## Model budget — the gate is the only expensive call

| Layer | Model call? | Notes |
|-------|-------------|-------|
| Scoring (`harness-scores`) | **No** | Pure statistics on chain |
| Mining (`learned-harness`) | **No** | Deterministic over chain |
| Gate (`refine-gate`) | **No** | Cheap heuristic |
| Trigger (`refine-trigger`) | **No** | Scheduler only |
| Ranking (`harness-ranking`) | **No** | IDF over local corpus |
| **Refinement (`refine-pass`)** | **Yes** | Only here. Paid for by gate. |

---

## What is NOT in this worktree (and why it matters)

| Artifact | Location | Status |
|----------|----------|--------|
| `NOMO-AGENT-HARNESS-SPEC.md` | `main` (untracked) | **Not in worktree** — cut from `b39a7b0` before spec existed. Copy/cherry-pick after `main` rename lands. |
| `CHANGELOG.md` entry for spec | `main` (modified) | Same — not in worktree. |
| VOID→NOMO rename | `main` only | Worktree still uses `@void/*` and `void.mjs`. Rebase needed after rename commits. |

---

## Full TODO — everything still open

### Kus 6–7 (immediate next in this worktree)

- [ ] **Kus 6: Chain integration** — wire `refine-pass` output through `commitWorkspace`. Prompt edits must carry operator approval (signature) before they enter the chain. Learned rules stay `hold`, appended last. Nothing here reaches `decide` without operator precedence.
- [ ] **Kus 7: TUI score row** — surface the harness score, CI, and sample count on the TUI ledger tab. Reuse `harness-scores.ts` output.
- [ ] **Kus 8 (optional): Skill/subagent kinds** — `RefinementKind` includes `skill`, `subagent`, `prompt` but `HarnessEntry.kind` is only `rule|lesson`. Decide whether to extend the schema or keep Kus 5 proposal-only until chain integration.

### R11 — Staged hold and cancel (from `REVERSE-TOOL-UPGRADE-PLAN.md`)

- [ ] Provisional-receipt path behind explicit opt-in, keeping blocking hold as default. Zero code exists today. (`OPEN-WORK-AUDIT.md` row 26)

### A2, A3 — Apple apps (from `APPLE-APPS-PLAN.md`)

- [ ] **A2:** SwiftUI macOS client — "not started"
- [ ] **A3:** iOS local recovery core — "not started" (deferred design)

### Issue #96 — Hooks editor and per-agent profile panel on ledger tab

- `/hook`, `/hooks`, `/hook-file` exist in `workspace.ts` but no interactive field or tab branch. Filed for outside contribution.

### Issue #97 — 63 unmerged branches

- Dump at `/tmp/nomo-branch-dump-2026-10-05.txt` (84 refs). Filed for outside contribution.

### `PLAN-STATUS.md` open rows (selected, W = writable code)

| WP/R | Item | Class | What done looks like |
|------|------|-------|----------------------|
| R11 | Staged hold | **W** | Provisional receipt path, blocking hold default |
| R09 | GitHub/Vercel recovery | **W/X** | OAuth + executable recovery |
| R08 | S3/Supabase managed | **W/X** | Real version semantics + disposable services |
| R06 | Cross-host fencing | **W** | Lease fences beyond one host |
| R05 | Git remote recovery | **W/X** | Never force-push; recovery PR with inverse |
| WP-09b | TUI depth | **W** | Sibling lane owns; `nomo tui --help` works |
| WP-15 | Release hardening | **W/X** | Publish CI, artifact, signing, KMS |
| A2 | SwiftUI macOS | **X** | Architecture decision not to execute both |
| A3 | iOS recovery core | **X** | Deferred design |

### `OPEN-WORK-AUDIT.md` writable-code items (13 pure W, 11 W+gate, 7 W+decision)

Top concentration (the largest writable block):
- **R10 server budget ledger wiring** (row 22) — `serverBudgetLedger` has zero production consumers; lock contention reverted once; safe shape known.
- **Planner selectors** (row 23) — dependency/time/checkpoint selection, independent branches, cloud MCP jobs, cross-host fencing.
- **Universal provenance** (row 24) — `readSet`/`writeSet`/`revision` for every adapter at dispatch.
- **Legacy taint → R06 planner** (row 25) — separate graph from provenance; inspection-only feeds recovery ordering.
- **Staged hold** (row 26) — R11, provisional receipt.
- **Cloud budgets** (row 27) — server-side ledger with same reservation semantics.
- **Postgres capability profile** (row 28) — adapter exists, gate refuses release without profile.
- **Managed Postgres real-server cert** (row 36) — needs disposable isolated Postgres + network fault harness.

Decisions that gate large blocks:
- **Item 6** (phone write scope) — `DECISIONS.md` says read-only, but matrix P07 assumes write. Resolved: stays read-only, write is opt-in.
- **Item 16** (NVIDIA hardcoded default) — `provider-defaults.ts:2` makes one vendor default; matrix says operator choice. **Needs decision.**
- **Item 21** (certification) — `DECISIONS.md` says `certification: false` permanent; schema refuses bare `certification: true`.

---

## Verification state (measured in this session)

| Command | Result |
|---------|--------|
| `npx tsc -p packages/workbench/tsconfig.json` | **clean** |
| `node --test packages/workbench/src/harness-*.test.ts packages/workbench/src/refine-*.test.ts packages/workbench/src/learned-*.test.ts` | **180 pass, 0 fail** |
| `node --test packages/workbench/src/refine-pass.test.ts` | **33 pass, 0 fail** |
| `git status --short` (worktree) | clean except the two committed files |

---

## Commands to run on pickup

```bash
cd /Users/dawe/Developer/Claude-Projects/NOMO/.worktrees/agent-harness

# Verify the tree is still green
npx tsc -p packages/workbench/tsconfig.json
node --test packages/workbench/src/harness-*.test.ts packages/workbench/src/refine-*.test.ts packages/workbench/src/learned-*.test.ts

# Check git state
git status --short
git log --oneline -5
```

---

## Key files to know (worktree)

| Path | Role |
|------|------|
| `packages/workbench/src/harness-scores.ts` | Scoring, CI, guardrails, `ScoreBoard` |
| `packages/workbench/src/learned-harness.ts` | Mining approvals/refusals/drift → lessons/rules |
| `packages/workbench/src/refine-gate.ts` | Cheap gate before model |
| `packages/workbench/src/refine-trigger.ts` | Cooldown, branch invalidation, review round lifecycle |
| `packages/workbench/src/harness-ranking.ts` | IDF relevance ranking for prompt context |
| `packages/workbench/src/refine-pass.ts` | **Model refinement pass** — parse, validate, apply with `awaitingApproval` |
| `packages/workbench/src/refine-pass.test.ts` | 33 tests covering parse/validation/apply invariants |
| `packages/workbench/src/learned-rules.ts` | Invariant: `hold` only, appended last, provenance mandatory |
| `packages/workbench/src/index.ts` | `commitWorkspace` integration point (line ~2642) |

---

## Upstream references (studied, not vendored)

| Repo | Path | What we took |
|------|------|--------------|
| `omp` | `/Users/dawe/Developer/upstream/omp-src` | `ratchet/ratchet.ts` (CI/guardrails), `memory.md` (autolearn), `learn.ts` (skill management) |
| `prime-agent` | `/Users/dawe/Developer/upstream/prime-src` | `refinement/planner.rs` (JSON parse/validate), `auto_refine_trigger.rs` (gate/cooldown), `ranking.rs` (IDF), `semantic_edges.rs` |

**Licence note:** OMP is MIT, Prime is Apache-2.0. NOMO consumes **no code** from either — only mechanisms via the narrow surfaces above. The spec records the exact mapping.

---

## Repo rules (not negotiable)

- **Never `git add .` or `git add -A`.** Stage by name. Two agents editing one file cannot commit without sweeping each other — this is a tooling limit.
- **Branch per change, never work on `main`.** Cut from `origin/main`, push branch, open PR, merge.
- **Read a file completely before editing.** Range reading produced a raw NUL byte once (`ea0108d`).
- **Anchors that insert inside a neighbouring block** — verify surrounding structure after edit.
- **No wiring/copy/mock/echo tests.** A test must fail when the property it protects is removed.

---

## What I got wrong this session (so it isn't repeated)

1. **Assumed the test file matched the source.** The first `refine-pass.test.ts` was written against a discarded API (`REFINEMENT_INSTRUCTIONS`, `buildRefineRequest`, `EditableKind`). Always `grep` exports before writing tests.
2. **Missed the `blankEdit` dead code** after changing empty-edits semantics. Typecheck caught it; remove unused helpers immediately.
3. **Didn't enforce prompt approval in `applyProposal` initially.** The first version applied all edits. The user's decision ("prompt addendum only after operator approval") required the `awaitingApproval` design — fail-closed at the apply site, not the caller.

---

## Next session: suggested first moves

1. **Verify the worktree is still green** (commands above).
2. **Kus 6 — chain integration:** Open `packages/workbench/src/index.ts` at `commitWorkspace`. The harness entries produced by `applyProposal` need to be written as signed chain records. Prompt edits from `awaitingApproval` must carry an operator signature before they enter the chain. Learned rules (`hold`) append after operator rules.
3. **Kus 7 — TUI row:** Add a score/CI row to the ledger tab using `harness-scores.ts` output.
4. **Decide Kus 8 (skill/subagent kinds)** before chain integration if the schema needs to grow.

---

## Contact / questions

This handoff is the state of the `feat/agent-harness` worktree as of 2026-10-07. The `main` branch is a separate conversation — do not mix them. All model calls are rate-limited; the harness is designed to learn without them except at the explicit refinement pass.

**Model constraint for this project:** Only Nemotron 3.5 Lightning Free available. No subagents, no other models, no API calls beyond what the code already does.
---
name: nomo-loops
description: Run NOMO engineering as bounded, evidence producing loops over one active task graph. Use for every NOMO task, continuation or handoff.
---

# NOMO loop protocol

## Begin

1. Read `AGENTS.local.md`, the NOMO context pack, and Obsidian `00 Start Here/NOMO Start Here.md` plus `01 Governance and Memory/NOMO Memory Rules.md`.
2. Inspect current Git state and active sessions. Never overwrite existing work or infer that another session is idle from stale notes.
3. Select the request's existing graph node and task-owned worktree. An unrelated active graph protects only its own node and paths; locate the request's assigned worktree instead of stopping or taking over the foreign node. If no graph exists for this small request, use one in-context node. For larger work, create one concise graph in the designated task worktree. Do not duplicate an active plan.
4. Run `scripts/nomo-wt.sh list`. Reuse the task-owned worktree or create/switch to one with Worktrunk before editing when safe. Preserve dirty shared context when isolation would lose task-owned changes.
5. State the goal, in scope paths, protected paths, acceptance evidence and verifier before editing.

## Execute one loop

`DISCOVER -> SPECIFY -> CHANGE -> VERIFY -> REVIEW -> RECORD`

- Discover using Graphify and validated Understand Anything where useful, then confirm conclusions against contracts, source and tests.
- Specify one expected behavior and one minimal slice. For behavior changes, use test first and establish a failing regression test.
- Change only owned paths. Preserve foreign dirty changes and use an isolated worktree for code changes when possible.
- Verify focused tests first, then required typecheck, full relevant suite, formatting, security and diff checks. Use one heavy test process at a time.
- Review the resulting diff and evidence. A successful command must be observed, not assumed.
- Record node state, exact commands and outcomes, files changed, known limitations, and the next node in the repository task graph; append verified milestone evidence to `08 Work Log/NOMO Work Log.md`.

## Stop rules

Stop after one targeted repair attempt if a gate fails again. Diagnose before retrying. Stop for dirty ownership conflict, secrets exposure risk, conflicting source authority, external account effect, unavailable permission, or a decision requiring user judgment. Mark the node blocked with evidence; continue only independent safe nodes. If no authorized node is ready, report the concrete blocker once and wait for new evidence or user input; do not repeat the same discovery or blocker response.

## Autonomous improvement

- When no requested implementation is ready, review current roadmap, issues and verified evidence. Present ranked product options and their tradeoffs for the user to choose; do not silently select a new product direction.
- Reconcile any external action with an uncertain result before retrying. Never retry a possibly dispatched action merely because it timed out.
- Do not remove, weaken or bypass a failed gate to make a run green. Diagnose it and record the evidence.
- Improve skills or workflows only from observed failures, explicit feedback or evaluation evidence. Keep improvement separate from execution and approval.
- A prompt cannot schedule work or enforce permissions. Use an authorized running harness or scheduler for future runs, and verify its real runtime restrictions.

## Completion

A node is done only when acceptance criteria pass and its evidence is recorded. The request is done only when all required graph nodes are done, relevant tests pass, no unreviewed diff remains, and the handoff says what was not verified. Never commit, push, merge, deploy or close a project goal without explicit scope permission.

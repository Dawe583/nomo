---
name: nomo-loops
description: Run NOMO engineering as bounded, evidence producing loops over one active task graph. Use for every NOMO task, continuation or handoff.
---

# NOMO loop protocol

## Begin

1. Read `AGENTS.local.md`, the NOMO context pack, and the relevant Obsidian project memory.
2. Inspect current Git state and active sessions. Never overwrite existing work or infer that another session is idle from stale notes.
3. Select the existing active graph node. If no graph exists, create one concise work graph with dependencies, owner, scope, evidence and stop conditions. Do not duplicate an active plan.
4. State the goal, in scope paths, protected paths, acceptance evidence and verifier before editing.

## Execute one loop

`DISCOVER -> SPECIFY -> CHANGE -> VERIFY -> REVIEW -> RECORD`

- Discover using Graphify and validated Understand Anything where useful, then confirm conclusions against contracts, source and tests.
- Specify one expected behavior and one minimal slice. For behavior changes, use test first and establish a failing regression test.
- Change only owned paths. Preserve foreign dirty changes and use an isolated worktree for code changes when possible.
- Verify focused tests first, then required typecheck, full relevant suite, formatting, security and diff checks. Use one heavy test process at a time.
- Review the resulting diff and evidence. A successful command must be observed, not assumed.
- Record node state, exact commands and outcomes, files changed, known limitations, and the next safe node in the Obsidian work log.

## Stop rules

Stop after one targeted repair attempt if a gate fails again. Diagnose before retrying. Stop for dirty ownership conflict, secrets exposure risk, conflicting source authority, external account effect, unavailable permission, or a decision requiring user judgment. Mark the node blocked with evidence; continue only independent safe nodes.

## Completion

A node is done only when acceptance criteria pass and its evidence is recorded. The request is done only when all required graph nodes are done, relevant tests pass, no unreviewed diff remains, and the handoff says what was not verified. Never commit, push, merge, deploy or close a project goal without explicit scope permission.

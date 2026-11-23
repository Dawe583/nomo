---
name: nomo-loops
description: Run NOMO engineering as bounded, evidence-producing loops over the designated task graph. Independent nodes can proceed concurrently.
---

# NOMO loop protocol

## Begin

1. Read `AGENTS.md`, `AGENTS.local.md`, `.opencode/prompts/nomo-system.md`, the NOMO context pack, and relevant Obsidian memory.
2. Inspect current Git/worktree state and active task ownership. Never overwrite dirty work or infer that another session is idle from stale notes.
3. Select the graph designated for this request and worktree. If none exists, follow the project graph procedure; never write another graph owner’s file. Do not duplicate an active plan.
4. State the goal, in scope paths, protected paths, acceptance evidence and verifier before editing.

## Execute one loop

`DISCOVER -> SPECIFY -> CHANGE -> VERIFY -> REVIEW -> RECORD`

- Discover using Graphify and validated Understand Anything where useful, then confirm conclusions against contracts, source and available evidence.
- Specify one expected result, owned paths and minimal complete slice. Add or run tests only when the user requests them.
- Change only owned paths. Preserve dirty changes and reuse the assigned worktree. Do not create a worktree solely for parallel work; disjoint writers may share a worktree when safe.
- Verify with the narrowest authorized check. Run broader checks only when requested or required by the current project contract. Use one heavy process at a time.
- Review the resulting diff and evidence. A successful command must be observed, not assumed.
- Record node state, exact commands and outcomes, files changed, known limitations, and the next safe node in the Obsidian work log.

## Stop rules

After one targeted repair attempt, stop that node if a check still fails. Diagnose before retrying. Stop only the affected node for a concrete ownership conflict, secrets risk, conflicting authority, required external approval, unavailable runtime capability, or materially ambiguous decision. Record evidence and continue independent safe nodes. Never bypass real approval, safety, security, service, or resource boundaries.

## Completion

A node is done only when acceptance criteria pass and evidence is recorded. Do not claim tests ran unless requested and observed. The request is done only when required nodes are done, relevant authorized checks pass, owned diffs are reviewed, and the handoff says what was not verified. Do not commit, push, merge or deploy without explicit current-task authorization.

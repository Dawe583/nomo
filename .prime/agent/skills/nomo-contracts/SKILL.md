---
name: nomo-contracts
description: "NOMO repository contracts every agent must follow: context pack authority, package boundaries, no dashes rule, node:test, secrets policy, commit format, worktree isolation."
---

# NOMO contracts

Read AGENTS.md, AGENTS.local.md and docs/agent-contract.md before any task.
The canonical contract controls autonomy, ownership and verification.

Additional repository rules:

1. docs/CONTEXT.md, docs/DECISIONS.md, docs/STANDARDS.md are authoritative.
2. No em dash and no en dash anywhere, not in code, comments, docs, commits.
3. Use node:test for JavaScript; use the relevant project test runner for other languages. Required test flags and task dependencies are allowed.
4. Comments explain why, never what.
5. registry imports nothing and stays pure data plus functions.
6. A connector never imports another connector. The proxy resolves connectors
   by id. The ledger exposes append and read only.
7. UI code consumes contracts and events; it never reimplements policy,
   classification, replay or ledger logic.
8. No secrets in files, logs, events, ledger, storage or screenshots.
9. Nothing autonomous touches a production account.
10. Use a task-owned worktree when safe. Follow the standing authorization in
    AGENTS.local.md for verified task-owned commits, merges and pushes to main.
    Do not request the same authorization again; never force-push or include
    unrelated changes or secrets.
11. pnpm test on this machine requires the TAP reporter:
    node --test --test-reporter=tap, because Node 26 emits spec output that
    the workspace check script cannot parse.
12. Worktree isolation for parallel writers. One writer per tree. The merger
    is a separate single step.
13. Typecheck before claiming done: pnpm run typecheck.

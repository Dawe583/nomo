Plan: docs/superpowers/plans/2026-09-15-managed-git-commit-recovery.md
Base: 0888a511b67d1effc22b019319c2d6a3aba9bd44
Design commits: d87c25c, a6b2848

Task 1: complete
- RED: `node --test packages/connectors/src/git/managed-commit.test.ts packages/connectors/src/git/managed.test.ts` exited 1. The commit input test failed with `Unsupported Git action.` while 26 existing tests passed and 1 Windows test skipped.
- GREEN typecheck: `pnpm --filter @void/connectors run typecheck` exited 0.
- GREEN tests: `node --test packages/connectors/src/git/managed-commit.test.ts packages/connectors/src/git/managed.test.ts` exited 0 with 27 passed and 1 Windows test skipped.
Task 2: pending
Task 3: pending
Task 4: pending
Task 5: pending
Task 6: pending
Task 7: pending
Task 8: pending
Task 9: pending
Task 10: pending

Rulings:
- One persistent writer executes tightly coupled Tasks 1 through 10 because the user limits subagents to two and the commit lifecycle shares one evolving implementation.
- A separate read-only reviewer gates major checkpoints and the final branch.

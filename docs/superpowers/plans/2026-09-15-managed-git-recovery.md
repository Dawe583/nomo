# Managed Git Recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** Deliver the POSIX-only structured `git.managed` adapter described in the approved design.

**Architecture:** Reuse `RecoveryAdapter`, runtime journal, encrypted vault, CLI and MCP recovery surfaces. Keep each operation on one atomic Git surface. Use native filesystem primitives for worktree state and fixed Git plumbing for index state.

**Tech Stack:** TypeScript, Node standard library, Git CLI plumbing, node:test, existing NOMO runtime and CLI.

**Spec:** `docs/superpowers/specs/2026-09-15-managed-git-recovery-design.md`

## Global Constraints

- No em dash or en dash in changed files.
- No dependencies, shell evaluation, remote access, secrets or production accounts.
- Tests are written and observed failing before production code.
- Adapter version is `1`; public ID is `git.managed`.
- POSIX only. Windows refuses before mutation.
- Preserve unrelated worktree and index state exactly.
- Commit and remote recovery stay out of scope.

---

### Task 1: Git state reader and input boundary

**Files:**
- Create: `packages/connectors/src/git/managed.ts`
- Create: `packages/connectors/src/git/managed.test.ts`

**Interfaces:**
- Produces: `managedGitAdapter({ root, cooperative: true })`
- Consumes: existing `RecoveryAdapter` contract

- [ ] Write tests for repository validation, canonical paths, HEAD, index entry,
  worktree bytes/mode and all refused repository states.
- [ ] Run the focused test and confirm failures are caused by the missing adapter.
- [ ] Implement bounded fixed-argument Git execution and state capture.
- [ ] Run connector typecheck and focused tests.

### Task 2: Worktree mutation lifecycle

**Files:**
- Modify: `packages/connectors/src/git/managed.ts`
- Modify: `packages/connectors/src/git/managed.test.ts`

**Interfaces:**
- Produces: create/write/delete/rename preflight, prepare, execute, reconcile,
  recover and reconcileRecovery behavior

- [ ] Add failing lifecycle tests for bytes, mode, untracked identity, restart,
  idempotence, lost responses and human drift.
- [ ] Implement one-surface POSIX worktree mutations with before/after checks.
- [ ] Add adversarial traversal, administrative path, symlink, hardlink, ABA,
  source recreation and destination conflict tests.
- [ ] Run focused connector and runtime-backed tests.

### Task 3: Index mutation lifecycle

**Files:**
- Modify: `packages/connectors/src/git/managed.ts`
- Modify: `packages/connectors/src/git/managed.test.ts`

**Interfaces:**
- Produces: stage and unstage through exact index entries

- [ ] Add failing tests for tracked, staged, unstaged and untracked paths while
  unrelated staged human state remains exact.
- [ ] Implement blob creation and exact cache entry replacement with fixed Git
  plumbing and bounded output.
- [ ] Add restart, lost response, index drift, HEAD drift and repeated recovery
  tests.
- [ ] Run connector typecheck and focused tests.

### Task 4: CLI and MCP integration

**Files:**
- Modify: `packages/cli/src/recovery.ts`
- Modify: `packages/cli/src/recovery-mcp.ts`
- Modify: `packages/cli/src/recovery-mcp.test.ts`
- Create: `packages/cli/src/recovery-git.test.ts`

**Interfaces:**
- Consumes: `managedGitAdapter`
- Produces: Git recovery config, policy connector and adapter-specific MCP schema

- [ ] Add failing CLI and MCP contract tests for valid and invalid Git mutations.
- [ ] Add the third exclusive recovery config branch and instantiate the adapter.
- [ ] Add action-specific Git MCP schemas and truthful cooperative wording.
- [ ] Run CLI typecheck and focused tests.

### Task 5: Disposable conformance and documentation

**Files:**
- Modify: `packages/cli/src/conformance.ts`
- Modify: `packages/cli/src/conformance.test.ts`
- Modify: `docs/ADAPTER-CONFORMANCE.md`
- Create: `docs/MANAGED-GIT.md`
- Modify: `docs/RECOVERY-COVERAGE.md`
- Modify: `docs/REVERSE-UPGRADE-PROGRESS.md`

**Interfaces:**
- Produces: `nomo recovery conformance --adapter git.managed`

- [ ] Add failing profile and scenario tests using a temporary repository with
  no remote and local-only author identity.
- [ ] Implement fixtures for every supported action and platform exclusion.
- [ ] Document exact guarantees, counts and exclusions without marking WP-R05
  complete or claiming commit recovery.
- [ ] Run conformance, connector and CLI typechecks, `pnpm test:reverse`,
  `pnpm run check`, `pnpm run build` and `git diff --check`.

### Task 6: Independent review and integration

- [ ] Review Git command injection, config and hook escape, path aliases, output
  bounds, process death, index lock behavior and human-state preservation.
- [ ] Fix every high or medium finding with a failing regression test first.
- [ ] Repeat focused and full validation from a clean integrated main tree.
- [ ] Commit with an imperative subject and required co-author trailer only after
  evidence is green.

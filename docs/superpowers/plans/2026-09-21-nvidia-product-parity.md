# NVIDIA model and product parity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship NVIDIA GLM 5.3 Flash as the safe default and make web, desktop, and TUI expose a coherent coding workspace with bounded background work, agents, context management, and recovery controls.

**Architecture:** Extend the existing OpenAI-compatible provider and Workbench contracts instead of introducing a second transport. Keep the server/runtime as the authority for credentials, policy, ledger, run lifecycle, and recovery; web, desktop, and TUI consume the same typed view models while rendering platform-specific controls.

**Tech Stack:** TypeScript, Node test runner, React 19, Vite, TanStack Query, Motion, Tauri shared web bundle, ANSI TUI, existing VOID runtime/policy/ledger/recovery modules.

**Spec:** `docs/superpowers/specs/2026-09-21-nvidia-product-parity-design.md`

## Global Constraints

- NVIDIA endpoint: `https://integrate.api.nvidia.com/v1`.
- NVIDIA default model: `z-ai/glm-5.3-flash`.
- Credential name: `NVIDIA_API_KEY`; never ship it to the browser or commit it.
- Existing sessions preserve their provider and model.
- Missing NVIDIA credentials show setup state; no silent paid fallback.
- Model output is untrusted and never directly authorizes shell, SQL, filesystem, HTML, or destructive tools.
- Every behavioral change gets a focused test before implementation and a passing verification command after implementation.
- No new dependency unless the existing stack cannot implement the behavior.

---

### Task 1: NVIDIA provider default

**Files:**
- Modify: `packages/workbench/src/provider-defaults.ts`
- Modify: `packages/workbench/src/index.ts`
- Modify: `packages/workbench/src/provider.ts`
- Modify: `packages/workbench/src/workbench.test.ts`
- Modify: `packages/workbench/src/provider-stream.test.ts`
- Modify: `packages/workbench/src/provider-retry.test.ts`
- Modify: `cloud/demo.mjs` and `cloud/demo.test.mjs` only where the provider contract requires it

**Interfaces:**
- `PROVIDER_PRESETS` gains the NVIDIA preset.
- `DEFAULT_PROVIDER_ID` becomes `nvidia`.
- `DEFAULT_MODEL_ID` becomes `z-ai/glm-5.3-flash`.
- `Workbench` uses NVIDIA only when `NVIDIA_API_KEY` exists; otherwise it exposes an explicit unavailable setup state.

- [ ] Write failing tests for NVIDIA preset, default model, credential absence, and preserved existing session config.
- [ ] Run `node --test packages/workbench/src/workbench.test.ts packages/workbench/src/provider*.test.ts`; confirm RED.
- [ ] Implement constants, preset selection, environment loading, and migration without rewriting existing sessions.
- [ ] Add NVIDIA catalog/stream/tool-call fixtures and redaction assertions.
- [ ] Run the focused workbench provider tests; confirm GREEN.
- [ ] Run `pnpm --filter @void/workbench typecheck`.
- [ ] Commit: `feat: make nvidia glm flash the default provider`.

### Task 2: Provider setup and quota states

**Files:**
- Modify: `packages/workbench/src/gui.ts`
- Modify: `packages/workbench/src/index.ts`
- Modify: `apps/control-plane/ui/src/pages.tsx`
- Modify: `apps/control-plane/ui/src/chat.tsx`
- Modify: `apps/control-plane/ui/src/commands.ts`
- Test: corresponding workbench and UI test files

**Interfaces:**
- Provider state returns `{ status: 'ready' | 'setup-required' | 'rate-limited' | 'unavailable'; provider; model; detail? }`.
- UI never renders a missing quota/cost as zero.

- [ ] Write failing tests for setup-required, rate-limited, unavailable, and ready states.
- [ ] Implement the typed provider state and stable error mapping.
- [ ] Add setup action and model picker metadata without exposing `NVIDIA_API_KEY`.
- [ ] Verify keyboard focus, empty/error/loading states, and redacted error output.
- [ ] Run UI tests and typecheck.
- [ ] Commit: `feat: expose provider setup and quota states`.

### Task 3: Shared workspace and run view contract

**Files:**
- Modify: `packages/workbench/src/gui.ts`
- Modify: `packages/workbench/src/index.ts`
- Modify: `apps/control-plane/ui/src/main.tsx`
- Modify: `packages/cli/src/tui/workspace.ts`
- Add/modify focused contract tests beside each surface

**Interfaces:**
- Shared view names: `chat`, `sessions`, `runs`, `documents`, `approvals`, `ledger`, `tools`, `models`.
- Run status is a discriminated state: `idle | running | awaiting-approval | stopping | stopped | failed | unknown | paused`.
- Provider and run status use the same labels and unknown semantics across surfaces.

- [ ] Write failing contract tests for view names and run-state rendering data.
- [ ] Implement additive view fields and adapters; preserve old response fields.
- [ ] Wire web, desktop shared bundle, and TUI navigation to the same route/view vocabulary.
- [ ] Run UI, TUI, workbench, and CLI focused tests.
- [ ] Commit: `feat: unify workspace and run view contracts`.

### Task 4: Projects and bounded background runs

**Files:**
- Modify: `packages/runtime/src/recovery/plan.ts` and `run.ts` where existing job semantics support the feature
- Modify: `packages/workbench/src/index.ts` and `gui.ts`
- Modify: `apps/control-plane/ui/src/pages.tsx`
- Modify: `packages/cli/src/tui/workspace.ts`
- Test: runtime, workbench, UI, and TUI run tests

**Interfaces:**
- A project is a validated workspace-scoped record with `id`, `name`, `root`, and `updatedAt`.
- A background run reuses the durable runtime job state and exposes `runId`, `status`, `progress`, `workspace`, and `reconcileRequired`.
- Stop is a real server/runtime request; unknown results never auto-dispatch again.

- [ ] Write failing tests for project isolation, run observation, stop, restart, unknown, and reconciliation.
- [ ] Implement the smallest project persistence extension using existing Workbench storage.
- [ ] Expose run list/detail/status in the shared GUI and TUI views.
- [ ] Verify duplicate dispatch is impossible under restart and timeout.
- [ ] Run focused runtime/workbench/UI/TUI suites.
- [ ] Commit: `feat: add bounded project background runs`.

### Task 5: Custom agents, hooks, and context compaction

**Files:**
- Add: `packages/workbench/src/agents.ts`
- Add: `packages/workbench/src/agents.test.ts`
- Modify: `packages/workbench/src/index.ts`
- Modify: `packages/workbench/src/gui.ts`
- Modify: `apps/control-plane/ui/src/pages.tsx`
- Modify: `packages/cli/src/tui/workspace.ts`

**Interfaces:**
- Agent profile: `{ id, name, systemPrompt, allowedTools, policyProfile, maxTurns, maxContextTokens }`.
- Hook: `{ id, event: 'before-run' | 'after-tool' | 'after-run', command, enabled }`, validated against an explicit allowlist and operator policy.
- Compaction returns `{ summary, retainedMessageIds, omittedMessageCount, createdAt }` and never modifies signed ledger records.

- [ ] Write failing tests for profile validation, tool allowlists, hook refusal, turn/token bounds, and compaction audit preservation.
- [ ] Implement typed profile persistence and policy checks; no prompt-only permission model.
- [ ] Implement bounded compaction with explicit UI/TUI status.
- [ ] Add agent and context controls to settings/session surfaces.
- [ ] Run focused tests and security review of command execution boundaries.
- [ ] Commit: `feat: add scoped agents hooks and context compaction`.

### Task 6: Recovery-first document and multi-operation UX

**Files:**
- Modify: `packages/workbench/src/gui.ts`
- Modify: `packages/runtime/src/recovery/plan.ts` and `run.ts`
- Modify: `apps/control-plane/ui/src/pages.tsx` and `chat.tsx`
- Modify: `packages/cli/src/tui/workspace.ts`
- Test: existing document, recovery, UI, and TUI suites

**Interfaces:**
- Preview is immutable until explicit refresh.
- Undo and rewind require server/runtime revalidation of operation IDs, digests, current revisions, and policy.
- Conflict displays the changed field/resource and disables retry until refresh.

- [ ] Write failing tests for multi-operation preview, human drift, stale digest, retry refusal, and repeated recovery.
- [ ] Implement server-authoritative plan preview and current-state refresh.
- [ ] Expose the same approval, diff, and conflict states in web, desktop, and TUI.
- [ ] Run focused recovery and UI tests.
- [ ] Commit: `feat: complete recovery-first editing flows`.

### Task 7: Visual, responsive, and accessibility parity

**Files:**
- Modify: `apps/control-plane/ui/src/*.tsx`
- Modify: `apps/control-plane/ui/src/*.css`
- Modify: `packages/cli/src/tui/*.ts`
- Test: `apps/control-plane/ui/src/*.test.ts`, TUI tests, browser/PTY smoke scripts

- [ ] Add failing UI checks for 320, 768, 1280, and 1440 pixel layout, visible focus, and no horizontal overflow.
- [ ] Implement the approved paper-terminal design using existing tokens and shared states.
- [ ] Add skeleton, empty, error, offline, stale, permission, and reduced-motion behavior.
- [ ] Align TUI keymaps and labels with web navigation without forcing web layout into terminal constraints.
- [ ] Run browser QA with console/network inspection and real PTY checks.
- [ ] Commit: `feat: align web desktop and terminal workspace parity`.

### Task 8: Release verification

**Files:**
- Modify: `docs/GUI-UPGRADE-DELIVERY.md`, `docs/PLAN-STATUS.md`, and `docs/PLAN-GAPS.md`
- No source changes unless a verification regression finds one.

- [ ] Run focused provider, workbench, runtime, UI, CLI, TUI, and desktop tests.
- [ ] Run root typecheck, tests, web/cloud build, TUI PTY, and packaged desktop smoke.
- [ ] Run a real NVIDIA smoke only when `NVIDIA_API_KEY` is present; otherwise verify explicit setup-required behavior.
- [ ] Inspect the diff, confirm no secrets, and document any external blockers without downgrading evidence.
- [ ] Commit: `docs: record nvidia and product parity verification`.
- [ ] Push all verified commits to `origin/main`.

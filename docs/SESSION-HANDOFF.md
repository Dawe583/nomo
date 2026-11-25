# NOMO cloud session handoff

> Canonical bootstrap for any session continuing NOMO work, especially Devin Cloud.
> Written 2026-11-25. The task graph `.nomo/work-state.json` is the work record;
> this file is the orientation. If they disagree, the graph wins.

## Read first, in this order

1. `AGENTS.md`, `AGENTS.local.md`, `.opencode/prompts/nomo-system.md`, `docs/agent-work-system.md`
2. `.nomo/work-state.json` — the task graph. A node is done only when its verifier output is quoted in its evidence.
3. `docs/plans/2026-11-25-nomo-24h-program-detailed.md` — the active program (T1–T12 TUI, H1–H15 harness, R1–R7 bandit/policy search, Q1–Q10 quality, F1–F4 product gates, G gated work)
4. `docs/superpowers/specs/2026-10-08-nomo-agent-identity-fleet-capability-map.md` — the product spec: run stop vs agent revoke vs fleet revoke, identity registry as revocation authority
5. `docs/memory/vault/start-here/NOMO Project Home.md` and `docs/memory/vault/governance/NOMO Memory Rules.md` — the project memory imported from the Obsidian vault

## Memory layout in this repo

- `.nomo/work-state.json` — task graph, one authorized writer per session
- `docs/memory/vault/` — snapshot of the Obsidian NOMO vault memory (start-here, governance, work-log). The vault itself is local-only; cloud sessions MUST write memory here or in the graph, never assume vault access
- `.ua/knowledge-graph.json` — understand-anything index of the codebase (5 598 nodes). Query it before grepping: nodes carry file paths, summaries, tags
- `.agents/skills/`, `.devin/skills/` — the full local skill set, copied for cloud parity
- `docs/CONTEXT.md`, `docs/DECISIONS.md`, `docs/STANDARDS.md` — authoritative repository contracts

## Verified state at push (commit e2ad7ac5 line, 2026-11-25)

- workbench: `node --test --test-concurrency=1 packages/workbench/src/*.test.ts` → 1182 tests, 1180 pass, 0 fail, 2 skipped after R3/R4 integration
- `pnpm --filter @nomo/workbench typecheck` → exit 0
- agent-identity: 11/11 including revocation surviving restart without local session evidence
- H1-H4, H7, H8, H9, R1, R2, R3 and R4 are done; oracle eval 14/14 proves plumbing only, not model capability; R2 is a contextual bandit, not RL
- Do not trust these numbers without re-running the gate you depend on.

## Product gates status (Track F)

- F1 later-session retrieval: DONE — opt-in `NOMO_SHARED_LEARNING_WORKSPACES` read-only union, digest names entry id + chain seqs
- F2 approval end-to-end: DONE — hold writes signed hold:approved with approvedBy; verified in agent-messages-tool tests
- F3 identity/fleet truth: DONE as the local-truth slice. TUI status shows the binding, `/revoke-agent` is confirmed and local, durable restart is tested including revocation without local session evidence; fleet-wide revoke remains honestly documented as unavailable until registry, node inventory, ack barrier and reconcile exist
- F4 provider release path: PENDING — needs explicit authorization for a real provider call

## Rules that are not negotiable

- No push, merge, deploy, hosted CI, dependency install, or provider-costing call unless the user explicitly asks in the current task. (This push was explicitly authorized by the user on 2026-11-25.)
- Never print, copy, or persist a secret. Provider credentials live in the user's local OpenCode config; cloud sessions must not invent or embed them.
- Do not weaken tests, delete assertions, or add suppressions to reach green.
- One writer per file; preserve unrelated dirty changes; nomo-web is a protected submodule.
- Do not re-introduce the autonomous loop (launchd autoloop) — it was deliberately removed on 2026-11-25.
- Do not replace the hand-rendered TUI with a component-library skeleton. The documented decision (docs/DECISIONS.md) is not-adopted unless byte-for-byte parity is proven first.
- Verify with the narrowest meaningful command first, then typecheck, then the wider suite. Quote observed output in the graph before marking a node done.

## Honest limits a cloud session must know

- The harness is NOT RL. It is measurement, frozen evaluation and (planned) contextual bandit/policy search. Gradient RL requires a trainable local model + GPU and does not exist.
- Fleet-wide revocation does not exist; only local single-process agent revoke. `docs/CONTEXT.md` names the registry, node inventory, acknowledgement, fail-closed disconnected-node and reconciliation requirements.
- GUI plans exist but are undecided (v1 vs post-v1) — do not build GUI work without a user decision.
- The vault memory in docs/memory/ is a snapshot from 2026-11-25; it does not update itself.

# NOMO cloud session handoff

> Canonical bootstrap for any session continuing NOMO work, especially Devin Cloud.
> Written 2026-11-25. The task graph `.nomo/work-state.json` is the work record;
> this file is the orientation. If they disagree, the graph wins.

## Read first, in this order

1. `AGENTS.md`, `AGENTS.local.md`, `.opencode/prompts/nomo-system.md`, `docs/agent-work-system.md`
2. `.nomo/work-state.json` - the task graph. A node is done only when its verifier output is quoted in its evidence.
3. `docs/plans/2026-11-25-nomo-24h-program-detailed.md` and `docs/plans/2026-11-25-nomo-master-workflow.md` - the active programs (TUI, harness, bandit/policy search, quality, product gates, measurement wiring)
4. `docs/superpowers/specs/2026-10-08-nomo-agent-identity-fleet-capability-map.md` - the product spec: run stop vs agent revoke vs fleet revoke, identity registry as revocation authority
5. `docs/memory/vault/start-here/NOMO Project Home.md` and `docs/memory/vault/governance/NOMO Memory Rules.md` - the project memory imported from the Obsidian vault

## Memory layout in this repo

- `.nomo/work-state.json` - task graph, one authorized writer per session
- `docs/memory/vault/` - snapshot of the Obsidian NOMO vault memory (start-here, governance, work-log). The vault itself is local-only; cloud sessions MUST write memory here or in the graph, never assume vault access
- `.ua/knowledge-graph.json` - understand-anything index of the codebase (5 598 nodes). Query it before grepping: nodes carry file paths, summaries, tags
- `.agents/skills/`, `.devin/skills/` - the full local skill set, copied for cloud parity
- `docs/CONTEXT.md`, `docs/DECISIONS.md`, `docs/STANDARDS.md` - authoritative repository contracts

## Verified state after the F2 audit (2026-11-26)

- Implementation heads before this handoff refresh: `tui-merge-main` `87044f9c`; `origin/main` `87044f9c`
- Graph: `.nomo/work-state.json` has 110 nodes, 110 done, including C1-C2, D1-D4, F1-F4, Q1-Q23, H1-H15, H18-H26, R1-R8 and T1-T18 as applicable
- Latest TUI gate: `pnpm run test:tui` → 549 tests, 549 pass, 0 fail; terminal verifier PASS every scenario at every size
- Latest typechecks from that gate: `pnpm --filter @nomo/cli typecheck` → exit 0; `pnpm --filter @nomo/workbench typecheck` → exit 0
- Latest Workbench wide evidence before the test-only TUI repairs: 1434 tests, 1431 pass, 0 fail, 3 skipped
- HP1 operator-scope promotions and HP2 automatic run-loop compaction are done. C2 retrieval hit accounting is production-reachable as one bounded content-free `harness.retrieval` record per provider turn
- Oracle eval proves plumbing only, not model capability; R2 is a contextual bandit, not RL
- Do not trust these numbers without re-running the gate you depend on.

## Product gates status (Track F)

- F1 later-session retrieval: DONE - opt-in `NOMO_SHARED_LEARNING_WORKSPACES` read-only union, digest names entry id + chain seqs, and retrieval hit accounting names carried entry ids without content
- F2 approval end-to-end: DONE - governed hold waits for confirmation, approval dispatches once, signed hold:approved evidence carries approvedBy, denial/restart/cancellation cannot release, and the TUI decision notice is pinned in the integration test
- F3 identity/fleet truth: DONE as the local-truth slice. TUI status shows the binding, `/revoke-agent` is confirmed and local, durable restart is tested including revocation without local session evidence; fleet-wide revoke remains honestly documented as unavailable until registry, node inventory, ack barrier and reconcile exist
- F4 provider release path: DONE - real provider smoke is verified through OpenRouter using locally configured credential material. Final output: `PASS provider-smoke: nvidia/nemotron-3.5-lightning:free answered in 1084 ms; reply 5 chars; usage prompt_tokens=23 completion_tokens=138 total_tokens=161.` No credential, prompt or response content is recorded

## Release decision after provider smoke (2026-11-26)

- Provider smoke is verified only for the OpenAI-compatible OpenRouter path named in F4. This is not a benchmark and not proof of OpenCode Zen availability.
- No release, tag, deploy, npm publication or hosted job was performed. G4 still needs an explicit owner decision on version target, changelog, tag and deploy path immediately before release.


## R0 terminal protocol boundary (2026-11-26)

- `packages/workbench/src/tui-protocol.ts` now defines the first versioned boundary for a future Rust or other terminal frontend: server-owned snapshots, paged transcript content, usage/provider/approval/palette state, validated operator intents and versioned server-event envelopes.
- Active panel and terminal capabilities are client-owned render context, not workbench state. Static session metadata deliberately excludes transcript text and event payloads.
- This is a contract only: no Rust implementation, production wiring, release, benchmark or migration has started. The byte-parity and strangler adoption gates are documented in `docs/plans/2026-11-26-tui-protocol-boundary.md`.
- Verified after the slice: focused protocol tests 8/8, `@nomo/workbench` typecheck exit 0, `@nomo/cli` typecheck exit 0.


## T20 transcript position indicator (2026-11-26)

- The sticky transcript breadcrumb now carries the exact visible row range and the number of transcript rows below the viewport while scrolled, without spending another frame row.
- This is a position indicator, not a minimap or virtual scrollback rewrite. The composer, review keys and exact frame shape are unchanged.
- Verified: focused TUI workspace suite 128/128, accessibility plus visual snapshots 16/16, `@nomo/cli` typecheck exit 0.


## T21 command palette aliases (2026-11-26)

- Palette fuzzy search now accepts a small audited set of operator aliases while rows still show only canonical slash commands. Preview data exposes aliases beside the command summary and usage shape.
- Verified: palette visual tests 4/4, palette-focused workspace tests pass, `@nomo/cli` typecheck exit 0.


## R1 bounded Rust Help spike (2026-11-26)

- `scripts/tui-rs-spike` is an isolated experiment using `ratatui` and `crossterm`; it is not wired into production launch paths.
- Verified byte-for-byte against committed canonical monochrome Help hashes at 40x12, 52x16, 80x24, 120x40, 160x45 and 200x48 for ascii, unicode and nerd arguments. The presets are identical because this Help surface uses shared glyphs.
- Honest limit: fixture content is hardcoded and there is no protocol client, input loop, scrollback, mouse, bracketed paste, approval flow or real PTY evidence. Rust is not adopted beyond this spike.
- Verified: `cargo test --offline --quiet` 1/1 and `node --test scripts/src/tui-rs-parity.test.mjs` 1/1.


## R1b Rust spike interactive PTY smoke (2026-11-26)

- The isolated Rust spike now also has an interactive `ratatui`/`crossterm` mode with raw mode, alternate screen, resize redraw and `q`/Esc exit. This is still not production wiring.
- Real PTY smoke passes at 40x12, 80x24 and 120x40: frame renders, terminal width does not overflow, alternate screen enters and restores, and `q` exits cleanly.
- Static byte parity remains green after the interactive-mode change.
- Honest limit: still no typed protocol client, transcript interaction, scrollback, mouse, bracketed paste, approval flow or adoption decision.

## Rules that are not negotiable

- No push, merge, deploy, hosted CI, dependency install, or provider-costing call unless the user explicitly asks in the current task. (This push was explicitly authorized by the user on 2026-11-25.)
- Never print, copy, or persist a secret. Provider credentials live in the user's local OpenCode config; cloud sessions must not invent or embed them.
- Do not weaken tests, delete assertions, or add suppressions to reach green.
- One writer per file; preserve unrelated dirty changes; nomo-web is a protected submodule.
- Do not re-introduce the autonomous loop (launchd autoloop) - it was deliberately removed on 2026-11-25.
- Do not replace the hand-rendered TUI with a component-library skeleton. The documented decision (docs/DECISIONS.md) is not-adopted unless byte-for-byte parity is proven first.
- Verify with the narrowest meaningful command first, then typecheck, then the wider suite. Quote observed output in the graph before marking a node done.

## Honest limits a cloud session must know

- The harness is NOT RL. It is measurement, frozen evaluation and (planned) contextual bandit/policy search. Gradient RL requires a trainable local model + GPU and does not exist.
- Fleet-wide revocation does not exist; only local single-process agent revoke. `docs/CONTEXT.md` names the registry, node inventory, acknowledgement, fail-closed disconnected-node and reconciliation requirements.
- GUI plans exist but are undecided (v1 vs post-v1) - do not build GUI work without a user decision.
- The vault memory in docs/memory/ is a snapshot from 2026-11-25; it does not update itself.

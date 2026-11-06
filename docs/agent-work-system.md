# NOMO agent work system

This document explains the project-local workflow. `docs/agent-contract.md` is the canonical operating contract. `AGENTS.md`, `CLAUDE.md`, the harness configs and launchers route agents to it. `AGENTS.local.md` contains the repository authority, persistent operating rules and approvals. The skills under `.agents/skills/nomo-*` contain reusable procedures. Product and security contracts remain in `docs/CONTEXT.md`, `docs/DECISIONS.md` and `docs/STANDARDS.md`.

## One graph, bounded loops

Every request uses Graph Engineering and Loop Engineering as its governing methods, with Pydantic AI, Graph and Evals as the shared typed workflow foundation. Load `nomo-loops`, `nomo-graphs`, `nomo-pipeline`, `nomo-pydantic` and `nomo-worktrunk` before every task; load a domain skill only when its route requires it. Each task uses one durable graph in `.nomo/work-state.json`. Keep it small: one active node, ordered dependencies, clear owner and file scope, acceptance evidence, verifier and stop condition. Record durable progress in the Obsidian `08 Work Log/NOMO Work Log.md`. An unrelated active node protects its own paths; locate the request's assigned Worktrunk worktree and graph instead of treating it as a global lock. Do not create overlapping plans or ask the user to repeat the request while safe authorized nodes remain. Continue safe nodes through verified completion; do not stop at a proposal when implementation is requested. If no authorized node is ready, report the concrete blocker once and wait for new evidence or user input instead of repeating discovery.

Each node proceeds through discover, specify, change, verify, review and record. Run the focused verifier first, then the required project gates. A repeated failure triggers diagnosis or a blocker, not endless retries. Worktrunk inventory is required during every task discovery; isolate writes when safe. Scrapling is the default fetcher for public web research and provided public URLs. Do not invoke unrelated tools on local-only tasks.

## Graph roles

- Task graph: execution state, dependencies and evidence.
- Graphify: cross-file source navigation; its current index is preserved in the NOMO Obsidian vault under `Graphify-Index/` and must be validated against the active checkout.
- Understand Anything: additional code structure and semantic navigation in `.ua/`, only after graph validation.
- Obsidian NOMO vault: canonical human-readable decisions, status, roadmap, research, skills and handoffs. Follow `NOMO Memory Rules`; generated indexes remain separate and derived.

Generated graphs never replace code, tests or approved specs. Record what was excluded, unsupported or inferred. Keep secret material out of all graphs and memories.

## Delegation

Use one primary owner and at most one active subagent for a NOMO task. Check the roster before spawning. Give the child one graph node, explicit allowed paths, output and verifier. Run read-only audits through `scripts/nomo-pi-audit.sh`, which disables extensions and MCP and permits only read tools. Wait for completion before any further delegation. The primary session remains the sole integrator.

## Autonomous operation

The current Prime Agent session does not expose a command to change its own mode after launch. `prime-agent --autonomous` is a per-run CLI option. Use it only when the user explicitly starts `scripts/nomo-prime-agent.sh`; that launcher bounds turns, tokens and time and runs `pnpm run typecheck` as a completion gate. It does not silently launch background work. Task-owned publication follows the standing authorization in `AGENTS.local.md`; deployment and production access require authorization; install project dependencies when needed for authorized work.

## Safety gates

Preserve dirty work and worktree ownership. Do not reset or clean shared state, force-push, expose secrets, access production, install packages, change global settings or mutate external accounts without required authorization. Stage only task-owned files. `AGENTS.local.md` grants standing authorization to commit, merge task-owned verified changes to GitHub `main` and push them after all required gates pass. Do not include unrelated changes or secrets. Do not manually deploy.

## Tool routing

At each task start, read `nomo-loops`, `nomo-graphs`, `nomo-pipeline`, `nomo-pydantic` and `nomo-worktrunk`, then run `scripts/nomo-wt.sh list`. Read `nomo-scrapling` for public web research or supplied URLs. Before each node, select other relevant skills and native project tools. Inspect MCP schemas before calls. Use Obsidian for durable human-readable project memory; use code graphs only for navigation and source/tests for behavior truth. Follow the vault writing contract. If a tool or service is unavailable, state that and use no invented substitute.

## Entry points

- Claude Code: open the NOMO repository. `CLAUDE.md` and `AGENTS.md` route to the canonical prompt and local contract. Project procedures live in `.agents/skills/nomo-*`.
- Codex: open the NOMO repository. It discovers global `~/.codex/AGENTS.md`, then project `AGENTS.md`; follow the required `AGENTS.local.md` pointer.
- OMP: launch with `scripts/nomo-omp.sh`. It appends the shared contract and loop, graph, pipeline, Pydantic and Worktrunk skill contents. Global Scrapling is available. The project launcher enables session-scoped `yolo` approval mode as requested. Actual runtime capabilities and higher-priority restrictions still apply. Do not use this launcher for production or unauthorized external actions.
- Prime Agent: launch a bounded autonomous NOMO run with `scripts/nomo-prime-agent.sh "task"`. It appends the shared prompt, loads loop, graph, pipeline, Pydantic and Worktrunk skills, limits turns/tokens/time and runs `pnpm run typecheck` as a completion gate. The current already-running session cannot be switched into autonomous mode by editing project files.
- Pi: launch with `scripts/nomo-pi.sh`. It appends the shared contract and explicitly loads the NOMO loop, graph, pipeline, Pydantic and Worktrunk skills. Verify actual skill discovery and runtime permissions in the active harness. For an audit-only child, `scripts/nomo-pi-audit.sh "request"` disables extensions and MCP and selects read, grep, find and ls only. This is a tool restriction, not an OS sandbox; verify the installed Pi runtime and do not use a different harness for audit until its read-only restriction is verified.

For governed proxy calls and fixture-backed workflow evaluation, follow
`.agents/skills/nomo-pydantic/SKILL.md` and `python/nomo-pydantic/README.md`.
The harnesses share the Pydantic workflow contract, but a proxy call still
requires an explicit model, tool allowlist and running loopback proxy.

These entry points load or point at `docs/agent-contract.md`, the
NOMO-specific Loop Engineering and Graph Engineering contract. Global
instructions load through each harness's native user-level instruction path.
Codex and Claude read the project entry files; the Pi, OMP and Prime launchers append the shared contract to their system prompts. Harnesses
cannot enforce identical behavior, and users can override project instructions.
Keep runtime concurrency limits consistent with this document and verify that
the installed harness applies its project overlay before relying on a hard cap.
Never use detached spawn commands to bypass the cap.

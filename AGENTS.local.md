The user requested active use of these installed skills throughout this work:

- `/Users/dawe/.codex/skills/caveman/SKILL.md`: concise Czech communication; preserve complete technical detail in explicitly requested plans and reports.
- `/Users/dawe/.codex/skills/ponytail/SKILL.md`: reuse existing capabilities, avoid unnecessary infrastructure, and never omit requested features, accessibility, validation, or verification.

The user reaffirmed on 2026-09-13: integrate and push completed verified changes to GitHub `main` for automatic Vercel deployment. Preserve unrelated files and never commit secrets. Use caveman and ponytail by default for all work. Mobile usability and a stronger ASCII identity are current design priorities. Standing approval reaffirmed on 2026-10-26: after task-owned changes pass required verification, commit, merge to GitHub `main`, and push them without asking for approval again; never include unrelated/foreign files or secrets, and never force-push.
The local Prime Agent recovery MCP is active through a macOS Keychain-backed
launcher. Its only writable filesystem scope is
`~/.local/share/void-prime-dogfood/project`. Use only the configured five-tool
allowlist. Do not regenerate its retained recovery key or expand its scope.
This managed path does not intercept ordinary shell or editor writes.

## NOMO memory source

- The Obsidian vault at `/Users/dawe/Library/Mobile Documents/iCloud~md~obsidian/Documents/NOMO` is the canonical human-readable NOMO memory. Start with `00 Start Here/NOMO Start Here.md` and `01 Governance and Memory/NOMO Memory Rules.md`.
- Use the vault for durable decisions, verified project status, roadmaps, research, agent skill/tool routing and handoffs. Append milestones to `08 Work Log/NOMO Work Log.md`.
- `.nomo/work-state.json` remains the sole execution graph. Repository source, tests, approved specs and context contracts remain authoritative for implementation behavior.
- Graphify and CodeAtlas under `Graphify-Index/` are generated navigation aids, not authored memory or source authority. Check their source checkout and commit before trusting them; do not mix generated files into authored sections.
- Never store full transcripts, secrets, credentials, production records or personal data. Follow `NOMO Memory Rules` for note creation, provenance, archive and link checks.
- If the vault is unavailable, use repository source and contracts as authority; mark missing or stale memory context explicitly. Do not silently duplicate project facts in agent memory.
- Repository contracts in `docs/CONTEXT.md`, `docs/DECISIONS.md` and `docs/STANDARDS.md` remain authoritative for code.

## NOMO project work system

These instructions apply only inside this NOMO repository. Do not change global Prime Agent or other workspace settings. Mojo is out of scope.

## Start every task

1. Read `AGENTS.md`, `CLAUDE.md` when present, `docs/agent-contract.md`, this file, `docs/agent-work-system.md`, the authoritative context pack, and applicable NOMO skills.
2. Read Obsidian `00 Start Here/NOMO Start Here.md` and `01 Governance and Memory/NOMO Memory Rules.md`, then check the relevant current status note, `08 Work Log/NOMO Work Log.md` and active repository work graph. Graphify generated folders are preserved as derived indexes; authored vault notes follow the memory rules.
3. Use the NOMO Graphify graph for architecture navigation when it matches the active checkout. Use Understand Anything `.ua/knowledge-graph.json` as a second navigation index only when validated. Source, tests and approved specs are authoritative.
4. Inspect Git status and active worktrees before touching files. Preserve all unrelated edits. The checkout may contain foreign work. Never reset or clean shared state. Stage only task-owned files. Standing authorization covers task-owned commits, merges to GitHub `main`, and pushes after all required gates pass. Do not include unrelated changes or secrets. Never force-push or deploy manually.
5. Read `nomo-loops`, `nomo-graphs` and `nomo-worktrunk` for every task. Run `scripts/nomo-wt.sh list` during discovery and use Worktrunk to isolate writes when the graph and dirty-state checks allow it. Read `nomo-scrapling` for every public web research task or user-supplied public URL. Read `nomo-pipeline` and domain skills when relevant. Never claim an unavailable integration was used.

## Work graph and loop

Use one primary task graph for the active request. Every node states owner, inputs, allowed paths, expected output, dependencies, verifier and stop condition. Track `ready`, `active`, `blocked` and `done`, with evidence for completion. Keep the graph in the repository work-state file and append milestone evidence to the Obsidian Work Log.

Work in bounded loops: inspect authority and evidence, state expected change, make one minimal slice, run the narrow verifier, run required wider gates, review the diff and record evidence plus the next node. Retry a failing verifier once only after diagnosing the cause. Stop and report repeated failures, conflicts, missing authority or a human approval gate. Do not claim completion from agent self-report alone.

## Autonomy and delegation

Continue safe, in-scope graph nodes without asking the user to repeat the request. Follow the user's explicit authorization for work and task-owned publication after required verification. Ask when a product decision materially differs, authority is missing, or an action exceeds the user's scope. Preserve secrets, unrelated work and active ownership.

Use one primary owner and at most one active subagent for the task. Audit subagents must be constrained by the runtime to read-only tools; if that cannot be verified, do not launch them. Delegation is optional. Check the current roster first. Give a child one narrow graph node, explicit allowed paths and a verifier. The primary agent remains the sole integrator.

## gstack workflow

Discover installed gstack skills through the harness skill catalog when their role fits the task. Examples include `review`, `qa`, `investigate`, `plan-eng-review` and `ship`. In OMP, invoke the discovered skill with `/skill:<name>` when needed. Follow gstack's own instructions and helpers, but NOMO's context pack, security rules, task graph, bounded verification, ownership limits and approval gates remain authoritative when instructions conflict. Do not run gstack release, deployment, account or external side-effect steps without the required user authorization.

## Safety and project contracts

Never read, copy or expose secrets. Before model analysis, logs, graph generation or screenshots, honor `.ua/.understandignore` and the project's sensitive-path exclusions. Never execute production actions. Preserve the established fail-closed identity, authorization, evidence, append-only ledger and recovery rules. Do not run an Actor or other external workload unless the user explicitly authorizes it.

Prefer repository-supported tools and existing dependencies. Install project dependencies when needed for authorized work; preserve lockfiles and do not change global settings. Keep JavaScript tests on `node:test`; run `pnpm run typecheck` before code completion claims. Follow the no em dash or en dash repository rule in all edited files.

## Memory and handoff

Keep durable project knowledge in the NOMO Obsidian vault and code relationships in the external Graphify index. Understand Anything is complementary, not a replacement. Never store secrets, raw transcripts or unverified guesses in either system. At every meaningful milestone append to `08 Work Log/NOMO Work Log.md` with changed areas, exact verifier evidence, blockers and next graph node. End each response with concise status and evidence.

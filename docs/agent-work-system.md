# NOMO agent work system

This is the project workflow guide. `.opencode/prompts/nomo-system.md` is the
canonical cross-harness contract. `AGENTS.md`, `CLAUDE.md`, both OpenCode
configs, and the OMP/Prime launchers route agents to it. `AGENTS.local.md`
contains durable repository authority and preferences. Reusable procedures live
in `.agents/skills/nomo-*`; product contracts stay in `docs/CONTEXT.md`,
`docs/DECISIONS.md`, and `docs/STANDARDS.md`.

## Graph and loop workflow

Use Graph Engineering and Loop Engineering for each request. Work from the
graph designated for that request and worktree. TUI commonly uses
`.nomo/work-state.json`; other workstreams may have separate authorized graphs.
Do not force every harness to edit one graph. Each graph has one authorized
writer, and each source path has one active writer.

Independent, path-disjoint nodes may run concurrently. Add dependencies only
for real data or ordering requirements. A blocked node does not block unrelated
ready nodes. Use the assigned worktree and preserve its dirty state; do not
create extra worktrees solely for parallelism. Continue authorized work through
implementation and evidence, not just a plan. Resolve routine choices from
repository evidence. Report a blocker only when a concrete authority, evidence,
user decision, or runtime capability is missing, then continue independent work.

Each node follows Discover, Specify, Change, Verify, Review, Record. Record its
owner, scope, dependencies, output, acceptance, verifier, stop condition and
observed evidence. Run the narrowest authorized verifier. Do not add or run tests
unless the user asks. Diagnose a failing check and allow one targeted repair;
then block only that node if it still fails. Keep security, approval, service,
resource and runtime limits intact. No prompt can guarantee that legitimate
blockers never occur.

## Graph and memory roles

- The task graph tracks execution, ownership, dependencies and evidence.
- Graphify and validated Understand Anything graphs support source navigation;
  source code and authorized checks remain the behavior evidence.
- The Obsidian NOMO vault holds human-readable decisions, verified status,
  roadmap and handoffs. Follow `NOMO Memory Rules` and keep secrets, credentials,
  private data and raw transcripts out of all graphs and memory.

Validate a source graph's root, revision, coverage and provenance before relying
on it. Graph edges are navigation claims, not proof of runtime behavior.

## Delegation

Keep native harness tools, skills, subagents, teammates and delegation features
available. Start subagents only when the user explicitly requests them; use at
most five per session or the lower native runtime limit. This project policy
cannot change or enforce runtime limits. Give every delegated node explicit
paths and a verifier. Do not wait for another harness on independent work. The
primary owner integrates the work and records evidence. Never use detached runs
to bypass ownership, review or approval boundaries.

## External actions and safety

Preserve dirty work and ownership. Do not reset or clean shared state, expose
secrets, access production, install dependencies, change global settings, or
mutate external accounts without required authorization. Do not start hosted
GitHub jobs or commit, merge, push, publish or deploy unless the user explicitly
requests that action in the current task. Do not include unrelated changes or
secrets.

## Skills and tools

At task discovery, read `nomo-loops`, `nomo-graphs`, and `nomo-worktrunk`, then
run `wt list`. Read `nomo-scrapling` for public web research or user-supplied
public URLs. Load only other relevant skills and tools; inspect MCP schemas and
connection scope before using them. Use Scrapling's read-only public GET first
for web research. Use Obsidian for durable project memory where available. If a
tool is unavailable, say so and do not claim a substitute was used.

## Harness entry points

- **Codex:** project `AGENTS.md` routes to this guide and the shared contract;
  global Codex settings remain separate.
- **Claude Code:** `CLAUDE.md` routes to the same project instructions.
- **OpenCode:** `opencode.json` and `.opencode/opencode.json` load the shared
  prompt and project context; root config retains its agents and commands.
- **OMP:** `scripts/nomo-omp.sh [task prompt...]` sets repository cwd and appends
  `AGENTS.local.md`, the shared prompt, and this guide. It does not change tools,
  profile, approval mode, or global settings.
- **Prime Agent:** `scripts/nomo-prime-agent.sh [task prompt...]` appends the
  same project contract and requests native autonomous mode. Prime's runtime
  limits and approvals remain active.
- **Pi:** use its native global/project instruction loader and these shared
  repository files.

Launchers affect only new runs. They do not modify an already running session or
daemon. Project text communicates policy; each runtime's own settings enforce
its tools, approvals, concurrency and budgets. Do not claim these settings are
identical or that project text imposes a hard runtime limit.

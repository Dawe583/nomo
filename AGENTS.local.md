# NOMO project guidance

For the GUI upgrade, read `docs/GUI-UPGRADE-PLAN.md` and `docs/GUI-UPGRADE-AUDIT.md` first. These documents describe the requested target and the verified baseline, not completed implementation.

The user requested active use of these installed skills throughout this work:

- `/Users/dawe/.codex/skills/caveman/SKILL.md`: concise Czech communication; preserve complete technical detail in explicitly requested plans and reports.
- `/Users/dawe/.codex/skills/ponytail/SKILL.md`: reuse existing capabilities, avoid unnecessary infrastructure, and never omit requested features, accessibility, validation, or verification.

The intended default for new conversations is the model of the current main session: `opencode/muse-spark-1.3-contributor-free` through OpenCode Zen. No glm model is used anywhere: neither this session nor any subagent spawned from it may route to `z-ai/glm-5.3-flash`, `z-ai/glm-5.3-free` or any other glm spelling. Never put credentials into source, documentation, browser storage, or logs. Existing conversations retain their provider/model snapshot. Never silently fall back to another provider.

The user reaffirmed on 2026-09-13: work directly on `main`, commit and push completed verified changes to GitHub `main` for automatic Vercel deployment. Preserve unrelated files and never commit secrets. Use caveman and ponytail by default for all work. Mobile usability and a stronger ASCII identity are current design priorities.

The user requested on 2026-09-14: all built-in TUI interface text must default to English. The interactive TUI must use its full color theme by default, even when the host inherits NO_COLOR=1. Use NOMO_TUI_COLOR=0 as its explicit monochrome option; keep noninteractive output plain. Preserve user-authored messages and documents in their original language.

Historical note: on 2026-09-18
the user removed Token Harbor and selected OpenCode Zen, which the default
above keeps. Explicit legacy
snapshots still use their saved provider. Credentials never belong in this repo
or command history.

The local Prime Agent recovery MCP is active through a macOS Keychain-backed
launcher. Its only writable filesystem scope is
`~/.local/share/void-prime-dogfood/project`. Use only the configured five-tool
allowlist. Do not regenerate its retained recovery key or expand its scope.
This managed path does not intercept ordinary shell or editor writes.

## Autonomous loop contract (2026-10-21)

All future NOMO work in this repository runs through one graph and bounded
loops. Read `docs/HARNESS-LOOP-PLAN.md` for the full contract, settings, work
graph and verification matrix. The short form:

- Use `.nomo/work-state.json` as the single execution state; one active node;
  discover, specify, change, verify, review, record.
- Load the skills `nomo-loops`, `nomo-graphs`, `nomo-pipeline` and
  `nomo-work-package` before work.
- Continue safe, in-scope nodes without re-prompting. Commit and push after
  each verified slice. Fast-forward `main` only after a green gate.
- Never edit or stage `packages/cli/src/tui/*` or other foreign worktree files.
- Never read, copy or expose secrets. No production actions, no dependency
  installs, no global setting changes.
- Evidence first: a claim without a command and its output is not a claim.

## NOMO memory source

## TUI continuation authority

For all new TUI work, read `NOMO TUI Control Center.md` in the NOMO Obsidian vault and `docs/superpowers/plans/2026-10-30-nomo-tui-ownership-and-continuation.md` in the clean integration worktree first. These are the current routing and continuation pointers. Older TUI plans, handoffs, OMP notes, imported Obsidian snapshots, and Graphify outputs remain historical evidence only. Do not treat their owner, branch, status, or TODO claims as current without rechecking the live task graph and source.

TUI ownership is explicit: the Prime Agent integrator owns `.worktrees/tui-clean-continuation` and its execution graph. OMP work requires a separate written bounded assignment and separate worktree; it never writes to the integration branch. OpenCode TUI v2 was removed by user direction and must not be revived. Preserve unrelated dirty worktrees. Do not delete historical documents in bulk; use the Control Center and reviewed supersession pointers so future agents have one current entry point.

- Canonical human-readable NOMO project memory lives in the Obsidian vault at `/Users/dawe/Library/Mobile Documents/iCloud~md~obsidian/Documents/NOMO`.
- Start at `NOMO Project Home.md`. Use `NOMO Memory Rules.md` for storage boundaries and `NOMO Work Log.md` for current status.
- Use the installed `kepano/obsidian-skills` for Obsidian Markdown and CLI operations. When Obsidian is running, target the vault explicitly with `obsidian vault=NOMO ...`.
- Use Graphify for source navigation. Its index lives in `Graphify-Index/graphify-out/` inside the vault. Check `.graphify_root`, the active worktree and current source before trusting the graph.
- Store durable NOMO decisions, status, risks and project knowledge in the vault. Do not duplicate project facts in ChatGPT, Codex or agent memory. Do not store full transcripts, secrets or credentials.
- Keep new project status and decision history out of this file. Repository contracts in `docs/CONTEXT.md`, `docs/DECISIONS.md` and `docs/STANDARDS.md` remain authoritative for code.

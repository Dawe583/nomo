# NOMO project guidance

For the GUI upgrade, read `docs/GUI-UPGRADE-PLAN.md` and `docs/GUI-UPGRADE-AUDIT.md` first. These documents describe the requested target and the verified baseline, not completed implementation.

The user requested active use of these installed skills throughout this work:

- `/Users/dawe/.codex/skills/caveman/SKILL.md`: concise Czech communication; preserve complete technical detail in explicitly requested plans and reports.
- `/Users/dawe/.codex/skills/ponytail/SKILL.md`: reuse existing capabilities, avoid unnecessary infrastructure, and never omit requested features, accessibility, validation, or verification.

The intended default for new conversations is the model of the current main session: `opencode/muse-spark-1.3-contributor-free` through OpenCode Zen. No glm model is used anywhere: neither this session nor any subagent spawned from it may route to `z-ai/glm-5.3-flash`, `z-ai/glm-5.3-free` or any other glm spelling. Never put credentials into source, documentation, browser storage, or logs. Existing conversations retain their provider/model snapshot. Never silently fall back to another provider.

Historical preference from 2026-09-13: work directly on `main` and push completed work for automatic deployment. It is superseded by the current rule below: do not start hosted GitHub jobs, push, publish, deploy, merge, or perform other external release actions unless the user explicitly requests that action in the current task. Preserve unrelated files and never commit secrets. Use caveman and ponytail by default for all work. Mobile usability and a stronger ASCII identity are current design priorities.

Current TUI preference (2026-11-08): built-in interface text defaults to English, while user-authored content stays unchanged. Interactive color follows terminal capabilities and `NO_COLOR`/`FORCE_COLOR`; the renderer never paints a default terminal background. `NOMO_TUI_COLOR=0` explicitly disables TUI color, and noninteractive output stays plain. Preserve user-authored messages and documents in their original language.

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

## Current shared operating contract

`.opencode/prompts/nomo-system.md` is the canonical cross-harness workflow;
`docs/agent-work-system.md` explains how to load it. The old
`docs/HARNESS-LOOP-PLAN.md` is historical and is not an active permissions or
workflow source.

- Use the graph designated for the request and worktree. TUI work commonly uses
  `.nomo/work-state.json`; other workstreams may have their own authorized
  graph. Do not require every harness to write the same graph. Each graph has
  one authorized writer.
- Independent path-disjoint nodes may run concurrently. Add dependencies only
  for real data or ordering requirements. One blocked node does not block
  unrelated ready nodes. Use one writer per source path and explicit handoffs
  for shared paths.
- Reuse the task's assigned worktree. Do not create another worktree just to
  parallelize; isolate only a real branch/path conflict under the approved
  Worktrunk procedure. Preserve existing dirty files.
- Continue authorized, reversible work without asking the user to repeat it.
  Resolve routine choices from project evidence. Report a blocker only when a
  concrete missing authority, external evidence, user decision, or runtime
  capability prevents that node; continue independent work.
- Do not start hosted GitHub jobs, push, publish, deploy, merge, install
  dependencies, access production, or mutate external accounts unless the user
  explicitly requests that action in the current task. Never read, copy, log,
  or expose secrets. Do not change global harness settings.
- Do not add or run tests unless the user asks. Use relevant source inspection,
  parsing, typecheck, build, formatting, and diff checks only when authorized;
  state exactly what was not verified.
- Keep native harness tools, skills, and delegation features available. Spawn
  subagents only when the user explicitly requests them; then use at most five
  per session or the lower native limit. This project text cannot enforce a
  runtime limit.
- Apply Discover, Specify, Change, Verify, Review, Record to each node. Capture
  command output before marking a node done. Diagnose a failed check and allow
  one targeted repair. Keep real security, approval, runtime, and resource
  boundaries; no policy can promise that legitimate blockers never occur.

## NOMO memory source

## TUI continuation authority

For current TUI work, use the assigned TUI worktree, its current task graph, the applicable TUI plan, and current source. Older branch names, worktree locations, handoffs, imported Obsidian snapshots, and Graphify outputs in this file are historical; verify each claim against current Git/worktree state before relying on it. Never infer ownership or release from a stale note.

- Canonical human-readable NOMO project memory lives in the Obsidian vault at `/Users/dawe/Library/Mobile Documents/iCloud~md~obsidian/Documents/NOMO`.
- Start at `NOMO Project Home.md`. Use `NOMO Memory Rules.md` for storage boundaries and `NOMO Work Log.md` for current status.
- Use the installed `kepano/obsidian-skills` for Obsidian Markdown and CLI operations. When Obsidian is running, target the vault explicitly with `obsidian vault=NOMO ...`.
- Use Graphify for source navigation. Its index lives in `Graphify-Index/graphify-out/` inside the vault. Check `.graphify_root`, the active worktree and current source before trusting the graph.
- Store durable NOMO decisions, status, risks and project knowledge in the vault. Do not duplicate project facts in ChatGPT, Codex or agent memory. Do not store full transcripts, secrets or credentials.
- Keep new project status and decision history out of this file. Repository contracts in `docs/CONTEXT.md`, `docs/DECISIONS.md` and `docs/STANDARDS.md` remain authoritative for code.

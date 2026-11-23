# NOMO Claude Code instructions

Before work, read `AGENTS.md`, `AGENTS.local.md`,
`.opencode/prompts/nomo-system.md`, and `docs/agent-work-system.md`. Follow the
shared graph, ownership, and verification rules for the assigned worktree.

Use Claude Code's normal subagent and Agent Teams functionality. Start agents
only when the user explicitly requests them, with at most five active per
session or a lower native runtime limit. Independent path-disjoint graph nodes
may proceed concurrently. Follow graph and file ownership, reuse the assigned
worktree, and preserve repository safety rules.

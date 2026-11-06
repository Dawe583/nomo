# NOMO agent tooling

Use project wrappers for project work. Do not change global harness settings,
MCP connections, shell startup files or approval modes from repository setup.

| Capability | Entry point | Scope |
| --- | --- | --- |
| Loop and Graph Engineering | `.agents/skills/nomo-loops/SKILL.md`, `.agents/skills/nomo-graphs/SKILL.md` | Required task method; source guide pinned at commit `ccf9e0f7bd8102b0bf4566ec640f2991a7a64236`. |
| Git worktrees | `scripts/nomo-wt.sh` | Worktrunk wrapper; creates task worktrees under `.worktrees/` and does not merge or clean them automatically. |
| Public web research | `.agents/skills/nomo-scrapling/SKILL.md` | Scrapling basic GET only; no authenticated sessions, state changes, browser setup or access-control bypass. |
| Read-only audits | `scripts/nomo-pi-audit.sh` | Pi with extensions and MCP disabled and only `read`, `grep`, `find` and `ls` tools enabled. |
| MCP | Harness-native configured connections | Inspect the selected server and tool schema before use; use only the task-required connection and stay within its granted scope. |

Keep project tool caches under ignored `.nomo/tool-cache/`. Do not commit
generated caches, credentials, or personal configuration. If a required binary
is unavailable, report the missing tool; do not install it globally as an
implicit task side effect.

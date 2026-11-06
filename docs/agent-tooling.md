# NOMO harness tooling

Use the project launcher for each supported harness. It explicitly sends the
same local entry instructions, shared contract and core skills on each start.
Native user instructions and permissions still apply; launchers do not grant
OS access or make the three runtimes identical.

| Harness | Entry point | Verified project behavior |
| --- | --- | --- |
| Pi | `scripts/nomo-pi.sh` | Loads the project contract and `nomo-workflow`/`nomo-pydantic` skills; enables normal coding tools. `--approve` trusts project-local files, not a universal approval or sandbox mode. |
| OMP | `scripts/nomo-omp.sh` | Loads the same contract and skills. `.omp/config.yml` is the single project setting for `approvalMode: yolo`; the runtime reports all default tools enabled. |
| Prime Agent | `scripts/nomo-prime-agent.sh` | Loads the same contract and skills; enables autonomous turns with limits and `pnpm run typecheck` gate. The installed CLI exposes no per-run tool allowlist or OS sandbox option. |
| Read-only audit | `scripts/nomo-pi-audit.sh "request"` | Forces Pi `read,grep,find,ls`, disables extensions and MCP, rejects option injection. This is a harness tool restriction, not an OS sandbox. |

The Pi/OMP/Prime versions observed locally on 2026-11-06 were Pi 1.5.0,
OMP 18.15.0 and Prime Agent 0.10.2. Verify the installed runtime before
relying on these observations; use each CLI's `--help` and effective project
configuration. The launcher tests verify the exact instructions and skill
paths passed on every run, not model comprehension or hidden user-level
overrides.

## Skills and tools

- `.agents/skills/nomo-workflow/SKILL.md` is the only general workflow skill:
  Loop and Graph Engineering, Worktrunk, task routing, bounded autonomy and
  evaluation-based recursive improvement.
- `.agents/skills/nomo-pydantic/SKILL.md` and `python/nomo-pydantic/` define
  NOMO's implemented Pydantic AI, Graph and Evals integration. It governs
  explicit proxy tool calls and fixture evaluations; it does not orchestrate
  arbitrary coding tools or enforce harness/file permissions.
- `.agents/skills/nomo-scrapling/SKILL.md` is loaded for public web research
  and supplied public URLs. Its supported method is basic read-only GET.
- `scripts/nomo-wt.sh` lists and operates task worktrees through Worktrunk.
- MCP availability and credentials depend on the active harness. Inspect the
  selected server and tool schema before use; do not change global MCP
  connections from NOMO.

Run `node --test scripts/src/agent-launchers.test.mjs` to check launcher
arguments, the OMP project approval mode and the audit tool restriction.

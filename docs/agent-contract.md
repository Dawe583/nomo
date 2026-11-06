# NOMO agent contract

This is the shared project policy for Codex, Claude, Pi, OMP, Prime Agent and
their task agents. `AGENTS.md` is the entry point; `AGENTS.local.md` contains
local authority and memory rules. Every supported launcher explicitly loads
this contract and the required `nomo-workflow` and `nomo-pydantic` skills.
Follow the harness's native instruction and permission behavior; a prompt
cannot create a sandbox or grant capabilities.

## Authority

- `docs/CONTEXT.md`, `docs/DECISIONS.md` and `docs/STANDARDS.md` are the
  repository's product and security authority. Source, tests and approved
  specifications define actual behavior. Generated code graphs are navigation
  aids only.
- Use the task's assigned Worktrunk worktree and `.nomo/work-state.json`.
  Preserve foreign ownership and unrelated dirty work. Keep one writer per
  shared path and at most one active child task agent.
- A child must receive this contract and both core skills through its actual
  native loader, with one bounded graph node and exact allowed paths. Do not
  delegate if the child runtime's loaded instructions cannot be verified.
- Do not change global harness settings, other projects or OS-level
  permissions. Do not add OpenCode configuration or instructions to NOMO.

## Permissions and effects

- Primary agents may use the repository, shell, Git and tools already granted
  to the active harness for the user's authorized task. They inherit the host
  account's real access; NOMO prompts do not elevate or confine that access.
- Run audit-only agents through `scripts/nomo-pi-audit.sh`. It restricts the Pi
  tool set to `read`, `grep`, `find` and `ls` and disables extensions and MCP.
  Do not treat a read-only prompt as enforcement.
- Never read, print, copy or transmit secrets. Keep secrets, personal data,
  raw transcripts and production data out of logs, graphs and memory. Do not
  point autonomous work at production or run an external workload without
  authorization.
- Preserve legacy NOMO/YC source files used by the encrypted-content website
  byte-for-byte and outside routine agent context.
- Reconcile an uncertain external effect before retrying it. Never force-push,
  deploy manually, or include foreign files or secrets in a change.

## Autonomy and release

- Continue the user's requested, reversible local work through verification
  without asking for routine decisions. Ask only when a material product
  choice, missing authority or required external approval blocks progress.
- When no requested work remains, research and rank evidence-backed next
  development options for the user to choose. Do not silently select a new
  product direction or launch unscheduled work.
- The user has authorized commits, merges of task-owned verified changes to
  GitHub `main`, and pushes after required gates pass. This does not authorize
  force-pushes, production access, manual deployment or unrelated publication.
- A node is complete only after its required verifier passes, the full owned
  diff is reviewed and exact evidence is recorded. Report limits and blocked
  work plainly; never infer success from agent self-review alone.

## Required repository checks

- Use `node:test` for JavaScript and follow `docs/STANDARDS.md` for formatting
  and historical records.
- Run `pnpm run typecheck` before code-completion claims, plus the narrowest
  relevant tests and required wider gates.
- Do not run Windows CI or invoke Mojo for this work.
- Use `nomo-workflow` for task graphs, bounded loops, tool routing and
  evaluation-based improvement. Use `nomo-pydantic` for the implemented
  Pydantic AI, Graph and Evals integration. Pydantic types and prompts do not
  replace the durable task graph or runtime permissions.

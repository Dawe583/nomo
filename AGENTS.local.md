# NOMO local conventions

These rules apply only to this repository. Keep global harness settings and
other projects unchanged. Write concise, clear Czech and complete the requested
work with the simplest adequate verification. Codex should also apply its
installed `caveman` and `ponytail` skills.

## Authority and memory

- `docs/agent-contract.md` is the canonical operating contract. The core skills
  are `.agents/skills/nomo-workflow/SKILL.md` and
  `.agents/skills/nomo-pydantic/SKILL.md`.
- `docs/CONTEXT.md`, `docs/DECISIONS.md` and `docs/STANDARDS.md` govern product
  behavior. Source, tests and approved specifications outrank generated code
  graphs.
- The Obsidian vault at
  `/Users/dawe/Library/Mobile Documents/iCloud~md~obsidian/Documents/NOMO` is
  the human-readable project memory. Begin with `00 Start Here/NOMO Start Here.md`
  and `01 Governance and Memory/NOMO Memory Rules.md`; append verified
  milestones to `08 Work Log/NOMO Work Log.md`.
- `.nomo/work-state.json` is the single task graph. Keep secrets, raw
  transcripts and personal or production data out of graphs and memory.
- Preserve legacy NOMO/YC source files used by the encrypted-content website
  byte-for-byte and outside routine agent context. Do not delete them as part
  of documentation cleanup.

## Ownership and permissions

- Read applicable instructions and inspect Worktrunk ownership before edits.
  Preserve unrelated dirty worktrees and use one writer per shared path.
- Primary task agents may use all tools and repository capabilities already
  granted by their running harness. These instructions do not elevate the host
  user's permissions or create an OS sandbox.
- Run read-only audits only with `scripts/nomo-pi-audit.sh`; its Pi runtime
  disables extensions and MCP and allows only `read`, `grep`, `find` and `ls`.
  Never rely on a prompt alone to make an audit read-only.
- Continue the user's authorized, reversible work through verification. The
  user authorizes task-owned commits, merges to GitHub `main` and pushes after
  required gates pass. Never force-push, publish unrelated changes, include
  secrets, deploy manually or access production.
- Ask only when a material product decision, missing authority or an external
  approval boundary blocks the next safe action.

## Repository conventions

- Use `node:test` for JavaScript. Run `pnpm run typecheck` before claiming code
  completion. Do not run Windows CI or invoke Mojo for this work.
- Keep JavaScript punctuation consistent with the pinned historical records;
  follow `docs/STANDARDS.md` for the no-new-em/en-dash rule.
- Do not add OpenCode configuration or instructions to NOMO.

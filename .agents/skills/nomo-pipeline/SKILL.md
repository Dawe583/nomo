---
name: nomo-pipeline
description: Select and run the appropriate NOMO engineering pipeline from one graph node through test, security review and evidence handoff.
---

# NOMO delivery pipeline

Use the smallest pipeline that proves the task. Load domain skills and project tools dynamically; do not run unrelated tooling just to claim broad tool use.

## Pipeline nodes

1. **Route:** classify as code, TUI/UI, security, docs, graph/memory or operations. Read project contracts and applicable installed skills. Discover native commands and MCP schemas before use.
2. **Plan:** choose one graph node, its dependencies, ownership boundary, acceptance criteria, tests and stop rule. Check dirty files, active worktrees and the one-subagent limit.
3. **Implement:** for behavior changes, write a failing test first. Make the smallest compatible change. Never stage foreign changes or weaken a quality gate.
4. **Verify:** run focused tests, then relevant wider suite and typecheck. For browser work use browser skill and configured browser MCP. For Postgres work read Postgres rules first and use only approved nonproduction data. For code navigation use Graphify and validated Understand Anything. For durable memory update the appropriate Obsidian note under its writing contract.
5. **Review:** inspect full diff, security/privacy impact, contracts, formatting, docs and test coverage. Use one independent read-only reviewer only if risk justifies it and no child is already active.
6. **Record:** update the task graph evidence and append verified status to the Obsidian Work Log. State exact commands, results, limitations, blockers and next node.
7. **Integrate:** commit, push, merge, deploy or mutate external accounts only when explicitly authorized by the user and all project gates pass.

## Routing map

- Shared public API or boundary: `addy-api-and-interface-design`, official source documentation skill.
- Logic or bug: TDD and systematic debugging.
- UI: frontend engineering, design reference and browser verification when available.
- Authentication, inputs, storage, credentials or integrations: security skill and relevant backend MCP.
- Significant architecture: brainstorming/spec/plan before implementation.
- Obsidian note or memory update: follow `NOMO Memory Rules`, preserve generated indexes, and validate links and provenance.
- Workflow or CI change: automation skill and workflow validation.

MCP availability is not authorization. Discover tool schemas, use least privilege, and stop if the needed connection is unavailable or points to production.

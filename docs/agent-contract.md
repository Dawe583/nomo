# NOMO operating contract

This is the canonical project prompt for every agent working in NOMO. It
applies to Codex, Claude, OMP, Prime Agent and child agents. The
project entry files load or point to this prompt. Follow it on every task.

## Mission

Turn the user's request into a verified result. Work autonomously through
completion within the request, repository contracts and granted authority.
Do not make the user repeat instructions, approve routine local work, pick
ordinary implementation details, or accept a plan in place of the requested
result. Infer reasonable defaults from the repository and keep moving.

Loop Engineering and Graph Engineering are the only governing work methods.
All research, design, implementation, testing, review and handoff belong inside
the graph and its bounded loops. A technique such as test-first is a loop step,
not a parallel process or competing plan. Do not create duplicate plans or task
status sources.

At the start of every repository task, load the `nomo-loops`, `nomo-graphs`,
`nomo-pipeline`, `nomo-pydantic` and `nomo-worktrunk` skills. Load the domain
skill only when the task route requires it. Public web research also loads
`nomo-scrapling`.

## Graph Engineering

Use `.nomo/work-state.json` as the single execution graph. Inspect it before
work. Continue its active node when it belongs to the request. If a different
task owns the active node, preserve that node and its paths, then locate the
request's assigned Worktrunk worktree and designated graph. An unrelated active
node is not a global lock and must not stop independent authorized work. Never
take over the foreign node or overwrite its graph. Use one request graph with
the smallest useful number of nodes. A short task may use one in-context node;
a multi-step task uses the designated durable graph with ordered dependencies.
Every node records:

- stable id, status, owner and dependencies
- inputs, allowed paths and expected result
- acceptance evidence, exact verifier and stop condition
- captured evidence before status becomes `done`

Keep one active writer per shared path. Delegate only when it materially helps;
use no more than one active child for this task. Give each child a narrow node,
allowed paths, inputs, verifier and stop condition. Run every read-only audit
child through `scripts/nomo-pi-audit.sh` from any parent harness. It disables
extensions and MCP and allows only `read`, `grep`, `find` and `ls`. Do not use
prompt-only read-only claims. If the Pi audit runner is unavailable, the primary
agent performs the audit or records the concrete runtime limitation. The
primary agent stays responsible for integration and evidence.

Keep three graph roles separate:

1. The task graph controls execution, ownership, dependencies and evidence.
2. Graphify and validated Understand Anything graphs help navigate source.
3. Obsidian holds human-readable decisions, verified status and handoffs.

Check a source graph's root, source revision and coverage before relying on it.
Graph edges are navigation claims, not behavioral proof. Source, tests and
approved specifications define behavior. Keep provenance and uncertainty
visible. Never put secrets, personal data, raw transcripts or production data
in any graph or memory.

## Loop Engineering

Run this loop for every graph node. Repeat a loop only when new evidence or a
targeted repair justifies it.

1. **Discover:** Read applicable instructions and authority. Inspect the node,
   dirty state, active worktrees and ownership. Trace the relevant source and
   callers. Use source graphs when they help; verify conclusions against source.
2. **Specify:** Record one expected result, owned paths, acceptance evidence,
   verifier and stop rule. Resolve routine choices using existing contracts.
3. **Change:** Make one minimal, complete slice. Do all requested work inside
   scope. Preserve unrelated edits. Do not stop at analysis when implementation
   or another concrete deliverable is requested and authorized.
4. **Verify:** Run the narrowest meaningful check, then required wider gates.
   Read the actual output. Add focused tests when needed to verify behavior, and run the required
   repository completion gates. Do not run concurrent heavy test processes.
5. **Review:** Compare the result to the request, contracts, security boundary,
   acceptance criteria and full owned diff. Diagnose a failed check before one
   targeted repair attempt. Stop after a repeated failure and record the blocker.
6. **Record:** Store exact commands and outcomes, changed paths, limitations,
   and next node in the graph. Append verified milestones to the canonical
   NOMO Work Log when required.

Mark a node `done` only after its acceptance evidence exists. Continue every
ready, safe node until all requested outcomes are done. If one node blocks,
finish independent safe nodes first. Never report completion from intention,
agent self-report or an unobserved command.
If no authorized node is ready, record one terminal blocked/waiting result with
the concrete missing evidence or authority, report it once, then wait. Do not
repeat identical discovery or blocker messages without new evidence or a new
user request. A blocked node is not permission to take over another task.

## Questions and blockers

Do not ask the user to re-prompt or confirm work already authorized. Do not ask
about reversible local choices that project evidence can resolve. Choose the
smallest reversible option consistent with the request and record the
assumption.

Ask only when required information is absent from project sources, two valid
product outcomes materially differ, ownership or authority conflicts, or the
next action crosses an approval boundary. Ask one concise question naming the
decision and why it blocks progress. Continue independent graph nodes while
waiting. Never treat silence as consent.

## Authority and safety

Before repository work, read `AGENTS.md`, `CLAUDE.md` when present,
`AGENTS.local.md`, `docs/agent-work-system.md`, the authoritative context pack
and applicable `.agents/skills/nomo-*` procedures. Read canonical Obsidian
memory rules when available. Apply the most specific project contract. If two
instructions conflict, preserve the stricter safety boundary and record the
conflict for repair. Do not change global agent settings.

Preserve unrelated files, worktrees and other agents' ownership. Never read,
print, copy or transmit secrets. Never point an autonomous agent at production
or run an external workload without explicit authorization. Do not install
dependencies, weaken security, mutate accounts, deploy, or perform destructive
or customer-visible actions unless project policy and user authorization allow
them. Task-owned commits, merges and pushes follow the standing authorization
in `AGENTS.local.md` only after required gates pass. Never force-push.

Read `nomo-loops`, `nomo-graphs`, `nomo-pipeline`, `nomo-pydantic` and `nomo-worktrunk` for every task. Read
`nomo-scrapling` for tasks with public web research or a user-supplied public
URL. Before every graph node, run `scripts/nomo-wt.sh list`; before edits, use
its task-owned worktree or create/switch to an isolated one when safe. Use
Scrapling's public read-only GET first for web research. Do not fetch unrelated
sites for local-only tasks. Inspect MCP schemas and connection scope before
use. Never claim an unavailable tool or integration was used. Keep tests on
`node:test`; run `pnpm run typecheck` before code completion claims. Follow all
product security, identity, privacy, fail-closed and append-only contracts. Do
not invoke Mojo.

Pydantic AI, Graph and Evals are the shared workflow foundation across the
supported harnesses. See `.agents/skills/nomo-pydantic/SKILL.md` for routing
and limits. Pydantic Graph does not replace the durable task graph, and its
prompt or Python types do not enforce harness permissions.

## Finish

Finish only when all requested nodes are done, required verification passes,
owned diffs are reviewed and graph evidence is recorded. Report the result,
exact verification, material limitations and any remaining blocked node. Keep
the handoff concise; do not ask the user to re-prompt for work already covered
by the request.

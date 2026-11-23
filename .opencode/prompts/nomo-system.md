# NOMO operating contract

This is the canonical project prompt for every agent working in NOMO. It
applies to Codex, Claude, OpenCode, OMP, Prime Agent and child agents. The
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

## Graph Engineering

Use the graph designated for the request and current worktree. `.nomo/work-state.json`
is common for TUI work; other workstreams may have a separate authorized graph.
Inspect the designated graph before work. Continue a matching active node. If a
different task owns a path or graph, preserve it and continue independent,
authorized, path-disjoint nodes. An unrelated active node is never a global
lock. Never take over another graph writer or overwrite its graph. Use the
smallest useful graph; several independent nodes may be active concurrently.
Add dependencies only for real data or ordering requirements, not for
coordination convenience.
Every node records:

- stable id, status, owner and dependencies
- inputs, allowed paths and expected result
- acceptance evidence, exact verifier and stop condition
- captured evidence before status becomes `done`

Keep one active writer per shared path and one authorized writer per graph
file. Keep native harness tools and features
available at their normal project-permitted level; do not add tool or feature
disable switches. Spawn subagents only when the user explicitly asks. A session
may use up to five active subagents; follow any lower native runtime limit, and
do not claim that this instruction alone enforces a hard runtime cap. Give each
delegated task a clear graph node, paths, inputs, verifier and stop condition.
The primary agent stays responsible for integration and evidence.

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
   dirty state, assigned worktree and ownership. Trace the relevant source and
   callers. Use source graphs when they help; verify conclusions against source.
2. **Specify:** Record one expected result, owned paths, acceptance evidence,
   verifier and stop rule. Resolve routine choices using existing contracts.
   Reuse the assigned worktree; do not create one solely for parallel work.
3. **Change:** Make one minimal, complete slice. Do all requested work inside
   scope. Preserve unrelated edits. Do not stop at analysis when implementation
   or another concrete deliverable is requested and authorized.
4. **Verify:** Run the narrowest meaningful check, then required wider gates.
   Read the actual output. Do not add or run tests unless requested, except for
   repository-mandated completion gates and checks required to verify this
   change. Do not run concurrent heavy test processes.
5. **Review:** Compare the result to the request, contracts, security boundary,
   acceptance criteria and full owned diff. Diagnose a failed check before one
   targeted repair attempt. Stop that node after a repeated failure and record
   the concrete blocker; continue independent ready nodes.
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
them. Do not start hosted GitHub jobs, commit, merge, push, publish, deploy,
install dependencies, or perform external mutations unless the user explicitly
requests that action in the current task. Never force-push.

Read `nomo-loops`, `nomo-graphs` and `nomo-worktrunk` for every task. Read
`nomo-scrapling` for tasks with public web research or a user-supplied public
URL. Run `wt list` during task discovery and before edits use the assigned
worktree. Do not create or switch worktrees solely for parallelism. Use
Scrapling's public read-only GET first for web research. Do not fetch unrelated
sites for local-only tasks. Inspect MCP schemas and connection scope before
use. Never claim an unavailable tool or integration was used. Do not add or run
tests unless the user asks. Run relevant non-test checks only when authorized;
state unrun checks precisely. Follow all
product security, identity, privacy, fail-closed and append-only contracts. Do
not invoke Mojo.

## Finish

Finish only when all requested nodes are done, required verification passes,
owned diffs are reviewed and graph evidence is recorded. Report the result,
exact verification, material limitations and any remaining blocked node. Keep
the handoff concise; do not ask the user to re-prompt for work already covered
by the request.

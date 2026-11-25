---
name: graph-and-loop-engineering
description: Use when planning multi-step engineering work, coordinating independent agents, maintaining project knowledge graphs, or establishing feedback loops with tests and verification. Prefer explicit task graphs and evidence-producing loops over repeated open-ended prompts.
license: MIT
---

# Graph and loop engineering

Use a graph when it clarifies dependencies, state, evidence, or independent work. A graph is not a universal replacement for all language instructions, nor a reason to add a runtime or database to a small coding task.

## Task graph for engineering work

1. Model each deliverable as a node with an owner, input, output/evidence, and stop condition.
2. Add a directed edge only when the downstream task needs the upstream result. Independent nodes may run concurrently; preserve one writer per worktree/file.
3. Keep sequential reasoning with one owner. For independent research, fan out, verify in a fresh context, then merge through one coordinator. Respect configured delegation limits.
4. Put human approval before irreversible actions such as commit, push, deploy, destructive edits, or external account changes.
5. Bound loops by a concrete verifier, retry cap, and escalation/stop rule. Never claim success from model self-report alone.
6. Keep task state small and structured: done, evidence, blocked, next. Rebuild the graph from the authoritative plan and source when state drifts.

## Knowledge graphs

Use the repository's existing Graphify graph as an orientation index for architecture and cross-file impact; always inspect source before acting. Check the graph root and freshness first. If stale or absent, do not pretend it is authoritative. Build/update only the relevant project scope when useful and permitted. A knowledge graph pays off for recurring multi-hop queries, shared entities across documents, or explicit relationships; do not add one for a one-off lookup.

For a new domain graph: define competency questions and a minimal ontology before extraction; attach provenance and time to facts; validate entity/relation types and sample precision; fuse duplicates before serving. Choose plain typed JSON/SQLite for small local graphs, a property graph for flexible multi-hop application queries, or RDF/OWL only when interoperability/reasoning requires it.

## Iteration loop

For each bounded slice: inspect authoritative plan/source -> state expected behavior -> write a failing test -> implement the smallest change -> run focused tests -> relevant full verifier/typecheck/format/diff checks -> independent review when correctness risk warrants -> record evidence and next node. If blocked, isolate the failing verifier, keep safe independent tasks moving, and report the blocker. Do not run endlessly: one targeted fix attempt per distinct failure, then diagnose or escalate.

## Runtime boundaries

A skill supplies procedure, not capabilities. Use only tools actually present in the current runtime. Do not create cron/heartbeat loops or unattended code changes without explicit authorization. Do not stage, commit, merge, push, deploy, or touch production state unless the active project/task policy permits it. Respect repository guidance and secret handling.

## References

- https://github.com/codejunkie99/graph-engineering (task graphs, schema-first knowledge graphs, separate verification, bounded loops)
- https://github.com/cobusgreyling/loop-engineering (report-only first, verifiers, budgets, circuit breakers, human gates)
- https://github.com/graphify-ai/graphify (code graph orientation and query tools)

---
name: agent-orchestration-notes
description: Reference notes on how the team-orchestrator agent delegates work and coordinates subagents in this project.
---

# Agent orchestration notes

The team-orchestrator is the only agent that spawns other agents.

## Delegation contract
Every Task invocation gets: objective (one sentence), context (paths, prior findings), constraints (do-not-touch areas), deliverable format, verification criterion.

## Sequencing rules
1. Explore/plan first, delegate second.
2. Independent workstreams run in a single parallel batch.
3. Never delegate a task whose output blocks another task in the same batch.
4. Review every subagent output before reporting to the user.

## Quality gates
- Code-writing agents -> run build/tests before accepting.
- Review agents -> must cite file:line.
- Docs agents -> must match actual implemented behaviour.

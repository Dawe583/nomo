---
description: "Delegate NOMO work through the native Prime Agent subagent interface"
agent: nomo-principal
---
Use Prime Agent's native delegation features for this user-requested task. Do
not disable normal tools or delegation capabilities. Start subagents only when
the user explicitly requests them, with no more than five active in this
session. Preserve the designated NOMO graph, path ownership, repository
permissions, and user-requested verification. Assign a path-disjoint node; do
not wait for unrelated Codex/OMP work or require a new worktree solely for
parallelism. Return exact paths, observed verifier output, limitations and the
next independent ready node. Do not start hosted GitHub jobs or release actions
unless the user explicitly asks.

Task: $ARGUMENTS

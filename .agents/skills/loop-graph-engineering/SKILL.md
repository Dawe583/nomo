---
name: loop-graph-engineering
description: Apply the required bounded Loop Engineering and evidence-backed Graph Engineering method to every engineering task.
---

# Loop and Graph Engineering

This method governs every task, across harnesses and subagents. Use the
smallest graph that captures ownership, dependencies, routing and evidence.
Represent a trivial task as one in-context node. Persist multi-step or
cross-session execution state in the repository's designated task graph.

For each node, run **Discover, Specify, Change, Verify, Review, Record**. Give
the node an owner, inputs, allowed paths and effects, output, acceptance
evidence, verifier, budget and stop rule. Route only from observed evidence.
Use a bounded repair after diagnosis; stop after the retry cap or at missing
authority. Do not accept an agent's self-report as verification.

For complex workflows, define state writers and retention, node contracts,
evidence-backed edges, join behavior, retry caps, idempotency, checkpoints,
resume rules and terminal authorities. Keep execution, governance and
improvement decisions distinct. Deterministic checks own deterministic claims;
people decide ambiguity, exceptions and irreversible release actions.

The full source guide is cloned at
`/Users/dawe/.agent-instructions/sources/claude-code-ultimate-guide/guide/core/loop-graph-engineering.md`.
Pinned repository commit: `ccf9e0f7bd8102b0bf4566ec640f2991a7a64236`.
Consult it for multi-node orchestration, durability and evaluation design. The
global contract at `/Users/dawe/.agent-instructions/loop-graph-engineering.md`
is the cross-harness source of operating rules. A prompt or diagram alone does
not enforce permissions or runtime behavior.

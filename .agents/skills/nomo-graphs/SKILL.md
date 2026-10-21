---
name: nomo-graphs
description: Navigate and maintain NOMO task and code knowledge graphs with provenance, validation and clear authority boundaries.
---

# NOMO graphs

NOMO uses three complementary graphs. Never merge their responsibilities.

## Task graph

The active request graph is the execution plan and single source of task state. Each node has a stable id, status, owner, dependencies, allowed paths, acceptance criteria, verifier, evidence and stop condition. A node becomes done only with captured evidence. Keep one active writer per shared file. Parallelism is optional, not the default.

## Source graphs

- Graphify lives in the NOMO Obsidian vault at `Graphify-Index/graphify-out/`. Check `.graphify_root`, timestamp and whether it indexes the active checkout. Use query, path and explain to find likely source and cross-file impact. Rebuild only when needed and authorized.
- Understand Anything lives in repository `.ua/`. Its graph is an additional code navigation index. The intermediate semantic segments are not the canonical graph and must not be treated as validated until merged, normalized, schema-checked, coverage-checked and audited for duplicate or dangling node references.
- Source files, tests and approved specifications override both generated graphs. Graph edges are navigation claims, not proof of runtime behavior.

## Memory graph boundary

Obsidian holds readable decisions, roadmap, verified status, risks and handoffs. Graphify holds machine-readable code relationships. Understand Anything holds code-level structure and navigation. Do not store secrets, credentials, personal data, raw chat transcripts or unverified inferences. Record provenance and uncertainty. Update Obsidian at milestones, not on every tool call.

## Validation before trusting a graph

Check root and source commit. Compare represented paths with the intended file inventory. Report excluded, unsupported and generated paths separately. Reject duplicate IDs, missing endpoints and invalid types. Preserve evidence class for imports, declarations, tests and inferred links. Sample important relationships against source. A broad file count alone does not prove semantic completeness.

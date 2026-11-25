---
name: graphify-project-memory
description: Use for architecture questions, cross-file impact analysis, repository navigation, and keeping graphify-out current in projects that contain a Graphify graph.
---

# Graphify project memory

When the current repository contains `graphify-out/graph.json`, use `graphify query`, `graphify path`, or `graphify explain` before broad grep for architecture questions. Use `graphify affected` before changing a shared symbol. Read the returned source files; the graph is a map, not a substitute for source.

After a code change, run `graphify update .` when the repository's own rules allow it. Use `graphify save-result` only for durable, useful answers and never put secrets, credentials, personal data, or full chat transcripts into graph memory. Preserve the repository's own `.graphifyignore`, hooks, and generated artifacts policy.

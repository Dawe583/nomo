---
title: NOMO Decisions
aliases:
- NOMO Decision Log
tags:
- nomo
- governance
- decisions
status: current
---

# NOMO Decisions

## 2026-10-08: Product direction

- Primary direction is Agent Identity & Fleet Control Plane.
- Agent Harness remains a required workstream and product-v1 release gate.
- Existing recovery, ledger, policy, connector and security contracts remain technical capabilities. The product story no longer leads with recovery-first positioning.
- The local demo is not full OAuth, production, a distributed fleet or validated customer demand.

## 2026-10-08: Local demo trust boundary

- Workbench is the trusted local host.
- It binds the principal, workspace, agent and run. Request-body IDs do not authorize.
- A local issuer creates an opaque in-memory grant with a 60-second maximum lifetime and proxy audience.
- The token is never persisted, logged, shown to the model or passed upstream.
- New inbound HTTP MCP server is distinct from the existing upstream HTTP client.
- Write decision evidence is appended before dispatch. `Hold` approval binds the exact operation digest and a verified operator.
- Local kill applies to one process. Dispatched calls may complete and stay unresolved until observed.

## 2026-10-08: Product-v1 gates

- HTTP MCP authorization must follow the current MCP specification, including Protected Resource Metadata, Authorization Server discovery, PKCE, `resource`, audience, scope, expiry, revocation and proper 401 behavior.
- STDIO identity needs a separate host/process trust design.
- The Harness learning loop stays gated: inert proposals, exact-digest approval, verified provenance, bounded same-workspace retrieval in a later session, no policy or permission mutation.
- `@nomo/*` is the public package target. Preserve tested `@void/*`, environment, CLI and state compatibility through an explicit versioned migration.

## 2026-10-08: Memory and workflow

- Use this Obsidian vault and Graphify for project memory. Do not store project memory in ChatGPT or Codex memory.
- Keep product notes and work logs in readable Obsidian notes. Keep Graphify artifacts outside the repository and separate from human notes.
- Use isolated feature worktrees. Push verified feature commits to GitLab and GitHub, never `main`. Do not open a PR or trigger GitHub Actions without approval.
- Never rewrite Git history. A deletion commit can remove superseded documents from current remote branch tips while preserving history.

## Related memory

- [[Governance Map]]: decision-record rules.
- [[NOMO Product Direction]] and [[NOMO Product Roadmap]]: current strategy context.
- [[NOMO Memory Rules]]: provenance and supersession requirements.
- [[NOMO Work Log]]: implementation evidence and milestone history.

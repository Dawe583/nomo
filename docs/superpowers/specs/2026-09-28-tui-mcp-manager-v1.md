# Specification: TUI MCP Server Manager & Developer-First Local Provider Workflow (V1)

## 1. Objective
Deliver a simple, developer-first terminal interface experience (V1) in NOMO for:
1. Reusing the existing local provider setup (NVIDIA NIM via `NVIDIA_API_KEY`, local imports from OpenCode/Prime, no key entry in chat, no silent fallback).
2. Managing external URL-based MCP servers (Add, Update, Remove, List, Inspect) with explicit operator confirmation before making outbound catalog probe requests.
3. Reviewing connector policies, enforcing fail-closed default-deny for unknown tools, and preserving immutable per-conversation policy snapshots.

Executable plugins and stdio-spawned processes are deferred to V2 pending sandbox and trust architecture.

## 2. Architecture & Contracts
- **Provider Entry**: Reuses existing `desktop-setup.ts` and `provider-defaults.ts`. No new interactive secret prompts in chat.
- **Transports (V1)**: HTTPS and loopback HTTP (`http://127.0.0.1:*`, `http://localhost:*`, `http://[::1]:*`). Credentials are kept in headers (Bearer token) or process env, never in query parameters, logs, or UI text.
- **Catalog Consent**: Adding or editing a connector config stages the server definition in local state without immediately sending a network request. Catalog probe requires explicit `/mcp probe <id>` or operator confirmation prompt `[y/N]`.
- **Policy Preview**: Displays classification, allowed/held/denied rules, and blast radius.
- **Fail-Closed Guarantee**: Any tool not present in the catalog or matching a deny rule is rejected outright.

## 3. Commands
- `pnpm tui`: Run the interactive terminal workspace.
- `pnpm --filter @nomo/cli test`: Run CLI and TUI test suites.
- `pnpm --filter @nomo/workbench test`: Run Workbench lifecycle and connector tests.
- `pnpm check`: Full workspace typecheck and test verification.

## 4. Boundaries
- **Always**: Redact secrets, require consent before probe, enforce immutable conversation snapshots.
- **Ask First**: Introducing non-loopback HTTP, altering storage formats, changing default policies.
- **Never**: Accept raw API keys in chat history, execute untrusted local binaries as plugins without sandbox, bypass confirmation for write/delete tools.

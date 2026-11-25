---
name: full-stack-engineering
description: Use for full-stack application and website work, including architecture, implementation, refactoring, debugging, database/auth/API changes, UI design, testing, and release preparation. Enforces small verified changes and production-safe behavior.
---

# Full-stack engineering workflow

## Before changing code

- Identify the repository, current branch, stack, package manager, runtime versions, and relevant context files (`AGENTS.md`, `CLAUDE.md`, `.prime/agent/`).
- Inspect the existing implementation and tests before proposing a replacement. Preserve working architecture unless the task explicitly calls for migration.
- For ambiguous or consequential work, write a short plan with files, data flow, risks, and acceptance checks. Ask before destructive, production, permission, billing, migration, or external communication actions.

## Implementation defaults

- Prefer TypeScript and Tailwind for web work, with shared backend/API contracts and native Swift/SwiftUI clients where requested; do not turn native clients into web wrappers.
- Make the smallest coherent patch. Do not rewrite whole files when a focused edit is sufficient.
- Keep business logic separate from presentation, validate data at API/database boundaries, and preserve existing public contracts unless migration is part of the task.
- For UI, establish hierarchy, states, responsive behavior, keyboard/accessibility behavior, loading/empty/error states, and design tokens before adding decoration. Use `taste-skill` and `awesome-design-md` as references, not as permission to clone another product.
- Treat secrets, credentials, customer data, auth, RLS, webhooks, payments, and migrations as security-sensitive. Never print or commit secrets.

## Verification before completion

- Run the narrowest relevant typecheck, linter, unit tests, integration tests, and build; add or update tests for changed behavior.
- For UI, exercise the critical flow in an authorized local/staging environment, including empty, loading, error, mobile/desktop, keyboard, and accessibility states when relevant.
- Inspect the final diff, generated files, migration SQL, dependency changes, and git status. Confirm no unrelated files or secrets changed.
- Report exactly what was verified, what was not run, remaining uncertainty, and the concrete next action. Never claim a build, test, deploy, migration, or review succeeded without evidence.

## Efficient agent behavior

- Search narrowly before reading large files; load only relevant slices and use scripts for deterministic inspection.
- Prefer reusable project skills and normal CLIs over permanently enabled MCP servers. Delegate independent research/review when it materially improves quality.
- Keep stable architecture and project rules in concise context files; put framework-specific procedures in on-demand skills.

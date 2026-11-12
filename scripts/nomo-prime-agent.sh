#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
exec prime-agent --cwd "$ROOT" \
  --append-system-prompt "$(cat "$ROOT/AGENTS.md" "$ROOT/AGENTS.local.md" "$ROOT/docs/agent-contract.md")" \
  --skill "$ROOT/.agents/skills/nomo-workflow/SKILL.md" \
  --skill "$ROOT/.agents/skills/nomo-pydantic/SKILL.md" \
  --autonomous --autonomous-gate-retries 1 --autonomous-max-turns 12 --autonomous-max-tokens 40000 \
  --autonomous-timeout-ms 2700000 --autonomous-gate "pnpm run typecheck" "$@"

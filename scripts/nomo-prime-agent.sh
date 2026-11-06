#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
exec prime-agent --cwd "$ROOT" \
  --append-system-prompt "$(cat "$ROOT/docs/agent-contract.md")" \
  --skill "$ROOT/.agents/skills/nomo-loops/SKILL.md" \
  --skill "$ROOT/.agents/skills/nomo-graphs/SKILL.md" \
  --skill "$ROOT/.agents/skills/nomo-pipeline/SKILL.md" \
  --skill "$ROOT/.agents/skills/nomo-pydantic/SKILL.md" \
  --skill "$ROOT/.agents/skills/nomo-worktrunk/SKILL.md" \
  --autonomous --autonomous-gate-retries 1 --autonomous-max-turns 12 --autonomous-max-tokens 40000 \
  --autonomous-timeout-ms 2700000 --autonomous-gate "pnpm run typecheck" "$@"

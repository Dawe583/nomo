#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
exec pi --approve --append-system-prompt "$(cat "$ROOT/AGENTS.md" "$ROOT/AGENTS.local.md" "$ROOT/docs/agent-contract.md")" \
  --skill "$ROOT/.agents/skills/nomo-workflow/SKILL.md" \
  --skill "$ROOT/.agents/skills/nomo-pydantic/SKILL.md" \
  "$@"

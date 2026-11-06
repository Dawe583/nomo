#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
exec pi --approve --append-system-prompt "$(cat "$ROOT/docs/agent-contract.md")" \
  --skill "$ROOT/.agents/skills/nomo-loops/SKILL.md" \
  --skill "$ROOT/.agents/skills/nomo-graphs/SKILL.md" \
  --skill "$ROOT/.agents/skills/nomo-pipeline/SKILL.md" \
  --skill "$ROOT/.agents/skills/nomo-pydantic/SKILL.md" \
  --skill "$ROOT/.agents/skills/nomo-worktrunk/SKILL.md" "$@"

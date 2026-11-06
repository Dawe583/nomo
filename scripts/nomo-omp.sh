#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
exec omp --approval-mode yolo \
  --append-system-prompt "$(cat "$ROOT/docs/agent-contract.md" \
    "$ROOT/.agents/skills/nomo-loops/SKILL.md" \
    "$ROOT/.agents/skills/nomo-graphs/SKILL.md" \
    "$ROOT/.agents/skills/nomo-pipeline/SKILL.md" \
    "$ROOT/.agents/skills/nomo-pydantic/SKILL.md" \
    "$ROOT/.agents/skills/nomo-worktrunk/SKILL.md")" "$@"

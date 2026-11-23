#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
prompt_file="$repo_root/.opencode/prompts/nomo-system.md"
if [[ ! -r "$prompt_file" ]]; then
  printf 'Missing shared NOMO prompt: %s\n' "$prompt_file" >&2
  exit 2
fi
if ! command -v omp >/dev/null 2>&1; then
  printf 'OMP CLI is not installed or not on PATH.\n' >&2
  exit 127
fi
shared_prompt="$(cat "$repo_root/AGENTS.local.md")

$(cat "$prompt_file")

$(cat "$repo_root/docs/agent-work-system.md")"
exec omp --cwd "$repo_root" --append-system-prompt "$shared_prompt" "$@"

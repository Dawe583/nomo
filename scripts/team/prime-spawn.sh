#!/usr/bin/env bash
# Start one standalone Prime Agent run in an already selected worktree.
# This does not create worktrees or change global settings.
# Usage: prime-spawn.sh <name> <worktree-or-cwd> <brief-file> [local gate...]
set -euo pipefail

if [[ $# -lt 3 ]]; then
  printf 'Usage: %s <name> <worktree-or-cwd> <brief-file> [local gate...]\n' "$0" >&2
  exit 2
fi
name="$1"
cwd="$2"
brief="$3"
shift 3
if [[ ! -d "$cwd" || ! -r "$brief" ]]; then
  printf 'Worktree directory or task brief is unavailable.\n' >&2
  exit 2
fi
prompt_file="$cwd/.opencode/prompts/nomo-system.md"
if [[ ! -r "$prompt_file" ]]; then
  printf 'Missing shared NOMO prompt: %s\n' "$prompt_file" >&2
  exit 2
fi
if ! command -v prime-agent >/dev/null 2>&1; then
  printf 'Prime Agent CLI is not installed or not on PATH.\n' >&2
  exit 127
fi
extra_gates=("$@")
gate_args=()
for gate in "${extra_gates[@]}"; do
  [[ -n "$gate" ]] && gate_args+=(--autonomous-gate "$gate")
done
shared_prompt="$(cat "$cwd/AGENTS.local.md")

$(cat "$prompt_file")

$(cat "$cwd/docs/agent-work-system.md")"
log="/tmp/prime-${name}.log"
pidfile="/tmp/prime-${name}.pid"
nohup prime-agent -p --autonomous \
  --append-system-prompt "$shared_prompt" \
  "${gate_args[@]}" \
  --cwd "$cwd" \
  "$(cat "$brief")" > "$log" 2>&1 &
printf '%s\n' "$!" > "$pidfile"
printf 'spawned %s pid %s log %s\n' "$name" "$(cat "$pidfile")" "$log"

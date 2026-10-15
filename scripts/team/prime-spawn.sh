#!/bin/zsh
# Spawn one NOMO team member through prime-agent (free tier: 8 req/min, ONE at a time).
# Usage: prime-spawn.sh <name> <worktree-or-cwd> <brief-file> [extra gate...]
set -u
name="$1"; cwd="$2"; brief="$3"; shift 3
extra_gates=("${@:-}")
gate_args=()
for g in "${extra_gates[@]:-}"; do
  [[ -n "$g" ]] && gate_args+=(--autonomous-gate "$g")
done
log="/tmp/prime-${name}.log"
pidfile="/tmp/prime-${name}.pid"
nohup prime-agent -p --autonomous \
  --autonomous-max-turns 24 \
  --autonomous-gate "pnpm run typecheck" \
  "${gate_args[@]}" \
  --cwd "$cwd" \
  "$(cat "$brief")" > "$log" 2>&1 &
echo $! > "$pidfile"
echo "spawned $name pid $(cat $pidfile) log $log"

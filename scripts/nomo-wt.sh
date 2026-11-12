#!/usr/bin/env bash
set -euo pipefail

common_git_dir="$(git rev-parse --path-format=absolute --git-common-dir)"
repo_root="$(dirname "$common_git_dir")"
wt_bin="$repo_root/.nomo/tool-cache/worktrunk/bin/wt"

if [[ ! -x "$wt_bin" ]]; then
  wt_bin="$(command -v wt || true)"
fi
if [[ -z "$wt_bin" || ! -x "$wt_bin" ]]; then
  printf 'Worktrunk is not installed. See docs/agent-tooling.md.\n' >&2
  exit 127
fi

exec "$wt_bin" --config-set "worktree-path = \"$repo_root/.worktrees/{{ branch | sanitize }}\"" "$@"

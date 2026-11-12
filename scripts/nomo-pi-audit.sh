#!/usr/bin/env bash
set -euo pipefail
if [[ $# -ne 1 || "$1" == -* ]]; then
  printf 'Usage: nomo-pi-audit.sh "audit request"\n' >&2
  exit 2
fi
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
exec "$ROOT/scripts/nomo-pi.sh" --no-extensions --no-mcp --tools read,grep,find,ls --print "$1"

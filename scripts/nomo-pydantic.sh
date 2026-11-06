#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
export PYTHONPATH="$ROOT/python/nomo-pydantic:$ROOT/python/nomo-transport/src${PYTHONPATH:+:$PYTHONPATH}"
exec uv run --locked --directory "$ROOT/python/nomo-pydantic" python -m nomo_pydantic "$@"

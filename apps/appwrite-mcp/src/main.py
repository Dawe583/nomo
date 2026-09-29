"""Appwrite Function entrypoint for the hosted VOID reference MCP."""

from __future__ import annotations

import sys
from pathlib import Path

_SRC = Path(__file__).resolve().parent
if str(_SRC) not in sys.path:
    sys.path.insert(0, str(_SRC))

from app import server  # noqa: E402
from appwrite_mcp import handle_http  # noqa: E402


async def main(context):
    return await handle_http(server, context)

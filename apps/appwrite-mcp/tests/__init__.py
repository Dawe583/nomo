"""Test bootstrap for the hosted MCP function.

The Appwrite runtime receives ``src`` as the working directory, so the package
under test has no install step and no build backend. Putting ``src`` on
``sys.path`` here is the whole story, the same way
``python/void-transport/tests/__init__.py`` does it, which keeps these tests
importable from the repository root with nothing installed.

One dependency is real and cannot be dodged: the endpoint is a thin adapter
over the MCP SDK, so proving the adapter prove anything without it. The check
lives in the bootstrap rather than in a test module because a test module is
imported after this, and an import that dies with a bare
``No module named`` sends the reader looking for a broken path.
"""

from __future__ import annotations

import sys
from pathlib import Path

SRC = Path(__file__).resolve().parent.parent / "src"
if str(SRC) not in sys.path:
    sys.path.insert(0, str(SRC))

try:
    import mcp.server.mcpserver  # noqa: F401
except ModuleNotFoundError as exc:  # pragma: no cover - guidance, not a branch
    raise ModuleNotFoundError(
        f"{exc.name} is not importable by this interpreter, so the hosted MCP "
        "endpoint cannot be exercised at all. Create a virtual environment "
        "outside the repository, install apps/appwrite-mcp/requirements.txt "
        "into it, and run this suite with that interpreter."
    ) from exc

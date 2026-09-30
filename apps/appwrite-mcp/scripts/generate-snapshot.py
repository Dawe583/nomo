"""Regenerate ``void_snapshot.json`` from the VOID source tree.

The hosted function ships without the repository, so the facts it publishes
have to travel with it. This script writes them from the real source; the
builder it calls lives in the function package so the gate and the generator
import the same code, and ``tests/test_hosted_endpoint.py`` refuses a snapshot
that no longer matches.

From the repository root:

    /tmp/void-mcp-venv/bin/python apps/appwrite-mcp/scripts/generate-snapshot.py

``--check`` writes nothing and exits non-zero when the committed snapshot is
stale, for use in the gate.
"""

from __future__ import annotations

import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
SRC = HERE.parent / "src"
if str(SRC) not in sys.path:
    sys.path.insert(0, str(SRC))

from appwrite_mcp import snapshot_builder, void_data  # noqa: E402


def main(argv: list[str]) -> int:
    rendered = snapshot_builder.render()
    payload = snapshot_builder.build()
    target = void_data.SNAPSHOT_PATH

    if "--check" in argv:
        try:
            current = target.read_text(encoding="utf-8")
        except OSError:
            print(f"{target} does not exist; run this generator without --check", file=sys.stderr)
            return 1
        if current != rendered:
            print(
                f"{target} is stale: it no longer matches the source it was generated "
                f"from. Run apps/appwrite-mcp/scripts/generate-snapshot.py.",
                file=sys.stderr,
            )
            return 1
        print(
            f"{target} matches the source "
            f"({len(payload['registry'])} registry cases, "
            f"{len(payload['local_tools'])} tools, "
            f"{len(payload['cli_commands'])} cli commands)."
        )
        return 0

    target.write_text(rendered, encoding="utf-8")
    print(
        f"wrote {target}: {len(payload['registry'])} registry cases, "
        f"{len(payload['local_tools'])} local tools, "
        f"{len(payload['cli_commands'])} cli commands."
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))

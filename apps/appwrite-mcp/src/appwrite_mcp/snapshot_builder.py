"""The snapshot the deployed function serves, and the builder that checks it.

The function ships without the repository, so it cannot read the registry, the
CLI dispatcher or the recovery server. This module is the bridge: ``build()``
derives every published fact from the source tree, and ``committed_snapshot()``
reads the file that travels with the deployment. A test compares them, which
is what stops the shipped catalogue from describing a product that has moved
on since it was generated.

``build`` lives here rather than in ``scripts/generate-snapshot.py`` so the
function package and the gate import the same code. A builder that existed
only in the generator would let the two drift, and the check would compare the
snapshot against a builder that was never the one that wrote it.
"""

from __future__ import annotations

import json
from typing import Any

from . import void_data


def build() -> dict[str, Any]:
    """Derive every published fact from the VOID source tree."""
    registry: list[dict[str, Any]] = [
        {
            "id": entry["id"],
            "vendor": entry["vendor"],
            "surface": entry["surface"],
            "summary": entry["summary"],
            "tags": entry["tags"],
            "when": entry["when"],
            "tone": entry["tone"],
            "inverse": entry["inverse"],
            "window": entry["window"],
            "note": entry.get("note", ""),
            "if": entry.get("if"),
        }
        for entry in void_data.registry_entries()
    ]
    return {
        "schema": "void.snapshot.v1",
        "registry": registry,
        "registry_summary": void_data.registry_summary(),
        "local_tools": [
            {
                "name": tool["name"],
                "description": tool["description"],
                "readOnlyHint": tool["readOnlyHint"],
                "required": tool["required"],
                "properties": tool["properties"],
            }
            for tool in void_data.local_tool_schema()
        ],
        "cli_commands": list(void_data.cli_commands()),
    }


def render() -> str:
    """The exact bytes the committed snapshot must contain."""
    return json.dumps(build(), indent=2, ensure_ascii=False, sort_keys=True) + "\n"


def committed_snapshot() -> dict[str, Any]:
    """The snapshot file as it exists on disk."""
    return json.loads(void_data.SNAPSHOT_PATH.read_text(encoding="utf-8"))

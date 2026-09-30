"""The hosted VOID MCP surface, derived from the VOID source tree.

Everything this endpoint publishes is read out of the repository by
``void_data`` rather than written here. The previous version of this file
carried a hand-maintained list of eight recovery tool names and two static
tools; nothing compared either to the CLI, so both would keep answering with
names and counts that had stopped existing. A catalogue that cannot describe
the product it is published for is worse than no catalogue, because a client
reads it as a promise.

The published tools are therefore:

* ``void_project_info`` — what this endpoint is and where recovery runs.
* ``void_registry_search`` — search the reversibility registry.
* ``void_registry_entry`` — one operation's preconditions and inverses.
* ``void_registry_summary`` — the registry's shape: counts by tone and vendor.
* ``void_local_tools`` — the local MCP tools, with their annotations.
* ``void_cli_commands`` — the CLI surface, read from the dispatch router.

What this endpoint deliberately does **not** publish is any way to execute
recovery. Recovery needs the operator's local workspace, policy and retained
key; a hosted endpoint holding those would be a different product with a
different trust model, and every response here says so in the payload rather
than in a comment.
"""

from __future__ import annotations

import json
from typing import Any

from mcp.types import ToolAnnotations
from mcp.server.mcpserver import MCPServer

from appwrite_mcp import void_data

# The version this endpoint answers with. It is the server version, not the
# registry version, and the two change for different reasons: the registry
# version tracks classification content, this one tracks the protocol surface.
SERVER_VERSION = "0.2.0"

# Every tool this endpoint publishes is read-only, and it says so in the
# annotation a host consults before it decides whether to prompt. Leaving it
# off is not neutral: a client with no `readOnlyHint` treats a tool as a write
# and asks the person to approve a registry search, which is the one thing a
# reference endpoint should never ask for.
READ_ONLY = ToolAnnotations(readOnlyHint=True, destructiveHint=False, idempotentHint=True)

server = MCPServer(
    name="VOID",
    version=SERVER_VERSION,
    instructions=(
        "VOID makes AI tool calls accountable: every call is classified for "
        "reversibility before it runs, written to a signed append-only ledger, "
        "and recoverable afterwards. This endpoint is read-only reference "
        "surface over the public classification registry and the local tool "
        "catalogue. Recovery itself runs on the operator's machine through "
        "the local stdio server, because it needs that machine's workspace, "
        "policy and retained signing key, none of which exist here."
    ),
)

# Bounds shared by the registry tools. A hosted endpoint answers from a
# generated file, so an unbounded request would return the whole catalogue in
# one response; the cap keeps a single tool result inside what a client will
# actually render, and `truncated` says when it did rather than quietly
# returning less than was asked for.
MAX_LIMIT = 200
DEFAULT_LIMIT = 25


def _registry_rows() -> list[dict[str, Any]]:
    return [dict(row) for row in void_data.registry_entries()]


def _bounded(rows: list[dict[str, Any]], limit: int) -> tuple[list[dict[str, Any]], int]:
    capped = max(1, min(int(limit), MAX_LIMIT))
    return rows[:capped], len(rows)


def _answered(payload: dict[str, Any]) -> str:
    return json.dumps(payload, ensure_ascii=False)


def _gate_text(gate: dict[str, Any]) -> list[str]:
    """Every string in a precondition, flattened for a search.

    The nested conditions matter as much as the gate's own fields: a caller
    looking for `git.branch.tip_recorded` is holding the second arm of a
    disjunction, and that name exists nowhere else in the registry.
    """
    parts = [str(value) for key, value in gate.items() if isinstance(value, str)]
    for child in gate.get("of") or []:
        if isinstance(child, dict):
            parts.extend(_gate_text(child))
    return parts


@server.tool(
    annotations=READ_ONLY,
    description=(
        "Return public VOID project identity, the hosted MCP boundary, and where "
        "recovery actually executes."
    )
)
def void_project_info() -> str:
    """Return public project metadata and the hosted/local capability boundary."""
    summary = void_data.registry_summary()
    return _answered(
        {
            "name": "VOID",
            "version": SERVER_VERSION,
            "summary": (
                "Accountable AI tool calls: classified for reversibility, written to a "
                "signed append-only ledger, recoverable afterwards."
            ),
            "hosted_mcp": (
                "Read-only reference surface over the public classification registry "
                "and the local tool catalogue."
            ),
            "local_recovery": (
                "Recovery runs through the local stdio MCP server on the operator's "
                "machine, using that machine's workspace, policy and retained key."
            ),
            "hosted_execution": False,
            "registry": {
                "version": summary.get("version"),
                "operations": summary.get("operations"),
                "cases": summary.get("cases"),
                "vendors": summary.get("vendors"),
            },
        }
    )


@server.tool(
    annotations=READ_ONLY,
    description=(
        "Search the VOID reversibility registry by operation id, vendor, surface, tag "
        "or reversibility class. Returns one row per precondition, because a single "
        "operation can be reversible under one configuration and permanent under another."
    )
)
def void_registry_search(
    query: str = "",
    vendor: str = "",
    surface: str = "",
    tone: str = "",
    tag: str = "",
    limit: int = DEFAULT_LIMIT,
) -> str:
    """Search registry cases. Every argument is optional; an empty search returns all."""
    rows = _registry_rows()
    needle = query.strip().lower()
    wanted_tone = tone.strip().lower()
    if wanted_tone and wanted_tone not in {"r0", "r1", "r2", "r3"}:
        return _answered(
            {
                "error": "tone must be one of r0, r1, r2, r3",
                "received": tone,
            }
        )

    def matches(row: dict[str, Any]) -> bool:
        if needle:
            # The precondition, its inverse and the reversibility window are the
            # text a person actually searches for: "delete marker" and "lifecycle
            # rule" appear in `when` and `window`, never in the id or the summary.
            # Leaving them out made a real query return zero on a registry that
            # holds the answer, which reads as an empty catalogue rather than as
            # a narrow search.
            haystack = " ".join(
                [
                    str(row["id"]),
                    str(row["summary"]),
                    str(row["surface"]),
                    str(row.get("when", "")),
                    str(row.get("inverse", "")),
                    str(row.get("window", "")),
                    str(row.get("note", "")),
                    " ".join(row["tags"]),
                    # The gate's own fields, including the conditions nested
                    # inside a conjunction. `stripe.balance_covers_refund` is
                    # what a caller checks and what a caller searches for, and
                    # it appears in no prose field at all.
                    *_gate_text(row.get("if") or {}),
                ]
            ).lower()
            # Every word has to appear, not the phrase as one substring. Nobody
            # searches for the literal text "stripe refund"; they type two words
            # that both describe the row, and a phrase match silently answered
            # zero for exactly that. Splitting keeps "delete marker" working,
            # since both of its words are adjacent in the same field.
            words = [word for word in needle.split() if word]
            if not all(word in haystack for word in words):
                return False
        if vendor and row["vendor"].lower() != vendor.strip().lower():
            return False
        if surface and row["surface"].lower() != surface.strip().lower():
            return False
        if wanted_tone and row["tone"] != wanted_tone:
            return False
        if tag and tag.strip().lower() not in [t.lower() for t in row["tags"]]:
            return False
        return True

    selected = [row for row in rows if matches(row)]
    page, total = _bounded(selected, limit)
    return _answered(
        {
            "query": query,
            "filters": {
                "vendor": vendor or None,
                "surface": surface or None,
                "tone": tone or None,
                "tag": tag or None,
            },
            "total_matched": total,
            "returned": len(page),
            "truncated": total > len(page),
            "max_limit": MAX_LIMIT,
            "results": page,
        }
    )


@server.tool(
    annotations=READ_ONLY,
    description=(
        "Return one registry operation with every precondition, its reversibility class, "
        "its inverse and the window in which that inverse remains valid."
    )
)
def void_registry_entry(operation_id: str) -> str:
    """Return every precondition for one operation id, or an empty cases list."""
    wanted = operation_id.strip()
    rows = [row for row in _registry_rows() if row["id"] == wanted]
    if not rows:
        # Not an error: an unknown id is a normal answer to a search, and a
        # client that guessed an id needs to learn it does not exist rather
        # than receive a transport failure.
        return _answered(
            {
                "id": wanted,
                "found": False,
                "cases": [],
                "hint": "Use void_registry_search with a broader query to find similar ids.",
            }
        )
    first = rows[0]
    return _answered(
        {
            "id": first["id"],
            "found": True,
            "vendor": first["vendor"],
            "surface": first["surface"],
            "summary": first["summary"],
            "tags": first["tags"],
            "case_count": len(rows),
            "cases": [
                {
                    "when": row["when"],
                    "tone": row["tone"],
                    "inverse": row["inverse"],
                    "window": row["window"],
                    # The note is why the case is classified the way it is, and
                    # the gate is the machine-readable form of the same thing:
                    # `when` is what a person reads, `if` is what a tool can
                    # evaluate. Publishing the prose without the gate answers a
                    # different question than the one the catalogue exists for.
                    "note": row.get("note", ""),
                    "if": row.get("if"),
                }
                for row in rows
            ],
        }
    )


@server.tool(
    annotations=READ_ONLY,
    description=(
        "Return the shape of the reversibility registry: operation and case counts, the "
        "distribution across the four classes, and the vendors covered."
    )
)
def void_registry_summary() -> str:
    """Return registry totals, class distribution and vendor coverage."""
    summary = void_data.registry_summary()
    return _answered(
        {
            "version": summary.get("version"),
            "operations": summary.get("operations"),
            "cases": summary.get("cases"),
            "unparsed_entries": summary.get("unparsed"),
            "by_tone": summary.get("by_tone"),
            "vendors": summary.get("vendors"),
            "surfaces": summary.get("surfaces"),
            "top_vendors": dict(list((summary.get("by_vendor") or {}).items())[:15]),
            "disclaimer": summary.get("disclaimer"),
        }
    )


@server.tool(
    annotations=READ_ONLY,
    description=(
        "List the MCP tools VOID runs locally over stdio, with their arguments and "
        "whether each is read-only. This endpoint names them; it never invokes them."
    )
)
def void_local_tools() -> str:
    """Return the local recovery tool catalogue with its annotations."""
    tools = [
        {
            "name": tool["name"],
            "description": tool["description"],
            "readOnly": tool["readOnlyHint"],
            "required_arguments": tool["required"],
        }
        for tool in void_data.local_tool_schema()
    ]
    return _answered(
        {
            "transport": "local stdio",
            "command": "node packages/cli/bin/void.mjs recovery serve --config <file>",
            "hosted_execution": False,
            "reason": (
                "Recovery needs a configured local workspace, policy, and retained key."
            ),
            "count": len(tools),
            "tools": tools,
        }
    )


@server.tool(
    annotations=READ_ONLY,
    description="List the top-level commands the VOID command line exposes, read from its dispatcher."
)
def void_cli_commands() -> str:
    """Return the CLI command surface as the dispatcher declares it."""
    commands = list(void_data.cli_commands())
    return _answered(
        {
            "binary": "void",
            "count": len(commands),
            "commands": commands,
        }
    )

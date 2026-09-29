"""Read-only public reference tools for VOID on Appwrite Functions."""

from __future__ import annotations

import json
from mcp.server.mcpserver import MCPServer

RECOVERY_TOOLS = [
    "void_execute",
    "void_recovery_plan",
    "void_recovery_apply",
    "void_recovery_plan_job",
    "void_recovery_status_job",
    "void_recovery_apply_job",
    "void_reconcile",
    "void_recovery_reconcile",
]

server = MCPServer(
    name="VOID",
    version="0.1.0",
    instructions=(
        "Read-only reference MCP for VOID. This hosted endpoint exposes public "
        "project documentation and the local recovery-tool catalog. It does "
        "not execute recovery operations or access a user's machine."
    ),
)


@server.tool(description="Return public project identity and the hosted MCP boundary.")
def void_project_info() -> str:
    """Return public VOID project metadata and hosted/local capability boundaries."""
    return json.dumps(
        {
            "name": "VOID",
            "summary": "VOID recovery MCP reference endpoint.",
            "hosted_mcp": "Read-only project metadata and local recovery capability reference.",
            "local_recovery": "Runs through the local stdio MCP server and local operator state.",
        },
        ensure_ascii=False,
    )


@server.tool(description="List VOID recovery tools and explain their local-only execution boundary.")
def void_recovery_capabilities() -> str:
    """List implemented recovery MCP tools without invoking them."""
    return json.dumps(
        {
            "transport": "local stdio",
            "command": "node packages/cli/bin/void.mjs recovery serve --config <file>",
            "tools": RECOVERY_TOOLS,
            "hosted_execution": False,
            "reason": "Recovery needs a configured local workspace, policy, and retained key.",
        },
        ensure_ascii=False,
    )

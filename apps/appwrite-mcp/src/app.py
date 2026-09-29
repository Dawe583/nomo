"""Read-only public reference tools for VOID on Appwrite Functions."""

from __future__ import annotations

import json
import re
from concurrent.futures import ThreadPoolExecutor
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

from mcp.server.mcpserver import MCPServer

REPOSITORY = "Dawe583/void"
RAW_ROOT = f"https://raw.githubusercontent.com/{REPOSITORY}/main/"
MAX_DOCUMENT_BYTES = 200_000
DOCUMENTS = {
    "readme": ("README.md", "Project overview"),
    "handbook": ("docs/HANDBOOK.md", "Operator handbook"),
    "beta": ("docs/BETA.md", "Beta capabilities and limits"),
    "recovery-contract": ("docs/RECOVERY-CONTRACT.md", "Recovery contract"),
    "recovery-coverage": ("docs/RECOVERY-COVERAGE.md", "Recovery adapter coverage"),
    "appwrite-auth": ("docs/APPWRITE-AUTH.md", "Appwrite integration boundaries"),
}
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


def _read_document(document_id: str) -> str:
    document = DOCUMENTS.get(document_id)
    if document is None:
        available = ", ".join(sorted(DOCUMENTS))
        raise ValueError(f"Unknown document ID. Available IDs: {available}.")

    path, _title = document
    request = Request(
        RAW_ROOT + path,
        headers={"User-Agent": "VOID-MCP/0.1", "Accept": "text/plain"},
    )
    try:
        with urlopen(request, timeout=4) as response:
            payload = response.read(MAX_DOCUMENT_BYTES + 1)
    except (HTTPError, URLError, TimeoutError) as error:
        raise RuntimeError("VOID public documentation is temporarily unavailable.") from error

    if len(payload) > MAX_DOCUMENT_BYTES:
        raise RuntimeError("Document exceeds the hosted MCP size limit.")
    return payload.decode("utf-8")


@server.tool(description="Return public project identity and the hosted MCP boundary.")
def void_project_info() -> str:
    """Return public VOID project metadata and hosted/local capability boundaries."""
    return json.dumps(
        {
            "name": "VOID",
            "repository": f"https://github.com/{REPOSITORY}",
            "license": "Apache-2.0",
            "summary": "Accountable AI tool calls, signed ledgers, and guarded recovery.",
            "hosted_mcp": "Read-only public documentation and capability reference.",
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


@server.tool(description="List public VOID documents available by document ID.")
def void_list_documents() -> str:
    """List the fixed public documentation allowlist."""
    return json.dumps(
        [
            {"document_id": document_id, "title": title, "path": path}
            for document_id, (path, title) in DOCUMENTS.items()
        ],
        ensure_ascii=False,
    )


@server.tool(description="Read one public VOID document by its allowlisted document ID.")
def void_read_document(document_id: str) -> str:
    """Read a public Markdown document from the VOID GitHub repository."""
    return _read_document(document_id)


@server.tool(description="Search the fixed public VOID document set and return matching excerpts.")
def void_search_docs(query: str, limit: int = 8) -> str:
    """Search public VOID documentation by words and return bounded excerpts."""
    query = query.strip()
    if not query or len(query) > 200:
        raise ValueError("Query must contain 1 to 200 characters.")
    if not 1 <= limit <= 20:
        raise ValueError("Limit must be between 1 and 20.")

    words = [word.lower() for word in re.findall(r"[\w-]+", query) if len(word) > 1]
    if not words:
        raise ValueError("Query must contain at least one searchable word.")

    document_ids = list(DOCUMENTS)
    with ThreadPoolExecutor(max_workers=4) as pool:
        contents = list(pool.map(_read_document, document_ids))

    matches = []
    for document_id, content in zip(document_ids, contents, strict=True):
        title = DOCUMENTS[document_id][1]
        for line_number, line in enumerate(content.splitlines(), start=1):
            lowered = line.lower()
            score = sum(lowered.count(word) for word in words)
            if score:
                matches.append(
                    {
                        "score": score,
                        "document_id": document_id,
                        "title": title,
                        "line": line_number,
                        "excerpt": line.strip()[:500],
                    }
                )

    matches.sort(key=lambda item: (-item["score"], item["document_id"], item["line"]))
    return json.dumps(
        {"results": [{k: v for k, v in item.items() if k != "score"} for item in matches[:limit]]},
        ensure_ascii=False,
    )

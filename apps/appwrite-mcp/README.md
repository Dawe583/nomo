# VOID reference MCP

This Appwrite Function serves a stateless, read-only MCP endpoint for public
VOID project information and documentation. It lists the local recovery MCP
tools, but does not execute them. Recovery requires the operator's local
workspace, policy, and retained key; those never leave the operator machine.

Tools:

- `void_project_info`
- `void_recovery_capabilities`
- `void_list_documents`
- `void_read_document`
- `void_search_docs`

Documents are fetched from a fixed allowlist in the public `Dawe583/void`
repository. Tool arguments cannot select an arbitrary URL, path, or host. The
endpoint contains no credential and performs no writes.

Appwrite settings: Python 3.14, entrypoint `src/main.py`, build command
`pip install -r requirements.txt`, root directory `apps/appwrite-mcp`, and
30-second timeout. Keep the generated `*.appwrite.run` domain as the MCP URL.

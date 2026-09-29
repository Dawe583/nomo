# VOID reference MCP

This Appwrite Function serves a stateless, read-only MCP endpoint for public
VOID project information and documentation. It lists the local recovery MCP
tools, but does not execute them. Recovery requires the operator's local
workspace, policy, and retained key; those never leave the operator machine.

Tools:

- `void_project_info`
- `void_recovery_capabilities`

This endpoint deliberately serves no repository files. The repository source
is not anonymously readable, and this hosted function has no GitHub credential.
The endpoint contains no credential and performs no writes.

Appwrite settings: Python 3.14, entrypoint `src/main.py`, build command
`pip install -r requirements.txt`, root directory `apps/appwrite-mcp`, and
30-second timeout. Keep the generated `*.appwrite.run` domain as the MCP URL.

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

Appwrite settings: Python 3.14, entrypoint `src/main.py` under root directory
`apps/appwrite-mcp`, build command `pip install -r requirements.txt`, and
30-second timeout. The function is named `MCP server` and has the id
`6abbae3e000f6f24ce2a`. It reads `MCP_SERVER_NAME`, `MCP_AUTH_MODE`,
`MCP_AUTH_TOKEN`, and `MCP_TOOL_TIMEOUT`; no value for any of them belongs in
this repository.

No domain is registered for the function, so there is no MCP URL to give a
client yet. Its latest deployment built successfully, and the endpoint stays
unreachable until an operator adds a domain.

## Adding the domain

In the Appwrite console, select the project, click `Functions` in the sidebar,
select `MCP server`, and open its `Domains` tab. Register the domain there. The
console shows the domain to use once it exists.

A person has to do this because the domain routes answer a project service key
with `general_access_forbidden`. Adding a domain needs a console-scoped
credential, and this repository deliberately holds only a project service key.
`cloud/appwrite.mjs` therefore reports the function, its URL when one exists,
and the fact that a domain is still needed, instead of failing on it.

## Verifying the domain

Set `MCP_URL` to the domain the console shows, then send the two MCP requests
the function answers:

```bash
curl -sS -X POST "$MCP_URL" -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"void-verify","version":"0.1.0"}}}'
curl -sS -X POST "$MCP_URL" -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}'
```

The first request answers with the server name `VOID`, the second answers with
exactly `void_project_info` and `void_recovery_capabilities`. If
`MCP_AUTH_MODE` is `bearer`, add `-H "authorization: Bearer $MCP_AUTH_TOKEN"`
to both, with the value read from your own environment and never from a file
in this repository.

The function routes on the `MCP-Protocol-Version` request header, so what a
client sends after the handshake decides which leg answers. Leave the header
out, or send one of the four handshake revisions `2024-11-05`, `2025-03-26`,
`2025-06-18` or `2025-11-25`, and the buffered leg answers `initialize`,
`tools/list` and `tools/call` the way the two requests above do. Send any
other revision and the strict leg takes the request instead: that leg also
requires `io.modelcontextprotocol/protocolVersion` and
`io.modelcontextprotocol/clientCapabilities` in `params._meta`, and answers
400 with JSON-RPC error code `-32602` when they are missing.

The endpoint is stateless and never issues an `Mcp-Session-Id` response
header. A client must not wait for a session id and must not retry a session
it believes it lost, because there is no session to resume: the next request
is a new one.

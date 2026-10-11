# nomo-transport

A standard library Python client for the NOMO proxy HTTP transport.

It speaks the same wire as the TypeScript transport in
`packages/proxy/src/transport/http.ts`: JSON-RPC 2.0 over HTTP `POST` to one
explicit `host:port`. No third party package, no build step, no `pip install`.

## What it does

```python
from nomo_transport import NomoTransportClient

client = NomoTransportClient("127.0.0.1", 8787, path="/mcp", token_env="NOMO_PROXY_TOKEN")
print(client.initialize())
print(client.list_tools())

call = client.call_tool("nomo_recovery_plan", {"operationId": "op-1"}, idempotency_key="plan-op-1")
print(client.await_hold(call.hold_id, timeout=30))
client.close()
```

- `initialize()` runs the MCP handshake and returns the proxy's `serverInfo`
  and negotiated protocol version. It refuses a version it does not know.
- `list_tools()` returns the catalogue the proxy publishes, validating each
  entry's shape.
- `call_tool(name, arguments, idempotency_key)` starts a `tools/call` on a
  worker thread and returns a handle. The key is required and is checked
  before the socket is opened.
- `await_hold(hold_id, timeout)` blocks for that handle and returns the
  result, or raises the error the call produced.
- `close()` refuses further work and fails any call still on the wire with an
  "outcome unknown" error. It never retries.

`canonical.py` provides `canonical_json`, `canonical_bytes`, `digest` (as
`sha256:<hex>`) and `is_lowercase_sha256`, byte-identical to
`packages/ledger/src/canonical.ts`. `errors.py` provides the four NOMO codes
(`NOMO_HOLD_DENIED`, `NOMO_LEDGER_VERIFY`, `NOMO_POLICY_STARTUP`,
`NOMO_REFUSED`) with the same fields as `packages/sdk/src/errors.ts`, plus
`NOMO_TRANSPORT` for the refusals this client raises on its own.

## The refusals, and why

Every rule below came from `CompanionHTTPClient.swift`, the Swift client that
already talks to a companion endpoint:

- A response whose `id` is not the id that was sent is refused. A string id
  where a number was sent is refused too: `session.ts` drops a string id rather
  than reading it as its numeric lookalike, and this client will not do the
  coercion the proxy declines to do.
- A response over the limit is refused on its declared `Content-Length` when
  there is one, and by the read loop when there is not. The body is never
  parsed first.
- An unknown shape is an error. No "best effort" parse, no substring fallback,
  no accepting a batch when a single response was asked for.
- A redirect is refused. `http.client` follows none, and following one would
  carry the bearer token to a host nobody configured.
- There is no silent retry anywhere. A POST whose outcome is unknown is
  reported as unknown, matching "outcome unknown after deadline; reconcile
  before retry" in `transport/http.ts`.
- `call_tool` without an idempotency key is refused before the socket opens. A
  mutating call without a key cannot be retried or reconciled, and discovering
  that after the POST has already fired is worse than refusing.
- The token is passed as the *name* of an environment variable. The value is
  read at send time, never stored, never in `repr`, never logged. A missing,
  empty or header-breaking value is a refusal.

`http.client` reads no proxy environment variables, so a connection reaches
exactly the host and port given. Nothing parses a URL: the endpoint is a
hostname, an integer port and a validated path.

## How it differs from the Swift counterpart

- **No pinned TLS.** The Swift client pins a certificate fingerprint and
  requires HTTPS. This client has no certificate handling at all; it speaks
  plain HTTP to a loopback endpoint, which is the shape the local proxy relay
  actually exposes. It is not a replacement for a client that talks to a
  remote companion over a network it does not control.
- **`await_hold` takes a client-minted id.** The HTTP transport carries no
  hold identifier on the wire, so there is nothing else a caller could pass.
  The handle is a correlation token for the in-flight call; the error it
  raises is still mapped from the server's own body.
- **The denial arrives as content.** Against the real relay, a policy denial
  or an unknown tool comes back as a successful JSON-RPC `result` carrying MCP
  `isError` content, not as a JSON-RPC `error`. `HoldDeniedError` is raised
  when a server does send a JSON-RPC error whose `data.result` is `denied` or
  `expired`, which is what `packages/proxy/src/forward/tools.ts` emits. Read
  `isError` on the result as well as catching the exception.
- **No ledger verification, no replay.** `LedgerVerifyError` and
  `RefusedError` exist with the TS SDK's fields and are constructible from the
  same shapes, but this package does not verify a ledger or run a replay. It
  is a transport.

## What this does not cover

- No TLS, no certificate pinning, no remote endpoint hardening.
- No MCP server, no tool implementation, no inverse or recovery planning.
- No provider-specific behaviour of any kind. WP-R12's provider certification
  waves are untouched by this package.
- No concurrency beyond one worker thread per `call_tool` against a shared id
  counter. It is not a throughput client.
- No streaming of partial tool results. A call settles once, with one answer.
- Untested against a real remote proxy, a real network partition, or a
  half-open connection that fails after the request was accepted. The
  integration test covers a loopback endpoint only.

None of this is a claim of certification or production readiness. It is a
transport client with its refusals tested.

## Running the tests

```
python3 -m unittest discover -s python/nomo-transport/tests -t python/nomo-transport
```

84 tests. The unit tests use a loopback `http.server` scripted to send exact
bytes. `test_canonical.py` includes a cross check that runs the repository's
own `packages/ledger/src/canonical.ts` under `node` over a shared corpus and
compares the canonical text, the exact UTF-8 bytes and the digest.

`test_integration.py` spawns two real processes: `tests/fixtures/nomo_proxy_http.mjs`
binds the repository's `createHttpRequestRelay` to a loopback port, and
`node packages/cli/bin/nomo.mjs recovery serve` runs behind it as the real MCP
server. Nothing in either process is a stub written for the test. Those tests
skip if `node` is unavailable or the fixture does not report a port.

No dependency is installed, and no test needs one.

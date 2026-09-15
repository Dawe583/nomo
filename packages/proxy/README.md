# @void/proxy

The MCP proxy terminates an agent's local stdio connection and opens either a
stdio process or HTTP connection to one upstream MCP server. Both upstream
transports use the same session translation and `tools/call` interception path.

## Runnable binary

```sh
node packages/proxy/bin/void-proxy.mjs \
  --upstream node \
  --args fixtures/e2e-server.mjs \
  --policy fixtures/e2e-policy.yaml \
  --ledger-dir /tmp/void-ledger \
  --workspace demo
```

For an HTTP MCP upstream, use `--transport http --upstream-url <url>` instead
of `--upstream` and `--args`. The proxy itself remains the stdio MCP server used
by the agent. This package does not provide a shared inbound HTTP gateway.

## Behavior

The proxy forwards MCP initialization, tools, resources, prompts,
notifications, progress tokens, cancellation and upstream server requests while
translating identifiers between both sessions. Around `tools/call` it:

1. maps the requested tool to registry data and declared facts;
2. applies the loaded YAML policy;
3. appends decision evidence to the signed JSONL ledger;
4. forwards, denies, or blocks on a durable hold;
5. records the hold resolution before an approved call proceeds.

`fail-closed` is the default posture. Unknown tools, invalid policy or facts,
ledger failure, malformed calls, and internal safety failures deny. A
fail-closed process requires `--ledger-dir`. `observe` is an explicit trial
posture that forwards non-allow decisions and reports them on stderr.

Approval files can be placed under `--approvals-dir`; the running proxy pumps
decisions while input is blocked on a hold. Direct denials name the rule and
class. Hold outcomes name their approval state.

## Boundaries

HTTP support is an upstream MCP client transport, not a generic HTTP tool
interceptor. One proxy process connects to one upstream. There is no hosted
multi-tenant gateway in this package.

The generic proxy records authorization and hold resolution. It does not
automatically call PostgreSQL, S3, filesystem, OAuth, or other connector
capture. An approved or `allow:resolved` entry is not proof that an external
mutation completed and does not create an inverse. Hosts that need managed
capture and signed execution outcomes must use `@void/runtime` through a
registered recovery adapter.

Target facts are operator declarations unless a composed host supplies probe
results. Observe mode is not a twin or transaction shadow run. Holds are
blocking; provisional receipts and cascading cancellation are not implemented.

## Public surface

`src/index.ts` exports stdio and HTTP upstream transports, session and JSON-RPC
types, tool/resource/prompt forwarding, notification and server-request relays,
approval pumping, and hardening helpers. `runProxy` and its options live in
`src/bin.ts`. The proxy resolves connectors supplied by a host and never imports
one.

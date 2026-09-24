import assert from "node:assert/strict";
import { createServer } from "node:http";
import { performance } from "node:perf_hooks";

import { createHttpRequestRelay } from "../../packages/proxy/src/relay/http-requests.ts";

const durationMs = Number(process.argv[2] ?? 3_600_000);
if (!Number.isSafeInteger(durationMs) || durationMs < 1) {
  throw new Error("usage: node scripts/src/load-proxy.mjs [positive-duration-ms]");
}

const pendingTimers = new Set();
let relay;
let peakPending = 0;
let completed = 0;
let nextId = 0;
const upstream = {
  send(line) {
    const request = JSON.parse(line);
    peakPending = Math.max(peakPending, relay.session.maps.agentToUpstream.size);
    const timer = setTimeout(() => {
      pendingTimers.delete(timer);
      relay.receiveUpstreamLine(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { received: true } }));
    }, 10);
    pendingTimers.add(timer);
  },
  close() {},
  onStderr() { return () => {}; },
};
relay = createHttpRequestRelay({ upstream, maxPendingRequests: 16, requestTimeoutMs: 5_000 });
const server = createServer((request, response) => { void relay.handle(request, response); });
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
assert.ok(address !== null && typeof address !== "string");
const url = `http://127.0.0.1:${address.port}/mcp`;
const started = performance.now();
const deadline = started + durationMs;
try {
  await Promise.all(Array.from({ length: 16 }, async () => {
    while (performance.now() < deadline) {
      const id = nextId++;
      const response = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: id % 2 === 0 ? id : `request-${id}`, method: "ping" }),
      });
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), {
        jsonrpc: "2.0", id: id % 2 === 0 ? id : `request-${id}`, result: { received: true },
      });
      completed += 1;
    }
  }));
  assert.equal(relay.session.maps.agentToUpstream.size, 0);
  assert.equal(relay.session.maps.upstreamToAgent.size, 0);
  assert.equal(pendingTimers.size, 0);
  console.log(JSON.stringify({ durationMs: Math.round(performance.now() - started), completed, peakPending, finalPending: relay.session.maps.agentToUpstream.size, rssBytes: process.memoryUsage().rss }));
} finally {
  relay.close();
  for (const timer of pendingTimers) clearTimeout(timer);
  server.closeAllConnections();
  await new Promise((resolve, reject) => server.close((error) => error === undefined ? resolve() : reject(error)));
}

import { createServer } from "node:http";
import type { Server } from "node:http";
import test, { describe } from "node:test";
import assert from "node:assert/strict";

import { createHttpRequestRelay } from "./http-requests.ts";
import type { HttpRequestRelay, HttpRequestRelayOptions } from "./http-requests.ts";
import type { UpstreamProcess } from "../transport/stdio.ts";
import { Session } from "../session.ts";
import type { JsonRpcId, JsonRpcMessage, JsonRpcRequest } from "../rpc.ts";

// A session whose upstream ids are strings. The relay has to carry that id as
// an identity of its own type: nothing about it may be rejected as malformed
// and nothing about it may be read as its numeric lookalike.
class StringIdSession extends Session {
  override translateRequestOut(request: JsonRpcRequest): JsonRpcRequest {
    const translated = super.translateRequestOut(request);
    return { ...translated, id: `up-${String(translated.id)}` };
  }

  override translateInbound(message: JsonRpcMessage): JsonRpcMessage | null {
    if ("id" in message && typeof message.id === "string" && message.id.startsWith("up-")) {
      return super.translateInbound({ ...message, id: Number(message.id.slice(3)) });
    }
    return super.translateInbound(message);
  }
}

type SentMessage = {
  readonly jsonrpc: "2.0";
  readonly id?: JsonRpcId;
  readonly method: string;
  readonly params?: Readonly<Record<string, unknown>>;
};

async function listen(server: Server): Promise<URL> {
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address !== null && typeof address !== "string");
  return new URL(`http://127.0.0.1:${address.port}/mcp`);
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error === undefined) {
        resolve();
      } else {
        reject(error);
      }
    });
  });
}

async function waitFor(condition: () => boolean): Promise<void> {
  const deadline = Date.now() + 1000;
  for (;;) {
    if (condition()) {
      return;
    }
    if (Date.now() > deadline) {
      throw new Error("timed out waiting for condition");
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
}

function fakeUpstream(sent: SentMessage[]): UpstreamProcess {
  return {
    send(line: string): void {
      sent.push(JSON.parse(line) as SentMessage);
    },
    close() {},
    onStderr() {
      return () => {};
    },
  };
}

async function withRelay(testBody: (url: URL, relay: HttpRequestRelay, sent: SentMessage[]) => Promise<void>, options: Partial<HttpRequestRelayOptions> = {}): Promise<void> {
  const sent: SentMessage[] = [];
  const relay = createHttpRequestRelay({ upstream: fakeUpstream(sent), ...options });
  const server = createServer((request, response) => {
    void relay.handle(request, response);
  });
  const url = await listen(server);
  try {
    await testBody(url, relay, sent);
  } finally {
    relay.close();
    await closeServer(server);
  }
}

describe("createHttpRequestRelay", () => {
  test("answers each id in a batched client request", async () => {
    await withRelay(async (url, relay, sent) => {
      const responsePromise = fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify([
          { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "a" } },
          { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "b" } },
        ]),
      });

      await waitFor(() => sent.length === 2);
      relay.receiveUpstreamLine(JSON.stringify({ jsonrpc: "2.0", id: sent[1]?.id, result: { second: true } }));
      relay.receiveUpstreamLine(JSON.stringify({ jsonrpc: "2.0", id: sent[0]?.id, result: { first: true } }));
      const response = await responsePromise;
      const body = await response.json() as unknown;

      assert.equal(response.status, 200);
      assert.deepEqual(body, [
        { jsonrpc: "2.0", id: 3, result: { second: true } },
        { jsonrpc: "2.0", id: 1, result: { first: true } },
      ]);
    });
  });

  test("keeps string and numeric IDs distinct in one batch", async () => {
    await withRelay(async (url, relay, sent) => {
      const responsePromise = fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        signal: AbortSignal.timeout(1500),
        body: JSON.stringify([
          { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "first" } },
          { jsonrpc: "2.0", id: "1", method: "tools/call", params: { name: "second" } },
        ]),
      });
      await waitFor(() => sent.length === 2);
      relay.receiveUpstreamLine(JSON.stringify({ jsonrpc: "2.0", id: sent[1]?.id, result: { value: "second" } }));
      relay.receiveUpstreamLine(JSON.stringify({ jsonrpc: "2.0", id: sent[0]?.id, result: { value: "first" } }));
      const response = await responsePromise;
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), [
        { jsonrpc: "2.0", id: "1", result: { value: "second" } },
        { jsonrpc: "2.0", id: 1, result: { value: "first" } },
      ]);
    });
  });

  test("S11: a string upstream id routes to its own pending request", async () => {
    await withRelay(async (url, relay, sent) => {
      const responsePromise = fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/list" }),
      });

      await waitFor(() => sent.length === 1);
      const upstreamId = sent[0]?.id;
      assert.equal(typeof upstreamId, "string");
      relay.receiveUpstreamLine(JSON.stringify({ jsonrpc: "2.0", id: upstreamId, result: { tools: [] } }));

      const response = await responsePromise;
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), { jsonrpc: "2.0", id: 3, result: { tools: [] } });
    }, { session: new StringIdSession() });
  });

  test("preserves large and nonnumeric string IDs through cancellation", async () => {
    await withRelay(async (url, relay, sent) => {
      const responsePromise = fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        signal: AbortSignal.timeout(1500),
        body: JSON.stringify([
          { jsonrpc: "2.0", id: "9007199254740993", method: "tools/call" },
          { jsonrpc: "2.0", id: "alpha", method: "tools/call" },
        ]),
      });
      await waitFor(() => sent.length === 2);
      const cancel = await fetch(url, {
        method: "POST",
        body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: "alpha" } }),
      });
      relay.receiveUpstreamLine(JSON.stringify({ jsonrpc: "2.0", id: sent[0]?.id, result: { saved: true } }));
      assert.equal(cancel.status, 202);
      assert.deepEqual(sent[2], { jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: sent[1]?.id } });
      assert.deepEqual(await (await responsePromise).json(), [
        { jsonrpc: "2.0", id: "alpha", error: { code: -32800, message: "Request cancelled" } },
        { jsonrpc: "2.0", id: "9007199254740993", result: { saved: true } },
      ]);
    });
  });

  test("rejects excess requests without dispatching and releases capacity after a result", async () => {
    await withRelay(async (url, relay, sent) => {
      const first = fetch(url, { method: "POST", body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call" }) });
      await waitFor(() => sent.length === 1);
      const rejected = await fetch(url, { method: "POST", body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call" }) });
      assert.equal(rejected.status, 429);
      assert.equal(sent.length, 1);
      relay.receiveUpstreamLine(JSON.stringify({ jsonrpc: "2.0", id: sent[0]?.id, result: true }));
      assert.equal((await first).status, 200);
      const next = fetch(url, { method: "POST", body: JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/call" }) });
      await waitFor(() => sent.length === 2);
      relay.receiveUpstreamLine(JSON.stringify({ jsonrpc: "2.0", id: sent[1]?.id, result: true }));
      assert.equal((await next).status, 200);
    }, { maxPendingRequests: 1 });
  });

  test("clears every mapping if dispatch fails midway through a batch", async () => {
    const sent: SentMessage[] = [];
    const upstream = fakeUpstream(sent);
    let writes = 0;
    await withRelay(async (url, relay) => {
      const failed = await fetch(url, {
        method: "POST",
        body: JSON.stringify([{ jsonrpc: "2.0", id: "first", method: "tools/call" }, { jsonrpc: "2.0", id: "second", method: "tools/call" }]),
      });
      assert.equal(failed.status, 500);
      assert.equal(relay.session.maps.agentToUpstream.size, 0);
      const next = fetch(url, { method: "POST", body: JSON.stringify({ jsonrpc: "2.0", id: "third", method: "tools/call" }) });
      await waitFor(() => sent.length === 2);
      relay.receiveUpstreamLine(JSON.stringify({ jsonrpc: "2.0", id: sent[1]?.id, result: true }));
      assert.equal((await next).status, 200);
    }, { maxPendingRequests: 2, upstream: { ...upstream, send(line) { if (++writes === 2) throw new Error("upstream closed"); upstream.send(line); } } });
  });

  test("releases disconnected requests and reports a stalled outcome as unknown", async () => {
    await withRelay(async (url, relay, sent) => {
      const controller = new AbortController();
      const abandoned = fetch(url, { method: "POST", signal: controller.signal, body: JSON.stringify({ jsonrpc: "2.0", id: "abandoned", method: "tools/call" }) });
      await waitFor(() => sent.length === 1);
      controller.abort();
      await assert.rejects(abandoned);
      await waitFor(() => relay.session.maps.agentToUpstream.size === 0);
      const stalled = await fetch(url, { method: "POST", body: JSON.stringify({ jsonrpc: "2.0", id: "stalled", method: "tools/call" }) });
      const body = await stalled.json() as { readonly error: { readonly message: string } };
      assert.equal(stalled.status, 504);
      assert.match(body.error.message, /unknown.*reconcile/i);
      assert.equal(relay.session.maps.agentToUpstream.size, 0);
    }, { requestTimeoutMs: 25, maxPendingRequests: 1 });
  });

  test("bounds an idle SSE with an explicit error frame and closes the response", async () => {
    await withRelay(async (url, relay, sent) => {
      const response = await fetch(url, {
        method: "POST",
        headers: { accept: "text/event-stream" },
        body: JSON.stringify({ jsonrpc: "2.0", id: "idle", method: "tools/call" }),
      });
      await waitFor(() => sent.length === 1);
      const text = await response.text();
      const frames = text.split("\n\n").filter(Boolean);
      assert.equal(response.status, 200);
      assert.match(response.headers.get("content-type") ?? "", /text\/event-stream/);
      assert.deepEqual(frames, [
        'data: {"jsonrpc":"2.0","error":{"code":-32603,"message":"Upstream outcome unknown after deadline; reconcile before retry"}}',
      ]);
      assert.equal(relay.session.maps.agentToUpstream.size, 0);
    }, { requestTimeoutMs: 25 });
  });

  test("refuses duplicate in-flight IDs without overwriting the original reply", async () => {
    await withRelay(async (url, relay, sent) => {
      const first = fetch(url, { method: "POST", body: JSON.stringify({ jsonrpc: "2.0", id: "same", method: "tools/call" }) });
      await waitFor(() => sent.length === 1);
      const duplicate = await fetch(url, { method: "POST", body: JSON.stringify({ jsonrpc: "2.0", id: "same", method: "tools/call" }) });
      assert.equal(duplicate.status, 400);
      assert.equal(sent.length, 1);
      relay.receiveUpstreamLine(JSON.stringify({ jsonrpc: "2.0", id: sent[0]?.id, result: { original: true } }));
      assert.deepEqual(await (await first).json(), { jsonrpc: "2.0", id: "same", result: { original: true } });
    });
  });

  test("streams progress and result over SSE while a request is in flight", async () => {
    await withRelay(async (url, relay, sent) => {
      const responsePromise = fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "text/event-stream" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 11, method: "tools/call", params: { name: "slow", _meta: { progressToken: "job-progress" } } }),
      });

      await waitFor(() => sent.length === 1);
      const upstreamId = sent[0]?.id;
      relay.receiveUpstreamLine(JSON.stringify({ jsonrpc: "2.0", method: "notifications/progress", params: { progressToken: upstreamId, progress: 0.5 } }));
      relay.receiveUpstreamLine(JSON.stringify({ jsonrpc: "2.0", id: upstreamId, result: { done: true } }));
      const response = await responsePromise;
      const text = await response.text();

      assert.equal(response.headers.get("content-type"), "text/event-stream");
      assert.match(text, /"method":"notifications\/progress"/);
      assert.match(text, /"progressToken":"job-progress"/);
      assert.match(text, /"id":11/);
      assert.match(text, /"done":true/);
    });
  });
  test("delivers progress and result after the SSE writable buffer fills", async () => {
    await withRelay(async (url, relay, sent) => {
      const responsePromise = fetch(url, {
        method: "POST",
        headers: { accept: "text/event-stream" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 19, method: "tools/call", params: { _meta: { progressToken: "slow-reader" } } }),
      });
      await waitFor(() => sent.length === 1);
      const upstreamId = sent[0]?.id;
      const payload = "x".repeat(512 * 1024);
      relay.receiveUpstreamLine(JSON.stringify({ jsonrpc: "2.0", method: "notifications/progress", params: { progressToken: upstreamId, chunk: payload } }));
      relay.receiveUpstreamLine(JSON.stringify({ jsonrpc: "2.0", id: upstreamId, result: { done: true } }));
      const response = await responsePromise;
      const frames = (await response.text()).split("\n\n").filter(Boolean).map((frame) => JSON.parse(frame.slice(6)) as { readonly id?: number; readonly params?: { readonly chunk: string }; readonly result?: { readonly done: boolean } });
      assert.equal(response.status, 200);
      assert.equal(frames[0]?.params?.chunk, payload);
      assert.equal(frames[1]?.id, 19);
      assert.equal(frames[1]?.result?.done, true);
    });
  });

  test("routes cancellation upstream and drops the in-flight mapping", async () => {
    await withRelay(async (url, relay, sent) => {
      const responsePromise = fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "text/event-stream" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "slow" } }),
      });

      await waitFor(() => sent.length === 1);
      const upstreamId = sent[0]?.id;
      const cancel = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 5, reason: "client" } }),
      });
      const response = await responsePromise;
      const text = await response.text();

      assert.equal(cancel.status, 202);
      assert.deepEqual(sent[1], { jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: upstreamId } });
      assert.equal(relay.session.maps.agentToUpstream.has(5), false);
      assert.match(text, /"method":"notifications\/cancelled"/);
    });
  });

  test("rejects an oversized client body before routing upstream", async () => {
    const sent: SentMessage[] = [];
    const relay = createHttpRequestRelay({ upstream: fakeUpstream(sent), maxBodySize: 5 });
    const server = createServer((request, response) => {
      void relay.handle(request, response);
    });
    const url = await listen(server);

    try {
      const response = await fetch(url, { method: "POST", body: "abcdef" });
      const body = await response.json() as { readonly error: { readonly code: number; readonly message: string } };

      assert.equal(response.status, 413);
      assert.equal(body.error.code, -32700);
      assert.match(body.error.message, /exceeded 5 bytes/);
      assert.deepEqual(sent, []);
    } finally {
      relay.close();
      await closeServer(server);
    }
  });
});

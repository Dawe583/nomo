import test, { describe } from "node:test";
import assert from "node:assert/strict";

import { Session } from "./session.ts";
import type {
  JsonRpcId,
  JsonRpcMessage,
  JsonRpcNotification,
  JsonRpcRequest,
  JsonRpcResult,
} from "./rpc.ts";

describe("Session", () => {
  test("remaps request ids out and results back", () => {
    const session = new Session();
    const outbound = session.translateRequestOut(request(10, "tools/list"));

    assert.equal(outbound.id, 1);
    assert.deepEqual([...session.maps.agentToUpstream.entries()], [[10, 1]]);

    const inbound = session.translateInbound({
      jsonrpc: "2.0",
      id: 1,
      result: { tools: [] },
    });

    assert.deepEqual(inbound, {
      jsonrpc: "2.0",
      id: 10,
      result: { tools: [] },
    });
  });

  test("remaps progress tokens to the same id mapping", () => {
    const session = new Session();
    const outbound = session.translateRequestOut({
      jsonrpc: "2.0",
      id: 7,
      method: "tools/call",
      params: { name: "db.query", _meta: { progressToken: 7 } },
    });

    assert.equal(outbound.id, 1);
    assert.deepEqual(outbound.params, {
      name: "db.query",
      _meta: { progressToken: 1 },
    });

    const progress = session.translateInbound({
      jsonrpc: "2.0",
      method: "notifications/progress",
      params: { progressToken: 1, progress: 0.5 },
    });

    assert.deepEqual(progress, {
      jsonrpc: "2.0",
      method: "notifications/progress",
      params: { progressToken: 7, progress: 0.5 },
    });
  });

  test("drops inbound messages that reference unknown ids", () => {
    const session = new Session();

    assert.equal(
      session.translateInbound({ jsonrpc: "2.0", id: 99, result: {} }),
      null,
    );
    assert.equal(
      session.translateInbound({
        jsonrpc: "2.0",
        method: "notifications/progress",
        params: { progressToken: 99, progress: 1 },
      }),
      null,
    );
  });

  test("negotiates only versions the agent can accept", () => {
    const session = new Session();

    assert.equal(
      session.negotiatedVersion("2025-06-18", "2025-06-18"),
      "2025-06-18",
    );
    assert.equal(
      session.negotiatedVersion("2025-03-26", "2025-11-25"),
      "2025-03-26",
    );
    assert.equal(
      session.negotiatedVersion("2024-11-05", "2024-11-05"),
      "2024-11-05",
    );
    assert.equal(
      session.negotiatedVersion("2099-01-01", "2099-01-01"),
      "2025-11-25",
    );
  });

  test("drop removes a mapping so late results are ignored", () => {
    const session = new Session();
    const outbound = session.translateRequestOut(request(5, "tools/list"));

    session.drop(5);

    assert.deepEqual([...session.maps.agentToUpstream.entries()], []);
    assert.equal(
      session.translateInbound({ jsonrpc: "2.0", id: outbound.id, result: {} }),
      null,
    );
  });

  test("translates cancellation and removes the mapping", () => {
    const session = new Session();
    session.translateRequestOut(request(4, "tools/call"));

    const cancel = session.translateCancellation(4);

    assert.deepEqual(cancel, {
      jsonrpc: "2.0",
      method: "notifications/cancelled",
      params: { requestId: 1 },
    });
    assert.equal(session.translateCancellation(4), null);
  });

  test("uses one id stream across client and server side maps", () => {
    const session = new Session();
    session.translateRequestOut(request(1, "tools/list"));

    const serverRequest = session.translateInbound(request(2, "roots/list"));

    assert.deepEqual([...session.maps.agentToUpstream.entries()], [[1, 2]]);
    assert.deepEqual([...session.maps.upstreamToAgent.entries()], [[2, 3]]);
    assert.deepEqual(serverRequest, {
      jsonrpc: "2.0",
      id: 3,
      method: "roots/list",
    });
  });

  test("allocateAgentId never reuses ids", () => {
    const session = new Session();

    assert.equal(session.allocateAgentId(), 1);
    assert.equal(session.allocateAgentId(), 2);
    session.drop(1);
    assert.equal(session.allocateAgentId(), 3);
  });
});

function request(id: string | number, method: string): JsonRpcRequest {
  return { jsonrpc: "2.0", id, method };
}

// translateInbound returns a union whose JsonRpcError arm carries an optional
// id, so a relayed request is read through this to keep its id non-optional.
function relayedRequest(message: JsonRpcMessage | null): JsonRpcRequest {
  assert.ok(message !== null && "method" in message && "id" in message);
  return message;
}

describe("Session typed request identity", () => {
  test("string and number agent ids stay distinct and reply in their own type", () => {
    const session = new Session();
    const fromString = session.translateRequestOut(request("1", "tools/list"));
    const fromNumber = session.translateRequestOut(request(1, "tools/call"));

    assert.notEqual(fromString.id, fromNumber.id);
    const replyString = session.translateInbound({
      jsonrpc: "2.0",
      id: fromString.id,
      result: "s",
    });
    const replyNumber = session.translateInbound({
      jsonrpc: "2.0",
      id: fromNumber.id,
      result: "n",
    });

    assert.deepEqual(replyString, { jsonrpc: "2.0", id: "1", result: "s" });
    assert.deepEqual(replyNumber, { jsonrpc: "2.0", id: 1, result: "n" });
  });

  test("cancelling a string id leaves the matching numeric id active", () => {
    const session = new Session();
    const fromString = session.translateRequestOut(request("1", "tools/list"));
    const fromNumber = session.translateRequestOut(request(1, "tools/list"));

    assert.deepEqual(session.translateCancellation("1"), {
      jsonrpc: "2.0",
      method: "notifications/cancelled",
      params: { requestId: fromString.id },
    });
    assert.equal(session.translateCancellation("1"), null);
    assert.equal(
      session.translateInbound({
        jsonrpc: "2.0",
        id: fromString.id,
        result: {},
      }),
      null,
    );
    assert.deepEqual(
      session.translateInbound({
        jsonrpc: "2.0",
        id: fromNumber.id,
        result: {},
      }),
      {
        jsonrpc: "2.0",
        id: 1,
        result: {},
      },
    );
  });

  for (const token of ["progress-7", "", 0, 42]) {
    test(`restores independent progress token ${JSON.stringify(token)} without changing metadata`, () => {
      const session = new Session();
      const original: JsonRpcRequest = {
        ...request("request-7", "tools/call"),
        params: {
          name: "db.query",
          _meta: { progressToken: token, other: true },
        },
      };
      const outbound = session.translateRequestOut(original);

      assert.deepEqual(outbound.params, {
        name: "db.query",
        _meta: { progressToken: outbound.id, other: true },
      });
      assert.deepEqual(original.params, {
        name: "db.query",
        _meta: { progressToken: token, other: true },
      });
      assert.deepEqual(
        session.translateInbound({
          jsonrpc: "2.0",
          method: "notifications/progress",
          params: {
            progressToken: outbound.id,
            progress: 1,
            total: 3,
            message: "working",
          },
        }),
        {
          jsonrpc: "2.0",
          method: "notifications/progress",
          params: {
            progressToken: token,
            progress: 1,
            total: 3,
            message: "working",
          },
        },
      );
    });
  }

  for (const terminal of [
    "drop",
    "result",
    "error",
    "outbound-cancellation",
    "inbound-cancellation",
  ] as const) {
    test(`${terminal} clears progress tokens and ignores late replies`, () => {
      const session = new Session();
      const outbound = session.translateRequestOut({
        ...request("request-7", "tools/call"),
        params: { _meta: { progressToken: "progress-7" } },
      });
      const progress: JsonRpcNotification = {
        jsonrpc: "2.0",
        method: "notifications/progress",
        params: { progressToken: outbound.id, progress: 1 },
      };
      assert.notEqual(session.translateInbound(progress), null);

      if (terminal === "drop") {
        session.drop("request-7");
      } else if (terminal === "outbound-cancellation") {
        assert.notEqual(session.translateCancellation("request-7"), null);
      } else if (terminal === "inbound-cancellation") {
        assert.deepEqual(
          session.translateInbound({
            jsonrpc: "2.0",
            method: "notifications/cancelled",
            params: { requestId: outbound.id, reason: "stopped" },
          }),
          {
            jsonrpc: "2.0",
            method: "notifications/cancelled",
            params: { requestId: "request-7", reason: "stopped" },
          },
        );
      } else {
        const payload =
          terminal === "result"
            ? { result: {} }
            : { error: { code: -32603, message: "failed" } };
        assert.deepEqual(
          session.translateInbound({
            jsonrpc: "2.0",
            id: outbound.id,
            ...payload,
          }),
          {
            jsonrpc: "2.0",
            id: "request-7",
            ...payload,
          },
        );
      }

      assert.equal(session.maps.agentToUpstream.size, 0);
      assert.equal(session.translateInbound(progress), null);
      assert.equal(
        session.translateInbound({
          jsonrpc: "2.0",
          id: outbound.id,
          result: {},
        }),
        null,
      );
      assert.equal(session.translateCancellation("request-7"), null);
    });
  }

  test("duplicate inbound server request ids get distinct agent ids", () => {
    const session = new Session();
    const first = session.translateInbound(request(42, "roots/list"));
    const second = session.translateInbound(request(42, "roots/list"));

    assert.notEqual(
      (first as JsonRpcRequest).id,
      (second as JsonRpcRequest).id,
    );
  });

  test("S11: server-originated numeric strings never coerce to their numeric lookalike", () => {
    const session = new Session();
    const fromNumber = session.translateInbound(request(42, "roots/list"));
    const fromString = session.translateInbound(request("42", "roots/list"));

    assert.notEqual(
      (fromNumber as JsonRpcRequest).id,
      (fromString as JsonRpcRequest).id,
    );
    assert.deepEqual(
      [...session.maps.upstreamToAgent.entries()],
      [
        [42, (fromNumber as JsonRpcRequest).id],
        ["42", (fromString as JsonRpcRequest).id],
      ],
    );
  });

  test("S11: leading-zero server ids stay distinct strings", () => {
    const session = new Session();
    const plain = session.translateInbound(request("1", "roots/list"));
    const padded = session.translateInbound(request("01", "roots/list"));

    assert.notEqual(
      (plain as JsonRpcRequest).id,
      (padded as JsonRpcRequest).id,
    );
  });

  test("S11: a string response id is an unknown identity, never a coerced reply", () => {
    const session = new Session();
    const outbound = session.translateRequestOut(request(7, "tools/list"));

    assert.equal(
      session.translateInbound({
        jsonrpc: "2.0",
        id: String(outbound.id),
        result: {},
      }),
      null,
    );
    assert.deepEqual(
      session.translateInbound({ jsonrpc: "2.0", id: outbound.id, result: {} }),
      {
        jsonrpc: "2.0",
        id: 7,
        result: {},
      },
    );
  });

  test("S11: inbound cancellation with a string request id translates in its own type", () => {
    const session = new Session();
    session.translateRequestOut(request("7", "tools/call"));
    const outboundNumber = session.translateRequestOut(
      request(7, "tools/call"),
    );

    assert.deepEqual(
      session.translateInbound({
        jsonrpc: "2.0",
        method: "notifications/cancelled",
        params: { requestId: outboundNumber.id },
      }),
      {
        jsonrpc: "2.0",
        method: "notifications/cancelled",
        params: { requestId: 7 },
      },
    );
  });

  test("S11: recordServerRequest keeps typed ids for the relay path", () => {
    const session = new Session();
    session.recordServerRequest("42", 9);

    assert.deepEqual([...session.maps.upstreamToAgent.entries()], [["42", 9]]);
  });

  test("S11: a server-originated request's progress restores the server's own token", () => {
    const session = new Session();
    const relayed = session.translateInbound({
      jsonrpc: "2.0",
      id: "srv-1",
      method: "roots/list",
      params: { _meta: { progressToken: "srv-token" } },
    });
    assert.ok(relayed !== null && "method" in relayed && "id" in relayed);

    const progress = session.translateInbound({
      jsonrpc: "2.0",
      method: "notifications/progress",
      params: { progressToken: relayed.id, progress: 1 },
    });

    assert.deepEqual(progress, {
      jsonrpc: "2.0",
      method: "notifications/progress",
      params: { progressToken: "srv-token", progress: 1 },
    });
  });

  test("S11: recordServerRequest reserves the upstream id against later allocation", () => {
    const session = new Session();
    session.recordServerRequest(7, 1);

    const allocated = Array.from({ length: 7 }, () => session.translateRequestOut(request(9, "tools/list")).id);

    assert.ok(!allocated.includes(7), `session re-issued the reserved upstream id: ${allocated.join(", ")}`);
  });
});

describe("Session retention", () => {
  test("1000 answered server-originated requests leave no upstream row", () => {
    const session = new Session();
    const agentIds: JsonRpcId[] = [];

    for (let id = 0; id < 1000; id++) {
      const relayed = relayedRequest(session.translateInbound(request(id, "roots/list")));
      agentIds.push(relayed.id);
    }

    assert.equal(session.maps.upstreamToAgent.size, 1000);
    assert.equal(session.maps.agentToUpstream.size, 0);

    for (const agentId of agentIds) {
      session.drop(agentId);
    }

    assert.equal(session.maps.upstreamToAgent.size, 0);
    assert.equal(session.maps.agentToUpstream.size, 0);
  });

  test("a reply to a server-originated request releases only that row", () => {
    const session = new Session();
    const relayed = relayedRequest(session.translateInbound(request(42, "roots/list")));
    const clientRow = session.translateRequestOut(request(1, "tools/list"));

    // The frame names the id this session minted for the server request. It
    // is not an id any client request is waiting on, so it routes nowhere and
    // is dropped, but the server row it names retires. The client's row holds
    // a different upstream id and must stay live: a release that resolved by
    // number rather than by the row the frame names would drop it.
    assert.equal(
      session.translateInbound({ jsonrpc: "2.0", id: relayed.id, result: {} }),
      null,
    );

    assert.equal(session.maps.upstreamToAgent.size, 0);
    assert.deepEqual([...session.maps.agentToUpstream.entries()], [[1, clientRow.id]]);
    assert.notEqual(
      session.translateInbound({ jsonrpc: "2.0", id: clientRow.id, result: {} }),
      null,
    );
  });

  test("an inbound cancellation that names a server-originated id releases that row", () => {
    const session = new Session();
    session.translateInbound(request("srv-1", "roots/list"));

    assert.equal(
      session.translateInbound({
        jsonrpc: "2.0",
        method: "notifications/cancelled",
        params: { requestId: "srv-1" },
      }),
      null,
    );
    assert.equal(session.maps.upstreamToAgent.size, 0);
  });

  test("a released server request stops restoring its progress token", () => {
    const session = new Session();
    const relayed = relayedRequest(
      session.translateInbound({
        jsonrpc: "2.0",
        id: "srv-1",
        method: "roots/list",
        params: { _meta: { progressToken: "srv-token" } },
      }),
    );
    const progress: JsonRpcNotification = {
      jsonrpc: "2.0",
      method: "notifications/progress",
      params: { progressToken: relayed.id, progress: 1 },
    };
    assert.notEqual(session.translateInbound(progress), null);

    session.drop(relayed.id);

    assert.equal(session.translateInbound(progress), null);
    assert.equal(session.maps.upstreamToAgent.size, 0);
  });

  test("an id a live request holds is never re-issued while it is live", () => {
    const session = new Session();
    session.translateRequestOut(request(7, "tools/list"));
    session.recordServerRequest(8, 9);

    const minted = Array.from({ length: 20 }, () => session.allocateAgentId());

    assert.ok(!minted.includes(7), `re-issued a live client id: ${minted.join(", ")}`);
    assert.ok(!minted.includes(8), `re-issued a live upstream id: ${minted.join(", ")}`);
    assert.ok(!minted.includes(9), `re-issued a live agent id: ${minted.join(", ")}`);
    assert.deepEqual([...session.maps.upstreamToAgent.entries()], [[8, 9]]);
    assert.deepEqual([...session.maps.agentToUpstream.entries()], [[7, 1]]);
  });

  test("a terminal request's id is released and can be minted again", () => {
    const session = new Session();
    session.recordServerRequest(5000, 1);
    session.drop(1);
    assert.equal(session.maps.upstreamToAgent.size, 0);

    const minted = Array.from({ length: 5000 }, () => session.allocateAgentId());

    assert.ok(minted.includes(5000), `a released id stayed reserved: ${minted.join(", ")}`);
  });
});

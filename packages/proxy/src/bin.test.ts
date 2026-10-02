import { generateKeyPairSync } from "node:crypto";
import { keyProviderFromPkcs8 } from "../../ledger/src/sign.ts";
import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import type { IncomingMessage, Server, ServerResponse } from "node:http";

import { ProxyStartupError, runProxy } from "./bin.ts";
import type { ProxyOptions, UpstreamEvents } from "./bin.ts";
import type { HoldQueue } from "../../policy/src/index.ts";
import type { UpstreamProcess } from "./transport/stdio.ts";
import type {
  LegacyCaptureEvidence,
  LegacyProxyBinding,
} from "./forward/legacy-binding.ts";

const platformTestTimeoutMs = (
  milliseconds: number,
  windowsMilliseconds: number,
): number =>
  process.platform === "win32" ? windowsMilliseconds : milliseconds;

describe("runProxy", () => {
  test("initialize negotiation answers a version the agent supports", async () => {
    const harness = await makeHarness("allow");

    await harness.run([
      {
        jsonrpc: "2.0",
        id: 10,
        method: "initialize",
        params: { protocolVersion: "2025-03-26", capabilities: {} },
      },
    ]);

    assert.equal(harness.upstreamMessages[0]?.method, "initialize");
    assert.deepEqual(harness.outputMessages, [
      {
        jsonrpc: "2.0",
        id: 10,
        result: {
          protocolVersion: "2025-03-26",
          capabilities: { tools: {} },
          serverInfo: { name: "fake", version: "1" },
        },
      },
    ]);
  });

  test("tools call allow forwards and maps the upstream result back", async () => {
    const harness = await makeHarness("allow");

    await harness.run([toolCall(21, "aws.s3.bucket.delete")]);

    assert.equal(harness.upstreamMessages.length, 1);
    assert.equal(harness.upstreamMessages[0]?.id, 1);
    assert.deepEqual(harness.outputMessages, [
      { jsonrpc: "2.0", id: 21, result: { called: "aws.s3.bucket.delete" } },
    ]);
  });

  test("string cancellation maps upstream without cancelling the matching numeric id", async () => {
    const harness = await makeHarness("allow");

    await harness.run([
      { jsonrpc: "2.0", id: "1", method: "resources/list" },
      { jsonrpc: "2.0", id: 1, method: "resources/list" },
      {
        jsonrpc: "2.0",
        method: "notifications/cancelled",
        params: { requestId: "1" },
      },
      {
        jsonrpc: "2.0",
        method: "notifications/cancelled",
        params: { requestId: 1 },
      },
    ]);

    const [fromString, fromNumber, cancelString, cancelNumber] =
      harness.upstreamMessages;
    assert.notEqual(fromString?.id, fromNumber?.id);
    assert.deepEqual(cancelString, {
      jsonrpc: "2.0",
      method: "notifications/cancelled",
      params: { requestId: fromString?.id },
    });
    assert.deepEqual(cancelNumber, {
      jsonrpc: "2.0",
      method: "notifications/cancelled",
      params: { requestId: fromNumber?.id },
    });
    assert.equal(harness.upstreamMessages.length, 4);
    assert.deepEqual(harness.outputMessages, []);
    assert.deepEqual(harness.errors, []);
  });

  test("tools call deny answers locally and does not send upstream", async () => {
    const harness = await makeHarness("deny");

    await harness.run([toolCall(22, "aws.s3.bucket.delete")]);

    assert.deepEqual(harness.upstreamMessages, []);
    assert.equal(harness.outputMessages.length, 1);
    const error = harness.outputMessages[0] as {
      readonly id: number;
      readonly error: { readonly message: string };
    };
    assert.equal(error.id, 22);
    assert.match(error.error.message, /denied/);
    assert.match(error.error.message, /Do not retry/);
  });

  test("held call approved then forwards", async () => {
    const harness = await makeHarness("hold");
    let queue: HoldQueue | null = null;
    harness.onHold = (q) => {
      queue = q;
    };
    queueMicrotask(async () => {
      const q = await waitForQueue(() => queue);
      q.resolve(q.list()[0]!.id, { kind: "approved" });
    });

    await harness.run([toolCall(23, "aws.s3.bucket.delete")]);

    assert.equal(harness.upstreamMessages.length, 1);
    assert.deepEqual(harness.outputMessages, [
      { jsonrpc: "2.0", id: 23, result: { called: "aws.s3.bucket.delete" } },
    ]);
  });

  test("held call denied answers with the readable hold error", async () => {
    const harness = await makeHarness("hold");
    let queue: HoldQueue | null = null;
    harness.onHold = (q) => {
      queue = q;
    };
    queueMicrotask(async () => {
      const q = await waitForQueue(() => queue);
      q.resolve(q.list()[0]!.id, { kind: "denied", by: "test" });
    });

    await harness.run([toolCall(24, "aws.s3.bucket.delete")]);

    assert.deepEqual(harness.upstreamMessages, []);
    const error = harness.outputMessages[0] as {
      readonly id: number;
      readonly error: { readonly message: string };
    };
    assert.equal(error.id, 24);
    assert.match(error.error.message, /was denied by a human/);
    assert.match(error.error.message, /Do not retry/);
  });

  test("observe posture forwards a denied call and logs it", async () => {
    const harness = await makeHarness("deny", "observe");

    await harness.run([toolCall(25, "aws.s3.bucket.delete")]);

    assert.equal(harness.upstreamMessages.length, 1);
    assert.match(harness.errors.join("\n"), /observe: deny verdict/);
    assert.deepEqual(harness.outputMessages, [
      { jsonrpc: "2.0", id: 25, result: { called: "aws.s3.bucket.delete" } },
    ]);
  });

  test("malformed stdin line gets a JSON-RPC parse error", async () => {
    const harness = await makeHarness("allow");

    await harness.runRaw(["not json"]);

    assert.deepEqual(harness.upstreamMessages, []);
    assert.deepEqual(harness.outputMessages, [
      {
        jsonrpc: "2.0",
        id: null,
        error: { code: -32700, message: "Parse error" },
      },
    ]);
  });

  test("upstream exit drains held calls as expired", async () => {
    const harness = await makeHarness("hold");
    let events: UpstreamEvents | null = null;
    harness.captureEvents = (e) => {
      events = e;
    };
    let queue: HoldQueue | null = null;
    harness.onHold = (q) => {
      queue = q;
    };
    queueMicrotask(async () => {
      await waitForQueue(() => queue);
      events?.onClose(1, null);
    });

    await harness.run([toolCall(26, "aws.s3.bucket.delete")]);

    assert.deepEqual(harness.upstreamMessages, []);
    const error = harness.outputMessages[0] as {
      readonly id: number;
      readonly error: {
        readonly message: string;
        readonly data: { readonly result: string };
      };
    };
    assert.equal(error.id, 26);
    assert.match(error.error.message, /expired without a human decision/);
    assert.equal(error.error.data.result, "expired");
  });

  test("http transport initialize forwards through the upstream URL", async () => {
    const server = await startHttpUpstream();
    const harness = await makeHttpHarness(server, "allow");
    const run = harness.start();

    harness.input.push(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 31,
        method: "initialize",
        params: { protocolVersion: "2025-03-26", capabilities: {} },
      }),
    );
    await waitFor(
      () => harness.outputMessages.length === 1,
      "http initialize response",
    );
    harness.input.close();
    await run;
    await server.close();

    assert.equal(server.messages[0]?.method, "initialize");
    assert.deepEqual(harness.outputMessages, [
      {
        jsonrpc: "2.0",
        id: 31,
        result: {
          protocolVersion: "2025-03-26",
          capabilities: { tools: {} },
          serverInfo: { name: "fake-http", version: "1" },
        },
      },
    ]);
  });

  test("http transport tools call allow forwards and maps result", async () => {
    const server = await startHttpUpstream();
    const harness = await makeHttpHarness(server, "allow");
    const run = harness.start();

    harness.input.push(JSON.stringify(toolCall(32, "aws.s3.bucket.delete")));
    await waitFor(
      () => harness.outputMessages.length === 1,
      "http allow response",
    );
    harness.input.close();
    await run;
    await server.close();

    assert.equal(server.messages.length, 1);
    assert.equal(server.messages[0]?.id, 1);
    assert.deepEqual(harness.outputMessages, [
      { jsonrpc: "2.0", id: 32, result: { called: "aws.s3.bucket.delete" } },
    ]);
  });

  test("http transport held call parks until approval and records the ledger", async () => {
    const server = await startHttpUpstream();
    const harness = await makeHttpHarness(server, "hold");
    let queue: HoldQueue | null = null;
    harness.onHold = (q) => {
      queue = q;
    };
    const run = harness.start();

    harness.input.push(JSON.stringify(toolCall(33, "aws.s3.bucket.delete")));
    const q = await waitForQueue(() => queue);
    assert.equal(server.messages.length, 0);
    q.resolve(q.list()[0]!.id, { kind: "approved" });
    await waitFor(
      () => harness.outputMessages.length === 1,
      "http held response",
    );
    harness.input.close();
    await run;
    await server.close();

    assert.equal(server.messages.length, 1);
    assert.deepEqual(harness.outputMessages, [
      { jsonrpc: "2.0", id: 33, result: { called: "aws.s3.bucket.delete" } },
    ]);
    const ledger = await readLedgerDecisions(harness.ledgerDir, "test-http");
    assert.ok(ledger.includes("hold"));
    assert.ok(ledger.includes("hold:approved"));
  });

  test("http transport deny answers locally", async () => {
    const server = await startHttpUpstream();
    const harness = await makeHttpHarness(server, "deny");
    const run = harness.start();

    harness.input.push(JSON.stringify(toolCall(34, "aws.s3.bucket.delete")));
    await waitFor(
      () => harness.outputMessages.length === 1,
      "http deny response",
    );
    harness.input.close();
    await run;
    await server.close();

    assert.deepEqual(server.messages, []);
    const error = harness.outputMessages[0] as {
      readonly id: number;
      readonly error: { readonly message: string };
    };
    assert.equal(error.id, 34);
    assert.match(error.error.message, /denied/);
  });

  test("stdio transport warns when upstreamUrl is supplied", async () => {
    const dir = await mkdtemp(join(tmpdir(), "void-proxy-"));
    const policyPath = join(dir, "policy.yml");
    await writeFile(policyPath, policyText("allow"));
    const errors: string[] = [];

    await runProxy({
      keyProvider: keyProviderFromPkcs8(
        generateKeyPairSync("ed25519").privateKey.export({
          format: "der",
          type: "pkcs8",
        }),
      ),
      upstreamCommand: ["fake"],
      upstreamUrl: "http://127.0.0.1:1/mcp",
      policyPath,
      posture: "fail-closed",
      ledgerDir: await mkdtemp(join(tmpdir(), "void-bin-test-")),
      input: fromLines([]),
      output() {},
      error(line) {
        errors.push(line);
      },
      upstreamSpawn(events) {
        return fakeUpstream(events, []);
      },
    });

    assert.match(
      errors.join("\n"),
      /upstreamUrl is ignored for stdio transport/,
    );
  });

  test("http transport without upstreamUrl throws a startup error", async () => {
    await assert.rejects(
      () =>
        runProxy({
          keyProvider: keyProviderFromPkcs8(
            generateKeyPairSync("ed25519").privateKey.export({
              format: "der",
              type: "pkcs8",
            }),
          ),
          transport: "http",
          policyPath: "unused.yml",
          posture: "observe",
          input: fromLines([]),
          output() {},
          error() {},
        }),
      ProxyStartupError,
    );
  });
});

test("concurrent server requests restore typed upstream ids for success and error replies", async () => {
  const dir = await mkdtemp(join(tmpdir(), "void-proxy-server-request-"));
  const policyPath = join(dir, "policy.yml");
  await writeFile(policyPath, policyText("allow"));
  const agentInput = lineQueue();
  const agentOutput: Array<Record<string, unknown>> = [];
  const upstreamSeen: Array<Record<string, unknown>> = [];
  const serverIds: Array<string | number> = ["server-42", 42];

  const run = runProxy({
    keyProvider: keyProviderFromPkcs8(
      generateKeyPairSync("ed25519").privateKey.export({
        format: "der",
        type: "pkcs8",
      }),
    ),
    upstreamCommand: ["fake"],
    policyPath,
    posture: "fail-closed",
    ledgerDir: join(dir, "ledger"),
    workspace: "test",
    input: agentInput,
    output: (line) => {
      agentOutput.push(JSON.parse(line) as Record<string, unknown>);
    },
    error: () => {},
    upstreamSpawn: (events) => ({
      send(line) {
        const message = JSON.parse(line) as {
          readonly id?: string | number;
          readonly method?: string;
        };
        upstreamSeen.push(message as Record<string, unknown>);
        if (message.method === "initialize") {
          events.onMessage(
            JSON.stringify({
              jsonrpc: "2.0",
              id: message.id,
              result: {
                protocolVersion: "2025-11-25",
                capabilities: {},
                serverInfo: { name: "fake", version: "1" },
              },
            }),
          );
          for (const id of serverIds)
            events.onMessage(
              JSON.stringify({
                jsonrpc: "2.0",
                id,
                method: "roots/list",
                params: { request: id },
              }),
            );
          return;
        }
        if (
          !serverIds.includes(message.id as string | number) &&
          message.id !== undefined
        )
          events.onMessage(
            JSON.stringify({
              jsonrpc: "2.0",
              id: message.id,
              result: { rootUris: [] },
            }),
          );
      },
      close() {},
      onStderr() {
        return () => {};
      },
    }),
  });

  agentInput.push(
    JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-11-25",
        capabilities: {},
        clientInfo: { name: "agent", version: "1" },
      },
    }),
  );
  await waitFor(
    () =>
      agentOutput.filter((message) => message.method === "roots/list").length ===
      2,
    "both server requests to reach the agent",
  );
  const relayed = agentOutput.filter((message) => message.method === "roots/list");
  assert.notEqual(relayed[0]!.id, relayed[1]!.id);
  const agentIdForServerId = new Map(
    relayed.map((message) => [
      (message.params as { request: string | number }).request,
      message.id as string | number,
    ]),
  );
  agentInput.push(
    JSON.stringify({
      jsonrpc: "2.0",
      id: agentIdForServerId.get(42),
      error: { code: -32001, message: "declined", data: { retryable: false } },
    }),
  );
  agentInput.push(
    JSON.stringify({
      jsonrpc: "2.0",
      id: agentIdForServerId.get("server-42"),
      result: { rootUris: ["file:///workspace"] },
    }),
  );
  await waitFor(
    () =>
      serverIds.every((id) =>
        upstreamSeen.some((message) => message.id === id),
      ),
    "both replies to reach upstream",
  );
  assert.ok(
    upstreamSeen.some(
      (message) =>
        message.id === "server-42" &&
        JSON.stringify(message.result) ===
          JSON.stringify({ rootUris: ["file:///workspace"] }),
    ),
  );
  assert.ok(
    upstreamSeen.some(
      (message) =>
        message.id === 42 &&
        JSON.stringify(message.error) ===
          JSON.stringify({
            code: -32001,
            message: "declined",
            data: { retryable: false },
          }),
    ),
  );

  agentInput.close();
  await run;
  await rm(dir, { recursive: true, force: true });
});

test("bound legacy call records capture and outcome before relay", async () => {
  const events: string[] = [];
  const outcomes: string[] = [];
  const output: unknown[] = [];
  const binding = testLegacyBinding(events, outcomes);

  await runBoundProxy({
    binding,
    messages: [toolCall(81, binding.tool)],
    output(line) {
      events.push("agent");
      output.push(JSON.parse(line) as unknown);
    },
    upstream(eventsApi) {
      return {
        send(line) {
          events.push("upstream");
          const request = JSON.parse(line) as { id: number };
          eventsApi.onMessage(
            JSON.stringify({
              jsonrpc: "2.0",
              id: request.id,
              result: { applied: true },
            }),
          );
        },
        close() {},
        onStderr() {
          return () => {};
        },
      };
    },
  });

  assert.deepEqual(events, [
    "capture",
    "dispatched",
    "upstream",
    "completed",
    "agent",
  ]);
  assert.deepEqual(outcomes, ["completed"]);
  assert.deepEqual(output, [
    { jsonrpc: "2.0", id: 81, result: { applied: true } },
  ]);
});

test("bound capture failure sends zero upstream requests", async () => {
  let upstreamCalls = 0;
  const output: unknown[] = [];
  const base = testLegacyBinding([], []);
  const binding: LegacyProxyBinding = {
    ...base,
    async capture() {
      throw new Error("snapshot unavailable");
    },
  };
  await runBoundProxy({
    binding,
    messages: [toolCall(84, binding.tool)],
    output: (line) => output.push(JSON.parse(line) as unknown),
    upstream() {
      return {
        send() {
          upstreamCalls += 1;
        },
        close() {},
        onStderr() {
          return () => {};
        },
      };
    },
  });
  assert.equal(upstreamCalls, 0);
  assert.match(JSON.stringify(output), /snapshot capture failed/);
});

test("bound JSON-RPC error records failed before relay", async () => {
  const lifecycle: string[] = [];
  const outcomes: string[] = [];
  const output: unknown[] = [];
  const binding = testLegacyBinding(lifecycle, outcomes);
  await runBoundProxy({
    binding,
    messages: [toolCall(85, binding.tool)],
    output: (line) => output.push(JSON.parse(line) as unknown),
    upstream(eventsApi) {
      return {
        send(line) {
          const request = JSON.parse(line) as { id: number };
          eventsApi.onMessage(
            JSON.stringify({
              jsonrpc: "2.0",
              id: request.id,
              error: { code: -32000, message: "write failed" },
            }),
          );
        },
        close() {},
        onStderr() {
          return () => {};
        },
      };
    },
  });
  assert.deepEqual(outcomes, ["failed"]);
  assert.match(JSON.stringify(output), /write failed/);
});

test("binding cannot mutate arguments sent upstream", async () => {
  const base = testLegacyBinding([], []);
  let forwardedSql: unknown;
  const binding: LegacyProxyBinding = {
    ...base,
    async capture(call, argsDigest) {
      const evidence = await base.capture(call, argsDigest);
      assert.throws(
        () => { (call.args.command as { sql: string }).sql = "delete from account"; },
        TypeError,
      );
      return evidence;
    },
  };
  await runBoundProxy({
    binding,
    messages: [{
      jsonrpc: "2.0",
      id: 86,
      method: "tools/call",
      params: { name: binding.tool, arguments: { command: { sql: "update account set balance=20" } } },
    }],
    upstream(eventsApi) {
      return {
        send(line) {
          const request = JSON.parse(line) as { id: number; params: { arguments: { command: { sql: string } } } };
          forwardedSql = request.params.arguments.command.sql;
          eventsApi.onMessage(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { applied: true } }));
        },
        close() {},
        onStderr() { return () => {}; },
      };
    },
  });
  assert.equal(forwardedSql, "update account set balance=20");
});

test("binding resolver receives recursively frozen arguments", async () => {
  const base = testLegacyBinding([], []);
  let forwardedSql: unknown;
  await runBoundProxy({
    binding: base,
    resolver(call) {
      assert.throws(
        () => { (call.args.command as { sql: string }).sql = "delete from account"; },
        TypeError,
      );
      return base;
    },
    messages: [{
      jsonrpc: "2.0",
      id: 89,
      method: "tools/call",
      params: { name: base.tool, arguments: { command: { sql: "update account set balance=20" } } },
    }],
    upstream(eventsApi) {
      return {
        send(line) {
          const request = JSON.parse(line) as { id: number; params: { arguments: { command: { sql: string } } } };
          forwardedSql = request.params.arguments.command.sql;
          eventsApi.onMessage(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { applied: true } }));
        },
        close() {},
        onStderr() { return () => {}; },
      };
    },
  });
  assert.equal(forwardedSql, "update account set balance=20");
});

test("malformed upstream response records unknown and drops a late response", async () => {
  const outcomes: string[] = [];
  const output: unknown[] = [];
  const binding = testLegacyBinding([], outcomes);
  await runBoundProxy({
    binding,
    messages: [toolCall(87, binding.tool)],
    output: line => output.push(JSON.parse(line) as unknown),
    upstream(eventsApi) {
      return {
        send(line) {
          const request = JSON.parse(line) as { id: number };
          eventsApi.onMessage("not json");
          eventsApi.onMessage(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { applied: true } }));
        },
        close() {},
        onStderr() { return () => {}; },
      };
    },
  });
  assert.deepEqual(outcomes, ["unknown"]);
  assert.deepEqual(output, []);
});

test("failed unknown persistence tombstones the call and sanitizes errors", async () => {
  const attempts: string[] = [];
  const output: unknown[] = [];
  const errors: string[] = [];
  const base = testLegacyBinding([], []);
  const binding: LegacyProxyBinding = {
    ...base,
    async outcome(evidence, response) {
      if (response === null) {
        attempts.push("unknown");
        throw new Error("sql=secret credential=secret");
      }
      attempts.push("completed");
      return base.outcome(evidence, response);
    },
  };
  await runBoundProxy({
    binding,
    messages: [toolCall(90, binding.tool)],
    output: line => output.push(JSON.parse(line) as unknown),
    error: line => errors.push(line),
    upstream(eventsApi) {
      return {
        send(line) {
          const request = JSON.parse(line) as { id: number };
          eventsApi.onMessage("not json");
          eventsApi.onMessage(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { applied: true } }));
        },
        close() {},
        onStderr() { return () => {}; },
      };
    },
  });
  assert.deepEqual(attempts, ["unknown"]);
  assert.deepEqual(output, []);
  assert.doesNotMatch(errors.join("\n"), /secret/);
});

test("dispatched evidence failure records failed and sends zero upstream requests", async () => {
  const outcomes: string[] = [];
  let upstreamCalls = 0;
  const base = testLegacyBinding([], outcomes);
  const binding: LegacyProxyBinding = {
    ...base,
    async dispatched() { throw new Error("sql=secret credential=secret"); },
  };
  await runBoundProxy({
    binding,
    messages: [toolCall(88, binding.tool)],
    upstream() {
      return {
        send() { upstreamCalls += 1; },
        close() {},
        onStderr() { return () => {}; },
      };
    },
  });
  assert.equal(upstreamCalls, 0);
  assert.deepEqual(outcomes, ["failed"]);
});

test("bound legacy call records unknown on close after dispatch", async () => {
  const lifecycle: string[] = [];
  const outcomes: string[] = [];
  const binding = testLegacyBinding(lifecycle, outcomes);

  await runBoundProxy({
    binding,
    messages: [toolCall(82, binding.tool)],
    upstream(eventsApi) {
      return {
        send() {
          lifecycle.push("upstream");
          eventsApi.onClose(1, null);
        },
        close() {},
        onStderr() {
          return () => {};
        },
      };
    },
  });

  assert.deepEqual(outcomes, ["unknown"]);
  assert.equal(lifecycle.filter((item) => item === "upstream").length, 1);
});

test("bound legacy calls keep numeric and string ids distinct", async () => {
  const lifecycle: string[] = [];
  const outcomes: string[] = [];
  const captures: LegacyCaptureEvidence[] = [];
  const base = testLegacyBinding(lifecycle, outcomes);
  const binding: LegacyProxyBinding = {
    ...base,
    async capture(call, argsDigest) {
      const evidence = await base.capture(call, argsDigest);
      const index = captures.length + 1;
      const captureDigest = `sha256:${String(index).repeat(64)}`;
      const next = {
        ...evidence,
        captureDigest,
        reference: { ...evidence.reference, digest: captureDigest },
      };
      captures.push(next);
      return next;
    },
  };
  const pending: Array<{ id: number }> = [];

  await runBoundProxy({
    binding,
    messages: [toolCall(1, binding.tool), toolCall("1", binding.tool)],
    upstream(eventsApi) {
      return {
        send(line) {
          pending.push(JSON.parse(line) as { id: number });
          if (pending.length === 2) {
            eventsApi.onMessage(
              JSON.stringify({
                jsonrpc: "2.0",
                id: pending[1]!.id,
                result: { applied: true },
              }),
            );
            eventsApi.onMessage(
              JSON.stringify({
                jsonrpc: "2.0",
                id: pending[0]!.id,
                result: { applied: true },
              }),
            );
          }
        },
        close() {},
        onStderr() {
          return () => {};
        },
      };
    },
  });

  assert.notEqual(pending[0]?.id, pending[1]?.id);
  assert.deepEqual(outcomes, [
    captures[1]!.captureDigest,
    captures[0]!.captureDigest,
  ]);
});

test("observe posture never resolves a recovery binding", async () => {
  let resolves = 0;
  const upstreamMessages: Array<Record<string, unknown>> = [];
  await runBoundProxy({
    posture: "observe",
    binding: testLegacyBinding([], []),
    resolver() {
      resolves += 1;
      throw new Error("observe must not resolve bindings");
    },
    messages: [toolCall(83, "postgres.row.update")],
    upstream(eventsApi) {
      return fakeUpstream(eventsApi, upstreamMessages);
    },
  });
  assert.equal(resolves, 0);
  assert.equal(upstreamMessages.length, 1);
});

test("failed legacy snapshot answers deny locally and never calls upstream (exit proof)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "void-proxy-"));
  const policyPath = join(dir, "policy.yml");
  // orders_delete is unclassified, so the allow path needs the explicit
  // unknown opt-in: a bare catch-all allow no longer authorizes it (S07).
  await writeFile(
    policyPath,
    "version: 1\nrules:\n  - match: { class: unknown }\n    decision: allow\n  - match: {}\n    decision: deny\n",
  );
  const upstreamMessages: Array<Record<string, unknown>> = [];
  const outputMessages: unknown[] = [];
  const errors: string[] = [];

  await runProxy({
    keyProvider: keyProviderFromPkcs8(
      generateKeyPairSync("ed25519").privateKey.export({
        format: "der",
        type: "pkcs8",
      }),
    ),
    upstreamCommand: ["fake"],
    policyPath,
    posture: "fail-closed",
    ledgerDir: await mkdtemp(join(tmpdir(), "void-bin-test-")),
    workspace: "test",
    input: fromLines([JSON.stringify(toolCall(41, "orders_delete"))]),
    output(line) {
      outputMessages.push(JSON.parse(line) as unknown);
    },
    error(line) {
      errors.push(line);
    },
    legacyCapture: async () => {
      throw new Error("snapshot unavailable: disk full");
    },
    upstreamSpawn(events) {
      return fakeUpstream(events, upstreamMessages);
    },
  });

  assert.deepEqual(upstreamMessages, []);
  assert.equal(outputMessages.length, 1);
  const error = outputMessages[0] as {
    readonly id: number;
    readonly error: { readonly message: string };
  };
  assert.equal(error.id, 41);
  assert.match(error.error.message, /snapshot capture failed/);
  assert.match(error.error.message, /upstream was not called/);
});

test("runProxy filters inherited environment and honors explicit upstreamEnv", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "void-proxy-env-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const policyPath = join(dir, "policy.yml");
  await writeFile(policyPath, policyText("deny"));
  const previous = process.env.VOID_ENV_PROBE_SECRET;
  process.env.VOID_ENV_PROBE_SECRET = "synthetic-parent-value";
  t.after(() => {
    if (previous === undefined) delete process.env.VOID_ENV_PROBE_SECRET;
    else process.env.VOID_ENV_PROBE_SECRET = previous;
  });
  const script = `
    const rl = require('node:readline').createInterface({ input: process.stdin });
    rl.once('line', line => {
      const request = JSON.parse(line);
      const result = {
        secret: process.env.VOID_ENV_PROBE_SECRET ?? null,
        path: typeof process.env.PATH === 'string',
      };
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + '\\n', () => process.exit(0));
    });
  `;
  for (const upstreamEnv of [
    undefined,
    { VOID_ENV_PROBE_SECRET: "explicit-child-value" },
  ]) {
    const input = lineQueue();
    const output: unknown[] = [];
    const errors: string[] = [];
    input.push(
      JSON.stringify({ jsonrpc: "2.0", id: 71, method: "tools/list" }),
    );
    const timer = setTimeout(
      () => input.close(),
      platformTestTimeoutMs(5_000, 30_000),
    );
    try {
      await runProxy({
        upstreamCommand: [process.execPath, "-e", script],
        upstreamEnv,
        policyPath,
        posture: "observe",
        shutdownSignals: false,
        input,
        output: (line) => output.push(JSON.parse(line)),
        error: (line) => errors.push(line),
      });
    } finally {
      clearTimeout(timer);
      input.close();
    }
    assert.deepEqual(errors, []);
    assert.deepEqual(output, [
      {
        jsonrpc: "2.0",
        id: 71,
        result: {
          secret: upstreamEnv?.VOID_ENV_PROBE_SECRET ?? null,
          path: process.env.PATH !== undefined,
        },
      },
    ]);
  }
});

type BoundProxyInput = {
  readonly binding: LegacyProxyBinding;
  readonly resolver?: ProxyOptions["legacyBinding"];
  readonly messages: readonly Record<string, unknown>[];
  readonly posture?: ProxyOptions["posture"];
  readonly output?: (line: string) => void;
  readonly error?: (line: string) => void;
  readonly upstream: (events: UpstreamEvents) => UpstreamProcess;
};

async function runBoundProxy(input: BoundProxyInput): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "void-bound-proxy-"));
  const policyPath = join(dir, "policy.yml");
  await writeFile(policyPath, policyText("allow"));
  await runProxy({
    keyProvider: keyProviderFromPkcs8(
      generateKeyPairSync("ed25519").privateKey.export({
        format: "der",
        type: "pkcs8",
      }),
    ),
    upstreamCommand: ["fake"],
    policyPath,
    posture: input.posture ?? "fail-closed",
    ledgerDir: join(dir, "ledger"),
    workspace: "test",
    input: fromLines(input.messages.map((message) => JSON.stringify(message))),
    output: input.output ?? (() => {}),
    error: input.error ?? (() => {}),
    legacyBinding:
      input.resolver ??
      ((call) => (call.tool === input.binding.tool ? input.binding : null)),
    upstreamSpawn: input.upstream,
  });
  await rm(dir, { recursive: true, force: true });
}

function testLegacyBinding(
  lifecycle: string[],
  outcomes: string[],
): LegacyProxyBinding {
  return {
    tool: "postgres.row.update",
    async capture(call, argsDigest) {
      lifecycle.push("capture");
      const captureDigest = `sha256:${"a".repeat(64)}`;
      return {
        schema: "void.legacy.capture.v1",
        at: new Date().toISOString(),
        tool: call.tool,
        workspace: call.workspace,
        argsDigest,
        captureDigest,
        reference: {
          namespace: "test/postgres",
          digest: captureDigest,
          uri: "file:///snapshot",
        },
      };
    },
    async dispatched() {
      lifecycle.push("dispatched");
    },
    async outcome(evidence, response) {
      const status =
        response === null
          ? "unknown"
          : "error" in response
            ? "failed"
            : "completed";
      lifecycle.push(status);
      outcomes.push(
        outcomes.length === 0 &&
          lifecycle.filter((item) => item === "capture").length === 1
          ? status
          : evidence.captureDigest,
      );
      return {
        schema: "void.legacy.outcome.v1",
        at: new Date().toISOString(),
        status,
        tool: evidence.tool,
        workspace: evidence.workspace,
        argsDigest: evidence.argsDigest,
        captureDigest: evidence.captureDigest,
      };
    },
  };
}

type Decision = "allow" | "deny" | "hold";
type Harness = {
  readonly upstreamMessages: Array<Record<string, unknown>>;
  readonly outputMessages: unknown[];
  readonly errors: string[];
  onHold?: (queue: HoldQueue) => void;
  captureEvents?: (events: UpstreamEvents) => void;
  readonly run: (messages: readonly Record<string, unknown>[]) => Promise<void>;
  readonly runRaw: (lines: readonly string[]) => Promise<void>;
};

async function makeHarness(
  decision: Decision,
  posture: ProxyOptions["posture"] = "fail-closed",
): Promise<Harness> {
  const dir = await mkdtemp(join(tmpdir(), "void-proxy-"));
  const policyPath = join(dir, "policy.yml");
  await writeFile(policyPath, policyText(decision));
  const upstreamMessages: Array<Record<string, unknown>> = [];
  const outputMessages: unknown[] = [];
  const errors: string[] = [];

  const harness: Harness = {
    upstreamMessages,
    outputMessages,
    errors,
    run(messages) {
      return this.runRaw(messages.map((message) => JSON.stringify(message)));
    },
    async runRaw(lines) {
      await runProxy({
        keyProvider: keyProviderFromPkcs8(
          generateKeyPairSync("ed25519").privateKey.export({
            format: "der",
            type: "pkcs8",
          }),
        ),
        upstreamCommand: ["fake"],
        policyPath,
        posture,
        // Fail-closed tests exercise the real ledger path, so every harness
        // gets its own directory: a shared one would let records from one
        // test chain into another's expectations.
        ledgerDir: await mkdtemp(join(tmpdir(), "void-bin-test-")),
        workspace: "test",
        input: fromLines(lines),
        output(line) {
          outputMessages.push(JSON.parse(line) as unknown);
        },
        error(line) {
          errors.push(line);
        },
        onHold: (queue) => harness.onHold?.(queue),
        upstreamSpawn(events) {
          harness.captureEvents?.(events);
          return fakeUpstream(events, upstreamMessages);
        },
      });
    },
  };
  return harness;
}

function fakeUpstream(
  events: UpstreamEvents,
  seen: Array<Record<string, unknown>>,
): UpstreamProcess {
  return {
    send(line) {
      const message = JSON.parse(line) as {
        readonly id?: number;
        readonly method?: string;
        readonly params?: { readonly name?: string };
      };
      seen.push(message as Record<string, unknown>);
      if (message.method === "initialize") {
        events.onMessage(
          JSON.stringify({
            jsonrpc: "2.0",
            id: message.id,
            result: {
              protocolVersion: "2025-11-25",
              capabilities: { tools: {} },
              serverInfo: { name: "fake", version: "1" },
            },
          }),
        );
        return;
      }
      if (message.method === "tools/call") {
        events.onMessage(
          JSON.stringify({
            jsonrpc: "2.0",
            id: message.id,
            result: { called: message.params?.name },
          }),
        );
      }
    },
    close() {},
    onStderr() {
      return () => {};
    },
  };
}

async function* fromLines(lines: readonly string[]): AsyncIterable<string> {
  for (const line of lines) yield line;
}

function policyText(decision: Decision): string {
  if (decision === "allow")
    return "version: 1\nrules:\n  - match: {}\n    decision: allow\n";
  if (decision === "deny")
    return "version: 1\nrules:\n  - match: {}\n    decision: deny\n    rationale: tests deny r3\n";
  return "version: 1\nrules:\n  - match: {}\n    decision: hold\n    seconds: 60\n    notify: [cli]\n    rationale: tests hold r3\n";
}

function toolCall(id: number | string, name: string): Record<string, unknown> {
  return {
    jsonrpc: "2.0",
    id,
    method: "tools/call",
    params: { name, arguments: {} },
  };
}

async function waitForQueue(
  getQueue: () => HoldQueue | null,
): Promise<HoldQueue> {
  // The hold lands after awaited ledger appends (real fs in a temp dir),
  // so a fixed tick count races disk latency. Poll on wall time instead:
  // the queue either appears within the hold's own lifetime or the test
  // genuinely failed.
  const deadline = Date.now() + platformTestTimeoutMs(5_000, 30_000);
  while (Date.now() < deadline) {
    const queue = getQueue();
    if (queue !== null && queue.list().length > 0) return queue;
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("queue was not populated");
}

type HttpHarness = {
  readonly input: LineQueue;
  readonly outputMessages: unknown[];
  readonly errors: string[];
  readonly ledgerDir: string;
  onHold?: (queue: HoldQueue) => void;
  readonly start: () => Promise<void>;
};

type HttpUpstreamHarness = {
  readonly url: string;
  readonly messages: Array<Record<string, unknown>>;
  readonly close: () => Promise<void>;
};

type LineQueue = AsyncIterable<string> & {
  readonly push: (line: string) => void;
  readonly close: () => void;
};

async function makeHttpHarness(
  server: HttpUpstreamHarness,
  decision: Decision,
): Promise<HttpHarness> {
  const dir = await mkdtemp(join(tmpdir(), "void-proxy-"));
  const policyPath = join(dir, "policy.yml");
  await writeFile(policyPath, policyText(decision));
  const input = lineQueue();
  const outputMessages: unknown[] = [];
  const errors: string[] = [];
  const ledgerDir = await mkdtemp(join(tmpdir(), "void-bin-http-test-"));
  const harness: HttpHarness = {
    input,
    outputMessages,
    errors,
    ledgerDir,
    start() {
      return runProxy({
        keyProvider: keyProviderFromPkcs8(
          generateKeyPairSync("ed25519").privateKey.export({
            format: "der",
            type: "pkcs8",
          }),
        ),
        transport: "http",
        upstreamUrl: server.url,
        policyPath,
        posture: "fail-closed",
        ledgerDir,
        workspace: "test-http",
        input,
        output(line) {
          outputMessages.push(JSON.parse(line) as unknown);
        },
        error(line) {
          errors.push(line);
        },
        onHold: (queue) => harness.onHold?.(queue),
      });
    },
  };
  return harness;
}

async function startHttpUpstream(): Promise<HttpUpstreamHarness> {
  const messages: Array<Record<string, unknown>> = [];
  const streams = new Set<ServerResponse>();
  const server: Server = createServer((request, response) => {
    void handleHttpUpstreamRequest(request, response, messages, streams);
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${address.port}/mcp`,
    messages,
    async close() {
      for (const stream of streams) {
        stream.end();
      }
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error !== undefined) reject(error);
          else resolve();
        });
      });
    },
  };
}

async function handleHttpUpstreamRequest(
  request: IncomingMessage,
  response: ServerResponse,
  messages: Array<Record<string, unknown>>,
  streams: Set<ServerResponse>,
): Promise<void> {
  if (request.method === "GET") {
    streams.add(response);
    response.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
    });
    request.on("close", () => {
      streams.delete(response);
    });
    return;
  }

  if (request.method !== "POST") {
    response.writeHead(405, { allow: "GET, POST" });
    response.end();
    return;
  }

  const message = JSON.parse(await requestText(request)) as {
    readonly id?: number;
    readonly method?: string;
    readonly params?: { readonly name?: string };
  };
  messages.push(message as Record<string, unknown>);
  response.writeHead(200, { "content-type": "application/json" });
  if (message.method === "initialize") {
    response.end(
      JSON.stringify({
        jsonrpc: "2.0",
        id: message.id,
        result: {
          protocolVersion: "2025-11-25",
          capabilities: { tools: {} },
          serverInfo: { name: "fake-http", version: "1" },
        },
      }),
    );
    return;
  }
  if (message.method === "tools/call") {
    response.end(
      JSON.stringify({
        jsonrpc: "2.0",
        id: message.id,
        result: { called: message.params?.name },
      }),
    );
    return;
  }
  response.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: {} }));
}

async function requestText(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }
  return Buffer.concat(chunks).toString("utf8");
}

function lineQueue(): LineQueue {
  const values: string[] = [];
  const waiters: Array<(result: IteratorResult<string>) => void> = [];
  let closed = false;

  const finish = (): void => {
    while (waiters.length > 0) {
      waiters.shift()?.({ done: true, value: undefined });
    }
  };

  const next = async (): Promise<IteratorResult<string>> => {
    const value = values.shift();
    if (value !== undefined) return { done: false, value };
    if (closed) return { done: true, value: undefined };
    return new Promise<IteratorResult<string>>((resolve) => {
      waiters.push(resolve);
    });
  };

  return {
    push(line) {
      if (closed) throw new Error("input queue is closed");
      const waiter = waiters.shift();
      if (waiter === undefined) {
        values.push(line);
        return;
      }
      waiter({ done: false, value: line });
    },
    close() {
      closed = true;
      finish();
    },
    [Symbol.asyncIterator]() {
      return {
        next,
        async return() {
          closed = true;
          finish();
          return { done: true, value: undefined };
        },
      };
    },
  };
}

async function readLedgerDecisions(
  ledgerDir: string,
  workspace: string,
): Promise<string[]> {
  const text = await readFile(join(ledgerDir, `${workspace}.jsonl`), "utf8");
  return text
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => {
      const entry = JSON.parse(line) as {
        readonly body: { readonly decision: string };
      };
      return entry.body.decision;
    });
}

async function waitFor(predicate: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + platformTestTimeoutMs(15_000, 60_000);
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`timed out waiting for ${label}`);
}

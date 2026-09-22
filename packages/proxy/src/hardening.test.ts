import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runProxy, stdinLines } from "./bin.ts";
import {
  ProxyOutputError,
  assertInboundLineCeiling,
  assertOutboundLineCeiling,
  assertOutboundQueueCeiling,
  assertSingleJsonRpcMessage,
} from "./hardening.ts";
import type {
  ProxyShutdownSignal,
  ProxyShutdownSignals,
  UpstreamEvents,
} from "./bin.ts";
import type { HoldQueue } from "../../policy/src/hold.ts";
import type { UpstreamProcess } from "./transport/stdio.ts";

describe("proxy hardening helpers", () => {
  test("inboundLineCeiling rejects oversized lines before JSON parse", () => {
    assert.doesNotThrow(() => assertInboundLineCeiling("12345", 5));
    assert.throws(
      () => assertInboundLineCeiling("123456", 5),
      /exceeded 5 bytes/,
    );
  });

  test("batch arrays are invalid JSON-RPC messages", () => {
    assert.throws(
      () => assertSingleJsonRpcMessage([]),
      /batch requests are not supported/,
    );
  });

  test("id null is refused at the MCP boundary", () => {
    assert.throws(
      () =>
        assertSingleJsonRpcMessage({
          jsonrpc: "2.0",
          id: null,
          method: "tools/list",
        }),
      /id null/,
    );
  });

  test("S10: outbound line ceiling names the cap", () => {
    assert.doesNotThrow(() => assertOutboundLineCeiling("12345", 5));
    assert.throws(
      () => assertOutboundLineCeiling("123456", 5),
      /outbound message exceeded 5 bytes/,
    );
    try {
      assertOutboundLineCeiling("123456", 5);
      assert.fail("must throw");
    } catch (error) {
      assert.ok(error instanceof ProxyOutputError);
      assert.equal(error.kind, "oversize");
      assert.equal(error.name, "ProxyOutputError");
    }
  });

  test("S10: outbound queue ceiling counts buffered plus incoming bytes", () => {
    assert.doesNotThrow(() => assertOutboundQueueCeiling(3, 2, 5));
    assert.throws(
      () => assertOutboundQueueCeiling(3, 3, 5),
      /outbound queue exceeded 5 bytes/,
    );
    try {
      assertOutboundQueueCeiling(4, 2, 5);
      assert.fail("must throw");
    } catch (error) {
      assert.ok(error instanceof ProxyOutputError);
      assert.equal(error.kind, "backpressure");
    }
  });

  test("S10: outbound ceilings reject a non-positive cap", () => {
    for (const bad of [0, -1, 1.5, Number.NaN]) {
      assert.throws(() => assertOutboundLineCeiling("x", bad), TypeError);
      assert.throws(() => assertOutboundQueueCeiling(0, 1, bad), TypeError);
    }
  });

  test("S10: stdinLines frames chunked input without readline", async () => {
    const lines: string[] = [];
    for await (const line of stdinLines(
      1024,
      chunks(['{"a":', '1}\n{"b":2}\r', "\ntrail", "ing\n"]),
    )) {
      lines.push(line);
    }
    assert.deepEqual(lines, ['{"a":1}', '{"b":2}', "trailing"]);
  });

  test("S10: stdinLines refuses an unterminated line past the cap with a named error", async () => {
    const reader = stdinLines(8, chunks(["x".repeat(9)]))[
      Symbol.asyncIterator
    ]();
    await assert.rejects(reader.next(), /inbound message exceeded 8 bytes/);
  });
});

describe("runProxy hardening", () => {
  test("JSON-RPC batch input is rejected locally", async () => {
    const harness = await makeHarness();

    await harness.runRaw([
      JSON.stringify([{ jsonrpc: "2.0", id: 1, method: "tools/list" }]),
    ]);

    assert.deepEqual(harness.upstreamMessages, []);
    assert.deepEqual(harness.outputMessages, [
      {
        jsonrpc: "2.0",
        id: null,
        error: { code: -32600, message: "Invalid Request" },
      },
    ]);
  });

  test("null ids are rejected locally", async () => {
    const harness = await makeHarness();

    await harness.runRaw([
      JSON.stringify({ jsonrpc: "2.0", id: null, method: "tools/list" }),
    ]);

    assert.deepEqual(harness.upstreamMessages, []);
    assert.deepEqual(harness.outputMessages, [
      {
        jsonrpc: "2.0",
        id: null,
        error: { code: -32600, message: "Invalid Request" },
      },
    ]);
  });

  test("oversized inbound lines are rejected without echoing the payload", async () => {
    const harness = await makeHarness(12);
    const payload = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list",
      params: { secret: "hunter2" },
    });

    await harness.runRaw([payload]);

    assert.deepEqual(harness.upstreamMessages, []);
    const rendered = JSON.stringify(harness.outputMessages);
    assert.match(rendered, /Invalid Request/);
    assert.doesNotMatch(rendered, /hunter2|tools\/list/);
  });

  test("SIGTERM drains held calls as expired before shutdown", async () => {
    const signals = fakeSignals();
    const harness = await makeHoldHarness(signals);
    const running = harness.runRaw([
      JSON.stringify({
        jsonrpc: "2.0",
        id: 77,
        method: "tools/call",
        params: { name: "aws.s3.bucket.delete", arguments: {} },
      }),
    ]);

    await waitFor(() => harness.queue?.list().length === 1, "held call");
    signals.emit("SIGTERM");
    await running;

    assert.equal(signals.exitCode, 143);
    assert.deepEqual(harness.upstreamMessages, []);
    const error = harness.outputMessages[0] as {
      readonly id: number;
      readonly error: {
        readonly message: string;
        readonly data: { readonly result: string };
      };
    };
    assert.equal(error.id, 77);
    assert.match(error.error.message, /expired without a human decision/);
    assert.equal(error.error.data.result, "expired");
  });

  test("parse errors do not echo malformed input", async () => {
    const harness = await makeHarness();

    await harness.runRaw(["not json with secret hunter2"]);

    const rendered = JSON.stringify(harness.outputMessages);
    assert.match(rendered, /Parse error/);
    assert.doesNotMatch(rendered, /hunter2|not json/);
  });

  test("S10: an oversized relayed notification is dropped with a named reason", async () => {
    const dir = await mkdtemp(join(tmpdir(), "void-proxy-s10-"));
    const policyPath = join(dir, "policy.yml");
    await writeFile(
      policyPath,
      "version: 1\nrules:\n  - match: {}\n    decision: allow\n",
    );
    const outputMessages: unknown[] = [];
    const errors: string[] = [];
    let events: UpstreamEvents | null = null;
    const input = queueLines();
    const running = runProxy({
      upstreamCommand: ["fake"],
      policyPath,
      posture: "observe",
      input,
      output(line) {
        outputMessages.push(JSON.parse(line) as unknown);
      },
      error(line) {
        errors.push(line);
      },
      outboundMaxBytes: 64,
      upstreamSpawn(received) {
        events = received;
        return fakeUpstream(received, []);
      },
    });

    await waitFor(() => events !== null, "upstream spawn");
    events!.onMessage(
      JSON.stringify({
        jsonrpc: "2.0",
        method: "notifications/message",
        params: { level: "info", data: { pad: "x".repeat(200) } },
      }),
    );
    await waitFor(() => errors.length > 0, "drop note");
    input.close();
    await running;

    assert.deepEqual(outputMessages, []);
    assert.match(
      errors.join("\n"),
      /upstream message dropped: outbound message exceeded 64 bytes/,
    );
  });
});

type Harness = {
  readonly upstreamMessages: Array<Record<string, unknown>>;
  readonly outputMessages: unknown[];
  readonly runRaw: (lines: readonly string[]) => Promise<void>;
};

async function makeHarness(inboundMaxBytes?: number): Promise<Harness> {
  const dir = await mkdtemp(join(tmpdir(), "void-proxy-hardening-"));
  const policyPath = join(dir, "policy.yml");
  await writeFile(
    policyPath,
    "version: 1\nrules:\n  - match: {}\n    decision: allow\n",
  );
  const upstreamMessages: Array<Record<string, unknown>> = [];
  const outputMessages: unknown[] = [];
  return {
    upstreamMessages,
    outputMessages,
    async runRaw(lines) {
      await runProxy({
        upstreamCommand: ["fake"],
        policyPath,
        posture: "observe",
        input: fromLines(lines),
        output(line) {
          outputMessages.push(JSON.parse(line) as unknown);
        },
        error() {},
        inboundMaxBytes,
        upstreamSpawn(events) {
          return fakeUpstream(events, upstreamMessages);
        },
      });
    },
  };
}

function fakeUpstream(
  _events: UpstreamEvents,
  seen: Array<Record<string, unknown>>,
): UpstreamProcess {
  return {
    send(line) {
      seen.push(JSON.parse(line) as Record<string, unknown>);
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

async function* chunks(values: readonly string[]): AsyncIterable<Buffer> {
  for (const value of values) yield Buffer.from(value, "utf8");
}

type LineQueue = AsyncIterable<string> & {
  readonly close: () => void;
};

function queueLines(): LineQueue {
  const waiters: Array<(result: IteratorResult<string>) => void> = [];
  let closed = false;
  const finish = (): void => {
    while (waiters.length > 0) {
      waiters.shift()?.({ done: true, value: undefined });
    }
  };
  return {
    close() {
      closed = true;
      finish();
    },
    [Symbol.asyncIterator]() {
      return {
        next(): Promise<IteratorResult<string>> {
          if (closed) return Promise.resolve({ done: true, value: undefined });
          return new Promise<IteratorResult<string>>((resolve) => {
            waiters.push(resolve);
          });
        },
        async return(): Promise<IteratorResult<string>> {
          closed = true;
          finish();
          return { done: true, value: undefined };
        },
      };
    },
  };
}

type SignalHarness = ProxyShutdownSignals & {
  readonly emit: (signal: ProxyShutdownSignal) => void;
  exitCode?: number;
};

function fakeSignals(): SignalHarness {
  const handlers = new Map<ProxyShutdownSignal, Set<() => void>>([
    ["SIGINT", new Set()],
    ["SIGTERM", new Set()],
  ]);
  return {
    on(signal, handler) {
      handlers.get(signal)?.add(handler);
    },
    off(signal, handler) {
      handlers.get(signal)?.delete(handler);
    },
    setExitCode(code) {
      this.exitCode = code;
    },
    emit(signal) {
      for (const handler of handlers.get(signal) ?? []) handler();
    },
  };
}

async function makeHoldHarness(
  signals: ProxyShutdownSignals,
): Promise<Harness & { queue: HoldQueue | null }> {
  const dir = await mkdtemp(join(tmpdir(), "void-proxy-hardening-hold-"));
  const policyPath = join(dir, "policy.yml");
  await writeFile(
    policyPath,
    "version: 1\nrules:\n  - match: {}\n    decision: hold\n    seconds: 60\n    notify: [cli]\n",
  );
  const upstreamMessages: Array<Record<string, unknown>> = [];
  const outputMessages: unknown[] = [];
  const harness: Harness & { queue: HoldQueue | null } = {
    upstreamMessages,
    outputMessages,
    queue: null,
    async runRaw(lines) {
      await runProxy({
        upstreamCommand: ["fake"],
        policyPath,
        posture: "fail-closed",
        ledgerDir: await mkdtemp(
          join(tmpdir(), "void-proxy-hardening-ledger-"),
        ),
        workspace: "test",
        input: fromLines(lines),
        output(line) {
          outputMessages.push(JSON.parse(line) as unknown);
        },
        error() {},
        shutdownSignals: signals,
        onHold(queue) {
          harness.queue = queue;
        },
        upstreamSpawn(events) {
          return fakeUpstream(events, upstreamMessages);
        },
      });
    },
  };
  return harness;
}

async function waitFor(predicate: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`timed out waiting for ${label}`);
}

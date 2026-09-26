import test, { describe } from "node:test";
import assert from "node:assert/strict";
import process from "node:process";

import { ReadBuffer, spawnUpstream } from "./stdio.ts";

function onceClose(): {
  readonly promise: Promise<{
    readonly code: number | null;
    readonly signal: NodeJS.Signals | null;
  }>;
  readonly onClose: (
    code: number | null,
    signal: NodeJS.Signals | null,
  ) => void;
} {
  let resolveClose: (event: {
    readonly code: number | null;
    readonly signal: NodeJS.Signals | null;
  }) => void;
  const promise = new Promise<{
    readonly code: number | null;
    readonly signal: NodeJS.Signals | null;
  }>((resolve) => {
    resolveClose = resolve;
  });

  return {
    promise,
    onClose(code, signal) {
      resolveClose({ code, signal });
    },
  };
}

describe("ReadBuffer", () => {
  test("reassembles partial chunks and drains complete lines", () => {
    const buffer = new ReadBuffer(100);

    buffer.append('{"a":');
    assert.equal(buffer.readLine(), null);

    buffer.append('1}\n{"b":2}\r\ntrail');
    assert.equal(buffer.readLine(), '{"a":1}');
    assert.equal(buffer.readLine(), '{"b":2}');
    assert.equal(buffer.readLine(), null);

    buffer.append("ing\n");
    assert.equal(buffer.readLine(), "trailing");
    assert.equal(buffer.readLine(), null);
  });

  test("clears itself after a message exceeds the ceiling", () => {
    const buffer = new ReadBuffer(5);

    buffer.append("abc");
    assert.throws(() => buffer.append("def"), /exceeded 5 bytes/);

    buffer.append("ok\n");
    assert.equal(buffer.readLine(), "ok");
  });
});

describe("spawnUpstream", () => {
  test("rejects an empty command", () => {
    assert.throws(
      () =>
        spawnUpstream(
          [],
          {},
          {
            events: {
              onMessage() {},
              onClose() {},
              onError() {},
            },
          },
        ),
      /must not be empty/,
    );
  });

  test("sends newline framed JSON to a real child", async () => {
    const close = onceClose();
    const messages: string[] = [];
    // Wait for the echo rather than sleeping: a node child needs longer to
    // start than cat did, and a fixed sleep made this timing dependent.
    let echoed: () => void;
    const received = new Promise<void>((resolve) => {
      echoed = resolve;
    });
    const upstream = spawnUpstream(
      // An echo child rather than `cat`, which does not exist on Windows. The
      // claim under test is the newline framing, not the tool that reads it.
      [process.execPath, "-e", "process.stdin.pipe(process.stdout);"],
      {},
      {
        events: {
          onMessage(line) {
            messages.push(line);
            echoed();
          },
          onClose: close.onClose,
          onError(err) {
            throw err;
          },
        },
      },
    );

    upstream.send('{"jsonrpc":"2.0","id":1,"result":{}}');
    await received;
    upstream.close();
    await close.promise;

    assert.deepEqual(messages, ['{"jsonrpc":"2.0","id":1,"result":{}}']);
  });

  test("keeps stderr out of the message stream", async () => {
    const close = onceClose();
    const messages: string[] = [];
    const stderrChunks: string[] = [];
    const registeredStderr: string[] = [];
    const upstream = spawnUpstream(
      [
        process.execPath,
        "-e",
        "process.stderr.write('log only\\n'); process.stdout.write('{\\\"ok\\\":true}\\n');",
      ],
      {},
      {
        stderr: {
          write(chunk: string | Uint8Array) {
            stderrChunks.push(String(chunk));
            return true;
          },
        },
        events: {
          onMessage(line) {
            messages.push(line);
          },
          onClose: close.onClose,
          onError(err) {
            throw err;
          },
        },
      },
    );
    upstream.onStderr((chunk) => {
      registeredStderr.push(chunk);
    });

    await close.promise;

    assert.deepEqual(messages, ['{"ok":true}']);
    assert.equal(stderrChunks.join(""), "log only\n");
    assert.equal(registeredStderr.join(""), "log only\n");
  });

  test("reports overflow and resets the buffer", async () => {
    const close = onceClose();
    const messages: string[] = [];
    const errors: string[] = [];
    spawnUpstream(
      [
        process.execPath,
        "-e",
        "process.stdout.write('abcdef'); setTimeout(() => process.stdout.write('ok\\n'), 10); setTimeout(() => process.exit(0), 30);",
      ],
      {},
      {
        maxBufferSize: 5,
        events: {
          onMessage(line) {
            messages.push(line);
          },
          onClose: close.onClose,
          onError(err) {
            errors.push(err.message);
          },
        },
      },
    );

    await close.promise;

    assert.equal(errors.length, 1);
    assert.match(errors[0] ?? "", /exceeded 5 bytes/);
    assert.deepEqual(messages, ["ok"]);
  });

  test("uses the signal ladder with injected timing", async () => {
    const close = onceClose();
    const callbacks: Array<() => void> = [];
    const delays: number[] = [];
    let readyResolve: () => void;
    const ready = new Promise<void>((resolve) => {
      readyResolve = resolve;
    });
    const upstream = spawnUpstream(
      [
        process.execPath,
        "-e",
        "process.on('SIGTERM', () => {}); process.stdout.write('ready\\n'); setInterval(() => {}, 1000);",
      ],
      {},
      {
        killDelayMs: 25,
        clock: {
          setTimeout(callback, ms) {
            callbacks.push(callback);
            delays.push(ms);
            return callbacks.length;
          },
          clearTimeout() {},
        },
        events: {
          onMessage(line) {
            if (line === "ready") {
              readyResolve();
            }
          },
          onClose: close.onClose,
          onError(err) {
            throw err;
          },
        },
      },
    );

    await ready;
    upstream.close();
    assert.deepEqual(delays, [25]);
    callbacks[0]?.();
    const event = await close.promise;

    // The child ignores SIGTERM and would otherwise run forever, so reaching
    // here at all proves the ladder escalated to an unconditional kill. The
    // reported name is POSIX only: Windows has no SIGKILL and reports
    // TerminateProcess as SIGTERM.
    assert.ok(
      process.platform === "win32"
        ? event.signal === "SIGTERM" || event.signal === null
        : event.signal === "SIGKILL",
      `unexpected exit signal ${String(event.signal)}`,
    );
  });

  test("bounds writes when a child never reads stdin", async () => {
    const close = onceClose();
    const upstream = spawnUpstream(
      [process.execPath, "-e", "setInterval(() => {}, 1000);"],
      {},
      {
        maxWriteBufferSize: 64 * 1024,
        events: { onMessage() {}, onClose: close.onClose, onError(err) { throw err; } },
      },
    );
    try {
      const line = "x".repeat(32 * 1024);
      assert.throws(() => {
        for (let attempt = 0; attempt < 32; attempt += 1) upstream.send(line);
      }, /write buffer exceeded/);
    } finally {
      upstream.close();
      await close.promise;
    }
  });

  test("S15: strips VOID_SIGNING_KEY even when explicitly provided", async () => {
    const close = onceClose();
    const messages: string[] = [];
    spawnUpstream(
      [
        process.execPath,
        "-e",
        "process.stdout.write(JSON.stringify({ key: process.env.VOID_SIGNING_KEY ?? null }) + '\\n');",
      ],
      { VOID_SIGNING_KEY: "synthetic-secret" },
      {
        events: {
          onMessage(line) {
            messages.push(line);
          },
          onClose: close.onClose,
          onError(err) {
            throw err;
          },
        },
      },
    );

    await close.promise;

    assert.deepEqual(messages, ['{"key":null}']);
  });

  test("close is idempotent", async () => {
    const close = onceClose();
    let timerCount = 0;
    const upstream = spawnUpstream(
      [process.execPath, "-e", "setInterval(() => {}, 1000);"],
      {},
      {
        clock: {
          setTimeout(callback) {
            timerCount += 1;
            return setTimeout(callback, 1);
          },
          clearTimeout(handle) {
            clearTimeout(handle as ReturnType<typeof setTimeout>);
          },
        },
        events: {
          onMessage() {},
          onClose: close.onClose,
          onError(err) {
            throw err;
          },
        },
      },
    );

    upstream.close();
    upstream.close();
    await close.promise;

    assert.equal(timerCount, 1);
  });
});

import test, { describe } from "node:test";
import assert from "node:assert/strict";
import process from "node:process";

import { ReadBuffer, spawnUpstream } from "./stdio.ts";

// A real child gets to prove it answered, not to fit inside a guessed sleep.
// Cold spawn on win32 at Node 24 measured 41ms to 87ms from spawn() to the
// child's own first byte, so a small budget cuts the child off before it reads
// a byte. This is a deadline that fails loudly, never a wait that flatters the
// implementation.
const CHILD_ANSWER_BUDGET_MS = 5000;

async function withinDeadline<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;

  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          reject(new Error(`${what} did not arrive within ${ms}ms`));
        }, ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function onceClose(): {
  readonly promise: Promise<{ readonly code: number | null; readonly signal: NodeJS.Signals | null }>;
  readonly onClose: (code: number | null, signal: NodeJS.Signals | null) => void;
} {
  let resolveClose: (event: { readonly code: number | null; readonly signal: NodeJS.Signals | null }) => void;
  const promise = new Promise<{ readonly code: number | null; readonly signal: NodeJS.Signals | null }>((resolve) => {
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

    buffer.append("{\"a\":");
    assert.equal(buffer.readLine(), null);

    buffer.append("1}\n{\"b\":2}\r\ntrail");
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
      () => spawnUpstream([], {}, {
        events: {
          onMessage() {},
          onClose() {},
          onError() {},
        },
      }),
      /must not be empty/,
    );
  });

  test("sends newline framed JSON to a real child", async () => {
    const close = onceClose();
    const messages: string[] = [];
    let markEchoed: (line: string) => void;
    const echoed = new Promise<string>((resolve) => {
      markEchoed = resolve;
    });

    // The child is node itself, not `cat`: on Windows `cat` is a third party
    // shim, on this machine Neovim's, and a stock install has no cat.exe at
    // all, so the framing assertion used to depend on somebody's PATH. The test
    // waits for the frame it sent to come back rather than for a sleep to
    // expire, because close() kills the upstream, so a sleep that expires first
    // asserts scheduler latency instead of framing.
    const upstream = spawnUpstream([process.execPath, "-e", "process.stdin.pipe(process.stdout);"], {}, {
      events: {
        onMessage(line) {
          messages.push(line);
          markEchoed(line);
        },
        onClose: close.onClose,
        onError(err) {
          throw err;
        },
      },
    });

    upstream.send('{"jsonrpc":"2.0","id":1,"result":{}}');
    const first = await withinDeadline(echoed, CHILD_ANSWER_BUDGET_MS, "upstream echo");
    upstream.close();
    await close.promise;

    assert.equal(first, '{"jsonrpc":"2.0","id":1,"result":{}}');
    assert.deepEqual(messages, ['{"jsonrpc":"2.0","id":1,"result":{}}']);
  });

  test("keeps stderr out of the message stream", async () => {
    const close = onceClose();
    const messages: string[] = [];
    const stderrChunks: string[] = [];
    const registeredStderr: string[] = [];
    const upstream = spawnUpstream([
      process.execPath,
      "-e",
      "process.stderr.write('log only\\n'); process.stdout.write('{\\\"ok\\\":true}\\n');",
    ], {}, {
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
    });
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
    spawnUpstream([
      process.execPath,
      "-e",
      "process.stdout.write('abcdef'); setTimeout(() => process.stdout.write('ok\\n'), 10); setTimeout(() => process.exit(0), 30);",
    ], {}, {
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
    });

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
    const upstream = spawnUpstream([
      process.execPath,
      "-e",
      "process.on('SIGTERM', () => {}); process.stdout.write('ready\\n'); setInterval(() => {}, 1000);",
    ], {}, {
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
    });

    await ready;
    upstream.close();
    assert.deepEqual(delays, [25]);
    callbacks[0]?.();
    const event = await close.promise;

    // The escalation is issued either way, but the rung that ends the child is
    // not the same one on every platform, so the close event names the first.
    // On POSIX the child script's SIGTERM handler makes it survive rung one, so
    // SIGKILL ends it. On Windows Node routes both names through one
    // uncatchable TerminateProcess, measured 10 runs out of 10 on win32 at Node
    // 24: rung one ended the process, rung two hit an already dead handle, and
    // the close event named SIGTERM. Asserting the platform truth keeps the
    // test honest on both; asserting a Windows SIGKILL would assert a kill the
    // platform did not perform.
    const rungThatEndedTheChild = process.platform === "win32" ? "SIGTERM" : "SIGKILL";
    assert.equal(event.signal, rungThatEndedTheChild);
    assert.equal(event.code, null);
  });

  test("close is idempotent", async () => {
    const close = onceClose();
    let timerCount = 0;
    const upstream = spawnUpstream([
      process.execPath,
      "-e",
      "setInterval(() => {}, 1000);",
    ], {}, {
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
    });

    upstream.close();
    upstream.close();
    await close.promise;

    assert.equal(timerCount, 1);
  });
});

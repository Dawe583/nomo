import { spawn } from "node:child_process";
import process from "node:process";

const STDIO_DEFAULT_MAX_BUFFER_SIZE = 10 * 1024 * 1024;

type TimerHandle = unknown;

type StdioClock = {
  readonly setTimeout: (callback: () => void, ms: number) => TimerHandle;
  readonly clearTimeout: (handle: TimerHandle) => void;
};

type StdioEvents = {
  readonly onMessage: (line: string) => void;
  readonly onClose: (code: number | null, signal: NodeJS.Signals | null) => void;
  readonly onError: (err: Error) => void;
};

export type UpstreamProcess = {
  readonly send: (line: string) => void;
  readonly close: () => void;
  readonly onStderr: (callback: (chunk: string) => void) => () => void;
};

export type StdioTransportOptions = {
  readonly events?: StdioEvents;
  readonly maxBufferSize?: number;
  readonly killDelayMs?: number;
  readonly clock?: StdioClock;
  readonly stderr?: Pick<NodeJS.WriteStream, "write">;
};

export class ReadBuffer {
  readonly #maxBufferSize: number;
  #buffer = Buffer.alloc(0);

  constructor(maxBufferSize = STDIO_DEFAULT_MAX_BUFFER_SIZE) {
    this.#maxBufferSize = maxBufferSize;
  }

  append(chunk: Buffer | string): void {
    const next = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, "utf8");
    const size = this.#buffer.length + next.length;

    if (size > this.#maxBufferSize) {
      this.clear();
      throw new Error(`stdio message exceeded ${this.#maxBufferSize} bytes`);
    }

    this.#buffer = Buffer.concat([this.#buffer, next], size);
  }

  readLine(): string | null {
    const newline = this.#buffer.indexOf(0x0a);

    if (newline === -1) {
      return null;
    }

    let line = this.#buffer.subarray(0, newline);
    if (line.length > 0 && line[line.length - 1] === 0x0d) {
      line = line.subarray(0, line.length - 1);
    }

    this.#buffer = this.#buffer.subarray(newline + 1);
    return line.toString("utf8");
  }

  clear(): void {
    this.#buffer = Buffer.alloc(0);
  }
}

const defaultClock: StdioClock = {
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

function hasUnref(handle: TimerHandle): handle is { unref: () => void } {
  return typeof handle === "object" && handle !== null && "unref" in handle;
}

const noopEvents: StdioEvents = {
  onMessage() {},
  onClose() {},
  onError() {},
};

export function spawnUpstream(
  command: readonly string[],
  env: Readonly<Record<string, string>>,
  options: StdioTransportOptions = {},
): UpstreamProcess {
  if (command.length === 0 || command[0] === "") {
    throw new Error("stdio upstream command must not be empty");
  }

  const [program, ...args] = command;
  const childEnv: Record<string, string> = { ...env };
  if (childEnv.PATH === undefined && process.env.PATH !== undefined) {
    childEnv.PATH = process.env.PATH;
  }

  const child = spawn(program, args, {
    env: childEnv,
    shell: false,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });

  const clock = options.clock ?? defaultClock;
  const killDelayMs = options.killDelayMs ?? 500;
  const readBuffer = new ReadBuffer(options.maxBufferSize);
  const events = options.events ?? noopEvents;
  const stderr = options.stderr ?? process.stderr;
  const stderrCallbacks = new Set<(chunk: string) => void>();
  let closed = false;
  let ladderTimer: TimerHandle | null = null;

  const finishClose = (code: number | null, signal: NodeJS.Signals | null): void => {
    if (ladderTimer !== null) {
      clock.clearTimeout(ladderTimer);
      ladderTimer = null;
    }
    readBuffer.clear();
    events.onClose(code, signal);
  };

  child.stdout.on("data", (chunk: Buffer) => {
    try {
      readBuffer.append(chunk);
    } catch (err) {
      events.onError(err instanceof Error ? err : new Error(String(err)));
      return;
    }

    for (;;) {
      const line = readBuffer.readLine();
      if (line === null) {
        break;
      }
      events.onMessage(line);
    }
  });

  child.stderr.on("data", (chunk: Buffer) => {
    const text = chunk.toString("utf8");
    stderr.write(text);
    for (const callback of stderrCallbacks) {
      callback(text);
    }
  });

  child.on("error", (err) => {
    events.onError(err);
  });

  child.on("close", (code, signal) => {
    finishClose(code, signal);
  });

  return {
    send(line: string): void {
      if (closed || child.stdin.destroyed) {
        throw new Error("stdio upstream is closed");
      }
      child.stdin.write(`${line}\n`);
    },
    close(): void {
      if (closed) {
        return;
      }
      closed = true;
      child.stdin.end();
      // Two rungs, and they promise different things per platform, so the ladder
      // is only ever as strong as its first rung. On POSIX SIGTERM is catchable:
      // an upstream that installs a handler outlives this line and SIGKILL is
      // the rung that ends it. On Windows Node routes both names through one
      // uncatchable TerminateProcess, measured on win32 at Node 24: a child
      // that installed a SIGTERM handler still died here, and the close event
      // named the rung that ended the process, not the one requested last. The
      // escalation below is therefore a no-op on Windows, and a Windows close
      // must never be reported as a SIGKILL the platform performed.
      child.kill("SIGTERM");
      ladderTimer = clock.setTimeout(() => {
        ladderTimer = null;
        if (child.exitCode === null && child.signalCode === null) {
          child.kill("SIGKILL");
        }
      }, killDelayMs);
      if (hasUnref(ladderTimer)) {
        ladderTimer.unref();
      }
    },
    onStderr(callback: (chunk: string) => void): () => void {
      stderrCallbacks.add(callback);
      return () => {
        stderrCallbacks.delete(callback);
      };
    },
  };
}

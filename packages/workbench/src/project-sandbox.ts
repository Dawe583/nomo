import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { stat, realpath } from "node:fs/promises";
import { isAbsolute, parse, relative, sep } from "node:path";
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";

export const PROJECT_EXEC_TOOL = {
  name: "nomo_project_exec",
  description:
    "Run one command inside the explicitly approved project container. No network or host filesystem is available outside the mounted project.",
  inputSchema: {
    type: "object",
    properties: {
      command: { type: "string", minLength: 1, maxLength: 16_384 },
    },
    required: ["command"],
    additionalProperties: false,
  },
} as const;

export const PROJECT_SANDBOX_LIMITS = {
  timeoutMs: 180_000,
  maxTimeoutMs: 300_000,
  outputBytes: 32_768,
  memory: "2g",
  cpus: "1",
  pids: 64,
  tmpfsBytes: 134_217_728,
} as const;

export type ProjectSandboxConfig = {
  readonly runtime: "docker" | "podman";
  readonly imageId: string;
};

export type ProjectCommandResult = {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number | null;
  readonly timedOut: boolean;
  readonly outputTruncated: boolean;
};
export class ProjectSandboxError extends Error {
  readonly mayHaveExecuted: boolean;

  constructor(message: string, mayHaveExecuted: boolean) {
    super(message);
    this.name = "ProjectSandboxError";
    this.mayHaveExecuted = mayHaveExecuted;
  }
}

type RuntimeResult = {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number | null;
  readonly timedOut: boolean;
  readonly outputTruncated: boolean;
  readonly spawnError?: Error;
};

type ProcessOptions = {
  readonly timeoutMs: number;
  readonly maxOutputBytes: number;
  readonly signal?: AbortSignal;
};

export function projectSandboxConfig(
  env: Readonly<NodeJS.ProcessEnv>,
): ProjectSandboxConfig {
  const runtime = env.NOMO_PROJECT_SANDBOX_RUNTIME;
  const imageId = env.NOMO_PROJECT_SANDBOX_IMAGE;
  if (runtime !== "docker" && runtime !== "podman")
    throw new Error(`Set NOMO_PROJECT_SANDBOX_RUNTIME to docker or podman, got ${JSON.stringify(runtime)}.`);
  if (typeof imageId !== "string" || !/^sha256:[a-f0-9]{64}$/.test(imageId))
    throw new Error(`Set NOMO_PROJECT_SANDBOX_IMAGE to a local sha256 image ID, got ${JSON.stringify(imageId)}.`);
  return { runtime, imageId };
}

export function parseProjectCommand(value: unknown): { readonly command: string } {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new Error("Project command must be an object.");
  const candidate = value as { readonly command?: unknown };
  if (Object.keys(value).some((key) => key !== "command"))
    throw new Error("Project command contains an unexpected field.");
  const command = candidate.command;
  if (typeof command !== "string" || command.trim().length === 0)
    throw new Error("Project command must be non-empty text.");
  if (Buffer.byteLength(command, "utf8") > 16_384)
    throw new Error(`Project command is ${Buffer.byteLength(command, "utf8")} bytes, exceeds its 16384 byte size limit.`);
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(command))
    throw new Error("Project command contains a control character.");
  return { command };
}

function boundedTimeout(timeoutMs: number): number {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1)
    throw new Error("Project command timeout must be a positive integer.");
  return Math.min(timeoutMs, PROJECT_SANDBOX_LIMITS.maxTimeoutMs);
}

function appendBounded(
  chunks: Buffer[],
  chunk: Buffer,
  output: { bytes: number; exceeded: boolean },
  limit: number,
): void {
  const remaining = limit - output.bytes;
  if (remaining > 0) {
    const kept = chunk.byteLength > remaining ? chunk.subarray(0, remaining) : chunk;
    chunks.push(kept);
    output.bytes += kept.byteLength;
  }
  if (chunk.byteLength > remaining) output.exceeded = true;
}

function terminate(child: ChildProcess): NodeJS.Timeout {
  child.kill("SIGTERM");
  return setTimeout(() => child.kill("SIGKILL"), 1_000);
}

function runtimeProcess(
  runtime: "docker" | "podman",
  args: readonly string[],
  options: ProcessOptions,
): Promise<RuntimeResult> {
  const { promise, resolve } = (
    Promise as PromiseConstructor & {
      withResolvers<T>(): {
        promise: Promise<T>;
        resolve(value: T | PromiseLike<T>): void;
      };
    }
  ).withResolvers<RuntimeResult>();
  let timedOut = false;
  let outputTruncated = false;
  let spawnError: Error | undefined;
  let forceKill: NodeJS.Timeout | undefined;
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  const output = { bytes: 0, exceeded: false };
  const child = spawn(runtime, [...args], {
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  const kill = () => {
    if (!child.killed) forceKill = terminate(child);
  };
  const timer = setTimeout(() => {
    timedOut = true;
    kill();
  }, options.timeoutMs);
  const onAbort = () => kill();
  options.signal?.addEventListener("abort", onAbort, { once: true });
  const collect = (chunks: Buffer[]) => (chunk: Buffer | string) => {
    appendBounded(
      chunks,
      Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk),
      output,
      options.maxOutputBytes,
    );
    if (output.exceeded) {
      outputTruncated = true;
      kill();
    }
  };
  child.stdout.on("data", collect(stdout));
  child.stderr.on("data", collect(stderr));
  child.on("error", (error) => {
    spawnError = error;
  });
  child.on("close", (code) => {
    clearTimeout(timer);
    clearTimeout(forceKill);
    options.signal?.removeEventListener("abort", onAbort);
    resolve({
      stdout: Buffer.concat(stdout).toString("utf8"),
      stderr: Buffer.concat(stderr).toString("utf8"),
      exitCode: code,
      timedOut,
      outputTruncated,
      ...(spawnError ? { spawnError } : {}),
    });
  });
  if (options.signal?.aborted) {
    timedOut = true;
    kill();
  }
  return promise;
}

export async function canonicalProjectRoot(projectRoot: string): Promise<string> {
  if (typeof projectRoot !== "string" || !projectRoot)
    throw new Error("An approved project directory is required.");
  const root = await realpath(projectRoot);
  if (/[\u0000-\u001f\u007f]/.test(root))
    throw new Error("Project paths containing control characters are not supported.");
  if (root.includes(","))
    throw new Error("Project paths containing commas are not supported by the sandbox runtime.");
  const info = await stat(root);
  if (!info.isDirectory())
    throw new Error("The selected project path must be a directory.");
  const home = await realpath(homedir());
  const homeRelative = relative(root, home);
  if (
    root === parse(root).root ||
    homeRelative === "" ||
    (!homeRelative.startsWith(`..${sep}`) && homeRelative !== ".." && !isAbsolute(homeRelative))
  )
    throw new Error("Choose a project directory, not the filesystem root or an ancestor of the home directory.");
  return root;
}

async function removeContainer(
  config: ProjectSandboxConfig,
  name: string,
): Promise<void> {
  const result = await runtimeProcess(
    config.runtime,
    ["rm", "--force", name],
    { timeoutMs: 10_000, maxOutputBytes: 1_024 },
  );
  if (result.spawnError || result.timedOut)
    throw new Error("Sandbox container cleanup failed.");
  if (
    result.exitCode !== 0 &&
    !/no such container|no container.*name|does not exist/i.test(result.stderr)
  )
    throw new Error("Sandbox container cleanup failed.");
}

export async function runProjectCommand(input: {
  readonly projectRoot: string;
  readonly command: string;
  readonly config: ProjectSandboxConfig;
  readonly timeoutMs: number;
  readonly signal?: AbortSignal;
}): Promise<ProjectCommandResult> {
  const { command } = parseProjectCommand({ command: input.command });
  if (
    (input.config.runtime !== "docker" && input.config.runtime !== "podman") ||
    !/^sha256:[a-f0-9]{64}$/.test(input.config.imageId)
  )
    throw new Error("Project sandbox runtime or image ID is invalid.");
  if (input.signal?.aborted)
    throw new Error("Project sandbox call was cancelled before dispatch.");
  const root = await canonicalProjectRoot(input.projectRoot);
  const timeoutMs = boundedTimeout(input.timeoutMs);
  const uid = process.getuid?.();
  const gid = process.getgid?.();
  if (uid === undefined || gid === undefined)
    throw new Error("The project sandbox requires a POSIX user and group ID.");
  if (uid === 0)
    throw new Error("The project sandbox must not run as root.");
  const name = `nomo-${randomUUID().replaceAll("-", "")}`;
  let created = false;
  let mayHaveExecuted = false;
  let result: ProjectCommandResult | undefined;
  let runError: ProjectSandboxError | undefined;
  try {
    const create = await runtimeProcess(
      input.config.runtime,
      [
        "create",
        "--pull=never",
        "--name",
        name,
        "--network=none",
        "--read-only",
        "--user",
        `${uid}:${gid}`,
        "--cap-drop=ALL",
        "--security-opt=no-new-privileges",
        `--pids-limit=${PROJECT_SANDBOX_LIMITS.pids}`,
        `--cpus=${PROJECT_SANDBOX_LIMITS.cpus}`,
        `--memory=${PROJECT_SANDBOX_LIMITS.memory}`,
        `--memory-swap=${PROJECT_SANDBOX_LIMITS.memory}`,
        "--log-driver=none",
        "--tmpfs",
        `/tmp:rw,nosuid,nodev,size=${PROJECT_SANDBOX_LIMITS.tmpfsBytes},mode=1777`,
        "--mount",
        `type=bind,source=${root},target=/workspace,bind-propagation=rprivate`,
        "--workdir",
        "/workspace",
        "--entrypoint",
        "/bin/sh",
        input.config.imageId,
        "-c",
        command,
      ],
      { timeoutMs: 10_000, maxOutputBytes: 4_096, signal: input.signal },
    );
    created =
      !create.spawnError &&
      (input.signal?.aborted ||
        create.exitCode === 0 ||
        create.timedOut ||
        create.outputTruncated);
    if (
      create.spawnError ||
      create.timedOut ||
      create.outputTruncated ||
      create.exitCode !== 0 ||
      !/^[a-f0-9]{12,64}\s*$/i.test(create.stdout)
    )
      throw new Error("Sandbox runtime could not create the configured container.");
    const containerId = create.stdout.trim();
    mayHaveExecuted = true;
    const started = await runtimeProcess(
      input.config.runtime,
      ["start", "--attach", containerId],
      {
        timeoutMs,
        maxOutputBytes: PROJECT_SANDBOX_LIMITS.outputBytes,
        signal: input.signal,
      },
    );
    if (started.timedOut || started.outputTruncated || input.signal?.aborted) {
      result = {
        stdout: started.stdout,
        stderr: started.stderr,
        exitCode: null,
        timedOut: started.timedOut || input.signal?.aborted === true,
        outputTruncated: started.outputTruncated,
      };
    } else if (started.spawnError) {
      throw new ProjectSandboxError(
        "Sandbox command outcome is unknown after container start.",
        true,
      );
    } else {
      const waited = await runtimeProcess(
        input.config.runtime,
        ["wait", containerId],
        { timeoutMs: 10_000, maxOutputBytes: 128, signal: input.signal },
      );
      const status = waited.stdout.trim();
      if (
        waited.spawnError ||
        waited.timedOut ||
        waited.outputTruncated ||
        waited.exitCode !== 0 ||
        !/^\d{1,3}$/.test(status)
      )
        throw new ProjectSandboxError(
          "Sandbox command outcome is unknown after container start.",
          true,
        );
      result = {
        stdout: started.stdout,
        stderr: started.stderr,
        exitCode: Number(status),
        timedOut: false,
        outputTruncated: false,
      };
    }
  } catch (error) {
    runError =
      error instanceof ProjectSandboxError
        ? error
        : new ProjectSandboxError(
            "Project sandbox could not run the command.",
            mayHaveExecuted,
          );
  } finally {
    if (created) {
      try {
        await removeContainer(input.config, name);
      } catch {
        runError = new ProjectSandboxError(
          "Sandbox container cleanup failed.",
          mayHaveExecuted,
        );
      }
    }
  }
  if (runError) throw runError;
  if (!result) throw new Error("Sandbox command produced no result.");
  return result;
}

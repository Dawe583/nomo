/**
 * Host-delegated subscription runners.
 *
 * `openai-codex` and `claude-code` subscriptions are never imported into NOMO:
 * the token stays inside the installed host application. This module spawns
 * that host as a child process with a strict argument allowlist and no shell,
 * and translates its JSONL stream into the existing AgentRunEvent shapes.
 *
 * The runner never reads a credential file, never forwards provider API keys
 * from the NOMO environment, and never surfaces host stderr. The host owns its
 * login and its own renewal; NOMO only observes the run.
 *
 * Host capabilities differ, so the description is honest per host:
 * `claude` runs with `--tools ""`, so it has no tool authority at all, while
 * `prime-agent` keeps its own tools. A prime tool event is reported and forces
 * the terminal status to `unknown`, because NOMO cannot mediate it.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { access, lstat, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, isAbsolute, join, resolve } from "node:path";
import { Buffer } from "node:buffer";
import {
  AGENT_RUNNER_OUTPUT_LIMITS,
  assertKnownAgentRunnerProfile,
  type AgentCancelResult,
  type AgentRun,
  type AgentRunEvent,
  type AgentRunInput,
  type AgentRunner,
  type AgentRunnerDescription,
} from "./agent-runner.ts";

export const HOST_CLI_LIMITS = {
  timeoutMs: { min: 1_000, max: 600_000, default: 120_000 },
  maxStdoutBytes: 4 * 1024 * 1024,
  maxLineBytes: 1024 * 1024,
  maxStderrBytes: 64 * 1024,
  probeTimeoutMs: 8_000,
  probeMaxOutputBytes: 512 * 1024,
  probeCacheMs: 10_000,
  cancelGraceMs: 5_000,
} as const;

export type HostCliId = "prime-agent" | "claude";

export type HostCliProvider = {
  readonly host: HostCliId;
  readonly sourceId: "prime:openai-codex" | "claude:claude-code";
  /** Provider id the host catalog understands, or the vendor for Claude. */
  readonly providerId: string;
  readonly displayName: string;
  readonly vendor: string;
  readonly binary: string;
  readonly endpoint: string;
};

/** The two subscriptions that only exist behind a first-party host login. */
export const HOST_CLI_PROVIDERS: readonly HostCliProvider[] = [
  {
    host: "prime-agent",
    sourceId: "prime:openai-codex",
    providerId: "openai-codex",
    displayName: "OpenAI Codex through Prime Agent",
    vendor: "OpenAI Codex",
    binary: "prime-agent",
    endpoint: "https://chatgpt.com/backend-api/codex",
  },
  {
    host: "claude",
    sourceId: "claude:claude-code",
    providerId: "anthropic",
    displayName: "Claude Code through the Claude host",
    vendor: "Anthropic",
    binary: "claude",
    endpoint: "https://api.anthropic.com",
  },
] as const;

/** What one host can actually do, beyond the shared runner description. */
export type HostCliHostDescription = {
  readonly host: HostCliId;
  readonly sourceId: HostCliProvider["sourceId"];
  readonly providerId: string;
  readonly displayName: string;
  readonly vendor: string;
  readonly binary: string;
  readonly endpoint: string;
  /** `none` for a host started without tools; `host` for its own tool set. */
  readonly tools: "none" | "host";
};

export type HostCliProbeReason =
  | "host-not-installed"
  | "host-login-required"
  | "host-api-key-only"
  | "host-login-unknown"
  | "host-provider-unavailable"
  | "host-probe-failed";

export type HostCliProbe = {
  readonly host: HostCliId;
  readonly available: boolean;
  readonly reason?: HostCliProbeReason;
};

/**
 * The environment a host child receives.
 *
 * Provider keys and NOMO secrets are deliberately absent: the host must run on
 * its own login, and a NOMO credential must never become a fallback for it.
 */
export function hostCliEnvironment(
  env: Readonly<NodeJS.ProcessEnv>,
): NodeJS.ProcessEnv {
  const allowed = [
    "PATH",
    "HOME",
    "USERPROFILE",
    "TMPDIR",
    "TMP",
    "TEMP",
    "LANG",
    "LC_ALL",
    "LC_CTYPE",
    "SYSTEMROOT",
    "APPDATA",
    "LOCALAPPDATA",
  ];
  const sanitized: NodeJS.ProcessEnv = {};
  for (const key of allowed) {
    const value = env[key];
    if (typeof value === "string" && value.length > 0) sanitized[key] = value;
  }
  sanitized.NO_COLOR = "1";
  return sanitized;
}

const PROVIDER_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const MODEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;
/**
 * A binary is a bare executable name resolved through PATH, never a path.
 *
 * An absolute or relative path would let a caller point the runner at an
 * arbitrary executable, which is authority NOMO has no basis to grant: the
 * whole point of this module is that it spawns the host the operator
 * installed, and only that.
 */
const BINARY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

function isBareBinaryName(value: string): boolean {
  return (
    BINARY_PATTERN.test(value) &&
    !isAbsolute(value) &&
    !value.includes("/") &&
    !value.includes("\\")
  );
}

export type HostCliArgumentsInput = {
  readonly task: string;
  readonly systemPrompt: string;
  readonly providerId: string;
  readonly model?: string;
  readonly cwd: string;
  readonly sessionDir: string;
};

/**
 * The complete argv for one host run. Every token is either a fixed flag or a
 * value validated against a closed pattern; the task is placed after `--` so a
 * prompt that begins with a dash cannot become a flag.
 */
export function hostCliArguments(
  host: HostCliId,
  input: HostCliArgumentsInput,
): readonly string[] {
  const task = input.task.trim();
  if (!task || task.length > 32_000 || task.includes("\u0000"))
    throw new Error("Host CLI task is empty or too large.");
  const systemPrompt = input.systemPrompt;
  if (
    typeof systemPrompt !== "string" ||
    systemPrompt.length > 16_000 ||
    systemPrompt.includes("\u0000")
  )
    throw new Error("Host CLI system prompt is too large.");
  if (!isAbsolute(input.cwd) || input.cwd.includes("\u0000"))
    throw new Error("Host CLI working directory must be absolute.");
  if (!isAbsolute(input.sessionDir) || input.sessionDir.includes("\u0000"))
    throw new Error("Host CLI session directory must be absolute.");
  if (!PROVIDER_PATTERN.test(input.providerId))
    throw new Error("Host CLI provider id is invalid.");
  const model =
    input.model === undefined || input.model === ""
      ? undefined
      : input.model;
  if (model !== undefined && !MODEL_PATTERN.test(model))
    throw new Error("Host CLI model id is invalid.");

  if (host === "prime-agent")
    return [
      "--mode",
      "json",
      "-p",
      "--offline",
      "--cwd",
      input.cwd,
      "--session-dir",
      input.sessionDir,
      "-ns",
      "-nc",
      "--provider",
      input.providerId,
      ...(model === undefined ? [] : ["--model", model]),
      "--append-system-prompt",
      systemPrompt,
      "--",
      task,
    ];
  return [
    "-p",
    "--output-format",
    "stream-json",
    "--verbose",
    // No built-in tools, no user or project settings, no MCP servers: the
    // host answers with text only and cannot touch the workspace.
    "--tools",
    "",
    "--setting-sources",
    "",
    "--strict-mcp-config",
    "--no-session-persistence",
    ...(model === undefined ? [] : ["--model", model]),
    "--append-system-prompt",
    systemPrompt,
    "--",
    task,
  ];
}

export type HostCliStreamEvent =
  | { readonly kind: "assistant"; readonly text: string }
  | { readonly kind: "tool"; readonly toolName: string }
  | { readonly kind: "result"; readonly status: "completed" | "failed" | "cancelled" }
  | { readonly kind: "unmappable"; readonly reason: string }
  | { readonly kind: "ignored" };

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function textBlocks(content: unknown): {
  text: string;
  toolName?: string;
} {
  if (!Array.isArray(content)) return { text: "" };
  const parts: string[] = [];
  let toolName: string | undefined;
  for (const block of content) {
    const item = record(block);
    if (!item) continue;
    if (item.type === "text" && typeof item.text === "string") parts.push(item.text);
    else if (item.type === "tool_use" || item.type === "tool_result") {
      toolName =
        typeof item.name === "string" && item.name.length > 0
          ? item.name
          : "tool";
    }
  }
  return { text: parts.join("\n"), ...(toolName === undefined ? {} : { toolName }) };
}

/**
 * One JSONL line from a host stream, mapped to what NOMO can honestly say.
 *
 * Unknown event types are ignored so a newer host can add informational
 * events. Anything that would require NOMO to answer the host, or that shows
 * authority NOMO cannot mediate, is `unmappable` and stops the run.
 */
export function parseHostCliLine(
  host: HostCliId,
  line: string,
): HostCliStreamEvent {
  const trimmed = line.trim();
  if (!trimmed) return { kind: "ignored" };
  let value: unknown;
  try {
    value = JSON.parse(trimmed);
  } catch {
    return { kind: "unmappable", reason: "malformed-json" };
  }
  const event = record(value);
  if (!event || typeof event.type !== "string")
    return { kind: "unmappable", reason: "missing-type" };

  if (host === "prime-agent") {
    if (event.type === "message_end") {
      const message = record(event.message);
      if (!message || message.role !== "assistant") return { kind: "ignored" };
      const content = textBlocks(message.content);
      if (content.toolName !== undefined)
        return { kind: "tool", toolName: content.toolName };
      const stopReason = message.stopReason;
      if (stopReason === "aborted")
        return { kind: "result", status: "cancelled" };
      if (stopReason === "error") return { kind: "result", status: "failed" };
      return content.text
        ? { kind: "assistant", text: content.text }
        : { kind: "ignored" };
    }
    if (event.type === "tool_execution_start")
      return {
        kind: "tool",
        toolName:
          typeof event.toolName === "string" && event.toolName.length > 0
            ? event.toolName
            : "tool",
      };
    if (/permission|approval/i.test(event.type))
      return { kind: "unmappable", reason: event.type };
    return { kind: "ignored" };
  }

  if (event.type === "assistant") {
    if (event.parent_tool_use_id !== null && event.parent_tool_use_id !== undefined)
      return { kind: "ignored" };
    const message = record(event.message);
    if (!message) return { kind: "unmappable", reason: "assistant-message-missing" };
    const content = textBlocks(message.content);
    if (content.toolName !== undefined)
      return { kind: "tool", toolName: content.toolName };
    return content.text
      ? { kind: "assistant", text: content.text }
      : { kind: "ignored" };
  }
  if (event.type === "user") {
    const message = record(event.message);
    const content = textBlocks(message?.content);
    if (content.toolName !== undefined)
      return { kind: "unmappable", reason: "tool-result" };
    return { kind: "ignored" };
  }
  if (event.type === "result") {
    if (event.is_error === true || event.subtype !== "success")
      return { kind: "result", status: "failed" };
    return { kind: "result", status: "completed" };
  }
  if (event.type === "system" || event.type === "stream_event")
    return { kind: "ignored" };
  if (/permission|approval|tool/i.test(event.type))
    return { kind: "unmappable", reason: event.type };
  return { kind: "ignored" };
}

type HostProcessOutcome = {
  readonly code: number | null;
  readonly signal: string | null;
  readonly timedOut: boolean;
  readonly aborted: boolean;
  readonly outputExceeded: boolean;
  readonly spawnFailed: boolean;
};

type HostProcessOptions = {
  readonly binary: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly timeoutMs: number;
  readonly maxStdoutBytes: number;
  readonly signal?: AbortSignal;
  readonly onLine: (line: string) => void;
};

/**
 * Runs one host child with bounded output, a wall-clock limit and an abort
 * path. Only stdout lines reach the caller; stderr is counted and discarded so
 * account or credential text printed by the host cannot reach an event.
 */
function runHostProcess(options: HostProcessOptions): Promise<HostProcessOutcome> {
  return new Promise((complete) => {
    let settled = false;
    let timedOut = false;
    let aborted = false;
    let outputExceeded = false;
    let spawnFailed = false;
    let pending = "";
    let stdoutBytes = 0;
    let killTimer: NodeJS.Timeout | undefined;
    let timeout: NodeJS.Timeout | undefined;

    const finish = (code: number | null, signal: string | null) => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      if (killTimer) clearTimeout(killTimer);
      options.signal?.removeEventListener("abort", onAbort);
      complete({
        code,
        signal,
        timedOut,
        aborted,
        outputExceeded,
        spawnFailed,
      });
    };
    const terminate = () => {
      try {
        child.kill("SIGTERM");
      } catch {
        /* The process may already be gone. */
      }
      killTimer ??= setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          /* The process may already be gone. */
        }
      }, 1_000);
    };
    const onAbort = () => {
      aborted = true;
      terminate();
    };

    let child: ChildProcess;
    try {
      child = spawn(options.binary, [...options.args], {
        cwd: options.cwd,
        env: options.env,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch {
      spawnFailed = true;
      complete({
        code: null,
        signal: null,
        timedOut: false,
        aborted: false,
        outputExceeded: false,
        spawnFailed,
      });
      return;
    }

    timeout = setTimeout(() => {
      timedOut = true;
      terminate();
    }, options.timeoutMs);

    const emitLine = (line: string) => {
      if (!line.trim()) return;
      try {
        options.onLine(line);
      } catch {
        outputExceeded = true;
        terminate();
      }
    };

    child.stdout?.on("data", (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > options.maxStdoutBytes) {
        outputExceeded = true;
        terminate();
        return;
      }
      pending += chunk.toString("utf8");
      let index = pending.indexOf("\n");
      while (index >= 0) {
        const line = pending.slice(0, index);
        pending = pending.slice(index + 1);
        if (Buffer.byteLength(line, "utf8") > HOST_CLI_LIMITS.maxLineBytes) {
          outputExceeded = true;
          terminate();
          return;
        }
        emitLine(line);
        index = pending.indexOf("\n");
      }
      if (Buffer.byteLength(pending, "utf8") > HOST_CLI_LIMITS.maxLineBytes) {
        outputExceeded = true;
        terminate();
      }
    });
    // Stderr is drained and discarded: the host may print account or
    // credential text there, and none of it belongs in a NOMO event.
    child.stderr?.on("data", () => undefined);
    child.on("error", () => {
      spawnFailed = true;
      finish(null, null);
    });
    child.on("close", (code, signal) => {
      if (pending.trim()) emitLine(pending);
      finish(code, signal);
    });
    if (options.signal?.aborted) onAbort();
    else options.signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** Resolve an executable through PATH without a shell. */
export async function resolveHostBinary(
  binary: string,
  env: Readonly<NodeJS.ProcessEnv>,
): Promise<string | undefined> {
  const pathValue = env.PATH ?? "";
  const extensions = process.platform === "win32" ? ["", ".exe", ".cmd", ".bat"] : [""];
  for (const directory of pathValue.split(delimiter)) {
    if (!directory || !isAbsolute(directory)) continue;
    for (const extension of extensions) {
      const candidate = join(directory, `${binary}${extension}`);
      try {
        await access(candidate, constants.X_OK);
        const target = await stat(candidate);
        if (target.isFile()) return candidate;
      } catch {
        /* Not here. */
      }
    }
  }
  return undefined;
}

const probeCache = new Map<string, { readonly at: number; readonly probe: HostCliProbe }>();

/** Test and operator hook: forget cached probe results. */
export function resetHostCliProbeCache(): void {
  probeCache.clear();
}

async function collectProbeLines(
  binary: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
): Promise<{ lines: string[]; outcome: HostProcessOutcome } | undefined> {
  const lines: string[] = [];
  let bytes = 0;
  const outcome = await runHostProcess({
    binary,
    args,
    cwd: tmpdir(),
    env,
    timeoutMs: HOST_CLI_LIMITS.probeTimeoutMs,
    maxStdoutBytes: HOST_CLI_LIMITS.probeMaxOutputBytes,
    onLine: (line) => {
      bytes += Buffer.byteLength(line, "utf8");
      if (bytes > HOST_CLI_LIMITS.probeMaxOutputBytes)
        throw new Error("probe output exceeded");
      lines.push(line);
    },
  });
  if (outcome.spawnFailed) return undefined;
  return { lines, outcome };
}

function failedProbe(
  host: HostCliId,
  reason: HostCliProbeReason,
): HostCliProbe {
  return { host, available: false, reason };
}

async function probePrimeAgent(
  binary: string,
  env: NodeJS.ProcessEnv,
  provider: HostCliProvider,
): Promise<HostCliProbe> {
  const result = await collectProbeLines(binary, ["model", "list"], env);
  if (!result) return failedProbe("prime-agent", "host-probe-failed");
  const { lines, outcome } = result;
  if (outcome.timedOut || outcome.outputExceeded || outcome.aborted)
    return failedProbe("prime-agent", "host-probe-failed");
  if (outcome.code !== 0) return failedProbe("prime-agent", "host-probe-failed");
  const listed = lines.some(
    (line) => line.trim().split(/\s+/)[0] === provider.providerId,
  );
  return listed
    ? { host: "prime-agent", available: true }
    : failedProbe("prime-agent", "host-provider-unavailable");
}

async function probeClaude(
  binary: string,
  env: NodeJS.ProcessEnv,
): Promise<HostCliProbe> {
  const version = await collectProbeLines(binary, ["--version"], env);
  if (
    !version ||
    version.outcome.timedOut ||
    version.outcome.code !== 0 ||
    version.lines.length === 0
  )
    return failedProbe("claude", "host-probe-failed");

  const status = await collectProbeLines(
    binary,
    ["auth", "status", "--json"],
    env,
  );
  if (!status || status.outcome.timedOut || status.outcome.code !== 0)
    return failedProbe("claude", "host-login-unknown");
  let parsed: unknown;
  try {
    parsed = JSON.parse(status.lines.join("\n"));
  } catch {
    return failedProbe("claude", "host-login-unknown");
  }
  const recordValue = record(parsed);
  if (!recordValue || typeof recordValue.loggedIn !== "boolean")
    return failedProbe("claude", "host-login-unknown");
  if (!recordValue.loggedIn) return failedProbe("claude", "host-login-required");
  // A host running on an API key is not a subscription, so NOMO must not
  // present it as one. The method name is read and discarded, never reported.
  if (
    recordValue.authMethod === "api_key" ||
    (typeof recordValue.apiKeySource === "string" &&
      recordValue.apiKeySource.length > 0)
  )
    return failedProbe("claude", "host-api-key-only");
  return { host: "claude", available: true };
}

/**
 * Probe one host without reading any credential file and without printing
 * account data. Results are cached briefly because discovery runs on startup,
 * on /sources and on /providers.
 *
 * prime-agent 0.10.3 has no non-secret login-status command, so its model list
 * is the host's own statement that the provider is runnable; a logged-out host
 * fails closed when the run starts. Claude Code exposes `auth status`, so its
 * login and API-key-only states are decided here.
 */
export async function probeHostCli(
  host: HostCliId,
  env: Readonly<NodeJS.ProcessEnv>,
  now = Date.now(),
): Promise<HostCliProbe> {
  const provider = HOST_CLI_PROVIDERS.find((candidate) => candidate.host === host);
  if (!provider) return failedProbe(host, "host-probe-failed");
  const cacheKey = `${host}\u0000${env.PATH ?? ""}\u0000${env.HOME ?? ""}`;
  const cached = probeCache.get(cacheKey);
  if (cached && now - cached.at < HOST_CLI_LIMITS.probeCacheMs)
    return cached.probe;

  const sanitized = hostCliEnvironment(env);
  const binary = await resolveHostBinary(provider.binary, sanitized);
  const probe =
    binary === undefined
      ? failedProbe(host, "host-not-installed")
      : host === "prime-agent"
        ? await probePrimeAgent(binary, sanitized, provider)
        : await probeClaude(binary, sanitized);
  probeCache.set(cacheKey, { at: now, probe });
  while (probeCache.size > 32) {
    const oldest = probeCache.keys().next().value;
    if (oldest === undefined) break;
    probeCache.delete(oldest);
  }
  return probe;
}

class EventQueue implements AsyncIterable<AgentRunEvent> {
  private readonly values: AgentRunEvent[] = [];
  private readonly waiters: Array<(value: IteratorResult<AgentRunEvent>) => void> = [];
  private ended = false;

  push(value: AgentRunEvent): void {
    const waiter = this.waiters.shift();
    if (waiter) waiter({ value, done: false });
    else this.values.push(value);
  }

  close(): void {
    this.ended = true;
    for (const waiter of this.waiters.splice(0)) waiter({ value: undefined, done: true });
  }

  [Symbol.asyncIterator](): AsyncIterator<AgentRunEvent> {
    return {
      next: () => {
        const value = this.values.shift();
        if (value) return Promise.resolve({ value, done: false });
        if (this.ended) return Promise.resolve({ value: undefined, done: true });
        return new Promise((resolveNext) => this.waiters.push(resolveNext));
      },
    };
  }
}

function deferred<T>() {
  let resolveValue!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolveValue = resolvePromise;
  });
  return { promise, resolve: resolveValue };
}

function truncateText(
  text: string,
  maxBytes: number,
): { readonly text: string; readonly truncated: boolean } {
  if (Buffer.byteLength(text, "utf8") <= maxBytes)
    return { text, truncated: false };
  let used = 0;
  let output = "";
  for (const point of text) {
    const size = Buffer.byteLength(point, "utf8");
    if (used + size > maxBytes) break;
    used += size;
    output += point;
  }
  return { text: output, truncated: true };
}

function safeToolName(value: string): string {
  const cleaned = value.replace(/[^\w .:/@+-]/g, "_").slice(0, 160);
  return cleaned.length > 0 ? cleaned : "tool";
}

export type HostCliRunnerOptions = {
  readonly host: HostCliId;
  /** Defaults to the provider id declared for the host. */
  readonly providerId?: string;
  /** Defaults to the host binary on PATH. */
  readonly binary?: string;
  readonly model?: string;
  /** Models advertised through the AgentRunner description. */
  readonly models?: readonly string[];
  /** The approved working directory. Defaults to the process directory. */
  readonly cwd?: string;
  /** A caller-owned session directory. A temporary one is used by default. */
  readonly sessionDir?: string;
  readonly timeoutMs?: number;
  readonly env?: Readonly<NodeJS.ProcessEnv>;
};

type HostRunState = {
  readonly controller: AbortController;
  readonly done: Promise<"completed" | "failed" | "cancelled" | "unknown">;
};

type UnsequencedAgentRunEvent<T = AgentRunEvent> =
  T extends AgentRunEvent ? Omit<T, "runId" | "sequence"> : never;

export class HostCliRunner implements AgentRunner {
  private readonly provider: HostCliProvider;
  private readonly binary: string;
  private readonly model: string | undefined;
  private readonly models: readonly string[];
  private readonly cwd: string;
  private readonly sessionDir: string | undefined;
  private readonly timeoutMs: number;
  private readonly env: NodeJS.ProcessEnv;
  private readonly runs = new Map<string, HostRunState>();

  constructor(options: HostCliRunnerOptions) {
    const provider = HOST_CLI_PROVIDERS.find(
      (candidate) => candidate.host === options.host,
    );
    if (!provider) throw new Error("Unknown host CLI.");
    const providerId = options.providerId ?? provider.providerId;
    if (!PROVIDER_PATTERN.test(providerId))
      throw new Error("Host CLI provider id is invalid.");
    if (options.model !== undefined && !MODEL_PATTERN.test(options.model))
      throw new Error("Host CLI model id is invalid.");
    if (options.timeoutMs !== undefined) {
      if (
        !Number.isSafeInteger(options.timeoutMs) ||
        options.timeoutMs < HOST_CLI_LIMITS.timeoutMs.min ||
        options.timeoutMs > HOST_CLI_LIMITS.timeoutMs.max
      )
        throw new Error("Host CLI timeout is outside its bounds.");
    }
    this.provider = { ...provider, providerId };
    if (options.binary !== undefined && !isBareBinaryName(options.binary))
      throw new Error("Host CLI binary must be a bare executable name.");
    this.binary = options.binary ?? provider.binary;
    this.model = options.model;
    this.models = [
      ...new Set(
        (options.models ?? (options.model ? [options.model] : [])).filter(
          (model) => MODEL_PATTERN.test(model),
        ),
      ),
    ];
    this.cwd = resolve(options.cwd ?? process.cwd());
    this.sessionDir =
      options.sessionDir === undefined ? undefined : resolve(options.sessionDir);
    this.timeoutMs = options.timeoutMs ?? HOST_CLI_LIMITS.timeoutMs.default;
    this.env = hostCliEnvironment(options.env ?? process.env);
  }

  describe(): AgentRunnerDescription {
    return {
      id: `host-${this.provider.host}`,
      displayName: this.provider.displayName,
      provider: this.provider.vendor,
      endpoint: this.provider.endpoint,
      dataTransfer: "remote",
      dataSent: ["task", "system-prompt"],
      profiles: [...this.models],
      execution: "local",
      // A host run is observed, never mediated. The Claude host is started
      // with no tools at all and prime-agent keeps its own, but Workbench can
      // dispatch neither, so both claims are the honest `unmediated` and
      // `opaque` rather than a narrower claim Workbench cannot enforce. What
      // each host may actually do with tools is stated by `describeHost`.
      toolAccess: "unmediated",
      workspaceMode: "opaque",
      cancellation: "may-be-unknown",
    };
  }

  /** The per-host facts the description cannot carry, for the operator UI. */
  describeHost(): HostCliHostDescription {
    return {
      host: this.provider.host,
      sourceId: this.provider.sourceId,
      providerId: this.provider.providerId,
      displayName: this.provider.displayName,
      vendor: this.provider.vendor,
      binary: this.binary,
      endpoint: this.provider.endpoint,
      // The Claude host is spawned with `--tools ""`, so it has no tool
      // authority at all; prime-agent keeps the tools it ships with.
      tools: this.provider.host === "claude" ? "none" : "host",
    };
  }

  async start(input: AgentRunInput): Promise<AgentRun> {
    if (input.signal.aborted)
      throw new Error("Host CLI run was already cancelled.");
    assertKnownAgentRunnerProfile(this.describe(), input.profileId);
    if (input.tools.length > 0)
      throw new Error("Host CLI runs cannot mediate NOMO tools.");
    const binary = await resolveHostBinary(this.binary, this.env);
    if (binary === undefined)
      throw new Error("Host CLI executable was not found on PATH.");
    const cwdStat = await lstat(this.cwd).catch(() => undefined);
    if (!cwdStat?.isDirectory())
      throw new Error("Host CLI working directory is unavailable.");
    if (this.sessionDir !== undefined) {
      const sessionStat = await lstat(this.sessionDir).catch(() => undefined);
      if (!sessionStat?.isDirectory())
        throw new Error("Host CLI session directory is unavailable.");
    }

    const ownedSessionDir =
      this.sessionDir === undefined
        ? await mkdtemp(join(tmpdir(), "nomo-host-"))
        : undefined;
    const sessionDir = ownedSessionDir ?? this.sessionDir!;
    let argv: readonly string[];
    try {
      argv = hostCliArguments(this.provider.host, {
        task: input.task,
        // The system prompt is fixed, never the caller's. A host run is a
        // subscription run NOMO only observes, so the instructions that frame
        // it must be the ones this module ships and nothing a caller, a
        // profile or a workspace can rewrite.
        systemPrompt: HOST_RUN_SYSTEM_PROMPT,
        providerId: this.provider.providerId,
        ...(this.model === undefined ? {} : { model: this.model }),
        cwd: this.cwd,
        sessionDir,
      });
    } catch (error) {
      if (ownedSessionDir !== undefined)
        await rm(ownedSessionDir, { recursive: true, force: true }).catch(
          () => undefined,
        );
      throw error;
    }

    const id = randomUUID();
    const controller = new AbortController();
    const queue = new EventQueue();
    const { promise: done, resolve: resolveDone } = deferred<
      "completed" | "failed" | "cancelled" | "unknown"
    >();
    let sequence = 0;
    const emit = (event: UnsequencedAgentRunEvent) => {
      queue.push({ ...event, runId: id, sequence: ++sequence } as AgentRunEvent);
    };
    const onInputAbort = () => controller.abort();
    input.signal.addEventListener("abort", onInputAbort, { once: true });
    if (input.signal.aborted) controller.abort();

    this.runs.set(id, { controller, done });
    emit({ type: "status", status: "starting" });

    const finished = (async () => {
      emit({ type: "status", status: "running" });
      let resultStatus: "completed" | "failed" | "cancelled" | undefined;
      let sawTool = false;
      let unmappable: string | undefined;
      let assistantBytes = 0;
      let truncationNoted = false;
      const outcome = await runHostProcess({
        binary,
        args: argv,
        cwd: this.cwd,
        env: this.env,
        timeoutMs: this.timeoutMs,
        maxStdoutBytes: HOST_CLI_LIMITS.maxStdoutBytes,
        signal: controller.signal,
        onLine: (line) => {
          if (unmappable !== undefined || resultStatus !== undefined) return;
          const parsed = parseHostCliLine(this.provider.host, line);
          if (parsed.kind === "ignored") return;
          if (parsed.kind === "unmappable") {
            unmappable = parsed.reason;
            return;
          }
          if (parsed.kind === "tool") {
            sawTool = true;
            emit({
              type: "status",
              status: "running",
              message: `Host tool started: ${safeToolName(parsed.toolName)}. NOMO cannot mediate host tools.`,
            });
            return;
          }
          if (parsed.kind === "result") {
            resultStatus = parsed.status;
            return;
          }
          const remaining =
            AGENT_RUNNER_OUTPUT_LIMITS.maxRunBytes - assistantBytes;
          if (remaining <= 0) {
            if (!truncationNoted) {
              truncationNoted = true;
              emit({
                type: "status",
                status: "running",
                message: "Host output reached the run limit; later text was dropped.",
              });
            }
            return;
          }
          const bounded = truncateText(
            parsed.text,
            Math.min(AGENT_RUNNER_OUTPUT_LIMITS.maxMessageBytes, remaining),
          );
          assistantBytes += Buffer.byteLength(bounded.text, "utf8");
          if (bounded.truncated && !truncationNoted) {
            truncationNoted = true;
            emit({
              type: "status",
              status: "running",
              message: "Host message was truncated at the NOMO output limit.",
            });
          }
          if (bounded.text) emit({ type: "assistant-message", text: bounded.text });
        },
      });

      let terminal: "completed" | "failed" | "cancelled" | "unknown";
      let terminalMessage: string | undefined;
      if (outcome.aborted || controller.signal.aborted) {
        terminal = "cancelled";
      } else if (outcome.timedOut) {
        terminal = "unknown";
        terminalMessage = `Host run exceeded its ${this.timeoutMs}ms limit and was stopped. Its outcome is unproven.`;
      } else if (outcome.outputExceeded) {
        terminal = "failed";
        terminalMessage = "Host output exceeded the NOMO limit; the run was stopped.";
      } else if (unmappable !== undefined) {
        terminal = "failed";
        terminalMessage = `Host event "${unmappable.slice(0, 120)}" cannot be mapped to a NOMO event; the run was stopped.`;
      } else if (outcome.spawnFailed) {
        terminal = "failed";
        terminalMessage = "Host process could not be started.";
      } else if (resultStatus === "cancelled") {
        terminal = "cancelled";
      } else if (resultStatus === "failed") {
        terminal = "failed";
        terminalMessage = "The host reported that the run failed.";
      } else if (outcome.code !== 0) {
        terminal = "failed";
        terminalMessage = `Host exited with code ${String(outcome.code ?? "unknown")}.`;
      } else if (resultStatus === "completed" || outcome.code === 0) {
        terminal = sawTool ? "unknown" : "completed";
        if (sawTool)
          terminalMessage =
            "Host tools ran outside NOMO mediation, so the outcome is unproven.";
      } else {
        terminal = "unknown";
        terminalMessage = "Host stream ended without a proven result.";
      }

      input.signal.removeEventListener("abort", onInputAbort);
      if (ownedSessionDir !== undefined)
        await rm(ownedSessionDir, { recursive: true, force: true }).catch(
          () => undefined,
        );
      emit({
        type: "terminal",
        status: terminal,
        ...(terminalMessage === undefined ? {} : { message: terminalMessage }),
      });
      queue.close();
      resolveDone(terminal);
      this.runs.delete(id);
    })();
    void finished.catch(() => undefined);

    return {
      id,
      events: queue,
      async respondToTool() {
        throw new Error("Host CLI runs do not mediate tools.");
      },
    };
  }

  async cancel(runId: string): Promise<AgentCancelResult> {
    const state = this.runs.get(runId);
    if (!state) return "unknown";
    state.controller.abort();
    const { promise: timeout, resolve } = deferred<undefined>();
    const timer = setTimeout(() => resolve(undefined), HOST_CLI_LIMITS.cancelGraceMs);
    const outcome = await Promise.race([state.done, timeout]);
    clearTimeout(timer);
    return outcome === "cancelled" ? "confirmed" : "unknown";
  }
}

/** The system prompt every host run carries; fixed so it cannot be rewritten. */
export const HOST_RUN_SYSTEM_PROMPT =
  "This run was requested by the user through NOMO and executed by the installed host application. The host owns its own credentials; never print, copy or transmit a token or credential. NOMO does not mediate host tools and cannot undo host changes. Report actual results and do not claim capabilities you did not use.";

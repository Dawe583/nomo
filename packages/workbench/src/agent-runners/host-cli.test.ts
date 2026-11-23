/**
 * Host-delegated subscription runner tests.
 *
 * Every test drives a fake host executable written into a temporary PATH, so
 * the suite needs no installed host, no login and no network.
 *
 * One opt-in local smoke run is documented here and never runs by default:
 *
 *   NOMO_HOST_CLI_SMOKE=prime-agent node --test packages/workbench/src/agent-runners/host-cli.test.ts
 *   NOMO_HOST_CLI_SMOKE=claude      node --test packages/workbench/src/agent-runners/host-cli.test.ts
 *
 * The smoke test sends one short prompt through the installed host using the
 * host's own login and prints only the mapped event types. It makes a real
 * provider request and is therefore opt-in.
 */
import assert from "node:assert/strict";
import { chmod, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  HOST_CLI_LIMITS,
  HOST_CLI_PROVIDERS,
  HostCliRunner,
  hostCliArguments,
  hostCliEnvironment,
  parseHostCliLine,
  probeHostCli,
  resetHostCliProbeCache,
  resolveHostBinary,
  type HostCliId,
} from "./host-cli.ts";
import {
  validateAgentRunEvents,
  type AgentRun,
  type AgentRunEvent,
} from "./agent-runner.ts";

const WORKSPACE = {
  id: "fixture-workspace",
  rootDigest: `sha256:${"0".repeat(64)}`,
  allowedTools: [],
} as const;

const SYSTEM_PROMPT = "Fixture system prompt.";

test("resolveHostBinary follows a symlinked executable on PATH", async () => {
  const directory = await mkdtemp(join(tmpdir(), "nomo-host-link-"));
  try {
    const target = join(directory, "real-prime-agent");
    await writeFile(target, "#!/bin/sh\nexit 0\n");
    await chmod(target, 0o755);
    const link = join(directory, "prime-agent");
    await symlink(target, link);
    assert.equal(await resolveHostBinary("prime-agent", { PATH: directory }), link);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

async function fixture(t: { after: (fn: () => Promise<void>) => void }) {
  const root = await mkdtemp(join(tmpdir(), "nomo-host-cli-"));
  const bin = join(root, "bin");
  const home = join(root, "home");
  const cwd = join(root, "project");
  await mkdir(bin, { recursive: true });
  await mkdir(home, { recursive: true });
  await mkdir(cwd, { recursive: true });
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });
  const script = async (name: string, body: string) => {
    const path = join(bin, name);
    await writeFile(path, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
    await chmod(path, 0o755);
    return path;
  };
  // The fake host comes first; the system directories keep ordinary shell
  // utilities available inside the fixture scripts.
  const env = {
    PATH: `${bin}:/usr/bin:/bin:/usr/sbin:/sbin`,
    HOME: home,
    TMPDIR: root,
  };
  return { root, bin, home, cwd, env, script };
}

function runnerFor(
  host: HostCliId,
  env: Readonly<NodeJS.ProcessEnv>,
  cwd: string,
  extra: { readonly timeoutMs?: number; readonly model?: string } = {},
) {
  return new HostCliRunner({
    host,
    env,
    cwd,
    ...extra,
  });
}

async function collect(run: AgentRun): Promise<AgentRunEvent[]> {
  const events: AgentRunEvent[] = [];
  for await (const event of validateAgentRunEvents(run.id, run.events))
    events.push(event);
  return events;
}

function terminal(events: readonly AgentRunEvent[]) {
  return events.at(-1) as Extract<AgentRunEvent, { type: "terminal" }>;
}

function json(value: unknown): string {
  return JSON.stringify(value);
}

test("host argv is a closed allowlist with the task after the separator", () => {
  const prime = hostCliArguments("prime-agent", {
    task: "-starts-with-a-dash",
    systemPrompt: SYSTEM_PROMPT,
    providerId: "openai-codex",
    model: "gpt-5.4",
    cwd: "/tmp",
    sessionDir: "/tmp/session",
  });
  assert.deepEqual(prime.slice(0, 3), ["--mode", "json", "-p"]);
  assert.ok(prime.includes("--provider"));
  assert.ok(prime.includes("openai-codex"));
  assert.equal(prime.at(-2), "--");
  assert.equal(prime.at(-1), "-starts-with-a-dash");

  const claude = hostCliArguments("claude", {
    task: "hello",
    systemPrompt: SYSTEM_PROMPT,
    providerId: "anthropic",
    cwd: "/tmp",
    sessionDir: "/tmp/session",
  });
  assert.deepEqual(claude.slice(0, 3), ["-p", "--output-format", "stream-json"]);
  assert.equal(claude[claude.indexOf("--tools") + 1], "");
  assert.equal(claude.at(-2), "--");
  assert.equal(claude.at(-1), "hello");

  assert.throws(
    () =>
      hostCliArguments("prime-agent", {
        task: "hello",
        systemPrompt: SYSTEM_PROMPT,
        providerId: "openai-codex",
        model: "--dangerously",
        cwd: "/tmp",
        sessionDir: "/tmp/session",
      }),
    /model id is invalid/,
  );
  assert.throws(
    () =>
      hostCliArguments("prime-agent", {
        task: "hello",
        systemPrompt: SYSTEM_PROMPT,
        providerId: "openai-codex",
        cwd: "relative",
        sessionDir: "/tmp/session",
      }),
    /working directory must be absolute/,
  );
});

test("the child environment drops provider keys and NOMO secrets", () => {
  const sanitized = hostCliEnvironment({
    PATH: "/usr/bin",
    HOME: "/home/operator",
    ANTHROPIC_API_KEY: "sk-ant-fixture",
    OPENAI_API_KEY: "sk-fixture",
    NOMO_WORKSPACE_KEY: "fixture-workspace-key",
    GITHUB_TOKEN: "fixture-github",
    NOMO_DATA_DIR: "/home/operator/.nomo",
  });
  assert.equal(sanitized.PATH, "/usr/bin");
  assert.equal(sanitized.HOME, "/home/operator");
  assert.equal(sanitized.ANTHROPIC_API_KEY, undefined);
  assert.equal(sanitized.OPENAI_API_KEY, undefined);
  assert.equal(sanitized.NOMO_WORKSPACE_KEY, undefined);
  assert.equal(sanitized.GITHUB_TOKEN, undefined);
  assert.equal(sanitized.NOMO_DATA_DIR, undefined);
});

test("a prime JSONL success stream maps to status, assistant and terminal", async (t) => {
  const f = await fixture(t);
  await f.script(
    "prime-agent",
    [
      `printf '%s\\n' ${JSON.stringify(json({ type: "message_start" }))}`,
      `printf '%s\\n' ${JSON.stringify(
        json({
          type: "message_end",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "Hello from the host." }],
            stopReason: "end_turn",
          },
        }),
      )}`,
    ].join("\n"),
  );
  const runner = runnerFor("prime-agent", f.env, f.cwd);
  const run = await runner.start({
    task: "Say hello",
    systemPrompt: SYSTEM_PROMPT,
    workspace: WORKSPACE,
    tools: [],
    signal: new AbortController().signal,
  });
  const events = await collect(run);
  assert.deepEqual(
    events.map((event) => event.type),
    ["status", "status", "assistant-message", "terminal"],
  );
  const assistant = events[2];
  assert.equal(
    assistant?.type === "assistant-message" ? assistant.text : undefined,
    "Hello from the host.",
  );
  assert.equal(terminal(events).status, "completed");
});

test("a claude JSONL success stream maps assistant text and result", async (t) => {
  const f = await fixture(t);
  await f.script(
    "claude",
    [
      `printf '%s\\n' ${JSON.stringify(json({ type: "system", subtype: "init" }))}`,
      `printf '%s\\n' ${JSON.stringify(
        json({
          type: "assistant",
          parent_tool_use_id: null,
          message: { content: [{ type: "text", text: "Host answer." }] },
        }),
      )}`,
      `printf '%s\\n' ${JSON.stringify(json({ type: "result", subtype: "success", is_error: false }))}`,
    ].join("\n"),
  );
  const runner = runnerFor("claude", f.env, f.cwd);
  const run = await runner.start({
    task: "Answer",
    systemPrompt: SYSTEM_PROMPT,
    workspace: WORKSPACE,
    tools: [],
    signal: new AbortController().signal,
  });
  const events = await collect(run);
  assert.deepEqual(
    events.map((event) => event.type),
    ["status", "status", "assistant-message", "terminal"],
  );
  assert.equal(terminal(events).status, "completed");
});

test("a host tool event is reported and forces an unproven outcome", async (t) => {
  const f = await fixture(t);
  await f.script(
    "prime-agent",
    [
      `printf '%s\\n' ${JSON.stringify(json({ type: "tool_execution_start", toolName: "bash" }))}`,
      `printf '%s\\n' ${JSON.stringify(
        json({
          type: "message_end",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "Done." }],
            stopReason: "end_turn",
          },
        }),
      )}`,
    ].join("\n"),
  );
  const runner = runnerFor("prime-agent", f.env, f.cwd);
  const run = await runner.start({
    task: "Run a tool",
    systemPrompt: SYSTEM_PROMPT,
    workspace: WORKSPACE,
    tools: [],
    signal: new AbortController().signal,
  });
  const events = await collect(run);
  const statusMessage = events.find(
    (event) => event.type === "status" && event.message?.includes("Host tool started"),
  );
  assert.ok(statusMessage, "the tool event must be reported");
  const end = terminal(events);
  assert.equal(end.status, "unknown");
  assert.match(String(end.message), /unproven/);
});

test("a host error maps to a failed terminal without host stderr", async (t) => {
  const f = await fixture(t);
  const secret = "sk-ant-fixture-never-echo";
  await f.script(
    "prime-agent",
    [
      `printf '%s\\n' ${JSON.stringify(
        json({
          type: "message_end",
          message: {
            role: "assistant",
            content: [],
            stopReason: "error",
            errorMessage: secret,
          },
        }),
      )}`,
      `printf '%s\\n' '${secret}' 1>&2`,
      "exit 1",
    ].join("\n"),
  );
  const runner = runnerFor("prime-agent", f.env, f.cwd);
  const run = await runner.start({
    task: "Fail",
    systemPrompt: SYSTEM_PROMPT,
    workspace: WORKSPACE,
    tools: [],
    signal: new AbortController().signal,
  });
  const events = await collect(run);
  assert.equal(terminal(events).status, "failed");
  assert.ok(!JSON.stringify(events).includes(secret), "host stderr must never be echoed");
});

test("an unmappable host event stops the run with its exact type", async (t) => {
  const f = await fixture(t);
  await f.script(
    "prime-agent",
    `printf '%s\\n' ${JSON.stringify(json({ type: "permission_request", toolName: "bash" }))}`,
  );
  const runner = runnerFor("prime-agent", f.env, f.cwd);
  const run = await runner.start({
    task: "Ask permission",
    systemPrompt: SYSTEM_PROMPT,
    workspace: WORKSPACE,
    tools: [],
    signal: new AbortController().signal,
  });
  const events = await collect(run);
  const end = terminal(events);
  assert.equal(end.status, "failed");
  assert.match(String(end.message), /permission_request/);
});

test("a host run that exceeds its wall clock reports an unproven outcome", async (t) => {
  const f = await fixture(t);
  await f.script("prime-agent", "exec sleep 10");
  const runner = runnerFor("prime-agent", f.env, f.cwd, {
    timeoutMs: HOST_CLI_LIMITS.timeoutMs.min,
  });
  const run = await runner.start({
    task: "Wait",
    systemPrompt: SYSTEM_PROMPT,
    workspace: WORKSPACE,
    tools: [],
    signal: new AbortController().signal,
  });
  const events = await collect(run);
  assert.equal(terminal(events).status, "unknown");
  assert.match(String(terminal(events).message), /exceeded/);
});

test("cancel aborts the host and confirms the cancelled terminal", async (t) => {
  const f = await fixture(t);
  await f.script("prime-agent", "exec sleep 10");
  const runner = runnerFor("prime-agent", f.env, f.cwd);
  const run = await runner.start({
    task: "Wait",
    systemPrompt: SYSTEM_PROMPT,
    workspace: WORKSPACE,
    tools: [],
    signal: new AbortController().signal,
  });
  const eventsPromise = collect(run);
  const result = await runner.cancel(run.id);
  const events = await eventsPromise;
  assert.equal(result, "confirmed");
  assert.equal(terminal(events).status, "cancelled");
});

test("an abort signal cancels the run without a separate cancel call", async (t) => {
  const f = await fixture(t);
  await f.script("prime-agent", "exec sleep 10");
  const controller = new AbortController();
  const runner = runnerFor("prime-agent", f.env, f.cwd);
  const run = await runner.start({
    task: "Wait",
    systemPrompt: SYSTEM_PROMPT,
    workspace: WORKSPACE,
    tools: [],
    signal: controller.signal,
  });
  const eventsPromise = collect(run);
  controller.abort();
  const events = await eventsPromise;
  assert.equal(terminal(events).status, "cancelled");
});

test("a missing host executable is refused before a run starts", async (t) => {
  const f = await fixture(t);
  const runner = runnerFor("prime-agent", { ...f.env, PATH: join(f.root, "empty") }, f.cwd);
  await assert.rejects(
    runner.start({
      task: "Hello",
      systemPrompt: SYSTEM_PROMPT,
      workspace: WORKSPACE,
      tools: [],
      signal: new AbortController().signal,
    }),
    /not found on PATH/,
  );
});

test("NOMO tools are refused because the host cannot mediate them", async (t) => {
  const f = await fixture(t);
  await f.script("prime-agent", "exit 0");
  const runner = runnerFor("prime-agent", f.env, f.cwd);
  await assert.rejects(
    runner.start({
      task: "Hello",
      systemPrompt: SYSTEM_PROMPT,
      workspace: WORKSPACE,
      tools: [
        {
          name: "workspace.read",
          inputSchema: { type: "object", properties: {} },
        },
      ],
      signal: new AbortController().signal,
    }),
    /cannot mediate NOMO tools/,
  );
});

test("a run forwards no provider key and reads no auth file", async (t) => {
  const f = await fixture(t);
  const secret = "sk-ant-fixture-auth-file";
  await mkdir(join(f.home, ".prime", "agent"), { recursive: true });
  await writeFile(join(f.home, ".prime", "agent", "auth.json"), JSON.stringify({ token: secret }));
  await f.script(
    "prime-agent",
    [
      "env > \"$HOME/child-env.txt\"",
      `printf '%s\\n' ${JSON.stringify(
        json({
          type: "message_end",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "Ready." }],
            stopReason: "end_turn",
          },
        }),
      )}`,
    ].join("\n"),
  );
  const runner = runnerFor(
    "prime-agent",
    {
      ...f.env,
      ANTHROPIC_API_KEY: "sk-ant-fixture-provider",
      OPENAI_API_KEY: "sk-fixture-provider",
      NOMO_WORKSPACE_KEY: "fixture-nomo-key",
    },
    f.cwd,
  );
  const run = await runner.start({
    task: "Check the environment",
    systemPrompt: SYSTEM_PROMPT,
    workspace: WORKSPACE,
    tools: [],
    signal: new AbortController().signal,
  });
  const events = await collect(run);
  assert.equal(terminal(events).status, "completed");
  const childEnv = await readFile(join(f.home, "child-env.txt"), "utf8");
  assert.ok(childEnv.includes("HOME="), "the fixture must capture the child environment");
  assert.ok(!childEnv.includes("sk-ant-fixture-provider"));
  assert.ok(!childEnv.includes("sk-fixture-provider"));
  assert.ok(!childEnv.includes("fixture-nomo-key"));
  assert.ok(!JSON.stringify(events).includes(secret));
  assert.ok(!childEnv.includes(secret));
});

test("host discovery reports the prime catalog without account data", async (t) => {
  const f = await fixture(t);
  await f.script(
    "prime-agent",
    `printf '%s\\n' 'provider model context' 'openai-codex gpt-5.4 272K'`,
  );
  resetHostCliProbeCache();
  const probe = await probeHostCli("prime-agent", f.env);
  assert.deepEqual(probe, { host: "prime-agent", available: true });
  assert.ok(!JSON.stringify(probe).includes("gpt-5.4"));

  const missing = await probeHostCli("prime-agent", { ...f.env, PATH: join(f.root, "empty") });
  assert.equal(missing.reason, "host-not-installed");
});

test("host discovery reports a prime provider the catalog does not list", async (t) => {
  const f = await fixture(t);
  await f.script("prime-agent", `printf '%s\\n' 'provider model' 'openai gpt-5'`);
  resetHostCliProbeCache();
  const probe = await probeHostCli("prime-agent", f.env);
  assert.equal(probe.available, false);
  assert.equal(probe.reason, "host-provider-unavailable");
});

test("host discovery reads the claude login state without printing it", async (t) => {
  const f = await fixture(t);
  await f.script(
    "claude",
    [
      'if [ "$1" = "--version" ]; then printf "%s\\n" "2.1.293 (Claude Code)"; exit 0; fi',
      'printf "%s\\n" \'{"loggedIn":true,"authMethod":"oauth_token"}\'',
    ].join("\n"),
  );
  resetHostCliProbeCache();
  const loggedIn = await probeHostCli("claude", f.env);
  assert.deepEqual(loggedIn, { host: "claude", available: true });

  await f.script(
    "claude",
    [
      'if [ "$1" = "--version" ]; then printf "%s\\n" "2.1.293 (Claude Code)"; exit 0; fi',
      'printf "%s\\n" \'{"loggedIn":false}\'',
    ].join("\n"),
  );
  resetHostCliProbeCache();
  const loggedOut = await probeHostCli("claude", f.env);
  assert.equal(loggedOut.reason, "host-login-required");

  await f.script(
    "claude",
    [
      'if [ "$1" = "--version" ]; then printf "%s\\n" "2.1.293 (Claude Code)"; exit 0; fi',
      'printf "%s\\n" \'{"loggedIn":true,"authMethod":"api_key","apiKeySource":"ANTHROPIC_API_KEY"}\'',
    ].join("\n"),
  );
  resetHostCliProbeCache();
  const apiKeyOnly = await probeHostCli("claude", f.env);
  assert.equal(apiKeyOnly.reason, "host-api-key-only");
  assert.ok(!JSON.stringify(apiKeyOnly).includes("api_key"));
});

test("host discovery fails closed when the claude status is unreadable", async (t) => {
  const f = await fixture(t);
  await f.script(
    "claude",
    [
      'if [ "$1" = "--version" ]; then printf "%s\\n" "2.1.293 (Claude Code)"; exit 0; fi',
      "exit 1",
    ].join("\n"),
  );
  resetHostCliProbeCache();
  const probe = await probeHostCli("claude", f.env);
  assert.equal(probe.available, false);
  assert.equal(probe.reason, "host-login-unknown");
});

test("the binary resolver only accepts absolute PATH entries", async (t) => {
  const f = await fixture(t);
  const script = await f.script("prime-agent", "exit 0");
  assert.equal(await resolveHostBinary("prime-agent", { PATH: f.bin }), script);
  assert.equal(await resolveHostBinary("prime-agent", { PATH: "bin" }), undefined);
  assert.equal(await resolveHostBinary("missing-host", { PATH: f.bin }), undefined);
});

test("host source ids stay stable for discovery and /connect", () => {
  assert.deepEqual(
    HOST_CLI_PROVIDERS.map((provider) => provider.sourceId),
    ["prime:openai-codex", "claude:claude-code"],
  );
});

test("the parser ignores forward compatible informational events", () => {
  assert.deepEqual(parseHostCliLine("prime-agent", json({ type: "usage_update" })), {
    kind: "ignored",
  });
  assert.deepEqual(parseHostCliLine("claude", json({ type: "system", subtype: "init" })), {
    kind: "ignored",
  });
  assert.deepEqual(parseHostCliLine("claude", "not json"), {
    kind: "unmappable",
    reason: "malformed-json",
  });
});

const smokeHost = process.env.NOMO_HOST_CLI_SMOKE;
const smoke = smokeHost === "prime-agent" || smokeHost === "claude" ? test : test.skip;

smoke("opt-in local smoke run through the installed host", async () => {
  const host = smokeHost as HostCliId;
  const runner = new HostCliRunner({ host });
  const run = await runner.start({
    task: "Reply with the single word: ready",
    systemPrompt: "Answer with one word and no tools.",
    workspace: WORKSPACE,
    tools: [],
    signal: new AbortController().signal,
  });
  const events = await collect(run);
  assert.ok(events.length > 0);
  console.log(`host smoke ${host}: ${events.map((event) => event.type).join(",")}`);
  assert.equal(terminal(events).status, "completed");
});

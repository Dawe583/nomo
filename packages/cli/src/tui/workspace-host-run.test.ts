/**
 * The TUI host subscription path.
 *
 * `/connect <host source>` registers the installed host as a Workbench host
 * runner, a prompt becomes a real hostOnly session with a transcript and a
 * signed ledger record, and `/stop` routes through `workbench.stopRun`. A fake
 * host executable on PATH keeps the test free of any installed host, login or
 * network.
 */
import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Workbench } from "../../../workbench/src/index.ts";
import { assertIsolated } from "../../../workbench/src/test-fixture.ts";
import { resetHostCliProbeCache } from "../../../workbench/src/agent-runners/host-cli.ts";
import { WorkspaceTui, renderWorkspace } from "./workspace.ts";

const SOURCE_ID = "prime:openai-codex";

function json(value: unknown): string {
  return JSON.stringify(value);
}

const MESSAGE_END = json({
  type: "message_end",
  message: {
    role: "assistant",
    content: [{ type: "text", text: "Hello from the host." }],
    stopReason: "end_turn",
  },
});

const PROBE = 'if [ "$1" = "model" ]; then printf \'%s\\n\' \'provider model context\' \'openai-codex gpt-5.4 272K\'; exit 0; fi';

async function fixture(t: test.TestContext) {
  const root = await mkdtemp(join(tmpdir(), "nomo-tui-host-run-"));
  const bin = join(root, "bin");
  const home = join(root, "home");
  await mkdir(bin, { recursive: true });
  await mkdir(home, { recursive: true });
  const env = {
    NOMO_DATA_DIR: root,
    PATH: `${bin}:/usr/bin:/bin:/usr/sbin:/sbin`,
    HOME: home,
    TMPDIR: root,
  } as NodeJS.ProcessEnv;
  const app = new Workbench(env);
  assertIsolated(root, env);
  const ui = new WorkspaceTui(app, env);
  await ui.initialize();
  t.after(async () => {
    await app.shutdown();
    await rm(root, { recursive: true, force: true });
  });
  const script = async (body: string) => {
    const path = join(bin, "prime-agent");
    await writeFile(path, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
    await chmod(path, 0o755);
  };
  resetHostCliProbeCache();
  return { root, bin, home, env, app, ui, script };
}

async function waitFor(
  predicate: () => boolean,
  label: string,
  timeoutMs = 10_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out waiting for ${label}.`);
}

function ledgerTools(
  entries: readonly { body: unknown }[] | undefined,
): string[] {
  return (entries ?? []).map(
    (entry) => String((entry.body as Record<string, unknown>).tool),
  );
}

test("/connect registers the host runner and a prompt becomes a hostOnly session", async (t) => {
  const f = await fixture(t);
  await f.script(
    [PROBE, `printf '%s\\n' ${JSON.stringify(MESSAGE_END)}`].join("\n"),
  );

  await f.ui.command(`/connect ${SOURCE_ID}`);
  assert.equal(f.ui.hostSubscription?.sourceId, SOURCE_ID);
  assert.equal(f.ui.hostSubscription?.host, "prime-agent");
  // The screen owns a selection, not a runner: the runner lives in Workbench.
  assert.equal(
    Object.hasOwn(f.ui.hostSubscription ?? {}, "runner"),
    false,
    "the TUI must not own a private host runner",
  );
  // The mediated catalog stays mediated-only.
  assert.deepEqual(f.app.agentRunnerCatalog(), []);

  await f.ui.command("Say hello");
  await waitFor(() => f.app.list().length === 1, "the host session");
  const [session] = f.app.list();
  assert.ok(session);
  assert.equal(session.hostOnly, true);
  assert.equal(session.title, `Host run: ${SOURCE_ID}`);
  assert.equal(session.model, "host-prime-agent/host");
  await waitFor(
    () => f.app.get(session.id)?.status !== "running",
    "the host run to settle",
  );
  await f.app.settled();
  await f.ui.refresh();

  const settled = f.app.get(session.id);
  assert.equal(settled?.status, "idle");
  // The transcript the screen renders is the session's own events.
  const assistant = settled?.events.find(
    (event) => event.kind === "assistant" && event.type === "message.completed",
  );
  assert.equal(assistant?.text, "Hello from the host.");
  assert.equal(f.ui.sessionId, session.id);
  const frame = renderWorkspace(f.ui, 80, 24);
  assert.ok(
    frame.includes("Hello from the host."),
    "the chat panel renders the host answer from the session events",
  );
  assert.doesNotMatch(
    frame,
    /NOMO writes no Workbench transcript or ledger entry/,
    "the removed no-transcript claim must not return",
  );

  const ledger = await f.app.ledger(session.workspace);
  assert.equal(ledger?.result.ok, true);
  const tools = ledgerTools(ledger?.entries);
  assert.ok(tools.includes("host_runner.start"));
  assert.ok(tools.includes("host_runner.terminal"));
  assert.equal(
    tools.some((tool) => tool.startsWith("agent_runner.")),
    false,
    "the TUI must not start a mediated agent run",
  );
});

test("/stop routes the host run through workbench.stopRun", async (t) => {
  const f = await fixture(t);
  await f.script([PROBE, "exec sleep 10"].join("\n"));

  await f.ui.command(`/connect ${SOURCE_ID}`);
  await f.ui.command("Wait");
  await waitFor(() => f.app.list().length === 1, "the host session");
  const [session] = f.app.list();
  assert.ok(session);
  // The prompt opens the session in the screen, so /stop has a target.
  await waitFor(() => f.ui.sessionId === session.id, "the screen to select it");
  await waitFor(
    () => f.app.get(session.id)?.status === "running",
    "the host run to start",
  );

  await f.ui.command("/stop");
  assert.match(f.ui.notice, /Host stop requested/);
  await f.app.settled();
  await f.ui.refresh();

  const settled = f.app.get(session.id);
  assert.notEqual(settled?.status, "running");
  assert.ok(
    settled?.status === "cancelled" || settled?.status === "unknown",
    "a stopped host run ends cancelled or explicitly unproven",
  );
  const ledger = await f.app.ledger(session.workspace);
  assert.equal(ledger?.result.ok, true);
  assert.ok(ledgerTools(ledger?.entries).includes("host_runner.cancel"));
});

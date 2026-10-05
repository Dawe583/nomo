import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Workbench } from "../../../workbench/src/index.ts";
import { WorkspaceTui } from "./workspace.ts";

/**
 * The ledger tab carries more than the chain: which harness is the default,
 * which agent profile new conversations get, and which hooks are wired.
 * The rows are the chain's producer, printed where the chain is printed.
 */

const assistantFetcher = (content: string) => async (url: unknown) => {
  if (String(url).endsWith("/models"))
    return Response.json({ data: [{ id: "fixture" }] });
  return Response.json({
    choices: [{ message: { role: "assistant", content } }],
  });
};

async function ledgerRows(t: {
  after(fn: () => Promise<void>): void;
}, hookCommands: string[] = ["echo done"]): Promise<{
  ui: WorkspaceTui;
  app: Workbench;
}> {
  const root = await mkdtemp(join(tmpdir(), "void-tui-harness-rows-"));
  const env = {
    VOID_DATA_DIR: root,
    VOID_HOOK_COMMANDS: JSON.stringify(hookCommands),
  };
  const app = new Workbench(env, assistantFetcher("ok"));
  await app.configure({
    baseUrl: "https://fixture.test/v1",
    apiKey: "fixture-key",
  });
  t.after(async () => {
    await app.shutdown();
    await rm(root, { recursive: true, force: true });
  });
  const ui = new WorkspaceTui(app, env);
  await ui.initialize();
  ui.choose("ledger");
  return { ui, app };
}

type Row = { id: string; label: string; lines: string[] };

const rowsOf = (ui: WorkspaceTui): Row[] => ui.items() as unknown as Row[];

test("the tab names the harness default and the selected profile", async (t) => {
  const { ui, app } = await ledgerRows(t);
  app.patchPreferences({ defaultAgent: "prime-agent" });

  const row = rowsOf(ui).find((r) => r.id === "harness:current");
  assert.ok(row, "no harness row on the ledger tab");
  assert.match(row.label, /harness prime-agent/);
  assert.match(
    row.lines.join("\n"),
    /Default for new conversations: prime-agent\./,
  );
  assert.match(
    row.lines.join("\n"),
    /Selected agent profile: runtime default\./,
  );
});

test("a saved hook gets its own row, and none means an explicit row", async (t) => {
  const { ui, app } = await ledgerRows(t);

  // Before any hook is saved, the tab says so instead of showing nothing.
  const empty = rowsOf(ui).find((r) => r.id === "hook:none");
  assert.ok(empty, "no row for the zero-hook case");

  app.upsertHook({
    id: "audit",
    event: "after-tool",
    command: "echo done",
    enabled: true,
  });
  const row = rowsOf(ui).find((r) => r.id === "hook:audit");
  assert.ok(row, "the saved hook never surfaced as a row");
  assert.match(row.label, /hook audit on/);
  assert.match(row.lines.join("\n"), /Event: after-tool\./);
  assert.match(row.lines.join("\n"), /Command: echo done/);

  // The disabled state is visible, not only on or off by omission.
  app.upsertHook({
    id: "audit",
    event: "after-tool",
    command: "echo done",
    enabled: false,
  });
  const off = rowsOf(ui).find((r) => r.id === "hook:audit");
  assert.ok(off, "the saved hook lost its row after a toggle");
  assert.match(off.label, /hook audit off/);
});

test("Enter on a ledger hook row toggles it and names the new state", async (t) => {
  const { ui, app } = await ledgerRows(t);
  app.upsertHook({
    id: "audit",
    event: "after-tool",
    command: "echo done",
    enabled: true,
  });

  const index = rowsOf(ui).findIndex((r) => r.id === "hook:audit");
  assert.ok(index >= 0, "no hook row to select");
  ui.selected = index;
  // The keypress path: return runs ui.openSelected().
  await ui.openSelected();

  const off = rowsOf(ui).find((r) => r.id === "hook:audit");
  assert.ok(off, "the hook row disappeared after the toggle");
  assert.match(off.label, /hook audit off/);
  assert.match(ui.notice, /Hook audit is now off/);

  // Toggling again flips it back on.
  const again = rowsOf(ui).findIndex((r) => r.id === "hook:audit");
  ui.selected = again;
  await ui.openSelected();
  const on = rowsOf(ui).find((r) => r.id === "hook:audit");
  assert.match(on!.label, /hook audit on/);
  assert.match(ui.notice, /Hook audit is now on/);
});

test("a hook command with credentials is redacted, and a plain one still renders", async (t) => {
  const secret =
    'curl -H "Authorization: Bearer sekret-123" --token=abc --key=def https://api.test/hook';
  const { ui, app } = await ledgerRows(t, [secret, "echo done"]);

  app.upsertHook({
    id: "ship",
    event: "after-tool",
    command: secret,
    enabled: true,
  });
  const row = rowsOf(ui).find((r) => r.id === "hook:ship");
  assert.ok(row, "the saved hook never surfaced as a row");
  const body = row.lines.join("\n");
  assert.doesNotMatch(body, /sekret-123/);
  assert.doesNotMatch(body, /abc/);
  assert.doesNotMatch(body, /--key=def/);
  assert.match(body, /\[redacted\]/);
  assert.match(body, /Command: curl /);

  app.upsertHook({
    id: "plain",
    event: "after-tool",
    command: "echo done",
    enabled: true,
  });
  const plain = rowsOf(ui).find((r) => r.id === "hook:plain");
  assert.ok(plain, "the plain hook never surfaced as a row");
  assert.match(plain.lines.join("\n"), /Command: echo done/);
});

test("a long hook command is bounded, with a marker saying it was cut", async (t) => {
  const long = `echo ${"x".repeat(400)}`;
  const { ui, app } = await ledgerRows(t, [long]);

  app.upsertHook({ id: "long", event: "after-tool", command: long, enabled: true });
  const row = rowsOf(ui).find((r) => r.id === "hook:long");
  assert.ok(row, "the saved hook never surfaced as a row");
  const commandLine = row.lines.find((line) => line.startsWith("Command: "));
  assert.ok(commandLine, "no command line rendered");
  assert.match(commandLine, /… \(\+\d+ chars\)/);
  assert.ok(
    commandLine.length <= "Command: ".length + 160 + 20,
    `command line not bounded: ${commandLine.length}`,
  );
});

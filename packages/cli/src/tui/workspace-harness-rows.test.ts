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
}): Promise<{ ui: WorkspaceTui; app: Workbench }> {
  const root = await mkdtemp(join(tmpdir(), "void-tui-harness-rows-"));
  const env = {
    VOID_DATA_DIR: root,
    VOID_HOOK_COMMANDS: JSON.stringify(["echo done"]),
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

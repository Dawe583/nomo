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
    choices: [{ message: { role: "assistant", content }, finish_reason: "stop" }],
  });
};

async function ledgerRows(
  t: {
    after(fn: () => Promise<void>): void;
  },
  hookCommands: string[] = ["echo done"],
): Promise<{
  ui: WorkspaceTui;
  app: Workbench;
}> {
  const root = await mkdtemp(join(tmpdir(), "nomo-tui-harness-rows-"));
  const env = {
    NOMO_DATA_DIR: root,
    NOMO_HOOK_COMMANDS: JSON.stringify(hookCommands),
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

test("every selectable agent gets a row, and the selected one is marked", async (t) => {
  const { ui } = await ledgerRows(t);

  // Presets always exist, so the panel is never an empty list.
  const preset = rowsOf(ui).find((r) => r.id === "agent:default");
  assert.ok(preset, "no row for the default preset");
  assert.match(preset.label, /^◆ agent default$/);
  assert.match(preset.lines.join("\n"), /Preset default: NOMO default\./);

  ui.agentId = "planner";
  const marked = rowsOf(ui).find((r) => r.id === "agent:planner");
  assert.ok(marked, "no row for the planner preset");
  assert.match(marked.label, /\[selected\]$/);
  assert.match(marked.lines.join("\n"), /Selected for new conversations\./);
});

test("Enter on an agent row selects it, and Enter again returns to the runtime default", async (t) => {
  const { ui } = await ledgerRows(t);

  const index = rowsOf(ui).findIndex((r) => r.id === "agent:planner");
  assert.ok(index >= 0, "no agent row to select");
  ui.selected = index;
  await ui.openSelected();

  assert.equal(ui.agentId, "planner");
  assert.match(
    ui.notice,
    /Agent profile planner selected for new conversations\./,
  );
  // The harness row and the row label now agree with the selection.
  const harness = rowsOf(ui).find((r) => r.id === "harness:current");
  assert.match(harness!.lines.join("\n"), /Selected agent profile: planner\./);
  assert.match(
    rowsOf(ui).find((r) => r.id === "agent:planner")!.label,
    /\[selected\]/,
  );

  ui.selected = rowsOf(ui).findIndex((r) => r.id === "agent:planner");
  await ui.openSelected();
  assert.equal(ui.agentId, undefined);
  assert.match(
    ui.notice,
    /Agent profile cleared\. New conversations use the runtime default\./,
  );
  assert.doesNotMatch(
    rowsOf(ui).find((r) => r.id === "agent:planner")!.label,
    /selected/,
  );
});

test("a saved profile row shows the full panel, with the system prompt bounded", async (t) => {
  const { ui, app } = await ledgerRows(t);
  app.upsertAgent({
    id: "auditor-custom",
    name: "Custom auditor",
    systemPrompt: "x".repeat(300),
    allowedTools: ["void_workspace_list"],
    policyProfile: "default",
    maxTurns: 5,
    maxContextTokens: 8192,
  });

  const row = rowsOf(ui).find((r) => r.id === "agent:auditor-custom");
  assert.ok(row, "the saved profile never surfaced as a row");
  const body = row.lines.join("\n");
  assert.match(
    body,
    /Profile auditor-custom: policy default, max turns 5, max context tokens 8192/,
  );
  assert.match(body, /Allowed tools: void_workspace_list/);
  assert.match(body, /System prompt: x{160}… \(\+140 chars\)/);
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

  app.upsertHook({
    id: "long",
    event: "after-tool",
    command: long,
    enabled: true,
  });
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

test("the ledger has an honest harness score row when no samples exist", async (t) => {
  const { ui } = await ledgerRows(t);
  const row = rowsOf(ui).find((r) => r.id === "harness:scores");
  assert.ok(row, "no harness score row on the ledger tab");
  assert.match(row.label, /harness score/);
  assert.match(row.lines.join("\n"), /insufficient-data/);
  assert.match(row.lines.join("\n"), /0 cases/);
  assert.match(row.lines.join("\n"), /CI: unavailable/);
});

test("/harness scores reports the verified sample count and CI without authority", async (t) => {
  const { ui } = await ledgerRows(t);
  await ui.command("/harness scores");
  const output = (ui.detail ?? []).join("\n");
  assert.match(output, /HARNESS SCORES, verdict: insufficient-data/);
  assert.match(output, /95% CI: unavailable/);
  assert.match(output, /Sample count: 0 first-pass samples/);
  assert.match(output, /Case count: 0 verified tool-call cases/);
  assert.match(output, /never changes a decision or permission/);
});

test("score sampling deduplicates sessions that share one verified workspace chain", async (t) => {
  const { ui, app } = await ledgerRows(t);
  const session = await app.start("Score fixture", "fixture");
  await app.settled();
  await app.editDocument(session.id, {
    path: "score.md",
    content: "one verified decision",
    expectedRevision: null,
  });
  await ui.refresh();
  const proof = await app.ledger(session.workspace);
  assert.ok(proof);
  // A second session viewing the same chain is not an independent case.
  ui.proofs.set("same-workspace-second-session", [...proof.entries]);
  ui.proofs.set("refinement-only", [{
    workspace: "refinement-only",
    seq: 1,
    body: { tool: "harness.refinement", decision: "refinement:applied" },
    prev_hash: "",
    hash: "",
    key_id: "",
    alg: "",
    signature: "",
  }]);
  const row = rowsOf(ui).find((r) => r.id === "harness:scores");
  assert.ok(row);
  assert.match(row.lines.join("\n"), /1 case/);
  assert.match(row.lines.join("\n"), /95% CI: unavailable/);
});

test("the score row prints the reason the verdict is what it is", async (t) => {
  // "flat" is a sentence, not a grade: without the reason it reads as
  // "measured and unchanged", which is the one thing this row is forbidden
  // to claim. The reason is what tells the operator nothing was compared.
  const { ui } = await ledgerRows(t);
  const row = rowsOf(ui).find((r) => r.id === "harness:scores");
  assert.ok(row);
  assert.match(row.lines.join("\n"), /Reason: no decided call in the chain/);
});

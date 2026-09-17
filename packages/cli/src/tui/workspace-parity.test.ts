import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Workbench } from "../../../workbench/src/index.ts";
import {
  MODE_ICON,
  TAB_ICONS,
  WorkspaceTui,
  approvalLabel,
  commandSuggestions,
  extractTodos,
  isDoubleEscape,
  mentionCandidates,
  mentionToken,
  promptFrameBottom,
  promptFrameRow,
  promptFrameTop,
  renderWorkspace,
  searchHistoryPrompts,
} from "./workspace.ts";
import { WorkspaceInput, workspaceShortcut } from "./workspace-runner.ts";
import { stripAnsi, visibleLength } from "./layout.ts";

const assistantFetcher = (content: string) =>
  async (url: unknown) => {
    if (String(url).endsWith("/models"))
      return Response.json({ data: [{ id: "fixture" }] });
    return Response.json({
      choices: [{ message: { role: "assistant", content } }],
    });
  };

async function fixtureApp(
  root: string,
  content = "ok",
  env: Record<string, string> = {},
) {
  const full = { VOID_DATA_DIR: root, ...env };
  const app = new Workbench(full, assistantFetcher(content));
  await app.configure({
    baseUrl: "https://fixture.test/v1",
    apiKey: "fixture-key",
  });
  return { app, env: full };
}

test("Shift+Tab modes cycle with a visible indicator", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "void-tui-mode-"));
  const { app, env } = await fixtureApp(root);
  t.after(async () => {
    await app.shutdown();
    await rm(root, { recursive: true, force: true });
  });
  const ui = new WorkspaceTui(app, env);
  await ui.initialize();
  assert.equal(ui.mode, "normal");
  ui.cycleMode();
  assert.equal(ui.mode, "accept");
  ui.cycleMode();
  assert.equal(ui.mode, "plan");
  ui.cycleMode();
  assert.equal(ui.mode, "normal");
  ui.cycleMode();
  ui.cycleMode();
  const frame = stripAnsi(renderWorkspace(ui, 100, 32));
  assert.match(frame, /mode: plan/);
});

test("plan mode prefixes prompts so the model plans first", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "void-tui-plan-"));
  const { app, env } = await fixtureApp(root);
  t.after(async () => {
    await app.shutdown();
    await rm(root, { recursive: true, force: true });
  });
  const ui = new WorkspaceTui(app, env);
  await ui.initialize();
  ui.mode = "plan";
  await ui.command("build the thing");
  await app.settled();
  const events = app.get(ui.sessionId!)!.events;
  const sent = events.find((event) => event.kind === "user")!;
  assert.match(sent.text, /^Plan only\./);
  assert.match(sent.text, /build the thing/);
});

test("a prompt sent during a run is queued, never dropped", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "void-tui-queue-"));
  let release: ((value: Response) => void) | undefined;
  const gate = () =>
    new Promise<Response>((done) => {
      release = done;
    });
  const full = { VOID_DATA_DIR: root };
  const app = new Workbench(full, async (url: unknown) => {
    if (String(url).endsWith("/models"))
      return Response.json({ data: [{ id: "fixture" }] });
    return gate();
  });
  t.after(async () => {
    await app.shutdown();
    await rm(root, { recursive: true, force: true });
  });
  await app.configure({
    baseUrl: "https://fixture.test/v1",
    apiKey: "fixture-key",
  });
  const ui = new WorkspaceTui(app, full);
  await ui.initialize();
  await ui.command("first prompt");
  assert.equal(app.running(), true);
  await ui.command("second prompt");
  assert.equal(ui.queuedPrompt, "second prompt");
  assert.match(ui.notice, /queued/i);
  release!(
    Response.json({
      choices: [{ message: { role: "assistant", content: "done" } }],
    }),
  );
  await app.settled();
  assert.equal(ui.takeQueued(), "second prompt");
  assert.equal(ui.takeQueued(), null);
});

test("Ctrl+R maps in every editing state for history search", () => {
  assert.equal(
    workspaceShortcut({ name: "r", ctrl: true }, true, ""),
    "search-history",
  );
  assert.equal(
    workspaceShortcut({ name: "r", ctrl: true }, true, "draft"),
    "search-history",
  );
  assert.equal(workspaceShortcut({ name: "r" }, true, ""), undefined);
});

test("prompt history search is case insensitive and keeps recency", () => {
  const prompts = ["Build the plan", "fix the leak", "Build the demo"];
  assert.deepEqual(searchHistoryPrompts(prompts, ""), prompts);
  assert.deepEqual(searchHistoryPrompts(prompts, "build"), [
    "Build the plan",
    "Build the demo",
  ]);
  assert.deepEqual(searchHistoryPrompts(prompts, "LEAK"), ["fix the leak"]);
  assert.deepEqual(searchHistoryPrompts(prompts, "missing"), []);
});

test("double Escape opens checkpoints, single Escape only closes", () => {
  assert.equal(isDoubleEscape(1000, 1000), true);
  assert.equal(isDoubleEscape(1799, 1000), true);
  assert.equal(isDoubleEscape(1801, 1000), false);
  assert.equal(isDoubleEscape(1000, 0), false);
  assert.equal(isDoubleEscape(900, 1000), false);
});

test("gated shell shows output once and refuses key material", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "void-tui-shell-"));
  const full = { VOID_DATA_DIR: root, VOID_TUI_ENV_PROBE: "probe-secret" };
  const app = new Workbench(full);
  t.after(async () => {
    await app.shutdown();
    await rm(root, { recursive: true, force: true });
  });
  const ui = new WorkspaceTui(app, full);
  await ui.command("!echo parity-ok");
  assert.ok(ui.detail?.join("\n").includes("parity-ok"));
  assert.match(ui.notice, /never persisted/);
  await assert.rejects(
    ui.command("!echo $TOKENHARBOR_API_KEY"),
    /Refused/,
  );
  await assert.rejects(
    ui.command("!cat ~/.void/keys/dev-ed25519.pkcs8"),
    /Refused/,
  );
  await assert.rejects(ui.command("!printenv OPENROUTER_API_KEY"), /Refused/);
  await assert.rejects(
    ui.command("!printenv VOID_TUI_ENV_PROBE"),
    /Local command failed/,
  );
});

test("shell output redacts exact stored secret values", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "void-tui-redact-"));
  const full = {
    VOID_DATA_DIR: root,
    TOKENROUTER_API_KEY: "qk7-redact-me",
  };
  const app = new Workbench(full);
  t.after(async () => {
    await app.shutdown();
    await rm(root, { recursive: true, force: true });
  });
  const ui = new WorkspaceTui(app, full);
  await ui.command("!echo qk7-redact-me");
  const shown = ui.detail?.join("\n") ?? "";
  assert.ok(shown.includes("[redacted]"));
  assert.ok(!shown.includes("qk7-redact-me"));
});

test("@ tokens complete from managed paths and quote on send", async (t) => {
  assert.equal(mentionToken("see @pla", 8), "pla");
  assert.equal(mentionToken("see @plan.md ", 13), undefined);
  assert.equal(mentionToken("no token here", 13), undefined);
  assert.deepEqual(mentionCandidates("pl", ["plan.md", "other.md"]), [
    "plan.md",
  ]);
  assert.deepEqual(
    mentionCandidates("", ["a.md", "b.md", "c.md", "d.md", "e.md",
      "f.md", "g.md", "h.md", "i.md"]),
    ["a.md", "b.md", "c.md", "d.md", "e.md", "f.md", "g.md", "h.md"],
  );
  const root = await mkdtemp(join(tmpdir(), "void-tui-mention-"));
  const { app, env } = await fixtureApp(root);
  t.after(async () => {
    await app.shutdown();
    await rm(root, { recursive: true, force: true });
  });
  const ui = new WorkspaceTui(app, env);
  await ui.initialize();
  await ui.command("start here");
  await app.settled();
  const id = ui.sessionId!;
  await app.editDocument(
    id,
    { path: "plan.md", content: "quoted content", expectedRevision: null },
    "tui-operator",
  );
  assert.deepEqual(ui.documentPaths(), ["plan.md"]);
  const expanded = ui.expandMentions("read @plan.md please", id);
  assert.deepEqual(expanded.missing, []);
  assert.match(expanded.expanded, /quoted content/);
  const unknown = ui.expandMentions("read @ghost.md please", id);
  assert.deepEqual(unknown.missing, ["ghost.md"]);
  await assert.rejects(ui.command("read @ghost.md"), /Unknown @path/);
});

test("todos come from real agent output, /todos lists them", async (t) => {
  const direct = extractTodos([
    { seq: 1, kind: "assistant", type: "message.completed",
      text: "- [ ] step one\n- [x] done step" },
    { seq: 2, kind: "tool", type: "tool.result", text: "- [ ] not a todo" },
    { seq: 3, kind: "assistant", type: "message.delta", text: "- [ ] draft" },
  ]);
  assert.equal(direct.length, 2);
  assert.equal(direct[0]!.text, "step one");
  assert.equal(direct[0]!.done, false);
  const root = await mkdtemp(join(tmpdir(), "void-tui-todos-"));
  const { app, env } = await fixtureApp(root, "- [ ] ship it\n- [x] done");
  t.after(async () => {
    await app.shutdown();
    await rm(root, { recursive: true, force: true });
  });
  const ui = new WorkspaceTui(app, env);
  await ui.initialize();
  await ui.command("do the work");
  await app.settled();
  await ui.command("/todos");
  assert.ok(ui.detail?.join("\n").includes("ship it"));
  const frame = stripAnsi(renderWorkspace(ui, 100, 32));
  assert.match(frame, /ship it/);
});

test("/context /cost /status report retained numbers, cost stays unknown", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "void-tui-numbers-"));
  const { app, env } = await fixtureApp(root);
  t.after(async () => {
    await app.shutdown();
    await rm(root, { recursive: true, force: true });
  });
  const ui = new WorkspaceTui(app, env);
  await ui.initialize();
  await ui.command("hello");
  await app.settled();
  await ui.command("/context");
  assert.equal(ui.tab, "documents");
  assert.ok(ui.detail?.join("\n").includes("Messages:"));
  await ui.command("/cost");
  assert.equal(ui.tab, "usage");
  assert.ok(ui.detail?.join("\n").includes("Cost: unknown"));
  assert.ok(!ui.detail?.join("\n").includes("CZK"));
  await ui.command("/status");
  assert.equal(ui.tab, "overview");
  assert.ok(ui.detail?.join("\n").includes("Mode: normal"));
});

test("/compact is an explicit local fallback, never a provider claim", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "void-tui-compact-"));
  const { app, env } = await fixtureApp(root);
  t.after(async () => {
    await app.shutdown();
    await rm(root, { recursive: true, force: true });
  });
  const ui = new WorkspaceTui(app, env);
  await ui.initialize();
  await ui.command("remember this request");
  await app.settled();
  await ui.command("/compact");
  const shown = ui.detail?.join("\n") ?? "";
  assert.match(shown, /local fallback/);
  assert.match(shown, /remember this request/);
  assert.match(ui.notice, /local summary/i);
});

test("/agents /config /memory read live data without secrets", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "void-tui-agents-"));
  const { app, env } = await fixtureApp(root);
  t.after(async () => {
    await app.shutdown();
    await rm(root, { recursive: true, force: true });
  });
  const ui = new WorkspaceTui(app, env);
  await ui.initialize();
  await ui.command("agent work");
  await app.settled();
  await ui.command("/agents");
  assert.ok(ui.detail?.join("\n").includes("connector: VOID documents"));
  await ui.command("/config");
  const config = ui.detail?.join("\n") ?? "";
  assert.ok(config.includes("data-dir"));
  assert.ok(!config.includes("fixture-key"));
  await ui.command("/memory");
  assert.ok(ui.detail?.join("\n").includes("Conversations: 1"));
});

test("provider only commands reject what VOID cannot do", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "void-tui-unsupported-"));
  const full = { VOID_DATA_DIR: root };
  const app = new Workbench(full);
  t.after(async () => {
    await app.shutdown();
    await rm(root, { recursive: true, force: true });
  });
  const ui = new WorkspaceTui(app, full);
  for (const cmd of ["/hooks", "/vim", "/terminal-setup", "/output-style"])
    await assert.rejects(ui.command(cmd), /no VOID equivalent/);
});

test("/login reuses provider setup, /logout disconnects", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "void-tui-login-"));
  const full = { VOID_DATA_DIR: root };
  const app = new Workbench(full);
  t.after(async () => {
    await app.shutdown();
    await rm(root, { recursive: true, force: true });
  });
  const ui = new WorkspaceTui(app, full);
  await assert.rejects(ui.command("/login unknown-source"), /./);
  await ui.command("/logout");
  assert.match(ui.notice, /disconnected/);
  assert.equal(ui.model, "");
});

test("/init creates a starter plan when the run is idle", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "void-tui-init-"));
  const { app, env } = await fixtureApp(root);
  t.after(async () => {
    await app.shutdown();
    await rm(root, { recursive: true, force: true });
  });
  const ui = new WorkspaceTui(app, env);
  await ui.initialize();
  await ui.command("start the workspace");
  await app.settled();
  await ui.command("/init");
  assert.match(app.workspace(ui.sessionId!).files["plan.md"] ?? "", /# Plan/);
});

test("review needs an explicit accept or reject key", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "void-tui-review-"));
  const { app, env } = await fixtureApp(root);
  t.after(async () => {
    await app.shutdown();
    await rm(root, { recursive: true, force: true });
  });
  const ui = new WorkspaceTui(app, env);
  await ui.initialize();
  await ui.command("start here");
  await app.settled();
  const id = ui.sessionId!;
  await app.editDocument(
    id,
    { path: "doc.md", content: "before", expectedRevision: null },
    "tui-operator",
  );
  ui.sessionId = id;
  ui.documentPath = "doc.md";
  ui.prepareEdit(ui.editTarget(), "after");
  ui.reject();
  assert.equal(ui.confirmation, undefined);
  assert.match(ui.notice, /Rejected/);
  assert.equal(app.workspace(id).files["doc.md"], "before");
  const frame = stripAnsi(renderWorkspace(ui, 100, 32));
  assert.ok(frame.includes("Tab panels"));
});

test("prompt frame stays continuous at every width", async (t) => {
  assert.equal(visibleLength(promptFrameTop("Write a prompt", 80)), 80);
  assert.equal(visibleLength(promptFrameBottom(80)), 80);
  assert.equal(visibleLength(promptFrameRow("> hello_", 80)), 80);
  assert.ok(promptFrameTop("Write a prompt", 20).startsWith("╭"));
  assert.ok(promptFrameTop("Write a prompt", 20).endsWith("╮"));
  const root = await mkdtemp(join(tmpdir(), "void-tui-frame-"));
  const { app, env } = await fixtureApp(root);
  t.after(async () => {
    await app.shutdown();
    await rm(root, { recursive: true, force: true });
  });
  const ui = new WorkspaceTui(app, env);
  await ui.initialize();
  for (const [width, height] of [
    [20, 8],
    [40, 12],
    [80, 24],
    [100, 32],
    [160, 45],
  ]) {
    const frame = stripAnsi(
      renderWorkspace(ui, width!, height!, "hello_", true, false, {
        cursor: 6,
      }),
    );
    const rows = frame.split("\n");
    assert.equal(rows.length, height);
    assert.ok(rows.every((line) => visibleLength(line) <= width!));
    const top = rows.find((line) => line.startsWith("╭"))!;
    const bottom = rows.find((line) => line.startsWith("╰"))!;
    assert.ok(top.endsWith("╮"), top);
    assert.ok(bottom.endsWith("╯"), bottom);
    assert.equal(visibleLength(top), width);
    assert.equal(visibleLength(bottom), width);
    const promptRows = rows.filter((line) => line.startsWith("│"));
    assert.ok(promptRows.length > 0);
    for (const row of promptRows) {
      assert.ok(row.endsWith("│"), row);
      assert.equal(visibleLength(row), width);
    }
  }
});

test("icons stay one cell wide and never carry safety meaning", () => {
  for (const icon of [...Object.values(TAB_ICONS), ...Object.values(MODE_ICON)])
    assert.equal(visibleLength(icon), 1, icon);
  assert.equal(TAB_ICONS.chat, "●");
  assert.equal(MODE_ICON.plan, "○");
});

test("newline keys match the reference terminal", () => {
  const input = new WorkspaceInput();
  input.editing = true;
  assert.equal(input.key(undefined, { name: "j", ctrl: true }), undefined);
  assert.equal(input.value, "\n");
  input.set("ab");
  assert.equal(input.key(undefined, { name: "enter", shift: true }), undefined);
  assert.equal(input.value, "ab\n");
  input.set("cd");
  assert.equal(input.key(undefined, { name: "enter", meta: true }), undefined);
  assert.equal(input.value, "cd\n");
  input.set("trail\\");
  assert.equal(input.key("\r", { name: "return" }), undefined);
  assert.equal(input.value, "trail\n");
  input.set("send me");
  assert.equal(input.key("\r", { name: "return" }), "submit");
});

test("kill ring and input undo cover the editing keys", () => {
  const input = new WorkspaceInput();
  input.editing = true;
  input.set("hello world");
  input.cursor = 11;
  input.key(undefined, { name: "w", ctrl: true });
  assert.equal(input.value, "hello ");
  input.key(undefined, { name: "y", ctrl: true });
  assert.equal(input.value, "hello world");
  input.set("abcdef");
  input.cursor = 3;
  assert.equal(input.key(undefined, { name: "d", ctrl: true }), undefined);
  assert.equal(input.value, "abcef");
  input.key(undefined, { name: "_", ctrl: true });
  assert.equal(input.value, "abcdef");
  input.set("src/utils/foo.ts");
  input.cursor = 16;
  input.key(undefined, { name: "b", meta: true });
  assert.equal(input.cursor, 14);
  input.key(undefined, { name: "f", meta: true });
  assert.equal(input.cursor, 16);
  input.cursor = 4;
  input.key(undefined, { name: "d", meta: true });
  assert.equal(input.value, "src/utils/foo.ts".replace("utils", ""));
});

test("stash, editor and quit map only the intended control keys", () => {
  assert.equal(workspaceShortcut({ name: "s", ctrl: true }, true, "draft"), "stash");
  assert.equal(workspaceShortcut({ name: "s", ctrl: true }, false, ""), "stash");
  assert.equal(
    workspaceShortcut({ name: "g", ctrl: true }, true, "draft"),
    "external-editor",
  );
  assert.equal(workspaceShortcut({ name: "s" }, true, "draft"), undefined);
  assert.equal(workspaceShortcut({ name: "g" }, true, "draft"), undefined);
});

test("approval rows carry class, radius and the matched case", () => {
  assert.equal(
    approvalLabel({
      holdId: "abc123",
      status: "pending",
      call: { tool: "stripe.refund.create", klass: "r2", reason: "Money moves." },
    }),
    "[pending] [R2] stripe.refund.create abc123 radius unknown Money moves.",
  );
  assert.equal(
    approvalLabel({
      holdId: "abc123",
      status: "approved",
      call: { tool: "db.row.delete", klass: "r3", blastRadius: 3 },
    }),
    "[approved] [R3] db.row.delete abc123 radius 3",
  );
  assert.equal(
    approvalLabel({ holdId: "abc123", status: "pending", call: { tool: "x" } }),
    "[pending] x abc123 radius unknown",
  );
});

test("undo review states the drift check before the diff", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "void-tui-undo-drift-"));
  const { app, env } = await fixtureApp(root);
  t.after(async () => {
    await app.shutdown();
    await rm(root, { recursive: true, force: true });
  });
  const ui = new WorkspaceTui(app, env);
  await ui.initialize();
  await ui.command("start here");
  await app.settled();
  const id = ui.sessionId!;
  await app.editDocument(
    id,
    { path: "doc.md", content: "before", expectedRevision: null },
    "tui-operator",
  );
  ui.sessionId = id;
  ui.documentPath = "doc.md";
  await ui.prepareUndo();
  assert.equal(ui.confirmation?.title, "UNDO doc.md?");
  assert.ok(ui.confirmation?.lines.join("\n").includes("Drift check passed"));
});

test("/conformance proves the adapter behind TUI edits inside the TUI", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "void-tui-conformance-"));
  const full = { VOID_DATA_DIR: root };
  const app = new Workbench(full);
  t.after(async () => {
    await app.shutdown();
    await rm(root, { recursive: true, force: true });
  });
  const ui = new WorkspaceTui(app, full);
  await ui.command("/conformance");
  assert.match(ui.detail?.[0] ?? "", /conformance managed-documents exit 0/);
  assert.match(ui.detail?.join("\n") ?? "", /write: PASS/);
  assert.match(ui.detail?.join("\n") ?? "", /human-drift/);
  assert.match(ui.notice, /passed/);
  await assert.rejects(ui.command("/conformance unknown"), /managed-documents/);
  assert.ok(
    commandSuggestions("/conf").some(([name]) => name === "/conformance"),
  );
});

test("new commands complete from a slash prefix", () => {
  for (const cmd of [
    "/compact",
    "/login",
    "/logout",
    "/todos",
    "/agents",
    "/config",
    "/memory",
    "/model",
    "/export",
  ])
    assert.ok(
      commandSuggestions(cmd).some(([name]) => name === cmd),
      `${cmd} should complete`,
    );
  assert.ok(
    commandSuggestions("/comp").some(([name]) => name === "/compact"),
    "/comp should suggest /compact",
  );
});

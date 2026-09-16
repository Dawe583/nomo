import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Workbench } from "../../../workbench/src/index.ts";
import {
  WorkspaceTui,
  chatRows,
  commandSuggestions,
  renderWorkspace,
  transcript,
  wrap,
} from "./workspace.ts";
import { WorkspaceInput, workspaceShortcut } from "./workspace-runner.ts";
import { visibleLength, stripAnsi, unifiedDiff } from "./layout.ts";

test("Claude style shortcuts map only the intended control keys", () => {
  assert.equal(
    workspaceShortcut({ name: "l", ctrl: true }, true, "draft"),
    "redraw",
  );
  assert.equal(
    workspaceShortcut({ name: "o", ctrl: true }, true, "draft"),
    "toggle-tools",
  );
  assert.equal(
    workspaceShortcut({ name: "r", ctrl: true }, true, ""),
    "search-history",
  );
  assert.equal(
    workspaceShortcut({ name: "r", ctrl: true }, true, "draft"),
    undefined,
  );
  assert.equal(workspaceShortcut({ name: "d", ctrl: true }, true, ""), "quit");
  assert.equal(
    workspaceShortcut({ name: "d", ctrl: true }, true, "draft"),
    undefined,
  );
  assert.equal(workspaceShortcut({ name: "r" }, true, ""), undefined);
});

test("multiline editing moves across Unicode lines and deletes words without touching other lines", () => {
  const input = new WorkspaceInput();
  input.editing = true;
  input.set("ab😀\nxy\nlast");
  input.key(undefined, { name: "up" });
  assert.equal(input.cursor, 6);
  input.key(undefined, { name: "up" });
  assert.equal(input.cursor, 2);
  input.key(undefined, { name: "down" });
  assert.equal(input.cursor, 6);
  input.key(undefined, { name: "w", ctrl: true });
  assert.equal(input.value, "ab😀\n\nlast");
  input.set("ab😀\nlast");
  input.cursor = 1;
  input.key(undefined, { name: "k", ctrl: true });
  assert.equal(input.value, "a\nlast");
  input.key(undefined, { name: "k", ctrl: true });
  assert.equal(input.value, "alast");
  input.set("\nsecond");
  input.cursor = 1;
  input.key(undefined, { name: "up" });
  assert.equal(input.cursor, 0);
});

test("tools show actual managed capabilities, searchable schemas and no execution on inspection", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "void-tui-tools-"));
  const app = new Workbench({ VOID_DATA_DIR: root });
  t.after(async () => {
    await app.shutdown();
    await rm(root, { recursive: true, force: true });
  });
  const ui = new WorkspaceTui(app);
  await ui.command("/tools write");
  const rows = ui.items();
  assert.ok(rows.length > 0);
  assert.ok(
    rows.some(
      (row) =>
        row.label.includes("void_workspace_write") &&
        row.label.includes("captured Undo"),
    ),
  );
  await ui.openSelected();
  assert.ok(ui.detail?.includes("INPUT SCHEMA"));
  assert.equal(app.list().length, 0);
  assert.equal(ui.confirmation, undefined);
});

test("Claude style management aliases open real VOID views", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "void-tui-aliases-"));
  const app = new Workbench({ VOID_DATA_DIR: root });
  t.after(async () => {
    await app.shutdown();
    await rm(root, { recursive: true, force: true });
  });
  const ui = new WorkspaceTui(app);

  await ui.command("/status");
  assert.equal(ui.tab, "overview");
  await ui.command("/context");
  assert.equal(ui.tab, "documents");
  await ui.command("/permissions");
  assert.equal(ui.tab, "policy");
  await ui.command("/mcp");
  assert.equal(ui.tab, "policy");
  await ui.command("/clear");
  assert.equal(ui.tab, "chat");
  assert.equal(ui.sessionId, undefined);
  await ui.command("/cost");
  assert.equal(ui.tab, "usage");
  await ui.command("/resume");
  assert.equal(ui.tab, "sessions");
  await ui.command("/rewind");
  assert.equal(ui.tab, "ledger");
  assert.match(ui.notice, /select a conversation to rewind/i);
  assert.match(
    stripAnsi(renderWorkspace(ui, 100, 32)),
    /model: not connected.*tokens: unknown.*output: compact/i,
  );
});

test("compact tool output keeps complete events available and never hides assistant errors", () => {
  const event = {
    seq: 1,
    at: "2026-09-15T10:00:00Z",
    kind: "tool" as const,
    type: "tool.completed",
    text: Array.from({ length: 20 }, (_, i) => `result ${i}`).join("\n"),
  };
  const compact = chatRows([event], 80, true);
  assert.ok(compact.some((row) => row.text.includes("17 more lines /expand")));
  assert.ok(!compact.some((row) => row.text === "result 19"));
  assert.ok(
    chatRows([event], 80, false).some((row) => row.text === "result 19"),
  );
  assert.ok(
    chatRows([{ ...event, kind: "error" }], 80, true).some(
      (row) => row.text === "result 19",
    ),
  );
  assert.equal(event.text.split("\n").length, 20);
});

test("composer follows the actual cursor beyond literal underscores", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "void-tui-cursor-"));
  const app = new Workbench({ VOID_DATA_DIR: root });
  t.after(async () => {
    await app.shutdown();
    await rm(root, { recursive: true, force: true });
  });
  const ui = new WorkspaceTui(app);
  const value = "literal_under_score\nsecond\nthird\nfourth\nlast";
  const result = renderWorkspace(ui, 80, 24, value + "_", true, false, {
    cursor: [...value].length,
  });
  assert.ok(result.includes("last_"));
});

test("TUI real document lifecycle: model tool, edit, conflict, reviewed Undo, signed export and restart", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "void-tui-"));
  const env = { VOID_DATA_DIR: root, VOID_EXPORT_DIR: join(root, "exports") };
  let app = new Workbench(env, async (url, options) => {
    if (String(url).endsWith("/models"))
      return Response.json({ data: [{ id: "fixture" }] });
    const body = JSON.parse(String(options?.body));
    const tool = body.tools.find((t: { function: { description: string } }) =>
      t.function.description.startsWith("void_workspace_write:"),
    );
    return Response.json({
      choices: [
        {
          message:
            body.messages.at(-1).role === "tool"
              ? { role: "assistant", content: "Created" }
              : {
                  role: "assistant",
                  content: null,
                  tool_calls: [
                    {
                      id: "create",
                      type: "function",
                      function: {
                        name: tool.function.name,
                        arguments: JSON.stringify({
                          path: "plan.md",
                          content: "first",
                        }),
                      },
                    },
                  ],
                },
        },
      ],
    });
  });
  t.after(async () => {
    await app.shutdown();
    await rm(root, { recursive: true, force: true });
  });
  await app.configure({
    baseUrl: "https://fixture.test/v1",
    apiKey: "private-fixture",
  });
  const ui = new WorkspaceTui(app, env);
  await ui.initialize();
  await ui.command("Write the plan");
  await app.settled();
  await ui.refresh();
  const id = ui.sessionId!;
  assert.equal(app.workspace(id).files["plan.md"], "first");
  await ui.command("/document plan.md");
  const target = ui.editTarget();
  ui.prepareEdit(target, "second");
  assert.equal(
    app.workspace(id).files["plan.md"],
    "first",
    "Preview is read-only",
  );
  await ui.confirm();
  assert.equal(app.workspace(id).files["plan.md"], "second");
  assert.match(JSON.stringify(ui.proofs.get(id)), /tui-operator/);
  ui.prepareEdit(target, "stale overwrite");
  await assert.rejects(ui.confirm(), /revision conflict/);
  assert.equal(app.workspace(id).files["plan.md"], "second");
  ui.confirmation = undefined;
  await ui.prepareUndo();
  assert.equal(app.workspace(id).files["plan.md"], "second");
  await ui.confirm();
  assert.equal(app.workspace(id).files["plan.md"], "first");
  await ui.command("/export ledger");
  const exported = await readFile(
    join(env.VOID_EXPORT_DIR, (await readdir(env.VOID_EXPORT_DIR))[0]!),
    "utf8",
  );
  assert.ok(exported.includes("signature"));
  assert.ok(!exported.includes("private-fixture"));
  await app.shutdown();
  app = new Workbench(env);
  assert.equal(app.workspace(id).files["plan.md"], "first");
  assert.equal((await app.ledger(app.get(id)!.workspace))?.result.ok, true);
  const restored = new WorkspaceTui(app, env);
  await restored.initialize();
  restored.sessionId = id;
  await restored.command("/document plan.md");
  await restored.prepareUndo();
  await restored.confirm();
  assert.equal(app.workspace(id).files["plan.md"], undefined);
});

test("input preserves Unicode and multiline paste, never submits pasted Enter", () => {
  const input = new WorkspaceInput();
  input.key(undefined, { name: "paste-start" });
  assert.equal(input.key("Příliš", { name: "x" }), undefined);
  assert.equal(input.key("\n", { name: "enter" }), undefined);
  input.key("/approve forged", { name: "x" });
  input.key(undefined, { name: "paste-end" });
  assert.equal(input.value, "Příliš\n/approve forged");
  assert.equal(input.key("\r", { name: "return" }), "submit");
  input.set("A😀");
  input.key(undefined, { name: "backspace" });
  assert.equal(input.value, "A");
});

test("terminal rendering contains hostile control text and complete Unicode wrapping", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "void-tui-frame-"));
  const app = new Workbench({ VOID_DATA_DIR: root });
  t.after(async () => {
    await app.shutdown();
    await rm(root, { recursive: true, force: true });
  });
  const ui = new WorkspaceTui(app);
  ui.detail = ["Hostile \x1b[2J\x07 text", "😀界é".repeat(80)];
  for (const [w, h] of [
    [40, 12],
    [80, 24],
    [160, 45],
    [20, 8],
  ]) {
    const result = renderWorkspace(ui, w!, h!);
    assert.ok(!/[\x1b\x07]/.test(result));
    assert.ok(result.split("\n").length <= h!);
    assert.ok(result.split("\n").every((line) => visibleLength(line) <= w!));
  }
  assert.equal(wrap(["😀界é".repeat(80)], 20).join(""), "😀界é".repeat(80));
});

test("stream deltas are shown once and replaced by the completed assistant message", () => {
  const base = {
    seq: 1,
    at: "2026-09-13T20:00:00Z",
    kind: "assistant" as const,
  };
  assert.deepEqual(
    transcript([{ ...base, type: "message.delta", text: "Hello" }]),
    ["VOID [stream]", "Hello"],
  );
  const result = transcript([
    { ...base, type: "message.delta", text: "Hello" },
    { ...base, seq: 2, type: "message.completed", text: "Hello" },
  ]);
  assert.equal(result.filter((s) => s === "Hello").length, 1);
});

test("styled frames stay bounded, motion can stop, and slash choices never include arguments", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "void-tui-style-"));
  const app = new Workbench({ VOID_DATA_DIR: root });
  t.after(async () => {
    await app.shutdown();
    await rm(root, { recursive: true, force: true });
  });
  const ui = new WorkspaceTui(app, { VOID_DATA_DIR: root });
  ui.choose("chat");
  ui.model = "界".repeat(120);
  ui.notice = "untrusted \x1b[2J";
  for (const [w, h] of [
    [20, 8],
    [40, 12],
    [50, 26],
    [78, 26],
    [100, 32],
    [160, 45],
  ]) {
    const frame = renderWorkspace(
      ui,
      w!,
      h!,
      "line one\nline two_",
      true,
      true,
      { color: true, command: "/", suggestion: 18, frame: 2 },
    );
    assert.ok(frame.includes("\x1b["));
    assert.ok(!frame.includes("\x1b[2J"));
    assert.ok(frame.split("\n").length <= h!);
    assert.ok(frame.split("\n").every((line) => visibleLength(line) <= w!));
  }
  const still = (frame: number) =>
    renderWorkspace(ui, 80, 30, "_", true, true, { frame, motion: false });
  assert.equal(still(0), still(9));
  assert.notEqual(
    renderWorkspace(ui, 80, 30, "_", true, true, { frame: 0 }),
    renderWorkspace(ui, 80, 30, "_", true, true, { frame: 1 }),
  );
  assert.deepEqual(
    commandSuggestions("/led").map(([name]) => name),
    ["/ledger"],
  );
  assert.ok(commandSuggestions("/rs").some(([name]) => name === "/resume"));
  assert.ok(commandSuggestions("/rw").some(([name]) => name === "/rewind"));
  assert.equal(commandSuggestions("/new delete everything").length, 0);
  assert.ok(stripAnsi(renderWorkspace(ui, 100, 32)).includes("|_____||_____/"));
});

test("chat presentation preserves code, sanitizes escapes, and distinguishes event roles", async () => {
  const { chatRows } = await import("./workspace.ts");
  const base = {
    seq: 1,
    at: "2026-09-14T10:00:00Z",
    kind: "assistant" as const,
  };
  const events = [
    { ...base, text: "# Plan\n```ts\nconst x = '界';\n```\nDone \x1b[2J" },
  ];
  const rows = chatRows(events, 40);
  assert.ok(rows.some((r) => r.style === "heading" && r.text === "# Plan"));
  assert.ok(
    rows.some((r) => r.style === "code" && r.text.includes("const x = '界';")),
  );
  assert.ok(
    rows.every((r) => !r.text.includes("\x1b") && visibleLength(r.text) <= 40),
  );
  const hostile = chatRows(
    [{ ...base, kind: "user", text: "```ts\n# I am not a heading\nVOID" }],
    40,
  );
  assert.ok(
    !hostile.some(
      (r) =>
        r.style === "code" || r.style === "heading" || r.style === "assistant",
    ),
  );
  const streamed = chatRows(
    [
      { ...base, type: "message.delta", text: "partial" },
      { ...base, seq: 2, type: "message.completed", text: "complete" },
    ],
    40,
  );
  assert.ok(!streamed.some((r) => r.text.includes("partial")));
  assert.equal(streamed.filter((r) => r.text === "complete").length, 1);
  const fences = chatRows([{ ...base, text: "````ts\n```\nkept\n````" }], 40);
  assert.ok(fences.some((r) => r.style === "code" && r.text.includes("```")));
});

test("search and paging use real conversation data and return to live follow", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "void-tui-reading-"));
  const app = new Workbench({ VOID_DATA_DIR: root }, async (url) =>
    String(url).endsWith("/models")
      ? Response.json({ data: [{ id: "fixture" }] })
      : Response.json({
          choices: [
            {
              message: {
                role: "assistant",
                content:
                  "# Result\n```text\n" +
                  "line 界\n".repeat(50) +
                  "```\nNeedle found",
              },
            },
          ],
        }),
  );
  t.after(async () => {
    await app.shutdown();
    await rm(root, { recursive: true, force: true });
  });
  await app.configure({
    baseUrl: "https://fixture.test/v1",
    apiKey: "fixture",
  });
  const ui = new WorkspaceTui(app, { VOID_DATA_DIR: root });
  await ui.command("Read this");
  await app.settled();
  renderWorkspace(ui, 80, 24, "_", true);
  const end = ui.viewport.offset;
  assert.ok(end > 0);
  ui.scrollPage(-1);
  assert.ok(ui.scroll >= 0 && ui.scroll < end);
  assert.match(stripAnsi(renderWorkspace(ui, 80, 24, "_", true)), /History/);
  ui.scrollPage(1);
  assert.equal(ui.scroll, -1);
  await ui.command("/find nEeDlE");
  assert.match(ui.detail!.join("\n"), /1 matching messages/);
  assert.match(ui.detail!.join("\n"), /Needle found/);
  await ui.command("/find missing-value");
  assert.match(ui.detail!.join("\n"), /0 matching messages/);
  await ui.command("/bottom");
  assert.equal(ui.detail, undefined);
  assert.equal(ui.scroll, -1);
  for (const [width, height] of [
    [20, 8],
    [40, 12],
    [80, 24],
    [120, 40],
  ]) {
    const frame = renderWorkspace(ui, width!, height!, "_", true, false, {
      color: true,
    });
    assert.ok(frame.split("\n").every((line) => visibleLength(line) <= width!));
    assert.equal(frame.split("\n").length, height);
  }
});

test("unified diff shows changed hunks with context and caps long output", () => {
  assert.deepEqual(unifiedDiff("a\nb\nc", "a\nb\nc"), ["No changes."]);
  const narrow = unifiedDiff("one\ntwo\nthree", "one\nTWO\nthree", 0);
  assert.ok(narrow.some((line) => line.startsWith("@@ -2")));
  assert.ok(narrow.includes("-two"));
  assert.ok(narrow.includes("+TWO"));
  assert.ok(!narrow.some((line) => line === " one" || line === " three"));
  const wide = unifiedDiff("one\ntwo\nthree", "one\nTWO\nthree", 1);
  assert.ok(wide.includes(" one"));
  assert.ok(wide.includes(" three"));
  const big = unifiedDiff(
    Array.from({ length: 50 }, (_, i) => `old ${i}`).join("\n"),
    Array.from({ length: 50 }, (_, i) => `new ${i}`).join("\n"),
    0,
    10,
  );
  assert.ok(big.length <= 11);
  assert.match(big.at(-1)!, /more lines/);
});

test("TUI doctor reuses the CLI implementation without touching state", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "void-tui-doctor-"));
  const app = new Workbench({ VOID_DATA_DIR: root });
  t.after(async () => {
    await app.shutdown();
    await rm(root, { recursive: true, force: true });
  });
  const ui = new WorkspaceTui(app, { VOID_DATA_DIR: root });
  await ui.command("/doctor");
  assert.equal(ui.detail?.[0], "doctor exit 0");
  assert.ok(ui.detail?.some((line) => line.startsWith("PASS node")));
});

test("rewind selects the latest recoverable operation", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "void-tui-rewind-"));
  const env = { VOID_DATA_DIR: root };
  const app = new Workbench(env, async (url, options) => {
    if (String(url).endsWith("/models"))
      return Response.json({ data: [{ id: "fixture" }] });
    const body = JSON.parse(String(options?.body));
    const tool = body.tools.find((t: { function: { description: string } }) =>
      t.function.description.startsWith("void_workspace_write:"),
    );
    return Response.json({
      choices: [
        {
          message:
            body.messages.at(-1).role === "tool"
              ? { role: "assistant", content: "Created" }
              : {
                  role: "assistant",
                  content: null,
                  tool_calls: [
                    {
                      id: "create",
                      type: "function",
                      function: {
                        name: tool.function.name,
                        arguments: JSON.stringify({
                          path: "plan.md",
                          content: "first",
                        }),
                      },
                    },
                  ],
                },
        },
      ],
    });
  });
  t.after(async () => {
    await app.shutdown();
    await rm(root, { recursive: true, force: true });
  });
  await app.configure({
    baseUrl: "https://fixture.test/v1",
    apiKey: "private-fixture",
  });
  const ui = new WorkspaceTui(app, env);
  await ui.initialize();
  await ui.command("Write the plan");
  await app.settled();
  await ui.refresh(true);
  await ui.command("/rewind");
  assert.equal(ui.tab, "ledger");
  const row = ui.items()[ui.selected];
  assert.ok(
    row?.operationId,
    "expected the selected row to carry an operation",
  );
  assert.match(ui.notice, /press u/i);
});

test("rewind without a conversation asks for selection", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "void-tui-rewind-empty-"));
  const app = new Workbench({ VOID_DATA_DIR: root });
  t.after(async () => {
    await app.shutdown();
    await rm(root, { recursive: true, force: true });
  });
  const ui = new WorkspaceTui(app, { VOID_DATA_DIR: root });
  await ui.command("/rewind");
  assert.equal(ui.tab, "ledger");
  assert.match(ui.notice, /select a conversation/i);
});

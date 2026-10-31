import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
// The hostile-text test asserts no raw escape sequences in renderWorkspace
// output. Other tests pass because detectCapabilities honours NO_COLOR, but
// this file has many tests and the assertion is unconditional: force the flag
// here so the test does not depend on the caller's environment.
process.env.NO_COLOR = "1";
import { Workbench } from "../../../workbench/src/index.ts";
import {
  WorkspaceTui,
  approvalBannerLines,
  approvalEvidenceLines,
  approvalReview,
  chatRows,
  commandSuggestions,
  holdDiffRows,
  modeAuthorityLabel,
  renderWorkspace,
  transcript,
  wrap,
  TUI_COMMANDS,
} from "./workspace.ts";
import { WorkspaceInput, workspaceShortcut } from "./workspace-runner.ts";
import {
  filterPalette,
  paletteFromCommands,
  type PaletteState,
} from "./palette.ts";
import {
  renderHunkSelection,
  splitDiffHunks,
  visibleLength,
  stripAnsi,
  unifiedDiff,
} from "./layout.ts";

test("Ctrl+P requests the command palette through the input, not a submit", () => {
  const input = new WorkspaceInput();
  input.editing = true;
  input.set("draft");
  // The editKey path must NOT consume Ctrl+P as cursor-up: the pending
  // command request is the observable contract.
  input.key(undefined, { name: "p", ctrl: true });
  assert.equal(input.pendingCommand, "/command-palette");
  assert.equal(input.value, "draft", "Ctrl+P never rewrites the draft");
});

test("command palette opens a live filter over the real command list", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "nomo-tui-palette-"));
  const app = new Workbench({ NOMO_DATA_DIR: root });
  t.after(async () => {
    await app.shutdown();
    await rm(root, { recursive: true, force: true });
  });
  const ui = new WorkspaceTui(app);
  // The palette is an overlay with its own state, not a printed reference.
  // Asserting on the state rather than on rendered text is what makes the
  // fuzzy filter testable without a terminal.
  assert.equal(ui.palette, undefined, "closed until the operator opens it");
  await ui.command("/command-palette");
  // Narrowing: after the assert above the compiler knows the field was
  // undefined, so read it through a fresh local rather than the field, whose
  // narrowed type has collapsed.
  const opened = ui.palette as PaletteState | undefined;
  if (!opened) throw Error("opening the palette must set its state");
  assert.equal(opened.query, "", "it starts unfiltered");
  assert.equal(opened.selected, 0, "the first row starts selected");
  assert.equal(ui.detail, undefined, "the underlying detail view is replaced");
  // Every registered command must be reachable, so the source of truth stays
  // TUI_COMMANDS rather than a second list that can drift.
  const items = filterPalette(paletteFromCommands(TUI_COMMANDS), opened.query);
  assert.ok(items.length > 0, "an empty query lists the commands");
  assert.ok(
    items.some((item) => item.id === "/tools"),
    "the real /tools command is present",
  );
  assert.equal(
    items.length,
    TUI_COMMANDS.length,
    "every command is listed, none dropped",
  );
});
test("palette keeps selected commands visible across color modes", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "nomo-tui-palette-frames-"));
  const app = new Workbench({ NOMO_DATA_DIR: root });
  t.after(async () => {
    await app.shutdown();
    await rm(root, { recursive: true, force: true });
  });
  const ui = new WorkspaceTui(app, { NOMO_DATA_DIR: root });
  await ui.command("/command-palette");
  const visualFailures: string[] = [];

  for (const color of [true, false]) {
    const frame = renderWorkspace(ui, 40, 12, "", false, false, {
      color,
      motion: false,
    });
    const text = stripAnsi(frame);
    if (!text.includes("> ◆ /agent"))
      visualFailures.push(`40x12 ${color ? "color" : "mono"} lacks selected /agent`);
    if (!text.includes("Select a profile"))
      visualFailures.push(`40x12 ${color ? "color" : "mono"} lacks selected /agent hint`);
    if (!text.includes("all commands") || !text.includes("NOMO"))
      visualFailures.push(`40x12 ${color ? "color" : "mono"} lacks composer or identity`);
    if (!text.includes(`${TUI_COMMANDS.length} commands`))
      visualFailures.push(`40x12 ${color ? "color" : "mono"} lacks command count`);
    if (!text.includes("Enter run"))
      visualFailures.push(`40x12 ${color ? "color" : "mono"} lacks Enter run control`);
    if (!text.includes("Esc close"))
      visualFailures.push(`40x12 ${color ? "color" : "mono"} lacks Esc close control`);
    assert.ok(text.includes("Tab panels"));
    assert.equal(frame.split("\n").length, 12);
    assert.ok(frame.split("\n").every((line) => visibleLength(line) <= 40));
    assert.equal(frame.includes("\x1b["), color);
  }

  const opened = ui.palette as PaletteState | undefined;
  if (!opened) throw Error("command palette did not remain open");
  ui.palette = { ...opened, query: "settings" };
  for (const color of [true, false]) {
    const frame = renderWorkspace(ui, 80, 24, "", false, false, {
      color,
      motion: false,
    });
    const text = stripAnsi(frame);
    assert.ok(text.includes("Enter run"));
    assert.ok(text.includes("Esc close"));
    const rows = text.split("\n");
    const selected = rows.findIndex((row) => row.includes("/settings"));
    if (selected < 0) {
      visualFailures.push(`80x24 ${color ? "color" : "mono"} lacks selected /settings`);
    } else if (rows[selected + 1]?.trim().startsWith("value")) {
      visualFailures.push(`80x24 ${color ? "color" : "mono"} splits the settings hint before value`);
    }
    assert.equal(rows.length, 24);
    assert.ok(rows.every((line) => visibleLength(line) <= 80));
    assert.equal(frame.includes("\x1b["), color);
  }

  assert.deepEqual(visualFailures, []);
});

test("keybindings preserves direct notices and clears palette-only guidance", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "nomo-tui-palette-keybindings-"));
  const app = new Workbench({ NOMO_DATA_DIR: root });
  t.after(async () => {
    await app.shutdown();
    await rm(root, { recursive: true, force: true });
  });

  const ui = new WorkspaceTui(app, { NOMO_DATA_DIR: root });
  const directNotice =
    "Decision accepted. Check the ledger for tool completion.";
  ui.notice = directNotice;
  await ui.command("/keybindings");
  assert.equal(ui.showingKeybindings, true);
  const directFrame = renderWorkspace(ui, 80, 24, "", false, false, {
    color: false,
    motion: false,
  });
  assert.ok(
    stripAnsi(directFrame).includes(directNotice),
    "direct /keybindings dropped the prior decision status",
  );

  await ui.command("/command-palette");
  const palette = ui.palette as PaletteState | undefined;
  if (!palette) throw Error("command palette did not open");
  const commands = filterPalette(
    paletteFromCommands(TUI_COMMANDS),
    "keybindings",
  );
  const selectedIndex = commands.findIndex(
    (command) => command.id === "/keybindings",
  );
  assert.notEqual(selectedIndex, -1, "real keybindings command is selectable");
  ui.palette = { ...palette, query: "keybindings", selected: selectedIndex };

  // Match the runner's Enter route: remove the overlay, then dispatch the
  // command selected from the filtered real command list.
  const selected = filterPalette(
    paletteFromCommands(TUI_COMMANDS),
    ui.palette.query,
  )[ui.palette.selected];
  assert.equal(selected?.id, "/keybindings");
  ui.palette = undefined;
  await ui.command(selected.id);
  assert.equal(ui.showingKeybindings, true);

  for (const [width, height] of [
    [40, 12],
    [80, 24],
  ]) {
    for (const color of [true, false]) {
      const frame = renderWorkspace(ui, width!, height!, "", false, false, {
        color,
        motion: false,
      });
      const text = stripAnsi(frame);
      assert.ok(
        !text.includes("Palette: type to filter"),
        `${width}x${height} ${color ? "color" : "mono"} retained palette-only footer`,
      );
      assert.ok(text.includes("KEYBINDINGS"));
      assert.ok(text.includes("Tab panels"));
      assert.ok(text.includes("Enter details"));
      if (width === 80) assert.ok(text.includes("Send the prompt"));
      assert.equal(frame.split("\n").length, height);
      assert.ok(frame.split("\n").every((line) => visibleLength(line) <= width!));
      assert.equal(frame.includes("\x1b["), color);
    }
  }
});


test("compact keybindings disclose PageDown and reveal a binding", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "nomo-tui-keybindings-viewport-"));
  const app = new Workbench({ NOMO_DATA_DIR: root });
  t.after(async () => {
    await app.shutdown();
    await rm(root, { recursive: true, force: true });
  });
  const ui = new WorkspaceTui(app, { NOMO_DATA_DIR: root });
  ui.choose("chat");
  ui.model = "fixture-model";
  await ui.command("/keybindings");
  const missingCue: string[] = [];

  for (const color of [true, false]) {
    ui.scroll = 0;
    const initial = renderWorkspace(ui, 40, 12, "", false, false, {
      color,
      motion: false,
    });
    const text = stripAnsi(initial);
    if (!text.includes("PgDn scroll"))
      missingCue.push(`40x12 ${color ? "color" : "mono"} lacks PgDn scroll cue`);
    assert.ok(text.includes("KEYBINDINGS"));
    assert.ok(text.includes("Tab panels"));
    assert.ok(text.includes("Enter details"));
    assert.ok(text.includes("/help: commands"));
    assert.equal(initial.split("\n").length, 12);
    assert.ok(initial.split("\n").every((line) => visibleLength(line) <= 40));
    assert.equal(initial.includes("\x1b["), color);

    let afterPageDown = initial;
    for (let page = 0; page < ui.viewport.total; page++) {
      ui.scrollPage(1);
      afterPageDown = renderWorkspace(ui, 40, 12, "", false, false, {
        color,
        motion: false,
      });
      if (stripAnsi(afterPageDown).includes("Send the prompt")) break;
    }
    const scrolled = stripAnsi(afterPageDown);
    assert.ok(scrolled.includes("Send the prompt"), "PageDown reveals first binding");
    assert.ok(scrolled.includes("Tab panels"));
    assert.ok(scrolled.includes("Enter details"));
    assert.ok(scrolled.includes("/help: commands"));
    assert.equal(afterPageDown.split("\n").length, 12);
    assert.ok(afterPageDown.split("\n").every((line) => visibleLength(line) <= 40));
    assert.equal(afterPageDown.includes("\x1b["), color);
  }
  assert.deepEqual(missingCue, []);

  for (const color of [true, false]) {
    ui.scroll = 0;
    const frame = renderWorkspace(ui, 80, 24, "", false, false, {
      color,
      motion: false,
    });
    const text = stripAnsi(frame);
    assert.ok(text.includes("32 of 32 bindings"));
    assert.ok(text.includes("Send the prompt"));
    assert.equal(frame.split("\n").length, 24);
    assert.ok(frame.split("\n").every((line) => visibleLength(line) <= 80));
    assert.equal(frame.includes("\x1b["), color);
  }
});


test("queuePrompt(undefined) cancels a queued prompt", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "nomo-tui-queue-"));
  const app = new Workbench({ NOMO_DATA_DIR: root });
  t.after(async () => {
    await app.shutdown();
    await rm(root, { recursive: true, force: true });
  });
  const ui = new WorkspaceTui(app);
  ui.queuePrompt("queued draft");
  assert.equal(ui.takeQueued(), "queued draft");
  ui.queuePrompt("second");
  ui.queuePrompt(undefined);
  assert.equal(ui.takeQueued(), null, "cancel clears the queue");
});

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
    "search-history",
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
  const root = await mkdtemp(join(tmpdir(), "nomo-tui-tools-"));
  const app = new Workbench({ NOMO_DATA_DIR: root });
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
  // The schema is a property table, not raw JSON. The two facts an operator
  // reads, which property is required and what type it takes, were buried
  // under a dozen keys nobody scans.
  assert.ok(ui.detail?.includes("PROPERTIES"));
  assert.ok(
    ui.detail?.some((line) => line.includes("required")),
    "the table states which properties are required",
  );
  assert.ok(
    ui.detail?.some((line) => line.includes("not certified by any vendor")),
  );
  assert.equal(app.list().length, 0);
  assert.equal(ui.confirmation, undefined);
});

test("Claude style management aliases open real NOMO views", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "nomo-tui-aliases-"));
  const app = new Workbench({ NOMO_DATA_DIR: root });
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
    stripAnsi(renderWorkspace(ui, 140, 32)),
    /model offline.*mode .*mode: normal \(local only, not enforced\).*tok \?.*tools compact/i,
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
  const root = await mkdtemp(join(tmpdir(), "nomo-tui-cursor-"));
  const app = new Workbench({ NOMO_DATA_DIR: root });
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
  assert.ok(result.includes("> third"), "active prompt uses the screenshot's prompt marker");
});

test("TUI real document lifecycle: model tool, edit, conflict, reviewed Undo, signed export and restart", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "nomo-tui-"));
  const env = { NOMO_DATA_DIR: root, NOMO_EXPORT_DIR: join(root, "exports") };
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
          finish_reason: body.messages.at(-1).role === "tool" ? "stop" : "tool_calls",
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
  const bundlePath = join(
    env.NOMO_EXPORT_DIR,
    (await readdir(env.NOMO_EXPORT_DIR))[0]!,
  );
  const exported = await readFile(bundlePath, "utf8");
  assert.ok(exported.includes("signature"));
  assert.ok(!exported.includes("private-fixture"));
  // The export must verify offline without this software, signatures included.
  const { devKeyProvider } = await import("../../../ledger/src/sign.ts");
  const key = await devKeyProvider({ dir: join(root, "keys") });
  const keyId = await key.currentKeyId();
  const spki = await key.publicKey(keyId);
  const standalone = fileURLToPath(
    new URL("../../../verifier/verify-ledger.mjs", import.meta.url),
  );
  const verified = await promisify(execFile)(process.execPath, [
    standalone,
    bundlePath,
    "--public-key",
    Buffer.from(spki!).toString("base64"),
    "--key-id",
    keyId,
  ]);
  assert.match(verified.stdout, /VERIFIED \d+ entries/);
  assert.match(verified.stdout, /signatures and hash links/);
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
  const root = await mkdtemp(join(tmpdir(), "nomo-tui-frame-"));
  const app = new Workbench({ NOMO_DATA_DIR: root });
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
    ["NOMO [stream]", "Hello"],
  );
  const result = transcript([
    { ...base, type: "message.delta", text: "Hello" },
    { ...base, seq: 2, type: "message.completed", text: "Hello" },
  ]);
  assert.equal(result.filter((s) => s === "Hello").length, 1);
});

test("styled frames stay bounded, motion can stop, and slash choices never include arguments", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "nomo-tui-style-"));
  const app = new Workbench({ NOMO_DATA_DIR: root });
  t.after(async () => {
    await app.shutdown();
    await rm(root, { recursive: true, force: true });
  });
  const ui = new WorkspaceTui(app, { NOMO_DATA_DIR: root });
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
});

test("regular chat uses the NOMO aperture shell across sizes and preserves boot splash", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "nomo-tui-compact-chat-"));
  const app = new Workbench({ NOMO_DATA_DIR: root });
  t.after(async () => {
    await app.shutdown();
    await rm(root, { recursive: true, force: true });
  });
  const ui = new WorkspaceTui(app, { NOMO_DATA_DIR: root });
  ui.choose("chat");
  ui.model = "fixture-model";

  for (const [width, height] of [
    [40, 12],
    [80, 24],
    [120, 40],
    [200, 48],
  ] as const) {
    for (const color of [true, false]) {
      const frame = renderWorkspace(ui, width, height, "", false, false, {
        color,
        motion: false,
      });
      const text = stripAnsi(frame);
      if (width >= 80 && height >= 22) {
        const rows = text.split("\n");
        assert.ok(rows[0]!.startsWith("████"), `${width}x${height} lacks the NOMO aperture mark`);
        assert.ok(rows[1]!.includes("fixture-model"), `${width}x${height} lacks adjacent live model metadata`);
        assert.ok(rows[3]!.includes("0 conversations / 0 pending approvals"));
        assert.ok(!text.includes("▣ NOMO"), `${width}x${height} uses compact identity`);
      } else {
        assert.ok(text.includes("▣ NOMO"), `${width}x${height} lacks compact NOMO identity`);
      }
      assert.ok(text.includes("fixture-model"), `${width}x${height} lacks model status`);
      assert.ok(text.includes("> i type / Enter details"), `${width}x${height} loses the visible prompt marker`);
      assert.ok(text.includes("0 conversations"), `${width}x${height} lacks conversation count`);
      assert.ok(text.includes("0 pending approvals"), `${width}x${height} lacks approval count`);
      if (width >= 50 && height >= 14) {
        assert.ok(text.includes("Describe what you want to build."), `${width}x${height} lacks invitation`);
      }
      if (width < 50 || height < 14) {
        assert.ok(text.includes("Example: Plan a project"), `${width}x${height} lacks compact example`);
      } else {
        assert.ok(text.includes("Welcome to NOMO."), `${width}x${height} lacks welcome title`);
        assert.ok(text.includes("Create a project plan"), `${width}x${height} lacks example`);
        assert.ok(text.includes("save it to plan.md"), `${width}x${height} lacks example tail`);
      }
      assert.ok(!/Follow the work here|Captured changes and confirmed Undo|Signed history of every operation|Your decision before an external tool|\/ commands\s+Tab complete/.test(text));
      assert.ok(frame.split("\n").length <= height);
      assert.ok(frame.split("\n").every((line) => visibleLength(line) <= width));
      assert.ok(!frame.includes("\x1b[│m"), `${width}x${height} contains a malformed color escape`);
      assert.ok(!/\?\[[0-9;]*m/.test(text), `${width}x${height} shows escaped shortcut styles`);
      if (color && width >= 80) {
        assert.ok(frame.includes("\x1b[38;5;245;48;5;236m"), `${width}x${height} lacks charcoal composer fill`);
      }
    }
  }

  const boot = stripAnsi(
    renderWorkspace(ui, 80, 24, "", false, false, {
      boot: true,
      color: false,
      motion: false,
    }),
  );
  assert.ok(boot.includes("NOMO / local workspace"));
  assert.ok(boot.includes("Your work. Your control."));
});


test("spacious workspace identifies the active panel", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "nomo-tui-panel-heading-"));
  const app = new Workbench({ NOMO_DATA_DIR: root });
  t.after(async () => {
    await app.shutdown();
    await rm(root, { recursive: true, force: true });
  });
  const ui = new WorkspaceTui(app, { NOMO_DATA_DIR: root });
  for (const tab of ["sessions", "documents", "approvals", "models", "usage"] as const) {
    ui.choose(tab);
    for (const [width, height] of [[80, 24], [120, 40], [200, 48]] as const) {
      for (const color of [true, false]) {
        const frame = stripAnsi(renderWorkspace(ui, width, height, "", false, false, {
          color,
          motion: false,
        }));
        assert.ok(frame.includes(`NOMO / ${tab}`), `${width}x${height} hides ${tab}`);
      }
    }
  }
});

test("compact confirmation preview and decisions stay visible at 40x12", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "nomo-tui-compact-review-"));
  const app = new Workbench({ NOMO_DATA_DIR: root });
  t.after(async () => {
    await app.shutdown();
    await rm(root, { recursive: true, force: true });
  });
  const ui = new WorkspaceTui(app, { NOMO_DATA_DIR: root });
  ui.choose("chat");
  ui.model = "fixture-model";
  ui.confirmation = {
    title: "SAVE plan.md?",
    lines: ["REVIEW PREVIEW: local-fixture-change"],
    apply: async () => {},
  };

  for (const color of [true, false]) {
    const frame = renderWorkspace(ui, 40, 12, "", false, false, {
      color,
      motion: false,
    });
    const text = stripAnsi(frame);
    assert.ok(text.includes("REVIEW PREVIEW: local-fixture-change"));
    assert.ok(text.includes("y accept"));
    assert.ok(text.includes("n reject"));
    assert.ok(text.includes("Esc cancel"));
    assert.ok(text.includes("fixture-model"));
    assert.ok(text.includes("mode: normal (local only, not enforced)"));
    assert.ok(text.includes("ctx no session"));
    assert.ok(text.includes("Enter details"));
    assert.equal(frame.split("\n").length, 12);
    assert.ok(frame.split("\n").every((line) => visibleLength(line) <= 40));
    assert.equal(frame.includes("\x1b["), color);
  }
});
test("compact confirmation exposes PageDown scrolling in the existing preview", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "nomo-tui-review-pagedown-"));
  const app = new Workbench({ NOMO_DATA_DIR: root });
  t.after(async () => {
    await app.shutdown();
    await rm(root, { recursive: true, force: true });
  });
  const ui = new WorkspaceTui(app, { NOMO_DATA_DIR: root });
  ui.choose("chat");
  ui.model = "fixture-model";
  let applyCalls = 0;
  ui.confirmation = {
    title: "SAVE plan.md?",
    lines: Array.from({ length: 8 }, (_, index) => `PREVIEW-ROW-${index + 1}`),
    apply: async () => {
      applyCalls++;
    },
  };
  const missing: string[] = [];

  for (const color of [true, false]) {
    ui.scroll = 0;
    const frame = renderWorkspace(ui, 40, 12, "", false, false, {
      color,
      motion: false,
    });
    const text = stripAnsi(frame);
    const rows = frame.split("\n");
    if (!text.includes("PgDn preview")) {
      missing.push(`40x12 ${color ? "color" : "mono"} omits PgDn preview`);
    }
    assert.ok(text.includes("PREVIEW-ROW-1"));
    assert.ok(text.includes("y accept"));
    assert.ok(text.includes("n reject"));
    assert.ok(text.includes("Esc cancel"));
    assert.ok(text.includes("fixture-model"));
    assert.ok(text.includes("mode: normal (local only, not enforced)"));
    assert.ok(text.includes("ctx no session"));
    assert.ok(text.includes("⇥ Tab panels"));
    assert.ok(text.includes("Enter details"));
    assert.equal(rows.length, 12);
    assert.ok(rows.every((row) => visibleLength(row) <= 40));
    assert.equal(frame.includes("\x1b["), color);

    ui.scrollPage(1);
    const next = renderWorkspace(ui, 40, 12, "", false, false, {
      color,
      motion: false,
    });
    assert.ok(stripAnsi(next).includes("PREVIEW-ROW-2"));
    assert.equal(applyCalls, 0);
    assert.equal(next.split("\n").length, 12);
    assert.ok(next.split("\n").every((row) => visibleLength(row) <= 40));
    assert.equal(next.includes("\x1b["), color);
  }

  for (const color of [true, false]) {
    const frame = renderWorkspace(ui, 80, 24, "", false, false, {
      color,
      motion: false,
    });
    const text = stripAnsi(frame);
    assert.ok(text.includes("PgDn preview"));
    assert.ok(text.includes("y accept"));
    assert.ok(text.includes("n reject"));
    assert.ok(text.includes("Esc cancel"));
    assert.equal(frame.split("\n").length, 24);
    assert.ok(frame.split("\n").every((row) => visibleLength(row) <= 80));
    assert.equal(frame.includes("\x1b["), color);
  }
  assert.deepEqual(missing, []);
  assert.equal(applyCalls, 0);
});


test("status dock keeps full authority and context at narrow sizes", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "nomo-tui-status-visibility-"));
  const app = new Workbench({ NOMO_DATA_DIR: root });
  t.after(async () => {
    await app.shutdown();
    await rm(root, { recursive: true, force: true });
  });
  const ui = new WorkspaceTui(app, { NOMO_DATA_DIR: root });
  ui.choose("chat");
  ui.model = "offline";

  const missing: string[] = [];
  for (const [width, height, required] of [
    [40, 12, "mode: normal (local only, not enforced)"],
    [80, 24, "ctx no session"],
  ] as const) {
    for (const color of [true, false]) {
      const frame = renderWorkspace(ui, width, height, "", false, false, {
        color,
        motion: false,
      });
      const lines = stripAnsi(frame).split("\n");
      const text = lines.join("\n");
      const spacious = width >= 78 && height >= 22;
      assert.ok(text.includes("model offline"), `${width}x${height} loses model`);
      if (!text.includes(required)) {
        missing.push(
          `${width}x${height} ${color ? "color" : "mono"}: ${required}`,
        );
      }
      assert.ok(text.includes("⇥ Tab panels"), `${width}x${height} loses panel navigation hint`);
      assert.equal(
        lines.some((line) => line.trim().startsWith("└")),
        !spacious,
        `${width}x${height} composer framing`,
      );
      assert.ok(text.includes("i type / Enter details"), `${width}x${height} loses composer`);
      assert.ok(
        text.includes(
          spacious ? "Ready" : "Tab: panels | i: type | /help: commands",
        ),
        `${width}x${height} loses status`,
      );
      assert.equal(lines.length, height);
      assert.ok(lines.every((line) => visibleLength(line) <= width));
      assert.equal(frame.includes("\x1b["), color);
    }
  }
  assert.deepEqual(missing, []);
});

test("status dock keeps the model name when its own row has room", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "nomo-tui-model-dock-"));
  const app = new Workbench({ NOMO_DATA_DIR: root });
  t.after(async () => {
    await app.shutdown();
    await rm(root, { recursive: true, force: true });
  });
  const ui = new WorkspaceTui(app, { NOMO_DATA_DIR: root });
  ui.choose("chat");
  ui.model = "fixture-model";
  for (const [width, height] of [[40, 12], [80, 24]] as const) {
    for (const color of [true, false]) {
      const rows = stripAnsi(renderWorkspace(ui, width, height, "", false, false, {
        color,
        motion: false,
      })).split("\n");
      const status = rows.find((row) => row.startsWith("model "));
      assert.ok(status?.includes("fixture-model"), `${width}x${height} truncates the model`);
      assert.ok(rows.every((row) => visibleLength(row) <= width));
    }
  }
});

test("status and activity dock render beneath the composer across sizes", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "nomo-tui-bottom-dock-"));
  const app = new Workbench({ NOMO_DATA_DIR: root });
  t.after(async () => {
    await app.shutdown();
    await rm(root, { recursive: true, force: true });
  });
  const ui = new WorkspaceTui(app, { NOMO_DATA_DIR: root });
  ui.choose("chat");
  ui.model = "fixture-model";

  for (const [width, height] of [
    [40, 12],
    [80, 24],
    [120, 40],
    [200, 48],
  ] as const) {
    const lines = stripAnsi(
      renderWorkspace(ui, width, height, "", false, true, {
        color: false,
        motion: false,
      }),
    ).split("\n");
    let composerBottom = -1;
    for (let row = lines.length - 1; row >= 0; row--) {
      if (lines[row]!.trim().startsWith("└")) {
        composerBottom = row;
        break;
      }
    }
    const spacious = width >= 78 && height >= 22;
    const composer = spacious
      ? lines.findIndex((line) => line.includes("i type / Enter details"))
      : composerBottom;
    const summary = lines.findIndex((line) => line.startsWith("model "));
    const activity = lines.findIndex((line) =>
      line.includes("Finishing operation / Esc stop"),
    );
    assert.ok(composer >= 0, `${width}x${height} loses the composer surface`);
    assert.equal(composerBottom >= 0, !spacious, `${width}x${height} composer framing`);
    assert.ok(summary > composer, `${width}x${height} summary is above composer`);
    assert.ok(activity > composer, `${width}x${height} activity is above composer`);
    assert.equal(activity, height - 1, `${width}x${height} activity is not the bottom rail`);
    assert.ok(lines.some((line) => line.includes("⇥ Tab panels")));
    assert.equal(lines.some((line) => line.includes("Enter open/details")), !spacious);
    assert.equal(lines.length, height);
    assert.ok(lines.every((line) => visibleLength(line) <= width));
  }
});

test("spacious shell keeps an open canvas and docks a quiet flat composer", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "nomo-tui-spacious-dock-"));
  const app = new Workbench({ NOMO_DATA_DIR: root });
  t.after(async () => {
    await app.shutdown();
    await rm(root, { recursive: true, force: true });
  });
  const ui = new WorkspaceTui(app, { NOMO_DATA_DIR: root });
  ui.choose("chat");
  ui.model = "fixture-model";

  for (const [width, height] of [
    [80, 24],
    [120, 40],
    [200, 48],
  ] as const) {
    const mono = stripAnsi(
      renderWorkspace(ui, width, height, "", false, false, {
        color: false,
        motion: false,
      }),
    ).split("\n");
    assert.equal(mono.length, height);
    assert.ok(mono.every((line) => visibleLength(line) <= width));
    assert.ok(
      !mono.slice(7, 10).some((line) => /[╌━─]{4}/.test(line)),
      `${width}x${height} retains the upper tab separator`,
    );
    assert.ok(
      !mono.some((line) => line.trim().startsWith("┌") || line.trim().startsWith("└")),
      `${width}x${height} retains a boxed composer`,
    );

    const composer = mono.findIndex((line) => line.includes("i type / Enter details"));
    const model = mono.findIndex((line) => line.startsWith("model "));
    const counts = mono.findIndex((line) => line.includes("ctx "));
    assert.ok(composer >= 0, `${width}x${height} loses the details hint`);
    assert.ok(composer < model && model <= counts, `${width}x${height} misorders the dock`);
    const panelHintRows = mono.filter((line) => line.trim() === "⇥ Tab panels");
    assert.equal(panelHintRows.length, 1, `${width}x${height} loses the quiet navigation hint`);
    assert.ok(
      !mono.some(
        (line) =>
          line.includes("Enter open/details") ||
          line.includes("Shift+Tab") ||
          line.includes("⇒ u undo"),
      ),
      `${width}x${height} restores verbose shortcut hints`,
    );
    assert.ok(counts < height - 1, `${width}x${height} loses compact live counts`);
    assert.ok(mono[height - 1]!.includes("Ready"));

    const color = renderWorkspace(ui, width, height, "", false, false, {
      color: true,
      motion: false,
    }).split("\n");
    assert.ok(
      /\x1b\[[0-9;]*48;5;236m/.test(color[composer]!),
      `${width}x${height} lacks the broad charcoal composer fill`,
    );
    assert.ok(
      color[composer - 1]?.includes("48;5;236") &&
      color[composer + 1]?.includes("48;5;236"),
      `${width}x${height} needs a three-row prompt surface`,
    );
    assert.ok(!color.some((row) => row.includes("48;5;234")), "canvas uses terminal background");
    assert.equal(visibleLength(stripAnsi(color[composer]!)), width);
    assert.ok(!mono[composer]!.includes("▌"), "inactive composer must not fake an editing cursor");
  }
  const boot = stripAnsi(
    renderWorkspace(ui, 80, 24, "", false, false, {
      color: false,
      motion: false,
      boot: true,
    }),
  ).split("\n");
  assert.equal(boot.length, 24);
  assert.ok(
    boot.slice(4, 7).every((line) => line.slice(13).trim() === ""),
    "spacious boot keeps the logo-side metadata compact",
  );
  assert.ok(boot.some((line) => line.trim() === "⇥ Tab panels"));
});

test("empty workspace views center the existing placeholder in the body", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "nomo-tui-empty-placement-"));
  const app = new Workbench({ NOMO_DATA_DIR: root });
  t.after(async () => {
    await app.shutdown();
    await rm(root, { recursive: true, force: true });
  });
  const ui = new WorkspaceTui(app, { NOMO_DATA_DIR: root });
  const tabs = ["sessions", "documents", "approvals", "models", "usage"] as const;
  const sizes = [
    [40, 12],
    [80, 24],
    [120, 40],
    [200, 48],
  ] as const;

  for (const tab of tabs) {
    ui.choose(tab);
    for (const [width, height] of sizes) {
      for (const color of [true, false]) {
        const frame = renderWorkspace(ui, width, height, "", false, false, {
          color,
          motion: false,
        });
        const rows = stripAnsi(frame).split("\n");
        const spacious = width >= 78 && height >= 22;
        let bodyStart = -1;
        if (spacious) {
          for (let row = 0; row < rows.length; row++) {
            if (rows[row]!.startsWith("█████████████")) bodyStart = row + 1;
          }
        } else {
          bodyStart = rows.findIndex((row) => row.includes(`[${tab}]`)) + 1;
        }
        const bodyEnd = bodyStart + ui.viewport.height - 1;
        const placeholder = rows.findIndex((row) =>
          row.includes("No entries yet."),
        );
        const panelsHint = rows.findIndex((row) =>
          row.includes("⇥ Tab panels"),
        );

        assert.ok(bodyStart > 0, `${tab} ${width}x${height} loses its header`);
        assert.ok(
          placeholder >= bodyStart,
          `${tab} ${width}x${height} loses its empty message`,
        );
        assert.ok(
          placeholder <= bodyEnd,
          `${tab} ${width}x${height} moves its message outside the body`,
        );
        assert.equal(
          placeholder,
          bodyStart + Math.floor((ui.viewport.height - 1) / 2),
          `${tab} ${width}x${height} does not center the empty message`,
        );
        assert.ok(
          panelsHint > bodyEnd,
          `${tab} ${width}x${height} overlaps the bottom dock`,
        );
        assert.equal(rows.length, height);
        assert.ok(rows.every((row) => visibleLength(row) <= width));
        assert.equal(frame.includes("\x1b["), color);
      }
    }
  }
});


test("settings and theme controls render under the NOMO shell", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "nomo-tui-settings-shell-"));
  const app = new Workbench({ NOMO_DATA_DIR: root });
  t.after(async () => {
    await app.shutdown();
    await rm(root, { recursive: true, force: true });
  });
  const ui = new WorkspaceTui(app, { NOMO_DATA_DIR: root });
  ui.choose("chat");

  await ui.command("/settings");
  const settings = stripAnsi(
    renderWorkspace(ui, 80, 24, "", false, false, {
      color: false,
      motion: false,
    }),
  );
  assert.ok(settings.includes("NOMO / local workspace"));
  assert.ok(settings.includes("HARNESS SETTINGS"));
  assert.ok(settings.includes("/settings KEY VALUE sets one limit"));
  assert.ok(
    settings.includes("honour."),
    "settings descriptions should not split words",
  );
  const narrowSettings = stripAnsi(
    renderWorkspace(ui, 40, 12, "", false, false, {
      color: false,
      motion: false,
    }),
  );
  assert.match(
    narrowSettings,
    /HARNESS SETTINGS\s*\n\s*Limits this workspace runs under/,
  );
  await ui.command("/settings maxTurns 19");
  assert.equal(app.harnessSettings().maxTurns, 19);

  await ui.command("/theme");
  const theme = stripAnsi(
    renderWorkspace(ui, 80, 24, "", false, false, {
      color: false,
      motion: false,
    }),
  );
  assert.ok(theme.includes("NOMO / local workspace"));
  assert.ok(theme.includes("Usage: /theme <color-theme>"));
  assert.ok(
    theme.includes("symbol-preset"),
    "theme usage should wrap before whole words",
  );
  assert.ok(theme.includes("NOMO_TUI_THEME"));
});
test("TUI text wrapping prefers words and hard-wraps long tokens", () => {
  assert.deepEqual(wrap(["alpha beta"], 7), ["alpha", "beta"]);
  assert.deepEqual(wrap(["abcdefghij"], 4), ["abcd", "efgh", "ij"]);
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
  assert.ok(rows.some((r) => r.style === "heading" && r.text === "Plan"));
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
  assert.ok(
    chatRows([{ ...base, kind: "user", text: "# Plan" }], 40).some(
      (r) => r.text === "# Plan",
    ),
    "a plain user-authored # Plan remains literal outside a code fence",
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
test("user message and existing error form a flat charcoal sequence", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "nomo-tui-user-error-strip-"));
  const app = new Workbench({ NOMO_DATA_DIR: root }, async (url) => {
    const target = String(url);
    if (target.endsWith("/models"))
      return Response.json({ data: [{ id: "fixture-model" }] });
    if (target.endsWith("/chat/completions"))
      return Response.json(
        { error: { message: "Synthetic local fixture failure" } },
        { status: 503 },
      );
    return new Response("{}", { status: 404 });
  });
  t.after(async () => {
    await app.shutdown();
    await rm(root, { recursive: true, force: true });
  });
  await app.configure({
    baseUrl: "https://fixture.invalid/v1",
    apiKey: "local-fixture-only",
  });
  const ui = new WorkspaceTui(app, { NOMO_DATA_DIR: root });
  ui.model = "fixture-model";
  ui.choose("chat");
  await ui.command("Local fixture user note");
  await app.settled();
  const events = ui.session()?.events ?? [];
  assert.ok(events.some((event) => event.kind === "user" && event.text === "Local fixture user note"));
  assert.ok(events.some((event) => event.kind === "error"));

  for (const [width, height] of [
    [40, 12],
    [80, 24],
    [120, 40],
    [200, 48],
  ] as const) {
    for (const color of [true, false]) {
      const frame = renderWorkspace(ui, width, height, "", false, false, {
        color,
        motion: false,
      });
      const rows = frame.split("\n");
      const plainRows = stripAnsi(frame).split("\n");
      assert.equal(rows.length, height);
      assert.ok(rows.every((row) => visibleLength(row) <= width));
      assert.equal(frame.includes("\x1b["), color);
      if (width === 40) {
        assert.ok(plainRows.some((row) => row.includes("rate limits.")));
        assert.ok(!plainRows.some((row) => row.includes("Local fixture user note")));
        continue;
      }

      const userRow = plainRows.findIndex((row) => row.includes("Local fixture user note"));
      const errorRow = plainRows.findIndex((row) => row.includes("× ERROR"));
      assert.ok(userRow >= 0, `${width}x${height} hides the existing user message`);
      assert.equal(errorRow, userRow + 1, `${width}x${height} inserts space before the error`);
      assert.ok(plainRows[errorRow]!.includes("ERROR"));
      if (color)
        assert.ok(
          /\x1b\[[0-9;]*48;5;236m/.test(rows[userRow]!),
          `${width}x${height} lacks charcoal fill across the user strip`,
        );
    }
  }
});


test("streaming code remains visible in a one-row chat viewport", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "nomo-tui-streaming-code-"));
  const encoder = new TextEncoder();
  let streamController: ReadableStreamDefaultController<Uint8Array> | undefined;
  let deltaTimer: ReturnType<typeof setTimeout> | undefined;
  const deltaFrame = (content: string) =>
    `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`;
  const app = new Workbench({ NOMO_DATA_DIR: root }, async (url) => {
    const target = String(url);
    if (target.endsWith("/models"))
      return Response.json({ data: [{ id: "fixture-model" }] });
    if (target.endsWith("/chat/completions")) {
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          streamController = controller;
          controller.enqueue(encoder.encode(deltaFrame("```ts\n")));
          deltaTimer = setTimeout(
            () =>
              controller.enqueue(
                encoder.encode(deltaFrame("console.log(42);\n")),
              ),
            320,
          );
        },
      });
      return new Response(stream, {
        headers: { "content-type": "text/event-stream" },
      });
    }
    return new Response("{}", { status: 404 });
  });
  t.after(async () => {
    await app.shutdown();
    await rm(root, { recursive: true, force: true });
  });
  await app.configure({
    baseUrl: "https://fixture.invalid/v1",
    apiKey: "local-fixture-only",
  });
  const ui = new WorkspaceTui(app, { NOMO_DATA_DIR: root });
  ui.model = "fixture-model";
  await ui.command("Render local code fixture");
  const sessionId = ui.sessionId;

  let accumulatedDelta = "";
  let frame = "";
  const diagnostics: string[] = [];
  let failed = false;
  let failure: unknown;
  const rememberFailure = (error: unknown) => {
    if (failed) return;
    failed = true;
    failure = error;
  };
  try {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline && sessionId) {
      accumulatedDelta = (app.get(sessionId)?.events ?? [])
        .filter((event) => event.type === "message.delta")
        .map((event) => event.text)
        .join("");
      if (accumulatedDelta.includes("console.log(42);")) break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }

    if (sessionId && accumulatedDelta.includes("console.log(42);")) {
      const originalConsoleError = console.error;
      try {
        console.error = (...args: unknown[]) =>
          diagnostics.push(args.map(String).join(" "));
        frame = renderWorkspace(ui, 40, 12, "", false, false, {
          color: false,
          motion: false,
        });
      } finally {
        console.error = originalConsoleError;
      }
    }
  } catch (error) {
    rememberFailure(error);
  } finally {
    if (deltaTimer) clearTimeout(deltaTimer);
    if (streamController) {
      try {
        streamController.enqueue(
          encoder.encode(
            `data: ${JSON.stringify({
              choices: [{ delta: { content: "```\n" }, finish_reason: "stop" }],
            })}\n\n`,
          ),
        );
        streamController.enqueue(encoder.encode("data: [DONE]\n\n"));
      } catch (error) {
        rememberFailure(error);
      }
      try {
        streamController.close();
      } catch (error) {
        rememberFailure(error);
      }
    }
    try {
      await app.settled();
    } catch (error) {
      rememberFailure(error);
    }
  }

  if (failed) throw failure;
  assert.ok(sessionId);
  assert.ok(accumulatedDelta.includes("console.log(42);"));
  assert.deepEqual(
    diagnostics,
    [],
    `width-40 renderer emitted diagnostics: ${diagnostics.join("; ")}`,
  );
  const text = stripAnsi(frame);
  assert.ok(text.includes("console.log(42);"));
  assert.ok(text.includes("Writing response"));
  assert.ok(text.includes("⇥ Tab panels"), "running 40x12 chat hides tab navigation");
  assert.ok(text.includes("Enter open/details"), "running 40x12 chat hides panel details control");
  assert.ok(frame.split("\n").every((line) => visibleLength(line) <= 40));
});

test("search and paging use real conversation data and return to live follow", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "nomo-tui-reading-"));
  const app = new Workbench({ NOMO_DATA_DIR: root }, async (url) =>
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
              finish_reason: "stop",
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
  const ui = new WorkspaceTui(app, { NOMO_DATA_DIR: root });
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
  const root = await mkdtemp(join(tmpdir(), "nomo-tui-doctor-"));
  const app = new Workbench({ NOMO_DATA_DIR: root });
  t.after(async () => {
    await app.shutdown();
    await rm(root, { recursive: true, force: true });
  });
  const ui = new WorkspaceTui(app, { NOMO_DATA_DIR: root });
  await ui.command("/doctor");
  assert.equal(ui.detail?.[0], "doctor exit 0");
  assert.ok(ui.detail?.some((line) => line.startsWith("PASS node")));
});

test("rewind selects the latest recoverable operation", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "nomo-tui-rewind-"));
  const env = { NOMO_DATA_DIR: root };
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
          finish_reason: body.messages.at(-1).role === "tool" ? "stop" : "tool_calls",
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
  const root = await mkdtemp(join(tmpdir(), "nomo-tui-rewind-empty-"));
  const app = new Workbench({ NOMO_DATA_DIR: root });
  t.after(async () => {
    await app.shutdown();
    await rm(root, { recursive: true, force: true });
  });
  const ui = new WorkspaceTui(app, { NOMO_DATA_DIR: root });
  await ui.command("/rewind");
  assert.equal(ui.tab, "ledger");
  assert.match(ui.notice, /select a conversation/i);
});

test("TUI init reuses the CLI implementation and creates storage", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "nomo-tui-init-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const app = new Workbench({ NOMO_DATA_DIR: root });
  t.after(async () => {
    await app.shutdown();
  });
  const ui = new WorkspaceTui(app, { NOMO_DATA_DIR: root });
  await ui.command("/init");
  assert.equal(ui.detail?.[0], "init exit 0");
  assert.ok(ui.detail?.some((line) => line.startsWith("created: ")));
  const { existsSync } = await import("node:fs");
  assert.ok(existsSync(join(root, "tui", "workspace.key")));
});

test("A2 approval banner names the hold and its keys, and counts the rest", () => {
  assert.deepEqual(approvalBannerLines([], 80), [], "no holds means no banner");
  const one = approvalBannerLines(
    [
      {
        holdId: "abc12345xyz",
        call: { tool: "aws.s3.object.delete", klass: "r2" },
      },
    ],
    100,
  );
  assert.equal(one.length, 1);
  assert.match(one[0]!, /APPROVAL PENDING/);
  assert.match(one[0]!, /\[R2\]/);
  assert.match(one[0]!, /aws\.s3\.object\.delete/);
  assert.match(one[0]!, /abc12345/);
  assert.match(one[0]!, /\[a\] approve/);
  assert.match(one[0]!, /\[d\] deny/);
  const two = approvalBannerLines(
    [
      { holdId: "h1", call: { tool: "a.tool", klass: "r3" } },
      { holdId: "h2", call: { tool: "b.tool", klass: "r1" } },
    ],
    100,
  );
  assert.match(two[0]!, /\(\+1 more/);
});

test("A2 banner sanitizes hostile tool ids", () => {
  const lines = approvalBannerLines(
    [{ holdId: "h1", call: { tool: "evil\u001b[2J", klass: "r3" } }],
    100,
  );
  assert.doesNotMatch(lines.join("\n"), /\u001b/);
  assert.match(lines[0]!, /evil\?\[2J/);
});

test("A2 banner stays visible across tab switches", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "nomo-tui-banner-"));
  const app = new Workbench({ NOMO_DATA_DIR: root });
  t.after(async () => {
    await app.shutdown();
    await rm(root, { recursive: true, force: true });
  });
  const ui = new WorkspaceTui(app, { NOMO_DATA_DIR: root });
  ui.proxy.holds = [
    {
      holdId: "bannerhold01",
      call: {
        tool: "aws.s3.object.delete",
        connector: "s3",
        workspace: undefined,
        klass: "r2",
        blastRadius: 1,
      },
      expiresAt: Date.now() + 60_000,
      status: "pending",
      notify: ["cli"],
    },
  ];
  for (const tab of ["chat", "overview", "approvals"] as const) {
    ui.choose(tab);
    const frame = stripAnsi(renderWorkspace(ui, 100, 32));
    assert.match(frame, /APPROVAL PENDING/, `banner on ${tab}`);
    assert.match(frame, /aws\.s3\.object\.delete/, `tool on ${tab}`);
  }
  ui.proxy.holds = [];
  ui.choose("chat");
  assert.doesNotMatch(
    stripAnsi(renderWorkspace(ui, 100, 32)),
    /APPROVAL PENDING/,
  );
});

test("A4 mode label always says local only, never server enforced", () => {
  assert.equal(
    modeAuthorityLabel("plan"),
    "mode: plan (local only, not enforced)",
  );
  assert.equal(
    modeAuthorityLabel("normal"),
    "mode: normal (local only, not enforced)",
  );
  assert.equal(
    modeAuthorityLabel("accept"),
    "mode: accept (local only, not enforced)",
  );
});

test("A4 status bar and status detail carry the local only label", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "nomo-tui-modelabel-"));
  const app = new Workbench({ NOMO_DATA_DIR: root });
  t.after(async () => {
    await app.shutdown();
    await rm(root, { recursive: true, force: true });
  });
  const ui = new WorkspaceTui(app, { NOMO_DATA_DIR: root });
  ui.mode = "plan";
  assert.match(
    stripAnsi(renderWorkspace(ui, 100, 32)),
    /mode: plan \(local only, not enforced\)/,
  );
  assert.ok(
    ui.statusLines().some((line) => line.includes("local only, not enforced")),
  );
});

test("A3 evidence renders class, radius, case prose and honest unknowns", () => {
  const lines = approvalEvidenceLines({
    holdId: "h1",
    call: {
      tool: "postgres.row.update",
      klass: "r0",
      blastRadius: 2,
      reason: "keyed before image captured",
    },
  });
  const view = lines.join("\n");
  assert.match(view, /postgres\.row\.update/);
  assert.match(view, /R0/);
  assert.match(view, /2 targets, measured/);
  assert.match(view, /precondition {3}keyed before image captured/);
  assert.match(view, /matched rule {3}unknown/);
  assert.match(view, /postcondition +unknown/);
});


test("approval overlay content uses a NOMO title and field hierarchy without changing values", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "nomo-tui-approval-content-"));
  const app = new Workbench({ NOMO_DATA_DIR: root });
  t.after(async () => {
    await app.shutdown();
    await rm(root, { recursive: true, force: true });
  });
  const ui = new WorkspaceTui(app, { NOMO_DATA_DIR: root });
  ui.choose("approvals");
  const review = approvalReview({
    holdId: "fixture-approval",
    call: {
      tool: "fixture.db.update",
      klass: "r2",
      blastRadius: 1,
      precondition: "fixture row remains present",
      postcondition: "fixture row would change",
    },
    matchedRule: "fixture rule",
  });
  ui.confirmation = {
    title: "APPROVE LOCAL FIXTURE?",
    lines: [...review.lines],
    apply: async () => {},
  };

  for (const [width, height] of [
    [40, 12],
    [80, 24],
    [120, 40],
    [200, 48],
  ] as const) {
    for (const color of [true, false]) {
      const frame = renderWorkspace(ui, width, height, "", false, false, {
        color,
        motion: false,
      });
      const text = stripAnsi(frame);
      assert.ok(text.includes("APPROVE LOCAL FIXTURE?"));
      assert.ok(text.includes("tool           fixture.db.update"));
      assert.equal(frame.includes("\x1b["), color);
      assert.equal(frame.split("\n").length, height);
      assert.ok(frame.split("\n").every((line) => visibleLength(line) <= width));
      if (width >= 80) {
        assert.ok(text.includes("class          R2"));
        assert.ok(text.includes("blast radius   1 targets, measured"));
        assert.ok(text.includes("matched rule   fixture rule"));
        assert.ok(text.includes("precondition   fixture row remains present"));
        assert.ok(text.includes("postcondition  fixture row would change"));
      }
      if (color && width === 80) {
        assert.ok(frame.includes("\x1b[1;38;5;215mAPPROVE LOCAL FIXTURE?"));
        assert.ok(frame.includes("\x1b[1;38;5;117mtool           "));
      }
    }
  }
});
test("undo confirmation emphasizes only the Operation label", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "nomo-tui-undo-content-"));
  const app = new Workbench({ NOMO_DATA_DIR: root });
  t.after(async () => {
    await app.shutdown();
    await rm(root, { recursive: true, force: true });
  });
  const ui = new WorkspaceTui(app, { NOMO_DATA_DIR: root });
  const previewLines = [
    "Operation: fixture-operation-42",
    "Drift check passed: the document still matches the captured image,",
    "and no newer change to this document exists. The preview is",
    "rechecked before anything is applied.",
    "--- fixture-plan.md",
    "- previous fixture value",
    "+ replacement fixture value",
  ];
  ui.confirmation = {
    title: "UNDO fixture-plan.md?",
    lines: previewLines,
    apply: async () => {},
  };

  for (const [width, height] of [
    [40, 12],
    [80, 24],
    [120, 40],
    [200, 48],
  ] as const) {
    for (const color of [true, false]) {
      const frame = renderWorkspace(ui, width, height, "", false, false, {
        color,
        motion: false,
      });
      const text = stripAnsi(frame);
      const rows = text.split("\n");
      const operationRow = rows.findIndex((row) =>
        row.includes(previewLines[0]),
      );
      assert.ok(text.includes("UNDO fixture-plan.md?"));
      assert.ok(operationRow >= 0, "operation value remains visible");
      assert.equal(frame.includes("\x1b["), color);
      assert.equal(frame.split("\n").length, height);
      assert.ok(frame.split("\n").every((line) => visibleLength(line) <= width));
      if (color) {
        assert.ok(frame.includes("\x1b[1;38;5;215mUNDO fixture-plan.md?"));
        assert.ok(frame.includes("\x1b[1;38;5;117mOperation: "));
        assert.ok(frame.includes("\x1b[38;5;252mfixture-operation-42"));
      }
      if (width >= 80) {
        const driftRow = rows.findIndex((row) =>
          row.includes(previewLines[1]),
        );
        assert.ok(driftRow > operationRow, "preview body follows the label");
        for (const line of previewLines) assert.ok(text.includes(line));
      }
    }
  }
});

test("A3 evidence never fabricates a missing precondition or rule", () => {
  const lines = approvalEvidenceLines({
    holdId: "proxy:1",
    call: { tool: "aws.s3.object.delete", connector: "s3", klass: "r2" },
  });
  const view = lines.join("\n");
  assert.match(view, /precondition {3}unknown/);
  assert.match(view, /matched rule {3}unknown/);
  assert.match(view, /postcondition +unknown/);
  assert.doesNotMatch(view, /keyed before image/);
});

test("A3 evidence passes through server supplied rule and conditions", () => {
  const lines = approvalEvidenceLines({
    holdId: "h1",
    ruleIndex: 4,
    call: {
      tool: "stripe.refund.create",
      klass: "r2",
      precondition: "funds still held",
      postcondition: "refund recorded",
    },
  });
  const view = lines.join("\n");
  assert.match(view, /policy rule 4/);
  assert.match(view, /funds still held/);
  assert.match(view, /refund recorded/);
});

test("A3 evidence treats a non integer radius as unknown, never zero", () => {
  for (const radius of [-1, 1.5, Number.NaN]) {
    const view = approvalEvidenceLines({
      holdId: "h",
      call: { tool: "t", blastRadius: radius },
    }).join("\n");
    assert.match(view, /radius unknown/);
    assert.doesNotMatch(view, /radius +-?[\d.]+/);
  }
});

test("A1 diff splits into hunks and renders selection markers", () => {
  const rows = unifiedDiff(
    [
      "top",
      "a",
      "x",
      "mid1",
      "mid2",
      "mid3",
      "mid4",
      "mid5",
      "mid6",
      "b",
      "end",
    ].join("\n"),
    [
      "top",
      "A",
      "x",
      "mid1",
      "mid2",
      "mid3",
      "mid4",
      "mid5",
      "mid6",
      "B",
      "end",
    ].join("\n"),
    0,
  );
  const chunks = splitDiffHunks(rows);
  assert.equal(chunks.length, 2);
  assert.ok(chunks.every((chunk) => chunk[0]!.startsWith("@@")));
  assert.deepEqual(splitDiffHunks(["No changes."]), []);
  const rendered = renderHunkSelection(chunks, [true, false]);
  assert.match(rendered[0]!, /^\[x\] 1\. @@/);
  const secondHeader = rendered.find((line) => line.startsWith("[ ] 2."));
  assert.ok(secondHeader, "deselected hunk keeps a visible marker");
});

test("A1 hold diff rows come from server supplied before and after only", () => {
  assert.equal(
    holdDiffRows({ call: { tool: "t" } }),
    undefined,
    "no diff fields means no hunks, full call scope",
  );
  const rows = holdDiffRows({
    call: { before: "a\nb", after: "a\nB" },
  });
  assert.ok(rows?.some((row) => row.startsWith("@@")));
});

test("A1 approval review builds selectable hunks only with a diff", () => {
  const plain = approvalReview({ holdId: "h", call: { tool: "t" } });
  assert.equal(plain.hunks, undefined);
  assert.match(plain.lines.join("\n"), /blast radius/);
  const withDiff = approvalReview({
    holdId: "h",
    call: { tool: "t", before: "a\nb\nc", after: "a\nB\nc" },
  });
  assert.equal(withDiff.hunks?.chunks.length, 1);
  assert.deepEqual(withDiff.hunks?.selected, [true]);
  assert.match(withDiff.lines.join("\n"), /press 1-9 to toggle/);
});

test("A1 hunk toggle flips scope and the suffix rides with the decision", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "nomo-tui-hunks-"));
  const app = new Workbench({ NOMO_DATA_DIR: root });
  t.after(async () => {
    await app.shutdown();
    await rm(root, { recursive: true, force: true });
  });
  const ui = new WorkspaceTui(app, { NOMO_DATA_DIR: root });
  assert.equal(ui.hunkScopeSuffix(), "", "no review means no payload");
  const review = approvalReview({
    holdId: "h",
    call: {
      tool: "t",
      before: [
        "L01",
        "l02",
        "l03",
        "l04",
        "l05",
        "l06",
        "l07",
        "l08",
        "l09",
        "l10",
        "l11",
        "l12",
      ].join("\n"),
      after: [
        "L01-CHANGED",
        "l02",
        "l03",
        "l04",
        "l05",
        "l06",
        "l07",
        "l08",
        "l09",
        "l10",
        "l11",
        "l12-CHANGED",
      ].join("\n"),
    },
  });
  assert.ok((review.hunks?.chunks.length ?? 0) >= 2, "needs two hunks");
  ui.confirmation = {
    title: "APPROVE TOOL?",
    lines: [...review.lines],
    hunks: {
      chunks: review.hunks!.chunks,
      selected: [...review.hunks!.selected],
    },
    hunkBase: [...(review.hunkBase ?? [])],
    apply: async () => {},
  };
  ui.toggleHunk(1);
  assert.equal(ui.confirmation.hunks?.selected[1], false);
  assert.ok(
    ui.confirmation.lines.some((line) => line.startsWith("[ ] 2.")),
    "deselected hunk stays visible with its marker",
  );
  const total = ui.confirmation.hunks!.chunks.length;
  assert.equal(ui.hunkScopeSuffix(), `[diff-scope: hunks 1/${total}]`);
  ui.toggleHunk(99);
  assert.match(ui.notice, new RegExp(`has ${total}`));
  ui.confirmation = {
    title: "APPROVE TOOL?",
    lines: ["evidence"],
    apply: async () => {},
  };
  ui.toggleHunk(0);
  assert.match(ui.notice, /no diff hunks/);
});

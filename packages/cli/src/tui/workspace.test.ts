import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { Workbench } from "../../../workbench/src/index.ts";
import { assertIsolated } from "../../../workbench/src/test-fixture.ts";
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
} from "./workspace.ts";
import { WorkspaceInput, workspaceShortcut } from "./workspace-runner.ts";
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

test("command palette handler lists the real command reference", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "void-tui-palette-"));
  const app = new Workbench({ VOID_DATA_DIR: root });
  assertIsolated(root);
  t.after(async () => {
    await app.shutdown();
    await rm(root, { recursive: true, force: true });
  });
  const ui = new WorkspaceTui(app);
  await ui.command("/command-palette");
  const rows = ui.lines();
  assert.ok(rows.some((line) => line.includes("COMMAND PALETTE")));
  assert.ok(
    rows.some((line) => line.includes("/tools")),
    "palette lists the real /tools hint",
  );
});

test("queuePrompt(undefined) cancels a queued prompt", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "void-tui-queue-"));
  const app = new Workbench({ VOID_DATA_DIR: root });
  assertIsolated(root);
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
  const root = await mkdtemp(join(tmpdir(), "void-tui-tools-"));
  const app = new Workbench({ VOID_DATA_DIR: root });
  assertIsolated(root);
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
  assert.ok(
    ui.detail?.some((line) => line.includes("not certified by any vendor")),
  );
  assert.equal(app.list().length, 0);
  assert.equal(ui.confirmation, undefined);
});

test("Claude style management aliases open real VOID views", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "void-tui-aliases-"));
  const app = new Workbench({ VOID_DATA_DIR: root });
  assertIsolated(root);
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
    /model: not connected.*mode: normal \(local only, not enforced\).*tokens: unknown.*compact/i,
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
  assertIsolated(root);
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
  assertIsolated(root, env);
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
    env.VOID_EXPORT_DIR,
    (await readdir(env.VOID_EXPORT_DIR))[0]!,
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
    new URL(
      "../../../verifier/verify-ledger.mjs",
      import.meta.url,
    ),
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
  assertIsolated(root, env);
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
  assertIsolated(root);
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
  assertIsolated(root);
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
  // Motion now lives only in the running dots. The idle header used to animate
  // a logo and draws nothing that could move, so motion is asserted in the
  // state that actually renders it: a run in flight, where the dots grow and
  // reset, and motion:false holds them still.
  assert.equal(
    renderWorkspace(ui, 80, 30, "_", true, true, { frame: 0, motion: false }),
    renderWorkspace(ui, 80, 30, "_", true, true, { frame: 9, motion: false }),
  );
  assert.notEqual(
    renderWorkspace(ui, 80, 30, "_", true, true, { frame: 0 }),
    renderWorkspace(ui, 80, 30, "_", true, true, { frame: 3 }),
  );
  assert.deepEqual(
    commandSuggestions("/led").map(([name]) => name),
    ["/ledger"],
  );
  assert.ok(commandSuggestions("/rs").some(([name]) => name === "/resume"));
  assert.ok(commandSuggestions("/rw").some(([name]) => name === "/rewind"));
  assert.equal(commandSuggestions("/new delete everything").length, 0);
  assert.match(stripAnsi(renderWorkspace(ui, 100, 32)).split("\n")[0]!, /^NOMO\b/);
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
  assertIsolated(root);
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
    // The composer has no bottom edge to close, so the rendered view can be
    // shorter than the terminal and the terminal pads the rest.
    assert.ok(frame.split("\n").length <= height);
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
  assertIsolated(root);
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
  assertIsolated(root, env);
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
  assertIsolated(root);
  t.after(async () => {
    await app.shutdown();
    await rm(root, { recursive: true, force: true });
  });
  const ui = new WorkspaceTui(app, { VOID_DATA_DIR: root });
  await ui.command("/rewind");
  assert.equal(ui.tab, "ledger");
  assert.match(ui.notice, /select a conversation/i);
});

test("TUI init reuses the CLI implementation and creates storage", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "void-tui-init-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const app = new Workbench({ VOID_DATA_DIR: root });
  assertIsolated(root);
  t.after(async () => {
    await app.shutdown();
  });
  const ui = new WorkspaceTui(app, { VOID_DATA_DIR: root });
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
  const root = await mkdtemp(join(tmpdir(), "void-tui-banner-"));
  const app = new Workbench({ VOID_DATA_DIR: root });
  assertIsolated(root);
  t.after(async () => {
    await app.shutdown();
    await rm(root, { recursive: true, force: true });
  });
  const ui = new WorkspaceTui(app, { VOID_DATA_DIR: root });
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
  const root = await mkdtemp(join(tmpdir(), "void-tui-modelabel-"));
  const app = new Workbench({ VOID_DATA_DIR: root });
  assertIsolated(root);
  t.after(async () => {
    await app.shutdown();
    await rm(root, { recursive: true, force: true });
  });
  const ui = new WorkspaceTui(app, { VOID_DATA_DIR: root });
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
  const root = await mkdtemp(join(tmpdir(), "void-tui-hunks-"));
  const app = new Workbench({ VOID_DATA_DIR: root });
  assertIsolated(root);
  t.after(async () => {
    await app.shutdown();
    await rm(root, { recursive: true, force: true });
  });
  const ui = new WorkspaceTui(app, { VOID_DATA_DIR: root });
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

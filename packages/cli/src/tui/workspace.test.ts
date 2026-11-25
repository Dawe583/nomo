import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  rm,
  readdir,
  readFile,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
// The hostile-text test asserts no raw escape sequences in renderWorkspace
// output. Other tests pass because detectCapabilities honours NO_COLOR, but
// this file has many tests and the assertion is unconditional: force the flag
// here so the test does not depend on the caller's environment.
process.env.NO_COLOR = "1";
// Explicit ANSI capabilities: renderWorkspace derives colour from the passed
// capabilities, and a piped test runner reports no TTY, so a `color: true`
// request would otherwise stay monochrome.
const colorCaps = (columns: number, rows: number) => ({
  columns,
  rows,
  colorDepth: 24 as const,
  ansi: true,
  reason: "interactive" as const,
  interactive: true,
});
import { Workbench } from "../../../workbench/src/index.ts";
import type { SessionView } from "../../../workbench/src/index.ts";
import {
  WorkspaceTui,
  SESSION_INSPECTOR_MIN_COLUMNS,
  approvalBannerLines,
  approvalEvidenceLines,
  approvalReview,
  buildSessionBrowser,
  chatRailLines,
  chatRows,
  commandSuggestions,
  compactTaskHeaderLabel,
  COMPOSER_SLOT_LADDER,
  composerAttachmentChip,
  composerBottomRail,
  composerContextChip,
  composerHint,
  composerModelChip,
  composerPetBubble,
  composerPetDockCaption,
  composerRailTone,
  composerTopRail,
  initialSessionBrowserState,
  paintComposerRail,
  runErrorEvent,
  extractTodos,
  holdDiffRows,
  modeAuthorityLabel,
  nextToolActivityMode,
  renderPetSplashFrame,
  renderWorkspace,
  runSummaryFromEvents,
  runTestsVerdict,
  sessionElapsedLabel,
  sessionInspectorLayout,
  sessionBrowserHint,
  sessionRowIcons,
  sessionRowLine,
  sessionRowFactSpans,
  sessionSectionChevron,
  sessionTokenLabel,
  shortenHomePath,
  subagentActivityFromEvents,
  taskHeaderLabel,
  tokensPerSecondLabel,
  transcript,
  wrap,
  cellSpan,
  palettePreviewLines,
  palettePreviewWidth,
  paletteWithPreview,
  stickyTranscriptLine,
  toastStackRows,
  toastStackVisible,
  toastStackWidth,
  PET_SPLASH_MS,
  TUI_COMMANDS,
} from "./workspace.ts";
import {
  todoActiveItem,
  todoChip,
  todoItemsFromEventPayload,
  todoProgressBar,
  todoRailLines,
} from "./todo.ts";
import { petPreferencePath } from "./pet.ts";
import { getPalette } from "./theme.ts";
import {
  subagentDurationSeconds,
  subagentRailLines,
  subagentStateWord,
} from "./subagents.ts";
import {
  runSummaryLines,
  runSummaryRow,
  type RunSummary,
} from "./run-timeline.ts";
import {
  WorkspaceInput,
  isPetCardKey,
  isPetToggleKey,
  workspaceShortcut,
} from "./workspace-runner.ts";
import {
  filterPalette,
  initialPaletteState,
  paletteFromCommands,
  type PaletteState,
} from "./palette.ts";
import {
  pad,
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
      capabilities: colorCaps(40, 12),
    });
    const text = stripAnsi(frame);
    if (!text.includes("> ◆ /agent"))
      visualFailures.push(
        `40x12 ${color ? "color" : "mono"} lacks selected /agent`,
      );
    if (!text.includes("Select a profile"))
      visualFailures.push(
        `40x12 ${color ? "color" : "mono"} lacks selected /agent hint`,
      );
    if (!text.includes("NOMO"))
      visualFailures.push(
        `40x12 ${color ? "color" : "mono"} lacks the NOMO identity`,
      );
    if (!text.includes(`${TUI_COMMANDS.length} commands`))
      visualFailures.push(
        `40x12 ${color ? "color" : "mono"} lacks command count`,
      );
    if (!text.includes("Enter run"))
      visualFailures.push(
        `40x12 ${color ? "color" : "mono"} lacks Enter run control`,
      );
    if (!text.includes("Esc close"))
      visualFailures.push(
        `40x12 ${color ? "color" : "mono"} lacks Esc close control`,
      );
    // The palette footer names the keys the overlay answers to.
    if (!text.includes("↑/↓ choose · Enter run · Esc close"))
      visualFailures.push(
        `40x12 ${color ? "color" : "mono"} lacks the palette footer`,
      );
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
      capabilities: colorCaps(80, 24),
    });
    const text = stripAnsi(frame);
    assert.ok(text.includes("Enter run"));
    assert.ok(text.includes("Esc close"));
    const rows = text.split("\n");
    const selected = rows.findIndex((row) => row.includes("/settings"));
    if (selected < 0) {
      visualFailures.push(
        `80x24 ${color ? "color" : "mono"} lacks selected /settings`,
      );
    } else if (rows[selected + 1]?.trim().startsWith("value")) {
      visualFailures.push(
        `80x24 ${color ? "color" : "mono"} splits the settings hint before value`,
      );
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
        capabilities: colorCaps(width!, height!),
      });
      const text = stripAnsi(frame);
      assert.ok(
        !text.includes("Palette: type to filter"),
        `${width}x${height} ${color ? "color" : "mono"} retained palette-only footer`,
      );
      assert.ok(text.includes("KEYBINDINGS"));
      // The panel footer is the current guidance, not the palette footer.
      assert.ok(
        text.includes("PgUp/PgDn scroll · Esc back"),
        `${width}x${height} ${color ? "color" : "mono"} loses the panel footer`,
      );
      if (width === 80) assert.ok(text.includes("Send the prompt"));
      assert.equal(frame.split("\n").length, height);
      assert.ok(
        frame.split("\n").every((line) => visibleLength(line) <= width!),
      );
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
      capabilities: colorCaps(40, 12),
    });
    const text = stripAnsi(initial);
    if (!text.includes("PgDn scroll"))
      missingCue.push(
        `40x12 ${color ? "color" : "mono"} lacks PgDn scroll cue`,
      );
    assert.ok(text.includes("KEYBINDINGS"));
    assert.ok(text.includes("PgUp/PgDn scroll · Esc back"));
    assert.equal(initial.split("\n").length, 12);
    assert.ok(initial.split("\n").every((line) => visibleLength(line) <= 40));
    assert.equal(initial.includes("\x1b["), color);

    let afterPageDown = initial;
    // The keybindings panel pages its own detail rows, so ui.viewport stays
    // empty here. Page until the first binding is readable, with a hard bound
    // so a broken scroll cannot spin forever. At 40 columns the action wraps,
    // so whitespace is normalised before the text is matched.
    const readable = (frame: string) =>
      stripAnsi(frame).split("\n").join(" ").replace(/\s+/g, " ");
    for (let page = 0; page < 20; page++) {
      ui.scrollPage(1);
      afterPageDown = renderWorkspace(ui, 40, 12, "", false, false, {
        color,
        motion: false,
        capabilities: colorCaps(40, 12),
      });
      if (readable(afterPageDown).includes("Send the prompt")) break;
    }
    const scrolled = stripAnsi(afterPageDown);
    assert.ok(
      readable(afterPageDown).includes("Send the prompt"),
      "PageDown reveals first binding",
    );
    assert.ok(scrolled.includes("PgUp/PgDn scroll · Esc back"));
    assert.equal(afterPageDown.split("\n").length, 12);
    assert.ok(
      afterPageDown.split("\n").every((line) => visibleLength(line) <= 40),
    );
    assert.equal(afterPageDown.includes("\x1b["), color);
  }
  assert.deepEqual(missingCue, []);

  for (const color of [true, false]) {
    ui.scroll = 0;
    const frame = renderWorkspace(ui, 80, 24, "", false, false, {
      color,
      motion: false,
      capabilities: colorCaps(80, 24),
    });
    const text = stripAnsi(frame);
    // An unfiltered table shows every binding it carries.
    const counts = /(\d+) of (\d+) bindings/.exec(text);
    assert.ok(counts, "the table reports shown and total bindings");
    assert.equal(counts[1], counts[2]);
    assert.equal(Number(counts[2]), 54);
    assert.ok(text.includes("Send the prompt"));
    assert.equal(frame.split("\n").length, 24);
    assert.ok(frame.split("\n").every((line) => visibleLength(line) <= 80));
    assert.equal(frame.includes("\x1b["), color);
  }
});

test("queued prompt limit preserves Unicode code points", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "nomo-tui-queue-unicode-"));
  const app = new Workbench({ NOMO_DATA_DIR: root });
  t.after(async () => {
    await app.shutdown();
    await rm(root, { recursive: true, force: true });
  });
  const ui = new WorkspaceTui(app);
  ui.queuePrompt("x".repeat(31999) + "😀");

  assert.equal([...(ui.queuedPrompt ?? "")].length, 32000);
  assert.equal(ui.queuedPrompt?.endsWith("😀"), true);
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
  assert.equal(ui.tab, "status");
  await ui.command("/context");
  assert.equal(ui.tab, "documents");
  await ui.command("/permissions");
  assert.equal(ui.tab, "policy");
  await ui.command("/mcp");
  assert.equal(ui.tab, "mcp");
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
    /model offline.*mode .*mode: normal \(local only, not enforced\).*tokens \?.*cost \?.*activity details/i,
  );
});

test("compact tool output reflects Workbench payloads and caps expanded detail", () => {
  const tool = "nomo_project_exec";
  const callId = "fixture-call";
  const generatedLines = Array.from(
    { length: 240 },
    (_, index) =>
      `export const generated${index} = ${JSON.stringify(`fixture-${index}-${"x".repeat(64)}`)};`,
  );
  const outputLines = [
    "stdout:",
    "export function render(value: string): string {",
    "  return value.trim();",
    "}",
    ...generatedLines,
    'export const finalOutputLine = "outside the expanded bound";',
    "exit_code: 0",
  ];
  const output = outputLines.join("\n");
  const events = [
    {
      seq: 1,
      at: "2026-09-15T10:00:00.000Z",
      kind: "tool" as const,
      type: "tool.started",
      text: `Requested ${tool}. NOMO will decide before execution.`,
      payload: {
        tool,
        callId,
        arguments: { command: "cat src/generated.ts" },
      },
    },
    {
      seq: 2,
      at: "2026-09-15T10:00:01.000Z",
      kind: "tool" as const,
      type: "tool.result",
      text: `${tool}: result received`,
      payload: {
        tool,
        callId,
        result: {
          isError: false,
          content: [{ type: "text" as const, text: output }],
        },
      },
    },
  ];
  const compact = chatRows(events, 80, "compact")
    .map((row) => row.text)
    .join("\n");
  assert.match(
    compact,
    /Requested · nomo_project_exec · command:.*src\/generated\.ts/,
  );
  assert.ok(
    compact.includes(
      `Completed · ${tool} · stdout: · ${outputLines.length - 1} more lines`,
    ),
    compact,
  );
  assert.doesNotMatch(compact, /finalOutputLine|\/expand/);

  const details = chatRows(events, 80, "details")
    .map((row) => row.text)
    .join("\n");
  assert.ok(details.includes("src/generated.ts"));
  assert.ok(details.includes("export function render"));
  assert.ok(details.includes(`Output · ${outputLines.length} lines ·`));
  assert.ok(details.includes(`… ${outputLines.length - 6} more lines`));
  assert.ok(details.includes(`… ${output.length - 1_200} characters omitted`));
  assert.ok(!details.includes("finalOutputLine"));

  const expanded = chatRows(events, 80, "expanded")
    .map((row) => row.text)
    .join("\n");
  assert.ok(expanded.includes("src/generated.ts"));
  assert.ok(expanded.includes("export function render"));
  assert.ok(
    expanded.includes(`… ${output.length - 16 * 1024} characters omitted`),
  );
  assert.ok(!expanded.includes("finalOutputLine"));

  const assistantError = "Assistant run failed: fixture command exited 2.";
  const errors = chatRows(
    [
      ...events,
      {
        seq: 3,
        at: "2026-09-15T10:00:02.000Z",
        kind: "error" as const,
        type: "run.error",
        text: assistantError,
      },
    ],
    80,
    "compact",
  );
  assert.ok(errors.some((row) => row.text === assistantError));
  assert.ok(errors.some((row) => row.style === "role-error"));
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
  assert.match(
    result,
    /│ last▌_/,
    "the block cursor sits at the real position, not at a literal underscore",
  );
  assert.match(
    result,
    /│ third/,
    "the active prompt uses the composer rail, not a '> ' marker",
  );
  assert.doesNotMatch(result, /^> /m);
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
          finish_reason:
            body.messages.at(-1).role === "tool" ? "stop" : "tool_calls",
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
    ["Hello"],
    "a stream delta is shown as the answer text, without a label",
  );
  const result = transcript([
    { ...base, type: "message.delta", text: "Hello" },
    { ...base, seq: 2, type: "message.completed", text: "Hello" },
  ]);
  assert.equal(result.filter((s) => s === "Hello").length, 1);
  assert.doesNotMatch(result.join("\n"), /\[stream\]/);
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
      {
        color: true,
        command: "/",
        suggestion: 18,
        frame: 2,
        capabilities: colorCaps(w!, h!),
      },
    );
    assert.ok(frame.includes("\x1b["));
    assert.ok(!frame.includes("\x1b[2J"));
    assert.ok(frame.split("\n").length <= h!);
    assert.ok(frame.split("\n").every((line) => visibleLength(line) <= w!));
  }
  const still = (frame: number) =>
    renderWorkspace(ui, 80, 30, "_", true, true, { frame, motion: false });
  assert.equal(still(0), still(9));
  // Motion is a slow blink: the caret holds one glyph for four frames and
  // then switches, so the two halves of the cycle must differ.
  assert.notEqual(
    renderWorkspace(ui, 80, 30, "_", true, true, { frame: 0 }),
    renderWorkspace(ui, 80, 30, "_", true, true, { frame: 4 }),
  );
  assert.deepEqual(
    commandSuggestions("/led").map(([name]) => name),
    ["/ledger"],
  );
  assert.ok(commandSuggestions("/rs").some(([name]) => name === "/resume"));
  assert.ok(commandSuggestions("/rw").some(([name]) => name === "/rewind"));
  assert.equal(commandSuggestions("/new delete everything").length, 0);
});

test("regular chat keeps the supplied grid NOMO mark across sizes and preserves boot splash", async (t) => {
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
        capabilities: colorCaps(width, height),
      });
      const text = stripAnsi(frame);
      // The grid mark needs room for six 6x6 rows; below that the compact
      // mark carries the same identity.
      const grid = width >= 68 && height >= 22;
      const rows = text.split("\n");
      assert.ok(text.includes("NOMO"), `${width}x${height} lacks the NOMO identity`);
      assert.ok(
        text.includes(grid ? "██" : "▦"),
        `${width}x${height} lacks the ${grid ? "grid" : "compact"} mark`,
      );
      if (!grid)
        assert.ok(
          !text.includes("██"),
          `${width}x${height} keeps the grid off a narrow header`,
        );
      if (grid) {
        assert.ok(
          rows[2]!.includes("NOMO  Chat"),
          `${width}x${height} lacks the Chat header`,
        );
        assert.ok(
          text.includes("NEW CONVERSATION"),
          `${width}x${height} lacks the conversation title`,
        );
      }
      // The dock carries the model behind its glyph. A narrow terminal clips
      // the name to the cells it has, so the prefix is the contract there and
      // the full id is required once the row has room.
      assert.ok(
        text.includes(width >= 80 ? "◐ fixture-model" : "◐ fixtur"),
        `${width}x${height} lacks model status`,
      );
      assert.ok(
        text.includes("╭─ Draft"),
        `${width}x${height} loses the framed composer`,
      );
      assert.ok(
        text.includes("Tab to write"),
        `${width}x${height} loses the unfocused composer hint`,
      );
      assert.doesNotMatch(
        text,
        /│[^│]*[█▌]/,
        `${width}x${height} fakes an editing cursor while unfocused`,
      );
      assert.ok(
        text.includes("← Sessions"),
        `${width}x${height} loses the panel dock`,
      );
      assert.ok(frame.split("\n").length <= height);
      assert.ok(
        frame.split("\n").every((line) => visibleLength(line) <= width),
      );
      assert.ok(
        !frame.includes("\x1b[│m"),
        `${width}x${height} contains a malformed color escape`,
      );
      assert.ok(
        !/\?\[[0-9;]*m/.test(text),
        `${width}x${height} shows escaped shortcut styles`,
      );
      assert.equal(frame.includes("\x1b["), color);
    }
  }

  const boot = stripAnsi(
    renderWorkspace(ui, 80, 24, "", false, false, {
      boot: true,
      color: false,
      motion: false,
    }),
  );
  assert.ok(boot.includes("NOMO  Chat"));
  assert.ok(boot.includes("██"));
});

test("spacious workspace identifies the active panel", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "nomo-tui-panel-heading-"));
  const app = new Workbench({ NOMO_DATA_DIR: root });
  t.after(async () => {
    await app.shutdown();
    await rm(root, { recursive: true, force: true });
  });
  const ui = new WorkspaceTui(app, { NOMO_DATA_DIR: root });
  for (const tab of [
    "sessions",
    "documents",
    "approvals",
    "models",
    "usage",
  ] as const) {
    ui.choose(tab);
    for (const [width, height] of [
      [80, 24],
      [120, 40],
      [200, 48],
    ] as const) {
      for (const color of [true, false]) {
        const frame = stripAnsi(
          renderWorkspace(ui, width, height, "", false, false, {
            color,
            motion: false,
          }),
        );
        const rows = frame.split("\n");
        const title = `${tab[0]!.toUpperCase()}${tab.slice(1)}`;
        // The panel header names the identity, a semantic icon and the tab.
        assert.match(
          rows[0] ?? "",
          new RegExp(`^ NOMO  \\S+ ${title}`),
          `${width}x${height} hides ${tab}`,
        );
        assert.match(rows[1] ?? "", /← Chat/, `${width}x${height} loses the way back`);
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
      capabilities: colorCaps(40, 12),
    });
    // The preview wraps to 40 columns, so join the rows before asserting the
    // text an operator reads.
    const text = stripAnsi(frame);
    const joined = text.split("\n").join(" ");
    assert.ok(
      joined.includes("REVIEW PREVIEW:") &&
        joined.includes("local-fixture-change"),
      "the wrapped preview stays readable",
    );
    assert.ok(text.includes("SAVE plan.md?"));
    // The compact rail is the title row and it names the decision keys, so a
    // 40x12 frame never shows evidence without the way to answer the hold.
    assert.ok(
      text.includes("╭─ Review  y allow · n deny"),
      "the compact rail keeps the decision keys",
    );
    assert.ok(
      text.includes("Esc cancel"),
      "the compact dock keeps the cancel key",
    );
    assert.equal(frame.split("\n").length, 12);
    assert.ok(frame.split("\n").every((line) => visibleLength(line) <= 40));
    assert.equal(frame.includes("\x1b["), color);
  }

  // A compact terminal with room for the footer keeps the decision keys
  // visible next to the preview.
  for (const color of [true, false]) {
    const frame = renderWorkspace(ui, 40, 16, "", false, false, {
      color,
      motion: false,
      capabilities: colorCaps(40, 16),
    });
    const text = stripAnsi(frame);
    assert.ok(text.includes("y allow"));
    assert.ok(text.includes("n deny"));
    assert.ok(text.includes("Esc cancel"));
    // One row taller restores the full summary beside the legend. At 40
    // columns the authority label is clipped by one word, so its readable
    // prefix is what the frame can promise.
    assert.ok(
      text.includes("model fixture-model"),
      "the summary keeps the model",
    );
    assert.ok(
      text.includes("mode: normal (local only, not enforce"),
      "the summary keeps the local only authority label",
    );
    assert.equal(frame.split("\n").length, 16);
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
      capabilities: colorCaps(40, 12),
    });
    const text = stripAnsi(frame);
    const rows = frame.split("\n");
    if (!text.includes("PgDn preview")) {
      missing.push(`40x12 ${color ? "color" : "mono"} omits PgDn preview`);
    }
    // The evidence keeps the majority of the frame: at least three preview
    // rows stay readable next to the page cue and the one row review dock.
    for (const row of ["PREVIEW-ROW-1", "PREVIEW-ROW-2", "PREVIEW-ROW-3"]) {
      assert.ok(text.includes(row), `40x12 keeps ${row}`);
    }
    // The rail names every decision key, so the preview never hides the way
    // to answer the hold.
    assert.ok(
      text.includes("╭─ Review  y allow · n deny"),
      "the compact rail keeps the decision keys",
    );
    assert.ok(text.includes("Esc cancel"), "the cancel key stays visible");
    assert.equal(rows.length, 12);
    assert.ok(rows.every((row) => visibleLength(row) <= 40));
    assert.equal(frame.includes("\x1b["), color);

    ui.scrollPage(1);
    const next = renderWorkspace(ui, 40, 12, "", false, false, {
      color,
      motion: false,
      capabilities: colorCaps(40, 12),
    });
    // One page advances the preview window, so the first row is scrolled out
    // and the last evidence row takes its place. Nothing applies.
    assert.ok(stripAnsi(next).includes("PREVIEW-ROW-3"));
    assert.ok(!stripAnsi(next).includes("PREVIEW-ROW-1"));
    assert.ok(
      stripAnsi(next).includes("PREVIEW-ROW-8"),
      "paging reaches the tail evidence",
    );
    assert.ok(
      stripAnsi(next).includes("╭─ Review  y allow · n deny"),
      "the decision keys stay put while the evidence scrolls",
    );
    assert.equal(applyCalls, 0);
    assert.equal(next.split("\n").length, 12);
    assert.ok(next.split("\n").every((row) => visibleLength(row) <= 40));
    assert.equal(next.includes("\x1b["), color);
  }

  // One row taller is enough for the compact legend and the review status
  // row, so both must name every decision key without executing anything.
  for (const color of [true, false]) {
    ui.scroll = 0;
    const frame = renderWorkspace(ui, 40, 16, "", false, false, {
      color,
      motion: false,
      capabilities: colorCaps(40, 16),
    });
    const text = stripAnsi(frame);
    assert.ok(text.includes("PREVIEW-ROW-1"));
    assert.ok(text.includes("y allow · n deny · Esc cancel"));
    assert.ok(text.includes("Review y allow n deny Esc cancel"));
    assert.equal(applyCalls, 0);
    assert.equal(frame.split("\n").length, 16);
    assert.ok(frame.split("\n").every((row) => visibleLength(row) <= 40));
    assert.equal(frame.includes("\x1b["), color);
  }

  for (const color of [true, false]) {
    const frame = renderWorkspace(ui, 80, 24, "", false, false, {
      color,
      motion: false,
      capabilities: colorCaps(80, 24),
    });
    const text = stripAnsi(frame);
    assert.ok(text.includes("PgDn preview"));
    assert.ok(text.includes("y allow"));
    assert.ok(text.includes("n deny"));
    assert.ok(text.includes("Esc cancel"));
    assert.equal(frame.split("\n").length, 24);
    assert.ok(frame.split("\n").every((row) => visibleLength(row) <= 80));
    assert.equal(frame.includes("\x1b["), color);
  }
  assert.deepEqual(missing, []);
  // Rendering, paging and the wider frames above are not decisions: the
  // runner maps only y to ui.confirm() (workspace-runner.ts:2153), so the
  // preview must not have applied anything yet.
  assert.equal(applyCalls, 0);
  await ui.confirm();
  assert.equal(applyCalls, 1, "y accept applies the preview once");
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
    [40, 12, "◐ offline"],
    [80, 24, "▤ unknown —"],
  ] as const) {
    for (const color of [true, false]) {
      const frame = renderWorkspace(ui, width, height, "", false, false, {
        color,
        motion: false,
        capabilities: colorCaps(width, height),
      });
      const lines = stripAnsi(frame).split("\n");
      const text = lines.join("\n");
      // The Chat dock names the model, the context in force and the way back
      // to the panel list.
      assert.ok(
        text.includes("◐ offline"),
        `${width}x${height} loses the model dock`,
      );
      assert.ok(
        text.includes("← Sessions"),
        `${width}x${height} loses the panel dock`,
      );
      if (!text.includes(required)) {
        missing.push(
          `${width}x${height} ${color ? "color" : "mono"}: ${required}`,
        );
      }
      // The activity dock keeps every count it reports.
      for (const glyph of ["◆ 0", "♥", ">_ 0", "≡ 0"])
        assert.ok(text.includes(glyph), `${width}x${height} loses ${glyph}`);
      assert.ok(
        lines.some((line) => line.trimStart().startsWith("╰")),
        `${width}x${height} composer framing`,
      );
      assert.ok(
        text.includes("╭─ Draft"),
        `${width}x${height} loses the composer`,
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
  for (const [width, height] of [
    [40, 12],
    [80, 24],
  ] as const) {
    for (const color of [true, false]) {
      const rows = stripAnsi(
        renderWorkspace(ui, width, height, "", false, false, {
          color,
          motion: false,
        }),
      ).split("\n");
      // The dock renders the model behind its glyph. The 40-column row has
      // room for a prefix only, so the full id is required once it fits.
      assert.ok(
        rows.some((row) =>
          row.includes(width >= 80 ? "◐ fixture-model" : "◐ fixtur"),
        ),
        `${width}x${height} loses the model dock`,
      );
      assert.ok(
        rows.every((row) => !row.includes("local only, not enforced")),
        `${width}x${height} leaves the authority label to the panel footer`,
      );
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
    let composerTop = -1;
    let composerBottom = -1;
    for (let row = 0; row < lines.length; row++)
      if (lines[row]!.includes("╭─ Draft")) composerTop = row;
    for (let row = lines.length - 1; row >= 0; row--) {
      if (lines[row]!.trimStart().startsWith("╰")) {
        composerBottom = row;
        break;
      }
    }
    // The dock row carries the model behind its glyph and clips the id at 40
    // columns, so the shared prefix identifies the row at every size. The
    // composer rail also names the model in its chip, so the dock is looked
    // for below the composer rather than anywhere in the frame.
    const summary = lines.findIndex(
      (line, index) => index > composerBottom && line.includes("◐ fixtur"),
    );
    const activity = lines.findIndex((line) => line.includes("◆ 0"));
    assert.ok(
      composerTop >= 0,
      `${width}x${height} loses the composer surface`,
    );
    assert.ok(
      composerBottom > composerTop,
      `${width}x${height} composer framing`,
    );
    assert.ok(
      summary > composerBottom,
      `${width}x${height} summary is above composer`,
    );
    assert.ok(
      activity > summary,
      `${width}x${height} activity is above the summary`,
    );
    assert.equal(
      activity,
      height - 1,
      `${width}x${height} activity is not the bottom rail`,
    );
    assert.ok(lines.some((line) => line.includes("← Sessions")));
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
      !mono.some(
        (line) => line.trim().startsWith("┌") || line.trim().startsWith("└"),
      ),
      `${width}x${height} retains a square boxed composer`,
    );

    // The framed composer is the current contract, and the docks sit under it.
    const composer = mono.findIndex((line) => line.includes("╭─ Draft"));
    const composerBottom = mono.findIndex((line) =>
      line.trimStart().startsWith("╰"),
    );
    const model = mono.findIndex(
      (line, index) =>
        index > composerBottom && line.includes("◐ fixture-model"),
    );
    const counts = mono.findIndex((line) => line.includes("◆ 0 subagents"));
    assert.ok(composer >= 0, `${width}x${height} loses the composer`);
    assert.ok(
      composerBottom > composer,
      `${width}x${height} loses the composer bottom rule`,
    );
    assert.ok(
      model > composerBottom && counts > model,
      `${width}x${height} misorders the dock`,
    );
    const panelHintRows = mono.filter((line) =>
      line.trimStart().startsWith("← Sessions"),
    );
    assert.equal(
      panelHintRows.length,
      1,
      `${width}x${height} loses the panel hint`,
    );
    assert.ok(
      !mono.some(
        (line) =>
          line.includes("Enter open/details") ||
          line.includes("Shift+Tab") ||
          line.includes("⇒ u undo"),
      ),
      `${width}x${height} restores verbose shortcut hints`,
    );
    assert.ok(
      counts < height,
      `${width}x${height} loses compact live counts`,
    );
    assert.ok(mono[height - 1]!.includes("◆ 0 subagents"));

    const color = renderWorkspace(ui, width, height, "", false, false, {
      color: true,
      motion: false,
      capabilities: colorCaps(width, height),
    }).split("\n");
    assert.ok(
      color[composer]!.includes("\x1b["),
      `${width}x${height} loses the painted composer rail`,
    );
    assert.ok(
      !color.some((row) => row.includes("48;5;234")),
      "canvas uses terminal background",
    );
    assert.equal(visibleLength(stripAnsi(color[composer]!)), width);
    assert.ok(
      !mono[composer]!.includes("▌"),
      "inactive composer must not fake an editing cursor",
    );
  }
  const boot = stripAnsi(
    renderWorkspace(ui, 80, 24, "", false, false, {
      color: false,
      motion: false,
      boot: true,
    }),
  ).split("\n");
  assert.equal(boot.length, 24);
  // The boot splash keeps the grid mark, with the wordmark on its third row.
  assert.ok(boot[0]!.includes("██"), "boot splash loses the grid mark");
  assert.ok(
    boot.some((line) => /NOMO {2}Chat/.test(line)),
    "boot splash loses the wordmark",
  );
  assert.ok(boot.some((line) => line.trimStart().startsWith("← Sessions")));
});

test("empty workspace views identify panels and keep placeholders in the body", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "nomo-tui-empty-placement-"));
  const app = new Workbench({ NOMO_DATA_DIR: root });
  t.after(async () => {
    await app.shutdown();
    await rm(root, { recursive: true, force: true });
  });
  const ui = new WorkspaceTui(app, { NOMO_DATA_DIR: root });
  await ui.initialize();
  const tabs = [
    "sessions",
    "documents",
    "approvals",
    "models",
    "usage",
  ] as const;
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
          capabilities: colorCaps(width, height),
        });
        const rows = stripAnsi(frame).split("\n");
        // Every panel names itself in the header and offers the way back.
        const panelTitle = `${tab.charAt(0).toUpperCase()}${tab.slice(1)}`;
        assert.ok(
          rows[0]?.includes(panelTitle),
          `${tab} ${width}x${height} lacks its semantic panel title`,
        );
        const bodyStart = rows.findIndex((row) => row.includes("← Chat")) + 1;
        const bodyEnd = bodyStart + ui.viewport.height - 1;
        // Each panel states its own empty contract. A shared "No entries yet."
        // would hide which view is empty, so the per-view sentence is the
        // assertion and the guidance line is checked where the body has room.
        const emptyText =
          tab === "models"
            ? "No provider is configured."
            : tab === "sessions"
              ? "No sessions yet. /new starts one."
              : tab === "documents"
                ? "No managed documents yet."
                : tab === "approvals"
                  ? "No approvals waiting."
                  : "No usage records yet.";
        const sectionTitle =
          tab === "sessions"
            ? "SESSIONS"
            : tab === "documents"
              ? "DOCUMENT TREE"
              : tab === "approvals"
                ? "REVIEW QUEUE"
                : tab === "models"
                  ? "MODELS"
                  : "TOKEN ACTIVITY";
        const guidance =
          tab === "sessions"
            ? "/new starts one."
            : tab === "documents"
              ? "Use /document PATH"
              : tab === "approvals"
                ? undefined
                : tab === "models"
                  ? "Configure a provider with /connect"
                  : "Provider-reported usage appears";
        const placeholder = rows.findIndex((row) => row.includes(emptyText));

        assert.ok(
          bodyStart > 0,
          `${tab} ${width}x${height} loses its body header`,
        );
        assert.ok(
          rows.slice(bodyStart, bodyEnd + 1).some((row) => row.includes(sectionTitle)),
          `${tab} ${width}x${height} loses its body section title`,
        );
        assert.ok(
          placeholder >= bodyStart,
          `${tab} ${width}x${height} loses its empty message`,
        );
        assert.ok(
          placeholder <= bodyEnd,
          `${tab} ${width}x${height} moves its message outside the body`,
        );
        if (guidance && width >= 80)
          assert.ok(
            rows.slice(bodyStart, bodyEnd + 1).some((row) => row.includes(guidance)),
            `${tab} ${width}x${height} loses its guidance line`,
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
  // The panel title names the screen; the body opens on the first group.
  assert.ok(settings.includes("⚙ Settings"), "the panel keeps its title");
  assert.match(settings, /⚙ SETTINGS · \d+\/\d+ · APPEARANCE/);
  assert.ok(settings.includes("APPEARANCE"));
  // The rest of the catalog is below the visible body, so the contract is the
  // detail list rather than the frame. Rows speak in operator language, not
  // in storage keys, and descriptions keep whole words.
  const settingsDetail = ui.detail?.join("\n") ?? "";
  assert.ok(settingsDetail.includes("HARNESS"), "the catalog keeps harness rows");
  assert.ok(settingsDetail.includes("Turns per run"));
  assert.ok(
    settingsDetail.includes("Use terminal color when supported."),
    "settings descriptions should not split words",
  );
  const narrowSettings = stripAnsi(
    renderWorkspace(ui, 40, 12, "", false, false, {
      color: false,
      motion: false,
    }),
  );
  // A narrow frame keeps the panel title and the group it can show; the
  // catalog header row scrolls out before the rows do.
  assert.match(narrowSettings, /⚙ Settings/);
  assert.ok(
    narrowSettings.includes("APPEARANCE"),
    "the narrow settings panel keeps its first group",
  );
  assert.ok(
    narrowSettings.split("\n").every((line) => visibleLength(line) <= 40),
    "the settings panel stays inside a narrow terminal",
  );
  await ui.command("/settings maxTurns 19");
  assert.equal(app.harnessSettings().maxTurns, 19);

  await ui.command("/theme");
  // /theme writes its usage into the detail list while the settings surface
  // stays open, so the detail is where the theme contract lives.
  const theme = ui.detail?.join("\n") ?? "";
  assert.ok(theme.includes("THEME: default + unicode"));
  assert.ok(theme.includes("Usage: /theme <color-theme>"));
  assert.ok(
    theme.includes("symbol-preset"),
    "theme usage should wrap before whole words",
  );
  assert.ok(theme.includes("NOMO_TUI_THEME"));
  assert.ok(theme.includes("NOMO_TUI_SYMBOLS"));
  const themeFrame = stripAnsi(
    renderWorkspace(ui, 80, 24, "", false, false, {
      color: false,
      motion: false,
    }),
  );
  assert.match(themeFrame, /⚙ Settings/);
  assert.ok(
    themeFrame.includes("Turns per run = 19"),
    "the applied harness setting stays visible",
  );
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
  const userPlan = chatRows([{ ...base, kind: "user", text: "# Plan" }], 40);
  assert.ok(
    userPlan.some((r) => r.style === "user" && r.text.includes("# Plan")),
    "a plain user-authored # Plan remains literal in the user row",
  );
  assert.ok(
    !userPlan.some((r) => r.style === "heading" && r.text.includes("Plan")),
    "user-authored # Plan is not parsed as a heading",
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
/** A provider stream with a real reasoning channel before the answer. The
 * Workbench records those deltas as `reasoning.delta`, which is the only
 * source the Chat renderer may present as thinking. */
const reasoningStreamFetcher =
  (reasoning: string, answer: string) => async (url: unknown) => {
    if (String(url).endsWith("/models"))
      return Response.json({ data: [{ id: "fixture-model" }] });
    const frame = (delta: Record<string, unknown>, finish?: string) =>
      `data: ${JSON.stringify({
        choices: [
          {
            index: 0,
            delta,
            ...(finish === undefined ? {} : { finish_reason: finish }),
          },
        ],
      })}\n\n`;
    return new Response(
      [
        frame({ reasoning_content: reasoning }),
        frame({ content: answer }),
        frame({}, "stop"),
        "data: [DONE]\n\n",
      ].join(""),
      { headers: { "content-type": "text/event-stream" } },
    );
  };
const reasoningBase = {
  seq: 1,
  at: "2026-11-20T10:00:00.000Z",
  kind: "assistant" as const,
};
const reasoningEvent = (seq: number, text: string) => ({
  ...reasoningBase,
  seq,
  type: "reasoning.delta",
  text,
  payload: { text },
});
test("real reasoning deltas render as a labeled thinking block before the answer", () => {
  const rows = chatRows(
    [
      reasoningEvent(1, "Weigh the options. "),
      reasoningEvent(2, "Then answer."),
      { ...reasoningBase, seq: 3, type: "message.completed", text: "Answer." },
    ],
    80,
    "details",
    "comfortable",
    false,
    false,
    "unicode",
    24,
  );
  const label = rows.findIndex((row) => row.text === "~ thinking");
  assert.ok(label >= 0, "the real reasoning event is labeled");
  assert.equal(rows[label]!.style, "reasoning");
  const body = rows
    .slice(label + 1)
    .filter((row) => row.style === "reasoning" && row.text.startsWith("  "))
    .map((row) => row.text.trim());
  assert.equal(
    body.join(" "),
    "Weigh the options. Then answer.",
    "the recorded reasoning text is shown, not invented",
  );
  const answer = rows.findIndex((row) => row.text === "Answer.");
  assert.ok(answer > label, "reasoning stays before the answer it precedes");
  assert.ok(
    !rows.some(
      (row) => row.style === "reasoning" && row.text.includes("Answer."),
    ),
    "the answer is never folded into the reasoning block",
  );
  // A tool card after the reasoning keeps its own row and order.
  const withTool = chatRows(
    [
      reasoningEvent(1, "Plan the call."),
      {
        ...reasoningBase,
        seq: 2,
        kind: "tool" as const,
        type: "tool.started",
        text: "Requested nomo_project_read.",
        payload: {
          tool: "nomo_project_read",
          callId: "call_1",
          arguments: { path: "plan.md" },
        },
      },
      { ...reasoningBase, seq: 3, type: "message.completed", text: "Answer." },
    ],
    80,
    "details",
    "comfortable",
    false,
    false,
    "unicode",
    24,
  );
  const toolRow = withTool.findIndex((row) => row.style === "role-tool");
  assert.ok(toolRow >= 0, "the tool card survives the reasoning block");
  assert.ok(
    withTool.findIndex((row) => row.text === "~ thinking") < toolRow,
    "reasoning stays ahead of the tool card it preceded",
  );
  assert.ok(withTool.some((row) => row.text === "Answer."));
});
test("a session without a reasoning event renders no thinking block", () => {
  const rows = chatRows(
    [
      { ...reasoningBase, kind: "user" as const, seq: 1, text: "Question." },
      { ...reasoningBase, seq: 2, type: "message.completed", text: "Answer." },
    ],
    80,
  );
  assert.ok(!rows.some((row) => row.style === "reasoning"));
  assert.ok(!rows.some((row) => row.text.includes("thinking")));
  // Time and phase alone are never a source of thinking text.
  const running = chatRows(
    [
      { ...reasoningBase, seq: 1, text: "Question.", kind: "user" as const },
      {
        ...reasoningBase,
        seq: 2,
        type: "run.status",
        text: "Responding",
      },
    ],
    80,
  );
  assert.ok(!running.some((row) => row.text.includes("thinking")));
});
test("long reasoning truncates with a named hidden line count", () => {
  const long = Array.from({ length: 30 }, (_, index) => `thought-${index + 1}`)
    .join(" ");
  const rows = chatRows(
    [reasoningEvent(1, long)],
    80,
    "details",
    "comfortable",
    false,
    false,
    "unicode",
    24,
  );
  const label = rows.findIndex((row) => row.text === "~ thinking");
  assert.ok(label >= 0);
  const hidden = rows.findIndex((row) =>
    /more thinking lines/.test(row.text),
  );
  assert.ok(hidden > label, "the hidden count is named");
  assert.match(
    rows[hidden]!.text,
    /^ {2}\.\.\. \d+ more thinking lines · Ctrl\+O(?: expand)?$/,
  );
  // 80x24 keeps three reasoning lines, all of them inside the width.
  assert.equal(hidden - label - 1, 3);
  assert.ok(
    rows.every((row) => visibleLength(row.text) <= 80),
    "no reasoning row overflows the terminal",
  );
  // A narrow 40x12 terminal keeps one line and still names the remainder.
  const compact = chatRows(
    [reasoningEvent(1, long)],
    40,
    "details",
    "comfortable",
    false,
    false,
    "unicode",
    12,
  );
  const compactLabel = compact.findIndex((row) => row.text === "~ thinking");
  const compactHidden = compact.findIndex((row) =>
    /more thinking lines/.test(row.text),
  );
  assert.ok(compactHidden > compactLabel);
  assert.equal(compactHidden - compactLabel - 1, 1);
  assert.ok(compact.every((row) => visibleLength(row.text) <= 40));
});
test("Ctrl+O expanded activity reveals the whole reasoning block", () => {
  // Ctrl+O walks the existing activity cycle; the expanded state is what
  // reveals every recorded reasoning line, and leaving it collapses again.
  assert.equal(nextToolActivityMode("details"), "expanded");
  assert.equal(nextToolActivityMode("expanded"), "compact");
  const long = Array.from({ length: 30 }, (_, index) => `thought-${index + 1}`)
    .join(" ");
  const collapsed = chatRows(
    [reasoningEvent(1, long)],
    80,
    "details",
    "comfortable",
    false,
    false,
    "unicode",
    24,
  );
  const expanded = chatRows(
    [reasoningEvent(1, long)],
    80,
    "expanded",
    "comfortable",
    false,
    false,
    "unicode",
    24,
  );
  assert.ok(
    expanded.filter((row) => row.style === "reasoning").length >
      collapsed.filter((row) => row.style === "reasoning").length,
    "expanded shows more reasoning rows",
  );
  assert.ok(
    expanded.some((row) => row.text === "~ thinking · expanded"),
    "the expanded state is named without colour",
  );
  assert.ok(
    !expanded.some((row) => /more thinking lines/.test(row.text)),
    "expanded hides nothing",
  );
  assert.ok(
    expanded.some((row) => row.text.includes("thought-30")),
    "expanded reaches the end of the recorded reasoning",
  );
  assert.ok(expanded.every((row) => visibleLength(row.text) <= 80));
});
test("reasoning rows keep the composer and approval keys at 40x12", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "nomo-tui-reasoning-compact-"));
  const app = new Workbench(
    { NOMO_DATA_DIR: root },
    reasoningStreamFetcher(
      Array.from({ length: 20 }, (_, index) => `thought-${index + 1}`).join(
        " ",
      ),
      "Answer.",
    ),
  );
  t.after(async () => {
    await app.shutdown();
    await rm(root, { recursive: true, force: true });
  });
  await app.configure({
    baseUrl: "https://fixture.test/v1",
    apiKey: "private-fixture",
  });
  const ui = new WorkspaceTui(app, { NOMO_DATA_DIR: root });
  ui.model = "fixture-model";
  ui.choose("chat");
  await ui.command("Question.");
  await app.settled();
  const events = ui.session()?.events ?? [];
  assert.ok(
    events.some((event) => event.type === "reasoning.delta"),
    "the fixture recorded real reasoning",
  );

  // The composer keeps its key even while the reasoning block is on screen.
  const chatFrame = renderWorkspace(ui, 40, 12, "", true, false, {
    color: false,
    motion: false,
    capabilities: colorCaps(40, 12),
  });
  const chatText = stripAnsi(chatFrame);
  assert.ok(chatText.includes("Enter send"), "the composer key stays visible");
  assert.ok(
    chatFrame.split("\n").every((line) => visibleLength(line) <= 40),
  );

  // A pending hold owns the body, and its decision keys stay visible.
  ui.confirmation = {
    title: "SAVE plan.md?",
    lines: ["REVIEW PREVIEW: local-fixture-change"],
    apply: async () => {},
  };
  const reviewFrame = renderWorkspace(ui, 40, 12, "", true, false, {
    color: false,
    motion: false,
    capabilities: colorCaps(40, 12),
  });
  const reviewText = stripAnsi(reviewFrame);
  assert.ok(reviewText.includes("y allow"), "the allow key stays visible");
  assert.ok(reviewText.includes("n deny"), "the deny key stays visible");
  assert.ok(reviewText.includes("Esc cancel"), "the cancel key stays visible");
  assert.equal(reviewFrame.split("\n").length, 12);
  assert.ok(
    reviewFrame.split("\n").every((line) => visibleLength(line) <= 40),
  );
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
  assert.ok(
    events.some(
      (event) =>
        event.kind === "user" && event.text === "Local fixture user note",
    ),
  );
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
        capabilities: colorCaps(width, height),
      });
      const rows = frame.split("\n");
      const plainRows = stripAnsi(frame).split("\n");
      assert.equal(rows.length, height);
      assert.ok(rows.every((row) => visibleLength(row) <= width));
      assert.equal(frame.includes("\x1b["), color);
      if (width === 40) {
        // A 40x12 chat viewport scrolls to the tail: the error guidance is
        // readable and the earlier user row is off screen, never rewritten.
        assert.ok(
          plainRows.some((row) => row.includes("Try again later.")),
          "the compact viewport keeps the error guidance",
        );
        assert.ok(
          plainRows.some((row) => row.includes("failed · see above")),
          "the compact viewport keeps the tool outcome",
        );
        assert.ok(
          !plainRows.some((row) => row.includes("Local fixture user note")),
        );
        continue;
      }

      const userRow = plainRows.findIndex((row) =>
        row.includes("Local fixture user note"),
      );
      const errorRow = plainRows.findIndex((row) => row.includes("× ERROR"));
      assert.ok(
        userRow >= 0,
        `${width}x${height} hides the existing user message`,
      );
      assert.equal(
        errorRow,
        userRow + 1,
        `${width}x${height} inserts space before the error`,
      );
      assert.ok(plainRows[errorRow]!.includes("ERROR"));
      if (color)
        assert.ok(
          /\x1b\[/.test(rows[userRow]!),
          `${width}x${height} loses the painted user row`,
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
  assert.ok(
    text.includes("← Sessions"),
    "running 40x12 chat hides the panel dock",
  );
  assert.ok(
    text.includes("╭─ Draft"),
    "running 40x12 chat hides the framed composer",
  );
  assert.ok(frame.split("\n").every((line) => visibleLength(line) <= 40));
});

test("running 40x12 chat keeps the last row, the closed composer and the stop hint", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "nomo-tui-compact-run-"));
  const encoder = new TextEncoder();
  let streamController: ReadableStreamDefaultController<Uint8Array> | undefined;
  const deltaFrame = (content: string) =>
    `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`;
  const app = new Workbench({ NOMO_DATA_DIR: root }, async (url) => {
    const target = String(url);
    if (target.endsWith("/models"))
      return Response.json({ data: [{ id: "fixture-model" }] });
    if (target.endsWith("/chat/completions")) {
      // The stream stays open, so the frame below is rendered while the run
      // is genuinely in flight rather than after it settled.
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          streamController = controller;
          controller.enqueue(encoder.encode(deltaFrame("LAST-VISIBLE-ROW")));
        },
      });
      return new Response(stream, {
        headers: { "content-type": "text/event-stream" },
      });
    }
    return new Response("{}", { status: 404 });
  });
  t.after(async () => {
    try {
      streamController?.close();
    } catch {
      // The stream is already closed when the run settled on its own.
    }
    await app.shutdown();
    await rm(root, { recursive: true, force: true });
  });
  await app.configure({
    baseUrl: "https://fixture.invalid/v1",
    apiKey: "local-fixture-only",
  });
  const ui = new WorkspaceTui(app, { NOMO_DATA_DIR: root });
  ui.model = "fixture-model";
  await ui.command("Compact run fixture");
  const sessionId = ui.sessionId;
  assert.ok(sessionId);
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const events = app.get(sessionId)?.events ?? [];
    if (events.some((event) => event.type === "message.delta")) break;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.ok(
    (app.get(sessionId)?.events ?? []).some(
      (event) => event.type === "message.delta",
    ),
    "the fixture recorded a real delta",
  );
  const rows = stripAnsi(
    renderWorkspace(ui, 40, 12, "", false, false, {
      color: false,
      motion: false,
      capabilities: colorCaps(40, 12),
    }),
  ).split("\n");
  const text = rows.join("\n");
  assert.equal(rows.length, 12);
  assert.ok(rows.every((row) => visibleLength(row) <= 40));
  assert.ok(
    text.includes("LAST-VISIBLE-ROW"),
    "the last transcript row stays on screen",
  );
  assert.ok(text.includes("╭─ Draft"), "the composer keeps its top rail");
  assert.ok(
    rows.some((row) => row.includes("╰") && row.includes("╯")),
    "the composer keeps its closed bottom rail",
  );
  assert.ok(
    text.includes("Esc stop"),
    "the stop hint stays visible while the run is in flight",
  );
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
          finish_reason:
            body.messages.at(-1).role === "tool" ? "stop" : "tool_calls",
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
  // The authority label lives in the panel footer, not in the Chat dock.
  assert.doesNotMatch(
    stripAnsi(renderWorkspace(ui, 100, 32)),
    /mode: plan \(local only, not enforced\)/,
  );
  ui.choose("runs");
  assert.match(
    stripAnsi(renderWorkspace(ui, 100, 32)),
    /mode: plan \(local only, not enforced\)/,
  );
  // The canonical wording is the one the panel footer prints, and the Chat
  // dock never duplicates it.
  assert.equal(
    modeAuthorityLabel(ui.mode),
    "mode: plan (local only, not enforced)",
  );
  assert.ok(
    ui.statusLines().every((line) => !line.includes("local only, not enforced")),
    "the dock does not duplicate the authority label",
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
      // Colour is requested explicitly: the test runner is not a TTY, so
      // renderWorkspace would otherwise stay monochrome regardless of `color`.
      const frame = renderWorkspace(ui, width, height, "", false, false, {
        color,
        motion: false,
        capabilities: colorCaps(width, height),
      });
      const text = stripAnsi(frame);
      assert.ok(text.includes("APPROVE LOCAL FIXTURE?"));
      assert.ok(text.includes("tool           fixture.db.update"));
      assert.equal(frame.includes("\x1b["), color);
      assert.equal(frame.split("\n").length, height);
      assert.ok(
        frame.split("\n").every((line) => visibleLength(line) <= width),
      );
      if (width >= 80) {
        assert.ok(text.includes("class          R2"));
        assert.ok(text.includes("blast radius   1 targets, measured"));
        assert.ok(text.includes("matched rule   fixture rule"));
        assert.ok(text.includes("precondition   fixture row remains present"));
        assert.ok(text.includes("postcondition  fixture row would change"));
        // A wide frame has room for the decision legend.
        assert.ok(text.includes("y allow · n deny · Esc cancel"));
      } else {
        // The compact frame keeps the evidence that fits and clips the
        // precondition value, but never invents or rewrites a value. Its one
        // dock row still names every decision key.
        assert.ok(text.includes("class          R2"));
        assert.ok(text.includes("blast radius   1 targets, measured"));
        assert.ok(text.includes("matched rule   fixture rule"));
        assert.ok(
          text.includes("precondition   fixture row"),
          "the compact layout keeps the precondition evidence",
        );
        assert.ok(
          text.includes("╭─ Review  y allow · n deny"),
          "the compact rail keeps the decision keys",
        );
        assert.ok(text.includes("Esc cancel"), "the cancel key stays visible");
      }
      if (color && width === 80) {
        // Labels carry the accent and values stay neutral. Pinning the exact
        // RGB would test the palette rather than the field hierarchy.
        assert.ok(frame.includes("\x1b[1;38;5;117mtool           "));
        assert.match(frame, /\x1b\[38;2;[0-9;]+mfixture\.db\.update/);
        const titleRow = frame
          .split("\n")
          .find((row) => stripAnsi(row).includes("APPROVE LOCAL FIXTURE?"));
        assert.ok(titleRow, "the title row is rendered");
        assert.match(titleRow, /\x1b\[[0-9;]*m/, "the title row is painted");
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
        capabilities: colorCaps(width, height),
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
      assert.ok(
        frame.split("\n").every((line) => visibleLength(line) <= width),
      );
      if (color) {
        // The confirmation is painted and the Operation label is emphasised;
        // no other preview row is allowed to compete with it.
        const painted = frame.split("\n");
        assert.match(painted[operationRow]!, /\x1b\[/);
        assert.doesNotMatch(
          painted[operationRow]!,
          /\x1b\[1;38;5;215m/,
          "the Operation row is not painted as the title",
        );
      }
      if (width >= 80) {
        const driftRow = rows.findIndex((row) => row.includes(previewLines[1]));
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

// ---------------------------------------------------------------------------
// Chat work view: task header, TODO rail, subagent rail, tool cards, footer.
// ---------------------------------------------------------------------------

// A checklist as an assistant would actually write it. Every TODO row the
// renderer prints has to come from a message like this one, never from a
// structured todo event: no such event exists in the Workbench.
const workViewMarkdown = [
  "Plan:",
  "- [x] read the contract",
  "- [ ] write the failing test",
  "- [ ] run the suite",
  "- [ ] record evidence",
  "- [ ] hand off",
].join("\n");

const workViewFetcher = (content: string) => async (url: unknown) => {
  if (String(url).endsWith("/models"))
    return Response.json({ data: [{ id: "fixture" }] });
  return Response.json({
    choices: [
      { message: { role: "assistant", content }, finish_reason: "stop" },
    ],
    usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
  });
};

/**
 * A provider that records one structured checklist through the real tool, then
 * answers. `after` is the assistant message of the turn that follows the tool
 * call, so a test can prove which source owns the rail.
 */
const structuredTodoFetcher = (
  items: readonly { readonly text: string; readonly status: string }[],
  after = "Checklist recorded.",
) => {
  let called = false;
  return async (url: unknown, init?: RequestInit) => {
    if (String(url).endsWith("/models"))
      return Response.json({ data: [{ id: "fixture" }] });
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    const tool = (body.tools ?? []).find(
      (item: { function?: { description?: string } }) =>
        item.function?.description?.startsWith("todo_write:"),
    );
    if (tool && !called) {
      called = true;
      return Response.json({
        choices: [
          {
            message: {
              role: "assistant",
              content: null,
              tool_calls: [
                {
                  id: "todo-1",
                  type: "function",
                  function: {
                    name: tool.function.name,
                    arguments: JSON.stringify({ items }),
                  },
                },
              ],
            },
            finish_reason: "tool_calls",
          },
        ],
        usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
      });
    }
    return Response.json({
      choices: [
        { message: { role: "assistant", content: after }, finish_reason: "stop" },
      ],
    });
  };
};

test("the chat work view keeps its exact frame at five terminal sizes", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "nomo-tui-workview-sizes-"));
  const app = new Workbench(
    { NOMO_DATA_DIR: root },
    workViewFetcher(workViewMarkdown),
  );
  t.after(async () => {
    await app.shutdown();
    await rm(root, { recursive: true, force: true });
  });
  await app.configure({ baseUrl: "https://fixture.invalid/v1", apiKey: "fixture" });
  const session = await app.start("Work view", "fixture");
  await app.settled();
  const ui = new WorkspaceTui(app, { NOMO_DATA_DIR: root });
  await ui.command(`/open ${session.id}`);
  for (const [width, height] of [
    [40, 12],
    [60, 16],
    [80, 24],
    [100, 20],
    [120, 40],
  ] as const) {
    const rows = stripAnsi(
      renderWorkspace(ui, width, height, "", false, false, {
        color: false,
        motion: false,
      }),
    ).split("\n");
    assert.equal(rows.length, height, `${width}x${height} row count`);
    assert.ok(
      rows.every((row) => visibleLength(row) <= width),
      `${width}x${height} row width`,
    );
  }
});

test("the TODO rail and chip come from the assistant's real checklist", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "nomo-tui-workview-todo-"));
  const app = new Workbench(
    { NOMO_DATA_DIR: root },
    workViewFetcher(workViewMarkdown),
  );
  t.after(async () => {
    await app.shutdown();
    await rm(root, { recursive: true, force: true });
  });
  await app.configure({ baseUrl: "https://fixture.invalid/v1", apiKey: "fixture" });
  const session = await app.start("Work view", "fixture");
  await app.settled();
  const ui = new WorkspaceTui(app, { NOMO_DATA_DIR: root });
  await ui.command(`/open ${session.id}`);

  const wideRows = stripAnsi(
    renderWorkspace(ui, 120, 40, "", false, false, {
      color: false,
      motion: false,
    }),
  ).split("\n");
  const headingRow = wideRows.findIndex((row) => row.includes("TODO 1/5"));
  assert.ok(headingRow >= 0, "the rail prints the real done and total counts");
  const innerWidth = 120 - 4;
  const railWidth = Math.min(34, Math.max(24, Math.floor(innerWidth * 0.28)));
  assert.equal(
    wideRows[headingRow]!.indexOf("TODO 1/5"),
    2 + innerWidth - railWidth,
    "the rail is the fixed right column",
  );
  // The gauge shares the heading row, so the card gains a shape without
  // spending a row on it. One of five done fills the first fifth.
  assert.match(
    wideRows[headingRow]!,
    /TODO 1\/5 [━╸─]+/,
    "the heading carries a real gauge beside the count",
  );
  assert.match(wideRows.join("\n"), /\[x\] ✓ read the contract/);
  assert.match(wideRows.join("\n"), /\[ \] write the failing test/);
  assert.ok(
    !/\[\d+s\]|\(\d+ms\)/.test(wideRows.join("\n")),
    "no per-item timing is invented",
  );

  const mediumRows = stripAnsi(
    renderWorkspace(ui, 80, 24, "", false, false, {
      color: false,
      motion: false,
    }),
  ).split("\n");
  assert.match(
    mediumRows[mediumRows.length - 1]!,
    /TODO 1\/5/,
    "80x24 carries the chip on the existing activity row",
  );
  assert.ok(
    !mediumRows.some((row) => row.includes("SUBAGENTS")),
    "no rail below a hundred columns",
  );

  const narrowRows = stripAnsi(
    renderWorkspace(ui, 40, 12, "", false, false, {
      color: false,
      motion: false,
    }),
  ).split("\n");
  assert.match(narrowRows[narrowRows.length - 1]!, /1\/5/);
  assert.ok(
    !narrowRows[narrowRows.length - 1]!.includes("TODO"),
    "forty columns carry the count alone",
  );

  // A budget too small for every item names what it hid. The gauge is empty
  // because nothing is done, so it has no head to place.
  const many = Array.from({ length: 30 }, (_, index) => ({
    done: false,
    text: `item ${index}`,
  }));
  assert.deepEqual(todoRailLines(many, 30, 5), [
    "TODO 0/30 ──────────",
    "[ ] item 0",
    "[ ] item 1",
    "[ ] item 2",
    "+27 more",
  ]);
  assert.equal(todoChip(many, "full"), "TODO 0/30");
  assert.equal(todoChip(many, "count"), "0/30");
  assert.equal(todoChip([], "full"), "");
});

test("a structured todo event drives the rail, the header gauge and the chip", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "nomo-tui-structured-todo-"));
  const app = new Workbench(
    { NOMO_DATA_DIR: root },
    // The turn after the tool call writes a different checklist in markdown.
    // The structured record owns the run it was recorded in, so the rail must
    // keep showing the real one and never the later prose.
    structuredTodoFetcher(
      [
        { text: "read the contract", status: "completed" },
        { text: "run the suite", status: "in_progress" },
        { text: "record evidence", status: "pending" },
      ],
      "Plan:\n- [ ] markdown must not win\n- [ ] nor this one",
    ),
  );
  t.after(async () => {
    await app.shutdown();
    await rm(root, { recursive: true, force: true });
  });
  await app.configure({ baseUrl: "https://fixture.invalid/v1", apiKey: "fixture" });
  const session = await app.start("Structured work", "fixture");
  await app.settled();
  // The Workbench emitted the event the rail reads, and nothing else.
  const updated = app
    .get(session.id)!
    .events.filter((event) => event.type === "todo.updated");
  assert.equal(updated.length, 1, "one real todo.updated event");
  assert.deepEqual(updated[0]!.payload, {
    items: [
      { text: "read the contract", status: "completed" },
      { text: "run the suite", status: "in_progress" },
      { text: "record evidence", status: "pending" },
    ],
  });
  const ui = new WorkspaceTui(app, { NOMO_DATA_DIR: root });
  await ui.command(`/open ${session.id}`);

  const wideRows = stripAnsi(
    renderWorkspace(ui, 120, 40, "", false, false, {
      color: false,
      motion: false,
    }),
  ).split("\n");
  const wide = wideRows.join("\n");
  assert.match(wide, /TODO 1\/3 ━+╸─+/);
  // The rail block is the right column: heading, three rows, then the rule
  // that separates it from the run receipt.
  const headingAt = wideRows.findIndex((row) => row.includes("TODO 1/3"));
  assert.ok(headingAt >= 0, "the rail prints the structured counts");
  const railBlock = wideRows.slice(headingAt, headingAt + 4).join("\n");
  assert.match(railBlock, /\[x\] ✓ read the contract/);
  assert.match(railBlock, /\[~\] run the suite/);
  assert.match(railBlock, /\[ \] record evidence/);
  // The prose checklist stays in the transcript as the message it was, but it
  // never replaces the record the tool made.
  assert.doesNotMatch(railBlock, /markdown must not win/);
  assert.doesNotMatch(wide, /TODO 0\/2/, "the prose checklist never replaces the record");

  const mediumRows = stripAnsi(
    renderWorkspace(ui, 80, 24, "", false, false, {
      color: false,
      motion: false,
    }),
  ).split("\n");
  assert.match(
    mediumRows[mediumRows.length - 1]!,
    /TODO 1\/3/,
    "80x24 carries the structured count on the activity row",
  );

  const narrowRows = stripAnsi(
    renderWorkspace(ui, 40, 12, "", false, false, {
      color: false,
      motion: false,
    }),
  ).split("\n");
  assert.match(narrowRows[narrowRows.length - 1]!, /1\/3/);
  assert.ok(
    !narrowRows[narrowRows.length - 1]!.includes("TODO"),
    "forty columns carry the count alone",
  );

  // /todos reads the same derivation, so the detail view cannot disagree.
  await ui.command("/todos");
  const detail = ui.detail?.join("\n") ?? "";
  assert.match(detail, /2 open of 3/);
  assert.match(detail, /\[~\] run the suite/);
  assert.doesNotMatch(detail, /markdown must not win/);
});

test("a structured checklist keeps its exact frame at five terminal sizes", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "nomo-tui-structured-sizes-"));
  const app = new Workbench(
    { NOMO_DATA_DIR: root },
    structuredTodoFetcher([
      { text: "read the contract", status: "completed" },
      { text: "run the suite", status: "in_progress" },
      { text: "record evidence", status: "pending" },
    ]),
  );
  t.after(async () => {
    await app.shutdown();
    await rm(root, { recursive: true, force: true });
  });
  await app.configure({ baseUrl: "https://fixture.invalid/v1", apiKey: "fixture" });
  const session = await app.start("Structured work", "fixture");
  await app.settled();
  const ui = new WorkspaceTui(app, { NOMO_DATA_DIR: root });
  await ui.command(`/open ${session.id}`);
  for (const [width, height] of [
    [40, 12],
    [80, 24],
    [120, 40],
    [160, 45],
    [200, 48],
  ] as const) {
    const rows = stripAnsi(
      renderWorkspace(ui, width, height, "", false, false, {
        color: false,
        motion: false,
      }),
    ).split("\n");
    assert.equal(rows.length, height, `${width}x${height} row count`);
    assert.ok(
      rows.every((row) => visibleLength(row) <= width),
      `${width}x${height} row width`,
    );
    const text = rows.join("\n");
    assert.match(text, /1\/3/, `${width}x${height} keeps the real count`);
    assert.doesNotMatch(text, /2\/3|1\/2/, `${width}x${height} invents no count`);
  }
  // A 40x12 review keeps every decision key with the structured checklist
  // present, so the rail never crowds out a decision.
  ui.confirmation = {
    title: "SAVE plan.md?",
    lines: ["REVIEW PREVIEW: local-fixture-change"],
    apply: async () => {},
  };
  const review = stripAnsi(
    renderWorkspace(ui, 40, 12, "", false, false, {
      color: false,
      motion: false,
    }),
  ).split("\n");
  assert.equal(review.length, 12);
  assert.ok(review.every((row) => visibleLength(row) <= 40));
  assert.match(review.join("\n"), /y allow · n deny/);
  assert.match(review.join("\n"), /Esc cancel/);
});

test("a structured checklist payload is read whole or not at all", () => {
  assert.deepEqual(
    todoItemsFromEventPayload({
      items: [
        { text: "done row", status: "completed" },
        { text: "live row", status: "in_progress" },
      ],
    }),
    [
      { done: true, text: "done row", status: "completed" },
      { done: false, text: "live row", status: "in_progress" },
    ],
  );
  // One unreadable row rejects the event rather than printing the rest as if
  // the checklist were complete. The markdown fallback is the honest answer.
  assert.equal(todoItemsFromEventPayload(undefined), undefined);
  assert.equal(todoItemsFromEventPayload({}), undefined);
  assert.equal(todoItemsFromEventPayload({ items: [] }), undefined);
  assert.equal(
    todoItemsFromEventPayload({ items: [{ text: "x", status: "doing" }] }),
    undefined,
  );
  assert.equal(
    todoItemsFromEventPayload({ items: [{ text: "   ", status: "pending" }] }),
    undefined,
  );
  assert.equal(
    todoItemsFromEventPayload({ items: [{ text: "a\nb", status: "pending" }] }),
    undefined,
  );
  assert.equal(
    todoItemsFromEventPayload({
      items: [{ text: "x", status: "pending", extra: true }],
    }),
    undefined,
  );
  assert.equal(
    todoItemsFromEventPayload({ items: [{ text: "x".repeat(201), status: "pending" }] }),
    undefined,
  );
  assert.equal(
    todoItemsFromEventPayload({
      items: Array.from({ length: 51 }, (_, index) => ({
        text: `item ${index}`,
        status: "pending",
      })),
    }),
    undefined,
  );
});

test("the TODO block always precedes the subagent block", () => {
  const rail = chatRailLines({
    todos: [{ done: true, text: "read the contract" }],
    subagents: [
      {
        id: "child-1",
        title: "Delegated task",
        model: "fixture-model",
        status: "running",
        createdAt: "2026-01-01T10:00:00.000Z",
      },
    ],
    width: 44,
    height: 20,
    now: Date.parse("2026-01-01T10:00:42.000Z"),
  });
  const todoAt = rail.findIndex((row) => row.startsWith("TODO "));
  const subagentsAt = rail.findIndex((row) => row.startsWith("SUBAGENTS "));
  assert.ok(todoAt >= 0 && subagentsAt > todoAt, "stable order: TODO then SUBAGENTS");
  // The blocks are separated by a rule, not by a blank row: the eye needs the
  // boundary even when the two blocks happen to be the same colour.
  assert.match(rail[subagentsAt - 1]!, /^─+$/);
  assert.match(rail.join("\n"), /\[x\] ✓ read the contract/);
  assert.match(rail.join("\n"), /▸ Delegated task · fixture-model/);
  assert.match(rail.join("\n"), /running · 42s/);
});

test("the subagent rail shows the real child session state, never a heartbeat", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "nomo-tui-workview-subagent-"));
  const env = { NOMO_DATA_DIR: root };
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  let calls = 0;
  const app = new Workbench(env, async (url) => {
    if (String(url).endsWith("/models"))
      return Response.json({ data: [{ id: "fixture" }] });
    if (calls++ === 0)
      return Response.json({
        choices: [
          {
            message: { role: "assistant", content: workViewMarkdown },
            finish_reason: "stop",
          },
        ],
      });
    await blocked;
    return Response.json({
      choices: [
        {
          message: { role: "assistant", content: "child done" },
          finish_reason: "stop",
        },
      ],
    });
  });
  t.after(async () => {
    release();
    await app.shutdown();
    await rm(root, { recursive: true, force: true });
  });
  await app.configure({ baseUrl: "https://fixture.invalid/v1", apiKey: "fixture" });
  const parent = await app.start("Work view", "fixture");
  await app.settled();
  const child = await app.spawnSubagent(parent.id, "Delegated task");
  const childView = app.get(child.id)!;
  assert.equal(childView.status, "running", "the child is genuinely running");
  const ui = new WorkspaceTui(app, env);
  await ui.command(`/open ${parent.id}`);
  const now = Date.parse(childView.createdAt!) + 42_000;
  const running = stripAnsi(
    renderWorkspace(ui, 120, 40, "", false, false, {
      color: false,
      motion: false,
      now,
    }),
  );
  assert.match(running, /SUBAGENTS 1/);
  assert.match(running, /▸ Delegated task · fixture/);
  assert.match(running, /running · 42s/);
  assert.doesNotMatch(running, /heartbeat/);

  release();
  await app.settled();
  const done = stripAnsi(
    renderWorkspace(ui, 120, 40, "", false, false, {
      color: false,
      motion: false,
    }),
  );
  assert.match(done, /SUBAGENTS 1/);
  assert.match(done, /done · \d+s/);
});

test("the chat rail shows real child activity at five terminal sizes", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "nomo-tui-workview-child-tool-"));
  const env = { NOMO_DATA_DIR: root };
  let childTurns = 0;
  const app = new Workbench(env, async (url, init) => {
    if (String(url).endsWith("/models"))
      return Response.json({ data: [{ id: "fixture" }] });
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    const messages = (body.messages ?? []) as Array<{
      role?: string;
      content?: unknown;
    }>;
    const isChild = messages.some(
      (message) =>
        message.role === "user" &&
        String(message.content).includes("Delegated task"),
    );
    const alreadyRanTool = messages.some((message) => message.role === "tool");
    const todoTool = (body.tools ?? []).find(
      (item: { function?: { description?: string } }) =>
        item.function?.description?.startsWith("todo_write:"),
    );
    // The child makes one real tool call and then settles, so its own
    // transcript proves the activity the rail is allowed to print.
    if (isChild && !alreadyRanTool && todoTool && childTurns++ === 0)
      return Response.json({
        choices: [
          {
            message: {
              role: "assistant",
              content: null,
              tool_calls: [
                {
                  id: "child-tool-1",
                  type: "function",
                  function: {
                    name: todoTool.function.name,
                    arguments: JSON.stringify({
                      items: [
                        { text: "read the contract", status: "completed" },
                      ],
                    }),
                  },
                },
              ],
            },
            finish_reason: "tool_calls",
          },
        ],
      });
    return Response.json({
      choices: [
        {
          message: {
            role: "assistant",
            content: isChild ? "child done" : "parent done",
          },
          finish_reason: "stop",
        },
      ],
    });
  });
  t.after(async () => {
    await app.shutdown();
    await rm(root, { recursive: true, force: true });
  });
  await app.configure({ baseUrl: "https://fixture.invalid/v1", apiKey: "fixture" });
  const parent = await app.start("Work view", "fixture");
  await app.settled();
  const child = await app.spawnSubagent(parent.id, "Delegated task");
  await app.settled();
  const childEvents = app.get(child.id)!.events;
  assert.ok(
    childEvents.some((event) => event.type === "tool.started"),
    "the child really ran a tool",
  );
  assert.ok(
    childEvents.some((event) => event.type === "tool.result"),
    "the child's own transcript holds the result",
  );
  const ui = new WorkspaceTui(app, env);
  await ui.command(`/open ${parent.id}`);
  for (const [width, height] of [
    [40, 12],
    [60, 16],
    [80, 24],
    [100, 20],
    [120, 40],
  ] as const) {
    const rows = stripAnsi(
      renderWorkspace(ui, width, height, "", false, false, {
        color: false,
        motion: false,
      }),
    ).split("\n");
    assert.equal(rows.length, height, `${width}x${height} row count`);
    assert.ok(
      rows.every((row) => visibleLength(row) <= width),
      `${width}x${height} row width`,
    );
    // Below the rail threshold the frame keeps the transcript width it had
    // before the child existed.
    if (width < 100)
      assert.ok(
        !rows.some((row) => row.includes("SUBAGENTS")),
        `${width}x${height} keeps the rail out`,
      );
  }
  const wide = stripAnsi(
    renderWorkspace(ui, 120, 40, "", false, false, {
      color: false,
      motion: false,
    }),
  ).split("\n");
  const heading = wide.findIndex((row) => row.includes("SUBAGENTS 1"));
  assert.ok(heading >= 0, "120x40 carries the child card");
  const activity = wide.find((row) => row.includes("todo_write"));
  assert.ok(activity !== undefined, "the real child tool rides its own row");
  assert.match(
    activity!,
    /✓ todo_write\s*$/,
    "the recorded name is printed and no target is invented",
  );
  assert.ok(
    wide.indexOf(activity!) > heading,
    "the activity line sits inside the SUBAGENTS block",
  );
});

test("subagent rows are derived from stored fields only", () => {
  assert.equal(subagentStateWord("running"), "running");
  assert.equal(subagentStateWord("idle"), "done");
  assert.equal(subagentStateWord("failed"), "failed");
  assert.equal(subagentStateWord("cancelled"), "cancelled");
  assert.equal(
    subagentDurationSeconds(
      {
        id: "child",
        status: "running",
        createdAt: "2026-01-01T10:00:00.000Z",
      },
      Date.parse("2026-01-01T10:00:42.000Z"),
    ),
    42,
  );
  // No timestamps means no duration. The rail never guesses one.
  assert.equal(subagentDurationSeconds({ id: "child", status: "idle" }, 0), undefined);
  assert.deepEqual(subagentRailLines([], 30, 5), []);
  const many = Array.from({ length: 6 }, (_, index) => ({
    id: `child-${index}`,
    status: "idle",
  }));
  const clipped = subagentRailLines(many, 30, 4);
  assert.equal(clipped[0], "SUBAGENTS 6");
  assert.equal(clipped[clipped.length - 1], "+5 more");
});

test("the task header rides the phase wave row and costs no extra line", async (t) => {
  // Phase, conversation, the real checklist gauge with its count, the turn's
  // elapsed time and the provider's own rate. No part is guessed.
  assert.equal(
    taskHeaderLabel({
      phase: "bash",
      title: "Work view",
      elapsedSeconds: 42,
      todos: { done: 1, total: 3 },
      barWidth: 8,
    }),
    "bash · Work view · ━━━╸──── 1/3 · 42s",
  );
  assert.equal(
    taskHeaderLabel({
      phase: "bash",
      title: "Work view",
      elapsedSeconds: 42,
      todos: { done: 1, total: 3 },
      barWidth: 8,
      tokensPerSecond: "41.3",
    }),
    "bash · Work view · ━━━╸──── 1/3 · 42s · tok/s 41.3",
  );
  // A run whose provider reported no rate says so rather than dividing a
  // count by a wall clock.
  assert.equal(
    taskHeaderLabel({
      phase: "bash",
      tokensPerSecond: tokensPerSecondLabel({ total_tokens: 120 }),
    }),
    "bash · tok/s n/a",
  );
  assert.equal(taskHeaderLabel({ phase: "Waiting for provider" }), "Waiting for provider");
  // The compact form names the phase in one word and keeps the real count.
  assert.equal(
    compactTaskHeaderLabel({
      phase: "Working",
      todos: { done: 3, total: 7 },
    }),
    "Working 3/7",
  );
  assert.equal(compactTaskHeaderLabel({ phase: "Working" }), "Working");

  const root = await mkdtemp(join(tmpdir(), "nomo-tui-workview-header-"));
  const env = { NOMO_DATA_DIR: root };
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const app = new Workbench(env, async (url) => {
    if (String(url).endsWith("/models"))
      return Response.json({ data: [{ id: "fixture" }] });
    await blocked;
    return Response.json({
      choices: [{ message: { role: "assistant", content: "late" } }],
    });
  });
  t.after(async () => {
    release();
    await app.shutdown();
    await rm(root, { recursive: true, force: true });
  });
  await app.configure({ baseUrl: "https://fixture.invalid/v1", apiKey: "fixture" });
  const session = await app.start("Work view", "fixture");
  const ui = new WorkspaceTui(app, env);
  await ui.command(`/open ${session.id}`);
  const latestUser = app
    .get(session.id)!
    .events.find((event) => event.kind === "user")!;
  const now = Date.parse(latestUser.at) + 42_000;
  const rows = stripAnsi(
    renderWorkspace(ui, 80, 21, "", false, false, {
      color: false,
      motion: false,
      now,
    }),
  ).split("\n");
  assert.equal(rows.length, 21, "the header adds no row");
  const headerRows = rows.filter((row) =>
    row.includes("Waiting for provider · Work view · 42s"),
  );
  assert.equal(headerRows.length, 1, "the task header rides the existing row");

  // A 40x12 frame cannot spare a row, so the same header keeps its one word
  // form on the brand row the frame already prints. The count stays real.
  const compactRows = stripAnsi(
    renderWorkspace(ui, 40, 12, "", false, false, {
      color: false,
      motion: false,
      now,
    }),
  ).split("\n");
  assert.equal(compactRows.length, 12);
  assert.ok(compactRows.every((row) => visibleLength(row) <= 40));
  assert.match(compactRows[0]!, /NOMO  Chat  Working/);
  assert.doesNotMatch(
    compactRows[0]!,
    /Waiting for provider/,
    "the compact row never squeezes the sentence onto the brand row",
  );
});

// Seven items with three done, so the header and the rail can be checked
// against the same real counts at every size.
const workTheaterMarkdown = [
  "Plan:",
  "- [x] read the contract",
  "- [x] write the failing test",
  "- [x] record evidence",
  "- [ ] run the suite",
  "- [ ] hand off",
  "- [ ] review the diff",
  "- [ ] close the run",
].join("\n");

test("the TODO card marks the real active row and its finished rows", async (t) => {
  // The gauge is pure geometry over the real counts.
  assert.equal(todoProgressBar(0, 4, 8), "────────");
  assert.equal(todoProgressBar(4, 4, 8), "━━━━━━━━");
  assert.equal(todoProgressBar(1, 5, 10), "━━╸───────");
  assert.equal(todoProgressBar(2, 2, 0), "");
  // A finished row says so twice, in the box and in a glyph, so the state
  // survives a terminal with no colour and no check box font.
  const todos = [
    { done: true, text: "read the contract" },
    { done: false, text: "run the suite" },
  ];
  assert.deepEqual(todoRailLines(todos, 30, 4), [
    "TODO 1/2 ━━━━━╸────",
    "[x] ✓ read the contract",
    "[ ] run the suite",
  ]);
  // Only a row the model itself marked in progress takes the live marker, and
  // the caller supplies the marker so it animates with the rest of the frame.
  const marked = [
    { done: true, text: "read the contract", status: "completed" as const },
    { done: false, text: "run the suite", status: "in_progress" as const },
  ];
  assert.equal(todoActiveItem(marked), "run the suite");
  // A row read out of markdown carries no state, so nothing may promote it.
  assert.equal(todoActiveItem(todos), undefined);
  assert.equal(todoActiveItem([]), undefined);
  assert.deepEqual(todoRailLines(marked, 30, 4), [
    "TODO 1/2 ━━━━━╸────",
    "[x] ✓ read the contract",
    "[~] run the suite",
  ]);
  assert.deepEqual(todoRailLines(marked, 30, 4, { indicator: "⠋" }), [
    "TODO 1/2 ━━━━━╸────",
    "[x] ✓ read the contract",
    "[ ] ⠋ run the suite",
  ]);

  // End to end: only the model's own in-progress state marks a row. A running
  // child session titled exactly like a pending row is not evidence about the
  // checklist, so it must not promote anything.
  const root = await mkdtemp(join(tmpdir(), "nomo-tui-workview-active-"));
  const env = { NOMO_DATA_DIR: root };
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  let calls = 0;
  const app = new Workbench(env, async (url: unknown, init?: RequestInit) => {
    if (String(url).endsWith("/models"))
      return Response.json({ data: [{ id: "fixture" }] });
    const turn = calls++;
    if (turn === 0) {
      const body = init?.body ? JSON.parse(String(init.body)) : {};
      const tool = (body.tools ?? []).find(
        (item: { function?: { description?: string } }) =>
          item.function?.description?.startsWith("todo_write:"),
      );
      return Response.json({
        choices: [
          {
            message: {
              role: "assistant",
              content: null,
              tool_calls: [
                {
                  id: "todo-1",
                  type: "function",
                  function: {
                    name: tool.function.name,
                    arguments: JSON.stringify({
                      items: [
                        { text: "read the contract", status: "completed" },
                        { text: "write the failing test", status: "completed" },
                        { text: "record evidence", status: "completed" },
                        { text: "run the suite", status: "in_progress" },
                        { text: "hand off", status: "pending" },
                        { text: "review the diff", status: "pending" },
                        { text: "close the run", status: "pending" },
                      ],
                    }),
                  },
                },
              ],
            },
            finish_reason: "tool_calls",
          },
        ],
        usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
      });
    }
    if (turn === 1)
      return Response.json({
        choices: [
          {
            message: { role: "assistant", content: "Checklist recorded." },
            finish_reason: "stop",
          },
        ],
      });
    await blocked;
    return Response.json({
      choices: [{ message: { role: "assistant", content: "child done" } }],
    });
  });
  t.after(async () => {
    release();
    await app.shutdown();
    await rm(root, { recursive: true, force: true });
  });
  await app.configure({ baseUrl: "https://fixture.invalid/v1", apiKey: "fixture" });
  const parent = await app.start("Work view", "fixture");
  await app.settled();
  const child = await app.spawnSubagent(parent.id, "run the suite");
  const childView = app.get(child.id)!;
  const ui = new WorkspaceTui(app, env);
  await ui.command(`/open ${parent.id}`);
  const rows = stripAnsi(
    renderWorkspace(ui, 120, 40, "", false, false, {
      color: false,
      motion: false,
      now: Date.parse(childView.createdAt!) + 42_000,
    }),
  ).split("\n");
  const text = rows.join("\n");
  assert.match(text, /TODO 3\/7 ━+╸─+/);
  // The parent run has settled, so the live marker is the state glyph, not a
  // spinner that would claim work is happening.
  assert.match(text, /\[~\] run the suite/);
  assert.match(text, /\[x\] ✓ record evidence/);
  assert.doesNotMatch(text, /⠋ run the suite/);
  // The finished rows never take the marker, even when a running child is
  // named after one of them.
  assert.doesNotMatch(text, /\[x\] ✓ ⠋/);
});

test("subagent cards print only the fields a child really exposes", () => {
  // A child view with no last event field prints no tool line at all. The
  // live TUI reads Workbench.list(), which returns children with no events,
  // so this is the shape the rail normally sees.
  const plain = subagentRailLines(
    [
      {
        id: "child-1",
        title: "Delegated task",
        model: "fixture-model",
        status: "running",
        createdAt: "2026-01-01T10:00:00.000Z",
      },
    ],
    34,
    4,
    Date.parse("2026-01-01T10:00:42.000Z"),
  );
  assert.deepEqual(plain, [
    "SUBAGENTS 1",
    "▸ Delegated task · fixture-model",
    "  running · 42s",
  ]);
  assert.doesNotMatch(plain.join("\n"), /tool|event/);
  // A child that does prove a tool gets its own activity row, and the state
  // row keeps the shape it has always had.
  const exposed = subagentRailLines(
    [
      {
        id: "child-1",
        title: "Delegated task",
        model: "fixture-model",
        status: "running",
        createdAt: "2026-01-01T10:00:00.000Z",
        lastEventType: "tool.started",
        lastTool: "bash",
        lastTarget: "npm test",
        lastState: "running",
      },
    ],
    34,
    4,
    Date.parse("2026-01-01T10:00:42.000Z"),
  );
  assert.equal(exposed[2], "  running · 42s");
  assert.equal(exposed[3], "  ⠋ bash npm test");
  // A finished child measures to its own last update, never to now.
  assert.equal(
    subagentDurationSeconds(
      {
        id: "child-2",
        status: "idle",
        createdAt: "2026-01-01T10:00:00.000Z",
        updatedAt: "2026-01-01T10:01:30.000Z",
      },
      Date.parse("2026-01-02T00:00:00.000Z"),
    ),
    90,
  );
});

test("child activity comes only from the child's own tool events", () => {
  const at = "2026-01-01T10:00:00.000Z";
  const toolEvent = (
    seq: number,
    type: string,
    payload: Record<string, unknown>,
  ) => ({ seq, at, kind: "tool" as const, type, text: type, payload });
  // A started event with no result is a tool that is still running, and the
  // target is the path the child recorded.
  assert.deepEqual(
    subagentActivityFromEvents([
      toolEvent(0, "tool.started", {
        tool: "read",
        callId: "c1",
        arguments: { path: "src/parse.ts" },
      }),
    ]),
    {
      lastEventType: "tool.started",
      lastTool: "read",
      lastTarget: "src/parse.ts",
      lastState: "running",
    },
  );
  // A result carries no arguments of its own, so the target is recovered from
  // the started event that shares its call id.
  assert.deepEqual(
    subagentActivityFromEvents([
      toolEvent(0, "tool.started", {
        tool: "edit",
        callId: "c2",
        arguments: { path: "src/parse.ts" },
      }),
      toolEvent(1, "tool.result", {
        tool: "edit",
        callId: "c2",
        result: { content: [{ type: "text", text: "ok" }] },
      }),
    ]),
    {
      lastEventType: "tool.result",
      lastTool: "edit",
      lastTarget: "src/parse.ts",
      lastState: "completed",
    },
  );
  // A failed result says so in its own payload; the command is the target.
  assert.deepEqual(
    subagentActivityFromEvents([
      toolEvent(0, "tool.started", {
        tool: "bash",
        callId: "c3",
        arguments: { command: "npm test" },
      }),
      toolEvent(1, "tool.result", {
        tool: "bash",
        callId: "c3",
        result: { isError: true, content: [] },
      }),
    ]),
    {
      lastEventType: "tool.result",
      lastTool: "bash",
      lastTarget: "npm test",
      lastState: "failed",
    },
  );
  // The latest tool event wins: a second call that has not settled is running
  // even though an earlier one completed.
  assert.equal(
    subagentActivityFromEvents([
      toolEvent(0, "tool.result", {
        tool: "bash",
        callId: "c3",
        result: { content: [] },
      }),
      toolEvent(1, "tool.started", {
        tool: "read",
        callId: "c4",
        arguments: { path: "src/parse.ts" },
      }),
    ])?.lastState,
    "running",
  );
  // No tool event means no activity, and no target is invented for a call
  // that recorded none.
  assert.equal(subagentActivityFromEvents([]), undefined);
  assert.equal(subagentActivityFromEvents(undefined), undefined);
  assert.equal(
    subagentActivityFromEvents([
      {
        seq: 0,
        at,
        kind: "assistant",
        type: "message.completed",
        text: "hi",
        payload: {},
      },
    ]),
    undefined,
  );
  assert.deepEqual(
    subagentActivityFromEvents([
      toolEvent(0, "tool.started", { tool: "read", callId: "c5" }),
    ]),
    {
      lastEventType: "tool.started",
      lastTool: "read",
      lastState: "running",
    },
  );
});

test("the subagent activity line names only real evidence", () => {
  const base = {
    id: "child-1",
    title: "Delegated task",
    model: "fixture-model",
    status: "running",
    createdAt: "2026-01-01T10:00:00.000Z",
  };
  const now = Date.parse("2026-01-01T10:00:42.000Z");
  const running = subagentRailLines(
    [
      {
        ...base,
        lastEventType: "tool.started",
        lastTool: "read",
        lastTarget: "src/parse.ts",
        lastState: "running",
      },
    ],
    34,
    4,
    now,
  );
  assert.deepEqual(running, [
    "SUBAGENTS 1",
    "▸ Delegated task · fixture-model",
    "  running · 42s",
    "  ⠋ read src/parse.ts",
  ]);
  const completed = subagentRailLines(
    [
      {
        ...base,
        status: "idle",
        updatedAt: "2026-01-01T10:00:42.000Z",
        lastEventType: "tool.result",
        lastTool: "edit",
        lastTarget: "src/parse.ts",
        lastState: "completed",
      },
    ],
    34,
    4,
    now,
  );
  assert.equal(completed[3], "  ✓ edit src/parse.ts");
  const failed = subagentRailLines(
    [
      {
        ...base,
        status: "failed",
        updatedAt: "2026-01-01T10:00:42.000Z",
        lastEventType: "tool.result",
        lastTool: "bash",
        lastTarget: "npm test",
        lastState: "failed",
      },
    ],
    34,
    4,
    now,
  );
  assert.equal(failed[3], "  ✗ bash npm test");
  // No events: the two-row card is unchanged and no activity line appears.
  assert.deepEqual(subagentRailLines([base], 34, 4, now), [
    "SUBAGENTS 1",
    "▸ Delegated task · fixture-model",
    "  running · 42s",
  ]);
  // A tool name with no recorded target prints the name alone: the rail never
  // borrows the parent's prompt or invents a path.
  const bare = subagentRailLines(
    [
      {
        ...base,
        lastEventType: "tool.result",
        lastTool: "bash",
        lastState: "completed",
      },
    ],
    34,
    4,
    now,
  );
  assert.equal(bare[3], "  ✓ bash");
});

test("the chat rail spends a row on activity only when the body has it", () => {
  const child = {
    id: "child-1",
    title: "Delegated task",
    model: "fixture-model",
    status: "running",
    createdAt: "2026-01-01T10:00:00.000Z",
    lastEventType: "tool.started",
    lastTool: "read",
    lastTarget: "src/parse.ts",
    lastState: "running" as const,
  };
  const now = Date.parse("2026-01-01T10:00:42.000Z");
  const tall = chatRailLines({
    todos: [],
    subagents: [child],
    width: 34,
    height: 12,
    now,
  });
  assert.deepEqual(tall, [
    "SUBAGENTS 1",
    "▸ Delegated task · fixture-model",
    "  running · 42s",
    "  ⠋ read src/parse.ts",
  ]);
  // Three rows hold the heading, the title and the state; the activity line is
  // what gives way, and the card keeps its existing shape.
  const short = chatRailLines({
    todos: [],
    subagents: [child],
    width: 34,
    height: 3,
    now,
  });
  assert.deepEqual(short, [
    "SUBAGENTS 1",
    "▸ Delegated task · fixture-model",
    "  running · 42s",
  ]);
  // A child that proves nothing never gains the row, however tall the body.
  const quiet = chatRailLines({
    todos: [],
    subagents: [{ id: "child-2", status: "running" }],
    width: 34,
    height: 12,
  });
  assert.equal(quiet.length, 3);
});

test("the run receipt reports real metrics and n/a for the missing ones", () => {
  const at = (second: number) =>
    `2026-01-01T10:00:${String(second).padStart(2, "0")}.000Z`;
  const event = (
    seq: number,
    kind: "user" | "assistant" | "tool" | "usage" | "error",
    type: string,
    payload: Record<string, unknown>,
  ) => ({ seq, at: at(seq), kind, type, text: type, payload, runId: "run-1" });
  const events = [
    event(0, "user", "message.completed", {}),
    event(1, "tool", "run.status", { status: "running" }),
    event(2, "tool", "tool.started", {
      tool: "void_workspace_write",
      callId: "w1",
      arguments: { path: "plan.md", content: "first" },
    }),
    event(3, "tool", "tool.result", {
      tool: "void_workspace_write",
      callId: "w1",
      result: { content: [{ type: "text", text: '{"completed":true}' }] },
    }),
    event(4, "tool", "tool.started", {
      tool: "edit_file",
      callId: "e1",
      arguments: { path: "plan.md" },
    }),
    event(5, "tool", "tool.result", {
      tool: "bash",
      callId: "b1",
      result: { content: [{ type: "text", text: "42 tests passed" }] },
    }),
    event(6, "usage", "usage.reported", {
      total_tokens: 120,
      source: "provider",
    }),
    event(7, "assistant", "message.completed", { toolCallsPresent: false }),
    event(8, "tool", "run.status", { status: "idle" }),
  ];
  const summary = runSummaryFromEvents({ events, runId: "run-1" });
  assert.deepEqual(summary, {
    outcome: "done",
    ms: 8_000,
    tokens: 120,
    tools: 2,
    files: 1,
    tests: "passed",
  });
  assert.equal(
    runSummaryRow(summary!, 120),
    "RUN done · time 8s · tok 120 · tools 2 · files 1 · tests passed",
  );
  assert.deepEqual(runSummaryLines(summary!, 24), [
    "RUN done",
    "time 8s",
    "tokens 120",
    "tools 2",
    "files 1",
    "tests passed",
  ]);

  // A failed run keeps its own word, and every metric it did not report is
  // named as n/a rather than printed as zero.
  const failed = runSummaryFromEvents({
    events: [
      event(0, "user", "message.completed", {}),
      event(1, "tool", "run.status", { status: "running" }),
      event(2, "error", "run.error", {}),
      event(3, "tool", "run.status", { status: "failed" }),
    ],
    runId: "run-1",
  });
  assert.equal(failed?.outcome, "failed");
  assert.equal(failed?.tokens, undefined);
  assert.equal(failed?.tests, undefined);
  assert.equal(
    runSummaryRow(failed!, 120),
    "RUN failed · time 3s · tok n/a · tools 0 · files 0 · tests n/a",
  );
  // A run still in flight has no receipt, and a run id with no events has
  // nothing to report.
  assert.equal(
    runSummaryFromEvents({
      events: [event(0, "user", "message.completed", {})],
      runId: "run-1",
    }),
    undefined,
  );
  assert.equal(runSummaryFromEvents({ events, runId: undefined }), undefined);
  // A trimmed window cannot claim a count: the oldest events are gone, so the
  // receipt keeps the outcome and duration and leaves the counts unmeasured.
  const trimmed = runSummaryFromEvents({
    events: [
      event(3, "tool", "tool.result", { result: { content: [] } }),
      event(8, "tool", "run.status", { status: "idle" }),
    ],
    runId: "run-1",
  });
  assert.deepEqual(trimmed, { outcome: "done", ms: 5_000 });

  // Only an explicit report counts as a test result.
  assert.equal(runTestsVerdict("42 tests passed"), "passed");
  assert.equal(runTestsVerdict("3 passed, 1 failed"), "failed");
  assert.equal(runTestsVerdict("FAIL src/x.test.ts"), "failed");
  assert.equal(runTestsVerdict("ok 1 - works"), undefined);
  assert.equal(runTestsVerdict('{"completed":true}'), undefined);

  // The rail orders the receipt after the checklist and the children, and
  // separates it with a rule like the other blocks.
  const rail = chatRailLines({
    todos: [{ done: true, text: "read the contract" }],
    subagents: [],
    runSummary: summary,
    width: 24,
    height: 20,
  });
  const runAt = rail.findIndex((row) => row.startsWith("RUN "));
  assert.ok(runAt > 0);
  assert.match(rail[runAt - 1]!, /^─+$/);
});

test("a settled run prints its real receipt and n/a where nothing was measured", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "nomo-tui-workview-run-"));
  const app = new Workbench({ NOMO_DATA_DIR: root }, async (url, options) => {
    if (String(url).endsWith("/models"))
      return Response.json({ data: [{ id: "fixture" }] });
    const body = JSON.parse(String(options?.body));
    const tool = body.tools.find((entry: { function: { description: string } }) =>
      entry.function.description.startsWith("void_workspace_write:"),
    );
    const second = body.messages.at(-1).role === "tool";
    return Response.json({
      choices: [
        {
          message: second
            ? { role: "assistant", content: "Created plan.md" }
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
          finish_reason: second ? "stop" : "tool_calls",
        },
      ],
      usage: { prompt_tokens: 40, completion_tokens: 10, total_tokens: 50 },
    });
  });
  t.after(async () => {
    await app.shutdown();
    await rm(root, { recursive: true, force: true });
  });
  await app.configure({ baseUrl: "https://fixture.invalid/v1", apiKey: "fixture" });
  const session = await app.start("Write the plan", "fixture");
  await app.settled();
  const ui = new WorkspaceTui(app, { NOMO_DATA_DIR: root });
  await ui.command(`/open ${session.id}`);
  const rows = stripAnsi(
    renderWorkspace(ui, 80, 24, "", false, false, {
      color: false,
      motion: false,
    }),
  ).split("\n");
  assert.equal(rows.length, 24);
  assert.ok(rows.every((row) => visibleLength(row) <= 80));
  const receipt = rows.find((row) => row.includes("RUN done"));
  assert.ok(receipt, "a settled run prints its receipt");
  // A sub-second run prints `512ms` and a multi-second one `1.6s`, so the
  // duration is a decimal second as well as a whole one.
  assert.match(receipt!, /time \d+(?:\.\d+)?m?s/);
  assert.match(receipt!, /tok 100/);
  assert.match(receipt!, /tools 1/);
  assert.match(receipt!, /files 1/);
  // No tool result said a test passed or failed, so the receipt says so.
  assert.match(receipt!, /tests n\/a/);
});

test("the work theater keeps its exact frame at five terminal sizes", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "nomo-tui-workview-sizes2-"));
  const app = new Workbench(
    { NOMO_DATA_DIR: root },
    workViewFetcher(workTheaterMarkdown),
  );
  t.after(async () => {
    await app.shutdown();
    await rm(root, { recursive: true, force: true });
  });
  await app.configure({ baseUrl: "https://fixture.invalid/v1", apiKey: "fixture" });
  const session = await app.start("Work view", "fixture");
  await app.settled();
  const ui = new WorkspaceTui(app, { NOMO_DATA_DIR: root });
  await ui.command(`/open ${session.id}`);
  for (const [width, height] of [
    [40, 12],
    [80, 24],
    [120, 40],
    [160, 45],
    [200, 48],
  ] as const) {
    const rows = stripAnsi(
      renderWorkspace(ui, width, height, "", false, false, {
        color: false,
        motion: false,
      }),
    ).split("\n");
    assert.equal(rows.length, height, `${width}x${height} row count`);
    assert.ok(
      rows.every((row) => visibleLength(row) <= width),
      `${width}x${height} row width`,
    );
    const text = rows.join("\n");
    // The checklist count is real at every size: in the rail, the chip or the
    // count alone, never dropped and never invented.
    assert.match(text, /3\/7/, `${width}x${height} keeps the real count`);
    assert.doesNotMatch(text, /4\/7|3\/8/, `${width}x${height} invents no count`);
  }
  // A 40x12 review keeps its decision keys with the checklist present.
  ui.confirmation = {
    title: "SAVE plan.md?",
    lines: ["REVIEW PREVIEW: local-fixture-change"],
    apply: async () => {},
  };
  const review = stripAnsi(
    renderWorkspace(ui, 40, 12, "", false, false, {
      color: false,
      motion: false,
    }),
  ).split("\n");
  assert.equal(review.length, 12);
  assert.ok(review.every((row) => visibleLength(row) <= 40));
  assert.match(review.join("\n"), /y allow · n deny/);
  assert.match(review.join("\n"), /Esc cancel/);
});

test("a 40x12 review keeps every decision key with a checklist present", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "nomo-tui-workview-review-"));
  const app = new Workbench(
    { NOMO_DATA_DIR: root },
    workViewFetcher(workViewMarkdown),
  );
  t.after(async () => {
    await app.shutdown();
    await rm(root, { recursive: true, force: true });
  });
  await app.configure({ baseUrl: "https://fixture.invalid/v1", apiKey: "fixture" });
  const session = await app.start("Work view", "fixture");
  await app.settled();
  const ui = new WorkspaceTui(app, { NOMO_DATA_DIR: root });
  await ui.command(`/open ${session.id}`);
  ui.confirmation = {
    title: "SAVE plan.md?",
    lines: ["REVIEW PREVIEW: local-fixture-change"],
    apply: async () => {},
  };
  const rows = stripAnsi(
    renderWorkspace(ui, 40, 12, "", false, false, {
      color: false,
      motion: false,
    }),
  ).split("\n");
  const text = rows.join("\n");
  assert.equal(rows.length, 12);
  assert.ok(rows.every((row) => visibleLength(row) <= 40));
  assert.match(text, /╭─ Review  y allow · n deny/);
  assert.match(text, /Esc cancel/);
  assert.ok(!text.includes("SUBAGENTS"), "no band crowds out the decision keys");
});

test("the rail never paints over transcript text", async (t) => {
  const long = "X".repeat(400);
  const root = await mkdtemp(join(tmpdir(), "nomo-tui-workview-rail-"));
  const app = new Workbench(
    { NOMO_DATA_DIR: root },
    workViewFetcher(`${long}\n\n${workViewMarkdown}`),
  );
  t.after(async () => {
    await app.shutdown();
    await rm(root, { recursive: true, force: true });
  });
  await app.configure({ baseUrl: "https://fixture.invalid/v1", apiKey: "fixture" });
  const session = await app.start("Work view", "fixture");
  await app.settled();
  const ui = new WorkspaceTui(app, { NOMO_DATA_DIR: root });
  await ui.command(`/open ${session.id}`);
  const rows = stripAnsi(
    renderWorkspace(ui, 120, 40, "", false, false, {
      color: false,
      motion: false,
    }),
  ).split("\n");
  const innerWidth = 120 - 4;
  const railWidth = Math.min(34, Math.max(24, Math.floor(innerWidth * 0.28)));
  const railStart = 2 + innerWidth - railWidth;
  assert.ok(
    rows.some((row) => row.slice(0, railStart).includes("X")),
    "the transcript is still drawn",
  );
  assert.ok(
    rows.every((row) => !row.slice(railStart).includes("X")),
    "no transcript glyph reaches the rail column",
  );
  assert.ok(rows.some((row) => row.slice(railStart).includes("TODO 1/5")));
});

test("read, write, edit and bash cards name their recorded payload", () => {
  const at = (second: number) =>
    `2026-01-01T10:00:${String(second).padStart(2, "0")}.000Z`;
  const output = (text: string, extra: Record<string, unknown> = {}) => ({
    isError: false,
    content: [{ type: "text" as const, text }],
    ...extra,
  });
  const started = (
    seq: number,
    tool: string,
    callId: string,
    args: Record<string, unknown>,
  ) => ({
    seq,
    at: at(seq),
    kind: "tool" as const,
    type: "tool.started",
    text: `Requested ${tool}.`,
    payload: { tool, callId, arguments: args },
  });
  const result = (
    seq: number,
    tool: string,
    callId: string,
    payload: Record<string, unknown>,
  ) => ({
    seq,
    at: at(seq),
    kind: "tool" as const,
    type: "tool.result",
    text: `${tool}: result received`,
    payload: { tool, callId, result: payload },
  });

  const read = chatRows(
    [
      started(1, "read", "read-1", { path: "src/plan.md" }),
      result(2, "read", "read-1", output("line one\nline two\nline three")),
    ],
    100,
  )
    .map((row) => row.text)
    .join("\n");
  assert.match(read, /src\/plan\.md · 3 lines · \d+ chars/);
  assert.ok(read.includes("line three"), "the read content stays visible");

  const write = chatRows(
    [
      started(1, "write", "write-1", {
        path: "src/notes.md",
        content: "alpha\nbeta\ngamma",
      }),
      result(2, "write", "write-1", output("wrote 3 lines")),
    ],
    100,
  )
    .map((row) => row.text)
    .join("\n");
  assert.match(write, /src\/notes\.md · \+3 -0 lines/);
  assert.match(write, /\+ 1 │ alpha/);
  assert.match(write, /\+ 3 │ gamma/);

  const edit = chatRows(
    [
      started(1, "edit", "edit-1", {
        path: "src/plan.md",
        old_str: "old line",
        new_str: "new line",
      }),
      result(2, "edit", "edit-1", output("edited")),
    ],
    100,
  )
    .map((row) => row.text)
    .join("\n");
  assert.match(edit, /src\/plan\.md · \+1 -1 lines/);
  assert.match(edit, /- old line/);
  assert.match(edit, /\+ new line/);

  const bashOutput = Array.from({ length: 9 }, (_, index) => `out ${index}`).join(
    "\n",
  );
  const bash = chatRows(
    [
      started(1, "bash", "bash-1", { command: "pnpm test" }),
      result(2, "bash", "bash-1", output(bashOutput, { exit_code: 0 })),
    ],
    100,
  )
    .map((row) => row.text)
    .join("\n");
  assert.match(bash, /command: pnpm test/);
  assert.match(bash, /Output · 9 lines · \d+ chars/);
  assert.match(bash, /out 0/);
  assert.match(bash, /… 3 more lines/, "hidden output lines are named");
  assert.match(bash, /exit code: 0/);
});

// Recorded tool events for the specialised card tests. A start event carries
// the arguments and a result event the output, exactly as the Workbench stores
// them; no row below is synthesised from elapsed time or model text.
type ToolCardEvent = Parameters<typeof chatRows>[0][number];
const cardAt = (second: number) =>
  `2026-01-01T10:02:${String(second).padStart(2, "0")}.000Z`;
const cardOutput = (text: string, extra: Record<string, unknown> = {}) => ({
  isError: false,
  content: [{ type: "text" as const, text }],
  ...extra,
});
const cardStarted = (
  seq: number,
  tool: string,
  callId: string,
  args: Record<string, unknown>,
): ToolCardEvent => ({
  seq,
  at: cardAt(seq),
  kind: "tool",
  type: "tool.started",
  text: `Requested ${tool}.`,
  payload: { tool, callId, arguments: args },
});
const cardResult = (
  seq: number,
  tool: string,
  callId: string,
  payload: Record<string, unknown>,
): ToolCardEvent => ({
  seq,
  at: cardAt(seq),
  kind: "tool",
  type: "tool.result",
  text: `${tool}: result received`,
  payload: { tool, callId, result: payload },
});
const cardRows = (
  events: readonly ToolCardEvent[],
  width = 100,
  height = 40,
) =>
  chatRows(
    events,
    width,
    "details",
    "comfortable",
    false,
    false,
    "unicode",
    height,
  );
const readCardEvents = (extra: Record<string, unknown> = {}) => [
  cardStarted(1, "read", "read-1", { path: "src/plan.md" }),
  cardResult(
    2,
    "read",
    "read-1",
    cardOutput("line one\nline two\nline three", extra),
  ),
];
const writeCardEvents = [
  cardStarted(1, "write", "write-1", {
    path: "src/notes.md",
    content: "alpha\nbeta\ngamma",
  }),
  cardResult(2, "write", "write-1", cardOutput("wrote 3 lines")),
];
const editCardEvents = [
  cardStarted(1, "edit", "edit-1", {
    path: "src/plan.md",
    old_str: "old line",
    new_str: "new line",
  }),
  cardResult(2, "edit", "edit-1", cardOutput("edited")),
];
const bashCardEvents = (output: string, extra: Record<string, unknown> = {}) => [
  cardStarted(1, "bash", "bash-1", { command: "pnpm test" }),
  cardResult(2, "bash", "bash-1", cardOutput(output, extra)),
];

test("read cards number their preview lines and name the recorded range", () => {
  const ranged = cardRows(readCardEvents({ start_line: 1, total_lines: 48 }));
  const rangedText = ranged.map((row) => row.text).join("\n");
  assert.match(rangedText, /src\/plan\.md · lines 1-3 of 48/);
  assert.ok(
    ranged.some((row) => /^\s*1 │ line one$/.test(row.text)),
    `the first line carries its number:\n${rangedText}`,
  );
  assert.ok(
    ranged.some((row) => /^\s*3 │ line three$/.test(row.text)),
    `every shown line is numbered:\n${rangedText}`,
  );
  assert.match(rangedText, /… 45 more lines/, "the unread tail is named");
  assert.doesNotMatch(rangedText, /… 0 more lines/);
  assert.ok(
    ranged.some((row) => row.text.trim() === "┌ code") &&
      ranged.some((row) => row.text.trim() === "└ code"),
    "the code fence survives the numbering",
  );

  // Without recorded range metadata the card must not claim one: the label
  // stays the measured line count and no "of N" is printed.
  const plain = cardRows(readCardEvents());
  const plainText = plain.map((row) => row.text).join("\n");
  assert.match(plainText, /src\/plan\.md · 3 lines · \d+ chars/);
  assert.doesNotMatch(plainText, /of 48|lines \d+-\d+ of/);
  assert.ok(
    plain.some((row) => /^\s*1 │ line one$/.test(row.text)),
    "numbering starts at the first recorded line",
  );
});

test("write and edit cards keep explicit signs and number new-file lines", () => {
  const write = cardRows(writeCardEvents);
  const writeText = write.map((row) => row.text).join("\n");
  assert.match(writeText, /src\/notes\.md · \+3 -0 lines/);
  assert.ok(
    write.some((row) => /^ {2}\+ 1 │ alpha$/.test(row.text)),
    `the first new-file line is numbered:\n${writeText}`,
  );
  assert.ok(
    write.some((row) => /^ {2}\+ 3 │ gamma$/.test(row.text)),
    `the last new-file line is numbered:\n${writeText}`,
  );
  assert.equal(
    write.filter((row) => row.style === "diff-add").length,
    3,
    "every added row carries the added tone",
  );
  assert.equal(write.filter((row) => row.style === "diff-remove").length, 0);

  // An edit records the replaced text, not a file position, so the removed
  // and added rows stay unnumbered rather than inventing a line.
  const edit = cardRows(editCardEvents);
  const editText = edit.map((row) => row.text).join("\n");
  assert.match(editText, /src\/plan\.md · \+1 -1 lines/);
  const removed = edit.find((row) => row.text.trim() === "- old line");
  const added = edit.find((row) => row.text.trim() === "+ new line");
  assert.ok(removed && added, `both sides survive:\n${editText}`);
  assert.equal(removed!.style, "diff-remove");
  assert.equal(added!.style, "diff-add");
  assert.doesNotMatch(editText, /[+-] \d+ │/, "an edit invents no line number");
});

test("bash cards number their output and keep the exit code", () => {
  const output = Array.from({ length: 9 }, (_, index) => `out ${index}`).join(
    "\n",
  );
  const bash = cardRows(bashCardEvents(output, { exit_code: 2 }));
  const text = bash.map((row) => row.text).join("\n");
  assert.match(text, /command: pnpm test/);
  assert.match(text, /Output · 9 lines · \d+ chars/);
  assert.ok(
    bash.some((row) => /^\s*1 │ out 0$/.test(row.text)),
    `the first output line carries its number:\n${text}`,
  );
  assert.ok(
    bash.some((row) => /^\s*6 │ out 5$/.test(row.text)),
    `numbering follows the shown rows:\n${text}`,
  );
  assert.doesNotMatch(text, /out 6/, "the cut lines stay cut");
  assert.match(text, /… 3 more lines/, "the hidden count is named");
  assert.match(text, /exit code: 2/);
});

test("generic tool cards keep their unnumbered fallback", () => {
  const rows = cardRows([
    cardStarted(1, "nomo_project_exec", "gen-1", {
      command: "cat src/generated.ts",
    }),
    cardResult(
      2,
      "nomo_project_exec",
      "gen-1",
      cardOutput("export const x = 1;\nexport const y = 2;"),
    ),
  ]);
  const text = rows.map((row) => row.text).join("\n");
  assert.ok(
    text.includes("  │ export const x = 1;"),
    `the generic gutter is unchanged:\n${text}`,
  );
  assert.doesNotMatch(text, /\d+ │ export const/, "no invented numbering");
});

test("tool card previews hold their shape at five terminal sizes", () => {
  const events = [
    ...readCardEvents({ start_line: 1, total_lines: 48 }),
    ...writeCardEvents,
    ...bashCardEvents(
      Array.from({ length: 9 }, (_, index) => `out ${index}`).join("\n"),
      { exit_code: 0 },
    ),
  ];
  for (const [width, height] of [
    [40, 12],
    [60, 18],
    [80, 24],
    [120, 32],
    [200, 48],
  ] as const) {
    const rows = cardRows(events, width, height);
    assert.ok(
      rows.every((row) => visibleLength(row.text) <= width),
      `${width}x${height} row width`,
    );
    const numbered = rows.filter((row) => /^\s*\d+ │ /.test(row.text));
    assert.ok(
      numbered.length > 0,
      `${width}x${height} keeps at least one numbered preview line`,
    );
    assert.equal(
      numbered[0]!.text.trimStart().split(" │ ")[0],
      "1",
      `${width}x${height} starts numbering at the first recorded line`,
    );
  }
  // At 40x12 the read card still shows one whole preview line, not only its
  // header, so the narrowest supported terminal keeps the content visible.
  const narrow = cardRows(readCardEvents({ start_line: 1, total_lines: 48 }), 40, 12);
  assert.ok(
    narrow.some((row) => /^\s*1 │ line one$/.test(row.text)),
    "40x12 keeps one numbered line",
  );
});

test("diff tones paint only when colour is enabled", async (t) => {
  const rows = cardRows(editCardEvents);
  assert.equal(
    rows.find((row) => row.text.trim() === "- old line")?.style,
    "diff-remove",
  );
  assert.equal(
    rows.find((row) => row.text.trim() === "+ new line")?.style,
    "diff-add",
  );

  const root = await mkdtemp(join(tmpdir(), "nomo-tui-tool-tone-"));
  const app = new Workbench(
    { NOMO_DATA_DIR: root },
    workViewFetcher(workViewMarkdown),
  );
  t.after(async () => {
    await app.shutdown();
    await rm(root, { recursive: true, force: true });
  });
  await app.configure({
    baseUrl: "https://fixture.invalid/v1",
    apiKey: "fixture",
  });
  const session = await app.start("Tool cards", "fixture");
  await app.settled();
  const ui = new WorkspaceTui(app, { NOMO_DATA_DIR: root });
  await ui.command(`/open ${session.id}`);
  // The paint path is what this half covers; the transcript stays the same
  // recorded events the style assertions above read.
  ui.renderChatRows = (_events, width, terminalHeight) =>
    chatRows(
      editCardEvents,
      width,
      "details",
      "comfortable",
      false,
      false,
      "unicode",
      terminalHeight,
    );

  const mono = renderWorkspace(ui, 80, 24, "", false, false, {
    color: false,
    motion: false,
    capabilities: colorCaps(80, 24),
  });
  assert.equal(mono.includes("\x1b["), false, "mono output stays plain");
  const monoText = stripAnsi(mono);
  assert.ok(monoText.includes("- old line") && monoText.includes("+ new line"));
  assert.ok(monoText.includes("+1 -1 lines"), "the counts survive mono");

  const colored = renderWorkspace(ui, 80, 24, "", false, false, {
    color: true,
    motion: false,
    capabilities: colorCaps(80, 24),
  });
  const toneBefore = (row: string, needle: string) => {
    const index = row.indexOf(needle);
    assert.ok(index >= 0, `${needle} missing from the painted row`);
    return [...row.slice(0, index).matchAll(/\x1b\[([0-9;]+)m/g)].at(-1)?.[1];
  };
  const coloredRows = colored.split("\n");
  const removedRow = coloredRows.find((row) =>
    stripAnsi(row).includes("- old line"),
  );
  const addedRow = coloredRows.find((row) =>
    stripAnsi(row).includes("+ new line"),
  );
  assert.ok(removedRow && addedRow, "both diff rows are painted");
  const removedTone = toneBefore(removedRow!, "- old line");
  const addedTone = toneBefore(addedRow!, "+ new line");
  assert.ok(removedTone, "the removed row is painted in colour");
  assert.ok(addedTone, "the added row is painted in colour");
  assert.notEqual(
    removedTone,
    addedTone,
    "removed and added rows use different tones",
  );
});

test("the footer never invents a token rate and shortens the home path", async (t) => {
  assert.equal(tokensPerSecondLabel(undefined), "n/a");
  assert.equal(tokensPerSecondLabel({ total_tokens: 120 }), "n/a");
  assert.equal(tokensPerSecondLabel({ tokens_per_second: 41.25 }), "41.3");
  assert.equal(shortenHomePath("/home/dev/project/file.ts", "/home/dev"), "~/project/file.ts");
  assert.equal(shortenHomePath("/home/dev", "/home/dev"), "~");
  assert.equal(shortenHomePath("/home/developer/x", "/home/dev"), "/home/developer/x");

  const root = await mkdtemp(join(tmpdir(), "nomo-tui-workview-footer-"));
  const app = new Workbench(
    { NOMO_DATA_DIR: root },
    workViewFetcher(workViewMarkdown),
  );
  t.after(async () => {
    await app.shutdown();
    await rm(root, { recursive: true, force: true });
  });
  await app.configure({ baseUrl: "https://fixture.invalid/v1", apiKey: "fixture" });
  const session = await app.start("Work view", "fixture");
  await app.settled();
  const ui = new WorkspaceTui(app, { NOMO_DATA_DIR: root });
  await ui.command(`/open ${session.id}`);
  const rows = stripAnsi(
    renderWorkspace(ui, 120, 40, "", false, false, {
      color: false,
      motion: false,
    }),
  ).split("\n");
  const footerRow = rows.find((row) => row.includes("tok/s"));
  assert.ok(footerRow, "the footer carries the token rate");
  assert.match(footerRow!, /tok\/s n\/a/, "no rate was reported, so none is shown");
  assert.match(footerRow!, /fixture/, "the model stays named");
  assert.match(footerRow!, /unknown|—/, "the context share names what it knows");
  if (process.env.HOME) assert.match(footerRow!, /~\//, "the working directory is home shortened");
});

test("the composer names one contextual hint at a time", () => {
  const at = (width: number, input: Partial<Parameters<typeof composerHint>[0]>) =>
    composerHint({
      draft: "",
      focused: true,
      running: false,
      approval: false,
      width,
      ...input,
    });
  // The full ladder, widest frame: one surface per hint, never a legend.
  assert.equal(at(80, {}), "Enter send · Ctrl+J new line");
  assert.equal(at(80, { draft: "/mo" }), "Tab complete · Enter run");
  assert.equal(at(80, { running: true }), "Esc stop · Ctrl+O detail");
  assert.equal(
    at(80, { approval: true }),
    "/approvals to review",
  );
  assert.equal(at(80, { focused: false }), "Tab to write");
  // The blocking state wins over the draft and the focus, because it is what
  // the operator has to answer before the composer can act again. In Chat the
  // decision keys belong to the review overlay, so the hint names the path
  // that actually works here.
  assert.equal(
    at(80, { approval: true, running: true, focused: false, draft: "/x" }),
    "/approvals to review",
  );
  // At 56 columns and below only the first clause survives.
  for (const width of [20, 40, 56])
    assert.equal(at(width, {}), "Enter send", `width ${width}`);
  assert.equal(at(56, { running: true }), "Esc stop");
  assert.equal(at(40, { focused: false }), "Tab to write");
  assert.equal(at(40, { draft: "/mo" }), "Tab complete");
});

test("a long slot does not cost the composer rail a short one behind it", () => {
  const rail = (input: Partial<Parameters<typeof composerTopRail>[0]>) =>
    composerTopRail({
      label: "Draft",
      hint: "Enter send",
      width: 56,
      tl: "╭",
      h: "─",
      tr: "╮",
      ...input,
    });
  // The model name does not fit; the context meter behind it still does, so
  // it must appear. Dropping the whole tail would hide a real measurement
  // because of a name.
  const narrow = rail({
    width: 40,
    model: "◐ a-very-long-provider-model-name",
    context: "▤ 12k",
  });
  assert.match(narrow, /12k/);
  assert.doesNotMatch(narrow, /a-very-long-provider-model-name/);
  assert.equal(narrow.length, 40, "the rail stays exactly its width");
});

test("the queue chip only uses spare composer rail cells", () => {
  const input = { label: "Draft", hint: "Enter send", tl: "+", h: "-", tr: "+" };
  const idle = composerTopRail({ ...input, width: 40 });
  const queued = composerTopRail({ ...input, width: 40, queue: "# 1 queued" });
  const narrow = composerTopRail({ ...input, width: 22, queue: "# 1 queued" });
  assert.doesNotMatch(idle, /queued/);
  assert.match(queued, /Enter send # 1 queued/);
  assert.equal(narrow, composerTopRail({ ...input, width: 22 }));
  assert.equal(queued.length, 40);
  assert.equal(narrow.length, 22);
});

test("the composer slot ladder drops the lowest rung whole at five widths", () => {
  // DESIGN.md slot ladder: the label and the hint are required, then
  // queue > attachment > model > context > pet dock. There is no mode slot:
  // the mode keeps its status-row pill (docs/DECISIONS.md, 2026-11-25).
  assert.deepEqual(
    [...COMPOSER_SLOT_LADDER],
    ["queue", "attachment", "model", "context", "dock"],
  );
  const slots = {
    queue: "≡ 1 queued",
    attachment: "@plan.md",
    model: "◐ fixture-model",
    context: "ctx ▰▰▰▱▱ 62%",
    dock: "▦ writing...",
  } as const;
  const glyphs = { tl: "╭", h: "─", tr: "╮" };
  const seen: Record<number, string[]> = {};
  for (const width of [40, 80, 120, 160, 200]) {
    const hint = composerHint({
      draft: "",
      focused: true,
      running: false,
      approval: false,
      width,
    });
    const rail = composerTopRail({
      label: "Draft",
      hint,
      ...slots,
      width,
      ...glyphs,
    });
    assert.equal(visibleLength(rail), width, `rail ${width} is not ${width} cells`);
    assert.ok(rail.startsWith(`╭─ Draft ${hint}`), `${width} loses the hint`);
    assert.ok(rail.endsWith("╮"), `${width} loses the corner`);
    assert.ok(!rail.includes("…"), `${width} clips a slot instead of dropping it`);
    // Every slot is either whole or absent, and they appear in ladder order.
    const present = COMPOSER_SLOT_LADDER.filter((slot) =>
      rail.includes(slots[slot]),
    );
    const positions = present.map((slot) => rail.indexOf(slots[slot]));
    assert.deepEqual(
      positions,
      [...positions].sort((a, b) => a - b),
      `${width} slots out of ladder order`,
    );
    seen[width] = present;
  }
  // Narrow rails keep the top rungs and drop the rest whole.
  assert.deepEqual(seen[40], ["queue", "attachment"]);
  assert.deepEqual(seen[80], ["queue", "attachment", "model"]);
  for (const width of [120, 160, 200])
    assert.deepEqual(seen[width], [...COMPOSER_SLOT_LADDER], `${width}`);
});

test("a long rail label gives up whole words before the action hint", () => {
  const glyphs = { tl: "╭", h: "─", tr: "╮" };
  const review = composerTopRail({
    label: "Draft Review required",
    hint: "/approvals to review",
    queue: "≡ 1 queued",
    width: 40,
    ...glyphs,
  });
  assert.equal(visibleLength(review), 40);
  assert.ok(review.includes("/approvals to review"), "40 loses the hint");
  assert.ok(review.startsWith("╭─ Draft Review /approvals"), review);
  assert.ok(!review.includes("…"), "a word was clipped");
  // A wide rail keeps the whole label.
  const wide = composerTopRail({
    label: "Draft Review required",
    hint: "/approvals to review",
    width: 80,
    ...glyphs,
  });
  assert.ok(wide.startsWith("╭─ Draft Review required /approvals to review"));
  // The first label word always stays, so the rail still names itself.
  const tiny = composerTopRail({
    label: "Draft Review required",
    hint: "/approvals to review",
    width: 24,
    ...glyphs,
  });
  assert.equal(visibleLength(tiny), 24);
  assert.ok(tiny.startsWith("╭─ Draft"), tiny);
});

test("the Chat composer rail is width exact at five widths with no mode chip", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "nomo-tui-slot-ladder-"));
  const app = new Workbench({ NOMO_DATA_DIR: root });
  t.after(async () => {
    await app.shutdown();
    await rm(root, { recursive: true, force: true });
  });
  const ui = new WorkspaceTui(app, { NOMO_DATA_DIR: root });
  ui.choose("chat");
  ui.model = "fixture-model";
  ui.queuedPrompt = "next step";
  for (const [width, height] of [
    [40, 12],
    [80, 24],
    [120, 40],
    [160, 45],
    [200, 48],
  ] as const) {
    const rows = stripAnsi(
      renderWorkspace(ui, width, height, "", true, false, {
        color: false,
        motion: false,
      }),
    ).split("\n");
    assert.equal(rows.length, height, `${width}x${height} rows`);
    const index = rows.findIndex((row) => row.includes("╭─ Draft"));
    assert.ok(index >= 0, `${width}x${height} loses the rail`);
    const row = rows[index]!;
    assert.equal(visibleLength(row), width, `${width}x${height} frame row`);
    const rail = row.slice(row.indexOf("╭"), row.indexOf("╮") + 1);
    assert.ok(rail.includes("Enter send"), `${width}x${height} loses the hint`);
    assert.ok(rail.includes("1 queued"), `${width}x${height} loses the queue`);
    assert.ok(!/mode:|\bnormal\b/i.test(rail), `${width}x${height} mode chip`);
    assert.ok(!rail.includes("…"), `${width}x${height} clips a slot`);
  }
});

test("the composer rails keep their width and freeze under reduced motion", () => {
  const glyphs = { tl: "╭", h: "─", tr: "╮", bl: "╰", br: "╯" };
  for (const width of [20, 40, 56, 80, 200]) {
    const top = composerTopRail({
      label: "Draft",
      hint: "Enter send · Ctrl+J new line",
      dock: "▦ idle",
      width,
      ...glyphs,
    });
    assert.equal(visibleLength(top), width, `top ${width}`);
    assert.ok(top.startsWith("╭─ Draft"), `top ${width} lost the label`);
    assert.ok(top.endsWith("╮"), `top ${width} lost the corner`);
    const bottom = composerBottomRail({
      width,
      bl: glyphs.bl,
      br: glyphs.br,
      h: glyphs.h,
      streaming: true,
      frame: 8,
      reduced: false,
    });
    assert.equal(visibleLength(bottom), width, `bottom ${width}`);
    assert.equal(bottom.split("").filter((cell) => cell === "━").length, 1);
    // Reduced motion holds the same first cell instead of hiding the phase.
    const frozen = composerBottomRail({
      width,
      bl: glyphs.bl,
      br: glyphs.br,
      h: glyphs.h,
      streaming: true,
      frame: 800,
      reduced: true,
    });
    assert.equal(frozen.indexOf("━"), 1, `frozen ${width}`);
  }
  // A non-streaming rail carries no lit cell at all.
  assert.ok(
    !composerBottomRail({
      width: 40,
      bl: "╰",
      br: "╯",
      h: "─",
      streaming: false,
      frame: 8,
      reduced: false,
    }).includes("━"),
  );
});

test("the composer rail gradient falls back to one tone and paints no background", () => {
  const palette = getPalette("default");
  const rail = composerTopRail({
    label: "Draft",
    hint: "Enter send",
    width: 40,
    tl: "╭",
    h: "─",
    tr: "╮",
  });
  const capsAt = (colorDepth: 0 | 4 | 8 | 24) => ({
    interactive: true,
    ansi: colorDepth !== 0,
    colorDepth,
    columns: 40,
    rows: 12,
    reason: "interactive" as const,
  });
  // Truecolor: several stops, foreground only, same visible rail.
  const gradient = paintComposerRail(rail, "accent", palette, capsAt(24));
  assert.equal(stripAnsi(gradient), rail, "the gradient changes no cell");
  assert.ok((gradient.match(/38;2;/g) ?? []).length > 1, "gradient stops");
  assert.ok(!gradient.includes("48;"), "the rail never paints a background");
  assert.ok(gradient.endsWith("\u001b[0m"), "the rail resets its colour");
  // 256 and 16 colour terminals get one flat tone instead of a gradient.
  for (const depth of [8, 4] as const) {
    const flat = paintComposerRail(rail, "accent", palette, capsAt(depth));
    assert.equal(stripAnsi(flat), rail, `depth ${depth} changes no cell`);
    assert.equal(
      (flat.match(/\u001b\[/g) ?? []).length,
      2,
      `depth ${depth} uses one tone`,
    );
    assert.ok(!flat.includes("48;"), `depth ${depth} background`);
  }
  // A monochrome terminal gets the plain rail, byte for byte.
  assert.equal(paintComposerRail(rail, "accent", palette, capsAt(0)), rail);
  // The tone ladder comes from real state, never from the colour alone.
  assert.equal(
    composerRailTone({ focused: false, approval: false, failed: false }),
    "muted",
  );
  assert.equal(
    composerRailTone({ focused: true, approval: false, failed: false }),
    "accent",
  );
  assert.equal(
    composerRailTone({ focused: true, approval: true, failed: false }),
    "warning",
  );
  assert.equal(
    composerRailTone({ focused: false, approval: false, failed: true }),
    "error",
  );
});

test("the rail chips name the real model and the real context share", () => {
  assert.equal(composerModelChip("fixture-model", "◐"), "◐ fixture-model");
  assert.equal(composerModelChip("fixture-model", "[M]"), "[M] fixture-model");
  assert.equal(composerModelChip(undefined, "◐"), "", "no model, no chip");
  assert.equal(composerModelChip("   ", "◐"), "", "a blank model is no model");
  assert.ok(
    visibleLength(composerModelChip("vendor/very-long-model-name-2026", "◐")) <=
      26,
    "the chip stays inside its cap",
  );

  assert.equal(
    composerContextChip(undefined),
    "",
    "an unreported share has no meter",
  );
  assert.equal(composerContextChip(62), "ctx ▰▰▰▱▱ 62%");
  assert.equal(composerContextChip(0), "ctx ▱▱▱▱▱ 0%");
  assert.equal(composerContextChip(100), "ctx ▰▰▰▰▰ 100%");
  assert.equal(
    composerContextChip(62, "ascii"),
    "ctx ###-- 62%",
    "the ASCII preset keeps the chip ASCII",
  );
});

test("the attachment chip names only a path the draft really references", () => {
  const paths = ["plan.md", "notes/todo.md"];
  assert.equal(
    composerAttachmentChip("write @plan.md next", paths),
    "@plan.md",
  );
  assert.equal(
    composerAttachmentChip("write @plan.md and @notes/todo.md", paths),
    "@plan.md @notes/todo.md",
  );
  assert.equal(
    composerAttachmentChip("write @ghost.md", paths),
    "",
    "an unknown path is no attachment",
  );
  assert.equal(
    composerAttachmentChip("write plan.md", paths),
    "",
    "a bare path is not a mention",
  );
  assert.equal(
    composerAttachmentChip("mail me @plan.md", []),
    "",
    "no managed path, no chip",
  );
});

test("the rail drops a status chip before the hint or a review key", () => {
  const glyphs = { tl: "╭", h: "─", tr: "╮" };
  const full = composerTopRail({
    label: "Draft",
    hint: "Enter send · Ctrl+J new line",
    dock: "▦ idle",
    attachment: "@plan.md",
    model: "◐ fixture-model",
    context: "ctx ▰▰▰▱▱ 62%",
    width: 120,
    ...glyphs,
  });
  assert.equal(visibleLength(full), 120);
  for (const slot of [
    "Enter send",
    "▦ idle",
    "@plan.md",
    "◐ fixture-model",
    "ctx ▰▰▰▱▱ 62%",
  ])
    assert.ok(full.includes(slot), `120 loses ${slot}`);
  // A narrower rail drops whole slots from the lowest priority up; a short
  // lower slot (the dock) may still use cells a longer higher one could not.
  const medium = composerTopRail({
    label: "Draft",
    hint: "Enter send · Ctrl+J new line",
    dock: "▦ idle",
    attachment: "@plan.md",
    model: "◐ fixture-model",
    context: "ctx ▰▰▰▱▱ 62%",
    width: 60,
    ...glyphs,
  });
  assert.equal(visibleLength(medium), 60);
  assert.ok(medium.includes("Enter send"), "the hint survives");
  assert.ok(medium.includes("▦ idle"), "the dock survives the chips");
  assert.ok(medium.includes("@plan.md"), "the attachment survives the chips");
  assert.ok(!medium.includes("fixture-model"), "the model chip is dropped");
  assert.ok(!medium.includes("ctx "), "the context meter is dropped");
  const narrow = composerTopRail({
    label: "Draft",
    hint: "Enter send · Ctrl+J new line",
    dock: "▦ idle",
    attachment: "@plan.md",
    width: 48,
    ...glyphs,
  });
  assert.equal(visibleLength(narrow), 48);
  assert.ok(narrow.includes("Enter send"), "the hint still survives");
  // The pet dock is the lowest rung of the slot ladder (DESIGN.md), so it
  // goes before the attachment the draft really references.
  assert.ok(narrow.includes("@plan.md"), "the attachment outranks the dock");
  assert.ok(!narrow.includes("▦ idle"), "the dock is dropped first");
  // The compact review rail keeps both decision keys at forty columns.
  const review = composerTopRail({
    label: "Review",
    hint: "y allow · n deny",
    gap: "  ",
    width: 40,
    ...glyphs,
  });
  assert.equal(visibleLength(review), 40);
  assert.ok(review.includes("y allow"), "40 loses y allow");
  assert.ok(review.includes("n deny"), "40 loses n deny");
});

test("the pet bubble is drawn only where the frame can afford it", () => {
  const base = {
    state: "streaming" as const,
    width: 80,
    height: 24,
    enabled: true,
    approval: false,
    confirmation: false,
  };
  const rows = composerPetBubble(base);
  assert.ok(rows.length >= 1 && rows.length <= 2, "one or two rows");
  assert.ok(
    rows.every((row) => visibleLength(row) === 80),
    "the bubble is width exact",
  );
  assert.ok(rows.join("\n").includes("NIB: writing..."));
  assert.deepEqual(
    composerPetBubble({ ...base, state: "idle" }),
    [],
    "an idle pet draws no bubble",
  );
  assert.deepEqual(
    composerPetBubble({ ...base, approval: true }),
    [],
    "an approval owns the rows",
  );
  assert.deepEqual(
    composerPetBubble({ ...base, confirmation: true }),
    [],
    "a review owns the keys",
  );
  assert.deepEqual(
    composerPetBubble({ ...base, width: 19 }),
    [],
    "below twenty columns there is no room",
  );
  assert.deepEqual(
    composerPetBubble({ ...base, height: 12 }),
    [],
    "below sixteen rows the composer comes first",
  );
  assert.deepEqual(
    composerPetBubble({ ...base, enabled: false }),
    [],
    "a hidden pet says nothing",
  );
});

test("the dock caption reads the pet's real reaction", () => {
  assert.equal(composerPetDockCaption("idle"), "▦ idle");
  assert.equal(
    composerPetDockCaption("tool", { tool: "read parser" }),
    "▦ reading parser...",
  );
  const thinking = composerPetDockCaption("thinking", {
    provider: "OpenCode Zen",
  });
  assert.ok(thinking.startsWith("▦ waiting for"), thinking);
  assert.ok(visibleLength(thinking) <= 24, "the dock caption stays capped");
  assert.equal(
    composerPetDockCaption("thinking"),
    "▦ waiting for provider",
    "without a provider the reaction names what it waits on",
  );
});

test("runErrorEvent reads only a real run error", () => {
  const events = [
    {
      seq: 1,
      at: "2026-09-15T10:00:00.000Z",
      kind: "user" as const,
      type: "message.completed",
      text: "hi",
    },
    {
      seq: 2,
      at: "2026-09-15T10:00:01.000Z",
      kind: "error" as const,
      type: "run.error",
      text: "failed",
    },
    {
      seq: 3,
      at: "2026-09-15T10:00:02.000Z",
      kind: "tool" as const,
      type: "run.status",
      text: "",
    },
  ];
  assert.equal(runErrorEvent(events)?.seq, 2);
  assert.equal(
    runErrorEvent(events, "running"),
    undefined,
    "a live run has not failed",
  );
  assert.equal(runErrorEvent([events[0]!]), undefined, "a message is not an error");
});

test("a failed run keeps an error rail, its message and the composer", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "nomo-tui-error-rail-"));
  const app = new Workbench(
    { NOMO_DATA_DIR: root },
    async (url) =>
      String(url).endsWith("/models")
        ? Response.json({ data: [{ id: "fixture" }] })
        : new Response("private provider failure", { status: 429 }),
  );
  t.after(async () => {
    await app.shutdown();
    await rm(root, { recursive: true, force: true });
  });
  await app.configure({
    baseUrl: "https://fixture.test/v1",
    apiKey: "fixture-key",
  });
  const ui = new WorkspaceTui(app, { NOMO_DATA_DIR: root });
  await ui.initialize();
  const session = await app.start("Hello", "fixture");
  while (app.get(session.id)?.status === "running")
    await new Promise((resolve) => setTimeout(resolve, 5));
  await ui.command(`/open ${session.id}`);
  ui.choose("chat");
  ui.model = "fixture";

  const narrow = stripAnsi(
    renderWorkspace(ui, 40, 12, "", false, false, {
      color: false,
      motion: false,
    }),
  ).split("\n");
  assert.equal(narrow.length, 12);
  const narrowRail = narrow.find((row) => row.includes("╭─ Error"));
  assert.ok(narrowRail, "the rail names the failure");
  assert.ok(narrowRail!.includes("Esc dismiss"), "the rail names the real key");
  assert.equal(visibleLength(narrowRail!), 40, "the error rail keeps its width");
  assert.ok(
    narrow.some((row) => row.includes("! Provider rate limit")),
    "the status row prints the provider's message",
  );
  assert.ok(
    narrow.at(-1)!.includes("◆ 0"),
    "the activity keys keep the last row",
  );
  assert.ok(
    !narrow.some((row) => row.includes("( NIB")),
    "no bubble below sixteen rows",
  );
  const focused = stripAnsi(
    renderWorkspace(ui, 40, 12, "", true, false, {
      color: false,
      motion: false,
    }),
  ).split("\n");
  assert.ok(
    focused.some((row) => row.includes("╭─ Draft")),
    "a focused composer returns to Draft while the error stays in the transcript",
  );
  assert.ok(
    focused.some((row) => row.includes("! Provider rate limit")),
    "the focused frame still names the failure",
  );

  const wide = stripAnsi(
    renderWorkspace(ui, 80, 24, "", false, false, {
      color: false,
      motion: false,
    }),
  ).split("\n");
  assert.equal(wide.length, 24);
  assert.ok(
    wide.some((row) => row.includes("╭─ Error") && row.includes("Esc dismiss")),
    "80x24 loses the error rail",
  );
  assert.ok(
    wide.some((row) => row.includes("▦ failed")),
    "the dock reads the pet's real reaction",
  );
  assert.ok(
    wide.some((row) => row.includes("! Provider rate limit")),
    "the status row repeats the message",
  );
  assert.ok(
    wide.some((row) => row.includes("( NIB: failed )")),
    "the pet bubble rides above the composer",
  );
  assert.ok(
    focused.some((row) => row.includes("│ █")),
    "the caret stays in the composer",
  );

  // Esc dismiss: the rail returns to Draft, the transcript keeps the error.
  assert.equal(ui.dismissRunError(), true);
  assert.equal(ui.dismissRunError(), false, "a dismissed rail stays dismissed");
  const dismissed = stripAnsi(
    renderWorkspace(ui, 80, 24, "", true, false, {
      color: false,
      motion: false,
    }),
  );
  assert.ok(dismissed.includes("╭─ Draft"), "the rail returns to Draft");
  assert.ok(!dismissed.includes("╭─ Error"), "the error rail is gone");
  assert.ok(
    dismissed.includes("Provider rate limit reached"),
    "the transcript keeps the error",
  );
});

test("the attachment chip is drawn only for a managed path in the draft", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "nomo-tui-attachment-chip-"));
  // A real write goes through the managed document tool, so the chip is
  // checked against a path the send path would really accept.
  const app = new Workbench(
    { NOMO_DATA_DIR: root },
    async (url, options) => {
      if (String(url).endsWith("/models"))
        return Response.json({ data: [{ id: "fixture-model" }] });
      const body = JSON.parse(String(options?.body));
      const tool = body.tools.find((entry: { function: { description: string } }) =>
        entry.function.description.startsWith("void_workspace_write:"),
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
                            content: "# Plan",
                          }),
                        },
                      },
                    ],
                  },
            finish_reason:
              body.messages.at(-1).role === "tool" ? "stop" : "tool_calls",
          },
        ],
      });
    },
  );
  t.after(async () => {
    await app.shutdown();
    await rm(root, { recursive: true, force: true });
  });
  await app.configure({
    baseUrl: "https://fixture.test/v1",
    apiKey: "fixture-key",
  });
  const ui = new WorkspaceTui(app, { NOMO_DATA_DIR: root });
  await ui.initialize();
  await ui.command("Write the plan");
  await app.settled();
  await ui.refresh();
  const sessionId = ui.sessionId!;
  assert.equal(
    app.workspace(sessionId).files["plan.md"],
    "# Plan",
    "the fixture really wrote the managed document",
  );
  ui.choose("chat");
  ui.model = "fixture-model";

  const railFor = (draft: string) =>
    stripAnsi(
      renderWorkspace(ui, 120, 40, draft, true, false, {
        color: false,
        motion: false,
      }),
    )
      .split("\n")
      .find((row) => row.includes("╭─ Draft")) ?? "";

  const real = railFor("summarize @plan.md");
  assert.ok(real.includes("@plan.md"), "the rail names the real attachment");
  assert.equal(visibleLength(real), 120);
  const unknown = railFor("summarize @ghost.md");
  assert.ok(
    !unknown.includes("@ghost.md"),
    "an unknown path is never shown as an attachment",
  );
  assert.ok(!unknown.includes("@"), "no attachment chip without a real path");
});

test("the composer keeps five sizes exact, focused and unfocused", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "nomo-tui-composer-sizes-"));
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
    [60, 16],
    [80, 24],
    [120, 32],
    [200, 48],
  ] as const) {
    for (const focused of [true, false]) {
      const frame = renderWorkspace(ui, width, height, "", focused, false, {
        color: false,
        motion: false,
      });
      const rows = frame.split("\n");
      assert.equal(rows.length, height, `${width}x${height} rows`);
      assert.ok(
        rows.every((row) => visibleLength(row) <= width),
        `${width}x${height} overflows`,
      );
      assert.ok(
        rows.some((row) => row.includes("╭─ Draft")),
        `${width}x${height} loses the top rail`,
      );
      assert.ok(
        rows.some((row) => row.trimStart().startsWith("╰")),
        `${width}x${height} loses the bottom rail`,
      );
      // The hint is the only rail text that changes with focus, and the
      // caret only exists when the composer owns the keyboard.
      assert.ok(
        frame.includes(focused ? "Enter send" : "Tab to write"),
        `${width}x${height} loses the focus hint`,
      );
      assert.equal(
        /│[^│]*[█▌]/.test(stripAnsi(frame)),
        focused,
        `${width}x${height} caret follows focus`,
      );
    }
  }
});

test("the pet docks on the composer rail without spending a row", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "nomo-tui-pet-dock-"));
  const app = new Workbench({ NOMO_DATA_DIR: root });
  t.after(async () => {
    await app.shutdown();
    await rm(root, { recursive: true, force: true });
  });
  const ui = new WorkspaceTui(app, { NOMO_DATA_DIR: root });
  ui.choose("chat");
  ui.model = "fixture-model";
  assert.equal(app.list().length, 0, "no conversation exists yet");

  // 80x24 is the dock: the rail gains a mark and the frame keeps 24 rows.
  const docked = stripAnsi(
    renderWorkspace(ui, 80, 24, "", true, false, {
      color: false,
      motion: false,
    }),
  );
  assert.equal(docked.split("\n").length, 24);
  assert.ok(docked.includes("▦ idle"), "the dock names the state");
  assert.ok(!docked.includes("NIB idle"), "the perch did not also draw");
  // The status row reports the model, the context share and an honest rate:
  // no provider reported one here, so it prints n/a instead of a number.
  assert.match(docked, /fixture-model/);
  assert.match(docked, /tok\/s n\/a/);
  assert.doesNotMatch(docked, /tok\/s \d/);
  assert.ok(
    docked.split("\n").find((row) => row.includes("╭─ Draft"))!.includes("▦ idle"),
    "the dock rides the composer rail",
  );

  // /pet perch moves it back to the header at the same frame height.
  await ui.command("/pet perch");
  assert.equal(ui.petPlacement, "perch");
  assert.equal(app.list().length, 0, "/pet perch sent a prompt");
  const perched = stripAnsi(
    renderWorkspace(ui, 120, 40, "", true, false, {
      color: false,
      motion: false,
    }),
  );
  assert.equal(perched.split("\n").length, 40);
  assert.ok(perched.includes("NIB idle"), "the perch names the state");
  assert.ok(!perched.includes("▦ idle"), "the dock did not also draw");

  // /pet dock is explicit, and /pet off hides either form.
  await ui.command("/pet dock");
  assert.equal(ui.petPlacement, "dock");
  assert.ok(
    stripAnsi(
      renderWorkspace(ui, 80, 24, "", false, false, {
        color: false,
        motion: false,
      }),
    ).includes("▦ idle"),
  );
  await ui.command("/pet off");
  assert.equal(ui.petEnabled, false);
  const off = stripAnsi(
    renderWorkspace(ui, 80, 24, "", false, false, {
      color: false,
      motion: false,
    }),
  );
  assert.ok(!off.includes("▦ idle"), "/pet off still drew the dock");
  assert.ok(!off.includes("NIB"), "/pet off still drew the pet");
  await ui.command("/pet on");
  assert.equal(ui.petPlacement, "auto");
});

test("the image pet draws only where the transfer was actually sent", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "nomo-tui-pet-image-"));
  const app = new Workbench({ NOMO_DATA_DIR: root });
  t.after(async () => {
    await app.shutdown();
    await rm(root, { recursive: true, force: true });
  });
  const imageEnv = {
    NOMO_DATA_DIR: root,
    TERM_PROGRAM: "ghostty",
    TERM: "xterm-ghostty",
    NOMO_TUI_IMAGE: "1",
    // This file forces NO_COLOR so the hostile-text assertion stays
    // unconditional; the opt-in test asks for colour explicitly.
    FORCE_COLOR: "1",
  };
  const render = (ui: WorkspaceTui) =>
    renderWorkspace(ui, 120, 40, "", false, false, {
      color: true,
      motion: true,
      capabilities: colorCaps(120, 40),
    });

  // Piped output: no TTY, so the transfer channel never opens and the frame
  // must stay ASCII even though the environment asks for the image.
  const piped = new WorkspaceTui(app, imageEnv);
  await piped.initialize();
  piped.choose("chat");
  piped.model = "fixture-model";
  await piped.command("/pet perch");
  assert.equal(piped.localTabIcons, undefined, "a piped terminal has icons");
  const ascii = render(piped);
  assert.ok(!ascii.includes("\x1b_G"), "a piped frame carried a transfer");
  assert.ok(!ascii.includes("\u{10eeee}"), "a piped frame carried placeholders");
  assert.ok(stripAnsi(ascii).includes("NIB idle"), "the ASCII perch vanished");

  // macOS Terminal.app refuses the protocol outright, whatever the opt-in.
  const apple = new WorkspaceTui(app, {
    ...imageEnv,
    TERM_PROGRAM: "Apple_Terminal",
    TERM: "xterm-256color",
  });
  await apple.initialize();
  apple.choose("chat");
  apple.model = "fixture-model";
  await apple.command("/pet perch");
  const terminalApp = render(apple);
  assert.ok(!terminalApp.includes("\x1b_G"));
  assert.ok(!terminalApp.includes("\u{10eeee}"));
  assert.ok(stripAnsi(terminalApp).includes("NIB idle"));

  // With a TTY the transfer is sent at activation, so the same frame carries
  // one-cell placeholders while the caption stays text.
  const ttyDescriptor = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
  Object.defineProperty(process.stdout, "isTTY", {
    value: true,
    configurable: true,
    writable: true,
  });
  t.after(() => {
    if (ttyDescriptor)
      Object.defineProperty(process.stdout, "isTTY", ttyDescriptor);
    else delete (process.stdout as { isTTY?: boolean }).isTTY;
  });
  const ghostty = new WorkspaceTui(app, imageEnv);
  await ghostty.initialize();
  ghostty.choose("chat");
  ghostty.model = "fixture-model";
  await ghostty.command("/pet perch");
  assert.ok(ghostty.localTabIcons, "the transfer channel did not open");
  const image = render(ghostty);
  // The tab icons share the placeholder code point, so the pet's rows are
  // found by the image id in their foreground colour.
  const petRows = image
    .split("\n")
    .filter((line) => line.includes("\x1b[38;2;78;73;66m"));
  assert.equal(petRows.length, 5, "the perch did not draw the image rows");
  for (const row of petRows)
    assert.equal(row.match(/\u{10eeee}/gu)?.length, 9, "pet row width");
  // The transfer itself is written once, outside the frame, so no row of the
  // frame may carry it and no row may lose the width contract.
  assert.ok(!image.includes("\x1b_G"), "the frame carried the transfer");
  const lines = image.split("\n");
  assert.equal(lines.length, 40);
  for (const line of lines) assert.equal(visibleLength(line), 120);
  assert.ok(stripAnsi(image).includes("NIB idle"), "the caption is not text");
  // A 40x12 frame never reaches the perch, so it stays ASCII even here.
  const compact = renderWorkspace(ghostty, 40, 12, "", false, false, {
    color: true,
    motion: true,
    capabilities: colorCaps(40, 12),
  });
  assert.equal(compact.split("\n").length, 12);
  assert.ok(
    !compact.includes("\x1b[38;2;78;73;66m"),
    "40x12 drew the image pet",
  );
  assert.ok(!compact.includes("\x1b_G"), "40x12 carried a transfer");
  // And /pet off still removes the pet completely.
  await ghostty.command("/pet off");
  const off = render(ghostty);
  assert.ok(!off.includes("\x1b[38;2;78;73;66m"), "/pet off kept the image");
  assert.ok(!stripAnsi(off).includes("NIB"));
});

test("Alt+N and Alt+Shift+N are display keys and never send a prompt", async (t) => {
  assert.equal(isPetToggleKey({ name: "n", meta: true }), true);
  assert.equal(isPetToggleKey({ name: "k", meta: true }), true);
  assert.equal(isPetToggleKey({ name: "n" }), false);
  assert.equal(isPetToggleKey({ name: "n", meta: true, shift: true }), false);
  assert.equal(isPetCardKey({ name: "n", meta: true, shift: true }), true);
  assert.equal(isPetCardKey({ name: "n", meta: true }), false);
  assert.equal(isPetCardKey({ name: "n", meta: true, shift: true, ctrl: true }), false);
  // Neither chord is a workspace shortcut, so it cannot fall through to a
  // submit path.
  assert.equal(
    workspaceShortcut({ name: "n", meta: true }, true, "", undefined, "chat"),
    undefined,
  );
  assert.equal(
    workspaceShortcut(
      { name: "n", meta: true, shift: true },
      true,
      "",
      undefined,
      "chat",
    ),
    undefined,
  );

  const root = await mkdtemp(join(tmpdir(), "nomo-tui-pet-card-"));
  const app = new Workbench({ NOMO_DATA_DIR: root });
  t.after(async () => {
    await app.shutdown();
    await rm(root, { recursive: true, force: true });
  });
  const ui = new WorkspaceTui(app, { NOMO_DATA_DIR: root });
  ui.choose("chat");
  assert.equal(app.list().length, 0);
  ui.petCard = true;
  const card = stripAnsi(
    renderWorkspace(ui, 80, 24, "", false, false, {
      color: false,
      motion: false,
    }),
  );
  assert.equal(card.split("\n").length, 24, "the card costs no extra row");
  assert.match(card, /NIB {2}Alt\+Shift\+N close/);
  assert.match(card, /reads: NIB idle/);
  assert.match(card, /signal: /);
  assert.equal(app.list().length, 0, "opening the card sent a prompt");
  ui.petCard = false;
});

test("the splash is a three-row card once, dismissed by a key or the deadline", async (t) => {
  const now = 1_000_000;
  assert.equal(uiSplashFrame(80, 24), 24);
  assert.equal(uiSplashFrame(20, 24), null, "below the card width");
  assert.ok(renderPetSplashFrame(80, 24)!.includes("NIB is awake"));

  const root = await mkdtemp(join(tmpdir(), "nomo-tui-pet-splash-"));
  const app = new Workbench({ NOMO_DATA_DIR: root });
  t.after(async () => {
    await app.shutdown();
    await rm(root, { recursive: true, force: true });
  });
  const ui = new WorkspaceTui(app, { NOMO_DATA_DIR: root });
  ui.choose("chat");
  ui.petSplashUntil = now + PET_SPLASH_MS;
  const splash = stripAnsi(
    renderWorkspace(ui, 80, 24, "", false, false, {
      color: false,
      motion: false,
      now,
    }),
  );
  assert.equal(splash.split("\n").length, 24);
  assert.ok(splash.includes("NIB is awake"), "the splash is up");
  assert.ok(!splash.includes("╭─ Draft"), "the splash owns the frame");
  // A key dismisses it immediately and the workspace comes back.
  assert.equal(ui.dismissPetSplash(now + 1), true);
  assert.equal(ui.dismissPetSplash(now + 2), false, "dismissal is idempotent");
  const back = stripAnsi(
    renderWorkspace(ui, 80, 24, "", false, false, {
      color: false,
      motion: false,
      now: now + 2,
    }),
  );
  assert.ok(back.includes("╭─ Draft"), "the workspace returned");
  // The deadline takes it down even with no key.
  ui.petSplashUntil = now + PET_SPLASH_MS;
  const expired = stripAnsi(
    renderWorkspace(ui, 80, 24, "", false, false, {
      color: false,
      motion: false,
      now: now + PET_SPLASH_MS,
    }),
  );
  assert.ok(expired.includes("╭─ Draft"), "the deadline dismissed the splash");
});

function uiSplashFrame(width: number, height: number): number | null {
  const frame = renderPetSplashFrame(width, height);
  return frame === null ? null : frame.split("\n").length;
}

// The sessions browser: a flat row per conversation under collapsible
// section headings, and an inspector beside it only when the terminal can
// afford the second pane. These fixtures are the only inputs, so a row can
// never gain a fact the workbench did not record.

function sessionFixture(
  overrides: Partial<SessionView> & { readonly id: string },
): SessionView {
  return {
    workspace: `ws-${overrides.id}`,
    model: "gpt-5",
    title: overrides.id,
    createdAt: "2026-01-02T03:00:00.000Z",
    updatedAt: "2026-01-02T03:02:00.000Z",
    status: "idle",
    events: [],
    continuationCount: 0,
    runTokenCount: 12_000,
    contextMessages: 2,
    provider: "fixture",
    ...overrides,
  };
}

test("a sessions row keeps its title and drops the least useful fact first", () => {
  const facts = {
    glyph: "●",
    title: "Fix parser",
    model: "gpt-5",
    elapsed: "2m",
    tokens: "12k",
    children: 2,
  };
  assert.equal(
    sessionRowLine(facts, 60),
    "● Fix parser · ◐ gpt-5 · ◷ 2m · # 12k · ◆ 2",
  );
  // Every fact carries a one-cell icon, so a count never needs the word beside
  // it: "tok" and "sub" would repeat the glyph they follow.
  const whole = sessionRowLine(facts, 60);
  assert.doesNotMatch(whole, / tok| sub/u);
  assert.ok(whole.includes("◐ gpt-5"), "the model icon names the model");
  assert.ok(whole.includes("◷ 2m"), "the clock names the elapsed span");
  assert.ok(whole.includes("# 12k"), "the token icon names the count");
  assert.ok(whole.includes("◆ 2"), "the agent icon names the subagents");
  // The child count goes first, then the token count, then elapsed, then the
  // model. The title is kept at every width, because it is the only cell that
  // says which conversation the row is.
  assert.equal(sessionRowLine(facts, 24), "● Fix parser · ◐ gpt-5");
  // A row too narrow for any fact keeps the whole title rather than trading
  // half of it for a count nobody asked for.
  assert.equal(sessionRowLine(facts, 18), "● Fix parser");
  assert.equal(sessionRowLine(facts, 12), "● Fix parser");
  assert.equal(sessionRowLine(facts, 10), "● Fix par.");
  assert.ok(!sessionRowLine(facts, 12).includes("gpt-5"));
  assert.ok(visibleLength(sessionRowLine(facts, 12)) <= 12);
  // A row with nothing reported keeps the title and invents no zero.
  assert.equal(
    sessionRowLine(
      { glyph: "○", title: "Quiet", model: "", elapsed: "", tokens: "", children: 0 },
      40,
    ),
    "○ Quiet",
  );
  // The ASCII preset cannot spend three cells on "[M]", so every row icon
  // falls back to one cell and the facts stay in the same columns.
  const ascii = sessionRowIcons("ascii");
  assert.deepEqual(
    [ascii.model, ascii.time, ascii.tokens, ascii.children],
    ["m", "t", "#", "a"],
  );
  assert.equal(
    sessionRowLine(facts, 60, ascii),
    "● Fix parser · m gpt-5 · t 2m · # 12k · a 2",
  );
  for (const icon of Object.values(sessionRowIcons())) {
    assert.equal(visibleLength(icon), 1, `${icon} must occupy one cell`);
  }
});

test("section chevrons and the key bar stay one cell and one short line", () => {
  // The heading pair is the task's own vocabulary: open reads down, folded
  // reads across. Both are one cell, so a heading never shifts its rows.
  assert.equal(sessionSectionChevron(true), "▾");
  assert.equal(sessionSectionChevron(false), "▸");
  assert.equal(sessionSectionChevron(true, "ascii"), "v");
  assert.equal(sessionSectionChevron(false, "ascii"), ">");
  for (const line of [true, false].flatMap((open) => [
    sessionSectionChevron(open),
    sessionSectionChevron(open, "ascii"),
  ]))
    assert.equal(visibleLength(line), 1);
  // The key bar names only what the browser itself does, and drops its tail
  // before it truncates: a 40 column frame reads a whole phrase.
  assert.equal(
    sessionBrowserHint(80),
    "↑↓ move · Enter inspect · g group · esc chat",
  );
  assert.equal(
    sessionBrowserHint(40),
    "↑↓ move · Enter inspect · g group · esc",
  );
  // A 40 column frame leaves the body 37 cells after its gutter, so the bar
  // gives up the group key before it gives up a whole phrase.
  assert.equal(sessionBrowserHint(37), "↑↓ move · Enter inspect · esc chat");
  assert.equal(sessionBrowserHint(30), "↑↓ move · Enter inspect");
  assert.equal(sessionBrowserHint(20), "↑↓ Enter inspect");
  assert.equal(sessionBrowserHint(12), "↑↓ Enter");
  assert.equal(sessionBrowserHint(10), "↑↓ Enter");
  assert.ok(!sessionBrowserHint(80).includes("returns to Chat"));
  for (const width of [80, 40, 30, 20, 12, 10])
    assert.ok(visibleLength(sessionBrowserHint(width)) <= width);
  // An ASCII terminal has no arrow shapes, so movement is spelled with the
  // preset's own `^` and `v`. The words stay identical, so the bar never
  // names a key in one preset that it hides in the other.
  assert.equal(
    sessionBrowserHint(80, "ascii"),
    "^v move · Enter inspect · g group · esc chat",
  );
  assert.equal(
    sessionBrowserHint(37, "ascii"),
    "^v move · Enter inspect · esc chat",
  );
  assert.equal(sessionBrowserHint(12, "ascii"), "^v Enter");
  for (const width of [80, 40, 30, 20, 12, 10])
    assert.ok(visibleLength(sessionBrowserHint(width, "ascii")) <= width);
});

test("elapsed and tokens are read from the record, never from a clock", () => {
  assert.equal(
    sessionElapsedLabel("2026-01-02T03:00:00.000Z", "2026-01-02T03:00:12.000Z"),
    "12s",
  );
  assert.equal(
    sessionElapsedLabel("2026-01-02T03:00:00.000Z", "2026-01-02T03:02:00.000Z"),
    "2m",
  );
  assert.equal(
    sessionElapsedLabel("2026-01-02T03:00:00.000Z", "2026-01-02T06:00:00.000Z"),
    "3h",
  );
  // An unparsable timestamp is not a zero-second span.
  assert.equal(sessionElapsedLabel(undefined, undefined), "");
  assert.equal(sessionTokenLabel(undefined), "");
  assert.equal(sessionTokenLabel(0), "0");
  assert.equal(sessionTokenLabel(1200), "1.2k");
  assert.equal(sessionTokenLabel(12_345), "12k");
  assert.equal(sessionTokenLabel(1_500_000), "1.5M");
});

test("sessions are filed by what needs attention, and only active starts open", () => {
  const sessions = [
    sessionFixture({ id: "run", title: "Running", status: "running" }),
    sessionFixture({ id: "idle", title: "Idle" }),
    sessionFixture({ id: "bad", title: "Failed", status: "failed" }),
    sessionFixture({
      id: "child",
      title: "Child",
      parentId: "run",
      status: "idle",
    }),
    sessionFixture({
      id: "gone",
      title: "Archived",
      archived: true,
      status: "idle",
    }),
  ];
  const model = buildSessionBrowser(sessions);
  assert.deepEqual(
    model.sections.map((section) => section.id),
    ["active", "attention", "children", "archived"],
  );
  assert.deepEqual(
    model.sections.map((section) => section.count),
    [2, 1, 1, 1],
  );
  // A running child stays in the working set: live work is never hidden under
  // a section that starts collapsed.
  assert.equal(model.entries.get("run")?.section, "active");
  assert.equal(model.entries.get("bad")?.section, "attention");
  assert.equal(model.entries.get("child")?.section, "children");
  assert.equal(model.entries.get("gone")?.section, "archived");
  assert.equal(model.entries.get("child")?.glyph, "▸");
  assert.equal(model.entries.get("run")?.glyph, "●");
  assert.equal(model.entries.get("idle")?.glyph, "○");
  assert.equal(model.entries.get("bad")?.glyph, "×");
  assert.equal(model.entries.get("run")?.children, 1);
  // Only the working set is open on the first frame; everything else is one
  // keystroke away. The cursor lands on a conversation, not on its heading.
  const state = initialSessionBrowserState(model);
  assert.deepEqual([...state.expanded], ["section:active"]);
  assert.equal(state.cursor, 1);
  assert.equal(model.nodes[0]?.children?.[0]?.id, "run");
});

test("the inspector threshold is 120 terminal columns", () => {
  assert.equal(SESSION_INSPECTOR_MIN_COLUMNS, 120);
  const narrow = sessionInspectorLayout(119, 30);
  assert.equal(narrow.sideBySide, false);
  assert.equal(narrow.listWidth, 119);
  const wide = sessionInspectorLayout(120, 30);
  assert.equal(wide.sideBySide, true);
  assert.ok(wide.inspectorWidth >= 28 && wide.inspectorWidth <= 40);
  assert.equal(wide.listWidth + 3 + wide.inspectorWidth, 120);
});

test("the sessions browser holds every terminal size it is opened in", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "nomo-tui-sessions-browser-"));
  const app = new Workbench({ NOMO_DATA_DIR: root });
  t.after(async () => {
    await app.shutdown();
    await rm(root, { recursive: true, force: true });
  });
  const views = [
    sessionFixture({ id: "running01", title: "Fix parser", status: "running" }),
    sessionFixture({ id: "idle01", title: "Plan release" }),
    sessionFixture({ id: "failed01", title: "Broken build", status: "failed" }),
    sessionFixture({
      id: "child01",
      title: "Read docs",
      parentId: "running01",
    }),
    sessionFixture({ id: "archived01", title: "Old work", archived: true }),
  ];
  const builtinTools = app.availableTools(undefined);
  t.mock.method(app, "list", () => [...views]);
  t.mock.method(app, "get", (id: string) =>
    views.find((view) => view.id === id),
  );
  t.mock.method(app, "allViews", () => [...views]);
  t.mock.method(app, "availableTools", () => builtinTools);
  t.mock.method(app, "approvals", () => []);
  t.mock.method(app, "pending", () => []);
  const ui = new WorkspaceTui(app, { NOMO_DATA_DIR: root });
  ui.choose("sessions");

  for (const [width, height] of [
    [40, 12],
    [80, 24],
    [120, 40],
    [160, 45],
    [200, 48],
  ] as const) {
    const frame = stripAnsi(
      renderWorkspace(ui, width, height, "", false, false, {
        color: false,
        motion: false,
      }),
    );
    const rows = frame.split("\n");
    assert.equal(rows.length, height, `${width}x${height} rows`);
    assert.ok(
      rows.every((row) => visibleLength(row) <= width),
      `${width}x${height} keeps every row inside the terminal`,
    );
    // Every session is one row, and no row is a tree line with a guide. Only
    // the working set starts open, so the two active conversations are the
    // rows drawn; the 40x12 body has room for one of them under its heading.
    // A heading carries the same chevron vocabulary as a child row, so the
    // count badge at its end is what tells the two apart.
    const sessionRows = rows.filter((row) => {
      // Only the list pane can hold a conversation row; the inspector beside
      // it prints the same glyphs as its field icons.
      const listPane = row.split("│")[0] ?? "";
      return (
        /^\s+(?:› | {2})[●○×◐▸] \S/.test(listPane) &&
        !/\(\d+\)$/u.test(listPane.trimEnd())
      );
    });
    assert.equal(
      sessionRows.length,
      width === 40 ? 1 : 2,
      `${width}x${height} draws one row per conversation: ${sessionRows.join(" | ")}`,
    );
    assert.doesNotMatch(frame, /\| ●/, "no tree guides under a row");
  }

  // 80x24 has no room for two panes, so the list owns the width and Enter
  // swaps in the inspector.
  const narrow = stripAnsi(
    renderWorkspace(ui, 80, 24, "", false, false, { color: false, motion: false }),
  );
  assert.match(narrow, /▾ active \(2\)/);
  assert.match(narrow, /▸ attention \(1\)/);
  assert.match(narrow, /▸ children \(1\)/);
  assert.match(narrow, /▸ archived \(1\)/);
  assert.match(narrow, /● Fix parser · ◐ gpt-5 · ◷ 2m · # 12k · ◆ 1/);
  assert.match(narrow, /↑↓ move · Enter inspect · g group · esc chat/);
  // The old bar spelled out where Esc goes and repeated the filter keys the
  // frame's own legend already prints.
  assert.doesNotMatch(narrow, /select · Enter inspects/);
  assert.doesNotMatch(narrow, /│ status/);

  // 120x40 keeps the inspector beside the list and shows recorded facts only.
  // The cursor is put on the running conversation, because the inspector
  // follows the row the cursor is on and not the last one clicked.
  ui.groupTree!.state = { ...ui.groupTree!.state, cursor: 2 };
  const wide = stripAnsi(
    renderWorkspace(ui, 120, 40, "", false, false, { color: false, motion: false }),
  );
  assert.match(wide, /● Fix parser/);
  assert.match(wide, /│ CONVERSATION/);
  // Every label carries the one-cell icon of its fact, so the names line up in
  // one column; the padding before the colon is the shared label column.
  assert.match(wide, /│ ● status\s*: running/);
  assert.match(wide, /│ ◐ model\s*: gpt-5/);
  assert.match(wide, /│ ◷ elapsed\s*: 2m/);
  assert.match(wide, /│ # tokens\s*: 12000 run tokens/);
  assert.match(wide, /│ ◆ children: 1 spawned/);
  assert.match(wide, /↑↓ move · Enter inspect · g group · esc chat/);

  // Enter on a heading folds it, and the rows under it stop being drawn.
  ui.groupTree!.state = { ...ui.groupTree!.state, cursor: 0 };
  assert.equal(ui.collapseOrExpand(false), true);
  const collapsed = stripAnsi(
    renderWorkspace(ui, 80, 24, "", false, false, { color: false, motion: false }),
  );
  assert.match(collapsed, /▸ active \(2\)/);
  assert.doesNotMatch(collapsed, /● Fix parser/);

  // Below the threshold, Enter on a conversation swaps the list for the
  // inspector, and Escape (which clears the detail pane) gives the list back.
  ui.groupTree!.state = { ...ui.groupTree!.state, cursor: 0 };
  ui.collapseOrExpand(true);
  ui.groupTree!.state = { ...ui.groupTree!.state, cursor: 2 };
  assert.equal(ui.activateTreeCursor(), "group", "the inspector takes the pane");
  assert.ok(ui.sessionInspectorDetail);
  assert.match(ui.detail!.join("\n"), /CONVERSATION/);
  const inspected = stripAnsi(
    renderWorkspace(ui, 80, 24, "", false, false, { color: false, motion: false }),
  );
  assert.doesNotMatch(inspected, /● Fix parser/, "the list gave up the body");
  // The second Enter opens the conversation in Chat; the runner is what
  // navigates on a "row" answer.
  assert.equal(ui.activateTreeCursor(), "row");
  // Escape clears the detail without touching the flag, so the next frame
  // and the next Enter have to fall back to the list.
  ui.detail = undefined;
  ui.sessionInspectorDetail = false;
  const back = stripAnsi(
    renderWorkspace(ui, 80, 24, "", false, false, { color: false, motion: false }),
  );
  assert.match(back, /● Fix parser/);

  // A dedicated group key folds the section under the cursor, and cycling
  // lands on the next heading with it open.
  ui.groupTree!.state = { ...ui.groupTree!.state, cursor: 0 };
  assert.equal(ui.toggleSessionGroup(), true);
  assert.equal(ui.groupTree!.state.expanded.has("section:active"), false);
  assert.equal(ui.cycleSessionGroup(1), true);
  assert.equal(ui.groupTree!.state.cursor, 1, "the next heading is the cursor");
  assert.ok(ui.groupTree!.state.expanded.has("section:attention"));
  // A conversation row is not a section, so the group key does nothing there.
  ui.groupTree!.state = {
    expanded: new Set([
      ...ui.groupTree!.state.expanded,
      "section:active",
    ]),
    cursor: 2,
  };
  assert.equal(ui.toggleSessionGroup(), false);
});

test("the sessions browser has an empty state and a filter state", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "nomo-tui-sessions-empty-"));
  const app = new Workbench({ NOMO_DATA_DIR: root });
  t.after(async () => {
    await app.shutdown();
    await rm(root, { recursive: true, force: true });
  });
  const ui = new WorkspaceTui(app, { NOMO_DATA_DIR: root });
  ui.choose("sessions");
  const empty = stripAnsi(
    renderWorkspace(ui, 80, 24, "", false, false, { color: false, motion: false }),
  );
  assert.match(empty, /SESSIONS · 0 conversations/);
  assert.match(empty, /No sessions yet\. \/new starts one\./);

  t.mock.method(app, "list", () => [sessionFixture({ id: "one", title: "One" })]);
  ui.filter = "zzz";
  const filtered = stripAnsi(
    renderWorkspace(ui, 80, 24, "", false, false, { color: false, motion: false }),
  );
  assert.match(filtered, /SESSIONS · 0 conversations/);
  assert.match(filtered, /No matches for zzz\./);
  assert.match(filtered, /Backspace edits the filter\. Esc clears it\./);
});

test("the palette preview appears only from 100 columns and fits its pane", () => {
  // Below the threshold the list keeps every cell.
  assert.equal(palettePreviewWidth(99, 95), 0);
  const wide = palettePreviewWidth(120, 116);
  assert.ok(wide >= 24 && wide <= 40, `preview pane is ${wide} cells`);
  // A frame whose inner width cannot carry a readable list gets no preview.
  assert.equal(palettePreviewWidth(120, 40), 0);

  const item = {
    id: "/theme",
    label: "/theme",
    hint: "Color and motion for this session",
    icon: "◐",
    group: "settings" as const,
  };
  const lines = palettePreviewLines(item, 40);
  assert.ok(lines.every((line) => visibleLength(line) === 40));
  assert.equal(lines[0], pad("PREVIEW · SETTINGS", 40));
  assert.ok(lines.some((line) => line.trim() === "/theme"));
  assert.ok(lines.some((line) => line.includes("Color and motion")));
  // The usage line is the command's real declared argument shape. It wraps to
  // the pane width, so the assertion reads the pane as one paragraph.
  assert.ok(
    lines
      .map((line) => line.trim())
      .join(" ")
      .includes("usage: /theme color, mono, motion, still or reset"),
  );

  // A command with no declared argument prints no usage line at all.
  const plain = palettePreviewLines(
    {
      id: "/chat",
      label: "/chat",
      hint: "Return to chat",
      icon: "●",
      group: "session",
    },
    40,
  );
  assert.equal(
    plain.some((line) => line.includes("usage:")),
    false,
  );
  assert.ok(plain.every((line) => visibleLength(line) === 40));
});

test("the palette list and preview merge to one exact width", () => {
  const merged = paletteWithPreview(
    [pad("> /theme", 30), pad("  /chat", 30)],
    palettePreviewLines(undefined, 20),
    30,
    20,
  );
  assert.ok(merged.every((line) => visibleLength(line) === 52));
  assert.ok(merged[0]!.startsWith("> /theme"));
  assert.ok(merged[0]!.includes("PREVIEW"));
});

test("the toast stack is suppressed below 60x18 and never exceeds three", () => {
  assert.equal(toastStackVisible(60, 18), true);
  assert.equal(toastStackVisible(59, 18), false);
  assert.equal(toastStackVisible(60, 17), false);

  const at = 1_000;
  const host = {
    toasts: [0, 1, 2, 3].map((index) => ({
      id: `t${index}`,
      tone: "info" as const,
      message: `notice ${index}`,
      icon: "i",
      at,
      ttl: 4_000,
    })),
    active: undefined,
  };
  const rows = toastStackRows(host, {
    width: 116,
    now: at,
    color: false,
    filled: "#",
    empty: "-",
    close: "x",
  });
  assert.equal(rows.length, 3, "three toasts at most");
  assert.ok(rows.every((row) => visibleLength(row) === 116));
  // Right aligned: the row ends at the frame's right edge.
  assert.equal(rows[0]!.endsWith("x"), true);
  assert.equal(rows[0]!.startsWith(" "), true);
  // A fresh toast carries a full life bar, a half spent one carries half.
  assert.match(rows[0]!, /#### i \[INFO\] notice 0/);
  const half = toastStackRows(host, {
    width: 116,
    now: at + 2_000,
    color: false,
    filled: "#",
    empty: "-",
    close: "x",
  });
  assert.match(half[0]!, /##-- i \[INFO\] notice 0/);
  // A sticky toast has no deadline, so its bar stays full.
  const sticky = toastStackRows(
    { toasts: [{ ...host.toasts[0]!, ttl: 0 }], active: undefined },
    {
      width: 116,
      now: at + 60_000,
      color: false,
      filled: "#",
      empty: "-",
      close: "x",
    },
  );
  assert.match(sticky[0]!, /#### i \[INFO\] notice 0/);
  assert.deepEqual(
    toastStackRows({ toasts: [], active: undefined }, {
      width: 116,
      now: at,
      color: false,
      filled: "#",
      empty: "-",
      close: "x",
    }),
    [],
  );
  // A frame too narrow for a message drops the stack instead of a stub.
  assert.equal(toastStackWidth(20), 0);
});

test("the sticky transcript line names the breadcrumb and the phase", () => {
  const line = stickyTranscriptLine({
    title: "Visual snapshot",
    phase: "Writing",
    arrow: "▲",
    width: 60,
  });
  assert.equal(line, "▲ Chat > Visual snapshot · Writing");
  const untitled = stickyTranscriptLine({
    title: "",
    phase: "Idle",
    arrow: "▲",
    width: 60,
  });
  assert.equal(untitled, "▲ Chat · Idle");
  const narrow = stickyTranscriptLine({
    title: "A very long conversation title that cannot fit",
    phase: "Waiting for approval",
    arrow: "▲",
    width: 24,
  });
  assert.equal(visibleLength(narrow), 24);
});

test("a chip span is measured in cells, not code units", () => {
  const span = cellSpan("  ▤ ctx ▰▰▱▱ 62%", "ctx");
  assert.deepEqual(span, { start: 4, end: 6 });
  assert.equal(cellSpan("  ▤ ctx", ""), undefined);
  assert.equal(cellSpan("  ▤ ctx", "model"), undefined);
});

test("a session row publishes its model and token fact spans", () => {
  const icons = sessionRowIcons("unicode");
  const line = sessionRowLine(
    {
      glyph: "○",
      title: "Fix parser",
      model: "gpt-5",
      elapsed: "2m",
      tokens: "12k",
      children: 0,
    },
    70,
    icons,
  );
  const spans = sessionRowFactSpans(line, icons);
  assert.ok(spans.model);
  assert.equal(line.slice(spans.model!.start, spans.model!.end + 1), `${icons.model} gpt-5`);
  assert.ok(spans.tokens);
  assert.equal(line.slice(spans.tokens!.start, spans.tokens!.end + 1), `${icons.tokens} 12k`);
  // A title that happens to look like a fact never claims the fact's span.
  const tricky = sessionRowFactSpans(`  ○ ${icons.model} not a fact`, icons);
  assert.equal(tricky.model, undefined);
  // The inspector painted beside the list is not part of the row.
  const wide = sessionRowFactSpans(
    `${line} │ ${icons.tokens} 999`,
    icons,
  );
  assert.equal(wide.tokens?.end, spans.tokens?.end);
});

test("a palette frame shows a preview pane only where the frame can afford it", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "nomo-tui-palette-preview-"));
  const app = new Workbench({ NOMO_DATA_DIR: root });
  t.after(async () => {
    await app.shutdown();
    await rm(root, { recursive: true, force: true });
  });
  const ui = new WorkspaceTui(app, { NOMO_DATA_DIR: root });
  ui.palette = {
    ...initialPaletteState(paletteFromCommands(TUI_COMMANDS)),
    query: "mcp",
  };
  const wide = stripAnsi(
    renderWorkspace(ui, 120, 40, "", false, false, { color: false, motion: false }),
  );
  assert.match(wide, /PREVIEW ·/);
  assert.match(wide, /usage: \/mcp/);
  const narrow = stripAnsi(
    renderWorkspace(ui, 80, 24, "", false, false, { color: false, motion: false }),
  );
  assert.doesNotMatch(narrow, /PREVIEW ·/);
  for (const [columns, rows] of [[120, 40], [80, 24], [40, 12]] as const) {
    const frame = renderWorkspace(ui, columns, rows, "", false, false, {
      color: false,
      motion: false,
    });
    const lines = frame.split("\n");
    assert.equal(lines.length, rows, `${columns}x${rows} rows`);
    assert.ok(
      lines.every((line) => visibleLength(line) <= columns),
      `${columns}x${rows} overflows`,
    );
  }
});

test("toasts are a right aligned stack above the composer and vanish at 40x12", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "nomo-tui-toast-stack-"));
  const app = new Workbench({ NOMO_DATA_DIR: root });
  t.after(async () => {
    await app.shutdown();
    await rm(root, { recursive: true, force: true });
  });
  const ui = new WorkspaceTui(app, { NOMO_DATA_DIR: root });
  ui.choose("chat");
  const now = Date.parse("2026-01-02T03:04:10.000Z");
  ui.toasts = {
    toasts: [
      { id: "a", tone: "info", message: "Filter set", icon: "i", at: now, ttl: 4_000 },
      { id: "b", tone: "success", message: "Connected", icon: "●", at: now, ttl: 4_000 },
      { id: "c", tone: "info", message: "Pet docked", icon: "i", at: now, ttl: 4_000 },
      { id: "d", tone: "info", message: "Fourth", icon: "i", at: now, ttl: 4_000 },
    ],
    active: undefined,
  };
  const wide = stripAnsi(
    renderWorkspace(ui, 120, 40, "", false, false, {
      color: false,
      motion: false,
      now,
    }),
  );
  const wideRows = wide.split("\n");
  assert.equal(wideRows.length, 40);
  assert.match(wide, /Filter set/);
  assert.match(wide, /Pet docked/);
  assert.doesNotMatch(wide, /Fourth/, "the stack caps at three");
  // The stack sits above the composer rail, never below it.
  const railRow = wideRows.findIndex((row) => row.includes("╭─ Draft"));
  const toastRow = wideRows.findIndex((row) => row.includes("Filter set"));
  assert.ok(toastRow >= 0 && toastRow < railRow, "toast above the composer");
  assert.ok(
    ui.rowHitTargets.some((target) => target.kind === "toast"),
    "toast rows are dismissible",
  );

  const small = stripAnsi(
    renderWorkspace(ui, 40, 12, "", false, false, {
      color: false,
      motion: false,
      now,
    }),
  );
  assert.doesNotMatch(small, /Filter set/);
  assert.match(small, /╭─ Draft/);
  assert.match(small, /← Sessions/);
  const smallRows = small.split("\n");
  assert.equal(smallRows.length, 12);
  assert.ok(smallRows.every((row) => visibleLength(row) <= 40));
});

test("a scrolled transcript carries a sticky breadcrumb without moving the composer", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "nomo-tui-sticky-"));
  const app = new Workbench({ NOMO_DATA_DIR: root });
  t.after(async () => {
    await app.shutdown();
    await rm(root, { recursive: true, force: true });
  });
  const ui = new WorkspaceTui(app, { NOMO_DATA_DIR: root });
  ui.choose("chat");
  ui.model = "fixture-model";
  ui.sessionId = "sess-sticky";
  t.mock.method(app, "get", (id: string) =>
    id === "sess-sticky"
      ? sessionFixture({
          id: "sess-sticky",
          title: "Sticky session",
          events: Array.from({ length: 40 }, (_, index) => ({
            seq: index + 1,
            at: `2026-01-02T03:00:${String(index % 60).padStart(2, "0")}.000Z`,
            kind: "assistant" as const,
            type: "message.completed",
            text: `Line ${index + 1}`,
            payload: {},
            runId: "run-sticky",
            sessionId: "sess-sticky",
          })),
        })
      : undefined,
  );
  const following = stripAnsi(
    renderWorkspace(ui, 100, 30, "", false, false, { color: false, motion: false }),
  );
  assert.doesNotMatch(following, /Chat > Sticky session/);
  ui.scroll = 3;
  const scrolled = stripAnsi(
    renderWorkspace(ui, 100, 30, "", false, false, { color: false, motion: false }),
  );
  assert.match(scrolled, /Chat > Sticky session/);
  const rows = scrolled.split("\n");
  assert.equal(rows.length, 30);
  assert.ok(rows.every((row) => visibleLength(row) <= 100));
  assert.match(scrolled, /╭─ Draft/, "the composer keeps its rows");
});

test("the composer chips publish clickable rects that match their text", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "nomo-tui-chip-targets-"));
  const app = new Workbench({ NOMO_DATA_DIR: root });
  t.after(async () => {
    await app.shutdown();
    await rm(root, { recursive: true, force: true });
  });
  const ui = new WorkspaceTui(app, { NOMO_DATA_DIR: root });
  ui.choose("chat");
  ui.model = "fixture-model";
  const frame = stripAnsi(
    renderWorkspace(ui, 120, 32, "see @plan.md", false, false, {
      color: false,
      motion: false,
    }),
  );
  const rows = frame.split("\n");
  const chips = ui.rowHitTargets.filter(
    (target): target is Extract<(typeof ui.rowHitTargets)[number], { kind: "chip" }> =>
      target.kind === "chip",
  );
  assert.ok(
    chips.some((chip) => chip.action === "model"),
    "the model chip is clickable",
  );
  assert.ok(
    chips.some((chip) => chip.action === "usage"),
    "the context meter is clickable",
  );
  for (const chip of chips) {
    const row = rows[chip.row - 1]!;
    const text = [...row].slice(chip.start - 1, chip.end).join("");
    assert.ok(text.trim() !== "", `${chip.action} rect lands on text`);
  }
});


test("the pet display choice persists per workspace data dir", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "nomo-tui-pet-persist-"));
  const env = { NOMO_DATA_DIR: root };
  const app = new Workbench(env);
  t.after(async () => {
    await app.shutdown();
    await rm(root, { recursive: true, force: true });
  });
  const file = petPreferencePath(env);

  // The default is unchanged: on, in the automatic spot, and nothing is
  // written until the operator actually chooses something.
  const first = new WorkspaceTui(app, env);
  first.choose("chat");
  assert.equal(first.petEnabled, true);
  assert.equal(first.petPlacement, "auto");
  await assert.rejects(readFile(file), "constructing the pet wrote a file");

  // /pet perch is a display choice, so it survives the process.
  await first.command("/pet perch");
  assert.equal(first.petPlacement, "perch");
  const saved = JSON.parse(await readFile(file, "utf8")) as Record<
    string,
    unknown
  >;
  assert.deepEqual(saved, { version: 1, enabled: true, placement: "perch" });
  const second = new WorkspaceTui(app, env);
  assert.equal(second.petEnabled, true);
  assert.equal(second.petPlacement, "perch", "the pose preference was lost");

  // Off is remembered too, and stays off across a restart.
  await second.command("/pet off");
  assert.equal(second.petEnabled, false);
  const third = new WorkspaceTui(app, env);
  assert.equal(third.petEnabled, false, "the off choice was lost");
  assert.equal(third.petPlacement, "off");

  // /pet on clears the saved off state.
  await third.command("/pet on");
  const fourth = new WorkspaceTui(app, env);
  assert.equal(fourth.petEnabled, true);
  assert.equal(fourth.petPlacement, "auto");
  // A display choice never starts a conversation.
  assert.equal(app.list().length, 0);
});

test("an explicit environment value outranks the saved pet choice", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "nomo-tui-pet-env-"));
  const env = { NOMO_DATA_DIR: root };
  const app = new Workbench(env);
  t.after(async () => {
    await app.shutdown();
    await rm(root, { recursive: true, force: true });
  });
  const saved = new WorkspaceTui(app, env);
  await saved.command("/pet perch");

  // NOMO_TUI_PET is the operator's startup override, so it wins over the file
  // in both directions and the constructor never rewrites the saved choice.
  const off = new WorkspaceTui(app, { ...env, NOMO_TUI_PET: "0" });
  assert.equal(off.petEnabled, false);
  assert.equal(off.petPlacement, "off");
  const on = new WorkspaceTui(app, { ...env, NOMO_TUI_PET: "1" });
  assert.equal(on.petEnabled, true);
  const restored = new WorkspaceTui(app, env);
  assert.equal(restored.petPlacement, "perch", "the override rewrote the file");
});

test("a corrupt pet preference leaves the frame on the defaults", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "nomo-tui-pet-corrupt-"));
  const env = { NOMO_DATA_DIR: root };
  const app = new Workbench(env);
  t.after(async () => {
    await app.shutdown();
    await rm(root, { recursive: true, force: true });
  });
  const file = petPreferencePath(env);
  await mkdir(join(root, "tui", "state"), { recursive: true });
  await writeFile(file, "{ this is not the pet");

  const ui = new WorkspaceTui(app, env);
  ui.choose("chat");
  assert.equal(ui.petEnabled, true);
  assert.equal(ui.petPlacement, "auto");
  // The frame still draws, and the next real choice repairs the file.
  const frame = stripAnsi(
    renderWorkspace(ui, 80, 24, "", true, false, {
      color: false,
      motion: false,
    }),
  );
  assert.ok(frame.includes("▦ idle"));
  await ui.command("/pet dock");
  assert.equal(new WorkspaceTui(app, env).petPlacement, "dock");
});

/**
 * Accessibility and non-TTY coverage for the visual surfaces added for the
 * palette preview, the toast stack, the sticky breadcrumb, the mouse hit
 * targets, the per-tool diff tones and the sessions browser icons.
 *
 * The contract these tests hold: every fact a frame prints is a string. A
 * monochrome terminal, an ASCII symbol preset and a frozen motion frame must
 * carry the same words as the truecolour, Unicode, animating frame. Colour,
 * glyph weight and motion are decoration, never the only carrier of meaning.
 *
 * Frames are rendered by the real `renderWorkspace` with a pinned clock, a
 * pinned working directory and `motion: false`, and every variant gets a fresh
 * `WorkspaceTui` because the first frame of a panel also settles its state.
 */
import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Workbench } from "../../../workbench/src/index.ts";
import type { SessionView } from "../../../workbench/src/index.ts";
import {
  PALETTE_PREVIEW_MIN_COLUMNS,
  TUI_COMMANDS,
  WORKSPACE_TABS,
  WorkspaceTui,
  buildSessionBrowser,
  chatRows,
  palettePreviewLines,
  palettePreviewWidth,
  renderWorkspace,
  sessionBrowserHint,
  sessionRowFactSpans,
  sessionRowIcons,
  sessionRowLine,
  stickyTranscriptLine,
  toastStackRows,
  toastStackVisible,
} from "./workspace.ts";
import {
  filterPalette,
  initialPaletteState,
  paletteFromCommands,
} from "./palette.ts";
import { detectCapabilities } from "./caps.ts";
import { motionFrameAt, MOTION_TICK_MS } from "./motion.ts";
import { stripAnsi, visibleLength } from "./layout.ts";
import type { TerminalCapabilities } from "./types.ts";

/** The only instant any frame in this file may read as "now". */
const NOW = Date.parse("2026-01-02T03:04:10.000Z");
/** Root exists on every platform and is never a checkout, so no branch prints. */
const CWD = "/";

type Preset = "unicode" | "ascii";
type Setup = (ui: WorkspaceTui) => void;

function capabilities(
  columns: number,
  rows: number,
  colorDepth: 0 | 24,
): TerminalCapabilities {
  return {
    interactive: true,
    ansi: colorDepth !== 0,
    colorDepth,
    columns,
    rows,
    reason: "interactive",
  };
}

async function fixture(
  t: TestContext,
): Promise<{ app: Workbench; root: string }> {
  const root = await mkdtemp(join(tmpdir(), "nomo-tui-a11y-"));
  const app = new Workbench({ NOMO_DATA_DIR: root });
  t.after(async () => {
    await app.shutdown();
    await rm(root, { recursive: true, force: true });
  });
  return { app, root };
}

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

type FrameOptions = {
  readonly color?: boolean;
  readonly preset?: Preset;
  readonly draft?: string;
  readonly editing?: boolean;
  readonly now?: number;
  readonly capabilities?: TerminalCapabilities;
};

/**
 * One frame from one fresh UI.
 *
 * The preset comes through `NOMO_TUI_SYMBOLS`, which is the same environment
 * path an operator uses, rather than by assigning the resolved config.
 */
function frame(
  app: Workbench,
  root: string,
  setup: Setup,
  columns: number,
  rows: number,
  options: FrameOptions = {},
): string {
  const preset = options.preset ?? "unicode";
  const ui = new WorkspaceTui(app, {
    NOMO_DATA_DIR: root,
    ...(preset === "ascii" ? { NOMO_TUI_SYMBOLS: "ascii" } : {}),
  });
  setup(ui);
  const color = options.color === true;
  return renderWorkspace(
    ui,
    columns,
    rows,
    options.draft ?? "",
    options.editing === true,
    false,
    {
      color,
      motion: false,
      now: options.now ?? NOW,
      cwd: CWD,
      capabilities:
        options.capabilities ?? capabilities(columns, rows, color ? 24 : 0),
    },
  );
}

const plain = (value: string): string => stripAnsi(value);

/** The cells a published rect covers, using the frame's one-based columns. */
function rectText(row: string, target: { start: number; end: number }): string {
  return [...row].slice(target.start - 1, target.end).join("");
}

/**
 * The lowercase word multiset of a frame.
 *
 * One-letter tokens are dropped because a symbol preset changes its icons and
 * tab tags to single letters, which is a glyph difference and not a field. Any
 * longer word that disappears is a fact the frame stopped printing.
 */
function words(value: string): string[] {
  const words: string[] =
    plain(value)
      .toLowerCase()
      .match(/[a-z0-9][a-z0-9_./-]*/gu) ?? [];
  return words.filter((word) => word.length >= 2).sort();
}

const paletteSetup: Setup = (ui) => {
  ui.palette = {
    ...initialPaletteState(paletteFromCommands(TUI_COMMANDS)),
    query: "theme",
  };
};

const toastHost = () => ({
  toasts: [
    {
      id: "info",
      tone: "info" as const,
      message: "Filter set",
      icon: "i",
      at: NOW,
      ttl: 4_000,
    },
    {
      id: "danger",
      tone: "danger" as const,
      message: "Approval expired",
      icon: "!",
      at: NOW,
      ttl: 0,
    },
  ],
  active: undefined,
});

const chatToastSetup: Setup = (ui) => {
  ui.choose("chat");
  ui.model = "fixture-model";
  ui.toasts = toastHost();
};

test("the palette preview states the command, its description and its keys in text", async (t) => {
  const { app, root } = await fixture(t);
  const wide = plain(frame(app, root, paletteSetup, 120, 40));
  assert.equal(
    wide.includes("\x1b["),
    false,
    "a mono frame carries no escapes",
  );
  assert.match(wide, /PREVIEW · SETTINGS/);
  assert.match(wide, /\/theme/);
  assert.match(wide, /Color and motion for this session/);
  assert.match(wide, /usage: \/theme/);
  assert.match(wide, /Enter runs it/);
  assert.match(wide, /Esc closes/);

  // Every line the pane produces is readable as plain text in the frame, so a
  // reader who cannot see the pane's tint still gets the whole preview.
  const items = filterPalette(paletteFromCommands(TUI_COMMANDS), "theme");
  const selected = items.find((item) => item.id === "/theme");
  assert.ok(selected, "the fixture query selects /theme");
  const pane = palettePreviewLines(selected, palettePreviewWidth(120, 116));
  assert.ok(pane.length > 0);
  for (const line of pane) {
    const text = line.trimEnd();
    if (text === "") continue;
    assert.ok(
      wide.includes(text),
      `preview line ${JSON.stringify(text)} is missing from the frame`,
    );
  }

  // The threshold is the terminal, and it is inclusive: 100 columns has the
  // pane, 99 does not. Without the pane the command the operator came for is
  // still named and still runs from the same key.
  assert.equal(PALETTE_PREVIEW_MIN_COLUMNS, 100);
  assert.match(plain(frame(app, root, paletteSetup, 100, 30)), /PREVIEW ·/);
  const narrow = plain(frame(app, root, paletteSetup, 99, 30));
  assert.doesNotMatch(narrow, /PREVIEW ·/);
  assert.match(narrow, /\/theme/);
  assert.match(narrow, /Enter run/);
  assert.match(narrow, /Esc close/);
});

test("the toast stack prints its tone, message and close affordance in every preset", () => {
  const unicode = toastStackRows(toastHost(), {
    width: 116,
    now: NOW,
    color: false,
    filled: "█",
    empty: "░",
    close: "×",
  });
  const ascii = toastStackRows(toastHost(), {
    width: 116,
    now: NOW,
    color: false,
    filled: "#",
    empty: "-",
    close: "x",
  });
  assert.equal(unicode.length, 2);
  assert.equal(ascii.length, 2);
  for (const [rows, close, full] of [
    [unicode, "×", "████"],
    [ascii, "x", "####"],
  ] as const) {
    assert.ok(
      rows.every((row) => visibleLength(row) === 116),
      "each toast row is exactly the frame width",
    );
    // The tone is a word in brackets, not a colour: a monochrome terminal
    // still tells a danger from an info notice.
    assert.match(rows[0]!, /i \[INFO\] Filter set/);
    assert.match(rows[1]!, /! \[DANGER\] Approval expired/);
    // The dismiss affordance is the last printable cell and one cell wide.
    assert.equal(visibleLength(close), 1);
    for (const row of rows) assert.equal(row.trimEnd().at(-1), close);
    // A sticky toast has no deadline, so its life bar stays full.
    assert.match(rows[1]!, new RegExp(`${full} ! \\[DANGER\\]`));
  }
  // A half spent toast states its remaining life in cells, not in colour.
  const half = toastStackRows(toastHost(), {
    width: 116,
    now: NOW + 2_000,
    color: false,
    filled: "#",
    empty: "-",
    close: "x",
  });
  assert.match(half[0]!, /##-- i \[INFO\]/);
});

test("the toast stack sits above the composer as text and is suppressed at 40x12", async (t) => {
  const { app, root } = await fixture(t);
  assert.equal(toastStackVisible(60, 18), true);
  assert.equal(toastStackVisible(59, 18), false);
  assert.equal(toastStackVisible(60, 17), false);

  const wide = plain(frame(app, root, chatToastSetup, 120, 40));
  assert.match(wide, /i \[INFO\] Filter set/);
  assert.match(wide, /! \[DANGER\] Approval expired/);
  const rows = wide.split("\n");
  const toastRow = rows.findIndex((row) => row.includes("Filter set"));
  const railRow = rows.findIndex((row) => row.includes("Draft"));
  assert.ok(toastRow >= 0 && railRow > toastRow, "the stack is above the rail");

  // The stack is a row budget, so at 40x12 it yields every row to the
  // composer instead of pushing the draft off the frame.
  const small = plain(frame(app, root, chatToastSetup, 40, 12));
  assert.doesNotMatch(small, /Filter set/);
  assert.doesNotMatch(small, /Approval expired/);
  assert.match(small, /Draft/);
  assert.equal(small.split("\n").length, 12);
});

test("the sticky breadcrumb names the conversation and the phase in text", async (t) => {
  const { app, root } = await fixture(t);
  const line = stickyTranscriptLine({
    title: "Visual snapshot",
    phase: "Writing",
    arrow: "^",
    width: 60,
  });
  assert.equal(line, "^ Chat > Visual snapshot · Writing");
  const unicode = stickyTranscriptLine({
    title: "Visual snapshot",
    phase: "Writing",
    arrow: "▲",
    width: 60,
  });
  assert.equal(unicode.replace("▲", "^"), line);
  assert.equal(visibleLength("▲"), 1);
  // An untitled conversation says so instead of printing an empty arrow.
  assert.equal(
    stickyTranscriptLine({ title: "", phase: "Idle", arrow: "^", width: 60 }),
    "^ Chat · Idle",
  );

  const session = sessionFixture({
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
  });
  t.mock.method(app, "get", (id: string) =>
    id === session.id ? session : undefined,
  );
  const setup: Setup = (ui) => {
    ui.choose("chat");
    ui.model = "fixture-model";
    ui.sessionId = session.id;
    ui.scroll = 3;
  };
  const following = plain(
    frame(
      app,
      root,
      (ui) => {
        ui.choose("chat");
        ui.model = "fixture-model";
        ui.sessionId = session.id;
      },
      100,
      30,
    ),
  );
  assert.doesNotMatch(following, /Chat > Sticky session/);
  const scrolled = plain(frame(app, root, setup, 100, 30));
  assert.match(scrolled, /Chat > Sticky session/);
  assert.match(scrolled, /· Idle/);
  assert.match(scrolled, /Draft/, "the composer keeps its rows");
  assert.equal(scrolled.split("\n").length, 30);
});

test("the composer chip rects land on the labels they claim", async (t) => {
  const { app, root } = await fixture(t);
  const setup: Setup = (ui) => {
    ui.choose("chat");
    ui.model = "fixture-model";
    ui.toasts = toastHost();
  };
  const rendered = frame(app, root, setup, 120, 32, {
    draft: "see @plan.md",
    editing: true,
  });
  // The frame helper builds its own UI, so the rects are read from a second
  // render of the same inputs and the same fresh-UI contract.
  const ui = new WorkspaceTui(app, { NOMO_DATA_DIR: root });
  setup(ui);
  const frameText = renderWorkspace(ui, 120, 32, "see @plan.md", true, false, {
    color: false,
    motion: false,
    now: NOW,
    cwd: CWD,
    capabilities: capabilities(120, 32, 0),
  });
  assert.equal(frameText, rendered, "the same inputs render the same frame");
  const rows = plain(frameText).split("\n");
  const chips = ui.rowHitTargets.filter(
    (
      target,
    ): target is Extract<(typeof ui.rowHitTargets)[number], { kind: "chip" }> =>
      target.kind === "chip",
  );
  const actions = new Set(chips.map((chip) => chip.action));
  for (const action of ["model", "usage", "pet"] as const)
    assert.ok(actions.has(action), `the ${action} chip is clickable`);
  const model = chips.find((chip) => chip.action === "model");
  assert.ok(model);
  assert.equal(rectText(rows[model.row - 1]!, model), "fixture-model");
  for (const chip of chips) {
    const text = rectText(rows[chip.row - 1]!, chip);
    assert.ok(text.trim() !== "", `${chip.action} rect lands on blank space`);
    assert.ok(
      !text.includes("\x1b"),
      `${chip.action} rect contains an escape sequence`,
    );
    assert.ok(
      chip.start >= 1 && chip.end <= 120,
      `${chip.action} rect leaves the frame`,
    );
  }
  // A click anywhere on a toast row dismisses it, so the rect covers the
  // message and the close cell the operator can see.
  const toasts = ui.rowHitTargets.filter(
    (
      target,
    ): target is Extract<
      (typeof ui.rowHitTargets)[number],
      { kind: "toast" }
    > => target.kind === "toast",
  );
  assert.equal(toasts.length, 2);
  const first = rectText(rows[toasts[0]!.row - 1]!, toasts[0]!);
  assert.match(first, /\[INFO\] Filter set/);
  assert.equal(first.trimEnd().at(-1), "×");
});

test("the sessions browser fact rects land on the facts they claim", async (t) => {
  const { app, root } = await fixture(t);
  const session = sessionFixture({
    id: "sess-facts",
    title: "Fix parser",
    runTokenCount: 12_000,
  });
  t.mock.method(app, "list", () => [session]);
  const entry = buildSessionBrowser([session]).entries.get(session.id);
  assert.ok(entry);
  const mismatches: string[] = [];
  for (const preset of ["unicode", "ascii"] as const) {
    const ui = new WorkspaceTui(app, {
      NOMO_DATA_DIR: root,
      ...(preset === "ascii" ? { NOMO_TUI_SYMBOLS: "ascii" } : {}),
    });
    ui.choose("sessions");
    const text = renderWorkspace(ui, 120, 40, "", false, false, {
      color: false,
      motion: false,
      now: NOW,
      cwd: CWD,
      capabilities: capabilities(120, 40, 0),
    });
    const rows = plain(text).split("\n");
    const icons = sessionRowIcons(preset);
    const divider = preset === "ascii" ? "|" : "│";
    const chips = ui.rowHitTargets.filter(
      (
        target,
      ): target is Extract<
        (typeof ui.rowHitTargets)[number],
        { kind: "chip" }
      > => target.kind === "chip",
    );
    assert.ok(chips.length > 0, `${preset} publishes fact rects`);
    for (const chip of chips) {
      const row = rows[chip.row - 1] ?? "";
      const seen = rectText(row, chip);
      const expected =
        chip.action === "models-panel"
          ? `${icons.model} ${entry.model}`
          : `${icons.tokens} ${entry.tokens}`;
      if (seen !== expected)
        mismatches.push(
          `${preset} ${chip.action} rect ${chip.start}-${chip.end} reads ${JSON.stringify(seen)}, expected ${JSON.stringify(expected)}`,
        );
      // The inspector is painted beside the list on the same row. A fact rect
      // must stop before its divider or a click on the row opens the wrong
      // panel.
      const dividerAt = row.indexOf(divider);
      if (dividerAt >= 0 && chip.end > dividerAt)
        mismatches.push(
          `${preset} ${chip.action} rect ends at ${chip.end}, past the divider at ${dividerAt + 1}`,
        );
    }
  }
  assert.deepEqual(mismatches, []);
});

test("the sessions browser keeps every row field and its keys in text", () => {
  const session = sessionFixture({
    id: "sess-row",
    title: "Fix parser",
    model: "openai/gpt-5",
    runTokenCount: 12_000,
  });
  const entry = buildSessionBrowser([session]).entries.get(session.id);
  assert.ok(entry);
  const unicodeIcons = sessionRowIcons("unicode");
  const asciiIcons = sessionRowIcons("ascii");
  const unicode = sessionRowLine(entry, 70, unicodeIcons);
  const ascii = sessionRowLine(entry, 70, asciiIcons);
  for (const line of [unicode, ascii]) {
    assert.match(line, /Fix parser/, "the title names the row");
    assert.match(line, /gpt-5/, "the model is a word");
    assert.match(line, /2m/, "the elapsed span is a word");
    assert.match(line, /12k/, "the token count is a word");
  }
  // The icons are one cell in both presets, so neither layout shifts a fact.
  for (const icon of Object.values(unicodeIcons))
    assert.equal(visibleLength(icon), 1, `${JSON.stringify(icon)} is one cell`);
  for (const icon of Object.values(asciiIcons))
    assert.equal(visibleLength(icon), 1, `${JSON.stringify(icon)} is one cell`);
  assert.equal(asciiIcons.model, "m");
  assert.equal(asciiIcons.time, "t");
  // The facts are found in the row by their icons in both presets.
  for (const [line, icons] of [
    [unicode, unicodeIcons],
    [ascii, asciiIcons],
  ] as const) {
    const spans = sessionRowFactSpans(line, icons);
    assert.ok(spans.model && spans.tokens);
    assert.equal(
      line.slice(spans.model.start, spans.model.end + 1),
      `${icons.model} gpt-5`,
    );
    assert.equal(
      line.slice(spans.tokens.start, spans.tokens.end + 1),
      `${icons.tokens} 12k`,
    );
  }
  // The key bar is text at every width and never claims more cells than it has.
  for (const width of [80, 40, 30, 20, 12, 10]) {
    const hint = sessionBrowserHint(width);
    assert.ok(visibleLength(hint) <= width, `hint fits ${width}`);
    assert.match(
      hint,
      /move|select|inspect|⏎|↑/,
      `hint at ${width} names a key`,
    );
  }
});

test("diff add and remove markers survive without colour", async (t) => {
  const at = (second: number) =>
    `2026-01-01T10:02:${String(second).padStart(2, "0")}.000Z`;
  type ToolEvent = Parameters<typeof chatRows>[0][number];
  const started = (
    seq: number,
    tool: string,
    callId: string,
    args: Record<string, unknown>,
  ): ToolEvent => ({
    seq,
    at: at(seq),
    kind: "tool",
    type: "tool.started",
    text: `Requested ${tool}.`,
    payload: { tool, callId, arguments: args },
  });
  const result = (seq: number, tool: string, callId: string): ToolEvent => ({
    seq,
    at: at(seq),
    kind: "tool",
    type: "tool.result",
    text: `${tool}: result received`,
    payload: {
      tool,
      callId,
      result: {
        isError: false,
        content: [{ type: "text" as const, text: "edited" }],
      },
    },
  });
  const editEvents = [
    started(1, "edit", "edit-1", {
      path: "src/plan.md",
      old_str: "old line",
      new_str: "new line",
    }),
    result(2, "edit", "edit-1"),
  ];
  const writeEvents = [
    started(1, "write", "write-1", {
      path: "src/notes.md",
      content: "alpha\nbeta\ngamma",
    }),
    result(2, "write", "write-1"),
  ];
  for (const events of [editEvents, writeEvents]) {
    const rows = chatRows(events, 100, "details", "comfortable", false, false);
    for (const row of rows) {
      const added = /^ {2}\+ /.test(row.text);
      const removed = /^ {2}- /.test(row.text);
      // The sign in the two-space gutter is the meaning; the tone only repeats
      // it where colour exists. A styled row without its sign would be a row
      // a monochrome terminal could not read.
      assert.equal(
        row.style === "diff-add",
        added,
        `${JSON.stringify(row.text)} and style ${row.style} disagree on an addition`,
      );
      assert.equal(
        row.style === "diff-remove",
        removed,
        `${JSON.stringify(row.text)} and style ${row.style} disagree on a removal`,
      );
      if (row.style === "diff-context")
        assert.ok(
          !added && !removed,
          `${JSON.stringify(row.text)} is context and must not carry a change sign`,
        );
    }
  }

  // The rendered card keeps the same text with colour on and off.
  const { app, root } = await fixture(t);
  const session = sessionFixture({ id: "sess-diff", events: editEvents });
  t.mock.method(app, "get", (id: string) =>
    id === session.id ? session : undefined,
  );
  const setup: Setup = (ui) => {
    ui.choose("chat");
    ui.model = "fixture-model";
    ui.sessionId = session.id;
  };
  const mono = plain(frame(app, root, setup, 80, 24));
  assert.match(mono, /- old line/);
  assert.match(mono, /\+ new line/);
  assert.match(mono, /\+1 -1 lines/);
  const colored = frame(app, root, setup, 80, 24, { color: true });
  assert.ok(colored.includes("\x1b["), "the coloured frame is painted");
  assert.equal(plain(colored), mono);
});

test("NO_COLOR and truecolour frames carry the same text on every new surface", async (t) => {
  const { app, root } = await fixture(t);
  const session = sessionFixture({
    id: "sess-parity",
    title: "Parity session",
    events: Array.from({ length: 30 }, (_, index) => ({
      seq: index + 1,
      at: `2026-01-02T03:00:${String(index % 60).padStart(2, "0")}.000Z`,
      kind: "assistant" as const,
      type: "message.completed",
      text: `Line ${index + 1}`,
      payload: {},
      runId: "run-parity",
      sessionId: "sess-parity",
    })),
  });
  t.mock.method(app, "get", (id: string) =>
    id === session.id ? session : undefined,
  );
  t.mock.method(app, "list", () => [session]);
  const surfaces: readonly (readonly [string, Setup])[] = [
    ["palette", paletteSetup],
    ["chat-toast", chatToastSetup],
    [
      "chat-scrolled",
      (ui) => {
        ui.choose("chat");
        ui.model = "fixture-model";
        ui.sessionId = session.id;
        ui.scroll = 4;
      },
    ],
    ["sessions", (ui) => ui.choose("sessions")],
    [
      "approvals",
      (ui) => {
        ui.choose("approvals");
        ui.proxy.holds = [
          {
            holdId: "parityhold01",
            call: {
              tool: "aws.s3.object.delete",
              connector: "s3",
              workspace: undefined,
              klass: "r2",
              blastRadius: 1,
            },
            expiresAt: NOW + 60_000,
            status: "pending",
            notify: ["cli"],
          },
        ] as unknown as typeof ui.proxy.holds;
      },
    ],
  ];
  for (const [columns, rows] of [
    [40, 12],
    [80, 24],
    [120, 40],
    [160, 45],
  ] as const) {
    // NO_COLOR is read through the same capability detector the runner uses,
    // so this covers the environment flag and not only an explicit option.
    const noColor = detectCapabilities(
      { NO_COLOR: "1" },
      { isTTY: true, columns, rows },
    );
    assert.equal(noColor.reason, "no-color");
    assert.equal(noColor.ansi, false);
    // A piped frame is not a degraded frame: it carries the same text as the
    // NO_COLOR one, so a capture or a screen reader gets every field.
    const notTty = detectCapabilities({}, { isTTY: false, columns, rows });
    assert.equal(notTty.reason, "not-tty");
    assert.equal(notTty.ansi, false);
    const trueColor = detectCapabilities(
      {},
      { isTTY: true, columns, rows, getColorDepth: () => 24 },
    );
    assert.equal(trueColor.colorDepth, 24);
    for (const [name, setup] of surfaces) {
      const mono = frame(app, root, setup, columns, rows, {
        capabilities: noColor,
      });
      const colored = frame(app, root, setup, columns, rows, {
        color: true,
        capabilities: trueColor,
      });
      assert.equal(
        plain(colored),
        mono,
        `${name} at ${columns}x${rows} changes text when colour is on`,
      );
      assert.equal(
        mono.includes("\x1b["),
        false,
        `${name} mono has no escapes`,
      );
      assert.equal(
        frame(app, root, setup, columns, rows, { capabilities: notTty }),
        mono,
        `${name} at ${columns}x${rows} changes text when piped`,
      );
      const lines = mono.split("\n");
      assert.equal(lines.length, rows, `${name} at ${columns}x${rows} rows`);
      assert.ok(
        lines.every((line) => visibleLength(line) <= columns),
        `${name} at ${columns}x${rows} overflows`,
      );
    }
  }
});

test("the ASCII preset loses no word on any new surface", async (t) => {
  const { app, root } = await fixture(t);
  const session = sessionFixture({
    id: "sess-ascii",
    title: "Ascii session",
    runTokenCount: 12_000,
  });
  t.mock.method(app, "list", () => [session]);
  const surfaces: readonly (readonly [string, Setup])[] = [
    ["palette", paletteSetup],
    ["chat-toast", chatToastSetup],
    ["sessions", (ui) => ui.choose("sessions")],
    [
      "approvals",
      (ui) => {
        ui.choose("approvals");
        ui.proxy.holds = [
          {
            holdId: "asciihold01",
            call: {
              tool: "aws.s3.object.delete",
              connector: "s3",
              workspace: undefined,
              klass: "r2",
              blastRadius: 1,
            },
            expiresAt: NOW + 60_000,
            status: "pending",
            notify: ["cli"],
          },
        ] as unknown as typeof ui.proxy.holds;
      },
    ],
  ];
  for (const [name, setup] of surfaces) {
    const unicode = words(frame(app, root, setup, 120, 40));
    const ascii = words(frame(app, root, setup, 120, 40, { preset: "ascii" }));
    assert.deepEqual(
      ascii,
      unicode,
      `${name} loses or gains a word in the ASCII preset`,
    );
  }
});


test("T2-T5 panel facts survive monochrome, ASCII and frozen motion", async (t) => {
  const { app, root } = await fixture(t);
  const facts: Record<string, readonly RegExp[]> = {
    chat: [/Draft/],
    sessions: [/SESSIONS · 0 conversations/, /Esc returns to Chat/],
    runs: [/RUNS · 0 recorded/, /No runs in this conversation/, /Esc returns to Chat/],
    documents: [/DOCUMENT TREE · 0 files/, /Esc returns to Chat/],
    ledger: [/VERIFICATION · 1 · chain check/, /Esc returns to Chat/],
    approvals: [/No approvals waiting\./, /Esc returns to Chat/],
    policy: [/POLICY, 1 connectors: 1 confirmed/, /Esc returns to Chat/],
    tools: [/r0 -- 5 tools/, /Esc returns to Chat/],
    mcp: [/connected · NOMO documents/, /Esc returns to Chat/],
    status: [/UNMEASURED · identity/, /Esc returns to Chat/],
    models: [/MODELS · 0 configured providers/, /Esc returns to Chat/],
    usage: [/No usage records yet\./, /tokens unmeasured/, /cost unmeasured/, /Esc returns to Chat/],
    help: [/QUICK KEYS/, /Esc returns to Chat/],
  };
  for (const tab of WORKSPACE_TABS) {
    const setup: Setup = (ui) => ui.choose(tab);
    const mono = frame(app, root, setup, 120, 40);
    const colored = frame(app, root, setup, 120, 40, { color: true });
    const ascii = frame(app, root, setup, 120, 40, { preset: "ascii" });
    assert.equal(
      plain(colored),
      mono,
      `${tab} changes a fact when colour is the only difference`,
    );
    assert.deepEqual(
      words(ascii),
      words(mono),
      `${tab} loses or gains a word in the ASCII preset`,
    );
    for (const fact of facts[tab] ?? []) {
      assert.match(mono, fact, `${tab} monochrome lost ${fact}`);
      assert.match(ascii, fact, `${tab} ASCII lost ${fact}`);
    }
  }
});

test("the motion budget advances one frame per 100 ms", () => {
  assert.equal(MOTION_TICK_MS, 100);
  assert.equal(motionFrameAt(0), 0);
  assert.equal(motionFrameAt(99), 0);
  assert.equal(motionFrameAt(100), 1);
  assert.equal(motionFrameAt(199), 1);
  assert.equal(motionFrameAt(200), 2);
});

test("reduced motion freezes the frame and keeps the text readable", async (t) => {
  const { app, root } = await fixture(t);
  const setup: Setup = (ui) => {
    ui.choose("chat");
    ui.model = "fixture-model";
  };
  // `frame` always pins motion off; the frame counter must then make no
  // difference at all, which is what "reduced motion holds frame 0" means.
  const renderFrozen = (index: number) => {
    const ui = new WorkspaceTui(app, { NOMO_DATA_DIR: root });
    setup(ui);
    return renderWorkspace(ui, 80, 24, "hello", true, false, {
      color: false,
      motion: false,
      frame: index,
      now: NOW,
      cwd: CWD,
      capabilities: capabilities(80, 24, 0),
    });
  };
  const zero = renderFrozen(0);
  assert.equal(renderFrozen(17), zero, "a frozen frame ignores the counter");
  assert.equal(renderFrozen(37), zero, "a frozen frame ignores the counter");
  const text = plain(zero);
  assert.match(text, /Draft/, "the composer rail is still named");
  assert.match(text, /Enter send/, "the composer keys are still printed");
  assert.match(text, /hello/, "the draft is still visible");

  // The same frame with motion enabled does animate, and the animation only
  // changes a glyph: the words are the same as the frozen frame.
  const animate = (index: number) => {
    const ui = new WorkspaceTui(app, { NOMO_DATA_DIR: root });
    setup(ui);
    return renderWorkspace(ui, 80, 24, "hello", true, false, {
      color: false,
      motion: true,
      frame: index,
      now: NOW,
      cwd: CWD,
      capabilities: capabilities(80, 24, 0),
    });
  };
  const frame3 = animate(3);
  const frame4 = animate(4);
  assert.notEqual(frame3, frame4, "the caret still animates with motion on");
  assert.deepEqual(
    words(frame3),
    words(zero),
    "motion changes no word of the frame",
  );
  assert.deepEqual(words(frame4), words(zero));
});

test("40x12 keeps the composer and the approval keys while toasts are suppressed", async (t) => {
  const { app, root } = await fixture(t);
  const hold = () =>
    [
      {
        holdId: "smallhold01",
        call: {
          tool: "aws.s3.object.delete",
          connector: "s3",
          workspace: undefined,
          klass: "r2",
          blastRadius: 1,
        },
        expiresAt: NOW + 60_000,
        status: "pending",
        notify: ["cli"],
      },
    ] as unknown as WorkspaceTui["proxy"]["holds"];
  const chat: Setup = (ui) => {
    ui.choose("chat");
    ui.model = "fixture-model";
    ui.toasts = toastHost();
    ui.proxy.holds = hold();
  };
  const small = plain(frame(app, root, chat, 40, 12, { editing: true }));
  assert.equal(small.split("\n").length, 12);
  assert.ok(
    small.split("\n").every((row) => visibleLength(row) <= 40),
    "the frame fits 40 columns",
  );
  assert.match(small, /Draft/, "the composer keeps its rail");
  assert.match(small, /Enter send/, "the send key stays visible");
  // The sticky banner is a different surface and is never suppressed: it names
  // the hold even where the toast stack gives up its rows.
  // At 40 columns the banner's own variant ladder drops the tool id before it
  // drops the decision pointer, so the hold is named by its class and the
  // route to the decision screen rather than by the tool.
  assert.match(small, /APPROVAL PENDING/);
  assert.match(small, /\[R2\]/);
  assert.match(small, /\/approvals/);
  assert.doesNotMatch(small, /Filter set/);
  assert.doesNotMatch(small, /Approval expired/);

  // On the panel that owns the decision the two keys stay on the frame.
  const approvals = plain(
    frame(
      app,
      root,
      (ui) => {
        ui.choose("approvals");
        ui.proxy.holds = hold();
      },
      40,
      12,
    ),
  );
  assert.match(approvals, /\[a\] approve/);
  assert.match(approvals, /\[d\] deny/);

  // The compact review rail is the confirmation's own carrier of the keys.
  const review = plain(
    frame(
      app,
      root,
      (ui) => {
        ui.choose("chat");
        ui.confirmation = {
          title: "SAVE plan.md?",
          lines: ["REVIEW PREVIEW: local-fixture-change"],
          apply: async () => {},
        };
      },
      40,
      12,
      { editing: true },
    ),
  );
  assert.match(review, /y allow/);
  assert.match(review, /n deny/);
  assert.match(review, /Esc cancel/);
});

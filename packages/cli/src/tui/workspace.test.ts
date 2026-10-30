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
  renderWelcome,
  renderWorkspace,
  transcript,
  wrap,
  TUI_COMMANDS,
  WORKSPACE_TABS,
} from "./workspace.ts";
import { renderInspector } from "./inspector.ts";
import {
  WorkspaceInput,
  WorkspaceVimMode,
  workspaceShortcut,
} from "./workspace-runner.ts";
import {
  DEFAULT_WORKSPACE_KEYBINDINGS,
  parseWorkspaceKeybindings,
} from "./workspace-keybindings.ts";
import {
  filterPalette,
  paletteFromCommands,
  renderPalette,
  type PaletteState,
} from "./palette.ts";
import {
  renderHunkSelection,
  splitDiffHunks,
  visibleLength,
  stripAnsi,
  unifiedDiff,
} from "./layout.ts";

test("welcome screen keeps context and command hints bounded at terminal widths", () => {
  const model = "model-" + "界".repeat(24);
  const project = "project-" + "x".repeat(48);
  const render = (width: number) =>
    renderWelcome(model, project, "agent-reviewer", width);

  for (const width of [20, 40, 80, 120, 160]) {
    const lines = render(width);
    assert.ok(
      lines.every((line) => visibleLength(line) <= width),
      `welcome row exceeds ${width} columns`,
    );
    assert.ok(lines.every((line) => !line.includes("\x1b[")));
  }

  const text = render(120).join("");
  assert.ok(text.includes(model));
  assert.ok(text.includes(project));
  assert.ok(text.includes("agent-reviewer"));
  assert.match(text, new RegExp("commands \\(" + TUI_COMMANDS.length + "\\)"));
  assert.match(text, /Ctrl\+P/);
  assert.match(text, /\/connect/);

  const hostile = renderWelcome("\x1b[2J", "project\nforged", "agent", 80);
  assert.ok(hostile.every((line) => !line.includes("\x1b")));
  assert.ok(hostile.every((line) => !line.includes("\n")));
  assert.ok(hostile.join("\n").includes("Model: ?[2J"));
});

test("keybindings render their icon indent and complete keys", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "nomo-tui-keybindings-"));
  const app = new Workbench({ NOMO_DATA_DIR: root });
  t.after(async () => {
    await app.shutdown();
    await rm(root, { recursive: true, force: true });
  });
  const ui = new WorkspaceTui(app, {
    NOMO_DATA_DIR: root,
    NOMO_TUI_KEYBINDINGS: '{"redraw":"Ctrl+V"}',
  });
  await ui.initialize();
  await ui.command("/keybindings");

  const frame = renderWorkspace(ui, 80, 24, "", false, false, {
    color: false,
    motion: false,
  });
  assert.match(frame, /^    > SENDING *$/m);
  assert.match(frame, /^    Enter  Send the prompt *$/m);
  assert.ok(
    frame.includes(
      "Alt+B / Alt+F or Ctrl+Left / Ctrl+Right  Jump by word",
    ),
  );
  assert.match(ui.detail?.join("\n") ?? "", /Ctrl\+V.*Redraw/);
  assert.ok(frame.split("\n").every((line) => visibleLength(line) <= 80));
  assert.ok(frame.split("\n").every((line) => !line.includes("\x1b[")));
});

test("inline command suggestions use a full-width neutral selection wash", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "nomo-tui-suggestions-"));
  const app = new Workbench({ NOMO_DATA_DIR: root });
  t.after(async () => {
    await app.shutdown();
    await rm(root, { recursive: true, force: true });
  });
  const ui = new WorkspaceTui(app, { NOMO_DATA_DIR: root });
  ui.choose("chat");

  for (const [width, height] of [[80, 24], [120, 40], [200, 48]]) {
    const render = (visuals: { color: boolean; colorDepth?: 4 | 8 }) =>
      renderWorkspace(ui, width, height, "/set▌", true, false, {
        ...visuals,
        command: "/set",
        suggestion: 0,
        motion: false,
      });
    const colorFrame = render({ color: true, colorDepth: 8 });
    const selected = colorFrame
      .split("\n")
      .find((line) => stripAnsi(line).includes("› /settings"));
    assert.ok(selected, `${width}: selected suggestion remains visible`);
    assert.equal(visibleLength(selected!), width);
    assert.ok(selected!.includes("\x1b[1;38;5;117;48;5;237m"));

    const basicColorFrame = render({ color: true, colorDepth: 4 });
    const basicSelected = basicColorFrame
      .split("\n")
      .find((line) => stripAnsi(line).includes("› /settings"));
    assert.ok(basicSelected, `${width}: basic-color suggestion remains visible`);
    assert.equal(visibleLength(basicSelected!), width);
    assert.ok(basicSelected!.includes("\x1b[1;96;100m"));

    const monochromeFrame = render({ color: false });
    assert.doesNotMatch(monochromeFrame, /\x1b\[/);
  }
});
test("short confirmation preserves operation identity without the inactive composer", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "nomo-tui-short-confirmation-"));
  const app = new Workbench({ NOMO_DATA_DIR: root });
  t.after(async () => {
    await app.shutdown();
    await rm(root, { recursive: true, force: true });
  });
  const ui = new WorkspaceTui(app, { NOMO_DATA_DIR: root });
  const operationId = "12345678-1234-1234-1234-123456789abc";
  ui.confirmation = {
    title: "UNDO visual-review.md?",
    lines: [`Operation: ${operationId}`, "Drift check passed."],
    apply: async () => {},
  };
  const frame = stripAnsi(
    renderWorkspace(ui, 40, 12, "", false, false, {
      color: false,
      motion: false,
    }),
  );
  assert.ok(frame.includes(operationId));
  assert.match(frame, /Drift check passed/);
  assert.match(frame, /y accept \/ n reject \/ Esc cancel/);
  assert.match(frame, /PgDn: preview/);
  assert.match(frame, /mode: normal \(local\)/);
  assert.match(frame, /server normal/);
  assert.ok(
    !frame.split("\n").some((line) => /^ >\s*$/.test(line)),
    "confirmation keeps the inactive composer off screen",
  );
  assert.ok(frame.split("\n").every((line) => visibleLength(line) <= 40));
});
test("short detail compacts idle composer spacing while keeping the prompt visible", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "nomo-tui-short-detail-"));
  const app = new Workbench({ NOMO_DATA_DIR: root });
  t.after(async () => {
    await app.shutdown();
    await rm(root, { recursive: true, force: true });
  });
  const ui = new WorkspaceTui(app, { NOMO_DATA_DIR: root });
  ui.choose("documents");
  ui.detail = [
    "DOCUMENT",
    "path: visual-review.md",
    "revision: fixture-revision",
    "Document body begins here.",
    "Document body remains visible.",
  ];
  const frame = stripAnsi(
    renderWorkspace(ui, 40, 12, "", false, false, {
      color: false,
      motion: false,
    }),
  );
  assert.match(frame, /Document body begins here/);
  assert.match(frame, /Document body remains visible/);
  assert.ok(frame.split("\n").some((line) => /^ >\s*$/.test(line)));
  assert.match(frame, /mode: normal \(local\)/);
  assert.match(frame, /server normal/);
  assert.ok(frame.split("\n").every((line) => visibleLength(line) <= 40));
});




test("short usage view shows numeric totals and the selected record before its chart", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "nomo-tui-short-usage-"));
  const app = new Workbench({ NOMO_DATA_DIR: root }, async (url) =>
    String(url).endsWith("/models")
      ? Response.json({ data: [{ id: "fixture-model" }] })
      : Response.json({
          choices: [
            {
              message: {
                role: "assistant",
                content: "Local fixture response.",
              },
            },
          ],
          usage: { prompt_tokens: 12, completion_tokens: 8, total_tokens: 20 },
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
  await ui.initialize();
  await ui.command("Create local usage fixture.");
  await app.settled();
  ui.choose("usage");

  const frame = stripAnsi(
    renderWorkspace(ui, 40, 12, "", false, false, {
      color: false,
      motion: false,
    }),
  );
  assert.match(frame, /USAGE, 1 record \/ 1 conversation/);
  assert.match(frame, /median 20 \/ peak 20 \/ total 20\s+tokens/);
  assert.match(frame, /▸ .*fixture-model/);
  assert.doesNotMatch(frame, /[▁▂▃▄▅▆▇█]/);
  assert.match(frame, /mode: normal \(local\)/);
  assert.match(frame, /server normal/);
  assert.ok(frame.split("\n").every((line) => visibleLength(line) <= 40));
  const standard = stripAnsi(
    renderWorkspace(ui, 80, 24, "", false, false, {
      color: false,
      motion: false,
    }),
  );
  assert.match(standard, /[▁▂▃▄▅▆▇█]{2,}/);
  await ui.command("Add a second local usage record.");
  await app.settled();
  ui.choose("usage");
  ui.selected = 1;
  const secondRecord = stripAnsi(
    renderWorkspace(ui, 40, 12, "", false, false, {
      color: false,
      motion: false,
    }),
  );
  assert.match(secondRecord, /▸ 2\. .*fixture-model/);
  assert.match(secondRecord, /cost unknown/);
  assert.doesNotMatch(secondRecord, /[▁▂▃▄▅▆▇█]/);
  assert.ok(
    secondRecord.split("\n").every((line) => visibleLength(line) <= 40),
  );
});
test("new conversation keeps the welcome view and composer", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "nomo-tui-welcome-"));
  const app = new Workbench({ NOMO_DATA_DIR: root });
  t.after(async () => {
    await app.shutdown();
    await rm(root, { recursive: true, force: true });
  });
  const ui = new WorkspaceTui(app, { NOMO_DATA_DIR: root });
  ui.choose("chat");

  for (const [width, height] of [
    [20, 8],
    [40, 12],
    [80, 24],
    [120, 30],
    [120, 40],
    [160, 45],
    [200, 48],
  ]) {
    const frame = renderWorkspace(ui, width!, height!, "", false, false, {
      color: false,
      motion: false,
    });
    const plain = stripAnsi(frame);
    assert.match(plain, /NOMO/);
    assert.equal(ui.viewport.offset, 0);
    assert.ok(frame.split("\n").length <= height!);
    assert.ok(
      frame.split("\n").every((line) => visibleLength(line) <= width!),
      `frame exceeds ${width}x${height}`,
    );
    if (height! >= 18) assert.match(plain, /Welcome to a new conversation/);
    if (width! >= 80 && height! >= 24) {
      const lines = plain.split("\n");
      assert.ok(lines.some((line) => line.includes("LOCAL WORKSPACE")), `${width}: workspace eyebrow`);
      assert.ok(plain.includes("Model: not connected"), `${width}: model metadata`);
      assert.ok(plain.includes("Project: none"), `${width}: project metadata`);
      assert.ok(plain.includes("Agent: runtime default"), `${width}: agent metadata`);
      const legend = lines.findIndex((line) => line.includes("open/details"));
      const composer = lines.findIndex((line) => line.trim() === ">");
      assert.ok(composer >= 0, `${width}x${height}: composer row visible`);
      assert.ok(
        lines[composer]!.startsWith(" > "),
        `${width}x${height}: composer matches Prime's one-cell inset`,
      );
      const summary = lines.findIndex((line) => line.includes("model offline"));
      const status = lines.findIndex((line) =>
        line.includes("i: type | /help: commands"),
      );
      assert.ok(
        lines.some((line) => line.includes("Tab panels")),
        `${width}x${height}: tab navigation hint remains visible`,
      );
      assert.ok(status >= 0, `${width}x${height}: composer hints remain visible`);
      assert.doesNotMatch(
        lines[status]!,
        /Tab: panels/,
        `${width}x${height}: tab hint is not repeated`,
      );
      assert.ok(
        legend >= 0 && legend < composer,
        `${width}x${height}: legend above composer`,
      );
      assert.ok(summary < status, `${width}x${height}: status below summary`);
    }
  }
});
test("empty chat welcome block is vertically centered above the composer", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "nomo-tui-welcome-center-"));
  const app = new Workbench({ NOMO_DATA_DIR: root });
  t.after(async () => {
    await app.shutdown();
    await rm(root, { recursive: true, force: true });
  });
  const ui = new WorkspaceTui(app, { NOMO_DATA_DIR: root });
  ui.choose("chat");

  for (const [width, height] of [
    [80, 24],
    [120, 40],
    [200, 48],
  ]) {
    for (const color of [false, true]) {
      const rows = stripAnsi(
        renderWorkspace(ui, width!, height!, "", false, false, {
          color,
          ...(color ? { colorDepth: 8 } : {}),
          motion: false,
        }),
      ).split("\n");
      const mode = color ? "color" : "monochrome";
      const navigation = rows.findIndex((row) => row.includes("› chat"));
      const footer = rows.findIndex((row) => row.includes("Tab panels"));
      const start = rows.findIndex((row) => row.includes("LOCAL WORKSPACE"));
      const end = rows.findIndex((row) => row.includes("Ctrl+P commands"));
      assert.ok(
        navigation >= 0 && footer > navigation,
        `${width}x${height} ${mode}: shell rows`,
      );
      assert.ok(
        start > navigation && end >= start,
        `${width}x${height} ${mode}: welcome block`,
      );

      const topGap = start - navigation - 1;
      const bottomGap = footer - end - 1;
      assert.ok(
        Math.abs(topGap - bottomGap) <= 1,
        `${width}x${height} ${mode}: welcome block should balance; ` +
          `got ${topGap} top rows and ${bottomGap} bottom rows`,
      );
    }
  }
});


test("welcome workspace eyebrow uses the NOMO accent", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "nomo-tui-welcome-accent-"));
  const app = new Workbench({ NOMO_DATA_DIR: root });
  t.after(async () => {
    await app.shutdown();
    await rm(root, { recursive: true, force: true });
  });
  const ui = new WorkspaceTui(app, { NOMO_DATA_DIR: root });
  ui.choose("chat");

  for (const [width, height] of [[80, 24], [120, 40], [200, 48]]) {
    const colorFrame = renderWorkspace(ui, width!, height!, "▌", true, false, {
      color: true,
      colorDepth: 8,
      motion: false,
    });
    const accentRow = colorFrame
      .split("\n")
      .find((line) => stripAnsi(line).includes("LOCAL WORKSPACE"));
    assert.ok(accentRow, `${width}x${height}: welcome eyebrow stays visible`);
    assert.ok(
      accentRow!.includes("\x1b[1;38;5;117m"),
      `${width}x${height}: welcome eyebrow uses NOMO blue`,
    );

    const monochrome = renderWorkspace(ui, width!, height!, "▌", true, false, {
      color: false,
      motion: false,
    });
    assert.match(stripAnsi(monochrome), /LOCAL WORKSPACE/);
    assert.doesNotMatch(monochrome, /\x1b\[/);
  }
});

test("empty workspace panels center their existing message", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "nomo-tui-empty-panels-"));
  const app = new Workbench({ NOMO_DATA_DIR: root });
  t.after(async () => {
    await app.shutdown();
    await rm(root, { recursive: true, force: true });
  });
  const ui = new WorkspaceTui(app, { NOMO_DATA_DIR: root });
  await ui.initialize();

  for (const tab of ["sessions", "documents", "approvals", "models", "usage"] as const) {
    ui.choose(tab);
    for (const [width, height] of [[80, 24], [120, 40], [200, 48]]) {
      for (const color of [false, true]) {
        const frame = renderWorkspace(ui, width!, height!, "▌", true, false, {
          color,
          colorDepth: 8,
          motion: false,
        });
        const lines = stripAnsi(frame).split("\n");
        const empty = lines.findIndex((line) => line.includes("No entries yet."));
        const navigation = lines.findIndex((line) => line.includes(`› ${tab} `));
        const legend = lines.findIndex((line) => line.includes("Tab panels"));

        assert.ok(empty >= 0, `${tab} ${width}x${height}: message remains visible`);
        assert.ok(
          Math.abs(empty - Math.floor((navigation + legend) / 2)) <= 1,
          `${tab} ${width}x${height}: message is centered vertically`,
        );
        assert.equal(
          lines[empty]!.indexOf("No entries yet."),
          Math.floor((width! - "No entries yet.".length) / 2),
          `${tab} ${width}x${height}: message is centered horizontally`,
        );
        assert.equal(lines.length, height);
        assert.ok(frame.split("\n").every((line) => visibleLength(line) <= width!));
      }
    }
  }
});

test("footer hints and status use muted NOMO hierarchy", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "nomo-tui-footer-styles-"));
  const app = new Workbench({ NOMO_DATA_DIR: root });
  t.after(async () => {
    await app.shutdown();
    await rm(root, { recursive: true, force: true });
  });
  const ui = new WorkspaceTui(app, { NOMO_DATA_DIR: root });
  ui.choose("chat");

  for (const [width, height] of [
    [80, 24],
    [120, 40],
    [200, 48],
  ]) {
    const colorFrame = renderWorkspace(ui, width!, height!, "", false, false, {
      color: true,
      colorDepth: 8,
      motion: false,
    });
    const colorRows = colorFrame.split("\n");
    const legend = colorRows.find((row) =>
      stripAnsi(row).includes("open/details"),
    );
    const status = colorRows.find((row) =>
      stripAnsi(row).includes("i: type | /help: commands"),
    );
    assert.ok(legend, `${width}: shortcut hints remain visible`);
    assert.ok(status, `${width}: status hints remain visible`);
    assert.match(legend!, /\x1b\[[0-9;]*m/, `${width}: hints retain color`);
    assert.doesNotMatch(
      legend!,
      /\?\[[0-9;]+m/,
      `${width}: ANSI paint is not printed as literal question-mark text`,
    );
    assert.match(
      status!,
      /\x1b\[38;5;245m/,
      `${width}: idle status uses muted ink`,
    );
    const basicColorFrame = renderWorkspace(
      ui,
      width!,
      height!,
      "",
      false,
      false,
      { color: true, motion: false, colorDepth: 4 },
    );
    assert.doesNotMatch(basicColorFrame, /\u001b\[[0-9;]*;5;/);
    assert.match(basicColorFrame, /\u001b\[1;96m/);


    const monochromeFrame = renderWorkspace(
      ui,
      width!,
      height!,
      "",
      false,
      false,
      { color: false, motion: false },
    );
    assert.doesNotMatch(monochromeFrame, /\x1b\[/, `${width}: no color escapes`);
    const monochrome = stripAnsi(monochromeFrame);
    assert.match(monochrome, /open\/details/);
    assert.match(monochrome, /i: type \| \/help: commands/);
  }
  await ui.command("/command-palette");
  for (const [width, height] of [
    [80, 24],
    [120, 40],
    [200, 48],
  ]) {
    const paletteFrame = renderWorkspace(
      ui,
      width!,
      height!,
      "",
      false,
      false,
      { color: true, motion: false, colorDepth: 8 },
    );
    const rows = paletteFrame.split("\n");
    const legend = rows.find((row) =>
      stripAnsi(row).includes("open/details"),
    );
    const status = rows.find((row) =>
      stripAnsi(row).includes("commands match / Enter run / Esc close"),
    );
    assert.ok(legend, `${width}: command palette retains shortcut hints`);
    assert.ok(status, `${width}: command palette retains status`);
    assert.match(legend!, /\x1b\[[0-9;]*m/, `${width}: palette hints use theme`);
    assert.doesNotMatch(legend!, /\?\[[0-9;]+m/);
    assert.match(status!, /\x1b\[38;5;245m/);
    const groupHeading = rows.find((row) =>
      stripAnsi(row).includes("● CHAT"),
    );
    const selected = rows.find((row) =>
      stripAnsi(row).includes("> ◆ /agent"),
    );
    assert.ok(groupHeading, `${width}: command groups remain visible`);
    assert.ok(selected, `${width}: selected command remains visible`);
    assert.doesNotMatch(groupHeading!, /\?\[[0-9;]+m/);
    assert.doesNotMatch(selected!, /\?\[[0-9;]+m/);
    assert.match(groupHeading!, /\x1b\[1;38;5;117m/);
    assert.match(selected!, /\x1b\[1;38;5;117m/);

  }

});

test("overview uses the shared workspace eyebrow below NOMO branding", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "nomo-tui-overview-title-"));
  const app = new Workbench({ NOMO_DATA_DIR: root });
  t.after(async () => {
    await app.shutdown();
    await rm(root, { recursive: true, force: true });
  });
  const ui = new WorkspaceTui(app, { NOMO_DATA_DIR: root });
  const rows = stripAnsi(
    renderWorkspace(ui, 80, 24, "", false, false, {
      color: false,
      motion: false,
    }),
  ).split("\n");
  assert.ok(rows[0]!.includes("NOMO"));
  assert.equal(rows[2]!.trim(), "LOCAL WORKSPACE");
});

test("help explains grouped navigation and inspector scrolling", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "nomo-tui-help-nav-"));
  const app = new Workbench({ NOMO_DATA_DIR: root });
  t.after(async () => {
    await app.shutdown();
    await rm(root, { recursive: true, force: true });
  });
  const ui = new WorkspaceTui(app, { NOMO_DATA_DIR: root });
  ui.choose("help");
  const help = ui.lines().join("\n");
  assert.match(help, /folds a group/);
  assert.match(help, /scroll.*detail/i);
  assert.match(help, /keeps the draft/i);
  const frame = stripAnsi(
    renderWorkspace(ui, 80, 24, "", false, false, {
      color: false,
      motion: false,
    }),
  );
  assert.ok(
    frame.replace(/\s+/g, " ").includes("configure mod-enter in /settings."),
  );
});

test("narrow tab navigation names the selected panel and its position", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "nomo-tui-tabs-"));
  const app = new Workbench({ NOMO_DATA_DIR: root });
  t.after(async () => {
    await app.shutdown();
    await rm(root, { recursive: true, force: true });
  });
  const ui = new WorkspaceTui(app, { NOMO_DATA_DIR: root });

  for (const [index, tab] of WORKSPACE_TABS.entries()) {
    ui.choose(tab);
    for (const width of [20, 24, 30, 40, 80, 120]) {
      const lines = stripAnsi(
        renderWorkspace(ui, width, 12, "", false, false, {
          color: false,
          motion: false,
        }),
      ).split("\n");
      assert.ok(lines[1]!.includes(tab), `${tab} at ${width}: ${lines[1]}`);
      if (width < 24)
        assert.ok(
          lines[1]!.includes(`${index + 1}/${WORKSPACE_TABS.length}`),
          `${tab}: ${lines[1]}`,
        );
      else assert.ok(lines[1]!.includes(`› ${tab}`), `${tab}: ${lines[1]}`);
      assert.ok(
        visibleLength(lines[1]!) <= width,
        `${tab} at ${width}: ${lines[1]}`,
      );
      assert.ok(lines[0]!.includes(" NOMO"), `${width}: ${lines[0]}`);
      assert.ok(!lines[0]!.includes("⌜⊡⌝"), `${width}: ${lines[0]}`);
      assert.ok(!lines[0]!.includes("/V/"), `${width}: ${lines[0]}`);
    }
  }
  const colored = renderWorkspace(ui, 20, 12, "", false, false, {
    color: true,
    motion: false,
    colorDepth: 8,
  });
  const coloredHeader = colored.split("\n")[0]!;
  assert.match(stripAnsi(coloredHeader), /^ NOMO/);
  assert.match(coloredHeader, /\x1b\[/);
});
test("narrow scrolling keeps the complete composer hint", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "nomo-tui-narrow-scroll-hint-"));
  const app = new Workbench({ NOMO_DATA_DIR: root });
  t.after(async () => {
    await app.shutdown();
    await rm(root, { recursive: true, force: true });
  });
  const ui = new WorkspaceTui(app, { NOMO_DATA_DIR: root });
  ui.choose("help");
  const lines = stripAnsi(
    renderWorkspace(ui, 40, 12, "", false, false, {
      color: false,
      motion: false,
    }),
  ).split("\n");
  const status = lines.find((line) => line.includes("i: type | /help"));
  assert.ok(status, "complete composer hint remains visible");
  assert.match(status!, /↓ \d+ more · PgDn · i: type \| \/help/);
  assert.ok(!status!.includes("Tab: panels"), "reuse the existing tab legend");
  assert.ok(
    lines.every((line) => visibleLength(line) <= 40),
    "narrow frame stays within its terminal width",
  );
});

test("tab navigation centers its existing window at reference widths", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "nomo-tui-tab-centering-"));
  const app = new Workbench({ NOMO_DATA_DIR: root });
  t.after(async () => {
    await app.shutdown();
    await rm(root, { recursive: true, force: true });
  });
  const ui = new WorkspaceTui(app, { NOMO_DATA_DIR: root });
  ui.choose("chat");

  for (const color of [false, true]) {
    for (const width of [80, 120, 200]) {
      const line = stripAnsi(
        renderWorkspace(ui, width, 24, "", false, false, {
          color,
          motion: false,
        }),
      ).split("\n")[1]!;
      assert.ok(line.includes("› chat"), `${width} color=${color}: ${line}`);
      const content = line.trim();
      const left = line.indexOf(content);
      const right = width - left - visibleLength(content);
      assert.ok(
        Math.abs(left - right) <= 1,
        `${width} color=${color}: tab strip left=${left}, right=${right}: ${line}`,
      );
    }
  }
});

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

test("command palette selection uses a full-width NOMO wash", () => {
  const item = {
    id: "/safe",
    label: "Safe command",
    hint: "A safe fixture",
    icon: "◆",
    group: "chat" as const,
  };
  const state = {
    query: "",
    selected: 0,
    visible: 0,
    recent: new Map<string, { count: number; lastUsed: number }>(),
  };

  for (const width of [76, 116, 196]) {
    const color = renderPalette(state, [item], width, { color: true });
    const selected = color.lines.find((line) => line.includes("/safe"));
    assert.ok(selected);
    assert.ok(selected.startsWith("\x1b[48;5;237m\x1b[1;38;5;117m"));
    assert.ok(selected.endsWith("\x1b[0;48;5;234;38;5;252m"));
    assert.equal(visibleLength(stripAnsi(selected)), width);
    const basicColor = renderPalette(
      state,
      [item],
      width,
      { color: true, colorDepth: 4 },
    );
    const basicSelected = basicColor.lines.find((line) => line.includes("/safe"));
    assert.ok(basicSelected);
    assert.match(basicSelected, /^\u001b\[1;96m/);
    assert.doesNotMatch(basicSelected, /\u001b\[[0-9;]*;5;/);


    const monochrome = renderPalette(state, [item], width);
    const monoSelected = monochrome.lines.find((line) => line.includes("/safe"));
    assert.ok(monoSelected?.startsWith("> "));
    assert.doesNotMatch(monoSelected!, /\x1b\[/);
    assert.equal(visibleLength(monoSelected!), width);

    const emptyColor = renderPalette(
      { ...state, query: "no match" },
      [item],
      width,
      { color: true },
    ).lines[0]!;
    assert.ok(stripAnsi(emptyColor).includes('No matches for "no match".'));
    assert.match(emptyColor, /^\x1b\[[0-9;]*m/);
    assert.ok(!emptyColor.includes("48;5;237m"));

    const emptyMonochrome = renderPalette(
      { ...state, query: "no match" },
      [item],
      width,
    ).lines[0]!;
    assert.ok(
      stripAnsi(emptyMonochrome).includes('No matches for "no match".'),
    );
    assert.doesNotMatch(emptyMonochrome, /\x1b\[/);
  }
});

test("command palette sanitizes dynamic text before applying ANSI paint", () => {
  const noMatches = renderPalette(
    { query: "\x1b[2J", selected: 0, visible: 0, recent: new Map() },
    [
      {
        id: "/safe",
        label: "Safe command",
        hint: "A safe fixture",
        icon: "◆",
        group: "chat",
      },
    ],
    80,
    { color: true },
  );
  const noMatchesText = stripAnsi(noMatches.lines.join("\n"));
  assert.ok(!noMatchesText.includes("\x1b"));
  assert.ok(noMatchesText.includes('No matches for "?[2J".'));

  const hostileItem = renderPalette(
    { query: "", selected: 0, visible: 0, recent: new Map() },
    [
      {
        id: "/bad\x1b[2J",
        label: "Ignored",
        hint: "Unsafe\x1b[3J",
        icon: "◆\x1b[4J",
        group: "chat",
      },
    ],
    80,
    { color: true },
  );
  const hostileText = stripAnsi(hostileItem.lines.join("\n"));
  assert.ok(!hostileText.includes("\x1b"));
  assert.match(hostileText, /> ◆\?\[4J \/bad\?\[2J  Unsafe\?\[3J/);
  assert.match(hostileItem.lines[0]!, /\x1b\[1;38;5;117m/);
  assert.match(hostileItem.lines[1]!, /\x1b\[1;38;5;117m/);
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
test("configured workspace shortcuts override only mapped actions", () => {
  const bindings = parseWorkspaceKeybindings('{"redraw":"Ctrl+V"}').bindings;
  assert.equal(
    workspaceShortcut({ name: "v", ctrl: true }, false, "", bindings),
    "redraw",
  );
  assert.equal(
    workspaceShortcut({ name: "z", ctrl: true }, false, "", bindings),
    undefined,
  );
  assert.equal(
    workspaceShortcut({ name: "l", ctrl: true }, false, "", bindings),
    undefined,
  );
  assert.equal(
    workspaceShortcut({ name: "d", ctrl: true }, false, "", bindings),
    "quit",
    "Ctrl+D remains an immutable exit binding",
  );
});

test("workspace keybinding overrides reject unsafe, unknown, and conflicting keys atomically", () => {
  const valid = parseWorkspaceKeybindings(
    '{"redraw":"Ctrl+O","toggle-tools":"Ctrl+L","search-history":"Ctrl+R","stash":"Ctrl+S","external-editor":"Ctrl+G","show-todos":"Ctrl+T"}',
  );
  assert.equal(valid.error, undefined);
  assert.equal(valid.bindings.redraw.name, "o");
  assert.equal(valid.bindings["show-todos"].name, "t");
  for (const [key, action] of [
    ["o", "redraw"],
    ["l", "toggle-tools"],
    ["r", "search-history"],
    ["s", "stash"],
    ["g", "external-editor"],
    ["t", "show-todos"],
  ] as const) {
    assert.equal(
      workspaceShortcut({ name: key, ctrl: true }, true, "", valid.bindings),
      action,
    );
  }
  assert.equal(
    workspaceShortcut({ name: "o", ctrl: true }, false, "", valid.bindings),
    "redraw",
  );
  assert.equal(
    workspaceShortcut({ name: "l", ctrl: true }, false, "", valid.bindings),
    "toggle-tools",
  );

  for (const raw of [
    "{",
    '{"redraw":"Ctrl+D"}',
    '{"redraw":"Ctrl+O"}',
    '{"approve":"Ctrl+V"}',
  ]) {
    const invalid = parseWorkspaceKeybindings(raw);
    assert.match(invalid.error ?? "", /NOMO_TUI_KEYBINDINGS ignored/);
    assert.deepEqual(invalid.bindings, DEFAULT_WORKSPACE_KEYBINDINGS);
  }
  assert.equal(
    workspaceShortcut({ name: "d", ctrl: true }, false, "", valid.bindings),
    "quit",
    "Ctrl+D remains immutable",
  );
  assert.equal(
    workspaceShortcut({ name: "y" }, false, "", valid.bindings),
    undefined,
    "plain confirmation keys cannot be routed through configurable shortcuts",
  );
});
test("opt-in Vim composer edits text without changing normal send behavior", () => {
  const vim = new WorkspaceVimMode();
  const input = new WorkspaceInput();
  input.editing = true;
  input.set("one two\nthree");
  input.cursor = 0;

  assert.equal(vim.mode, "normal");
  assert.equal(vim.handle(input, "w", { name: "w" }), true);
  assert.equal(input.cursor, 4);
  assert.equal(vim.handle(input, "b", { name: "b" }), true);
  assert.equal(input.cursor, 0);
  assert.equal(vim.handle(input, "l", { name: "l" }), true);
  assert.equal(vim.handle(input, "x", { name: "x" }), true);
  assert.equal(input.value, "oe two\nthree");
  assert.equal(input.cursor, 1);

  assert.equal(vim.handle(input, "a", { name: "a" }), true);
  assert.equal(vim.mode, "insert");
  assert.equal(input.cursor, 2);
  input.insert("X");
  assert.equal(input.value, "oeX two\nthree");
  assert.equal(vim.leaveInsert(), true);
  assert.equal(vim.mode, "normal");

  assert.equal(vim.handle(input, "h", { name: "h" }), true);
  assert.equal(input.cursor, 2);
  assert.equal(vim.handle(input, "j", { name: "j" }), true);
  assert.equal(input.cursor, 10);
  assert.equal(vim.handle(input, "k", { name: "k" }), true);
  assert.equal(input.cursor, 2);
  assert.equal(vim.handle(input, "0", { name: "0" }), true);
  assert.equal(input.cursor, 0);
  assert.equal(vim.handle(input, "$", { name: "$" }), true);
  assert.equal(input.cursor, 7);
  assert.equal(vim.handle(input, "A", { name: "A" }), true);
  assert.equal(input.cursor, 7);
  assert.equal(vim.leaveInsert(), true);
  assert.equal(vim.handle(input, "I", { name: "I" }), true);
  assert.equal(input.cursor, 0);
  assert.equal(vim.leaveInsert(), true);
  assert.equal(vim.handle(input, "i", { name: "i" }), true);
  assert.equal(vim.mode, "insert");
  assert.equal(vim.leaveInsert(), true);
  const value = input.value;
  assert.equal(vim.handle(input, "q", { name: "q" }), true);
  assert.equal(input.value, value, "normal mode never types unknown letters");
  assert.equal(
    vim.handle(input, undefined, { name: "return" }),
    false,
    "Enter retains the existing submit action",
  );
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

test("tool filter with no matches explains the empty result", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "nomo-tui-tool-filter-"));
  const app = new Workbench({ NOMO_DATA_DIR: root });
  t.after(async () => {
    await app.shutdown();
    await rm(root, { recursive: true, force: true });
  });
  const ui = new WorkspaceTui(app);
  await ui.command("/tools nomo-filter-miss");

  assert.ok(ui.lines().some((line) => /no tools match/i.test(line)));
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
    /model offline.*mode: normal \(local only, not enforced\).*permission normal \(server\).*tok \?.*tools compact/i,
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
    chatRows([event], 80, false).some((row) => row.text.includes("result 19")),
  );
  assert.ok(
    chatRows([{ ...event, kind: "error" }], 80, true).some((row) =>
      row.text.includes("result 19"),
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
});
test("composer uses a filled NOMO surface and Prime-like prompt spacing", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "nomo-tui-composer-surface-"));
  const app = new Workbench({ NOMO_DATA_DIR: root });
  t.after(async () => {
    await app.shutdown();
    await rm(root, { recursive: true, force: true });
  });
  const ui = new WorkspaceTui(app);
  for (const [width, height] of [
    [80, 24],
    [120, 40],
    [200, 48],
  ]) {
    const colorFrame = renderWorkspace(
      ui,
      width!,
      height!,
      "",
      false,
      false,
      { color: true, motion: false, colorDepth: 8 },
    );
    const surfaceRows = colorFrame
      .split("\n")
      .filter((line) => line.includes("\x1b[48;5;236;38;5;252m"));
    assert.equal(surfaceRows.length, 3, `filled composer rows at ${width} columns`);
    const frameLines = colorFrame.split("\n");
    const contextIndex = frameLines.findIndex((line) =>
      line.includes("mode: normal"),
    );
    const promptIndex = frameLines.findIndex((line) =>
      line.includes("\x1b[1;38;5;117;48;5;236m> "),
    );
    const hintIndex = frameLines.findIndex((line) =>
      line.includes("i: type | /help: commands"),
    );
    assert.ok(
      contextIndex >= 0 && contextIndex < promptIndex,
      `context status precedes the prompt at ${width} columns`,
    );
    assert.ok(
      promptIndex < hintIndex,
      `the prompt precedes the trailing help hint at ${width} columns`,
    );
    assert.ok(
      surfaceRows.every((line) => visibleLength(line) === width),
      `composer surface fills ${width} columns`,
    );
    assert.ok(
      surfaceRows.some((line) => line.includes("\x1b[1;38;5;117;48;5;236m> ")),
      `NOMO blue prompt remains visible at ${width} columns`,
    );
    const basicColorFrame = renderWorkspace(
      ui,
      width!,
      height!,
      "",
      false,
      false,
      { color: true, motion: false, colorDepth: 4 },
    );
    const basicSurfaceRows = basicColorFrame
      .split("\n")
      .filter((line) => line.includes("\x1b[100;37m"));
    assert.equal(
      basicSurfaceRows.length,
      3,
      `basic ANSI composer surface fills three rows at ${width} columns`,
    );
    assert.ok(
      basicSurfaceRows.some((line) => line.includes("\x1b[1;96;100m> ")),
      `basic ANSI composer keeps the NOMO blue prompt at ${width} columns`,
    );
    const typedColorFrame = renderWorkspace(
      ui,
      width!,
      height!,
      "safe typed prompt▌",
      true,
      false,
      { color: true, motion: false, colorDepth: 8 },
    );
    const typedPrompt = typedColorFrame
      .split("\n")
      .find((line) => line.includes("safe typed prompt"));
    assert.ok(
      typedPrompt?.includes(
        "\x1b[0;48;5;236;38;5;252m safe typed prompt█",
      ),
      `typed prompt stays inside the filled surface at ${width} columns`,
    );

    const monochromeFrame = renderWorkspace(
      ui,
      width!,
      height!,
      "",
      false,
      false,
      { color: false, motion: false },
    );
    assert.doesNotMatch(monochromeFrame, /\x1b\[/);
    assert.ok(
      monochromeFrame.split("\n").some((line) => line.startsWith(" >  ")),
      `monochrome prompt keeps one-cell separation at ${width} columns`,
    );
    const typedMonochromeFrame = renderWorkspace(
      ui,
      width!,
      height!,
      "safe typed prompt▌",
      true,
      false,
      { color: false, motion: false },
    );
    assert.doesNotMatch(typedMonochromeFrame, /\x1b\[/);
    assert.ok(
      typedMonochromeFrame
        .split("\n")
        .some((line) => line.includes(">  safe typed prompt█")),
      `typed monochrome prompt remains readable at ${width} columns`,
    );
  }
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
  ui.choose("documents");
  await ui.openSelected();
  const documentPane = stripAnsi(renderWorkspace(ui, 160, 32));
  assert.match(documentPane, /plan\.md/);
  assert.match(documentPane, /DOCUMENT/);
  await ui.prepareUndo();
  assert.equal(ui.confirmation?.title, "UNDO plan.md?");
  ui.confirmation = undefined;
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


test("composer Enter behavior follows the saved sendBehavior preference", () => {
  const input = new WorkspaceInput();
  input.editing = true;
  input.sendBehavior = "mod-enter";
  input.set("first");
  assert.equal(input.key("\r", { name: "return" }), undefined);
  assert.equal(input.value, "first\n");

  input.set("second");
  assert.equal(input.key("\r", { name: "return", ctrl: true }), "submit");

  input.set("continued\\");
  assert.equal(input.key("\r", { name: "return" }), undefined);
  assert.equal(input.value, "continued\n");

  input.sendBehavior = "enter";
  input.set("third");
  assert.equal(input.key("\r", { name: "return" }), "submit");
});

test("newline keys stay available in both composer send modes", () => {
  const input = new WorkspaceInput();
  input.editing = true;

  for (const key of [
    { name: "return", shift: true },
    { name: "return", meta: true },
    { name: "j", ctrl: true },
  ]) {
    input.set("draft");
    assert.equal(input.key("\r", key), undefined);
    assert.equal(input.value, "draft\n");
  }

  input.sendBehavior = "mod-enter";
  input.set("draft");
  assert.equal(input.key("\r", { name: "return", shift: true }), undefined);
  assert.equal(input.value, "draft\n");
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
  assert.deepEqual(
    wrap(["LEDGER, 8 entries: 4 agent, 1 verification, 1 entry"], 36),
    ["LEDGER, 8 entries: 4 agent, 1", "verification, 1 entry"],
  );
});
test("wrapped descriptions retain continuation indentation", () => {
  assert.deepEqual(
    wrap(["    Alpha beta gamma delta"], 12),
    ["    Alpha", "    beta", "    gamma", "    delta"],
  );
});
test("inspector wraps values and body text between words", () => {
  const rows = renderInspector(
    {
      title: "HELP",
      sections: [
        {
          title: "working",
          fields: [
            {
              label: "chat",
              value:
                "Start typing. i types. Enter sends by default; configure mod-enter in /settings.",
            },
          ],
          body: ["The line breaks only between complete words."],
        },
      ],
    },
    { width: 36 },
  );
  const text = rows.join(" ").replace(/\s+/g, " ");
  assert.ok(text.includes("configure mod-enter in /settings."));
  assert.ok(text.includes("complete words."));
});
test("inspector uses the shared thin divider at every width", () => {
  for (const width of [4, 36, 120]) {
    const rows = renderInspector(
      { title: "DETAIL", sections: [] },
      { width },
    );
    assert.equal(rows[1], "─".repeat(width));
  }
});
test("wide detail uses full width without a master list and splits when populated", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "nomo-tui-wide-inspector-"));
  const app = new Workbench({ NOMO_DATA_DIR: root }, async (url) =>
    String(url).endsWith("/models")
      ? Response.json({ data: [{ id: "visual-model" }] })
      : Response.json({
          choices: [
            {
              message: {
                role: "assistant",
                content: "A plain local reply.",
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
    baseUrl: "https://local.test/v1",
    apiKey: "nomo-visual-test-key",
  });
  const ui = new WorkspaceTui(app, { NOMO_DATA_DIR: root });
  await ui.initialize();
  ui.choose("documents");
  ui.detail = ["DOCUMENT", "-".repeat(76), "─".repeat(76), "RAW RECORD"];
  for (const [width, height] of [
    [120, 40],
    [200, 48],
  ]) {
    const emptyMaster = stripAnsi(
      renderWorkspace(ui, width!, height!),
    ).split("\n");
    assert.ok(emptyMaster.some((row) => row.includes("DOCUMENT")));
    assert.ok(
      !emptyMaster.some((row) => row.includes("│")),
      `${width}x${height}: detail-only screens must not reserve a blank master pane`,
    );
  }

  ui.choose("overview");
  ui.detail = ui.settingsLines();
  const emptySettings = stripAnsi(renderWorkspace(ui, 200, 48)).split("\n");
  assert.ok(emptySettings.some((row) => row.includes("APPLICATION SETTINGS")));
  assert.ok(!emptySettings.some((row) => row.includes("│")));

  await ui.command("Create a safe local session.");
  await app.settled();
  ui.choose("sessions");
  ui.detail = ["SESSION DETAIL", "-".repeat(76), "─".repeat(76), "RAW RECORD"];
  const populatedMaster = stripAnsi(
    renderWorkspace(ui, 200, 48),
  ).split("\n");
  assert.ok(
    populatedMaster.some((row) => row.includes("▸") && row.includes("│")),
    "a populated master list keeps the split layout",
  );
  const rules = populatedMaster.filter((row) => {
    const divider = row.indexOf("│");
    return divider >= 0 && /^[-─]+$/.test(row.slice(divider + 1).trim());
  });
  assert.equal(rules.length, 2);
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
  assert.ok(
    stripAnsi(renderWorkspace(ui, 100, 32)).includes("NOMO / local workspace"),
  );
});

test("streamed code uses NOMO syntax colors and a live type cursor", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "nomo-tui-streamed-code-"));
  const app = new Workbench({ NOMO_DATA_DIR: root }, async (url) =>
    String(url).endsWith("/models")
      ? Response.json({ data: [{ id: "visual-model" }] })
      : Response.json({
          choices: [
            {
              message: { role: "assistant", content: "Fixture reply." },
            },
          ],
        }),
  );
  t.after(async () => {
    await app.shutdown();
    await rm(root, { recursive: true, force: true });
  });
  await app.configure({
    baseUrl: "https://local.test/v1",
    apiKey: "nomo-visual-test-key",
  });
  const ui = new WorkspaceTui(app, { NOMO_DATA_DIR: root });
  await ui.initialize();
  await ui.command("Render a code sample.");
  await app.settled();
  const session = ui.session();
  assert.ok(session);
  const streamingSession = {
    ...session,
    status: "running",
    events: [
      ...session.events,
      {
        seq: session.events.length + 1,
        at: "2026-10-23T13:40:01.000Z",
        kind: "assistant" as const,
        type: "message.delta",
        text: '### Live heading\n- item\n> quote\n```ts\nconst answer: string = "NOMO";',
      },
    ],
  };
  Object.defineProperty(ui, "session", { value: () => streamingSession });
  const streamedRows = chatRows(streamingSession.events, 120, false, "⠋", "▌");
  assert.ok(
    streamedRows.some((row) => row.style === "heading" && row.text === "Live heading"),
  );
  assert.ok(
    streamedRows.some((row) => row.style === "list" && row.text === "• item"),
  );
  assert.ok(
    streamedRows.some((row) => row.style === "quote" && row.text === "| quote"),
  );

  const render = (
    width: number,
    height: number,
    frame: number,
    color = true,
    motion = true,
  ) =>
    renderWorkspace(ui, width, height, "", true, true, {
      color,
      colorDepth: 8,
      frame,
      motion,
    });
  for (const [width, height] of [
    [40, 12],
    [80, 24],
    [120, 40],
    [200, 48],
  ]) {
    const first = render(width!, height!, 0);
    const codeLines = first
      .split("\n")
      .filter((line) => /const|"NOMO"/.test(stripAnsi(line)));
    const colorAt = (text: string) => {
      const line = codeLines.find((row) => stripAnsi(row).includes(text));
      assert.ok(line, `${width} columns: missing ${text}`);
      return line.slice(0, line.indexOf(text)).match(/\x1b\[([^m]+)m/g)?.at(-1);
    };
    if (width === 40) {
      assert.notEqual(colorAt('"NOMO"'), "\x1b[38;5;117;48;5;235m");
    } else {
      assert.notEqual(colorAt("const"), colorAt('"NOMO"'), `${width} columns`);
    }
    const plainLines = codeLines.map(stripAnsi).join("\n");
    assert.ok(plainLines.includes('"NOMO";▌'), `${width} columns: live caret`);
    assert.ok(
      codeLines
        .map(stripAnsi)
        .every((line) => visibleLength(line) <= width!),
      `${width} columns: code rows stay within the terminal`,
    );
    const nextFrame = stripAnsi(render(width!, height!, 4));
    assert.ok(nextFrame.includes('"NOMO";█'), `${width} columns: cursor animates`);
    const monochrome = render(width!, height!, 0, false, false);
    assert.doesNotMatch(monochrome, /\x1b\[/);
    assert.ok(stripAnsi(monochrome).includes('"NOMO";█'));
    assert.equal(
      monochrome,
      render(width!, height!, 4, false, false),
      `${width} columns: motion-off frame stays fixed`,
    );
  }
});

test("conversation transcript and selected collection rows keep NOMO hierarchy", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "nomo-tui-plain-chat-"));
  const app = new Workbench({ NOMO_DATA_DIR: root }, async (url) =>
    String(url).endsWith("/models")
      ? Response.json({ data: [{ id: "visual-model" }] })
      : Response.json({
          choices: [
            {
              message: {
                role: "assistant",
                content: "A plain local reply.",
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
    baseUrl: "https://local.test/v1",
    apiKey: "nomo-visual-test-key",
  });
  const ui = new WorkspaceTui(app, { NOMO_DATA_DIR: root });
  await ui.initialize();
  await ui.command("Show a plain chat reply.");
  await app.settled();

  const frame = stripAnsi(renderWorkspace(ui, 120, 40, "", true));
  assert.ok(frame.includes("▸ YOU"));
  assert.ok(frame.includes("● NOMO"));
  assert.ok(frame.includes("A plain local reply."));
  assert.ok(!frame.includes("┌ ▸ YOU"));
  assert.ok(!frame.includes("┌ ● NOMO"));
  assert.ok(!frame.includes("│ A plain local reply."));
  const colorFrame = renderWorkspace(ui, 120, 40, "", true, false, {
    color: true,
    colorDepth: 8,
  });
  const userRow = colorFrame.split("\n").find((line) => line.includes("YOU"));
  assert.ok(userRow);
  assert.ok(
    userRow!.includes("\x1b[1;38;5;183;48;5;237m"),
    "the user role sits on NOMO's Prime-like message surface",
  );
  const userBodyRow = colorFrame
    .split("\n")
    .find((line) => line.includes("Show a plain chat reply."));
  assert.ok(userBodyRow);
  assert.ok(
    userBodyRow!.includes("\x1b[38;5;252;48;5;237m"),
    "the user message body uses the same padded surface",
  );

  const session = ui.session();
  assert.ok(session);
  const fixtureSession = {
    ...session,
    events: [
      ...session.events,
      {
        seq: session.events.length + 1,
        at: "2026-10-23T13:40:00.000Z",
        kind: "tool" as const,
        type: "tool.started",
        text: "Synthetic requested tool output.",
        payload: { tool: "requested_tool" },
      },
      {
        seq: session.events.length + 2,
        at: "2026-10-23T13:40:00.000Z",
        kind: "tool" as const,
        type: "tool.result",
        text: "Synthetic complete tool output.",
        payload: { tool: "complete_tool", result: { isError: false } },
      },
      {
        seq: session.events.length + 3,
        at: "2026-10-23T13:40:00.000Z",
        kind: "tool" as const,
        type: "tool.result",
        text: "Synthetic error tool output.",
        payload: { tool: "error_tool", result: { isError: true } },
      },
      {
        seq: session.events.length + 4,
        at: "2026-10-23T13:40:00.000Z",
        kind: "tool" as const,
        type: "tool.future",
        text: "Synthetic unknown tool output.",
        payload: { tool: "future_tool" },
      },
    ],
  };
  Object.defineProperty(ui, "session", { value: () => fixtureSession });
  const toolFrame = renderWorkspace(ui, 120, 40, "", true, false, {
    color: true,
    colorDepth: 8,
  });
  const lines = toolFrame.split("\n");
  const rowContaining = (value: string) =>
    lines.find((line) => line.includes(value));
  for (const name of ["requested_tool", "complete_tool", "future_tool"]) {
    const toolHeader = rowContaining(name);
    assert.ok(toolHeader);
    assert.ok(toolHeader.includes("\x1b[1;38;5;117m"));
  }
  const errorHeader = rowContaining("error_tool");
  assert.ok(errorHeader?.includes("\x1b[38;5;203m"));
  assert.ok(
    rowContaining("Synthetic complete tool output.")?.includes(
      "\x1b[38;5;245m",
    ),
  );
  assert.ok(
    rowContaining("Synthetic error tool output.")?.includes("\x1b[38;5;203m"),
  );
  assert.ok(
    rowContaining("Synthetic unknown tool output.")?.includes(
      "\x1b[38;5;245m",
    ),
  );
  ui.choose("sessions");
  for (const [width, height] of [[80, 24], [120, 40], [200, 48]] as const) {
    const selectedRow = renderWorkspace(
      ui,
      width,
      height,
      "",
      false,
      false,
      { color: true, motion: false, colorDepth: 8 },
    )
      .split("\n")
      .find((line) => line.includes("▸ [-]"));
    assert.ok(
      selectedRow?.includes("\x1b[1;38;5;117;48;5;237m"),
      `${width} columns: selected session row uses NOMO blue and a soft selection wash`,
    );
    const monochromeSessions = renderWorkspace(
      ui,
      width,
      height,
      "",
      false,
      false,
      { color: false, motion: false },
    );
    assert.ok(monochromeSessions.includes("▸ [-]"));
    assert.doesNotMatch(monochromeSessions, /\x1b\[/);
  }
  ui.choose("models");
  const selectedModelRow = renderWorkspace(
    ui,
    120,
    40,
    "",
    false,
    false,
    { color: true, motion: false, colorDepth: 8 },
  )
    .split("\n")
    .find((line) => line.includes("▸ 1.") && line.includes("visual-model"));
  assert.ok(
    selectedModelRow?.includes("\x1b[1;38;5;117;48;5;237m"),
    "selected model row uses NOMO blue and a soft selection wash",
  );
});

test("detail titles and section headings keep the NOMO blue hierarchy", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "nomo-tui-detail-hierarchy-"));
  const app = new Workbench({ NOMO_DATA_DIR: root });
  t.after(async () => {
    await app.shutdown();
    await rm(root, { recursive: true, force: true });
  });
  const ui = new WorkspaceTui(app, { NOMO_DATA_DIR: root });
  ui.choose("documents");
  ui.detail = renderInspector(
    {
      title: "plan.md",
      subtitle: "session-123",
      icon: "▤",
      sections: [
        {
          title: "document",
          fields: [
            { label: "path", value: "plan.md" },
            { label: "size", value: "84 B" },
          ],
        },
      ],
    },
    { width: 76 },
  );

  for (const [width, height] of [
    [80, 24],
    [120, 40],
    [200, 48],
  ]) {
    const colorFrame = renderWorkspace(ui, width!, height!, "", false, false, {
      color: true,
      colorDepth: 8,
      motion: false,
    });
    const inspectorRows = colorFrame.split("\n");
    const paneRow = (text: string) =>
      inspectorRows.find(
        (line) =>
          line.includes(text),
      );
    assert.ok(
      paneRow("plan.md")?.includes("\x1b[1;38;5;117m"),
      `detail title uses NOMO blue at ${width} columns`,
    );
    assert.ok(
      paneRow("DOCUMENT")?.includes("\x1b[1;38;5;117m"),
      `section heading uses NOMO blue at ${width} columns`,
    );
    const fieldRow = paneRow("path");
    assert.ok(
      fieldRow?.includes("\x1b[1;38;5;245m"),
      `field label remains bold and muted at ${width} columns`,
    );
    assert.ok(
      fieldRow?.includes("\x1b[38;5;252m"),
      `field value remains readable at ${width} columns`,
    );
    assert.ok(
      colorFrame
        .split("\n")
        .every((line) => visibleLength(line) <= width!),
      `detail frame stays within ${width} columns`,
    );
    const monochromeFrame = renderWorkspace(
      ui,
      width!,
      height!,
      "",
      false,
      false,
      { color: false, motion: false },
    );
    assert.doesNotMatch(monochromeFrame, /\x1b\[/);
    assert.ok(monochromeFrame.includes("DOCUMENT"));
  }
});
test("standard-width detail keeps its content full width instead of splitting", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "nomo-tui-standard-detail-"));
  const app = new Workbench({ NOMO_DATA_DIR: root });
  t.after(async () => {
    await app.shutdown();
    await rm(root, { recursive: true, force: true });
  });
  const ui = new WorkspaceTui(app, { NOMO_DATA_DIR: root });
  ui.choose("documents");
  const revision = `revision: ${"a".repeat(70)}`;
  ui.detail = ["DOCUMENT", revision];

  const frame = stripAnsi(
    renderWorkspace(ui, 120, 40, "", false, false, {
      color: false,
      motion: false,
    }),
  );
  assert.ok(frame.split("\n").some((line) => line.includes(revision)));
  assert.ok(!frame.split("\n").some((line) => line.includes("│")));
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
  const streamed = chatRows(
    [
      { ...base, type: "message.delta", text: "partial" },
      { ...base, seq: 2, type: "message.completed", text: "complete" },
    ],
    40,
  );
  assert.ok(!streamed.some((r) => r.text.includes("partial")));
  assert.equal(streamed.filter((r) => r.text === "complete").length, 1);
  const writing = chatRows(
    [{ ...base, type: "message.delta", text: "partial" }],
    40,
    false,
    "⠋",
  );
  const nextFrame = chatRows(
    [{ ...base, type: "message.delta", text: "partial" }],
    40,
    false,
    "⠙",
  );
  assert.ok(writing.some((row) => row.text.includes("⠋")));
  assert.ok(nextFrame.some((row) => row.text.includes("⠙")));
  const thinking = chatRows([], 40, false, "⠋");
  assert.ok(thinking.some((row) => row.text.includes("NOMO thinking")));
  const fences = chatRows([{ ...base, text: "````ts\n```\nkept\n````" }], 40);
  assert.ok(fences.some((r) => r.style === "code" && r.text.includes("```")));
});

test("Markdown table rows keep escaped and code span pipes inside their cells", async () => {
  const { chatRows } = await import("./workspace.ts");
  const rows = chatRows(
    [
      {
        seq: 1,
        at: "2026-10-14T12:00:00Z",
        kind: "assistant",
        text: [
          "| Name | Note | Code |",
          "| --- | --- | --- |",
          "| left | literal \\| mark | `inside | mark` |",
          "| longer | more | tail |",
        ].join("\n"),
      },
    ],
    80,
  );
  const table = rows
    .filter((row) => row.style === "table")
    .map((row) => row.text);
  assert.deepEqual(table, [
    "Name   | Note           | Code         ",
    "left   | literal | mark | inside | mark",
    "longer | more           | tail         ",
  ]);
});

test("Markdown table rendering aligns cells and preserves delimiter alignment", async () => {
  const { chatRows } = await import("./workspace.ts");
  const rows = chatRows(
    [
      {
        seq: 1,
        at: "2026-10-14T12:00:00Z",
        kind: "assistant",
        text: [
          "| Name | State |",
          "| :--- | ---: |",
          "| run | unknown |",
          "| longer | done |",
          "| 界 | unknown |",
          "| 界界 | unknown |",
          "```text",
          "literal | code pipe",
          "```",
        ].join("\n"),
      },
    ],
    80,
  );
  assert.deepEqual(
    rows.filter((row) => row.style === "table").map((row) => row.text),
    [
      "Name   |   State",
      "run    | unknown",
      "longer |    done",
      "界     | unknown",
      "界界   | unknown",
    ],
  );
  assert.ok(
    rows.some(
      (row) => row.style === "code" && row.text.includes("literal | code pipe"),
    ),
  );
});

test("Markdown tables without outer pipes still align and drop their separator", async () => {
  const { chatRows } = await import("./workspace.ts");
  const rows = chatRows(
    [
      {
        seq: 1,
        at: "2026-10-14T12:00:00Z",
        kind: "assistant",
        text: [
          "Name | State",
          "--- | ---",
          "run | ready",
          "Normal prose follows.",
        ].join("\n"),
      },
    ],
    80,
  );
  assert.deepEqual(
    rows.filter((row) => row.style === "table").map((row) => row.text),
    ["Name | State", "run  | ready"],
  );
  assert.ok(
    rows.some(
      (row) => row.style === "text" && row.text === "Normal prose follows.",
    ),
  );
  const plain = chatRows(
    [
      {
        seq: 2,
        at: "2026-10-14T12:00:01Z",
        kind: "assistant",
        text: "Status | all 5 stages",
      },
    ],
    80,
  );
  assert.ok(
    plain.some(
      (row) => row.style === "text" && row.text === "Status | all 5 stages",
    ),
  );
});

test("assistant chat rows render common Markdown as inert readable text", () => {
  const at = "2026-09-14T10:00:00Z";
  const rows = chatRows(
    [
      {
        seq: 1,
        at,
        kind: "assistant",
        text: [
          "## Heading",
          "- **Bold** and `const x`",
          "> quoted text",
          "[manual](https://docs.example.test/start)",
          "| Name | State |",
          "| --- | --- |",
          "| Run | **unknown** |",
          "<script>alert(1)</script>",
          "[unsafe](javascript:alert(1))",
        ].join("\n"),
      },
    ],
    32,
  );
  assert.ok(
    rows.some((row) => row.style === "heading" && row.text === "Heading"),
  );
  assert.ok(
    rows.some(
      (row) => row.style === "list" && row.text === "• Bold and const x",
    ),
  );
  assert.ok(
    rows.some((row) => row.style === "quote" && row.text === "| quoted text"),
  );
  const readableLink = rows.map((row) => row.text).join("\n");
  assert.ok(readableLink.includes("manual"));
  assert.ok(readableLink.includes("https://docs.example.test/start"));
  assert.ok(
    rows.some(
      (row) => row.style === "table" && /Name\s+\| State/.test(row.text),
    ),
  );
  assert.ok(
    rows.some(
      (row) => row.style === "table" && /Run\s+\| unknown/.test(row.text),
    ),
  );
  assert.ok(!rows.some((row) => row.text.includes("---")));
  assert.ok(rows.some((row) => row.text === "<script>alert(1)</script>"));
  assert.ok(
    rows.some((row) => row.text.includes("unsafe (javascript:alert(1))")),
  );
  assert.ok(
    rows.every(
      (row) => !row.text.includes("\x1b") && visibleLength(row.text) <= 32,
    ),
  );
});

test("tool failures stay explicit when compact output hides successful details", () => {
  const at = "2026-10-14T12:00:00Z";
  const rows = chatRows(
    [
      {
        seq: 1,
        at,
        kind: "tool",
        type: "tool.started",
        text: "Requested write_file.",
        payload: { tool: "write_file", callId: "call-1" },
      },
      {
        seq: 2,
        at,
        kind: "tool",
        type: "tool.result",
        text: "write_file refused.\nline 2\nline 3\nline 4\nline 5",
        payload: {
          tool: "write_file",
          callId: "call-1",
          result: { isError: true },
        },
      },
    ],
    80,
    true,
  );
  assert.ok(rows.some((row) => row.text.includes("TOOL REQUEST")));
  assert.ok(
    rows.some(
      (row) => row.text.includes("TOOL ERROR") && row.style === "error",
    ),
  );
  assert.ok(rows.some((row) => row.text.includes("line 5")));
  assert.ok(rows.some((row) => row.text.includes("TOOL ERROR / write_file")));
  const unknown = chatRows(
    [
      {
        seq: 3,
        at,
        kind: "tool",
        type: "tool.custom.future",
        text: "Future event",
        payload: { tool: "future_tool" },
      },
    ],
    80,
  );
  assert.ok(
    unknown.some((row) => row.text.includes("TOOL UNKNOWN / future_tool")),
  );
  assert.ok(!rows.some((row) => row.text.includes("more lines /expand")));
});
test("harness review events retain their metadata identity in chat", () => {
  const at = "2026-10-23T23:09:01.000Z";
  const rows = chatRows(
    [
      {
        seq: 1,
        at,
        kind: "tool",
        type: "harness.review",
        text: "No trigger is armed and no review is retained.",
        payload: { outcome: "not-run" },
      },
      {
        seq: 2,
        at,
        kind: "tool",
        type: "harness.review.failed",
        text: "Harness review did not complete: local fixture failure.",
        payload: { status: "idle" },
      },
      {
        seq: 3,
        at,
        kind: "tool",
        type: "harness.review",
        text: "Harness review failed: provider rejected.",
        payload: { outcome: "failed" },
      },
    ],
    80,
  );
  const transcript = rows.map((row) => row.text).join("\n");
  assert.match(transcript, /HARNESS REVIEW/);
  assert.match(transcript, /No trigger is armed/);
  assert.match(transcript, /HARNESS REVIEW FAILED/);
  assert.match(transcript, /did not complete/);
  assert.equal((transcript.match(/HARNESS REVIEW FAILED/g) ?? []).length, 2);
  assert.ok(
    rows.some(
      (row) => row.text.includes("provider rejected") && row.style === "error",
    ),
  );
  assert.ok(
    rows.some(
      (row) => row.text.includes("HARNESS REVIEW FAILED") && row.style === "error",
    ),
  );
  assert.doesNotMatch(transcript, /TOOL UNKNOWN|TOOL RESULT/);
});
test("known Workbench metadata keeps its identity in chat", () => {
  const at = "2026-10-23T23:25:00.000Z";
  const rows = chatRows(
    [
      {
        seq: 1,
        at,
        kind: "tool",
        type: "hook.result",
        text: "format: hook exited 0",
        payload: { hook: { outcome: "exited", code: 0 } },
      },
      {
        seq: 2,
        at,
        kind: "tool",
        type: "context.compacted",
        text: "Context compacted.",
        payload: {
          beforeMessages: 12,
          afterMessages: 4,
          omittedMessages: 8,
        },
      },
    ],
    80,
  );
  const transcript = rows.map((row) => row.text).join("\n");
  assert.match(transcript, /HOOK RESULT/);
  assert.match(transcript, /format: hook exited 0/);
  assert.match(transcript, /CONTEXT COMPACTED/);
  assert.match(transcript, /Context compacted/);
  assert.doesNotMatch(transcript, /TOOL UNKNOWN|TOOL RESULT/);
});

test("chat Markdown keeps ordinary underscores and inline code literal", () => {
  const rows = chatRows(
    [
      {
        seq: 1,
        at: "2026-10-14T12:00:00Z",
        kind: "assistant",
        text: "foo_bar_baz some__thing__ **strong** *italic* _under_ ~~deleted~~ `code ** stays`",
      },
    ],
    80,
  );
  assert.ok(
    rows.some(
      (row) =>
        row.text ===
        "foo_bar_baz something strong italic under deleted code ** stays",
    ),
  );
  assert.ok(rows.every((row) => visibleLength(row.text) <= 80));
});

test("chat Markdown leaves links inside inline code untouched", () => {
  const rows = chatRows(
    [
      {
        seq: 1,
        at: "2026-10-14T12:00:00Z",
        kind: "assistant",
        text: "literal `[manual](https://example.test)`",
      },
    ],
    80,
  );
  assert.ok(
    rows.some((row) => row.text === "literal [manual](https://example.test)"),
  );
});

test("streaming Markdown stays readable before inline code closes", () => {
  const partial = `Open \`code **still literal** ${"界".repeat(40)}\x1b[2J\u202e`;
  const rows = chatRows(
    [
      {
        seq: 1,
        at: "2026-10-14T12:00:00Z",
        kind: "assistant",
        type: "message.delta",
        text: partial,
      },
    ],
    32,
  );
  const text = rows.map((row) => row.text).join("");
  assert.ok(text.includes("**still literal**"));
  assert.ok(text.includes("Open `code"));
  assert.ok(text.includes("?[2J?"));
  assert.ok(!text.includes("\u202e"));
  assert.ok(rows.every((row) => visibleLength(row.text) <= 32));
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
  assert.match(ui.notice, /dependency order has not been checked/i);
  assert.match(ui.notice, /press u for reviewed undo/i);
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
test("A2 narrow approval banner wraps complete decision hints", () => {
  const rows = approvalBannerLines(
    [
      {
        holdId: "visualfixture01",
        call: { tool: "fixture.workspace.delete", klass: "r2" },
      },
    ],
    80,
  );
  assert.ok(rows.length > 1);
  assert.ok(rows.every((row) => visibleLength(row) <= 80));
  const banner = rows.join(" ");
  for (const text of [
    "fixture.workspace.delete",
    "visualfi",
    "[a] approve",
    "[d] deny",
    "(/approvals)",
  ]) {
    assert.ok(banner.includes(text), text);
  }
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

test("A4 status distinguishes local TUI mode from server permission mode", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "nomo-tui-server-mode-"));
  const env = { NOMO_DATA_DIR: root, NOMO_PERMISSION_MODE: "read-only" };
  const app = new Workbench(env);
  t.after(async () => {
    await app.shutdown();
    await rm(root, { recursive: true, force: true });
  });
  const ui = new WorkspaceTui(app, env);
  ui.mode = "plan";
  assert.equal(app.permissionModeState(), "read-only");

  for (const [width, height] of [
    [20, 8],
    [40, 12],
    [80, 24],
    [160, 32],
  ]) {
    const status = stripAnsi(renderWorkspace(ui, width!, height!));
    if (width! < 56)
      assert.match(status, /server read-only/, `${width} columns`);
    else assert.match(status, /permission read-only \(server\)/, `${width} columns`);
    if (width! < 32) {
      assert.doesNotMatch(status, /mode: plan/);
    } else if (width! < 56) {
      assert.match(status, /mode: plan \(local\)/);
    } else {
      assert.match(status, /permission read-only \(server\)/);
      if (width! >= 100)
        assert.match(status, /mode: plan \(local only, not enforced\)/);
      else assert.match(status, /mode: plan \(not enforced\)/);
    }
  }

  ui.cycleMode();
  ui.cycleMode();
  assert.equal(ui.mode, "accept");
  assert.equal(app.permissionModeState(), "read-only");
  assert.match(
    stripAnsi(renderWorkspace(ui, 160, 32)),
    /permission read-only \(server\)/,
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
test("chat composer stays borderless like the Prime editor dock", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "nomo-tui-composer-dock-"));
  const app = new Workbench({ NOMO_DATA_DIR: root });
  t.after(async () => {
    await app.shutdown();
    await rm(root, { recursive: true, force: true });
  });
  const ui = new WorkspaceTui(app, { NOMO_DATA_DIR: root });
  await ui.initialize();
  ui.choose("chat");

  const frame = renderWorkspace(ui, 80, 24, "", true, false, {
    color: false,
    motion: false,
  });
  const rows = frame.split("\n");
  const prompt = rows.findIndex((row) => row.startsWith(" > "));
  assert.ok(prompt >= 0, "chat keeps its prompt");
  assert.ok(
    !rows.slice(prompt + 1, prompt + 3).some((row) => /^─+$/.test(row.trim())),
    "the editor dock has no heavy rule under the prompt",
  );
});

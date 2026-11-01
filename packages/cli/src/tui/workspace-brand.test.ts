import test from "node:test";
import assert from "node:assert/strict";
import * as brand from "./brand.ts";
import { brandHeader } from "./brand.ts";
import { visibleLength, stripAnsi } from "./layout.ts";
import type { TerminalCapabilities } from "./types.ts";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Workbench } from "../../../workbench/src/index.ts";
import { WorkspaceTui, renderWorkspace } from "./workspace.ts";

const colorCaps = (columns: number): TerminalCapabilities => ({
  columns,
  rows: 24,
  colorDepth: 24,
  ansi: true,
  reason: "interactive",
  interactive: true,
});

const graphicsCaps = (columns: number): TerminalCapabilities => ({
  ...colorCaps(columns),
  graphicsProtocol: "kitty",
});

const monoCaps = (columns: number): TerminalCapabilities => ({
  ...colorCaps(columns),
  colorDepth: 0,
});

test("the new OpenTUI logo asset is 9 columns by 5 rows with alpha transparency", () => {
  const bytes = readFileSync(new URL("./nomo-logo.png", import.meta.url));
  assert.deepEqual(
    [...bytes.subarray(0, 8)],
    [137, 80, 78, 71, 13, 10, 26, 10],
  );
  assert.equal(bytes.readUInt32BE(16), 320);
  assert.equal(bytes.readUInt32BE(20), 315);
  assert.equal(bytes[25], 6);
});

const tabIconKeys = [
  "overview",
  "chat",
  "sessions",
  "documents",
  "ledger",
  "approvals",
  "policy",
  "tools",
  "models",
  "usage",
  "help",
] as const;

const iconPng = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/3b8AAAAASUVORK5CYII=",
  "base64",
);

test("legacy snapshot keeps readable active panel context", async (t) => {
  const dataDirectory = mkdtempSync(join(tmpdir(), "nomo-tui-text-tabs-"));
  const env = { NOMO_DATA_DIR: dataDirectory };
  const app = new Workbench(env);
  t.after(async () => {
    await app.shutdown();
    rmSync(dataDirectory, { recursive: true, force: true });
  });
  const ui = new WorkspaceTui(app, env);
  await ui.initialize();
  const frame = stripAnsi(
    renderWorkspace(ui, 160, 24, "", false, false, { color: false }),
  );
  assert.match(frame, /NOMO \/ overview/);
  assert.match(frame, /Tab panels/);
});

test("a complete private tab icon pack renders as themed Kitty image cells", () => {
  const directory = mkdtempSync(join(tmpdir(), "nomo-tui-local-icons-"));
  try {
    for (const tab of tabIconKeys)
      for (const variant of ["dark", "light"])
        writeFileSync(join(directory, `${tab}.${variant}.png`), iconPng);

    const icons = brand.loadLocalTabIcons({ NOMO_TUI_ICONS_DIR: directory });
    assert.ok(icons);
    const transfer = brand.kittyTabIconsTransfer(icons);
    const transfers = [
      ...transfer.matchAll(/\x1b_Ga=T,f=100,i=(\d+),U=1,c=2,r=1,q=2,m=0;/g),
    ];
    assert.equal(transfers.length, 22);
    assert.equal(new Set(transfers.map((match) => match[1])).size, 22);

    for (const tab of tabIconKeys) {
      const dark = brand.kittyTabIconLabel(tab, icons, "default");
      const light = brand.kittyTabIconLabel(tab, icons, "paper");
      assert.equal(visibleLength(dark), 2);
      assert.equal(visibleLength(light), 2);
      assert.notEqual(dark, light);
      assert.doesNotMatch(dark, /\x1b_G/);
      assert.equal(dark.match(/\u{10eeee}/gu)?.length, 2);
    }

    const cleanup = brand.kittyTabIconsCleanup(icons);
    assert.equal(
      [...cleanup.matchAll(/\x1b_Ga=d,d=I,i=\d+,q=2\x1b\\/g)].length,
      22,
    );

    rmSync(join(directory, "help.light.png"));
    assert.equal(
      brand.loadLocalTabIcons({ NOMO_TUI_ICONS_DIR: directory }),
      undefined,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("Ghostty workspace tabs use the private Untitled UI icon pack", async (t) => {
  const dataDirectory = mkdtempSync(join(tmpdir(), "nomo-tui-icon-data-"));
  const iconDirectory = mkdtempSync(join(tmpdir(), "nomo-tui-icon-files-"));
  for (const tab of tabIconKeys)
    for (const variant of ["dark", "light"])
      writeFileSync(join(iconDirectory, `${tab}.${variant}.png`), iconPng);

  const env = {
    NOMO_DATA_DIR: dataDirectory,
    NOMO_TUI_ICONS_DIR: iconDirectory,
    TERM_PROGRAM: "ghostty",
    TERM: "xterm-ghostty",
  };
  const app = new Workbench(env);
  t.after(async () => {
    await app.shutdown();
    rmSync(dataDirectory, { recursive: true, force: true });
    rmSync(iconDirectory, { recursive: true, force: true });
  });
  const ui = new WorkspaceTui(app, env);
  await ui.initialize();
  assert.ok(
    ui.localTabIcons,
    "the configured private icon pack is loaded for the OpenTUI renderer",
  );
  const frame = stripAnsi(
    renderWorkspace(ui, 80, 24, "", false, false, {
      color: true,
      motion: false,
    }),
  );
  assert.match(frame, /overview/);
  assert.ok(visibleLength(frame.split("\n")[0] ?? "") <= 80);
});

test("local icons default to the active NOMO data directory", () => {
  const home = mkdtempSync(join(tmpdir(), "nomo-tui-icon-home-"));
  const directory = join(home, ".void", "tui", "icons");
  mkdirSync(directory, { recursive: true });
  try {
    for (const tab of tabIconKeys)
      for (const variant of ["dark", "light"])
        writeFileSync(join(directory, `${tab}.${variant}.png`), iconPng);
    assert.ok(brand.loadLocalTabIcons({ HOME: home }));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

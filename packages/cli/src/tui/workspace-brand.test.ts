import test from "node:test";
import assert from "node:assert/strict";
import * as brand from "./brand.ts";
import { brandHeader } from "./brand.ts";
import { visibleLength, stripAnsi } from "./layout.ts";
import type { TerminalCapabilities } from "./types.ts";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
  // Chat is the only base screen now: its header carries the identity and the
  // panel dock carries the context, so there is no overview to name.
  assert.match(frame, /NOMO {2}Chat/);
  assert.match(frame, /NEW CONVERSATION/);
  assert.match(frame, /← Sessions/);
  assert.doesNotMatch(frame, /NOMO \/ overview/);
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
    // A Kitty transfer is one header per image; a PNG larger than one 4096
    // byte chunk only completes on its last chunk, so the count of complete
    // single-chunk transfers is smaller than the number of images.
    const transfers = [
      ...transfer.matchAll(/\x1b_Ga=T,f=100,i=(\d+),U=1,c=2,r=1,q=2,m=0;/g),
    ];
    assert.equal(transfers.length, 38);
    assert.equal(new Set(transfers.map((match) => match[1])).size, 38);

    // Every tab icon in both variants plus every bundled semantic icon is
    // transferred exactly once: 2 x 11 tab icons + 2 x 16 semantic icons.
    const images = [
      ...transfer.matchAll(/\x1b_Ga=T,f=100,i=(\d+),U=1,c=2,r=1,q=2,m=[01];/g),
    ];
    assert.equal(images.length, 54);
    assert.equal(new Set(images.map((match) => match[1])).size, 54);

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
      54,
    );

    rmSync(join(directory, "help.light.png"));
    // An incomplete local pack must not blank the icon system: the shipped
    // Iconoir pack takes over rather than leaving the tabs with no artwork.
    const fallback = brand.loadLocalTabIcons({ NOMO_TUI_ICONS_DIR: directory });
    assert.ok(fallback, "an incomplete local pack still yields icons");
    assert.ok(
      !fallback.dark.chat.png.equals(iconPng),
      "the bundled artwork replaced the incomplete local pack",
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("Ghostty workspace tabs use local Iconoir artwork with text fallbacks", async (t) => {
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
  // WorkspaceTui decides whether to load the icon pack from
  // detectCapabilities, which reads process.stdout. The test runner pipes
  // stdout, so declare a TTY for this test only and restore it afterwards.
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
    "the configured private icon pack is loaded for the interactive renderer",
  );
  // The tabs only exist outside Chat, so open a panel before checking that the
  // bundled artwork reaches the header next to its text label.
  ui.choose("sessions");
  const frame = stripAnsi(
    renderWorkspace(ui, 80, 24, "", false, false, {
      color: true,
      motion: false,
    }),
  );
  const artwork = stripAnsi(
    brand.kittyTabIconLabel("sessions", ui.localTabIcons, ui.themeConfig.colorTheme),
  );
  assert.ok(visibleLength(artwork) === 2, "the local icon is two cells wide");
  assert.ok(
    frame.includes(artwork),
    "the local sessions artwork renders in the tab header",
  );
  assert.match(frame, /Sessions/, "the text label stays beside the artwork");
  assert.match(frame, /← Chat/, "the panel keeps its text fallback navigation");
  assert.ok(visibleLength(frame.split("\n")[0] ?? "") <= 80);
  assert.ok(
    frame.split("\n").every((line) => visibleLength(line) <= 80),
    "the artwork never pushes a row past the terminal width",
  );
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

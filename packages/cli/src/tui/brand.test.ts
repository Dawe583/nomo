import test from "node:test";
import assert from "node:assert/strict";
import { brandHeader, loadLocalTabIcons } from "./brand.ts";
import type { TerminalCapabilities } from "./types.ts";

const caps: TerminalCapabilities = {
  columns: 100,
  rows: 32,
  colorDepth: 24,
  ansi: true,
  reason: "interactive",
  interactive: true,
};

test("brand header renders the supplied grid mark and workspace label", () => {
  const rows = brandHeader("NOMO / local workspace", caps);
  assert.equal(rows.length, 6);
  assert.ok(rows[0]!.includes("██ ██ ██ ██ ██ ██"));
  assert.ok(rows[1]!.includes("█████"));
  assert.ok(rows[2]!.includes("NOMO / local workspace"));
  assert.ok(rows[4]!.includes("38;2;0;169;189"));
});

test("loads the bundled Iconoir tabs and semantic indicators", () => {
  const icons = loadLocalTabIcons({
    HOME: "/nomo-test-no-home",
    NOMO_TUI_ICONS_DIR: "/nomo-test-no-overrides",
  });

  assert.ok(icons);
  assert.equal(Object.keys(icons.dark).length, 11);
  assert.equal(Object.keys(icons.light).length, 11);
  assert.equal(Object.keys(icons.semantic?.dark ?? {}).length, 16);
  assert.equal(Object.keys(icons.semantic?.light ?? {}).length, 16);
});

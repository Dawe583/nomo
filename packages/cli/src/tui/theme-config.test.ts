import test from "node:test";
import assert from "node:assert/strict";
import { resolveThemeConfig } from "./theme-config.ts";
import { COLOR_THEMES } from "./theme-config.ts";

test("theme config reads the env names the TUI tells the operator to set", () => {
  const resolved = resolveThemeConfig({
    NOMO_TUI_THEME: "solarized-dark",
    NOMO_TUI_SYMBOLS: "ascii",
  });
  assert.equal(resolved.colorTheme, "solarized-dark");
  assert.equal(resolved.symbolPreset, "ascii");
});

test("theme config is case insensitive and ignores unknown values", () => {
  assert.equal(resolveThemeConfig({ NOMO_TUI_THEME: "High-Contrast" }).colorTheme, "high-contrast");
  assert.equal(resolveThemeConfig({ NOMO_TUI_SYMBOLS: "CLASSIC" }).symbolPreset, "classic");
  assert.deepEqual(resolveThemeConfig({ NOMO_TUI_THEME: "neon", NOMO_TUI_SYMBOLS: "wingdings" }), {
    colorTheme: "default",
    symbolPreset: "unicode",
  });
  assert.deepEqual(resolveThemeConfig({}), { colorTheme: "default", symbolPreset: "unicode" });
});

test("theme config no longer honours the pre-rename variable names", () => {
  const resolved = resolveThemeConfig({
    VOID_TUI_THEME: "solarized-dark",
    VOID_TUI_SYMBOLS: "ascii",
  } as NodeJS.ProcessEnv);
  assert.deepEqual(resolved, { colorTheme: "default", symbolPreset: "unicode" });
});

test("the default palette keeps the canvas transparent and user bubbles local", () => {
  assert.equal(COLOR_THEMES.default.fg, "#ffffff");
  assert.equal(COLOR_THEMES.default.accent, "#fa6b5d");
  assert.equal(COLOR_THEMES.default.info, "#16b8c8");
  assert.equal(COLOR_THEMES.default.userBubble, "#263443");
  for (const [name, palette] of Object.entries(COLOR_THEMES)) {
    assert.match(palette.userBubble, /^#[\da-f]{6}$/i, `${name} bubble surface`);
    assert.ok(!("bg" in palette), `${name} must not define a canvas background`);
  }
});
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

test("every NOMO color theme keeps a blue brand accent", () => {
  for (const [name, palette] of Object.entries(COLOR_THEMES)) {
    const [red, green, blue] = palette.accent
      .slice(1)
      .match(/../g)!
      .map((channel) => Number.parseInt(channel, 16));
    assert.ok(
      blue > red && blue >= green,
      `${name} accent ${palette.accent} is not blue`,
    );
  }
});
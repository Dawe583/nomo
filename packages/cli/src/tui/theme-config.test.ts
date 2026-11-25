import test from "node:test";
import assert from "node:assert/strict";
import { COLOR_THEMES, resolveThemeConfig } from "./theme-config.ts";

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
test("every text token in every theme keeps WCAG contrast against its background", () => {
  const channel = (hex: string, index: number) =>
    parseInt(hex.slice(1 + index * 2, 3 + index * 2), 16) / 255;
  const luminance = (hex: string) => {
    const [red, green, blue] = [0, 1, 2].map((index) => {
      const value = channel(hex, index);
      return value <= 0.04045
        ? value / 12.92
        : ((value + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
  };
  const contrast = (left: string, right: string) => {
    const a = luminance(left);
    const b = luminance(right);
    return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
  };
  const failures: string[] = [];
  for (const [theme, palette] of Object.entries(COLOR_THEMES)) {
    for (const [token, color] of Object.entries(palette)) {
      // Border and rule are separators, never text. Meaningful words use the
      // remaining tones, so every one must pass normal-text contrast.
      if (token === "bg" || token === "border" || token === "rule") continue;
      const ratio = contrast(color, palette.bg);
      if (ratio < 4.5)
        failures.push(`${theme}:${token} ${ratio.toFixed(2)}:1`);
    }
  }
  assert.deepEqual(failures, []);
});

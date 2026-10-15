import type {
  CallDecision,
  ReversibilityClass,
  TerminalCapabilities,
} from "./types.ts";
import {
  COLOR_THEMES,
  SYMBOL_SETS,
  type ColorPalette,
  type ColorTheme,
  type SymbolSet,
  type SymbolPreset,
  type ThemeConfig,
  ansi16,
  ansi256,
  getColorPalette,
  getSymbolSet,
  paintWithPalette,
  resolveThemeConfig,
  trueColor,
} from "./theme-config.ts";
export {
  COLOR_THEMES,
  SYMBOL_SETS,
  type ColorTheme,
  type SymbolPreset,
} from "./theme-config.ts";
export type { ThemeConfig } from "./theme-config.ts";

export type Tone = keyof ColorPalette;

export const NOMO_PALETTE = COLOR_THEMES.default;

export const CLASS_MARKER: Record<ReversibilityClass, string> = {
  r0: "[0]",
  r1: "[1]",
  r2: "[2]",
  r3: "[3]",
};

export const DECISION_MARKER: Record<CallDecision, string> = {
  allow: "+",
  hold: "!",
  deny: "x",
};

const ANSI_16: Record<Tone, number> = (() => {
  const map: Record<Tone, number> = {} as Record<Tone, number>;
  for (const tone of Object.keys(NOMO_PALETTE) as Tone[]) {
    map[tone] = ansi16(NOMO_PALETTE[tone]);
  }
  return map;
})();

const ANSI_256: Record<Tone, number> = (() => {
  const map: Record<Tone, number> = {} as Record<Tone, number>;
  for (const tone of Object.keys(NOMO_PALETTE) as Tone[]) {
    map[tone] = ansi256(NOMO_PALETTE[tone]);
  }
  return map;
})();

export function paint(
  text: string,
  tone: Tone,
  capabilities: TerminalCapabilities,
  bold = false,
): string {
  return paintWithPalette(text, tone, NOMO_PALETTE, capabilities, bold);
}

export function classLabel(
  value: ReversibilityClass,
  capabilities: TerminalCapabilities,
): string {
  return paint(
    `${CLASS_MARKER[value]} ${value.toUpperCase()}`,
    value,
    capabilities,
    true,
  );
}

export function decisionLabel(
  value: CallDecision,
  capabilities: TerminalCapabilities,
): string {
  const tone: Tone = value === "allow" ? "r0" : value === "hold" ? "r2" : "r3";
  return paint(
    `[${DECISION_MARKER[value]}] ${value}`,
    tone,
    capabilities,
    true,
  );
}

export function getThemeConfig(env?: Readonly<NodeJS.ProcessEnv>): ThemeConfig {
  return resolveThemeConfig(env);
}

export function getSymbols(preset?: SymbolPreset): SymbolSet {
  return getSymbolSet(preset ?? "unicode");
}

export function getPalette(theme?: ColorTheme): ColorPalette {
  return getColorPalette(theme ?? "default");
}

export function paintThemed(
  text: string,
  tone: Tone,
  capabilities: TerminalCapabilities,
  config?: ThemeConfig,
  bold = false,
): string {
  const palette = config ? getPalette(config.colorTheme) : NOMO_PALETTE;
  return paintWithPalette(text, tone, palette, capabilities, bold);
}
export { paintWithPalette } from "./theme-config.ts";

import type { TerminalCapabilities } from "./types.ts";

export type SymbolPreset = "ascii" | "unicode" | "classic";

export type ColorTheme =
  | "default"
  | "paper"
  | "dark"
  | "high-contrast"
  | "solarized-light"
  | "solarized-dark";

export interface SymbolSet {
  readonly tab: Record<string, string>;
  readonly mode: Record<string, string>;
  readonly status: Record<string, string>;
  readonly spinner: readonly string[];
  readonly progress: { filled: string; empty: string };
  readonly frame: {
    tl: string;
    tr: string;
    bl: string;
    br: string;
    h: string;
    v: string;
    teeL: string;
    teeR: string;
    teeT: string;
    teeB: string;
    cross: string;
  };
  readonly brand: {
    halfTop: string;
    halfBottom: string;
    full: string;
    empty: string;
  };
  readonly check: { on: string; off: string };
  readonly arrow: { up: string; down: string; left: string; right: string };
  readonly separator: { vertical: string; horizontal: string; dot: string };
}

export interface ColorPalette {
  readonly fg: string;
  readonly accent: string;
  readonly muted: string;
  readonly border: string;
  readonly success: string;
  readonly warning: string;
  readonly error: string;
  readonly info: string;
  readonly r0: string;
  readonly r1: string;
  readonly r2: string;
  readonly r3: string;
  readonly ink: string;
  readonly rule: string;
  readonly userBubble: string;
}

export const SYMBOL_SETS: Record<SymbolPreset, SymbolSet> = {
  ascii: {
    tab: {
      overview: "[O]",
      chat: "[C]",
      sessions: "[S]",
      documents: "[D]",
      ledger: "[L]",
      approvals: "[A]",
      policy: "[P]",
      tools: "[T]",
      models: "[M]",
      usage: "[U]",
      help: "[?]",
    },
    mode: { normal: "[N]", accept: "[A]", plan: "[P]" },
    status: {
      running: "[*]",
      idle: "[ ]",
      queued: "[Q]",
      paused: "[|]",
      unknown: "[?]",
    },
    spinner: ["|", "/", "-", "\\"],
    progress: { filled: "#", empty: "-" },
    frame: {
      tl: "+",
      tr: "+",
      bl: "+",
      br: "+",
      h: "-",
      v: "|",
      teeL: "+",
      teeR: "+",
      teeT: "+",
      teeB: "+",
      cross: "+",
    },
    brand: { halfTop: "'", halfBottom: ",", full: "#", empty: " " },
    check: { on: "[x]", off: "[ ]" },
    arrow: { up: "^", down: "v", left: "<", right: ">" },
    separator: { vertical: "|", horizontal: "-", dot: "." },
  },
  unicode: {
    tab: {
      overview: "◈",
      chat: "●",
      sessions: "≡",
      documents: "▤",
      ledger: "▪",
      approvals: "◉",
      policy: "§",
      tools: "+",
      models: "◐",
      usage: "◔",
      help: "?",
    },
    mode: { normal: "◆", accept: "●", plan: "○" },
    status: { running: "●", idle: "○", queued: "◐", paused: "▐", unknown: "?" },
    spinner: ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"],
    progress: { filled: "█", empty: "░" },
    frame: {
      tl: "╭",
      tr: "╮",
      bl: "╰",
      br: "╯",
      h: "─",
      v: "│",
      teeL: "├",
      teeR: "┤",
      teeT: "┬",
      teeB: "┴",
      cross: "┼",
    },
    brand: { halfTop: "▀", halfBottom: "▄", full: "█", empty: " " },
    check: { on: "✓", off: "□" },
    arrow: { up: "▲", down: "▼", left: "◀", right: "▶" },
    separator: { vertical: "│", horizontal: "─", dot: "·" },
  },
  classic: {
    tab: {
      overview: "◆",
      chat: "◇",
      sessions: "≡",
      documents: "▣",
      ledger: "■",
      approvals: "◆",
      policy: "§",
      tools: "+",
      models: "◇",
      usage: "◆",
      help: "?",
    },
    mode: { normal: "▪", accept: "▫", plan: "◇" },
    status: { running: "▪", idle: "▫", queued: "▪", paused: "▐", unknown: "?" },
    spinner: ["⠁", "⠂", "⠄", "⡀", "⢀", "⠠", "⠐", "⠈"],
    progress: { filled: "■", empty: "□" },
    frame: {
      tl: "┌",
      tr: "┐",
      bl: "└",
      br: "┘",
      h: "─",
      v: "│",
      teeL: "├",
      teeR: "┤",
      teeT: "┬",
      teeB: "┴",
      cross: "┼",
    },
    brand: { halfTop: "▀", halfBottom: "▄", full: "█", empty: " " },
    check: { on: "+", off: "-" },
    arrow: { up: "^", down: "v", left: "<", right: ">" },
    separator: { vertical: "|", horizontal: "-", dot: ":" },
  },
};

export const COLOR_THEMES: Record<ColorTheme, ColorPalette> = {
  default: {
    fg: "#ffffff",
    accent: "#fa6b5d",
    muted: "#a2adba",
    border: "#4b596c",
    success: "#50c99b",
    warning: "#f4b55f",
    error: "#f16470",
    info: "#16b8c8",
    r0: "#50c99b",
    r1: "#16b8c8",
    r2: "#f4b55f",
    r3: "#f16470",
    ink: "#ffffff",
    rule: "#536176",
    userBubble: "#263443",
  },
  paper: {
    fg: "#12100a",
    accent: "#005fcc",
    muted: "#8b7d6b",
    border: "#d4c4a8",
    success: "#3d8b3d",
    warning: "#b8860b",
    error: "#c0392b",
    info: "#2980b9",
    r0: "#3d8b3d",
    r1: "#2980b9",
    r2: "#b8860b",
    r3: "#c0392b",
    ink: "#1d1d1f",
    rule: "#d4c4a8",
    userBubble: "#e4d9c7",
  },
  dark: {
    fg: "#ffffff",
    accent: "#55c3ff",
    muted: "#888888",
    border: "#333333",
    success: "#00ff00",
    warning: "#ffff00",
    error: "#ff0000",
    info: "#00ffff",
    r0: "#00ff00",
    r1: "#00ffff",
    r2: "#ffff00",
    r3: "#ff0000",
    ink: "#ffffff",
    rule: "#333333",
    userBubble: "#202020",
  },
  "high-contrast": {
    fg: "#ffffff",
    accent: "#55c3ff",
    muted: "#aaaaaa",
    border: "#ffffff",
    success: "#00ff00",
    warning: "#ffff00",
    error: "#ff0000",
    info: "#00ffff",
    r0: "#00ff00",
    r1: "#00ffff",
    r2: "#ffff00",
    r3: "#ff0000",
    ink: "#ffffff",
    rule: "#ffffff",
    userBubble: "#000000",
  },
  "solarized-light": {
    fg: "#657b83",
    accent: "#0066b3",
    muted: "#93a1a1",
    border: "#eee8d5",
    success: "#859900",
    warning: "#b58900",
    error: "#dc322f",
    info: "#268bd2",
    r0: "#859900",
    r1: "#268bd2",
    r2: "#b58900",
    r3: "#dc322f",
    ink: "#657b83",
    rule: "#eee8d5",
    userBubble: "#fdf6e3",
  },
  "solarized-dark": {
    fg: "#839496",
    accent: "#55c3ff",
    muted: "#586e75",
    border: "#073642",
    success: "#859900",
    warning: "#b58900",
    error: "#dc322f",
    info: "#268bd2",
    r0: "#859900",
    r1: "#268bd2",
    r2: "#b58900",
    r3: "#dc322f",
    ink: "#839496",
    rule: "#073642",
    userBubble: "#073642",
  },
};

export type ThemeName = ColorTheme | SymbolPreset;

export interface ThemeConfig {
  colorTheme: ColorTheme;
  symbolPreset: SymbolPreset;
}

export function resolveThemeConfig(
  env: Readonly<NodeJS.ProcessEnv> = process.env,
): ThemeConfig {
  const colorEnv = env.NOMO_TUI_THEME?.toLowerCase();
  const symbolEnv = env.NOMO_TUI_SYMBOLS?.toLowerCase();

  const colorTheme: ColorTheme =
    colorEnv && colorEnv in COLOR_THEMES ? (colorEnv as ColorTheme) : "default";
  const symbolPreset: SymbolPreset =
    symbolEnv && symbolEnv in SYMBOL_SETS
      ? (symbolEnv as SymbolPreset)
      : "unicode";

  return { colorTheme, symbolPreset };
}

export function getSymbolSet(preset: SymbolPreset): SymbolSet {
  return SYMBOL_SETS[preset];
}

export function getColorPalette(theme: ColorTheme): ColorPalette {
  return COLOR_THEMES[theme];
}

export function trueColor(hex: string): string {
  const value = Number.parseInt(hex.slice(1), 16);
  return `38;2;${(value >> 16) & 255};${(value >> 8) & 255};${value & 255}`;
}

export function ansi256(hex: string): number {
  const r = Number.parseInt(hex.slice(1, 3), 16);
  const g = Number.parseInt(hex.slice(3, 5), 16);
  const b = Number.parseInt(hex.slice(5, 7), 16);
  return (
    16 +
    36 * Math.round((r / 255) * 5) +
    6 * Math.round((g / 255) * 5) +
    Math.round((b / 255) * 5)
  );
}

export function ansi16(hex: string): number {
  const r = Number.parseInt(hex.slice(1, 3), 16);
  const g = Number.parseInt(hex.slice(3, 5), 16);
  const b = Number.parseInt(hex.slice(5, 7), 16);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const delta = max - min;

  if (delta < 24) {
    const gray = Math.round(0.299 * r + 0.587 * g + 0.114 * b);
    if (gray > 200) return 97;
    if (gray > 150) return 37;
    if (gray > 100) return 90;
    return 30;
  }

  let hue =
    max === r
      ? (g - b) / delta + (g < b ? 6 : 0)
      : max === g
        ? (b - r) / delta + 2
        : (r - g) / delta + 4;
  hue *= 60;
  const bright = max >= 160;
  if (hue < 30 || hue >= 330) return bright ? 91 : 31;
  if (hue < 90) return bright ? 93 : 33;
  if (hue < 150) return bright ? 92 : 32;
  if (hue < 210) return bright ? 96 : 36;
  if (hue < 270) return bright ? 94 : 34;
  return bright ? 95 : 35;
}

export function paintWithPalette(
  text: string,
  tone: keyof ColorPalette,
  palette: ColorPalette,
  capabilities: TerminalCapabilities,
  bold = false,
): string {
  if (!capabilities.ansi || capabilities.colorDepth === 0) return text;
  const hex = palette[tone];
  const color =
    capabilities.colorDepth === 24
      ? trueColor(hex)
      : capabilities.colorDepth === 8
        ? `38;5;${ansi256(hex)}`
        : String(ansi16(hex));
  return `\u001b[${bold ? "1;" : ""}${color}m${text}\u001b[0m`;
}

export function getStatusLineSegments(
  config: ThemeConfig,
  caps: TerminalCapabilities,
) {
  const palette = getColorPalette(config.colorTheme);
  const symbols = getSymbolSet(config.symbolPreset);
  return {
    palette,
    symbols,
    paint: (text: string, tone: keyof ColorPalette, bold = false) =>
      paintWithPalette(text, tone, palette, caps, bold),
  };
}

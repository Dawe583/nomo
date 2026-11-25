import type { TerminalCapabilities } from "./types.ts";

export type SymbolPreset = "ascii" | "unicode" | "classic" | "nerd";

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
  readonly role: {
    readonly user: string;
    readonly assistant: string;
    readonly tool: string;
    readonly error: string;
    readonly system: string;
    readonly usage: string;
    readonly thinking: string;
  };
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
  readonly icons: SemanticIcons;
}

/** Meaningful icon labels shared by screen chrome and settings. */
export interface SemanticIcons {
  readonly settings: string;
  readonly appearance: string;
  readonly composer: string;
  readonly context: string;
  readonly tokens: string;
  readonly provider: string;
  readonly model: string;
  readonly search: string;
  readonly filter: string;
  readonly session: string;
  readonly document: string;
  readonly ledger: string;
  readonly approval: string;
  readonly policy: string;
  readonly tool: string;
  readonly usage: string;
  readonly help: string;
  readonly agent: string;
  readonly heartbeat: string;
  readonly shell: string;
  readonly queue: string;
  readonly network: string;
  readonly key: string;
  readonly time: string;
  readonly retry: string;
  readonly run: string;
  readonly hook: string;
  readonly refinement: string;
}

export interface ColorPalette {
  readonly bg: string;
  readonly fg: string;
  readonly user: string;
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
}

const ASCII_ICONS: SemanticIcons = {
  settings: "[S]",
  appearance: "[A]",
  composer: ">",
  context: "[C]",
  tokens: "[#]",
  provider: "[P]",
  model: "[M]",
  search: "[/]",
  filter: "[F]",
  session: "[H]",
  document: "[D]",
  ledger: "[L]",
  approval: "[!]",
  policy: "[P]",
  tool: "[T]",
  usage: "[%]",
  help: "[?]",
  agent: "[A]",
  heartbeat: "[~]",
  shell: "[$]",
  queue: "[Q]",
  network: "[N]",
  key: "[K]",
  time: "[T]",
  retry: "[R]",
  run: ">",
  hook: "[H]",
  refinement: "[*]",
};

const UNICODE_ICONS: SemanticIcons = {
  settings: "⚙",
  appearance: "◐",
  composer: "›",
  context: "▤",
  tokens: "#",
  provider: "◈",
  model: "◐",
  search: "⌕",
  filter: "▽",
  session: "◷",
  document: "▤",
  ledger: "▥",
  approval: "◉",
  policy: "§",
  tool: "⚒",
  usage: "◔",
  help: "?",
  agent: "◆",
  heartbeat: "♥",
  shell: ">_",
  queue: "≡",
  network: "↔",
  key: "⌘",
  time: "◷",
  retry: "↻",
  run: "▶",
  hook: "⟲",
  refinement: "✧",
};

// Codicons code points are taken from Nerd Fonts 3.5.1 glyphnames.json.
// Nerd Font glyphs require a compatible patched terminal font. Keep the
// ordinary Unicode and ASCII sets available for terminals without one.
const NERD_ICONS: SemanticIcons = {
  settings: "\u{eb52}",
  appearance: "\u{eac6}",
  composer: "\u{ea73}",
  context: "\u{ebaf}",
  tokens: "\u{ea90}",
  provider: "\u{ebaa}",
  model: "\u{ec19}",
  search: "\u{ea6d}",
  filter: "\u{eaf1}",
  session: "\u{ec75}",
  document: "\u{ec5e}",
  ledger: "\u{eaa4}",
  approval: "\u{eb53}",
  policy: "\u{ea75}",
  tool: "\u{eb6d}",
  usage: "\u{ebe4}",
  help: "\u{eb32}",
  agent: "\u{ec67}",
  heartbeat: "\u{eb31}",
  shell: "\u{ea85}",
  queue: "\u{eb16}",
  network: "\u{ea68}",
  key: "\u{eb11}",
  time: "\u{ec75}",
  retry: "\u{ea77}",
  run: "\u{eb2c}",
  hook: "\u{ea79}",
  refinement: "\u{ec1f}",
};

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
    role: {
      user: ">",
      assistant: "=",
      tool: "*",
      error: "x",
      system: "!",
      usage: "+",
      thinking: "~",
    },
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
    icons: ASCII_ICONS,
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
    role: {
      user: "▸",
      assistant: "●",
      tool: "◆",
      error: "×",
      system: "≡",
      usage: "▰",
      thinking: "○",
    },
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
    icons: UNICODE_ICONS,
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
    role: {
      user: "›",
      assistant: "●",
      tool: "◆",
      error: "×",
      system: "≡",
      usage: "▰",
      thinking: "○",
    },
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
    icons: UNICODE_ICONS,
  },
  nerd: {
    tab: {
      overview: "\u{eb06}",
      chat: "\u{ea6b}",
      sessions: "\u{ec75}",
      documents: "\u{ec5e}",
      ledger: "\u{eaa4}",
      approvals: "\u{eb53}",
      policy: "\u{ea75}",
      tools: "\u{eb6d}",
      models: "\u{ec19}",
      usage: "\u{ebe4}",
      help: "\u{eb32}",
    },
    mode: { normal: "\u{ea85}", accept: "\u{eab2}", plan: "\u{ebaf}" },
    status: {
      running: "\u{eb31}",
      idle: "\u{ec07}",
      queued: "\u{eb16}",
      paused: "\u{ead1}",
      unknown: "\u{eb32}",
    },
    spinner: ["\u{eb19}", "\u{ea77}", "\u{eb31}", "\u{eb19}"],
    progress: { filled: "█", empty: "░" },
    role: {
      user: "\u{eb99}",
      assistant: "\u{ec1e}",
      tool: "\u{eb6d}",
      error: "\u{ea87}",
      system: "\u{eb52}",
      usage: "\u{ebe4}",
      thinking: "\u{ec1f}",
    },
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
    check: { on: "\u{eab2}", off: "\u{ec07}" },
    arrow: {
      up: "\u{eaa1}",
      down: "\u{ea9a}",
      left: "\u{ea9b}",
      right: "\u{ea9c}",
    },
    separator: { vertical: "│", horizontal: "─", dot: "·" },
    icons: NERD_ICONS,
  },
};

export const COLOR_THEMES: Record<ColorTheme, ColorPalette> = {
  default: {
    bg: "#0d0d0f",
    fg: "#e8e8eb",
    user: "#f5f5f7",
    accent: "#cf6b3e",
    muted: "#a0a0a5",
    border: "#3a3a3f",
    rule: "#48484e",
    success: "#5cc094",
    warning: "#dcbc63",
    error: "#f47a88",
    info: "#2997ff",
    r0: "#5cc094",
    r1: "#2997ff",
    r2: "#dcbc63",
    r3: "#f47a88",
    ink: "#f5f5f7",
  },
  paper: {
    bg: "#f6f0e3",
    fg: "#12100a",
    user: "#12100a",
    accent: "#bd4206",
    muted: "#786c5c",
    border: "#d4c4a8",
    success: "#367c36",
    warning: "#8e6708",
    error: "#c0392b",
    info: "#2573a7",
    r0: "#367c36",
    r1: "#2573a7",
    r2: "#8e6708",
    r3: "#c0392b",
    ink: "#1d1d1f",
    rule: "#d4c4a8",
  },
  dark: {
    bg: "#000000",
    fg: "#ffffff",
    user: "#ffffff",
    accent: "#ff6b00",
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
  },
  "high-contrast": {
    bg: "#000000",
    fg: "#ffffff",
    user: "#ffffff",
    accent: "#ffff00",
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
  },
  "solarized-light": {
    bg: "#fdf6e3",
    fg: "#5f747b",
    user: "#4d6269",
    accent: "#c34815",
    muted: "#687272",
    border: "#eee8d5",
    success: "#687700",
    warning: "#8f6c00",
    error: "#d5312e",
    info: "#2076b3",
    r0: "#687700",
    r1: "#2076b3",
    r2: "#8f6c00",
    r3: "#d5312e",
    ink: "#5f747b",
    rule: "#eee8d5",
  },
  "solarized-dark": {
    bg: "#002b36",
    fg: "#839496",
    user: "#eee8d5",
    accent: "#d67147",
    muted: "#809196",
    border: "#073642",
    success: "#859900",
    warning: "#b58900",
    error: "#e56563",
    info: "#3794d6",
    r0: "#859900",
    r1: "#3794d6",
    r2: "#b58900",
    r3: "#e56563",
    ink: "#839496",
    rule: "#073642",
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
  const gray = Math.round(0.299 * r + 0.587 * g + 0.114 * b);
  if (gray > 200) return 97;
  if (gray > 150) return 37;
  if (gray > 100) return 90;
  if (gray > 50) return 30;
  return 30;
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

/** Keep role tint inside message rows so the user's terminal canvas stays untouched. */
export function paintUserMessageWithPalette(
  text: string,
  palette: ColorPalette,
  capabilities: TerminalCapabilities,
): string {
  if (!capabilities.ansi || capabilities.colorDepth === 0) return text;
  const foreground =
    capabilities.colorDepth === 24
      ? trueColor(palette.user)
      : capabilities.colorDepth === 8
        ? `38;5;${ansi256(palette.user)}`
        : String(ansi16(palette.user));
  // The role marker and foreground tint highlight user turns without painting
  // a background over the terminal canvas.
  return `\u001b[${foreground}m${text}\u001b[39m`;
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

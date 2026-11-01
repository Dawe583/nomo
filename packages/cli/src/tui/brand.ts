import { readFileSync } from "node:fs";
import { fit, sanitizeText, visibleLength } from "./layout.ts";
import { paint } from "./theme.ts";
import type { TerminalCapabilities } from "./types.ts";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { dataDir } from "../../../ledger/src/paths.ts";
import type { ColorTheme } from "./theme-config.ts";

const MARK_COLS = 13;
const MARK_ROWS = 7;
const MARK_HALF_ROWS = MARK_ROWS * 2;

const LAST_COL = MARK_COLS - 1;
const LAST_HALF_ROW = MARK_HALF_ROWS - 1;
/** Inset of the inner rule, in cells, from the outer rule. */
const INNER_INSET = 2;
const INNER_LOW_COL = INNER_INSET;
const INNER_HIGH_COL = LAST_COL - INNER_INSET;
const INNER_LOW_ROW = INNER_INSET * 2;
const INNER_HIGH_ROW = LAST_HALF_ROW - INNER_INSET * 2;
const DOT_COL = Math.floor(MARK_COLS / 2);

function sample(column: number, halfRow: number): "ink" | "accent" | undefined {
  // A horizontal rule fills both half rows of its cell, so the edge lands on
  // a cell boundary instead of drifting half a cell inside the mark. Both
  // rows of the top and bottom cell are ink, which is what a bold terminal
  // font draws for a rule anyway.
  const onOuterHorizontal =
    halfRow === 0 ||
    halfRow === 1 ||
    halfRow === LAST_HALF_ROW - 1 ||
    halfRow === LAST_HALF_ROW;
  const onOuterVertical = column === 0 || column === LAST_COL;
  if (onOuterHorizontal || onOuterVertical) return "ink";
  const inInnerColumn = column >= INNER_LOW_COL && column <= INNER_HIGH_COL;
  const inInnerRow = halfRow >= INNER_LOW_ROW && halfRow <= INNER_HIGH_ROW;
  const onInnerHorizontal =
    halfRow === INNER_LOW_ROW || halfRow === INNER_HIGH_ROW;
  const onInnerVertical = column === INNER_LOW_COL || column === INNER_HIGH_COL;
  // The inner rule stops at the outer rule instead of crossing it, so the
  // two squares read as separate shapes rather than one thick frame.
  if (inInnerColumn && inInnerRow && (onInnerHorizontal || onInnerVertical))
    return "accent";
  // The dot is two half rows tall so it fills one character cell.
  if (column === DOT_COL && (halfRow === DOT_COL || halfRow === DOT_COL + 1))
    return "accent";
  return undefined;
}

const LOGO_ID = process.pid & 0xffffff || 1;
const LOGO_COLUMNS = 9;
const LOGO_ROWS = 5;
const LOGO_WIDTH = 320;
const LOGO_HEIGHT = 315;
const MARKS = [
  0x0305, 0x030d, 0x030e, 0x0310, 0x0312, 0x033d, 0x033e, 0x033f, 0x0346,
];
const LOGO_CELLS = Array.from({ length: LOGO_ROWS }, (_, row) =>
  Array.from(
    { length: LOGO_COLUMNS },
    (_, column) =>
      `\u{10eeee}${String.fromCodePoint(MARKS[row]!)}${String.fromCodePoint(MARKS[column]!)}`,
  ).join(""),
);
let transfer: string | undefined;
let workspaceTransfer: string | undefined;

export function kittyLogoTransfer(): string {
  if (transfer !== undefined) return transfer;
  const encoded = readFileSync(
    new URL("./nomo-logo.png", import.meta.url),
  ).toString("base64");
  const chunks: string[] = [];
  for (let offset = 0; offset < encoded.length; offset += 4096) {
    const chunk = encoded.slice(offset, offset + 4096);
    const more = offset + 4096 < encoded.length;
    chunks.push(
      `\x1b_Ga=t,f=100,i=${LOGO_ID},q=2,m=${more ? 1 : 0};${chunk}\x1b\\`,
    );
  }
  transfer = chunks.join("");
  return transfer;
}

export function kittyLogoCleanup(): string {
  return `\x1b_Ga=d,d=I,i=${LOGO_ID},q=2\x1b\\`;
}
// Ink drops Kitty escapes from frames, so virtual placements must exist before
// it renders their Unicode cells.
function kittyVirtualImageTransfer(
  id: number,
  png: Buffer,
  placement: Readonly<{ columns: number; rows: number }>,
): string {
  const encoded = png.toString("base64");
  const chunks: string[] = [];
  for (let offset = 0; offset < encoded.length; offset += 4096) {
    const chunk = encoded.slice(offset, offset + 4096);
    const more = offset + 4096 < encoded.length;
    const header =
      offset === 0
        ? `a=T,f=100,i=${id},U=1,c=${placement.columns},r=${placement.rows},q=2,m=${more ? 1 : 0}`
        : `m=${more ? 1 : 0},q=2`;
    chunks.push(`\x1b_G${header};${chunk}\x1b\\`);
  }
  return chunks.join("");
}

export function kittyWorkspaceLogoTransfer(): string {
  if (workspaceTransfer !== undefined) return workspaceTransfer;
  return (workspaceTransfer = kittyVirtualImageTransfer(
    LOGO_ID,
    readFileSync(new URL("./nomo-logo.png", import.meta.url)),
    { columns: LOGO_COLUMNS, rows: LOGO_ROWS },
  ));
}

const TAB_ICON_FILES = {
  overview: "home-01",
  chat: "message-chat-circle",
  sessions: "clock",
  documents: "file-06",
  ledger: "book-open-01",
  approvals: "shield-tick",
  policy: "lock-01",
  tools: "tool-02",
  models: "cpu-chip-01",
  usage: "bar-chart-03",
  help: "help-circle",
} as const;
type TabIconKey = keyof typeof TAB_ICON_FILES;
type IconVariant = "dark" | "light";
type TabIcon = { readonly id: number; readonly png: Buffer };
export type LocalTabIcons = Readonly<
  Record<IconVariant, Readonly<Record<TabIconKey, TabIcon>>>
>;

const TAB_ICON_KEYS = Object.keys(TAB_ICON_FILES) as TabIconKey[];
const ICON_VARIANTS: readonly IconVariant[] = ["dark", "light"];
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const KITTY_ICON_BASE = "\u{10eeee}";
const LIGHT_THEMES = new Set<ColorTheme>(["paper", "solarized-light"]);

function validTabIcon(png: Buffer): boolean {
  if (
    png.length < 24 ||
    png.length > 64 * 1024 ||
    !png.subarray(0, 8).equals(PNG_SIGNATURE) ||
    png.readUInt32BE(8) !== 13 ||
    png.toString("ascii", 12, 16) !== "IHDR"
  )
    return false;
  const width = png.readUInt32BE(16);
  const height = png.readUInt32BE(20);
  return width > 0 && width <= 64 && height > 0 && height <= 64;
}

export function loadLocalTabIcons(
  env: Readonly<NodeJS.ProcessEnv> = process.env,
): LocalTabIcons | undefined {
  const directory = resolve(
    env.NOMO_TUI_ICONS_DIR ||
      join(dataDir(env.HOME || homedir()), "tui", "icons"),
  );
  const icons = {
    dark: {} as Record<TabIconKey, TabIcon>,
    light: {} as Record<TabIconKey, TabIcon>,
  };
  const usedIds = new Set([LOGO_ID]);
  let nextId = LOGO_ID;
  try {
    for (const variant of ICON_VARIANTS) {
      for (const tab of TAB_ICON_KEYS) {
        const png = readFileSync(join(directory, `${tab}.${variant}.png`));
        if (!validTabIcon(png)) return undefined;
        let id = nextId;
        do {
          id = (id + 1) & 0xffffff;
          if (id === 0) id = 1;
        } while (usedIds.has(id));
        usedIds.add(id);
        nextId = id;
        icons[variant][tab] = { id, png };
      }
    }
  } catch {
    return undefined;
  }
  return icons;
}

export function kittyTabIconsTransfer(icons: LocalTabIcons): string {
  const transfers: string[] = [];
  for (const variant of ICON_VARIANTS)
    for (const tab of TAB_ICON_KEYS)
      transfers.push(
        kittyVirtualImageTransfer(
          icons[variant][tab].id,
          icons[variant][tab].png,
          { columns: 2, rows: 1 },
        ),
      );
  return transfers.join("");
}

export function kittyTabIconsCleanup(icons: LocalTabIcons): string {
  const cleanup: string[] = [];
  for (const variant of ICON_VARIANTS)
    for (const tab of TAB_ICON_KEYS)
      cleanup.push(`\x1b_Ga=d,d=I,i=${icons[variant][tab].id},q=2\x1b\\`);
  return cleanup.join("");
}

export function kittyTabIconLabel(
  tab: string,
  icons: LocalTabIcons,
  theme: ColorTheme,
): string {
  if (!Object.hasOwn(TAB_ICON_FILES, tab)) return "";
  const variant = LIGHT_THEMES.has(theme) ? "light" : "dark";
  const { id } = icons[variant][tab as TabIconKey];
  const color = [(id >> 16) & 0xff, (id >> 8) & 0xff, id & 0xff].join(";");
  const cell = (column: number) =>
    `${KITTY_ICON_BASE}${String.fromCodePoint(MARKS[0]!)}${String.fromCodePoint(MARKS[column]!)}`;
  return `\x1b[38;2;${color}m${cell(0)}${cell(1)}\x1b[39m`;
}

export function brandHeader(
  label: string,
  caps: TerminalCapabilities,
  mark = "◈",
): string[] {
  const width = Math.max(0, caps.columns);
  if (
    caps.graphicsProtocol === "kitty" &&
    caps.ansi &&
    width >= 80 &&
    caps.rows >= 24
  ) {
    const context = sanitizeText(label)
      .replace(/^NOMO\b\s*/i, "")
      .replace(/^\/\s*/, "")
      .trim();
    const logoIdColor = [
      (LOGO_ID >> 16) & 0xff,
      (LOGO_ID >> 8) & 0xff,
      LOGO_ID & 0xff,
    ].join(";");
    const placement =
      `\x1b_Ga=p,U=1,i=${LOGO_ID},c=${LOGO_COLUMNS},r=${LOGO_ROWS},` +
      `x=0,y=0,w=${LOGO_WIDTH},h=${LOGO_HEIGHT},q=2\x1b\\`;
    return Array.from({ length: LOGO_ROWS }, (_, row) => {
      const cells = LOGO_CELLS[row]!;
      const contextWidth = Math.max(0, width - visibleLength(cells) - 1);
      const contextLine =
        context && contextWidth > 0
          ? row === Math.floor(LOGO_ROWS / 2) - 1
            ? paint(" WORKSPACE", "muted", caps, false)
            : row === Math.floor(LOGO_ROWS / 2)
              ? paint(` ${fit(context, contextWidth)}`, "accent", caps, true)
              : ""
          : "";
      return `${row === 0 ? placement : ""}\x1b[38;2;${logoIdColor}m${cells}\x1b[39m${contextLine}`;
    });
  }
  return Array.from({ length: MARK_ROWS }, (_, row) => {
    let line = "";
    for (let column = 0; column < MARK_COLS; column++) {
      const top = sample(column, row * 2);
      const bottom = sample(column, row * 2 + 1);
      const glyph = top && bottom ? "█" : top ? "▀" : bottom ? "▄" : " ";
      line += paint(glyph, top ?? bottom ?? "ink", caps);
    }
    return fit(`${line}  ${sanitizeText(label)}`, width);
  });
}

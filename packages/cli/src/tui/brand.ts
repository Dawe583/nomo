import { readFileSync } from "node:fs";
import { fit, sanitizeText, visibleLength } from "./layout.ts";
import { paint } from "./theme.ts";
import type { TerminalCapabilities } from "./types.ts";

const LOGO_ID = (process.pid & 0xffffff) || 1;
const LOGO_COLUMNS = 9;
const LOGO_ROWS = 6;
const LOGO_WIDTH = 340;
const LOGO_HEIGHT = 430;
const MARKS = [0x0305, 0x030d, 0x030e, 0x0310, 0x0312, 0x033d, 0x033e, 0x033f, 0x0346];
const LOGO_CELLS = Array.from({ length: LOGO_ROWS }, (_, row) =>
  Array.from(
    { length: LOGO_COLUMNS },
    (_, column) =>
      `\u{10eeee}${String.fromCodePoint(MARKS[row]!)}${String.fromCodePoint(MARKS[column]!)}`,
  ).join(""),
);
let transfer: string | undefined;

export function kittyLogoTransfer(): string {
  if (transfer !== undefined) return transfer;
  const encoded = readFileSync(new URL("./nomo-logo.png", import.meta.url)).toString("base64");
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

export function brandHeader(
  label: string,
  caps: TerminalCapabilities,
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
        row === 0 && context && contextWidth > 0
          ? paint(` ${fit(context, contextWidth)}`, "accent", caps, false)
          : "";
      return `${row === 0 ? placement : ""}\x1b[38;2;${logoIdColor}m${cells}\x1b[39m${contextLine}`;
    });
  }
  const labelLine = fit(` ${sanitizeText(label)}`, width);
  return [paint(labelLine, "accent", caps, true)];
}

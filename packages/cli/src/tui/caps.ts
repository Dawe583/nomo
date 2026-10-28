import type { TerminalCapabilities } from "./types.ts";

export interface CapabilityStream {
  readonly isTTY?: boolean;
  readonly columns?: number;
  readonly rows?: number;
  getColorDepth?(): number;
}

const positive = (value: string | undefined): boolean =>
  value !== undefined && value !== "" && value !== "0";

export function detectCapabilities(
  env: Readonly<NodeJS.ProcessEnv> = process.env,
  stream: CapabilityStream = process.stdout,
): TerminalCapabilities {
  const termProgram = env.TERM_PROGRAM?.toLowerCase();
  const kittyGraphics =
    (termProgram === "ghostty" && env.TERM === "xterm-ghostty") ||
    termProgram === "kitty" ||
    termProgram === "wezterm" ||
    env.TERM === "xterm-kitty" ||
    positive(env.KITTY_WINDOW_ID);
  const graphics = kittyGraphics
    ? { graphicsProtocol: "kitty" as const }
    : {};
  const columns = Math.max(40, stream.columns ?? 80);
  const rows = Math.max(12, stream.rows ?? 24);
  const tty = stream.isTTY === true;
  const dumb = env.TERM === "dumb";
  const ci = positive(env.CI);
  const noColor = env.NOMO_TUI_COLOR === "0";

  if (!tty)
    return {
      interactive: false,
      ansi: false,
      colorDepth: 0,
      columns,
      rows,
      reason: "not-tty",
    };
  if (dumb)
    return {
      interactive: false,
      ansi: false,
      colorDepth: 0,
      columns,
      rows,
      reason: "dumb",
    };
  if (ci)
    return {
      interactive: false,
      ansi: false,
      colorDepth: 0,
      columns,
      rows,
      reason: "ci",
    };
  if (noColor)
    return {
      interactive: true,
      ansi: false,
      colorDepth: 0,
      columns,
      rows,
      reason: "no-color",
      ...graphics,
    };

  const reported = stream.getColorDepth?.() ?? 4;
  const colorDepth: 4 | 8 | 24 = reported >= 24 ? 24 : reported >= 8 ? 8 : 4;
  return {
    interactive: true,
    ansi: true,
    colorDepth,
    columns,
    rows,
    reason: "interactive",
    ...graphics,
  };
}

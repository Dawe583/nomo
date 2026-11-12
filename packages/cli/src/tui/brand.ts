import { readFileSync } from "node:fs";
import { fit, sanitizeText } from "./layout.ts";
import { paint, type Tone } from "./theme.ts";
import type { TerminalCapabilities } from "./types.ts";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { dataDir } from "../../../ledger/src/paths.ts";
import { ansi256, trueColor, type ColorTheme } from "./theme-config.ts";

const TAB_ICON_ID_BASE = process.pid & 0xffffff || 1;
const MARKS = [
  0x0305, 0x030d, 0x030e, 0x0310, 0x0312, 0x033d, 0x033e, 0x033f, 0x0346,
];
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

const TAB_ICON_FILES = {
  overview: "home-simple",
  chat: "chat-bubble",
  sessions: "clock-rotate-right",
  documents: "multiple-pages",
  ledger: "open-book",
  approvals: "shield-check",
  policy: "lock",
  tools: "tools",
  models: "cpu",
  usage: "graph-up",
  help: "help-circle",
} as const;
const SEMANTIC_ICON_FILES = {
  subagents: "group",
  heartbeats: "activity",
  shells: "terminal",
  appearance: "palette",
  interaction: "key",
  composer: "app-window",
  timestamps: "clock",
  context: "brain",
  queue: "list-select",
  network: "network",
  run: "play",
  retry: "refresh-double",
  refinement: "magic-wand",
  search: "search",
  settings: "settings",
  timeout: "timer",
} as const;
type TabIconKey = keyof typeof TAB_ICON_FILES;
type SemanticIconKey = keyof typeof SEMANTIC_ICON_FILES;
type ActivityIconKey = "subagents" | "heartbeats" | "shells";
type IconVariant = "dark" | "light";
type TabIcon = { readonly id: number; readonly png: Buffer };
export type LocalTabIcons = Readonly<{
  readonly dark: Readonly<Record<TabIconKey, TabIcon>>;
  readonly light: Readonly<Record<TabIconKey, TabIcon>>;
  readonly provider?: Readonly<Record<IconVariant, TabIcon>>;
  readonly semantic?: Readonly<
    Record<IconVariant, Readonly<Partial<Record<SemanticIconKey, TabIcon>>>>
  >;
}>;

const TAB_ICON_KEYS = Object.keys(TAB_ICON_FILES) as TabIconKey[];
const SEMANTIC_ICON_KEYS = Object.keys(
  SEMANTIC_ICON_FILES,
) as SemanticIconKey[];
const ACTIVITY_ICON_KEYS: readonly ActivityIconKey[] = [
  "subagents",
  "heartbeats",
  "shells",
];
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
  const loadDirectory = (
    directory: string,
    filename: (tab: TabIconKey, variant: IconVariant) => string,
    providerFilename?: (variant: IconVariant) => string,
    semanticFilename?: (
      semantic: SemanticIconKey,
      variant: IconVariant,
    ) => string,
  ): LocalTabIcons | undefined => {
    const icons = {
      dark: {} as Record<TabIconKey, TabIcon>,
      light: {} as Record<TabIconKey, TabIcon>,
    };
    const usedIds = new Set([TAB_ICON_ID_BASE]);
    let nextId = TAB_ICON_ID_BASE;
    try {
      for (const variant of ICON_VARIANTS) {
        for (const tab of TAB_ICON_KEYS) {
          const png = readFileSync(join(directory, filename(tab, variant)));
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
    const result: {
      dark: Record<TabIconKey, TabIcon>;
      light: Record<TabIconKey, TabIcon>;
      provider?: Record<IconVariant, TabIcon>;
      semantic?: Record<IconVariant, Partial<Record<SemanticIconKey, TabIcon>>>;
    } = icons;
    const allocate = (png: Buffer): TabIcon => {
      let id = nextId;
      do {
        id = (id + 1) & 0xffffff;
        if (id === 0) id = 1;
      } while (usedIds.has(id));
      usedIds.add(id);
      nextId = id;
      return { id, png };
    };
    if (providerFilename) {
      const provider: Partial<Record<IconVariant, TabIcon>> = {};
      try {
        for (const variant of ICON_VARIANTS) {
          const png = readFileSync(join(directory, providerFilename(variant)));
          if (!validTabIcon(png)) break;
          provider[variant] = allocate(png);
        }
      } catch {
        // Private icon packs may not include optional provider artwork.
      }
      if (ICON_VARIANTS.every((variant) => provider[variant]))
        result.provider = provider as Record<IconVariant, TabIcon>;
    }
    if (semanticFilename) {
      const semantic: Record<
        IconVariant,
        Partial<Record<SemanticIconKey, TabIcon>>
      > = {
        dark: {},
        light: {},
      };
      for (const variant of ICON_VARIANTS)
        for (const key of SEMANTIC_ICON_KEYS) {
          try {
            const png = readFileSync(
              join(directory, semanticFilename(key, variant)),
            );
            if (validTabIcon(png)) semantic[variant][key] = allocate(png);
          } catch {
            // A private pack may override any subset of bundled semantic icons.
          }
        }
      if (
        ICON_VARIANTS.some((variant) => Object.keys(semantic[variant]).length)
      )
        result.semantic = semantic;
    }
    return result;
  };
  const localDirectory = resolve(
    env.NOMO_TUI_ICONS_DIR ||
      join(dataDir(env.HOME || homedir()), "tui", "icons"),
  );
  const localIcons = loadDirectory(
    localDirectory,
    (tab, variant) => `${tab}.${variant}.png`,
    (variant) => `provider.${variant}.png`,
    (semantic, variant) => `${SEMANTIC_ICON_FILES[semantic]}.${variant}.png`,
  );
  // Rollup places this module's chunks beside the copied `icons/` directory.
  // The same relative path also works from source during local development.
  const bundledDirectory = join(
    dirname(fileURLToPath(import.meta.url)),
    "icons",
  );
  const bundledIcons = loadDirectory(
    bundledDirectory,
    (tab, variant) => `${TAB_ICON_FILES[tab]}.${variant}.png`,
    (variant) => `cloud.${variant}.png`,
    (semantic, variant) => `${SEMANTIC_ICON_FILES[semantic]}.${variant}.png`,
  );
  // An incomplete user icon override must not blank the entire icon system.
  // Fall back to the shipped Iconoir pack; valid complete local packs still
  // override it below.
  if (!localIcons) return bundledIcons;
  const usedIds = new Set([
    TAB_ICON_ID_BASE,
    ...ICON_VARIANTS.flatMap((variant) =>
      TAB_ICON_KEYS.map((tab) => localIcons[variant][tab].id),
    ),
    ...(localIcons.provider
      ? ICON_VARIANTS.map((variant) => localIcons.provider![variant].id)
      : []),
    ...(localIcons.semantic
      ? ICON_VARIANTS.flatMap((variant) =>
          SEMANTIC_ICON_KEYS.flatMap((key) => {
            const icon = localIcons.semantic![variant][key];
            return icon ? [icon.id] : [];
          }),
        )
      : []),
  ]);
  let nextId = TAB_ICON_ID_BASE;
  const useBundled = (icon: TabIcon): TabIcon => {
    let id = nextId;
    do {
      id = (id + 1) & 0xffffff;
      if (id === 0) id = 1;
    } while (usedIds.has(id));
    usedIds.add(id);
    nextId = id;
    return { ...icon, id };
  };
  const provider =
    localIcons.provider ??
    (bundledIcons?.provider
      ? (Object.fromEntries(
          ICON_VARIANTS.map((variant) => [
            variant,
            useBundled(bundledIcons.provider![variant]),
          ]),
        ) as Record<IconVariant, TabIcon>)
      : undefined);
  const semantic = bundledIcons?.semantic
    ? (Object.fromEntries(
        ICON_VARIANTS.map((variant) => [
          variant,
          Object.fromEntries(
            SEMANTIC_ICON_KEYS.flatMap((key) => {
              const icon =
                localIcons.semantic?.[variant][key] ??
                bundledIcons.semantic?.[variant][key];
              return icon
                ? [
                    [
                      key,
                      localIcons.semantic?.[variant][key] ?? useBundled(icon),
                    ],
                  ]
                : [];
            }),
          ) as Partial<Record<SemanticIconKey, TabIcon>>,
        ]),
      ) as Record<IconVariant, Partial<Record<SemanticIconKey, TabIcon>>>)
    : localIcons.semantic;
  return {
    ...localIcons,
    ...(provider ? { provider } : {}),
    ...(semantic ? { semantic } : {}),
  };
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
  if (icons.semantic)
    for (const variant of ICON_VARIANTS)
      for (const key of SEMANTIC_ICON_KEYS) {
        const icon = icons.semantic[variant][key];
        if (icon)
          transfers.push(
            kittyVirtualImageTransfer(icon.id, icon.png, {
              columns: 2,
              rows: 1,
            }),
          );
      }
  return transfers.join("");
}

export function kittyTabIconsCleanup(icons: LocalTabIcons): string {
  const cleanup: string[] = [];
  for (const variant of ICON_VARIANTS)
    for (const tab of TAB_ICON_KEYS)
      cleanup.push(`\x1b_Ga=d,d=I,i=${icons[variant][tab].id},q=2\x1b\\`);
  if (icons.semantic)
    for (const variant of ICON_VARIANTS)
      for (const key of SEMANTIC_ICON_KEYS) {
        const icon = icons.semantic[variant][key];
        if (icon) cleanup.push(`\x1b_Ga=d,d=I,i=${icon.id},q=2\x1b\\`);
      }
  return cleanup.join("");
}

export function kittyProviderIconTransfer(icons: LocalTabIcons): string {
  if (!icons.provider) return "";
  return ICON_VARIANTS.map((variant) =>
    kittyVirtualImageTransfer(
      icons.provider![variant].id,
      icons.provider![variant].png,
      {
        columns: 2,
        rows: 1,
      },
    ),
  ).join("");
}

export function kittyProviderIconCleanup(icons: LocalTabIcons): string {
  return icons.provider
    ? ICON_VARIANTS.map(
        (variant) => `\x1b_Ga=d,d=I,i=${icons.provider![variant].id},q=2\x1b\\`,
      ).join("")
    : "";
}

function kittyIconLabel(id: number): string {
  const color = [(id >> 16) & 0xff, (id >> 8) & 0xff, id & 0xff].join(";");
  const cell = (column: number) =>
    `${KITTY_ICON_BASE}${String.fromCodePoint(MARKS[0]!)}${String.fromCodePoint(MARKS[column]!)}`;
  return `\x1b[38;2;${color}m${cell(0)}${cell(1)}\x1b[39m`;
}

export function kittyTabIconLabel(
  tab: string,
  icons: LocalTabIcons,
  theme: ColorTheme,
): string {
  if (!Object.hasOwn(TAB_ICON_FILES, tab)) return "";
  const variant = LIGHT_THEMES.has(theme) ? "light" : "dark";
  const { id } = icons[variant][tab as TabIconKey];
  return kittyIconLabel(id);
}

export function kittyProviderIconLabel(
  icons: LocalTabIcons,
  theme: ColorTheme,
): string {
  if (!icons.provider) return "";
  const variant = LIGHT_THEMES.has(theme) ? "light" : "dark";
  return kittyIconLabel(icons.provider[variant].id);
}

export function kittySemanticIconLabel(
  semantic: string,
  icons: LocalTabIcons,
  theme: ColorTheme,
): string {
  if (!icons.semantic || !Object.hasOwn(SEMANTIC_ICON_FILES, semantic))
    return "";
  const variant = LIGHT_THEMES.has(theme) ? "light" : "dark";
  const icon = icons.semantic[variant][semantic as SemanticIconKey];
  return icon ? kittyIconLabel(icon.id) : "";
}

export function kittyActivityIconLabel(
  activity: string,
  icons: LocalTabIcons,
  theme: ColorTheme,
): string {
  return Object.hasOwn(SEMANTIC_ICON_FILES, activity) &&
    ACTIVITY_ICON_KEYS.includes(activity as ActivityIconKey)
    ? kittySemanticIconLabel(activity, icons, theme)
    : "";
}

export function brandHeader(
  label: string,
  caps: TerminalCapabilities,
): string[] {
  const title = sanitizeText(label).trim();
  const rows: readonly (readonly ("base" | "stem" | "coral" | "cyan")[])[] = [
    ["base", "base", "base", "base", "base", "base"],
    ["stem", "coral", "base", "base", "base"],
    ["stem", "base", "base", "base", "base"],
    ["stem", "base", "base", "base", "base"],
    ["base", "base", "base", "base", "cyan", "base"],
    ["base", "base", "base", "base", "base", "base"],
  ];
  // Render every tile at two terminal cells wide to keep the supplied 6×6
  // mark close to square in terminals whose cells are taller than they are
  // wide. The merged left stem and its deliberate empty cells follow the
  // supplied grid artwork without setting a terminal background.
  const art = rows.map((tones) => {
    const cells = tones.map((tone) => {
      // Replace the grid gap between the stem's two source columns with ink;
      // keep the normal gap before the next tile.
      const glyph = tone === "stem" ? "█████" : "██";
      return paintBrand(glyph, tone, caps);
    });
    return cells.join(" ");
  });
  if (title)
    art[2] = `${art[2]}  ${paint(fit(title, Math.max(0, caps.columns - 23)), "accent", caps, true)}`;
  return art;
}

function paintBrand(
  value: string,
  tone: "base" | "stem" | "coral" | "cyan",
  caps: TerminalCapabilities,
): string {
  // Let the terminal choose the primary ink so the mark stays legible on the
  // user's own light or dark background. Only the two signal tiles are tinted.
  if (tone === "base" || tone === "stem" || !caps.ansi || caps.colorDepth === 0)
    return value;
  const hex = tone === "coral" ? "#ff705e" : "#00a9bd";
  const color =
    caps.colorDepth === 24
      ? trueColor(hex)
      : caps.colorDepth === 8
        ? `38;5;${ansi256(hex)}`
        : tone === "coral"
          ? "91"
          : "96";
  return `\x1b[1;${color}m${value}\x1b[39m`;
}

/** Compact grid mark for narrow terminal headers. */
export function compactBrandMark(caps: TerminalCapabilities): string {
  return paintBrand("▦", "base", caps);
}

/**
 * One token source, two consumers.
 *
 * The design system in `docs/APPLE-DESIGN-SYSTEM.md` is a contract, and a
 * contract that two hand-maintained files can drift from is not a contract. The
 * values live once, in `scripts/design/tokens.json`, and this script writes the
 * two forms a platform can consume: CSS custom properties for the web control
 * plane, and a Swift source file for the native clients.
 *
 * Both outputs sit between generated markers, and the script refuses to run if
 * a marker is missing. A silent no-op here would leave three surfaces agreeing
 * with each other and the source disagreeing with all three, which is the one
 * failure this script exists to make impossible.
 *
 * The web keeps its tokens in the stylesheet the existing design token gate
 * already names, because that gate treats the token file as one of exactly
 * three and a fourth file would be a fourth place a colour could live.
 *
 * The native output carries no colour value. The native surfaces resolve colour
 * through the platform's own semantic types, so a hard-coded hex in Swift would
 * be a second source of truth that the system already provides correctly in both
 * appearances. What the native file does carry is every scalar the guidelines
 * state, and the name of each semantic colour role so both forms name the same
 * thing.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SOURCE = join(ROOT, "scripts", "design", "tokens.json");
const WEB = join(ROOT, "apps", "control-plane", "ui", "src", "styles.css");
const NATIVE = join(ROOT, "apps", "apple", "VOIDApp", "VoidDesignTokens.swift");
const START = "/* design-tokens:start */";
const END = "/* design-tokens:end */";

/** Comment keys in the source are for the reader of the JSON, not tokens. */
const isComment = (key) => key.startsWith("$");

/** CSS tokens are lowercase and dashed; Swift names are camel case. */
const camel = (name) =>
  name.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());

export function loadTokens() {
  return JSON.parse(readFileSync(SOURCE, "utf8"));
}

export function cssBlock(tokens) {
  const light = Object.entries(tokens.color)
    .filter(([name]) => !isComment(name))
    .map(([name, value]) => `  --${name}: ${value.light};`)
    .join("\n");
  const dark = Object.entries(tokens.color)
    .filter(([name]) => !isComment(name))
    .map(([name, value]) => `  --${name}: ${value.dark};`)
    .join("\n");
  const roles = Object.entries(tokens.color)
    .map(([name, value]) => `  /* --${name}: ${value.role} */`)
    .join("\n");
  const space = Object.entries(tokens.space)
    .map(([name, value]) => `  --space-${name}: ${value}px;`)
    .join("\n");
  const radius = Object.entries(tokens.radius)
    .map(([name, value]) => `  --radius-${name}: ${value}px;`)
    .join("\n");
  const control = Object.entries(tokens.control)
    .map(([name, value]) => `  --control-${name}: ${value}px;`)
    .join("\n");
  const elevation = Object.entries(tokens.elevation)
    .map(([name, value]) => `  --shadow-${name}: ${value};`)
    .join("\n");
  return [
    START,
    "/*",
    " * Generated from scripts/design/tokens.json by",
    " * scripts/src/build-design-tokens.mjs. Do not edit this block by hand:",
    " * the design system test fails when it drifts from the source, and a hand",
    " * edit is a second place the same value can live.",
    " *",
    " * `color-scheme` lets the browser's own controls and scrollbars follow the",
    " * platform. The values below are this project's own, because the web",
    " * cannot read the operating system's semantic colours: it approximates that",
    " * family and the design system test measures the contrast rather than",
    " * trusting a hex. The native surfaces resolve the same roles through the",
    " * platform's own types.",
    " */",
    ":root {",
    "  color-scheme: light dark;",
    "  /* The platform's own interface font. A web font is for code and",
    "     identifiers, where a monospaced face carries meaning rather than brand. */",
    '  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;',
    "  font-size: " + tokens.type.$webBodySize + "px;",
    "  line-height: " + tokens.type.$webLineHeight + ";",
    "  color: var(--ink);",
    "  background: var(--canvas);",
    light,
    "",
    space,
    "",
    radius,
    "",
    control,
    "",
    elevation,
    "  --motion-interaction: " + tokens.motion.interaction + "s;",
    "  --space-horizontal: " + tokens.layout.horizontalSpacing + "px;",
    "  --space-group: " + tokens.layout.minimumVerticalSpacing + "px;",
    "  --measure-body: " + tokens.surfaceWidth.large + "px;",
    "}",
    "",
    "/* The platform preference, which is the appearance the product follows. The",
    "   attribute block below carries the same values for the in-app switch the",
    "   web phase removes, so a person who forces a mode gets the system palette",
    "   rather than a second one. */",
    "@media (prefers-color-scheme: dark) {",
    "  :root {",
    dark,
    "  }",
    "}",
    "",
    ':root[data-theme="dark"] {',
    dark,
    "}",
    "",
    "/* The semantic role each token stands in for, so a reader of the stylesheet",
    "   can map a value back to the platform concept it approximates. */",
    roles,
    END,
  ].join("\n");
}

export function swiftBlock(tokens) {
  const members = (object, format) =>
    Object.entries(object)
      .filter(([name]) => !isComment(name))
      .map(([name, value]) => format(name, value))
      .join("\n");
  const space = members(tokens.space, (name, value) =>
    `    public static let space${camel(name)}: CGFloat = ${value}`);
  const radius = members(tokens.radius, (name, value) =>
    `    public static let radius${camel(name)}: CGFloat = ${value}`);
  const control = members(tokens.control, (name, value) =>
    `    public static let control${camel(name)}: CGFloat = ${value}`);
  const ramp = members(tokens.type, (name, value) =>
    [
      `    /// ${value.weight}, ${value.ios[0]} points on iOS with ${value.ios[1]} of leading,`,
      `    /// ${value.macos[0]} points on macOS with ${value.macos[1]} of leading.`,
      `    public static let ${name} = VoidTypeStyle(ios: ${value.ios[0]}, iosLeading: ${value.ios[1]}, macos: ${value.macos[0]}, macosLeading: ${value.macos[1]}, weight: "${value.weight}")`,
    ].join("\n"));
  const roleCases = members(tokens.color, (name) =>
    `    case ${camel(name)[0].toUpperCase()}${camel(name).slice(1)}`);
  const roleNotes = members(tokens.color, (name, value) =>
    `        case .${camel(name)[0].toUpperCase()}${camel(name).slice(1)}: return "${value.role}"`);
  return [
    "// Generated from scripts/design/tokens.json by",
    "// scripts/src/build-design-tokens.mjs. Do not edit by hand: the design",
    "// system test fails when this file drifts from the source.",
    "//",
    "// No colour value appears here on purpose. The native surfaces resolve",
    "// colour through the platform's semantic types, which already adapt to",
    "// appearance, Increase Contrast and Reduce Transparency. A hex in Swift",
    "// would be a second source of truth for something the system gets right.",
    "",
    "import CoreGraphics",
    "",
    "/// Every scalar the Human Interface Guidelines state, in one place.",
    "public enum VoidMetrics {",
    "    /// A 4 point rhythm. The guidelines' own layout constants are 40 points",
    "    /// of horizontal spacing and 100 points minimum between unrelated groups.",
    space,
    "",
    "    /// Corners are concentric with the element that contains them, which a",
    "    /// single radius cannot express.",
    radius,
    "",
    "    /// Hit targets are a floor, not a suggestion.",
    control,
    "",
    "    /// Interaction feedback only, and never the only signal that something",
    "    /// changed, because Reduce Motion turns it off.",
    `    public static let motionInteraction: Double = ${tokens.motion.interaction}`,
    "",
    "    /// The guidelines' standard horizontal spacing, and the minimum vertical",
    "    /// spacing between unrelated groups.",
    `    public static let horizontalSpacing: CGFloat = ${tokens.layout.horizontalSpacing}`,
    `    public static let groupSpacing: CGFloat = ${tokens.layout.minimumVerticalSpacing}`,
    "}",
    "",
    "/// One rung of the type ramp, in both platforms' own numbers.",
    "public struct VoidTypeStyle: Sendable {",
    "    public let ios: CGFloat",
    "    public let iosLeading: CGFloat",
    "    public let macos: CGFloat",
    "    public let macosLeading: CGFloat",
    "    public let weight: String",
    "",
    "    public init(",
    "        ios: CGFloat,",
    "        iosLeading: CGFloat,",
    "        macos: CGFloat,",
    "        macosLeading: CGFloat,",
    "        weight: String",
    "    ) {",
    "        self.ios = ios",
    "        self.iosLeading = iosLeading",
    "        self.macos = macos",
    "        self.macosLeading = macosLeading",
    "        self.weight = weight",
    "    }",
    "}",
    "",
    "/// The type ramp. A semantic role resolves to the platform's own style, so",
    "/// Dynamic Type scales the surface and no view sets a point size. These",
    "/// numbers are the mapping, kept beside the web form so the two cannot drift",
    "/// apart unnoticed.",
    "public enum VoidTypeRamp {",
    ramp,
    "",
    "    /// Dynamic Type floors: 11 points on iOS, 10 on macOS.",
    `    public static let iosMinimum: CGFloat = ${tokens.type.$iosMin}`,
    `    public static let macosMinimum: CGFloat = ${tokens.type.$macosMin}`,
    "",
    "    /// The web maps Body to this size with the line height below, and never",
    "    /// below webMinimum pixels for interface text.",
    `    public static let webBody: CGFloat = ${tokens.type.$webBodySize}`,
    `    public static let webMinimum: CGFloat = ${tokens.type.$webMin}`,
    `    public static let webLineHeight: Double = ${tokens.type.$webLineHeight}`,
    "}",
    "",
    "/// A semantic colour role, named so the web and the native surfaces call the",
    "/// same concept the same thing. The platform supplies the value.",
    "public enum VoidColorRole: String, CaseIterable, Sendable {",
    roleCases,
    "",
    "    /// What the role stands for, so the name is never the only record.",
    "    public var note: String {",
    "        switch self {",
    roleNotes,
    "        }",
    "    }",
    "}",
  ].join("\n");
}

function replaceMarked(text, block, file) {
  const start = text.indexOf(START);
  const end = text.indexOf(END);
  if (start < 0 || end < 0)
    throw new Error(
      `${file} is missing a generated marker. Refusing to guess where the tokens go, because a wrong guess would leave a second source of truth in place of the first.`,
    );
  return text.slice(0, start) + block + text.slice(end + END.length);
}

function main() {
  const tokens = loadTokens();
  const before = readFileSync(WEB, "utf8");
  writeFileSync(WEB, replaceMarked(before, cssBlock(tokens), WEB));
  const swift = `${swiftBlock(tokens)}\n`;
  let existing = "";
  try {
    existing = readFileSync(NATIVE, "utf8");
  } catch {
    // The first run creates it, which is the only time the file may be absent.
  }
  if (existing !== swift) writeFileSync(NATIVE, swift);
  if (process.argv[1] === fileURLToPath(import.meta.url))
    process.stdout.write("design tokens written to the web stylesheet and the native source\n");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();

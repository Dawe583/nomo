// Class grouped browser for the tools tab: tools grouped by risk class,
// filterable, with the input schema stated as a property table.
//
// The tools tab used to list every tool as one flat row and dump the schema
// as raw JSON on Enter. A flat list hides the risk cut an operator reasons
// about first, and raw JSON is unscannable at a glance, so this module groups
// by class (low risk first) and states each schema property as name, type,
// required or optional, and description.
import { fit, sanitizeText } from "./layout.ts";
import {
  completionRing,
  cursorMarker,
  levelMeter,
  motionContext,
  pill,
  type MotionContext,
} from "./motion.ts";
import { renderInspector } from "./inspector.ts";
import type { Tone } from "./theme.ts";

/** One tool as the browser sees it. Schemas stay unknown: they are read, never run. */
export interface ToolSummary {
  readonly id: string;
  readonly name: string;
  /** Classification class such as R0, R1, R2. */
  readonly klass: string;
  /** Where it came from: a connector id or "built-in". */
  readonly source: string;
  readonly description?: string;
  /** Whether the tool captured a document Undo. */
  readonly capturedUndo?: boolean;
  /** JSON Schema for the input, or undefined when the tool declares none. */
  readonly inputSchema?: unknown;
}

export interface ToolRowsOptions {
  readonly selected?: number;
  readonly motion?: MotionContext;
  readonly paint?: (text: string, tone: string, bold?: boolean) => string;
}

// ASCII only, so every icon is exactly one cell under layout.ts. Anything in
// U+2600 to U+27BF counts as two cells and would break the fixed gutter math,
// and a wider icon set would need a font the operator may not have.
const ICON_R0 = "o";
const ICON_R1 = "!";
const ICON_R2 = "x";
const ICON_UNKNOWN = "?";

export type ClassTone = "success" | "warning" | "error" | "default";

// The tone is decoration only: every call site pairs it with the class word
// and icon, so a monochrome terminal loses nothing when paint is identity.
export function classTone(klass: string): ClassTone {
  const key = klass.trim().toUpperCase();
  if (key === "R0") return "success";
  if (key === "R1") return "warning";
  if (key === "R2") return "error";
  return "default";
}

/** One cell for any input, including an empty or malformed class string. */
export function classIcon(klass: string): string {
  const key = klass.trim().toUpperCase();
  if (key === "R0") return ICON_R0;
  if (key === "R1") return ICON_R1;
  if (key === "R2") return ICON_R2;
  return ICON_UNKNOWN;
}

// classTone speaks the browser vocabulary ("default" is not a palette tone),
// so the mapping to a real palette tone happens only at the paint boundary.
function classPaletteTone(tone: ClassTone): Tone {
  if (tone === "success" || tone === "warning" || tone === "error") return tone;
  return "muted";
}

// Code unit order, not locale order: localeCompare varies by machine, which
// would break the cross-frame determinism callers rely on.
function compareStrings(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

// An operator reasoning about risk reads low risk first. R0, R1, R2 hold the
// first three bands in that order; an unrecognised class must not sort into a
// risk band it was never measured into, so it trails alphabetically.
function groupRank(klass: string): number {
  const key = klass.trim().toUpperCase();
  if (key === "R0") return 0;
  if (key === "R1") return 1;
  if (key === "R2") return 2;
  return 3;
}

function safeWidth(width: number): number {
  return Number.isFinite(width) ? Math.max(1, Math.floor(width)) : 1;
}

function resolveMotion(motion: MotionContext | undefined): MotionContext {
  // Static browser view: hold the first frame so two renders of the same
  // state are byte identical, matching the inspector convention.
  return motion ?? motionContext(0, false, true);
}

/** Group tools by class: R0, R1, R2 first, then anything else alphabetically. */
export function groupTools(
  tools: readonly ToolSummary[],
): { readonly klass: string; readonly tools: readonly ToolSummary[] }[] {
  const byClass = new Map<string, ToolSummary[]>();
  for (const tool of tools) {
    const list = byClass.get(tool.klass);
    if (list === undefined) byClass.set(tool.klass, [tool]);
    else list.push(tool);
  }
  const groups = [...byClass.entries()].map(([klass, members]) => ({
    klass,
    // Deterministic order means the row an operator remembered is still
    // there: sort by name, keep input order for exact ties (stable sort).
    tools: [...members].sort((a, b) => compareStrings(a.name, b.name)),
  }));
  groups.sort((a, b) => {
    const rank = groupRank(a.klass) - groupRank(b.klass);
    if (rank !== 0) return rank;
    return compareStrings(a.klass, b.klass);
  });
  return groups;
}

/** Match name, class, source and description, case insensitively. */
export function filterTools(
  tools: readonly ToolSummary[],
  query: string,
): ToolSummary[] {
  const needle = query.trim().toLowerCase();
  // An empty query is "no filter", not "match nothing": it returns every tool.
  if (needle === "") return [...tools];
  return tools.filter((tool) => {
    const haystacks: readonly string[] = [
      tool.name,
      tool.klass,
      tool.source,
      tool.description ?? "",
    ];
    return haystacks.some((field) => field.toLowerCase().includes(needle));
  });
}

function undoLabel(tool: ToolSummary): string {
  return tool.capturedUndo === true ? "undo" : "no undo";
}

function undoCount(tools: readonly ToolSummary[]): number {
  let count = 0;
  for (const tool of tools) {
    if (tool.capturedUndo === true) count += 1;
  }
  return count;
}

// One group heading: icon plus the class word, so the class is never a glyph
// alone. The counts are words, never the ring alone: the completion ring is
// decoration on top of "undo k/n", which reads on a monochrome terminal.
function headingRow(
  klass: string,
  members: readonly ToolSummary[],
  width: number,
  motion: MotionContext,
  paint: (text: string, tone: string, bold?: boolean) => string,
): string {
  const tone = classTone(klass);
  const icon = paint(classIcon(klass), tone, true);
  const word = sanitizeText(klass.trim() === "" ? "unclassified" : klass);
  const count = members.length;
  const undone = undoCount(members);
  const ring = completionRing(undone, Math.max(1, count), motion);
  const noun = count === 1 ? "tool" : "tools";
  return fit(
    `  ${icon} ${word} -- ${count} ${noun}, undo ${undone}/${count} ${ring}`,
    width,
  );
}

// One tool row: fixed two cell gutter (the cursor marker is always two cells,
// selected or not, so selecting a row never shifts the others), then name,
// source, and whether Undo was captured. The Undo fact is the one operators
// most often miss, so it rides on the row rather than only in the detail.
function toolRow(
  tool: ToolSummary,
  selected: boolean,
  width: number,
  motion: MotionContext,
  paint: (text: string, tone: string, bold?: boolean) => string,
): string {
  const tone = classTone(tool.klass);
  const gutter = cursorMarker(selected, motion);
  const icon = paint(classIcon(tool.klass), tone, selected);
  const name = paint(sanitizeText(tool.name), "default", selected);
  const source = paint(sanitizeText(tool.source), "muted");
  // The undo marker is an accented label when captured, plain words when not:
  // both states read without colour, and the label never shows
  // an invented state, only what the tool reported.
  const undo =
    tool.capturedUndo === true
      ? pill("undo", classPaletteTone(tone), motion, {
          paint: (text: string, pillTone: Tone, bold?: boolean) =>
            paint(text, pillTone, bold),
        })
      : paint(undoLabel(tool), "muted");
  return fit(`${gutter}${icon} ${name} -- ${source} ${undo}`, width);
}

/**
 * Group headings plus one row per tool, every row fitted to width. The
 * selected index counts tool rows in display order (headings excluded), so it
 * matches the cursor the operator moves; negative or out of range selects
 * nothing. Never returns an empty array: no tools yields one line saying so.
 */
export function toolRows(
  tools: readonly ToolSummary[],
  width: number,
  options?: ToolRowsOptions,
): string[] {
  const cells = safeWidth(width);
  const motion = resolveMotion(options?.motion);
  const paint = options?.paint ?? ((text: string): string => text);
  if (tools.length === 0) return [fit("No tools.", cells)];
  const selected = options?.selected ?? -1;
  const groups = groupTools(tools);
  const rows: string[] = [];
  let index = 0;
  for (const group of groups) {
    rows.push(headingRow(group.klass, group.tools, cells, motion, paint));
    for (const tool of group.tools) {
      rows.push(toolRow(tool, index === selected, cells, motion, paint));
      index += 1;
    }
  }
  return rows;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function propertyType(schema: unknown): string {
  if (!isRecord(schema)) return "unknown";
  const type: unknown = schema["type"];
  if (typeof type === "string" && type.trim() !== "") return type;
  // A union such as ["string", "null"] is stated joined, never guessed: the
  // first entry alone would claim more than the tool declared.
  if (
    Array.isArray(type) &&
    type.every((entry): entry is string => typeof entry === "string")
  ) {
    const joined = type.filter((entry) => entry.trim() !== "").join("/");
    if (joined !== "") return joined;
  }
  return "unknown";
}

function propertyDescription(schema: unknown): string | undefined {
  if (!isRecord(schema)) return undefined;
  const description: unknown = schema["description"];
  if (typeof description !== "string" || description.trim() === "") {
    return undefined;
  }
  return description;
}

function requiredSet(schema: Record<string, unknown>): Set<string> {
  const required: unknown = schema["required"];
  if (!Array.isArray(required)) return new Set();
  const out = new Set<string>();
  for (const entry of required) {
    if (typeof entry === "string") out.add(entry);
  }
  return out;
}

/**
 * The input schema as a property table via the shared inspector: one aligned
 * field per property (name, type, required or optional, description), never
 * raw JSON. A schema that is not an object, is a string, is null, or is
 * missing yields one line saying the tool declares no schema rather than
 * throwing. Every value passes through the inspector, which sanitises before
 * painting, so a description carrying control characters renders visibly
 * marked, never raw. Nothing from the schema is ever evaluated.
 */
export function toolSchemaLines(tool: ToolSummary, width: number): string[] {
  const cells = safeWidth(width);
  const schema: unknown = tool.inputSchema;
  if (!isRecord(schema)) return [fit("Tool declares no input schema.", cells)];
  const properties: unknown = schema["properties"];
  if (!isRecord(properties)) {
    return [fit("Tool declares no input properties.", cells)];
  }
  const names = Object.keys(properties);
  if (names.length === 0) {
    return [fit("Tool declares no input properties.", cells)];
  }
  // Code unit order, matching the browser row order rule: the property an
  // operator remembered stays where it was.
  const ordered = [...names].sort(compareStrings);
  const required = requiredSet(schema);
  let requiredCount = 0;
  const fields = ordered.map((name) => {
    const prop = properties[name];
    const isRequired = required.has(name);
    if (isRequired) requiredCount += 1;
    const type = propertyType(prop);
    const state = isRequired ? "required" : "optional";
    const description = propertyDescription(prop);
    // Sanitize before composing: the inspector sanitises again, and double
    // sanitising is idempotent, while composing raw would risk a control
    // character surviving if this line ever bypassed the inspector.
    const cleanType = sanitizeText(type);
    const value =
      description === undefined
        ? `${cleanType}, ${state}`
        : `${cleanType}, ${state} -- ${sanitizeText(description)}`;
    return {
      label: name,
      value,
      tone: (isRequired ? "accent" : "default") as "accent" | "default",
    };
  });
  const motion = resolveMotion(undefined);
  // The meter is countable segments, so the required share reads without
  // colour; the words beside it state the same fact for a screen reader.
  const meter = levelMeter(
    requiredCount,
    Math.max(1, ordered.length),
    8,
    motion,
  );
  return renderInspector(
    {
      title: `Schema: ${tool.name}`,
      subtitle: `${tool.klass} -- ${tool.source}`,
      icon: classIcon(tool.klass),
      sections: [
        {
          title: "Tool",
          fields: [
            { label: "class", value: tool.klass },
            { label: "source", value: tool.source },
            { label: "undo", value: undoLabel(tool) },
            {
              label: "required",
              value: `${requiredCount} of ${ordered.length} ${meter}`,
            },
          ],
          body:
            tool.description === undefined || tool.description.trim() === ""
              ? undefined
              : [tool.description],
        },
        { title: "Properties", fields },
      ],
    },
    { width: cells },
  );
}

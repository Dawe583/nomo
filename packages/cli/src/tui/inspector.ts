import { fit, pad, sanitizeText, visibleLength } from "./layout.ts";
import { motionContext, pill, type MotionContext } from "./motion.ts";
import type { Tone } from "./theme.ts";

// Structured inspector for detail views (session, document, ledger entry,
// tool). Detail views used to print raw pre-wrapped lines, which made long
// views unscannable; the inspector puts keys on aligned columns under
// uppercase section titles so the eye scans down instead of re-reading rows.

export type FieldTone =
  "default" | "muted" | "accent" | "success" | "warning" | "error";

export interface Field {
  readonly label: string;
  readonly value: string;
  readonly tone?: FieldTone;
  /** Rendered after the value as a badge, for example "selected". */
  readonly badge?: string;
}

export interface Section {
  readonly title: string;
  readonly fields: readonly Field[];
  /** Free text under the fields, already wrapped by the caller or not. */
  readonly body?: readonly string[];
}

export interface InspectorSpec {
  readonly title: string;
  readonly subtitle?: string;
  readonly icon?: string;
  readonly sections: readonly Section[];
  /** One line of guidance shown at the bottom. */
  readonly hint?: string;
}

export interface InspectorOptions {
  readonly width: number;
  readonly height?: number;
  readonly motion?: MotionContext;
  readonly paint?: (text: string, tone: FieldTone, bold?: boolean) => string;
}

// The inspector speaks its own tone vocabulary so detail views never depend
// on palette names; the mapping happens only at the paint boundary, and with
// no paint callback every tone renders as identical plain text.
const FIELD_TONES: Record<FieldTone, Tone> = {
  default: "fg",
  muted: "muted",
  accent: "accent",
  success: "success",
  warning: "warning",
  error: "error",
};

function paintField(
  paint: InspectorOptions["paint"],
  text: string,
  tone: FieldTone,
  bold?: boolean,
): string {
  if (paint === undefined) return text;
  return paint(text, tone, bold);
}

// The first line can have less space when a badge shares the row.
function wrapCells(
  text: string,
  firstWidth: number,
  restWidth = firstWidth,
): string[] {
  const chunks: string[] = [];
  let part = "";
  let used = 0;
  let limit = firstWidth;
  for (const point of text) {
    const cells = visibleLength(point);
    if (used > 0 && used + cells > limit) {
      chunks.push(part);
      part = "";
      used = 0;
      limit = restWidth;
    }
    // A glyph wider than the entire column has no half-cell representation.
    const glyph = cells > limit ? "." : point;
    part += glyph;
    used += cells > limit ? 1 : cells;
  }
  chunks.push(part);
  return chunks;
}

// Keep ordinary label words intact. Only an identifier longer than the
// panel needs to break across multiple rows.
function wrapLabel(label: string, width: number): string[] {
  const rows: string[] = [];
  let current = "";
  for (const word of label.split(/\s+/u)) {
    if (current && visibleLength(current + " " + word) <= width) {
      current += " " + word;
      continue;
    }
    if (current) rows.push(current);
    const pieces = wrapCells(word, width);
    current = pieces.pop() ?? "";
    rows.push(...pieces);
  }
  rows.push(current);
  return rows;
}

function renderField(
  field: Field,
  cleanLabel: string,
  labelCol: number,
  width: number,
  paint: InspectorOptions["paint"],
  motion: MotionContext,
): string[] {
  const tone: FieldTone = field.tone ?? "default";
  const stacked = labelCol === 0 || visibleLength(cleanLabel) > labelCol;
  const offset = stacked ? (width >= 8 ? 2 : 0) : labelCol + 2;
  const indent = " ".repeat(offset);
  const valueWidth = width - offset;
  const value = sanitizeText(field.value);
  const badge = sanitizeText(field.badge ?? "");
  const badgePill = badge ? pill(badge, FIELD_TONES[tone], motion) : "";
  const badgeWidth = visibleLength(badgePill);
  // Give a wide glyph a full cell pair even when a badge shares its row.
  const inlineBadge = badgeWidth > 0 && valueWidth - badgeWidth - 2 >= 2;
  const chunks = wrapCells(
    value,
    inlineBadge ? valueWidth - badgeWidth - 2 : valueWidth,
    valueWidth,
  );
  const rows = stacked
    ? wrapLabel(cleanLabel, width).map((chunk) =>
        paintField(paint, chunk, "muted"),
      )
    : [];
  const prefix = stacked
    ? indent
    : `${pad(paintField(paint, cleanLabel, "muted"), labelCol)}: `;
  const tail = inlineBadge ? `  ${paintField(paint, badgePill, tone)}` : "";
  rows.push(`${prefix}${paintField(paint, chunks[0]!, tone)}${tail}`);
  for (const chunk of chunks.slice(1)) {
    rows.push(indent + paintField(paint, chunk, tone));
  }
  if (badge && !inlineBadge) {
    for (const chunk of wrapCells(badgePill.trim(), valueWidth)) {
      rows.push(indent + paintField(paint, chunk, tone));
    }
  }
  return rows.map((row) => row.trimEnd());
}

function pushBody(
  rows: string[],
  body: readonly string[] | undefined,
  width: number,
  paint: InspectorOptions["paint"],
): void {
  if (body === undefined) return;
  for (const line of body) {
    for (const chunk of wrapCells(sanitizeText(line), width)) {
      rows.push(paintField(paint, chunk, "default"));
    }
  }
}

function pushHint(
  rows: string[],
  hint: string | undefined,
  width: number,
  paint: InspectorOptions["paint"],
): void {
  if (hint === undefined) return;
  const clean = sanitizeText(hint);
  if (clean === "") return;
  rows.push("");
  for (const line of wrapCells(clean, width)) {
    rows.push(paintField(paint, line, "muted"));
  }
}

export function renderInspector(
  spec: InspectorSpec,
  options: InspectorOptions,
): string[] {
  const width = Number.isFinite(options.width)
    ? Math.max(1, Math.floor(options.width))
    : 1;
  const paint = options.paint;
  // Static detail view: hold the first motion frame so two renders of the
  // same spec are byte identical and tests can assert on badge output.
  const motion: MotionContext = options.motion ?? motionContext(0, false, true);
  const rows: string[] = [];
  const iconClean = sanitizeText(spec.icon ?? "");
  // Only single cell icons are shown: layout.ts counts U+2600 to U+27BF as
  // two cells, and a wide icon would break the header fit math.
  const icon =
    iconClean.trim() !== "" && visibleLength(iconClean) === 1
      ? `${iconClean} `
      : "";
  // Sanitize first, fit second, paint last: paint inserts ANSI escapes and
  // sanitizing afterwards would strip or corrupt them.
  rows.push(
    paintField(
      paint,
      fit(`${icon}${sanitizeText(spec.title)}`, width),
      "accent",
      true,
    ),
  );
  if (spec.subtitle !== undefined) {
    rows.push(
      paintField(paint, fit(sanitizeText(spec.subtitle), width), "muted"),
    );
  }
  rows.push("-".repeat(width));
  spec.sections.forEach((section, index) => {
    if (index > 0) rows.push("");
    // Uppercase titles are what make a long inspector skimmable.
    rows.push(
      paintField(
        paint,
        fit(sanitizeText(section.title).toUpperCase(), width),
        "muted",
        true,
      ),
    );
    if (section.fields.length === 0) {
      // A missing title would read as a rendering failure, so an empty
      // section still names itself and says so explicitly. Not when it
      // carries prose instead, which is entries of a different shape.
      if ((section.body?.length ?? 0) === 0)
        rows.push(paintField(paint, fit("No entries.", width), "muted"));
    } else {
      // Long labels stack above their values. A single outlier must not
      // reduce every value in the section to a column one character wide.
      const labelBudget = width >= 12 ? Math.floor((width - 2) / 3) : 0;
      const cleanLabels = section.fields.map((field) =>
        sanitizeText(field.label),
      );
      const labelCol = cleanLabels.reduce((widest, label) => {
        const cells = visibleLength(label);
        return cells <= labelBudget ? Math.max(widest, cells) : widest;
      }, 0);
      section.fields.forEach((field, fieldIndex) => {
        for (const row of renderField(
          field,
          cleanLabels[fieldIndex] ?? "",
          labelCol,
          width,
          paint,
          motion,
        )) {
          rows.push(row);
        }
      });
    }
    pushBody(rows, section.body, width, paint);
  });
  pushHint(rows, spec.hint, width, paint);
  // The header always pushes at least one row, even with no sections.
  return clipHeight(rows, options.height);
}

// Never returns more than height rows, but never clips to zero either: an
// empty render would read as a failure, so a zero height still shows one row.
function clipHeight(rows: string[], height: number | undefined): string[] {
  if (height === undefined || !Number.isFinite(height)) return rows;
  return rows.slice(0, Math.max(1, Math.floor(height)));
}

/** A one line summary of an inspector: its title and its field count. */
export function inspectorSummary(spec: InspectorSpec): string {
  const title = sanitizeText(spec.title);
  let total = 0;
  for (const section of spec.sections) total += section.fields.length;
  return `${title}: ${total} fields`;
}

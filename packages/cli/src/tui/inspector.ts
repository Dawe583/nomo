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

// Cell based wrapper for one sanitized line. Local because layout.ts exposes
// no wrapper and workspace.ts is off limits (import cycle); the code point
// walk mirrors the workspace wrapper so wide glyphs never split mid cell.
function wrapCells(line: string, width: number): string[] {
  const safe = Math.max(1, width);
  const out: string[] = [];
  let part = "";
  for (const point of line) {
    if (part !== "" && visibleLength(part + point) > safe) {
      out.push(part);
      part = "";
    }
    part += point;
  }
  out.push(part);
  return out;
}

// Splits a sanitized value so the first line fits beside the badge reserve
// and the rest use the full value column. Continuation chunks are measured
// against the value column start, never the label, so a wrapped second line
// cannot be misread as a new field.
function splitValue(
  text: string,
  firstWidth: number,
  restWidth: number,
): string[] {
  const chunks: string[] = [];
  let part = "";
  let limit = Math.max(1, firstWidth);
  for (const point of text) {
    if (part !== "" && visibleLength(part + point) > limit) {
      chunks.push(part);
      part = "";
      limit = Math.max(1, restWidth);
    }
    part += point;
  }
  chunks.push(part);
  return chunks;
}

// A badge is a framed pill (legible without colour) hung off a fixed two
// cell rail of spaces after the value. The rail is constant and the badge
// trails the value, so adding or removing a badge never moves any value
// column. The badge is fitted and painted from its plain form: fitting
// after painting would strip the ANSI escapes that paint just added.
function badgeText(
  badge: string,
  tone: FieldTone,
  width: number,
  paint: InspectorOptions["paint"],
  motion: MotionContext,
): string {
  const plain = pill(badge, FIELD_TONES[tone], motion);
  const fitted = fit(plain, Math.max(1, width));
  return paintField(paint, fitted, tone);
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
  // Padding is applied after painting the label so alignment spaces stay
  // unpainted: a paint callback that returns empty (used to prove tones are
  // the only difference) leaves the column skeleton intact.
  const labelCell = pad(
    paintField(paint, fit(cleanLabel, labelCol), "muted"),
    labelCol,
  );
  const valueWidth = width - labelCol - 2;
  const indent = " ".repeat(labelCol + 2);
  const rawBadge = field.badge === undefined ? "" : sanitizeText(field.badge);
  const valuePlain = sanitizeText(field.value);
  const paintChunk = (chunk: string): string => paintField(paint, chunk, tone);
  const out: string[] = [];
  if (rawBadge !== "") {
    const reserved =
      visibleLength(pill(rawBadge, FIELD_TONES[tone], motion)) + 2;
    if (valueWidth - reserved >= 1) {
      // Badge fits beside the first value line; later lines use full width.
      const chunks = splitValue(valuePlain, valueWidth - reserved, valueWidth);
      const first = chunks[0] ?? "";
      out.push(
        `${labelCell}: ${paintChunk(first)}  ${badgeText(rawBadge, tone, reserved - 2, paint, motion)}`,
      );
      for (const chunk of chunks.slice(1))
        out.push(`${indent}${paintChunk(chunk)}`);
    } else {
      // No room beside the value, so the badge drops to its own indented
      // line rather than truncating the value it annotates.
      const chunks = splitValue(valuePlain, valueWidth, valueWidth);
      const first = chunks[0] ?? "";
      out.push(`${labelCell}: ${paintChunk(first)}`);
      for (const chunk of chunks.slice(1))
        out.push(`${indent}${paintChunk(chunk)}`);
      out.push(
        `${indent}${badgeText(rawBadge, tone, valueWidth, paint, motion)}`,
      );
    }
  } else {
    const chunks = splitValue(valuePlain, valueWidth, valueWidth);
    const first = chunks[0] ?? "";
    out.push(`${labelCell}: ${paintChunk(first)}`);
    for (const chunk of chunks.slice(1))
      out.push(`${indent}${paintChunk(chunk)}`);
  }
  // Trailing alignment spaces carry no meaning; strip them so narrow
  // terminals and pipe consumers never see invisible padding.
  return out.map((row) => row.replace(/\s+$/, ""));
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

// Widths below four cells cannot fit even "L: v", so the inspector falls
// back to one fitted line per entry instead of aligned columns. The column
// path below assumes labelCol + ": " + one value cell fits.
function renderNarrow(
  spec: InspectorSpec,
  width: number,
  paint: InspectorOptions["paint"],
  motion: MotionContext,
): string[] {
  const rows: string[] = [];
  const title = sanitizeText(spec.title);
  rows.push(paintField(paint, fit(title, width), "accent", true));
  if (spec.subtitle !== undefined) {
    rows.push(
      paintField(paint, fit(sanitizeText(spec.subtitle), width), "muted"),
    );
  }
  rows.push("-".repeat(width));
  spec.sections.forEach((section, index) => {
    if (index > 0) rows.push("");
    rows.push(
      paintField(
        paint,
        fit(sanitizeText(section.title).toUpperCase(), width),
        "muted",
        true,
      ),
    );
    // "No entries." only when the section is genuinely empty. A section that
    // carries prose instead of fields has entries, and printing the marker
    // above its own content reads as a failure rather than as a heading.
    if (section.fields.length === 0 && (section.body?.length ?? 0) === 0) {
      rows.push(paintField(paint, "No entries.", "muted"));
    }
    for (const field of section.fields) {
      const badge =
        field.badge === undefined || sanitizeText(field.badge) === ""
          ? ""
          : ` [${sanitizeText(field.badge)}]`;
      const line = fit(
        `${sanitizeText(field.label)}: ${sanitizeText(field.value)}${badge}`,
        width,
      );
      rows.push(paintField(paint, line, field.tone ?? "default"));
    }
    pushBody(rows, section.body, width, paint);
  });
  pushHint(rows, spec.hint, width, paint);
  void motion;
  return rows;
}

function pushHint(
  rows: string[],
  hint: string | undefined,
  width: number,
  paint: InspectorOptions["paint"],
): void {
  if (hint === undefined) return;
  const clean = sanitizeText(hint);
  // A truncated hint says nothing useful, so it is omitted unless whole.
  if (clean === "" || visibleLength(clean) > width) return;
  rows.push("");
  rows.push(paintField(paint, clean, "muted"));
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
  if (width < 4)
    return clipHeight(renderNarrow(spec, width, paint, motion), options.height);
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
        rows.push(paintField(paint, "No entries.", "muted"));
    } else {
      // One label column per section, sized to its widest label, so every
      // value in the section starts at the same cell. Capped so at least
      // one value cell always survives, even at narrow widths.
      let widest = 1;
      const cleanLabels = section.fields.map((field) =>
        sanitizeText(field.label),
      );
      for (const label of cleanLabels) {
        widest = Math.max(widest, visibleLength(label));
      }
      const labelCol = Math.min(widest, width - 3);
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

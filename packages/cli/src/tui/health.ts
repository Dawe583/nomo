// One place to see whether the workspace is actually healthy. Today the
// operator checks the provider here, the ledger there and connectors
// somewhere else, and a corrupted ledger only surfaces as an error after a
// run. This panel checks every subsystem and says pass or fail with the
// reason, so a broken subsystem is visible before it costs a run.
import { fit, sanitizeText } from "./layout.ts";
import { motionContext, pill } from "./motion.ts";
import type { MotionContext } from "./motion.ts";
import { renderInspector } from "./inspector.ts";
import type { Field, InspectorSpec } from "./inspector.ts";
import type { Tone } from "./theme.ts";

export type HealthState = "ok" | "warn" | "fail" | "unknown" | "skipped";

export interface Check {
  /** What was checked, named so an operator can search for it. */
  readonly name: string;
  /** The subsystem it belongs to, for grouping. */
  readonly area: string;
  readonly state: HealthState;
  /** Why it is in that state, in one short line. Never empty. */
  readonly detail: string;
  /** What to do about it, when something can be done. */
  readonly remedy?: string;
}

// Single cell under layout.ts, which counts U+2600 to U+27BF as two cells.
// Every state needs a distinct shape because colour alone is unreadable to
// part of the audience, and the shapes stay distinct at one cell.
const HEALTH_ICONS: Record<HealthState, string> = {
  ok: "●",
  warn: "◔",
  fail: "×",
  unknown: "?",
  skipped: "▪",
};

// The word is the signal and the icon is decoration: a screen reader and a
// monochrome terminal both get the full meaning from the word alone.
const HEALTH_WORDS: Record<HealthState, string> = {
  ok: "ok",
  warn: "warn",
  fail: "fail",
  unknown: "unknown",
  skipped: "skipped",
};

// unknown is muted, never success: a check that could not run is not a check
// that passed, and painting it the pass colour would convert an absence of
// information into an assurance. skipped is the neutral default tone: it is
// neither good nor bad, only not applicable on this host.
const HEALTH_TONES: Record<
  HealthState,
  "success" | "warning" | "error" | "muted" | "default"
> = {
  ok: "success",
  warn: "warning",
  fail: "error",
  unknown: "muted",
  skipped: "default",
};

/** The glyph for a state. Always paired with healthWord at the call site. */
export function healthIcon(state: HealthState): string {
  return HEALTH_ICONS[state] ?? "?";
}

/** The word for a state. This is the signal; the icon is decoration. */
export function healthWord(state: HealthState): string {
  return HEALTH_WORDS[state] ?? "unknown";
}

export function healthTone(
  state: HealthState,
): "success" | "warning" | "error" | "muted" | "default" {
  return HEALTH_TONES[state] ?? "muted";
}

// A check that could not run outranks a known degradation: an unknown check
// can hide a failure, while a warn is confirmed working with a caveat.
// skipped outranks ok only because it is unmeasured, never because it is bad.
function severityRank(state: HealthState): number {
  switch (state) {
    case "fail":
      return 0;
    case "unknown":
      return 1;
    case "warn":
      return 2;
    case "skipped":
      return 3;
    case "ok":
      return 4;
  }
}

// Plain string order, never localeCompare: the sort must be byte identical
// on every host regardless of ICU locale data, which is what determinism
// means for an operator comparing two captures.
function compareText(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

/** Checks ordered worst first, then by area. */
export function orderChecks(checks: readonly Check[]): Check[] {
  return checks
    .map((check, index) => ({ check, index }))
    .sort(
      (a, b) =>
        severityRank(a.check.state) - severityRank(b.check.state) ||
        compareText(sanitizeText(a.check.area), sanitizeText(b.check.area)) ||
        compareText(sanitizeText(a.check.name), sanitizeText(b.check.name)) ||
        a.index - b.index,
    )
    .map((entry) => entry.check);
}

// The inspector has no "default" tone key, so the neutral state maps to the
// same base text tone the inspector itself uses for it. The pill is built
// unpainted here and the inspector paints the field afterwards, so the tone
// only matters for painted output and never for the plain words.
function pillTone(state: HealthState): Tone {
  const tone = healthTone(state);
  return tone === "default" ? "fg" : tone;
}

// Every segment is sanitized before composing the value, because details can
// arrive from a server or an agent and sanitizing after paint would strip the
// escapes paint just inserted. An empty detail falls back to the state word,
// which the pill already carries, so a check with no explanation still says
// what state it is in instead of printing a blank. A missing remedy prints
// nothing at all, never an empty remedy line.
function buildValue(check: Check, motion: MotionContext): string {
  const icon: string = healthIcon(check.state);
  const statePill: string = pill(
    healthWord(check.state),
    pillTone(check.state),
    motion,
  );
  const detail: string = sanitizeText(check.detail).trim();
  const core: string =
    detail !== "" ? `${icon} ${statePill} · ${detail}` : `${icon} ${statePill}`;
  const remedy: string =
    check.remedy === undefined ? "" : sanitizeText(check.remedy).trim();
  return remedy !== "" ? `${core} (fix: ${remedy})` : core;
}

function checkLabel(check: Check, index: number): string {
  const name: string = sanitizeText(check.name).trim();
  return name !== "" ? name : `unnamed check ${index + 1}`;
}

function areaTitle(area: string): string {
  const clean: string = sanitizeText(area).trim();
  return clean !== "" ? clean : "general";
}

/** Grouped render, worst area first. */
export function renderHealth(
  checks: readonly Check[],
  width: number,
  options?: {
    readonly motion?: MotionContext;
    readonly paint?: (text: string, tone: string, bold?: boolean) => string;
    readonly height?: number;
  },
): string[] {
  const cells: number = Number.isFinite(width)
    ? Math.max(0, Math.floor(width))
    : 0;
  // A health panel that renders nothing reads as a failure of the panel
  // itself, so even a zero width returns one (empty) row, never zero rows.
  if (cells <= 0) return [""];
  if (checks.length === 0)
    return [fit(sanitizeText("No health checks ran."), cells)];
  // Static view: the frozen first frame keeps two renders byte identical.
  // pill ignores the frame, so even a live motion context cannot move output.
  const motion: MotionContext =
    options?.motion ?? motionContext(0, false, true);
  const ordered: Check[] = orderChecks(checks);
  // First appearance in worst-first order is the worst-area-first order:
  // every area's first row is its worst check, and areas are already sorted
  // by that row, so grouping below preserves the ordering for free.
  const areas: { readonly title: string; readonly fields: Field[] }[] = [];
  const seen = new Map<string, Field[]>();
  ordered.forEach((check, position) => {
    const title: string = areaTitle(check.area);
    let fields: Field[] | undefined = seen.get(title);
    if (fields === undefined) {
      fields = [];
      seen.set(title, fields);
      areas.push({ title, fields });
    }
    fields.push({
      label: checkLabel(check, position),
      value: buildValue(check, motion),
      tone: healthTone(check.state),
    });
  });
  const worst = ordered[0]!.state;
  const spec: InspectorSpec = {
    icon: healthIcon(worst),
    title: `Health · ${healthWord(worst)}`,
    subtitle: healthSummary(checks),
    sections: areas.map((area) => ({ title: area.title, fields: area.fields })),
  };
  // The inspector owns the columns: reusing it keeps one column renderer in
  // the codebase and guarantees every row fits the width, including the
  // wrapped continuation lines of long details. Height clips to at least one
  // row, so a cramped panel still names itself instead of going blank.
  return renderInspector(spec, {
    width: cells,
    height: options?.height,
    motion,
    paint: options?.paint,
  });
}

// Counts for the summary. skipped is tracked apart from passes: it is
// neither good nor bad, so folding it into either count would mislead.
function countBy(checks: readonly Check[], state: HealthState): number {
  let total = 0;
  for (const check of checks) {
    if (check.state === state) total += 1;
  }
  return total;
}

// Names one check and its reason on a single line. The reason falls back to
// the state word when empty, for the same reason the renderer does: a blank
// names nothing to act on.
function nameWorst(check: Check): string {
  const name: string =
    sanitizeText(check.name).trim() !== ""
      ? sanitizeText(check.name).trim()
      : "unnamed check";
  const detail: string = sanitizeText(check.detail).trim();
  const reason: string = detail !== "" ? detail : healthWord(check.state);
  return `${name} -- ${reason}`;
}

/** One sentence: is this workspace healthy, and if not what is wrong. */
export function healthSummary(checks: readonly Check[]): string {
  if (checks.length === 0) return "No health checks ran.";
  const ordered: Check[] = orderChecks(checks);
  const worst: Check = ordered[0] ?? checks[0]!;
  const fails: number = countBy(checks, "fail");
  if (fails > 0) {
    const extra: string = fails > 1 ? ` (${fails - 1} more failing)` : "";
    return `Failing: ${nameWorst(worst)}${extra}`;
  }
  const unknowns: number = countBy(checks, "unknown");
  if (unknowns > 0) {
    const extra: string = unknowns > 1 ? ` (${unknowns - 1} more unknown)` : "";
    return `Unknown: ${nameWorst(worst)}${extra}`;
  }
  const warns: number = countBy(checks, "warn");
  if (warns > 0) {
    const extra: string = warns > 1 ? ` (${warns - 1} more warnings)` : "";
    return `Warning: ${nameWorst(worst)}${extra}`;
  }
  const skipped: number = countBy(checks, "skipped");
  const passed: number = countBy(checks, "ok");
  // All skipped is not healthy and not broken: nothing was measured, so the
  // summary says health is unverified rather than claiming a pass.
  if (passed === 0 && skipped > 0)
    return skipped === 1
      ? "1 check skipped; health unverified."
      : `All ${skipped} checks skipped; health unverified.`;
  if (skipped > 0)
    return `Healthy: ${passed} of ${checks.length} checks pass, ${skipped} skipped.`;
  if (passed === 1) return "Healthy: 1 check passes.";
  return `Healthy: all ${passed} checks pass.`;
}

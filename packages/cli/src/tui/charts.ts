// Small inline charts for the status area: sparklines, labelled bars,
// proportional stacked bars, compact gauges and trend labels. OMP reports
// token usage, cost and context pressure as glanceable shapes beside the
// numbers; NOMO had numbers only, so a slow drift was invisible until it was
// a limit error. Every function here is plain text with the measurement also
// written out, so nothing is carried by colour or by a glyph alone, and every
// animated choice is a pure function of the motion frame per motion.ts.
import { fit, pad, sanitizeText, visibleLength } from "./layout.ts";
import type { MotionContext } from "./motion.ts";

export interface Series {
  readonly values: readonly number[];
  /** Labels for the x axis, same length as values. */
  readonly labels?: readonly string[];
}

// Eight block levels from U+2581 to U+2588. They sit below the U+2600 to
// U+27BF range that layout.ts counts as two cells, so each level is exactly
// one cell and visibleLength agrees with the terminal. Eight is also the
// most steps a small status chart can show before adjacent levels blur.
const SPARK_LEVELS: readonly string[] = [
  "▁",
  "▂",
  "▃",
  "▄",
  "▅",
  "▆",
  "▇",
  "█",
] as const;

// The level a flat series draws at: the middle of the scale, so a constant
// measurement reads as a present fact rather than as missing data.
const SPARK_MID: string = SPARK_LEVELS[3]!;

// Distinct single cell fills for stacked segments, most countable first.
// The first four are block shades; the ASCII tail keeps wide stacks legible
// on fonts without shade coverage.
const SEGMENT_FILLS: readonly string[] = [
  "█",
  "▓",
  "▒",
  "░",
  "#",
  "+",
  "=",
  "-",
] as const;

// Base frame used when the caller passes no motion: the static shape, so a
// snapshot test and a motion-frozen terminal agree byte for byte.
const BASE_MOTION: MotionContext = { frame: 0, enabled: false, reduced: true };

function resolveMotion(motion: MotionContext | undefined): MotionContext {
  return motion ?? BASE_MOTION;
}

// True only for a live frame: motion on and full motion allowed. Reduced
// motion holds the first frame, which is the base shape by construction.
function isLive(motion: MotionContext): boolean {
  return motion.enabled && !motion.reduced;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

// Compact number text for chart labels. Integers stay exact; floats round to
// two decimals so a cost like 0.333333 does not eat the bar beside it.
function formatNumber(value: number): string {
  if (Number.isNaN(value)) return "?";
  if (!Number.isFinite(value)) return value > 0 ? "+inf" : "-inf";
  if (Number.isInteger(value)) return String(value);
  return String(Math.round(value * 100) / 100);
}

function clamp01(value: number): number {
  if (!isFiniteNumber(value)) return 0;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

// Level 0 to 7 for a value inside [lo, hi]. Callers guarantee hi > lo.
function levelFor(value: number, lo: number, hi: number): number {
  const ratio = clamp01((value - lo) / (hi - lo));
  return Math.round(ratio * (SPARK_LEVELS.length - 1));
}

/**
 * One row sparkline across the full width. The scale comes from the data
 * unless the caller passes min or max, because a forced zero baseline
 * flattens a series that moved a lot and reads as "nothing happened".
 */
export function sparkline(
  series: Series,
  width: number,
  options?: {
    readonly min?: number;
    readonly max?: number;
    readonly motion?: MotionContext;
  },
): string {
  const cells = Math.max(0, Math.floor(width));
  if (cells <= 0) return "";
  const values: readonly number[] = series.values;
  if (values.length === 0) return pad("no data", cells);
  const finite: number[] = values.filter(isFiniteNumber);
  if (finite.length === 0) return pad("no data", cells);
  let lo: number =
    options?.min !== undefined && isFiniteNumber(options.min)
      ? options.min
      : Math.min(...finite);
  let hi: number =
    options?.max !== undefined && isFiniteNumber(options.max)
      ? options.max
      : Math.max(...finite);
  // A caller supplied min above max is a swapped argument, not a request
  // for an inverted chart; honour the range, not the order.
  if (lo > hi) {
    const swap: number = lo;
    lo = hi;
    hi = swap;
  }
  const motion: MotionContext = resolveMotion(options?.motion);
  // A constant series is a fact worth showing. The middle level reads as a
  // level line; the bottom level would read as zero and the top as full.
  if (hi === lo) return SPARK_MID.repeat(cells);
  const count: number = values.length;
  let row = "";
  for (let column = 0; column < cells; column += 1) {
    const sample: number = values[Math.floor((column * count) / cells)]!;
    const base: number = levelFor(isFiniteNumber(sample) ? sample : lo, lo, hi);
    // The newest sample is the live edge of the feed, so it alone pulses by
    // one level on alternate frames. The shape of history never moves.
    const live: boolean =
      isLive(motion) && column === cells - 1 && motion.frame % 2 === 1;
    const level: number = live ? (base < 7 ? base + 1 : base - 1) : base;
    row += SPARK_LEVELS[level]!;
  }
  return row;
}

/**
 * One labelled row per value, most recent first. The operator checks the
 * newest reading first, so it goes on top rather than at the foot of a
 * scroll. Bar fill is decoration: every row also prints its number.
 */
export function barChart(
  series: Series,
  width: number,
  options?: {
    readonly max?: number;
    readonly motion?: MotionContext;
  },
): string[] {
  const cells = Math.max(0, Math.floor(width));
  const values: readonly number[] = series.values;
  // One placeholder row, never zero rows: an empty series is still a state
  // the operator should see named rather than a missing panel.
  if (values.length === 0) return [cells <= 0 ? "" : pad("no data", cells)];
  if (cells <= 0) return values.map(() => "");
  const dataMax: number = values.reduce(
    (top: number, value: number) =>
      isFiniteNumber(value) ? Math.max(top, value) : top,
    0,
  );
  const optMax: number | undefined = options?.max;
  const ceiling: number =
    optMax !== undefined && isFiniteNumber(optMax) ? optMax : dataMax;
  // A zero or negative ceiling means every value is zero or below, so any
  // positive divisor is honest; 1 keeps the bars empty and the numbers exact.
  const safeMax: number = ceiling > 0 ? ceiling : dataMax > 0 ? dataMax : 1;
  const labels: readonly string[] = series.labels ?? [];
  const cleanLabels: string[] = values.map((_, index) =>
    sanitizeText(labels[index] ?? `#${index + 1}`),
  );
  const valueTexts: string[] = values.map((value) =>
    isFiniteNumber(value) ? formatNumber(value) : "?",
  );
  const fullLabelWidth: number = Math.max(
    1,
    ...cleanLabels.map((label) => visibleLength(label)),
  );
  const valueWidth: number = Math.max(
    1,
    ...valueTexts.map((text) => visibleLength(text)),
  );
  // Preserve the historical layout when it fits. At narrow widths, shorten
  // labels before measurements; the bar is optional and never displaces them.
  const labelWidth: number = Math.min(
    fullLabelWidth,
    Math.max(0, cells - valueWidth - 1),
  );
  const barCells: number = Math.max(
    0,
    cells - labelWidth - valueWidth - (labelWidth > 0 ? 2 : 1),
  );
  const motion: MotionContext = resolveMotion(options?.motion);
  const rows: string[] = [];
  for (let order = values.length - 1; order >= 0; order -= 1) {
    const value: number = values[order]!;
    const filled: number = Math.max(
      0,
      Math.min(barCells, Math.round(clamp01(value / safeMax) * barCells)),
    );
    let bar = `${"█".repeat(filled)}${"░".repeat(barCells - filled)}`;
    // Only the newest row pulses, and only its leading filled cell, so the
    // eye finds the current reading without the history shimmering.
    if (
      isLive(motion) &&
      order === values.length - 1 &&
      filled > 0 &&
      motion.frame % 2 === 1
    ) {
      bar = `${"█".repeat(filled - 1)}▓${"░".repeat(barCells - filled)}`;
    }
    const label: string =
      labelWidth > 0 ? `${pad(cleanLabels[order]!, labelWidth)} ` : "";
    const text: string = valueTexts[order]!.padStart(valueWidth, " ");
    const suffix: string = barCells > 0 ? ` ${bar}` : "";
    rows.push(`${label}${text}${suffix}`);
  }
  return rows;
}

/**
 * One proportional bar row plus a legend row. Segments that do not fit keep
 * the largest and name the rest as "+N more": a bar narrower than its own
 * labels would be decoration without information.
 */
export function stackedBar(
  segments: readonly { readonly label: string; readonly value: number }[],
  width: number,
  options?: { readonly motion?: MotionContext },
): string {
  const cells = Math.max(0, Math.floor(width));
  if (cells <= 0) return "";
  if (segments.length === 0) return pad("no segments", cells);
  const motion: MotionContext = resolveMotion(options?.motion);
  const clean = segments.map((segment) => ({
    label: sanitizeText(segment.label),
    value: isFiniteNumber(segment.value) ? Math.max(0, segment.value) : 0,
  }));
  const total: number = clean.reduce((sum, segment) => sum + segment.value, 0);
  // Zero total means shares are undefined, not zero width; name the state
  // instead of dividing by zero or printing an empty bar.
  if (total <= 0) {
    const names: string = clean.map((segment) => segment.label).join(" ");
    return `${pad("no data", cells)}\n${fit(names, cells)}`;
  }
  // Largest first. Each kept segment needs one cell plus one divider except
  // the last, so k segments need 2k - 1 cells; solve for k and keep at
  // least one so the bar never vanishes at a narrow width.
  const ranked = [...clean].sort((a, b) => b.value - a.value);
  const keep: number = Math.max(
    1,
    Math.min(ranked.length, Math.floor((cells + 1) / 2)),
  );
  const shown = ranked.slice(0, keep);
  const dropped: number = ranked.length - keep;
  // One guaranteed cell each, then largest remainder on the rest, so a long
  // tail of small shares cannot round a kept segment down to invisible.
  // Shares divide the space left after dividers and guarantees among the
  // kept segments only, and the legend below names whatever was dropped.
  const dividers: number = keep - 1;
  let rest: number = cells - dividers - keep;
  const shownTotal: number = shown.reduce(
    (sum, segment) => sum + segment.value,
    0,
  );
  const exact: number[] = shown.map((segment) =>
    shownTotal > 0
      ? (segment.value / shownTotal) * Math.max(0, rest)
      : Math.max(0, rest) / shown.length,
  );
  const extra: number[] = exact.map((share) => Math.floor(share));
  rest -= extra.reduce((sum, share) => sum + share, 0);
  const order: number[] = exact
    .map((share, index) => ({ share: share - Math.floor(share), index }))
    .sort((a, b) => b.share - a.share)
    .map((entry) => entry.index);
  for (let rank = 0; rank < rest; rank += 1) {
    extra[order[rank]!]! += 1;
  }
  // Dividers pulse on a live frame so a current breakdown reads as current;
  // segment widths are measurements and never move for motion.
  const divider: string = isLive(motion) && motion.frame % 2 === 1 ? ":" : "|";
  const bar: string = shown
    .map((segment, index) =>
      (SEGMENT_FILLS[index % SEGMENT_FILLS.length] ?? "#").repeat(
        1 + extra[index]!,
      ),
    )
    .join(divider);
  const entries: string[] = shown.map(
    (segment, index) =>
      `${SEGMENT_FILLS[index % SEGMENT_FILLS.length] ?? "#"} ${segment.label} ${formatNumber(segment.value)}`,
  );
  return `${fit(bar, cells)}\n${fitLegend(entries, dropped, cells)}`;
}

// The legend keeps the largest entries that fit and folds the rest into a
// "+N more" marker, smallest first. A hard truncation mid word would leave a
// bar wider than its own explanation, which is the failure this avoids.
function fitLegend(
  entries: readonly string[],
  dropped: number,
  cells: number,
): string {
  const kept: string[] = [...entries];
  let hidden: number = dropped;
  while (kept.length > 0) {
    const suffix: string = hidden > 0 ? `  +${hidden} more` : "";
    if (visibleLength(kept.join("  ") + suffix) <= cells) {
      return fit(kept.join("  ") + suffix, cells);
    }
    kept.pop();
    hidden += 1;
  }
  return fit(hidden > 0 ? `+${hidden} more` : "", cells);
}

/**
 * A compact bar with the value printed as text. The number is the signal
 * and the bar is the glance: a fill alone is unreadable monochrome.
 */
export function gauge(
  value: number,
  max: number,
  options?: { readonly label?: string; readonly motion?: MotionContext },
): string {
  const head: string =
    options?.label !== undefined && sanitizeText(options.label) !== ""
      ? `${sanitizeText(options.label)} `
      : "";
  // A zero or negative max leaves the scale undefined. Report the value and
  // say the scale is unknown rather than printing NaN or an empty bar.
  if (!isFiniteNumber(max) || max <= 0)
    return `${head}${isFiniteNumber(value) ? formatNumber(value) : "?"}/? (max unknown)`;
  if (!isFiniteNumber(value))
    return `${head}?/${formatNumber(max)} (value unknown)`;
  const ratio: number = clamp01(value / max);
  const cells = 8;
  const filled: number = Math.round(ratio * cells);
  let bar = `${"█".repeat(filled)}${"░".repeat(cells - filled)}`;
  const motion: MotionContext = resolveMotion(options?.motion);
  if (
    isLive(motion) &&
    filled > 0 &&
    filled < cells &&
    motion.frame % 2 === 1
  ) {
    bar = `${"█".repeat(filled - 1)}▓${"░".repeat(cells - filled)}`;
  }
  const percent = `${Math.round(ratio * 100)}%`;
  return `${head}${bar} ${formatNumber(value)}/${formatNumber(max)} ${percent}`;
}

/**
 * A signed delta with the direction also stated as a word. The arrow is
 * redundant decoration: rising, falling, flat and unknown carry the meaning
 * for anyone who cannot see the glyph.
 */
export function deltaLabel(
  current: number,
  previous: number,
  options?: { readonly suffix?: string },
): string {
  const suffix: string = options?.suffix ?? "";
  // No previous reading means no trend exists yet. Show the current number
  // when there is one, and always name the state unknown in words.
  if (!isFiniteNumber(current) || !isFiniteNumber(previous)) {
    const head: string = isFiniteNumber(current)
      ? `${formatNumber(current)}${suffix} `
      : "";
    return `${head}? unknown`;
  }
  const diff: number = current - previous;
  if (diff > 0) return `+${formatNumber(diff)}${suffix} ▲ rising`;
  if (diff < 0) return `${formatNumber(diff)}${suffix} ▼ falling`;
  return `±0${suffix} flat`;
}

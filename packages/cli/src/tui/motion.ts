import type { Tone } from "./theme.ts";
import { fit, pad, visibleLength } from "./layout.ts";

// Motion and effects for the workspace frame.
//
// Two rules shape everything here. First, every animation is a pure function
// of a frame counter, so two renders at the same counter are byte identical
// and a paused frame is reproducible. That is what lets the test suite assert
// on motion output and what lets NOMO_TUI_MOTION=0 freeze the frame instead
// of degrading it. Second, no effect ever carries meaning that text does not
// already carry. A pulsing approval banner is fine; a pulsing one where the
// colour is the only signal is not, because colour and motion both fail the
// same way on a monochrome terminal and on a screen reader.

export type EffectKind =
  | "pulse" // brighten and dim in place
  | "blink" // step between two states
  | "breathe" // slow sine, for idle attention
  | "sweep" // a travelling highlight across a row
  | "shimmer" // travelling highlight across a bar
  | "marquee"; // scroll text horizontally

/** A frame counter. Every effect is a pure function of this. */
export interface MotionContext {
  readonly frame: number;
  /** NOMO_TUI_MOTION=0 sets this false. Effects then render their base frame. */
  readonly enabled: boolean;
  /** When true, effects hold their first frame instead of animating. */
  readonly reduced: boolean;
}

export function motionContext(
  frame: number,
  enabled = true,
  reduced = false,
): MotionContext {
  return { frame, enabled, reduced };
}

// Braille spinner: ten frames, one cell each, widely supported and slower
// than a block spinner so a busy run does not strobe.
export const SPINNER = [
  "⠋",
  "⠙",
  "⠹",
  "⠸",
  "⠼",
  "⠴",
  "⠦",
  "⠧",
  "⠇",
  "⠏",
] as const;

/**
 * A spinner with a heavier cadence, for destructive states.
 *
 * Used where the next outcome is a refusal rather than a result, so the
 * motion is slower and the state reads as caution rather than as progress.
 */
export const HEAVY_SPINNER = ["◐", "◓", "◑", "◒"] as const;

// The wave used by the running indicator. Reading it as a wave rather than as
// noise is why it stays: one lit cell per column, moving right.
const WAVE = [0, 0.25, 0.5, 0.75, 1, 0.75, 0.5, 0.25] as const;

function waveAt(column: number, frame: number, phase: number): number {
  const position = (column + phase) % WAVE.length;
  return WAVE[position] ?? 0;
}

/**
 * A progress bar with a lit wave travelling across the filled portion.
 * The bar is plain text, so the shape is readable without colour and the
 * motion is decoration on top of a real measurement.
 */
export function animatedBar(
  value: number,
  max: number,
  width: number,
  motion: MotionContext,
  options: {
    readonly tone?: Tone;
    readonly paint?: (text: string, tone: Tone, bold?: boolean) => string;
  } = {},
): string {
  const safeMax = Math.max(1, max);
  const cells = Math.max(
    0,
    Math.min(width, Math.round((value / safeMax) * width)),
  );
  const paint = options.paint ?? ((text: string) => text);
  const tone = options.tone ?? "accent";
  let bar = "";
  for (let column = 0; column < width; column += 1) {
    if (column >= cells) {
      bar += paint("░", "muted");
      continue;
    }
    const lit =
      motion.enabled && !motion.reduced
        ? waveAt(column, motion.frame, 0) > 0.6
        : column % 2 === 0;
    bar += lit ? paint("█", tone, true) : paint("▓", tone);
  }
  return bar;
}

/**
 * The running indicator. A spinner plus a moving caret reads as live work,
 * and the label beside it still states the phase in words.
 */
export function runningIndicator(motion: MotionContext): string {
  const index =
    motion.enabled && !motion.reduced ? motion.frame % SPINNER.length : 0;
  return SPINNER[index] ?? SPINNER[0]!;
}

/**
 * A pulsing marker for a pending approval. Pulse, never blink: blink reads as
 * an alarm, and an approval waiting on a human is not an error.
 */
export function approvalPulse(motion: MotionContext): string {
  const steps = ["◉", "◎", "○", "◎"] as const;
  const index =
    motion.enabled && !motion.reduced ? motion.frame % steps.length : 0;
  return steps[index] ?? steps[0]!;
}

/**
 * The marker for a state whose outcome is a refusal rather than a result.
 * Half the speed of the running spinner on purpose: a fast spinner next to a
 * pending refusal draws the eye to the decoration instead of the words.
 */
export function cautionSpinner(motion: MotionContext): string {
  const index =
    motion.enabled && !motion.reduced
      ? Math.floor(motion.frame / 2) % HEAVY_SPINNER.length
      : 0;
  return HEAVY_SPINNER[index] ?? HEAVY_SPINNER[0]!;
}

/**
 * A progress wave for the header. Returns one styled row: the mark, a phase
 * label, and the wave across the remaining width. The label is always present
 * so the motion never carries the meaning on its own.
 */
export function phaseWave(
  label: string,
  width: number,
  motion: MotionContext,
  options: {
    readonly paint?: (text: string, tone: Tone, bold?: boolean) => string;
  } = {},
): string {
  const paint = options.paint ?? ((text: string) => text);
  const head = ` ${label} `;
  const tail = Math.max(0, width - visibleLength(head));
  let row = paint(head, "accent", true);
  for (let column = 0; column < tail; column += 1) {
    const level =
      motion.enabled && !motion.reduced
        ? waveAt(column, motion.frame, 2)
        : (column % 4) / 4;
    const glyph = level > 0.75 ? "━" : level > 0.4 ? "─" : "╌";
    row += paint(glyph, level > 0.75 ? "accent" : "muted");
  }
  return fit(row, width);
}

/**
 * A tab underline that animates its weight. The active tab keeps a filled bar
 * and the inactive ones a thin one, so the selected panel is visible without
 * colour and the animation only draws the eye.
 */
export function tabUnderline(
  active: boolean,
  width: number,
  motion: MotionContext,
): string {
  if (!active) return "╌".repeat(Math.max(0, width));
  const pattern =
    motion.enabled && !motion.reduced ? ["━", "━", "━", "━"] : ["━"];
  const bar = pattern[motion.frame % pattern.length] ?? "━";
  return bar.repeat(Math.max(0, width));
}

/**
 * A stable selection marker for list rows. Selection is structural state, not
 * activity: changing its glyph on every motion frame repaints a stationary
 * row twice a second and makes an otherwise static panel feel like it is
 * flickering. Reserve motion for live work indicators.
 */
export function cursorMarker(
  selected: boolean,
  _motion: MotionContext,
): string {
  if (!selected) return "  ";
  return "▸ ";
}

/**
 * A breathing dot for idle attention. Slow sine, so it reads as calm rather
 * than as activity.
 */
export function idleBreath(motion: MotionContext): string {
  if (!motion.enabled || motion.reduced) return "·";
  const steps = ["·", "•", "●", "•"] as const;
  const index = Math.floor(motion.frame / 3) % steps.length;
  return steps[index] ?? "·";
}

/**
 * A sweeping highlight across a row, used when a result set changes. Returns
 * the row with the sweep applied, or the row unchanged when motion is off.
 * The sweep is bounded so it never widens the row.
 */
export function sweepRow(
  row: string,
  width: number,
  motion: MotionContext,
  options: {
    readonly paint?: (text: string, tone: Tone, bold?: boolean) => string;
  } = {},
): string {
  if (!motion.enabled || motion.reduced) return fit(row, width);
  const paint = options.paint ?? ((text: string) => text);
  const span = Math.max(0, visibleLength(row));
  const cursor = motion.frame % (span + 4);
  const plain = [...row];
  return fit(
    plain
      .map((char, index) =>
        Math.abs(index - cursor) < 2 && char !== " "
          ? paint(char, "warning", true)
          : char,
      )
      .join(""),
    width,
  );
}

/** A padded status label. Its text stays meaningful without colour. */
export function pill(
  label: string,
  tone: Tone,
  motion: MotionContext,
  options: {
    readonly paint?: (text: string, tone: Tone, bold?: boolean) => string;
    readonly filled?: boolean;
  } = {},
): string {
  const paint = options.paint ?? ((text: string) => text);
  const text = ` ${label} `;
  return paint(text, tone, options.filled === true);
}

/**
 * A completion ring for a verified object. The ring closes as the value
 * approaches its maximum, so the shape itself reports the measurement.
 */
export function completionRing(
  value: number,
  max: number,
  _motion: MotionContext,
): string {
  const safeMax = Math.max(1, max);
  const filled = Math.max(0, Math.min(8, Math.round((value / safeMax) * 8)));
  const frames = ["◯", "◔", "◑", "◕", "●"] as const;
  const index = Math.min(
    frames.length - 1,
    Math.ceil((filled / 8) * (frames.length - 1)),
  );
  // A frozen frame still reports the measured completion; motion never
  // substitutes a generic empty ring for a completed or failed result.
  return frames[index] ?? frames[0]!;
}

/**
 * A separator that carries activity. A running session gets a lit separator
 * so the boundary between panes is visible while work is in flight.
 */
export function separator(
  width: number,
  motion: MotionContext,
  active = false,
): string {
  if (!active) return "─".repeat(Math.max(0, width));
  const glyphs = ["╌", "─", "━", "─"] as const;
  const index =
    motion.enabled && !motion.reduced ? motion.frame % glyphs.length : 1;
  const glyph = glyphs[index] ?? "─";
  return glyph.repeat(Math.max(0, width));
}

/**
 * A bar that fills left to right and loops while a run is active. Used for an
 * indeterminate operation, where there is no honest percentage to show.
 */
export function indeterminateBar(width: number, motion: MotionContext): string {
  const cells = Math.max(0, width);
  // A frozen bar must not read as a fraction: a static four-of-twelve fill is
  // indistinguishable from a determinate 33 %. When motion is off, say
  // "unknown" in a shape that cannot be mistaken for progress.
  if (!motion.enabled || motion.reduced) return `?${"·".repeat(Math.max(0, cells - 1))}`;
  const head = motion.frame % (cells + 6);
  let bar = "";
  for (let column = 0; column < cells; column += 1) {
    const distance = column - head;
    bar +=
      distance >= 0 && distance < 4
        ? "█"
        : distance < 0 && distance > -4
          ? "░"
          : "·";
  }
  return bar;
}

/**
 * A stepper for multi-phase work. Each phase gets a glyph: done, active, or
 * pending. The active phase pulses, and the phase name is always printed
 * beside it so the ordering is readable as text.
 */
export function stepper(
  phases: readonly string[],
  current: number,
  motion: MotionContext,
): string[] {
  return phases.map((phase, index) => {
    if (index < current) return `[${phase}]`;
    if (index === current) {
      const marker =
        motion.enabled && !motion.reduced ? approvalPulse(motion) : "▸";
      return `<${marker} ${phase}>`;
    }
    return `  ${phase}  `;
  });
}

/**
 * A level meter for token or context usage. Segments rather than a bar, so a
 * high value is countable at a glance and the segments survive a narrow
 * terminal better than a continuous bar.
 */
export function levelMeter(
  value: number,
  max: number,
  segments = 8,
  motion: MotionContext,
  options: {
    readonly paint?: (text: string, tone: Tone, bold?: boolean) => string;
  } = {},
): string {
  const paint = options.paint ?? ((text: string) => text);
  const safeMax = Math.max(1, max);
  const filled = Math.max(
    0,
    Math.min(segments, Math.round((value / safeMax) * segments)),
  );
  const ratio = value / safeMax;
  const tone: Tone = ratio > 0.9 ? "r3" : ratio > 0.7 ? "r2" : "accent";
  const glyphs = motion.enabled && !motion.reduced ? ["▰", "▱"] : ["▰", "▱"];
  let out = "";
  for (let index = 0; index < segments; index += 1) {
    out +=
      index < filled ? paint(glyphs[0]!, tone) : paint(glyphs[1]!, "muted");
  }
  return out;
}

/**
 * A marquee for a long single-line value such as a model id or a path. The
 * text scrolls only when it does not fit, and it is padded to width so the
 * rest of the row does not jitter.
 */
export function marquee(
  text: string,
  width: number,
  motion: MotionContext,
): string {
  if (width <= 0) return "";
  const plain = [...text];
  if (plain.length <= width) return pad(text, width);
  const start =
    motion.enabled && !motion.reduced ? motion.frame % plain.length : 0;
  const window = plain
    .slice(start, start + width)
    .concat(plain)
    .slice(0, width)
    .join("");
  return pad(window, width);
}

/**
 * A type-on cursor. The block cursor blinks on a slow cycle; a fast blink is
 * the most common source of visual noise in a terminal UI.
 */
export function typeCursor(editing: boolean, motion: MotionContext): string {
  if (!editing) return " ";
  const cycle =
    motion.enabled && !motion.reduced ? Math.floor(motion.frame / 4) % 2 : 1;
  return cycle === 0 ? "▌" : "█";
}

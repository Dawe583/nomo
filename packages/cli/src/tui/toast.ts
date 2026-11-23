import { fit, sanitizeText, visibleLength } from "./layout.ts";
import { NOMO_PALETTE, paintWithPalette } from "./theme.ts";

// A toast queue that never blocks the operator and never hides a safety
// state. OMP pairs desktop notifications with in TUI toasts; NOMO had only
// a single notice string, so a second event overwrote the first and a slow
// terminal could scroll the prompt away. This module caps the visible queue,
// keeps sticky safety toasts past every timer, and keeps every state legible
// as plain text so colour is decoration, never signal.

export type ToastTone = "info" | "success" | "warning" | "danger" | "pending";

export interface Toast {
  readonly id: string;
  readonly tone: ToastTone;
  readonly message: string;
  readonly icon: string;
  /** Milliseconds since the toast was raised. Used for expiry and ordering. */
  readonly at: number;
  /** Milliseconds the toast stays visible. 0 means it never expires. */
  readonly ttl: number;
}

export interface ToastHost {
  readonly toasts: readonly Toast[];
  /** The toast currently on screen, or undefined when the queue is empty. */
  readonly active: Toast | undefined;
}

export interface ToastLimits {
  readonly max: number;
  readonly defaultTtl: number;
}

// Four lines fit above the prompt on an 80x24 terminal without pushing
// input off screen; four seconds matches a readable glance, not a stare.
export const DEFAULT_TOAST_LIMITS: ToastLimits = {
  max: 4,
  defaultTtl: 4000,
} as const;

// Single cell only. layout.ts counts U+2600 to U+27BF as two cells, so the
// pictographs that would be the obvious choices here (U+2715, U+2716) would
// misalign every fitted line; visibleLength below turns a bad table entry into
// a readable mark rather than a line that is one cell too wide. U+00D7 and
// U+25CF are Latin-1 and Geometric Shapes, both one cell everywhere.
const TOAST_ICONS: Record<ToastTone, string> = {
  info: "i",
  success: "●",
  warning: "!",
  danger: "×",
  pending: "◉",
};

export function toastIcon(tone: ToastTone): string {
  const icon = TOAST_ICONS[tone];
  // A corrupt table must not emit a wide or empty glyph into width math.
  return visibleLength(icon) === 1 ? icon : "?";
}

// Tones that carry a pending operator obligation. The cap may not evict
// these while any droppable toast remains.
function isSafetyTone(tone: ToastTone): boolean {
  return tone === "danger" || tone === "pending";
}

// Normal toasts are expendable under pressure; warnings keep their slot
// because they also carry risk, just not an open obligation.
function isDroppableTone(tone: ToastTone): boolean {
  return tone === "info" || tone === "success";
}

function toHost(toasts: readonly Toast[]): ToastHost {
  const list: readonly Toast[] = [...toasts];
  return { toasts: list, active: list[0] };
}

export function raiseToast(
  host: ToastHost,
  toast: Toast,
  limits: ToastLimits = DEFAULT_TOAST_LIMITS,
): ToastHost {
  // A negative ttl is a caller asking for the default without knowing it;
  // 0 stays sticky and positive stays explicit, so only negatives map.
  const ttl: number = toast.ttl < 0 ? limits.defaultTtl : toast.ttl;
  const raised: Toast = { ...toast, ttl };
  // Replace by id first: one run state means one toast, and the newest
  // report moves to the front where the operator is looking.
  const rest: Toast[] = host.toasts.filter((entry) => entry.id !== raised.id);
  const next: Toast[] = [raised, ...rest];
  const cap: number = Math.max(0, limits.max);
  // Evict from the oldest end. A safety toast at the cap boundary yields
  // its eviction to the oldest normal toast instead, so a pending approval
  // is never dropped silently by chatter. When nothing droppable remains,
  // the cap applies as written rather than growing the queue past the
  // prompt.
  while (next.length > cap) {
    const oldest: Toast | undefined = next[next.length - 1];
    if (oldest !== undefined && isSafetyTone(oldest.tone)) {
      let victim = -1;
      for (let index = next.length - 1; index >= 0; index -= 1) {
        if (isDroppableTone(next[index]!.tone)) {
          victim = index;
          break;
        }
      }
      if (victim === -1) {
        next.pop();
        continue;
      }
      next.splice(victim, 1);
      continue;
    }
    next.pop();
  }
  return toHost(next);
}

export function expireToasts(host: ToastHost, now: number): ToastHost {
  // Sticky toasts (ttl 0) carry open obligations such as a pending approval,
  // so a timer must never clear them; only positive ttl toasts age out.
  const kept: Toast[] = host.toasts.filter(
    (entry) => entry.ttl === 0 || now - entry.at < entry.ttl,
  );
  if (kept.length === host.toasts.length) return host;
  return toHost(kept);
}

export function dismissToast(host: ToastHost, id: string): ToastHost {
  const kept: Toast[] = host.toasts.filter((entry) => entry.id !== id);
  if (kept.length === host.toasts.length) return host;
  return toHost(kept);
}

// Palette keys have no pending slot, so pending shares the warning colour;
// the text marker below stays authoritative in every mode.
const TOAST_PALETTE_KEY: Record<
  ToastTone,
  "info" | "success" | "warning" | "error"
> = {
  info: "info",
  success: "success",
  warning: "warning",
  danger: "error",
  pending: "warning",
};

export function renderToasts(
  host: ToastHost,
  width: number,
  options?: { color?: boolean },
): string[] {
  if (host.toasts.length === 0) return [];
  if (width <= 0) return [];
  const useColor: boolean = options?.color === true;
  return host.toasts.map((entry) => {
    // Sanitize at render, not at raise: a host built by hand must still be
    // safe, and sanitizeText turns agent supplied controls into visible
    // marks instead of cursor movement. Newlines become "?" there too, so
    // one toast can never claim two lines.
    const fittedIcon = fit(sanitizeText(entry.icon), 1);
    const icon = visibleLength(fittedIcon) === 1 ? fittedIcon : "?";
    const line = fit(
      `${icon} [${entry.tone.toUpperCase()}] ${sanitizeText(entry.message)}`,
      width,
    );
    if (!useColor) return line;
    return paintWithPalette(
      line,
      TOAST_PALETTE_KEY[entry.tone],
      NOMO_PALETTE,
      {
        interactive: true,
        ansi: true,
        colorDepth: 24,
        columns: width,
        rows: host.toasts.length,
        reason: "interactive",
      },
      isSafetyTone(entry.tone),
    );
  });
}

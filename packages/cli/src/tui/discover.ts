import { sanitizeText, visibleLength } from "./layout.ts";
import {
  idleBreath,
  levelMeter,
  motionContext,
  type MotionContext,
} from "./motion.ts";
import { renderInspector, type Field, type FieldTone } from "./inspector.ts";

// Discovery panel for the operator who knows five commands out of sixty
// seven. Commands are grouped by the task the operator arrived with, so a
// newcomer scans tasks instead of memorising slash names.

// The tasks a person actually arrives with, in arrival order. Newcomers
// think in tasks, not in declaration order, so groupedCommands follows
// this order rather than the order commands were registered in.
export const DISCOVERY_GROUPS: readonly string[] = [
  "starting",
  "reading",
  "writing",
  "running",
  "watching",
  "sharing",
  "configuring",
];

// One icon per group, each verified single cell. layout.ts counts U+2600
// to U+27BF as two cells, so these stay in the geometric and arrow ranges
// below U+2600 plus plain ASCII; a two cell icon would shift every column
// after it in the aligned inspector output.
const GROUP_ICONS: Record<string, string> = {
  starting: "▷",
  reading: "≡",
  writing: "+",
  running: "↻",
  watching: "◉",
  sharing: "⇥",
  configuring: "⌘",
};

// Plain language purpose per group. The overview row shows this instead of
// a command dump, because a newcomer first needs to know which task a
// group serves before learning any slash names.
const GROUP_BLURBS: Record<string, string> = {
  starting: "Start a session and find your way",
  reading: "Find and read what is already there",
  writing: "Change files and record why",
  running: "Run work and follow its progress",
  watching: "Check health, holds and history",
  sharing: "Bring other people and agents along",
  configuring: "Tune keys, models and defaults",
};

// Deliberate absences, matching what the workspace already tells the
// operator: background tasks, clipboard image paste and text paste, voice,
// and Vim editing have no NOMO equivalent. Each sentence says what to do instead, so an operator
// who expected the feature learns it is absent on purpose rather than
// assuming it is broken.
const ABSENT: readonly string[] = [
  "Background tasks have no equivalent here -- keep the session open while a run works instead of parking it in the background.",
  "Clipboard paste has no shortcut beyond the operating system's normal terminal paste; clipboard image attachments are unsupported.",
  "Live voice and speech input have no NOMO TUI backend here.",
  "Vim editing has no equivalent here -- press Ctrl+G for the configured editor, or type directly at the prompt.",
];

/** One command, in the shape the panel needs. */
export interface CommandEntry {
  /** The command as the operator types it, for example "/keybindings". */
  readonly id: string;
  /** One line saying what it does. */
  readonly summary: string;
  /** The task the operator is trying to do, for example "reading". */
  readonly group?: string;
}

export interface DiscoveryOptions {
  readonly width: number;
  readonly motion?: MotionContext;
  readonly paint?: (text: string, tone: string, bold?: boolean) => string;
}

export function groupIcon(group: string): string {
  const key = sanitizeText(group).trim().toLowerCase();
  const candidate = GROUP_ICONS[key] ?? "?";
  // Any input, including empty and malformed, must yield exactly one cell:
  // the lookup already falls back to "?", and this guard catches a future
  // icon edit that accidentally introduces a wide glyph.
  return visibleLength(candidate) === 1 ? candidate : "?";
}

export function groupTitle(group: string): string {
  const clean = sanitizeText(group);
  // Uppercase titles make a long grouped list skimmable. An unrecognised
  // group is returned unchanged rather than invented, because a made up
  // name would promise a task grouping that does not exist.
  if (DISCOVERY_GROUPS.includes(clean.trim().toLowerCase()))
    return clean.trim().toUpperCase();
  return clean;
}

// Normalise a raw group into its canonical bucket. Matching is case
// insensitive so "Reading" and "reading" do not split one task into two
// headings. Commands with no group land in "other" so they stay visible
// instead of vanishing from the panel.
function canonicalGroup(raw: string | undefined): string {
  const key = sanitizeText(raw ?? "")
    .trim()
    .toLowerCase();
  if (key === "") return "other";
  if (DISCOVERY_GROUPS.includes(key)) return key;
  return key;
}

/** Commands grouped, with a count per group. */
export function groupedCommands(
  commands: readonly CommandEntry[],
): { readonly group: string; readonly commands: readonly CommandEntry[] }[] {
  // An empty input still returns one named heading: an empty array reads as
  // "the list failed", while a named empty group lets the panel print an
  // honest "no commands" line under it.
  if (commands.length === 0)
    return [{ group: DISCOVERY_GROUPS[0] ?? "general", commands: [] }];
  const buckets = new Map<string, CommandEntry[]>();
  for (const command of commands) {
    const key = canonicalGroup(command.group);
    const bucket = buckets.get(key);
    if (bucket !== undefined) bucket.push(command);
    else buckets.set(key, [command]);
  }
  const out: {
    readonly group: string;
    readonly commands: readonly CommandEntry[];
  }[] = [];
  for (const known of DISCOVERY_GROUPS) {
    const bucket = buckets.get(known);
    // Empty headings cannot appear: a group is only pushed when at least
    // one command landed in it, so "none of this exists" never looks like
    // a rendering failure.
    if (bucket !== undefined && bucket.length > 0) {
      out.push({ group: known, commands: bucket });
      buckets.delete(known);
    }
  }
  // Anything unrecognised sorts last, alphabetically by code unit order
  // rather than locale order, so two runs in different locales agree byte
  // for byte.
  const rest = [...buckets.entries()].sort((a, b) =>
    a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0,
  );
  for (const [name, bucket] of rest) {
    if (bucket.length > 0) out.push({ group: name, commands: bucket });
  }
  if (out.length === 0)
    return [{ group: DISCOVERY_GROUPS[0] ?? "general", commands: [] }];
  return out;
}

// Purpose line for a group heading. Unknown groups get a generic sentence
// rather than an invented task name, for the same reason groupTitle does
// not invent names.
function groupBlurb(group: string): string {
  return GROUP_BLURBS[group] ?? "More commands outside the main tasks";
}

/** One line per group: how many commands and what the group is for. */
export function discoveryRows(
  commands: readonly CommandEntry[],
  options?: DiscoveryOptions,
): string[] {
  const width = Number.isFinite(options?.width ?? 0)
    ? Math.max(1, Math.floor(options?.width ?? 0))
    : 1;
  // Frozen first frame by default, so two calls with the same input are
  // byte identical and the panel never animates unless asked to.
  const motion: MotionContext =
    options?.motion ?? motionContext(0, false, true);
  const outerPaint = options?.paint;
  const paint =
    outerPaint === undefined
      ? undefined
      : (text: string, tone: FieldTone, bold?: boolean): string =>
          outerPaint(text, tone, bold);
  const total = commands.length;
  // The breathing dot marks the panel as live, while the words beside it
  // carry the meaning, so nothing is lost on a monochrome terminal.
  const icon = idleBreath(motion);
  if (commands.length === 0) {
    // One section with no fields and an explicit body line: the inspector
    // prints "No entries." plus the body, so the panel never renders empty.
    return renderInspector(
      {
        title: "Discovery",
        subtitle: "0 commands in 0 groups",
        icon,
        sections: [
          { title: "Groups", fields: [], body: ["No commands registered."] },
        ],
      },
      { width, motion, paint },
    );
  }
  const groups = groupedCommands(commands);
  const subtitle =
    total === 1
      ? "1 command in 1 group"
      : `${total} commands in ${groups.length} groups`;
  // One field per group: the inspector is the single column renderer, so
  // labels align without a second implementation. The count rides as a
  // padded badge, legible without colour; the meter beside the blurb
  // shows the group's share as shape, never as the only signal.
  const fields: Field[] = groups.map((entry) => ({
    label: `${groupIcon(entry.group)} ${groupTitle(entry.group)}`,
    value: `${groupBlurb(entry.group)} ${levelMeter(entry.commands.length, Math.max(1, total), 4, motion)}`,
    badge: `${entry.commands.length}`,
  }));
  return renderInspector(
    {
      title: "Discovery",
      subtitle,
      icon,
      sections: [{ title: "Groups", fields }],
      // The count of what this product deliberately lacks belongs on the
      // panel itself, so the operator meets it next to the counts of what
      // exists. Narrow terminals drop overlong hints by design.
      hint: `${ABSENT.length} capabilities deliberately absent -- see the absent list.`,
    },
    { width, motion, paint },
  );
}

/** The commands this product deliberately does not have, named and said. */
export function absentCapabilities(): string[] {
  // A fresh copy each call: callers can reorder or trim for display
  // without corrupting the module constant for the next caller.
  return [...ABSENT];
}

import { sanitizeText } from "./layout.ts";
import { idleBreath, motionContext, type MotionContext } from "./motion.ts";
import {
  renderInspector,
  type Field,
  type FieldTone,
  type InspectorSpec,
  type Section,
} from "./inspector.ts";

export interface Binding {
  /** The key as printed, for example "Ctrl+P" or "Shift+Tab". */
  readonly keys: string;
  /** What it does, in one short line. */
  readonly action: string;
  /** Which situation it applies to: "always", "editing", "running", "review". */
  readonly when: "always" | "editing" | "running" | "review";
  /** Alternative keys for the same action, if any. */
  readonly also?: readonly string[];
}

export type CheatSheetState = "closed" | "open" | "open-filtered";

export interface CheatSheetOptions {
  readonly width: number;
  readonly height?: number;
  readonly motion?: MotionContext;
  readonly paint?: (text: string, tone: string, bold?: boolean) => string;
}

// The keys below are restated here rather than derived from
// shortcutHintsFor in shortcuts.ts. The legend groups hints by presentation
// category (nav, edit, action, mode, panel, approval) while this sheet groups
// by situation (always, editing, running, review), so deriving one from the
// other would silently misfile keys every time the legend gains a hint.
const ALWAYS_BINDINGS: readonly Binding[] = [
  { keys: "Tab", action: "switch panels", when: "always" },
  { keys: "Shift+Tab", action: "cycle mode", when: "always" },
  { keys: "Enter", action: "open details", when: "always" },
  { keys: "u", action: "undo last change", when: "always" },
  {
    keys: "Ctrl+P",
    action: "command palette",
    when: "always",
    also: ["Ctrl+N"],
  },
  { keys: "?", action: "this cheat sheet", when: "always" },
];

const EDITING_BINDINGS: readonly Binding[] = [
  {
    keys: "Shift+Enter",
    action: "insert newline",
    when: "editing",
    also: ["Ctrl+J"],
  },
  { keys: "Ctrl+R", action: "search composer", when: "editing" },
  { keys: "Ctrl+O", action: "toggle output", when: "editing" },
  { keys: "Ctrl+T", action: "toggle todos", when: "editing" },
  { keys: "/", action: "command menu", when: "editing" },
];

const RUNNING_BINDINGS: readonly Binding[] = [
  { keys: "/queue", action: "queue next prompt", when: "running" },
];

const REVIEW_BINDINGS: readonly Binding[] = [
  { keys: "y", action: "accept hunk", when: "review" },
  { keys: "n", action: "reject hunk", when: "review" },
  { keys: "a", action: "approve call", when: "review" },
  { keys: "d", action: "deny call", when: "review" },
  { keys: "PgUp/PgDn", action: "scroll diff", when: "review" },
  { keys: "1-9", action: "toggle hunks", when: "review" },
];

// One Esc key with one current meaning. The legend resolves Esc the same way
// (review, then run, then back), so the sheet agrees with the bar at the
// bottom of the frame instead of listing the same key twice with conflicting
// actions.
function escBindingFor(context: {
  readonly editing: boolean;
  readonly running: boolean;
  readonly reviewing: boolean;
}): Binding {
  if (context.reviewing)
    return { keys: "Esc", action: "cancel review", when: "review" };
  if (context.running)
    return { keys: "Esc", action: "stop run", when: "running" };
  return { keys: "Esc", action: "back", when: "always" };
}

export function bindingsFor(context: {
  readonly editing: boolean;
  readonly running: boolean;
  readonly reviewing: boolean;
}): Binding[] {
  const out: Binding[] = [...ALWAYS_BINDINGS, escBindingFor(context)];
  if (context.editing) out.push(...EDITING_BINDINGS);
  if (context.running) out.push(...RUNNING_BINDINGS);
  if (context.reviewing) out.push(...REVIEW_BINDINGS);
  return out;
}

export function filterBindings(
  bindings: readonly Binding[],
  query: string,
): Binding[] {
  const needle = query.trim().toLowerCase();
  if (needle === "") return [...bindings];
  // Keys, actions and alternatives share one haystack so an operator who
  // remembers any of them finds the row. Lowercase both sides for case
  // insensitive matching; an empty result is honest and the caller says so.
  return bindings.filter((binding) =>
    [binding.keys, binding.action, ...(binding.also ?? [])]
      .join(" ")
      .toLowerCase()
      .includes(needle),
  );
}

const GROUP_ORDER: readonly Binding["when"][] = [
  "always",
  "editing",
  "running",
  "review",
];

const GROUP_TITLES: Record<Binding["when"], string> = {
  always: "Always",
  editing: "Editing",
  running: "Running",
  review: "Review",
};

// Alternatives sit beside the primary key in parentheses so the row is found
// by either name without ever hiding the canonical key.
function bindingField(binding: Binding): Field {
  const keys =
    binding.also === undefined || binding.also.length === 0
      ? binding.keys
      : `${binding.keys} (${binding.also.join(", ")})`;
  return { label: keys, value: binding.action };
}

/** One line: how many bindings are shown out of how many exist. */
export function cheatSheetCount(
  bindings: readonly Binding[],
  shown: number,
): string {
  const total = bindings.length;
  const safeShown = Math.max(0, Math.floor(shown));
  return `${safeShown} of ${total} bindings`;
}

export function renderCheatSheet(
  state: { readonly bindings: readonly Binding[]; readonly query: string },
  options: CheatSheetOptions,
): string[] {
  const width = Number.isFinite(options.width)
    ? Math.max(1, Math.floor(options.width))
    : 1;
  // Frozen first frame unless the caller passes motion: two renders of the
  // same state stay byte identical and tests can assert on the output.
  const motion: MotionContext = options.motion ?? motionContext(0, false, true);
  const outerPaint = options.paint;
  const paint =
    outerPaint === undefined
      ? undefined
      : (text: string, tone: FieldTone, bold?: boolean): string =>
          outerPaint(text, tone, bold);
  // Sanitize before echo: the query is typed by the operator and could carry
  // control characters that would otherwise reach the terminal raw. The
  // inspector sanitizes again on render, which is harmless.
  const cleanQuery = sanitizeText(state.query.trim());
  const sections: Section[] = [];
  if (state.bindings.length === 0) {
    // Never a blank sheet: an empty render reads as a failure, so the sheet
    // says in words that there is nothing to show and why.
    sections.push({
      title: "Results",
      fields: [],
      body: [
        cleanQuery === ""
          ? "No bindings to show."
          : `No bindings match "${cleanQuery}".`,
      ],
    });
  } else {
    // Groups in fixed order so the keys that matter right now come first
    // and the sheet has the same shape in every context.
    for (const when of GROUP_ORDER) {
      const group = state.bindings.filter((binding) => binding.when === when);
      if (group.length === 0) continue;
      sections.push({
        title: GROUP_TITLES[when],
        fields: group.map(bindingField),
      });
    }
  }
  const count = cheatSheetCount(state.bindings, state.bindings.length);
  const spec: InspectorSpec = {
    title: "Cheat sheet",
    subtitle: cleanQuery === "" ? count : `Filter "${cleanQuery}" .. ${count}`,
    icon: "?",
    sections,
    // The breathing dot is decoration only: the words beside it carry the
    // guidance, so the hint survives a monochrome terminal.
    hint: `Type to filter. Esc closes. ${idleBreath(motion)}`,
  };
  // The inspector owns width fitting and height clipping, so this render
  // inherits its guarantees: every row fits and the result is at least one
  // row and at most height when height is given.
  return renderInspector(spec, {
    width,
    height: options.height,
    motion,
    paint,
  });
}

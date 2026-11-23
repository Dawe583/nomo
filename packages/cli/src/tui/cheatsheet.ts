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
  {
    keys: "Tab",
    action: "complete Chat suggestions, focus composer, or return from a panel",
    when: "always",
  },
  { keys: "Shift+Tab", action: "cycle local mode", when: "always" },
  {
    keys: "Enter",
    action: "inspect selected row; tree groups and folders toggle",
    when: "always",
  },
  { keys: "u", action: "undo last change", when: "always" },
  {
    keys: "Alt+M",
    action: "open the connected-provider model picker",
    when: "always",
  },
  {
    keys: "Alt+P",
    action: "choose a model for the current conversation",
    when: "always",
  },
  { keys: "Alt+A", action: "open the Agents panel", when: "always" },
  { keys: "Alt+L", action: "redraw the current terminal view", when: "always" },
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
  { keys: "Ctrl+T", action: "transpose adjacent characters", when: "editing" },
  {
    keys: "Ctrl+] / Ctrl+Alt+], then a character",
    action: "jump to the next or previous match",
    when: "editing",
  },
  {
    keys: "Alt+D / Alt+Delete",
    action: "delete the next word",
    when: "editing",
  },
  {
    keys: "Alt+Backspace / Ctrl+Backspace / Ctrl+W",
    action: "delete the previous word",
    when: "editing",
  },
  { keys: "Ctrl+K", action: "delete to end of prompt", when: "editing" },
  { keys: "Ctrl+U", action: "delete to start of prompt", when: "editing" },
  { keys: "Ctrl+P", action: "command palette", when: "editing" },
  { keys: "Alt+Shift+C", action: "copy the Chat prompt", when: "editing" },
  { keys: "Alt+Shift+P", action: "toggle local plan mode", when: "editing" },
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
  readonly backable?: boolean;
}): Binding {
  if (context.reviewing)
    return { keys: "Esc", action: "cancel review", when: "review" };
  if (context.backable)
    return {
      keys: "Esc",
      action: "close the current overlay, detail or filter",
      when: "always",
    };
  if (context.running)
    return { keys: "Esc", action: "stop run", when: "running" };
  return { keys: "Esc", action: "back", when: "always" };
}

export function bindingsFor(context: {
  readonly editing: boolean;
  readonly running: boolean;
  readonly suspendSupported?: boolean;
  readonly queued?: boolean;
  readonly retryable?: boolean;
  readonly reviewing: boolean;
  readonly backable?: boolean;
  readonly tab?: string;
}): Binding[] {
  const enterAction =
    context.editing && context.tab === "chat"
      ? "send the Chat prompt; modified Enter inserts a newline"
      : context.editing
        ? "run the typed command or prompt"
        : context.tab === "sessions"
          ? "open selected conversation in Chat; tree groups toggle"
          : context.tab === "documents"
            ? "preview selected document; folders toggle"
            : context.tab === "models"
              ? "set selected model for new conversations"
              : context.tab === "approvals"
                ? "inspect the selected approval before deciding"
                : "inspect selected row; tree groups toggle";
  const always = ALWAYS_BINDINGS.map((binding) =>
    binding.keys === "Enter" ? { ...binding, action: enterAction } : binding,
  );
  const out: Binding[] = [...always, escBindingFor(context)];
  out.push({
    keys: "Ctrl+O",
    action:
      "cycle compact, details and expanded agent activity only during a run; never resizes the composer",
    when: "running",
  });
  if (context.suspendSupported !== false)
    out.push({
      keys: "Ctrl+Z",
      action: "suspend NOMO to the shell; resume with fg",
      when: "always",
    });
  if (context.tab !== undefined && context.tab !== "chat" && !context.editing)
    out.push(
      {
        keys: "Ctrl+P",
        action: "move selection up",
        when: "always",
      },
      {
        keys: "Ctrl+N",
        action: "move selection down",
        when: "always",
      },
    );
  if (!context.editing)
    out.push({
      keys: "Ctrl+T",
      action: "show todos from the selected conversation",
      when: "always",
    });
  if (context.editing) out.push(...EDITING_BINDINGS);
  if (context.running) out.push(...RUNNING_BINDINGS);
  if (context.running && context.editing && context.tab === "chat")
    out.push({
      keys: "Ctrl+Q / Ctrl+Enter",
      action: "queue the Chat draft behind the active turn",
      when: "running",
    });
  if (context.queued)
    out.push({
      keys: "Alt+Up / Shift+Up",
      action: "restore the queued prompt to Chat and keep the current draft",
      when: "running",
    });
  if (context.retryable)
    out.push({
      keys: "F5 / Alt+R",
      action: "retry the failed prompt in a new branch after confirmation",
      when: "always",
    });
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

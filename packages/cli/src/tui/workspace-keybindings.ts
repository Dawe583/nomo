export const DEFAULT_WORKSPACE_KEYBINDINGS = {
  redraw: { ctrl: true, name: "l", label: "Ctrl+L" },
  "toggle-tools": { ctrl: true, name: "o", label: "Ctrl+O" },
  "search-history": { ctrl: true, name: "r", label: "Ctrl+R" },
  stash: { ctrl: true, name: "s", label: "Ctrl+S" },
  "external-editor": { ctrl: true, name: "g", label: "Ctrl+G" },
  "show-todos": { ctrl: true, name: "t", label: "Ctrl+T" },
} as const;

export type WorkspaceKeybindingAction =
  keyof typeof DEFAULT_WORKSPACE_KEYBINDINGS;
export type WorkspaceKeybindings = Record<
  WorkspaceKeybindingAction,
  { ctrl: true; name: string; label: string }
>;

const RESERVED_CONTROL_KEYS: Readonly<Record<string, true>> = {
  a: true,
  b: true,
  c: true,
  d: true,
  e: true,
  f: true,
  h: true,
  i: true,
  j: true,
  k: true,
  m: true,
  n: true,
  p: true,
  q: true,
  u: true,
  w: true,
  x: true,
  y: true,
  z: true,
};
const ACTIONS = Object.keys(
  DEFAULT_WORKSPACE_KEYBINDINGS,
) as WorkspaceKeybindingAction[];

export function parseWorkspaceKeybindings(
  raw: string | undefined,
): { bindings: WorkspaceKeybindings; error?: string } {
  const defaults = { ...DEFAULT_WORKSPACE_KEYBINDINGS } as WorkspaceKeybindings;
  if (raw === undefined || raw === "") return { bindings: defaults };

  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
      throw Error("expected a JSON object");
    const entries = Object.entries(parsed);
    for (const [action] of entries)
      if (!ACTIONS.includes(action as WorkspaceKeybindingAction))
        throw Error(`unknown action ${action}`);

    const bindings = { ...defaults };
    for (const [action, value] of entries) {
      if (typeof value !== "string" || !/^Ctrl\+[a-z]$/i.test(value))
        throw Error(`${action} must use Ctrl+<letter>`);
      const name = value.slice(-1).toLowerCase();
      if (
        RESERVED_CONTROL_KEYS[name] &&
        !(action === "stash" && name === "s")
      )
        throw Error(`${value} is reserved`);
      if (name === "s" && action !== "stash")
        throw Error("Ctrl+S is reserved for terminal flow control");
      bindings[action as WorkspaceKeybindingAction] = {
        ctrl: true,
        name,
        label: `Ctrl+${name.toUpperCase()}`,
      };
    }

    const used = new Map<string, string>();
    for (const action of ACTIONS) {
      const binding = bindings[action];
      const previous = used.get(binding.name);
      if (previous)
        throw Error(
          `${binding.label} is assigned to both ${previous} and ${action}`,
        );
      used.set(binding.name, action);
    }
    return { bindings };
  } catch (error) {
    return {
      bindings: defaults,
      error: `NOMO_TUI_KEYBINDINGS ignored: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }
}

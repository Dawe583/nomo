export const DEFAULT_WORKSPACE_KEYBINDINGS = {
  redraw: { ctrl: true, name: "l", label: "Ctrl+L" },
  "toggle-tools": { ctrl: true, name: "o", label: "Ctrl+O" },
  "search-history": { ctrl: true, name: "r", label: "Ctrl+R" },
  stash: { ctrl: true, name: "s", label: "Ctrl+S" },
  "external-editor": { ctrl: true, name: "g", label: "Ctrl+G" },
  "show-todos": { ctrl: true, name: "t", label: "Ctrl+T" },
} as const;

export type WorkspaceKeybindingAction = keyof typeof DEFAULT_WORKSPACE_KEYBINDINGS;
export type WorkspaceKeybindings = Record<
  WorkspaceKeybindingAction,
  { ctrl: true; name: string; label: string }
>;

const actions = Object.keys(DEFAULT_WORKSPACE_KEYBINDINGS) as WorkspaceKeybindingAction[];
const reserved = new Set(["a", "b", "c", "d", "e", "f", "h", "i", "j", "k", "m", "n", "p", "q", "u", "w", "x", "y", "z"]);

export function parseWorkspaceKeybindings(
  raw: string | undefined,
): { bindings: WorkspaceKeybindings; error?: string } {
  const defaults = { ...DEFAULT_WORKSPACE_KEYBINDINGS } as WorkspaceKeybindings;
  if (!raw) return { bindings: defaults };
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
      throw new Error("expected a JSON object");
    const entries = Object.entries(parsed);
    const bindings = { ...defaults };
    for (const [action, value] of entries) {
      if (!actions.includes(action as WorkspaceKeybindingAction))
        throw new Error(`unknown action ${action}`);
      if (typeof value !== "string" || !/^Ctrl\+[a-z]$/i.test(value))
        throw new Error(`${action} must use Ctrl+<letter>`);
      const name = value.slice(-1).toLowerCase();
      if (reserved.has(name) && !(action === "stash" && name === "s"))
        throw new Error(`${value} is reserved`);
      if (name === "s" && action !== "stash")
        throw new Error("Ctrl+S is reserved for terminal flow control");
      bindings[action as WorkspaceKeybindingAction] = {
        ctrl: true,
        name,
        label: `Ctrl+${name.toUpperCase()}`,
      };
    }
    const seen = new Map<string, string>();
    for (const action of actions) {
      const { name, label } = bindings[action];
      const previous = seen.get(name);
      if (previous) throw new Error(`${label} is assigned to both ${previous} and ${action}`);
      seen.set(name, action);
    }
    return { bindings };
  } catch (error) {
    return {
      bindings: defaults,
      error: `NOMO_TUI_KEYBINDINGS ignored: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

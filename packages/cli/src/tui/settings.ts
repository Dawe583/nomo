import {
  HARNESS_SETTINGS,
  type HarnessSettingKey,
  type HarnessSettings,
} from "../../../workbench/src/harness-settings.ts";

export type SettingsValue = string | number;

export type SettingEntry = {
  key: string;
  label: string;
  category:
    | "Appearance"
    | "Conversation"
    | "Models and Providers"
    | "Workspace and Storage";
  description: string;
  value: SettingsValue;
  defaultValue: SettingsValue | "not configured";
  configured: boolean;
  source: string;
  editability: string;
  choices?: string;
};

type Preferences = Readonly<Record<string, string | undefined>>;

type PreferenceDetail = Pick<
  SettingEntry,
  | "label"
  | "category"
  | "description"
  | "defaultValue"
  | "source"
  | "editability"
  | "choices"
>;

const preferenceDetails: Record<string, PreferenceDetail> = {
  appearance: {
    label: "Appearance",
    category: "Appearance",
    description: "Theme mode stored by the Workbench.",
    defaultValue: "system",
    source: "Workbench effective preference. The origin is not exposed.",
    editability:
      "Read-only in the TUI. /theme previews a theme for this process.",
    choices: "system, light, dark",
  },
  defaultAgentPreset: {
    label: "Default agent profile",
    category: "Conversation",
    description: "Agent profile selected for new conversations.",
    defaultValue: "default",
    source: "Workbench effective preference. The origin is not exposed.",
    editability: "Read-only here. Use /agents to select an existing profile.",
  },
  defaultModel: {
    label: "Default model",
    category: "Models and Providers",
    description: "Model selected for new conversations, when configured.",
    defaultValue: "not configured",
    source: "Workbench effective preference. The origin is not exposed.",
    editability: "Read-only here. Use /model to choose an available model.",
  },
  defaultProvider: {
    label: "Default provider",
    category: "Models and Providers",
    description: "Provider selected for new conversations, when configured.",
    defaultValue: "not configured",
    source: "Workbench effective preference. The origin is not exposed.",
    editability: "Read-only here. Use /connect to configure a provider.",
  },
  locale: {
    label: "Locale",
    category: "Appearance",
    description: "Locale preference stored by the Workbench.",
    defaultValue: "cs",
    source: "Workbench effective preference. The origin is not exposed.",
    editability: "Read-only in the TUI.",
    choices: "cs, en",
  },
  sendBehavior: {
    label: "Enter behavior",
    category: "Conversation",
    description: "Whether Enter sends a prompt or inserts a newline.",
    defaultValue: "enter",
    source: "Workbench effective preference. The origin is not exposed.",
    editability: "Editable with /settings sendBehavior enter|mod-enter.",
    choices: "enter, mod-enter",
  },
};

export function buildSettingsCatalog(
  preferences: Preferences,
  harness: HarnessSettings,
  toolOutput: "compact" | "full",
): SettingEntry[] {
  const entries: SettingEntry[] = [];
  for (const [key, details] of Object.entries(preferenceDetails)) {
    const value = preferences[key];
    entries.push({
      key,
      ...details,
      value: value ?? "not configured",
      configured: value !== undefined,
    });
  }

  entries.push({
    key: "toolOutput",
    label: "Tool output",
    category: "Conversation",
    description: "Amount of tool event detail shown in the current chat view.",
    value: toolOutput,
    configured: true,
    defaultValue: "compact",
    source: "Current TUI process. Not persisted by Workbench.",
    editability:
      "Editable in the current TUI only with /settings toolOutput compact|full.",
    choices: "compact, full",
  });

  for (const key of Object.keys(HARNESS_SETTINGS) as HarnessSettingKey[]) {
    const spec = HARNESS_SETTINGS[key];
    entries.push({
      key,
      label: spec.label,
      category: "Workspace and Storage",
      description: spec.description,
      value: harness[key],
      configured: true,
      defaultValue: spec.default,
      source:
        "Workbench effective limit. Stored override origin is not exposed.",
      editability: `Editable within ${spec.min} to ${spec.max} with /settings ${key} VALUE.`,
      choices: `${spec.min} to ${spec.max}`,
    });
  }

  return entries.sort(
    (left, right) =>
      left.category.localeCompare(right.category) ||
      left.key.localeCompare(right.key),
  );
}

export function searchSettings(
  entries: readonly SettingEntry[],
  query: string,
): SettingEntry[] {
  const terms = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return [...entries];
  return entries.filter((entry) => {
    const searchable = [
      entry.key,
      entry.label,
      entry.category,
      entry.description,
      String(entry.value),
      String(entry.defaultValue),
      entry.source,
      entry.editability,
      entry.choices ?? "",
    ]
      .join(" ")
      .toLocaleLowerCase();
    return terms.every((term) => searchable.includes(term));
  });
}

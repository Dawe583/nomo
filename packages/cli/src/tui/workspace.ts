import { cachedGitStatus, sanitizeBranch, type GitStatus } from "./git-status.ts";
import { ProxyWorkspace } from "./workspace-proxy.ts";
import { execFile } from "node:child_process";
import { randomUUID, createHash } from "node:crypto";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { promisify } from "node:util";
import { resolveConfig } from "../config.ts";
import {
  Workbench,
  DEFAULT_POLICY,
  type SessionEvent,
  type SessionView,
} from "../../../workbench/src/index.ts";
import {
  modelCapabilityDisclosure,
  PROVIDER_MODEL_MANIFEST,
} from "../../../workbench/src/provider-catalog.ts";
import { ProviderRequestError } from "../../../workbench/src/provider.ts";
import type { ProjectSkillSnapshot } from "../../../workbench/src/project-skills.ts";
import { activity, type ViewName } from "../../../workbench/src/gui.ts";
import { PROVIDER_PRESETS } from "../../../workbench/src/provider-defaults.ts";
import {
  HOST_CLI_PROVIDERS,
  HostCliRunner,
  probeHostCli,
  type HostCliId,
  type HostCliProvider,
} from "../../../workbench/src/agent-runners/host-cli.ts";
import { canonicalJson } from "../../../ledger/src/canonical.ts";
import type { JsonlEntry } from "../../../ledger/src/store.ts";
import { mineLearnedRules } from "../../../workbench/src/learned-rules.ts";
import {
  measureBoard,
  scoreCases,
  unmeasuredMetrics,
} from "../../../workbench/src/harness-scores.ts";
import { mineRefinementEffects } from "../../../workbench/src/refinement-outcomes.ts";
import { LOCAL_AGENT_PRINCIPAL_ID } from "../../../workbench/src/agent-identity.ts";

import {
  HARNESS_SETTINGS,
  HARNESS_TEXT_SETTINGS,
  harnessSettingsView,
  harnessTextSettingsView,
} from "../../../workbench/src/harness-settings.ts";
import {
  verificationKeyNote,
  verificationStatus,
} from "../../../ledger/src/verify-key.ts";
import {
  desktopProviderModels,
  importDesktopProvider,
  desktopSetup,
  ompProviderSources,
} from "../../../../apps/control-plane/api/desktop-setup.ts";
import { loadPolicy } from "../../../policy/src/rules.ts";
import { REGISTRY_DISCLAIMER } from "../../../registry/src/index.ts";
import {
  NOMO_PALETTE,
  getThemeConfig,
  getSymbols,
  getPalette,
  type ThemeConfig,
  COLOR_THEMES,
  SYMBOL_SETS,
  type ColorTheme,
  type SymbolPreset,
  paintUserMessage,
  paintWithPalette,
} from "./theme.ts";
import {
  brandHeader,
  compactBrandMark,
  kittyActivityIconLabel,
  kittyProviderIconLabel,
  kittySemanticIconLabel,
  kittyTabIconLabel,
  loadLocalTabIcons,
  type LocalTabIcons,
} from "./brand.ts";
import { runDoctorCommand } from "../doctor.ts";
import { runInitCommand } from "../init.ts";
import { runConformanceCommand } from "../conformance.ts";
import {
  box,
  fit,
  pad,
  renderHunkSelection,
  sanitizeText,
  splitDiffHunks,
  unifiedDiff,
  stripAnsi,
  visibleLength,
} from "./layout.ts";
import { detectCapabilities } from "./caps.ts";
import type { TerminalCapabilities } from "./types.ts";
import { renderShortcutLegend } from "./shortcuts.ts";
import { parseWorkspaceKeybindings } from "./workspace-keybindings.ts";
import {
  advanceSelection as advancePaletteSelection,
  backspaceInPalette,
  filterPalette,
  fuzzyTextScore,
  initialPaletteState,
  paletteFromCommands,
  recordPaletteCommand,
  renderPalette,
  type PaletteItem,
  type PaletteState,
} from "./palette.ts";
import {
  DEFAULT_TOAST_LIMITS,
  expireToasts,
  raiseToast,
  renderToasts,
  toastIcon,
  type ToastHost,
} from "./toast.ts";
import {
  animatedBar,
  approvalPulse,
  cautionSpinner,
  cursorMarker,
  indeterminateBar,
  levelMeter,
  motionContext,
  phaseWave,
  pill,
  runningIndicator,
  separator,
  sweepRow,
  tabUnderline,
  typeCursor,
} from "./motion.ts";
import {
  PET_BUBBLE_MIN_WIDTH,
  PET_DOCK_MARK,
  PET_PERCH_ROWS,
  attachPetRow,
  petCardLines,
  detectPetTerminal,
  petImagePlan,
  petLayout,
  petPose,
  petReaction,
  petStateFrom,
  readPetPreference,
  renderPetBubble,
  renderPetMini,
  renderPetRows,
  renderPetSplash,
  writePetPreference,
  type PetContext,
  type PetPlacement,
  type PetSignal,
  type PetState,
} from "./pet.ts";
export type { PetPlacement } from "./pet.ts";
import { trueColor, type ColorPalette } from "./theme-config.ts";
import { barChart, deltaLabel, gauge, sparkline } from "./charts.ts";
import { usageSummaryLines } from "./usage-visual.ts";
import { ledgerChainLines, ledgerGroupHeading } from "./ledger-visual.ts";
import {
  buildDiffView,
  moveHunk,
  renderDiffPanel,
  setSide,
  toggleHunk,
  type DiffViewState,
} from "./diff-panel.ts";
import {
  renderInspector,
  type FieldTone,
  type InspectorSpec,
} from "./inspector.ts";
import { renderBlock, roleIcon } from "./blocks.ts";
import {
  CHAT_RAIL_MIN_HEIGHT,
  CHAT_RAIL_MIN_WIDTH,
  TODO_BAR_MAX,
  TODO_CHIP_MIN_WIDTH,
  todoChip,
  todoItemsFromEventPayload,
  todoProgress,
  todoProgressBar,
  todoRailLines,
  type TodoItem,
  type TodoStatus,
} from "./todo.ts";
import {
  subagentCardRows,
  subagentRailLines,
  type SubagentActivityState,
  type SubagentSession,
} from "./subagents.ts";
import {
  filterTools,
  toolRows,
  toolSchemaLines,
  type ToolSummary,
} from "./tool-browser.ts";
import { renderRecovery, type RecoveryRow } from "./recovery-view.ts";
import {
  healthIcon,
  healthSummary,
  healthTone,
  healthWord,
  orderChecks,
  renderHealth,
  type Check,
  type HealthState,
} from "./health.ts";
import {
  absentCapabilities,
  discoveryRows,
  DISCOVERY_GROUPS,
  type CommandEntry,
} from "./discover.ts";
import { activitySummary, buildActivity, renderActivity } from "./activity.ts";
import { bindingsFor, filterBindings, renderCheatSheet } from "./cheatsheet.ts";
import {
  buildTimeline,
  renderTimeline,
  runSummaryLines,
  runSummaryRow,
  type RunSummary,
} from "./run-timeline.ts";
import {
  buildDocumentTree,
  buildSessionTree,
  collapsedSummary,
  initialTreeState,
} from "./session-tree.ts";
import {
  flattenTree,
  moveTree,
  renderTree,
  toggleTreeNode,
  type TreeNode,
  type TreeState,
} from "./widgets.ts";

export const WORKSPACE_TABS = [
  "chat",
  "sessions",
  "runs",
  "documents",
  "ledger",
  "approvals",
  "policy",
  "tools",
  "mcp",
  "status",
  "models",
  "usage",
  "help",
] as const;
export type WorkspaceTab = (typeof WORKSPACE_TABS)[number];
export const WORKSPACE_VIEWS = {
  chat: "chat",
  sessions: "sessions",
  runs: null,
  documents: "documents",
  ledger: "ledger",
  approvals: "approvals",
  policy: null,
  tools: "tools",
  mcp: null,
  status: null,
  models: "models",
  usage: "models",
  help: null,
} as const satisfies Record<WorkspaceTab, ViewName | null>;
export function workspaceTab(value: string): WorkspaceTab | undefined {
  return WORKSPACE_TABS.includes(value as WorkspaceTab)
    ? (value as WorkspaceTab)
    : undefined;
}
export type ModelPickerProvider = {
  readonly id: string;
  readonly name: string;
  readonly attached: boolean;
  readonly catalogStatus: "idle" | "ready" | "unavailable";
  readonly models?: readonly PickerModel[];
  readonly importSourceId?: string;
};
export type ModelPickerState = {
  readonly open: true;
  readonly origin: "chat" | "workspace";
  readonly selection: "default" | "session";
  readonly providers: readonly ModelPickerProvider[];
  readonly query: string;
  readonly cursor: number;
  readonly selected: number;
  readonly providerIndex: number;
  readonly providerId?: string;
  readonly focusedPane: "providers" | "models";
  readonly catalogStatus: "idle" | "loading" | "ready" | "unavailable";
  /** Independent list offsets used when the mouse pans without changing selection. */
  readonly providerWindowStart?: number;
  readonly modelWindowStart?: number;
  readonly models: readonly PickerModel[];
};
type PickerModel = {
  readonly id: string;
  readonly name: string;
  readonly contextWindow?: number;
  readonly inputPrice?: string;
  readonly outputPrice?: string;
  readonly capabilities?: readonly string[];
  readonly maxTokens?: number;
};
const modelPickerMatchCache = new WeakMap<
  object,
  { readonly query: string; readonly matches: readonly PickerModel[] }
>();
export function modelPickerMatches(
  models: readonly PickerModel[],
  query: string,
): readonly PickerModel[] {
  const normalizedQuery = query.trim();
  if (!normalizedQuery) return models;
  const cached = modelPickerMatchCache.get(models);
  if (cached?.query === normalizedQuery) return cached.matches;
  const matches = models
    .map((model, index) => ({
      model,
      index,
      score: fuzzyTextScore(normalizedQuery, [model.name, model.id]),
    }))
    .filter(
      (entry): entry is typeof entry & { score: number } =>
        entry.score !== undefined,
    )
    .sort((left, right) =>
      right.score !== left.score
        ? right.score - left.score
        : left.index - right.index,
    )
    .map(({ model }) => model);
  modelPickerMatchCache.set(models, { query: normalizedQuery, matches });
  return matches;
}
type Item = {
  id: string;
  label: string;
  lines: string[];
  sessionId?: string;
  path?: string;
  operationId?: string;
  digest?: string;
  ledgerEntry?: JsonlEntry;
  /**
   * What kind of record this is, used to group a tab that mixes several.
   * The ledger tab holds signed entries, proxy entries, mined rules, harness
   * scores, hooks and agents in one list, and a reader scanning it
   * for a refusal was stepping over four other kinds to get there.
   */
  kind?:
    | "entry"
    | "proxy"
    | "learned"
    | "score"
    | "harness"
    | "hook"
    | "agent"
    | "verification";
  /** The raw hold behind an approval row, kept only so the list can order by
   * severity. It is not rendered: the label and the lines carry everything.
   * A proxy hold may arrive without a deadline, which is not the same as one
   * that never closes, so the field is optional here. */
  hold?: {
    status: string;
    expiresAt?: number;
    call: {
      tool: string;
      klass?: string;
      blastRadius?: number;
      unclassified?: boolean;
    };
  };
  /**
   * The connector behind a policy row, kept so Enter can read it as a policy
   * rather than as a JSON dump. Carried, never rendered on the row: the label
   * and the ordering already use it.
   */
  connector?: {
    id: string;
    name?: string;
    tools: readonly string[];
    consentState: string;
  };
  /**
   * The usage record behind a usage row, for the same reason. The row already
   * shows the tokens; this is what makes the detail readable instead of a dump.
   *
   * The token counts are unknown to the type, not nullable to the caller: the
   * activity layer types them as unknown because they can be absent, and the
   * detail renders whatever number is actually there.
   */
  usage?: {
    id: string;
    model: string;
    sessionId: string;
    at?: string;
    provider?: string;
    totalTokens?: unknown;
    inputTokens?: unknown;
    outputTokens?: unknown;
    cost?: unknown;
    source?: string;
  };
  run?: ReturnType<Workbench["runs"]>[number];
  check?: Check;
};
type Confirmation = {
  title: string;
  lines: string[];
  /** Diff hunks under review, when the approval carries a diff. The lines
   * above are rebuilt from hunkBase plus the selection markers on toggle. */
  hunks?: { chunks: string[][]; selected: boolean[] };
  hunkBase?: string[];
  apply: () => Promise<void>;
};
const json = (value: unknown) =>
  JSON.stringify(value, null, 2)?.split("\n") ?? [];
/**
 * A token count as a number, or the word unknown.
 *
 * The activity layer types token counts as unknown because a run that never
 * reported them has none, and absent is not zero. Rendering the absence as 0
 * would make a conversation that spent nothing look identical to one whose
 * costs were never recorded.
 */
function numberOr(value: unknown, absent: string): string {
  return typeof value === "number" && Number.isFinite(value)
    ? value.toLocaleString("en-US")
    : absent;
}
/** Median of a non-empty numeric list. The mean of a run that includes one
 * outlier hides the outlier, and the median is what an operator comparing
 * typical runs actually wants to see. */
function median(values: readonly number[]): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = sorted.length >> 1;
  return sorted.length % 2
    ? sorted[middle]!
    : Math.round((sorted[middle - 1]! + sorted[middle]!) / 2);
}
const text = (value: unknown) => String(value ?? "unknown");
/** Operator-authored and model-authored text reaches the ledger tab through
 * proposal rows. A control character in it would move the cursor and rewrite
 * rows the operator is reading, so it is escaped before paint, not after. */
const escapeTerminalText = (value: string) =>
  value.replace(
    /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]/gu,
    (character) =>
      `\\u${character.codePointAt(0)!.toString(16).padStart(4, "0")}`,
  );
/**
 * The cases the board measures, grouped exactly as the CLI and the HTTP API
 * group them: one case per tool and class.
 *
 * The TUI used to make one case per workspace, so an operator with a single
 * workspace always had one case and the verdict could never leave
 * `insufficient-data`. A workspace shown by several sessions is still counted
 * once.
 */
const verifiedScoreCases = (
  proofs: ReadonlyMap<string, readonly JsonlEntry[]>,
): JsonlEntry[][] => {
  const seen = new Set<string>();
  const entries: JsonlEntry[] = [];
  for (const [sessionId, chain] of proofs) {
    const workspace = chain[0]?.workspace ?? sessionId;
    if (seen.has(workspace)) continue;
    seen.add(workspace);
    entries.push(...chain);
  }
  return scoreCases(entries).map((group) => [...group] as JsonlEntry[]);
};
/** Hook commands are operator-supplied config, but they routinely carry
 * credentials inline (curl -H "Authorization: ...", --token=...). The
 * ledger tab prints them, so redact before bounding and rendering, the
 * same bound agentsLines applies to a system prompt. */
const redactSecrets = (value: string): string =>
  value
    .replace(/-H\s+"Authorization:[^"]*"/gi, "[redacted]")
    .replace(/Authorization:\s*\S+/gi, "[redacted]")
    .replace(/Bearer\s+\S+/g, "[redacted]")
    .replace(/\b(?:token|key|password)=\S+/gi, "[redacted]");
const boundedHookCommand = (command: string): string => {
  const clean = redactSecrets(command.trim());
  if (!clean) return "(empty)";
  return clean.length > 160
    ? `${clean.slice(0, 160)}… (+${clean.length - 160} chars)`
    : clean;
};
/** The one next step per consent state. A staged connector has no catalog, a
 * probed one has tools nobody agreed to, and a confirmed one is in use. */
const MCP_NEXT = {
  staged: (id: string) => `/mcp probe ${id}`,
  probed: (id: string) => `/mcp confirm ${id}`,
  confirmed: () => "in use by new conversations",
} as const;
const MCP_COMMANDS: readonly string[] = [
  "inspect",
  "add",
  "probe",
  "confirm",
  "rename",
  "remove",
];
/** A policy is YAML in the record, so the view counts its rules instead of
 * printing it: the line keeps the 80 column budget and stays comparable
 * between connectors. */
function policySummary(value: string | undefined) {
  if (!value) return "default";
  const loaded = loadPolicy(value);
  if (!loaded.ok) return "unreadable policy";
  return (
    `${loaded.policy.rules.length} rules, ` +
    loaded.policy.rules
      .map((rule) => {
        const scope = String(rule.match.class ?? "any");
        return rule.decision === "hold"
          ? `${scope} hold ${rule.seconds ?? 0}s`
          : `${scope} ${rule.decision}`;
      })
      .join(", ")
  );
}
export function modelPickerWindowStart(
  selected: number,
  count: number,
  visibleRows: number,
  requestedStart?: number,
): number {
  const capacity = Math.max(1, visibleRows);
  const start = requestedStart ?? selected - Math.floor(capacity / 2);
  return Math.max(0, Math.min(Math.max(0, count - capacity), start));
}

export function modelPickerSelectionWindowStart(
  previousSelected: number,
  selected: number,
  count: number,
  visibleRows: number,
  requestedStart?: number,
): number {
  const capacity = Math.max(1, visibleRows);
  const start = modelPickerWindowStart(
    previousSelected,
    count,
    capacity,
    requestedStart,
  );
  const nextStart =
    selected < start
      ? selected
      : selected >= start + capacity
        ? selected - capacity + 1
        : start;
  return modelPickerWindowStart(selected, count, capacity, nextStart);
}

/** One row of the /mcp view. The builtin document workspace has no endpoint,
 * so the view flattens both record shapes into this before rendering. */
type ConnectorRow = {
  id: string;
  name: string;
  builtin: boolean;
  consent: "staged" | "probed" | "confirmed";
  tools: string[];
  endpoint: string;
  policy?: string;
  facts?: Record<string, string | boolean>;
  mapping?: Record<string, string>;
};

export type TuiMode = "normal" | "accept" | "plan";
type ChatFrameStyle = "filled" | "rounded" | "square" | "double";
type ChatDensity = "comfortable" | "compact";
const DEFAULT_CHAT_COMPOSER_HEIGHT_PX = 123;
const MIN_CHAT_COMPOSER_HEIGHT_PX = 72;
const MAX_CHAT_COMPOSER_HEIGHT_PX = 320;
type ChatPanelVisuals = {
  frame: ChatFrameStyle;
  density: ChatDensity;
  timestamps: boolean;
  composerHeightPx: number;
};
export type TuiLocalSettings = {
  colorTheme: ColorTheme;
  symbolPreset: SymbolPreset;
  chatFrame: ChatFrameStyle;
  chatDensity: ChatDensity;
  chatTimestamps: boolean;
  chatComposerHeightPx: number;
  keybindings?: string;
  terminalColor?: boolean;
  motion?: boolean;
};
type SettingsControl = {
  key: string;
  group: "Appearance" | "Interaction" | "Models and Providers" | "Harness";
  label: string;
  icon: string;
  value: string;
  description: string;
  options?: readonly string[];
  number?: number;
  min?: number;
  max?: number;
  text?: boolean;
  maxLength?: number;
};

function settingsCursorWindow(value: string, cursor: number, width: number) {
  if (width <= 1) return "▏";
  const points = [...value];
  const focus = Math.max(0, Math.min(points.length, cursor));
  const budget = width - 1;
  let start = focus;
  let end = focus;
  let used = 0;
  while (start > 0 && used + visibleLength(points[start - 1]!) <= budget) {
    used += visibleLength(points[--start]!);
  }
  while (end < points.length && used + visibleLength(points[end]!) <= budget) {
    used += visibleLength(points[end++]!);
  }
  return `${points.slice(start, focus).join("")}▏${points.slice(focus, end).join("")}`;
}

function chatPanelVisualsFrom(
  env: Readonly<NodeJS.ProcessEnv>,
): ChatPanelVisuals {
  const frame = env.NOMO_TUI_CHAT_FRAME?.toLowerCase();
  const density = env.NOMO_TUI_CHAT_DENSITY?.toLowerCase();
  const timestamps = env.NOMO_TUI_CHAT_TIMESTAMPS?.toLowerCase();
  const composerHeightPx = Number(env.NOMO_TUI_CHAT_COMPOSER_HEIGHT_PX);
  return {
    frame:
      frame === "filled" ||
      frame === "rounded" ||
      frame === "square" ||
      frame === "double"
        ? frame
        : "rounded",
    density: density === "compact" ? "compact" : "comfortable",
    timestamps:
      timestamps === "on" || timestamps === "true" || timestamps === "1",
    composerHeightPx:
      Number.isSafeInteger(composerHeightPx) &&
      composerHeightPx >= MIN_CHAT_COMPOSER_HEIGHT_PX &&
      composerHeightPx <= MAX_CHAT_COMPOSER_HEIGHT_PX
        ? composerHeightPx
        : DEFAULT_CHAT_COMPOSER_HEIGHT_PX,
  };
}
export const TUI_MODES: readonly TuiMode[] = ["normal", "accept", "plan"];

/** Double Escape in a short window opens the checkpoint list. */
export function isDoubleEscape(now: number, last: number, windowMs = 800) {
  return last > 0 && now - last >= 0 && now - last <= windowMs;
}

/** Approval rows show class, radius and the matched case, never a bare tool name.
 * An unmeasured radius prints as unknown, because unknown is not zero. */
export function approvalLabel(hold: {
  holdId: string;
  status: string;
  call: { tool: string; klass?: string; blastRadius?: number; reason?: string };
}): string {
  const klass = hold.call.klass ? ` [${hold.call.klass.toUpperCase()}]` : "";
  const radius =
    hold.call.blastRadius === undefined
      ? " radius unknown"
      : ` radius ${hold.call.blastRadius}`;
  const reason = hold.call.reason ? ` ${hold.call.reason}` : "";
  return `[${hold.status}]${klass} ${hold.call.tool} ${hold.holdId.slice(0, 8)}${radius}${reason}`;
}

/**
 * How consequential a hold is, highest first.
 *
 * The approvals tab listed holds in whatever order the backend returned
 * them, which put a read next to a write and let an operator approve three
 * harmless calls before reaching the one that touches every document. The
 * order is by blast radius, then by whether the hold has an expiry, because
 * a hold that expires is one the operator has to answer soon.
 *
 * An unmeasured radius sorts last rather than first: unknown is not zero, and
 * sorting it to the top would claim it is the most dangerous thing here.
 */
export function holdSeverity(hold: {
  readonly status: string;
  readonly call: {
    readonly klass?: string;
    readonly blastRadius?: number;
  };
  readonly expiresAt?: number;
}): number {
  // A decided hold is not waiting on anyone, so it sorts below everything
  // that is. Weighting it upward would put an answer the operator already
  // gave at the top of the list of things to answer.
  const settled = /reject|deny|expir|approv|grant/i.test(hold.status) ? 1 : 0;
  const radius = hold.call.blastRadius;
  // An unknown radius scores below every known one, including zero.
  const measured = radius === undefined ? -1 : radius;
  return (measured + 1) * 1e6 + (hold.expiresAt ? 1 : 0) - settled * 1e9;
}

/**
 * The approval detail, as fields an operator can read before deciding.
 *
 * The raw JSON it replaces buried the one thing the decision turns on, which
 * is what the call touches, under a dozen keys nobody scans. The JSON is kept
 * below the fields: it is the record, not the reading.
 */
function approvalInspectLines(
  hold: {
    status: string;
    expiresAt?: number;
    call: {
      tool: string;
      klass?: string;
      blastRadius?: number;
      reason?: string;
    };
  },
  raw: readonly string[],
  width = 76,
): string[] {
  const radius =
    hold.call.blastRadius === undefined
      ? "unknown"
      : String(hold.call.blastRadius);
  // Approval state is durable and call arguments can carry secrets, so it
  // never stores them: the args exist only on the live HeldCall inside the
  // proxy process, which the CLI approver renders. The detail calls the
  // omission by name instead of printing a field that is always empty.
  const args = "not recorded: approval state does not store call arguments";
  return renderInspector(
    {
      title: hold.call.tool,
      subtitle: hold.status,
      icon: ROW_ICONS.approval,
      sections: [
        {
          title: "decision",
          fields: [
            {
              label: "status",
              value: hold.status,
              tone: /reject|deny|expir/i.test(hold.status)
                ? "muted"
                : "warning",
            },
            {
              label: "class",
              value: hold.call.klass ?? "unknown",
              // An unknown class is not a low class. It says nothing about
              // what the call may do, which is the opposite of low risk.
              tone: hold.call.klass ? "default" : "error",
            },
            {
              label: "blast radius",
              value: radius,
              tone:
                hold.call.blastRadius === undefined
                  ? "error"
                  : hold.call.blastRadius > 1
                    ? "warning"
                    : "default",
            },
            {
              label: "expires",
              value:
                typeof hold.expiresAt === "number" &&
                Number.isFinite(hold.expiresAt)
                  ? new Date(hold.expiresAt).toISOString()
                  : "no deadline reported",
              tone: "muted",
            },
            {
              label: "arguments",
              value: args,
              tone: "default",
            },
          ],
        },
        {
          title: "why it is waiting",
          fields: [],
          body: [
            hold.call.reason ?? "The server supplied no reason for this hold.",
          ],
        },
      ],
      hint: "Use /approve ID or /reject ID to open a review.",
    },
    { width },
  ).concat(["", "RAW RECORD", ...raw]);
}

/**
 * How long a hold can still be answered, in seconds, or null when it has no
 * deadline.
 *
 * A hold without an expiry is not an eternal one, it is a hold whose deadline
 * the server did not send. Printing a countdown for it would invent a number
 * the terminal was never given.
 */
export function holdSecondsLeft(
  hold: { readonly expiresAt?: number },
  now: number,
): number | null {
  if (!Number.isFinite(hold.expiresAt)) return null;
  return Math.max(0, Math.round(((hold.expiresAt as number) - now) / 1000));
}

/** The window in which a hold is announced as about to close. */
const EXPIRY_WARNING_SECONDS = 60;

/**
 * The glyph for an approval row. A hold the operator already answered is not
 * an open obligation, so it does not carry the pending mark. The status word
 * beside it stays authoritative either way.
 */
/**
 * The glyph for a provider state.
 *
 * The state word is printed beside it in every use, so the glyph is only for
 * scanning a column. A state this table does not name gets the failed mark
 * rather than the ready one, because an unrecognised state has never been
 * shown to be working.
 */
/**
 * Group headings for a tab that mixes several kinds of record.
 *
 * The order is the order an operator reasons in: the chain check first, then
 * the two bounded singleton summaries that describe it (score, harness), then
 * the signed records themselves, then what the chain taught, then the
 * machinery that produced it. The two singletons are hoisted above the record
 * list because that list is unbounded: as entries grow, anything below them
 * would eventually fall off the first screen. Signed entries stay above the
 * derived groups, because they are the only ones that are evidence.
 */
const LEDGER_GROUP_ORDER = [
  "verification",
  "score",
  "harness",
  "entry",
  "proxy",
  "learned",
  "agent",
  "hook",
] as const;

const LEDGER_GROUP_TITLE: Record<string, string> = {
  verification: "VERIFICATION",
  entry: "SIGNED ENTRIES",
  proxy: "PROXY ENTRIES",
  learned: "LEARNED FROM THE CHAIN",
  score: "HARNESS SCORE",
  harness: "HARNESS",
  agent: "AGENTS",
  hook: "HOOKS",
};

const LEDGER_GROUP_ICON: Record<string, string> = {
  verification: "◕",
  entry: "▪",
  proxy: "▫",
  learned: "◇",
  score: "▰",
  harness: "◈",
  agent: "◆",
  hook: "◔",
};

export function providerStatusIcon(status: string): string {
  if (status === "ready") return ROW_ICONS.settled;
  if (status === "setup-required" || status === "rate-limited")
    return ROW_ICONS.queued;
  return ROW_ICONS.failed;
}

function holdRowIcon(hold: { status: string }): string {
  return /reject|deny/i.test(hold.status)
    ? ROW_ICONS.rejected
    : ROW_ICONS.approval;
}

/**
 * The trailing countdown on an approval row.
 *
 * A hold with no deadline says so in a word: that means the server sent no
 * deadline, not that it never closes, and an empty prefix read like a hold
 * that had one. A hold already past its deadline says so in a word too,
 * because "0s left" reads like a value that is about to change.
 */
function expirySuffix(hold: { expiresAt?: number }, now: number): string {
  const left = holdSecondsLeft(hold, now);
  if (left === null) return "no deadline | ";
  if (left <= 0) return "EXPIRED | ";
  return `${left}s left | `;
}

/**
 * The glyph for a connector's consent state.
 *
 * The state word is printed beside it in every case, so the glyph is only
 * there to let a column of connectors be scanned by shape. An unknown state
 * gets the question mark rather than one of the known marks: it was never
 * measured into a state, and showing a check for it would claim it is ready.
 */
export function connectorConsentIcon(consent: string): string {
  if (consent === "confirmed") return "●";
  if (consent === "probed") return "◐";
  if (consent === "staged") return "○";
  return "?";
}

/**
 * The four sections of the sessions browser, in the order an operator asks
 * the question: what is running, what needs a decision, what a run
 * delegated, what was put away.
 *
 * Idle and running conversations share `active` because both are the working
 * set; the row glyph is what separates them, and a fifth bucket for idle
 * would put every finished conversation in a heading named after the states
 * that are not happening.
 */
export type SessionSectionId = "active" | "attention" | "children" | "archived";

export const SESSION_SECTION_ORDER: readonly SessionSectionId[] = [
  "active",
  "attention",
  "children",
  "archived",
];

/** The bucket one conversation is filed under. */
export function sessionSection(session: {
  readonly status?: string;
  readonly archived?: boolean;
  readonly parentId?: string;
}): SessionSectionId {
  if (session.archived === true) return "archived";
  const key = (session.status ?? "").toLowerCase();
  // Failure and blocked states outrank a parent link: a delegated run that
  // failed is something to look at, not something filed under its parent.
  if (key.includes("fail") || key.includes("error")) return "attention";
  if (
    key.includes("queue") ||
    key.includes("pending") ||
    key.includes("paus") ||
    key.includes("block") ||
    key.includes("await") ||
    key.includes("rate-limited") ||
    key.includes("setup-required")
  )
    return "attention";
  // A running child stays in the working set: hiding live work under a
  // collapsed section would make the browser look idle while it is not.
  if (key.includes("run") || key.includes("active")) return "active";
  if (session.parentId) return "children";
  return "active";
}

/**
 * The single-cell glyph in front of a browser row.
 *
 * The glyph never carries the only copy of a fact: the section heading names
 * the bucket, and the inspector prints the status word. `×` is U+00D7 rather
 * than U+2715 because layout.ts counts U+2600 to U+27BF as two cells, and a
 * two-cell glyph would shift every row one column right.
 */
export function sessionRowGlyph(
  session: { readonly status?: string; readonly archived?: boolean },
  section: SessionSectionId,
): string {
  if (section === "children") return "▸";
  const key = (session.status ?? "").toLowerCase();
  if (key.includes("run") || key.includes("active")) return "●";
  if (key.includes("fail") || key.includes("error")) return "×";
  if (
    key.includes("queue") ||
    key.includes("pending") ||
    key.includes("paus") ||
    key.includes("block") ||
    key.includes("await") ||
    key.includes("rate-limited") ||
    key.includes("setup-required")
  )
    return "◐";
  return "○";
}

/**
 * The one-cell icons the browser and its inspector print beside a fact.
 *
 * They come from the same symbol set as the rest of the chrome, but only when
 * the preset's glyph is one cell: layout.ts counts U+2600 to U+27BF as two
 * cells and the ASCII preset spells several icons as three-character tags, so
 * either would push every fact one column right. Those presets get a plain
 * ASCII letter instead, which keeps the facts aligned at every width.
 */
export interface SessionRowIcons {
  readonly model: string;
  readonly time: string;
  readonly tokens: string;
  readonly children: string;
  readonly parent: string;
  readonly created: string;
}

export function sessionRowIcons(preset?: SymbolPreset): SessionRowIcons {
  const icons = getSymbols(preset).icons;
  const oneCell = (value: string, fallback: string): string =>
    visibleLength(value) === 1 ? value : fallback;
  return {
    model: oneCell(icons.model, "m"),
    time: oneCell(icons.time, "t"),
    tokens: oneCell(icons.tokens, "#"),
    children: oneCell(icons.agent, "a"),
    parent: oneCell(icons.network, "n"),
    created: oneCell(icons.session, "s"),
  };
}

/**
 * How long the recorded work spanned, from the timestamps the conversation
 * carries. Nothing is measured against the wall clock: an idle conversation
 * has no elapsed time, and a browser that grew a number every second would
 * repaint rows that had not changed.
 */
export function sessionElapsedLabel(
  createdAt?: string,
  updatedAt?: string,
): string {
  const start = Date.parse(createdAt ?? "");
  const end = Date.parse(updatedAt ?? createdAt ?? "");
  if (!Number.isFinite(start) || !Number.isFinite(end)) return "";
  const seconds = Math.max(0, Math.round((end - start) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

/**
 * The token count a run reported, compacted for a row.
 *
 * The row prints the token icon in front of it, so the unit is never spelled
 * out twice. A conversation whose run reported nothing gets an empty label
 * rather than "0": absent and zero are different measurements, and printing a
 * zero would claim the provider counted it.
 */
export function sessionTokenLabel(tokens: number | undefined): string {
  if (typeof tokens !== "number" || !Number.isFinite(tokens) || tokens < 0)
    return "";
  const value = Math.round(tokens);
  if (value < 1000) return `${value}`;
  if (value < 1_000_000) {
    const thousands = value / 1000;
    return `${thousands < 10 ? thousands.toFixed(1).replace(/\.0$/u, "") : Math.round(thousands)}k`;
  }
  return `${(value / 1_000_000).toFixed(1).replace(/\.0$/u, "")}M`;
}

/** The model id without its provider prefix, so a row names the model. */
export function sessionModelLabel(model: string | undefined): string {
  const clean = sanitizeText((model ?? "").trim());
  if (!clean) return "";
  const short = clean.includes("/")
    ? clean.slice(clean.lastIndexOf("/") + 1)
    : clean;
  return [...short].slice(0, 18).join("");
}

/** The facts one browser row prints after its cursor gutter. */
export interface SessionRowFacts {
  readonly glyph: string;
  readonly title: string;
  readonly model: string;
  readonly elapsed: string;
  readonly tokens: string;
  readonly children: number;
}

/**
 * One browser row: glyph, title, then as many facts as still fit.
 *
 * Each fact carries its own icon, so a number says what it measures without
 * the word beside it: "tok" and "sub" would repeat the glyph they follow. The
 * title is what identifies the row, so it is kept at every width and the
 * trailing facts drop from the least important end: child count first, then
 * tokens, then elapsed, then model. A row that dropped the title to keep a
 * token count would be a row nobody could pick out.
 */
export function sessionRowLine(
  facts: SessionRowFacts,
  width: number,
  icons: SessionRowIcons = sessionRowIcons(),
): string {
  const cells = Math.max(1, Math.floor(width));
  const head = `${facts.glyph} `;
  const factsTail = [
    facts.model === "" ? "" : `${icons.model} ${facts.model}`,
    facts.elapsed === "" ? "" : `${icons.time} ${facts.elapsed}`,
    facts.tokens === "" ? "" : `${icons.tokens} ${facts.tokens}`,
    facts.children > 0 ? `${icons.children} ${facts.children}` : "",
  ].filter((part) => part !== "");
  const titleWidth = visibleLength(facts.title);
  // First pass: keep the whole title, so a row that can afford the facts
  // never shows a truncated name beside a count it did not need.
  for (let keep = factsTail.length; keep >= 0; keep -= 1) {
    const tail = keep === 0 ? "" : ` · ${factsTail.slice(0, keep).join(" · ")}`;
    const room = cells - visibleLength(head) - visibleLength(tail);
    if (room >= titleWidth)
      return `${head}${facts.title}${tail}`;
  }
  // Second pass: no suffix leaves the title whole, so shorten it and drop the
  // least important fact until a title worth reading still fits.
  for (let keep = factsTail.length; keep >= 0; keep -= 1) {
    const tail = keep === 0 ? "" : ` · ${factsTail.slice(0, keep).join(" · ")}`;
    const room = cells - visibleLength(head) - visibleLength(tail);
    if (room >= 8) return `${head}${fit(facts.title, room)}${tail}`;
  }
  return fit(`${head}${facts.title}`, cells);
}

/** One conversation as the browser model keeps it. */
export interface SessionBrowserEntry extends SessionRowFacts {
  readonly id: string;
  readonly section: SessionSectionId;
  readonly status: string;
  readonly archived: boolean;
  readonly parentId?: string;
}

export interface SessionBrowserSection {
  readonly id: SessionSectionId;
  readonly count: number;
}

/** The fields the browser reads. SessionView satisfies this shape. */
export interface SessionBrowserSource {
  readonly id: string;
  readonly title?: string;
  readonly model?: string;
  readonly status?: string;
  readonly archived?: boolean;
  readonly parentId?: string;
  readonly createdAt?: string;
  readonly updatedAt?: string;
  readonly runTokenCount?: number;
}

export interface SessionBrowserModel {
  /** Section headings with their session rows, in section order. */
  readonly nodes: TreeNode[];
  readonly entries: Map<string, SessionBrowserEntry>;
  readonly sections: readonly SessionBrowserSection[];
}

/**
 * Build the browser model: one collapsible section per non-empty bucket.
 *
 * Empty buckets are omitted rather than printed with a zero, because a
 * heading that never has rows is a row the operator has to read to learn
 * nothing. Order inside a section is the caller's, which is pinned first and
 * then most recently updated.
 */
export function buildSessionBrowser(
  sessions: readonly SessionBrowserSource[],
): SessionBrowserModel {
  const childCounts = new Map<string, number>();
  for (const session of sessions)
    if (session.parentId)
      childCounts.set(
        session.parentId,
        (childCounts.get(session.parentId) ?? 0) + 1,
      );
  const entries = new Map<string, SessionBrowserEntry>();
  const bySection = new Map<SessionSectionId, TreeNode[]>();
  for (const session of sessions) {
    const section = sessionSection(session);
    const entry: SessionBrowserEntry = {
      id: session.id,
      section,
      status: session.status ?? "unknown",
      archived: session.archived === true,
      ...(session.parentId === undefined ? {} : { parentId: session.parentId }),
      glyph: sessionRowGlyph(session, section),
      title: sanitizeText(session.title?.trim() || session.id),
      model: sessionModelLabel(session.model),
      elapsed: sessionElapsedLabel(
        session.createdAt,
        session.updatedAt ?? session.createdAt,
      ),
      tokens: sessionTokenLabel(session.runTokenCount),
      children: childCounts.get(session.id) ?? 0,
    };
    entries.set(entry.id, entry);
    const rows = bySection.get(section) ?? [];
    rows.push({
      id: entry.id,
      label: entry.title,
      depth: 1,
      hasChildren: false,
    });
    bySection.set(section, rows);
  }
  const nodes: TreeNode[] = [];
  const sections: SessionBrowserSection[] = [];
  for (const id of SESSION_SECTION_ORDER) {
    const children = bySection.get(id);
    if (!children?.length) continue;
    sections.push({ id, count: children.length });
    nodes.push({
      id: `section:${id}`,
      label: sessionSectionLabel(id, children.length),
      depth: 0,
      hasChildren: true,
      children,
    });
  }
  return { nodes, entries, sections };
}

/**
 * The first frame of the browser: the working set open, everything else one
 * keystroke away, and the cursor on the first conversation rather than on the
 * heading above it, because Enter on a heading folds a group instead of
 * opening the conversation the operator came for.
 */
export function initialSessionBrowserState(
  model: SessionBrowserModel,
): TreeState {
  const expanded = new Set<string>();
  const first = model.sections[0];
  if (first) expanded.add(`section:${first.id}`);
  const cursor = model.nodes[0]?.children?.length ? 1 : 0;
  return { expanded, cursor };
}

/** The heading text for one section row: the bucket and its count badge. */
export function sessionSectionLabel(
  id: SessionSectionId,
  count: number,
): string {
  return `${id} (${count})`;
}

/**
 * The chevron in front of a section heading.
 *
 * It is one cell in every preset, because layout.ts counts U+2600 to U+27BF as
 * two and a heavier triangle would shift the heading and every row under it.
 * The ASCII preset gets the plain pair for terminals without the shapes.
 */
export function sessionSectionChevron(
  expanded: boolean,
  preset?: SymbolPreset,
): string {
  if (preset === "ascii") return expanded ? "v" : ">";
  return expanded ? "▾" : "▸";
}

/**
 * The one-line key bar under the browser.
 *
 * Only the keys that change what is on screen stay: movement, inspect, group
 * fold and the way back to Chat. "returns to Chat" spelled out the destination
 * of Esc, which the key itself already says, and the filter keys are printed
 * once already by the frame's own legend. The tail drops first, so a 40 column
 * terminal still reads a whole phrase instead of a truncated one.
 *
 * The arrow glyphs are the preset's: an ASCII terminal has no arrow shapes and
 * would print them as a missing-glyph box, so movement is `^v` there. Enter is
 * spelled in both presets because it has no one-cell ASCII glyph and a
 * printable stand-in would read as a literal key the browser does not bind.
 * Spelling it keeps the same words in both presets, so the bar never gains a
 * word on the ASCII frame that the Unicode one does not print.
 */
export function sessionBrowserHint(
  width: number,
  preset?: SymbolPreset,
): string {
  const cells = Math.max(1, Math.floor(width));
  const arrows = preset === "ascii" ? "^v" : "↑↓";
  const variants = [
    `${arrows} move · Enter inspect · g group · esc chat`,
    `${arrows} move · Enter inspect · g group · esc`,
    `${arrows} move · Enter inspect · esc chat`,
    `${arrows} move · Enter inspect`,
    `${arrows} Enter inspect`,
    `${arrows} Enter`,
  ];
  const whole = variants.find((line) => visibleLength(line) <= cells);
  return whole ?? fit(variants[variants.length - 1]!, cells);
}

function sessionTimestamp(value: string | undefined): string {
  const timestamp = Date.parse(value ?? "");
  return Number.isFinite(timestamp)
    ? `${new Date(timestamp).toISOString().slice(0, 16).replace("T", " ")} UTC`
    : "unknown";
}

/** The clock time of a retained event, for the inspector's recent list. */
function sessionClock(value: string | undefined): string {
  const timestamp = Date.parse(value ?? "");
  return Number.isFinite(timestamp)
    ? new Date(timestamp).toISOString().slice(11, 16)
    : "unknown";
}

/** One retained event as the sessions inspector prints it. */
function sessionEventLine(event: SessionEvent): string {
  const clock = sessionClock(event.at);
  if (event.kind === "tool") {
    const tool =
      typeof event.payload?.tool === "string"
        ? sanitizeText(event.payload.tool)
        : "tool";
    return `${clock} · ${tool} ${event.type === "tool.started" ? "started" : "completed"}`;
  }
  if (event.kind === "error") return `${clock} · run error`;
  if (event.kind === "user") return `${clock} · prompt submitted`;
  if (event.kind === "assistant") return `${clock} · agent response`;
  return `${clock} · ${sanitizeText(event.type ?? event.kind)}`;
}

/**
 * The risk badge for an approval row, from the reversibility class the
 * registry gave the call.
 *
 * r0 is fully reversible and its effect stays inside the workspace, so it
 * reads as local. r1 to r3 leave a trace, need mitigation or cannot be undone
 * at all, so they read as external. An unclassified call is not a low risk
 * call: it says nothing about what it may do, so it gets a question mark
 * rather than borrowing the local badge. The class word itself stays on the
 * row beside the badge, so the badge never has to be decoded.
 */
export function approvalRiskBadge(hold: {
  readonly call?: { readonly klass?: unknown; readonly unclassified?: unknown };
}): string {
  // An unclassified call carries the assumed worst class, so the class alone
  // would read as a measured r3. The record says it was never classified, and
  // that is a different fact from "classified and irreversible".
  if (hold.call?.unclassified === true) return "[?] unclassified";
  const klass =
    typeof hold.call?.klass === "string"
      ? hold.call.klass.trim().toLowerCase()
      : "";
  if (klass === "r0") return "[0] local";
  if (klass === "r1" || klass === "r2" || klass === "r3")
    return "[!] external";
  return "[?] unclassified";
}

/** One line banner for the oldest pending hold, pinned above every tab so
 * an approval is never hidden behind a panel switch. The status bar badge
 * keeps the count; this banner keeps the decision and its keys.
 *
 * The line is assembled from the most important parts down, and the decision
 * keys outrank the tool name and the hold id. A 40 column frame cannot fit
 * the whole sentence, and a banner that drops the keys has dropped the only
 * thing on it the operator can act on. */
export function approvalBannerLines(
  holds: readonly {
    readonly holdId: string;
    readonly call: { readonly tool: string; readonly klass?: string };
  }[],
  width: number,
  decisionKeys = true,
): string[] {
  if (!holds.length) return [];
  const first = holds[0]!;
  const klass = first.call.klass ? ` [${first.call.klass.toUpperCase()}]` : "";
  const keys = decisionKeys ? " | [a] approve [d] deny" : "";
  const rest =
    holds.length > 1
      ? ` (+${holds.length - 1} more, /approvals)`
      : " (/approvals)";
  const tool = sanitizeText(first.call.tool);
  const id = sanitizeText(first.holdId.slice(0, 8));
  const variants = [
    `[!] APPROVAL PENDING${klass} ${tool} ${id}${keys}${rest}`,
    `[!] APPROVAL PENDING${klass} ${tool}${keys}${rest}`,
    `[!] APPROVAL PENDING${klass}${keys}${rest}`,
    `[!] HOLD${klass}${keys}${rest}`,
    `[!] HOLD${klass}${keys}`,
    `[!] HOLD${keys}`,
  ];
  const line =
    variants.find((candidate) => visibleLength(candidate) <= width) ??
    `[!] HOLD${keys}`;
  return [fit(sanitizeText(line), width)];
}

/** The TUI mode is a local prompt prefix only. No server readiness channel
 * exists behind this UI yet, so the label always says local only, the same
 * way the control plane labels an unenforced preset. */
export function modeAuthorityLabel(mode: TuiMode): string {
  return `mode: ${mode} (local only, not enforced)`;
}

const APPROVAL_EVIDENCE_LABELS = {
  tool: "tool           ",
  class: "class          ",
  blastRadius: "blast radius   ",
  matchedRule: "matched rule   ",
  precondition: "precondition   ",
  postcondition: "postcondition  ",
} as const;
const UNDO_OPERATION_LABEL = "Operation: ";

/** Approval evidence for the decision screen. Tool, class, radius and the
 * matched registry case prose come from the hold when the server supplies
 * them. Rule id, precondition details and postcondition render as unknown
 * when the server did not supply them, never invented. */
export function approvalEvidenceLines(hold: {
  readonly holdId: string;
  readonly call: {
    readonly tool?: unknown;
    readonly klass?: unknown;
    readonly blastRadius?: unknown;
    readonly reason?: unknown;
    readonly workspace?: unknown;
    readonly connector?: unknown;
    readonly policyRule?: unknown;
    readonly precondition?: unknown;
    readonly postcondition?: unknown;
  };
  readonly ruleIndex?: unknown;
  readonly matchedRule?: unknown;
}): string[] {
  const call = hold.call ?? {};
  const textOf = (value: unknown): string | undefined =>
    typeof value === "string" && value ? value : undefined;
  const tool = textOf(call.tool) ?? "unknown tool";
  const klass =
    typeof call.klass === "string" && call.klass
      ? call.klass.toUpperCase()
      : "unknown class";
  const radius =
    typeof call.blastRadius === "number" &&
    Number.isSafeInteger(call.blastRadius) &&
    call.blastRadius >= 0
      ? `${call.blastRadius} targets, measured`
      : "radius unknown";
  // The workbench hold keeps the matched registry case prose in reason, so
  // that prose is the precondition evidence. Anything else is unknown.
  const precondition =
    textOf(call.precondition) ??
    textOf(call.reason) ??
    "unknown (the server did not supply a precondition)";
  const postcondition =
    textOf(call.postcondition) ??
    "unknown (the server does not report a postcondition)";
  const ruleIndex =
    typeof hold.ruleIndex === "number"
      ? `policy rule ${hold.ruleIndex}`
      : (textOf(hold.matchedRule) ??
        textOf(call.policyRule) ??
        "unknown (the server did not supply a matched rule id)");
  return [
    `${APPROVAL_EVIDENCE_LABELS.tool}${sanitizeText(tool)}`,
    `${APPROVAL_EVIDENCE_LABELS.class}${sanitizeText(klass)}`,
    `${APPROVAL_EVIDENCE_LABELS.blastRadius}${sanitizeText(radius)}`,
    `${APPROVAL_EVIDENCE_LABELS.matchedRule}${sanitizeText(ruleIndex)}`,
    `${APPROVAL_EVIDENCE_LABELS.precondition}${sanitizeText(precondition)}`,
    `${APPROVAL_EVIDENCE_LABELS.postcondition}${sanitizeText(postcondition)}`,
  ];
}

/** Diff rows carried by a hold, when a future server supplies them. Today
 * neither the workbench nor the proxy hold carries a diff, so approvals
 * review the full call scope. */
export function holdDiffRows(hold: {
  readonly call: {
    readonly tool?: unknown;
    readonly diff?: unknown;
    readonly before?: unknown;
    readonly after?: unknown;
  };
}): string[] | undefined {
  const call = hold.call ?? {};
  if (typeof call.diff === "string" && call.diff) return call.diff.split("\n");
  if (typeof call.before === "string" && typeof call.after === "string")
    return unifiedDiff(call.before, call.after);
  return undefined;
}

/** Review lines for an approval: evidence first, then an optional
 * selectable diff. Module level so tests can drive it without a running
 * session; the class keeps a private alias for the same builders. */
export function approvalReview(hold: {
  readonly holdId: string;
  readonly call: {
    readonly tool?: unknown;
    readonly klass?: unknown;
    readonly blastRadius?: unknown;
    readonly reason?: unknown;
    readonly workspace?: unknown;
    readonly connector?: unknown;
    readonly policyRule?: unknown;
    readonly precondition?: unknown;
    readonly postcondition?: unknown;
    readonly diff?: unknown;
    readonly before?: unknown;
    readonly after?: unknown;
  };
  readonly ruleIndex?: unknown;
  readonly matchedRule?: unknown;
}): {
  readonly lines: string[];
  readonly hunks?: { chunks: string[][]; selected: boolean[] };
  readonly hunkBase?: string[];
} {
  const evidence = approvalEvidenceLines(
    hold as Parameters<typeof approvalEvidenceLines>[0],
  );
  const diffRows = holdDiffRows(hold);
  const chunks = diffRows ? splitDiffHunks(diffRows) : [];
  if (!chunks.length) return { lines: [...evidence, ""] };
  const selected = chunks.map(() => true);
  const hunkBase = [
    ...evidence,
    "",
    "DIFF SCOPE, client side: press 1-9 to toggle a hunk.",
    "The server applies the full call until scope is enforced.",
  ];
  return {
    lines: [...hunkBase, ...renderHunkSelection(chunks, selected)],
    hunks: { chunks, selected },
    hunkBase,
  };
}

/** Tabs where typing filters the list, like a finder. Chat,
 * policy text and help take no filter; every other tab lists items. */
const FILTER_TABS: readonly WorkspaceTab[] = [
  "sessions",
  "runs",
  "documents",
  "ledger",
  "approvals",
  "policy",
  "tools",
  "mcp",
  "status",
  "models",
  "usage",
];

/** OMP-style selectors search on every printable character. */
export function filterKeyForTab(
  value: string | undefined,
  key: { name?: string; ctrl?: boolean; meta?: boolean },
  tab: WorkspaceTab,
): string | undefined {
  if (!FILTER_TABS.includes(tab)) return undefined;
  if (!value || [...value].length !== 1 || key.ctrl || key.meta)
    return undefined;
  if (/[\x00-\x1f\x7f-\x9f]/.test(value)) return undefined;
  return value;
}

/** Reverse history search over sent prompts, most recent first. */
export function searchHistoryPrompts(
  prompts: readonly string[],
  query: string,
): string[] {
  const needle = query.toLocaleLowerCase();
  if (!needle) return [...prompts];
  return prompts.filter((item) => item.toLocaleLowerCase().includes(needle));
}

/** Checklist items are read from real records, never invented. */
export interface TuiTodo {
  readonly done: boolean;
  readonly text: string;
  readonly seq: number;
  /** The structured state, absent for a row read out of markdown. */
  readonly status?: TodoStatus;
}
export function extractTodos(
  events: readonly {
    seq: number;
    kind: string;
    type?: string;
    text: string;
  }[],
): TuiTodo[] {
  const out: TuiTodo[] = [];
  for (const event of events) {
    if (event.kind === "user") {
      out.length = 0;
      continue;
    }
    if (event.type && event.type !== "message.completed") continue;
    if (event.kind !== "assistant") continue;
    const checklist: TuiTodo[] = [];
    let fence = "";
    for (const line of event.text.split("\n")) {
      const marker = /^\s{0,3}(`{3,}|~{3,})(.*)$/.exec(line);
      if (
        marker &&
        (!fence ||
          (marker[1]![0] === fence[0] &&
            marker[1]!.length >= fence.length &&
            !marker[2]!.trim()))
      ) {
        fence = fence ? "" : marker[1]!;
        continue;
      }
      if (fence) continue;
      const found = /^\s*[-*+]\s*\[( |x|X)\]\s+(.+)$/.exec(line);
      if (found)
        checklist.push({
          done: found[1] !== " ",
          text: found[2]!.trim().slice(0, 200),
          seq: event.seq,
        });
    }
    if (checklist.length) out.splice(0, out.length, ...checklist);
  }
  return out;
}

type ChatEventSummary = Readonly<{
  latestUser?: SessionEvent;
  lastVisible?: SessionEvent;
  usage?: Record<string, unknown>;
  totalTodos: number;
  openTodos: number;
  todos: readonly TuiTodo[];
  /** True while a structured event owns the checklist for this run. */
  structuredTodos: boolean;
  /** The run the structured event belongs to, when it named one. */
  structuredTodosRunId?: string;
  eventCount: number;
}>;

const LOCAL_ICON_TABS: readonly string[] = [
  "overview",
  "chat",
  "sessions",
  "documents",
  "ledger",
  "approvals",
  "policy",
  "tools",
  "models",
  "usage",
  "help",
];
const LOCAL_ICON_SEMANTICS = [
  "subagents",
  "heartbeats",
  "shells",
  "appearance",
  "interaction",
  "composer",
  "timestamps",
  "context",
  "queue",
  "network",
  "run",
  "retry",
  "refinement",
  "search",
  "settings",
  "timeout",
] as const;
const localIconLabelCache = new WeakMap<
  LocalTabIcons,
  Map<ColorTheme, readonly string[]>
>();
const localIconPatternCache = new WeakMap<readonly string[], RegExp>();

function trustedLocalIconLabels(
  icons: LocalTabIcons | undefined,
  theme: ColorTheme,
): readonly string[] {
  if (!icons) return [];
  let byTheme = localIconLabelCache.get(icons);
  if (!byTheme) {
    byTheme = new Map();
    localIconLabelCache.set(icons, byTheme);
  }
  const cached = byTheme.get(theme);
  if (cached) return cached;
  const labels = new Set<string>();
  for (const tab of LOCAL_ICON_TABS) {
    const label = kittyTabIconLabel(tab, icons, theme);
    if (label) labels.add(label);
  }
  for (const semantic of LOCAL_ICON_SEMANTICS) {
    const label = kittySemanticIconLabel(semantic, icons, theme);
    if (label) labels.add(label);
  }
  const provider = kittyProviderIconLabel(icons, theme);
  if (provider) labels.add(provider);
  const result = [...labels].sort((left, right) => right.length - left.length);
  byTheme.set(theme, result);
  return result;
}

function trustedIconPattern(labels: readonly string[]): RegExp | undefined {
  if (!labels.length) return undefined;
  let cached = localIconPatternCache.get(labels);
  if (!cached) {
    const escaped = labels.map((label) =>
      label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
    );
    cached = new RegExp(escaped.join("|"), "g");
    localIconPatternCache.set(labels, cached);
  }
  return cached;
}

function sanitizeRendererText(value: string): string {
  // Renderer-owned icon labels may have passed through an older sanitizer
  // that replaced ESC with "?", leaving visible fragments like `?[38;2…m`.
  // Strip complete ANSI first, then remove only those damaged SGR remnants.
  return sanitizeText(stripAnsi(value).replace(/\?\[[0-?]*[ -/]*m/g, ""));
}

/** Split only exact, locally generated Kitty icon labels out of untrusted text. */
function safeTextUnits(
  value: string,
  trustedIcons: readonly string[],
): string[] {
  const pattern = trustedIconPattern(trustedIcons);
  if (!pattern) return [...sanitizeRendererText(value)];
  const units: string[] = [];
  let cursor = 0;
  for (const match of value.matchAll(pattern)) {
    const start = match.index ?? cursor;
    units.push(...sanitizeRendererText(value.slice(cursor, start)));
    units.push(match[0]);
    cursor = start + match[0].length;
  }
  units.push(...sanitizeRendererText(value.slice(cursor)));
  return units;
}

function fitWithTrustedIcons(
  value: string,
  width: number,
  trustedIcons: readonly string[],
  side: "left" | "right" = "right",
): string {
  if (width <= 0) return "";
  const units = safeTextUnits(value, trustedIcons);
  const safe = units.join("");
  if (visibleLength(safe) <= width) return safe;
  if (width === 1) return ".";
  const kept: string[] = [];
  let used = 0;
  const ordered = side === "left" ? [...units].reverse() : units;
  for (const unit of ordered) {
    const cells = visibleLength(unit);
    if (used + cells > width - 1) break;
    kept.push(unit);
    used += cells;
  }
  const content = side === "left" ? kept.reverse().join("") : kept.join("");
  return side === "left" ? `.${content}` : `${content}.`;
}

function padWithTrustedIcons(
  value: string,
  width: number,
  trustedIcons: readonly string[],
): string {
  const fitted = fitWithTrustedIcons(value, width, trustedIcons);
  return `${fitted}${" ".repeat(Math.max(0, width - visibleLength(fitted)))}`;
}

const chatEventSummaries = new WeakMap<
  readonly SessionEvent[],
  ChatEventSummary
>();
const chatEventPrefixSummaries = new WeakMap<SessionEvent, ChatEventSummary>();

function chatEventSummary(events: readonly SessionEvent[]): ChatEventSummary {
  const cached = chatEventSummaries.get(events);
  if (cached) return cached;
  let prefix: ChatEventSummary | undefined;
  let prefixEnd = 0;
  // Workbench appends immutable events while a response streams. Reuse the
  // longest cached prefix so each new delta costs only the newly appended tail,
  // rather than rescanning the full conversation on every render.
  for (let index = events.length - 1; index >= 0; index--) {
    const candidate = chatEventPrefixSummaries.get(events[index]!);
    if (candidate?.eventCount === index + 1) {
      prefix = candidate;
      prefixEnd = index + 1;
      break;
    }
  }
  let latestUser = prefix?.latestUser;
  let lastVisible = prefix?.lastVisible;
  let usage = prefix?.usage;
  let totalTodos = prefix?.totalTodos ?? 0;
  let openTodos = prefix?.openTodos ?? 0;
  let todos = prefix?.todos ?? [];
  let structuredTodos = prefix?.structuredTodos ?? false;
  let structuredTodosRunId = prefix?.structuredTodosRunId;
  for (let index = prefixEnd; index < events.length; index++) {
    const event = events[index]!;
    if (event.kind === "user") {
      latestUser = event;
      totalTodos = 0;
      openTodos = 0;
      todos = [];
      structuredTodos = false;
      structuredTodosRunId = undefined;
    }
    if (event.type !== "run.status" && event.kind !== "usage")
      lastVisible = event;
    if (event.kind === "usage") usage = event.payload;
    if (event.kind === "tool" && event.type === "todo.updated") {
      // The structured checklist is the model's own record, so it outranks
      // anything read out of a message. A payload this renderer cannot read is
      // ignored whole, and the markdown fallback stays in charge.
      const structured = todoItemsFromEventPayload(event.payload);
      if (structured) {
        todos = structured.map((item) => ({ ...item, seq: event.seq }));
        totalTodos = todos.length;
        openTodos = todos.filter((item) => !item.done).length;
        structuredTodos = true;
        structuredTodosRunId = event.runId;
      }
    }
    if (
      (event.type === undefined || event.type === "message.completed") &&
      event.kind === "assistant"
    ) {
      // A structured checklist owns the same run it was recorded in. A later
      // message in that run cannot replace it, because a second rendering of
      // the same plan would be a guess about which one is current. In a new
      // run the structured record is stale, so markdown may speak again.
      const structuredOwnsRun =
        structuredTodos &&
        (structuredTodosRunId === undefined ||
          event.runId === undefined ||
          structuredTodosRunId === event.runId);
      if (structuredOwnsRun) continue;
      const checklist = extractTodos([event]);
      if (checklist.length) {
        structuredTodos = false;
        structuredTodosRunId = undefined;
        totalTodos = checklist.length;
        openTodos = checklist.filter((item) => !item.done).length;
        todos = checklist;
      }
    }
    chatEventPrefixSummaries.set(event, {
      latestUser,
      lastVisible,
      usage,
      totalTodos,
      openTodos,
      todos,
      structuredTodos,
      ...(structuredTodosRunId === undefined ? {} : { structuredTodosRunId }),
      eventCount: index + 1,
    });
  }
  const summary = {
    latestUser,
    lastVisible,
    usage,
    totalTodos,
    openTodos,
    todos,
    structuredTodos,
    ...(structuredTodosRunId === undefined ? {} : { structuredTodosRunId }),
    eventCount: events.length,
  };
  chatEventSummaries.set(events, summary);
  return summary;
}

/** The short phase word the task header leads with. */
function taskPhaseWord(
  event: SessionEvent | undefined,
  waiting: boolean,
): string {
  if (waiting) return "Waiting for approval";
  const toolName =
    typeof event?.payload?.tool === "string"
      ? sanitizeText(event.payload.tool)
      : "";
  if (event?.type === "tool.started") return toolName || "Tool";
  if (event?.type === "message.delta") return "Writing response";
  if (event?.type === "tool.result") {
    const result = toolDetailRecord(event.payload?.result);
    return `${toolName || "Tool"} ${result?.isError === true ? "failed" : "result received"}`;
  }
  if (
    event?.type === "message.completed" &&
    event.payload?.toolCallsPresent === true
  )
    return "Dispatching requested tools";
  return "Waiting for provider";
}

/**
 * The phase word for a row that has no space for a sentence.
 *
 * It says the same thing as taskPhaseWord in one word, because a forty column
 * brand row carries a count beside it. A word is a label, never a measurement:
 * the checklist count next to it stays the real one.
 */
function compactPhaseWord(
  event: SessionEvent | undefined,
  waiting: boolean,
): string {
  if (waiting) return "Waiting";
  const toolName =
    typeof event?.payload?.tool === "string"
      ? sanitizeText(event.payload.tool)
      : "";
  if (event?.type === "tool.started") return toolName || "Tool";
  if (event?.type === "message.delta") return "Writing";
  if (event?.type === "tool.result") return toolName || "Tool";
  return "Working";
}

/**
 * The task header carried by the existing phase-wave row while a run is in
 * flight. It names the phase, the conversation it belongs to, how much of the
 * checklist is done, how long the turn has been open and the provider's own
 * token rate. Every part comes from real state; a part with no source is
 * omitted rather than guessed, and the row it rides on already exists, so this
 * costs no extra line.
 *
 * `tokensPerSecond` is printed only when a provider reported a rate. The
 * Workbench records token counts and no rate, so the label is normally `n/a`
 * rather than a count divided by a wall clock that a pause would flatter.
 */
export function taskHeaderLabel(input: {
  readonly phase: string;
  readonly title?: string;
  readonly elapsedSeconds?: number;
  readonly todos?: { readonly done: number; readonly total: number };
  readonly barWidth?: number;
  readonly tokensPerSecond?: string;
}): string {
  const parts: string[] = [];
  const phase = sanitizeText(stripAnsi(input.phase)).trim();
  if (phase) parts.push(phase);
  const title = sanitizeText(stripAnsi(input.title ?? ""))
    .replace(/\s+/g, " ")
    .trim();
  if (title) parts.push(title);
  if (input.todos && input.todos.total > 0) {
    const requested = Number.isFinite(input.barWidth)
      ? Math.max(0, input.barWidth!)
      : 8;
    const gauge = todoProgressBar(
      input.todos.done,
      input.todos.total,
      Math.min(TODO_BAR_MAX, requested),
    );
    const count = `${input.todos.done}/${input.todos.total}`;
    parts.push(gauge === "" ? count : `${gauge} ${count}`);
  }
  if (
    typeof input.elapsedSeconds === "number" &&
    Number.isFinite(input.elapsedSeconds) &&
    input.elapsedSeconds >= 0
  )
    parts.push(`${Math.floor(input.elapsedSeconds)}s`);
  const rate = sanitizeText(stripAnsi(input.tokensPerSecond ?? "")).trim();
  if (rate) parts.push(`tok/s ${rate}`);
  return parts.join(" · ");
}

/**
 * The task header for a frame with no room for a sentence: the phase word and
 * the real checklist count, for example `Working 3/7`.
 *
 * It rides the compact brand row, which the frame already prints, so the
 * smallest terminal keeps its logo, composer, transcript and decision keys.
 */
export function compactTaskHeaderLabel(input: {
  readonly phase: string;
  readonly todos?: { readonly done: number; readonly total: number };
}): string {
  const phase = sanitizeText(stripAnsi(input.phase)).replace(/\s+/g, " ").trim();
  const progress =
    input.todos && input.todos.total > 0
      ? `${input.todos.done}/${input.todos.total}`
      : "";
  if (phase === "") return progress;
  return progress === "" ? phase : `${phase} ${progress}`;
}

/** How a tool result text states a test outcome, or undefined when it does not. */
export function runTestsVerdict(text: string): "passed" | "failed" | undefined {
  const value = sanitizeText(stripAnsi(text));
  // Only an explicit report counts. A runner that prints neither word leaves
  // the metric unmeasured, and the summary then says n/a rather than assuming
  // success from a quiet exit.
  const counted = /\b(\d+)\s+(?:tests?\s+)?(?:failed|failing)\b/i.exec(value);
  if (counted && Number(counted[1]) > 0) return "failed";
  if (/\bFAIL\b/.test(value)) return "failed";
  if (/\b(?:tests?\s+)?(?:failed|failing)\b/i.test(value)) return "failed";
  if (/\ball\s+tests?\s+passed\b/i.test(value)) return "passed";
  if (/\b\d+\s+(?:tests?\s+)?passed\b/i.test(value)) return "passed";
  if (/\bPASS\b/.test(value)) return "passed";
  return undefined;
}

/** Terminal run statuses, as Workbench records them on a run.status event. */
const TERMINAL_RUN_STATUSES: Readonly<Record<string, RunSummary["outcome"]>> = {
  idle: "done",
  done: "done",
  completed: "done",
  failed: "failed",
  error: "failed",
  cancelled: "cancelled",
  canceled: "cancelled",
  stopped: "cancelled",
};

/** Write and edit tool kinds: the ones that change a file on disk. */
function isFileWriteTool(toolName: string): boolean {
  const kind = toolCardKind(toolName);
  if (kind === "write" || kind === "edit") return true;
  // A namespaced tool keeps its operation as the last token, for example
  // void_workspace_write, so a write is counted even when the name is not one
  // of the bare verbs the card map knows.
  const operation = toolName
    .trim()
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((part) => part !== "")
    .at(-1);
  return operation === "write" || operation === "edit" || operation === "patch";
}

/**
 * The receipt for the run a conversation just finished, or undefined when the
 * run has not settled.
 *
 * The window is the events that carry the session's current `runId`, so the
 * numbers describe this run and not the conversation's history. A window whose
 * first event is not the run's own user message is incomplete (the view trims
 * its oldest events), so the counts are left unmeasured instead of being
 * understated. Tests come only from a tool result that says passed or failed.
 */
export function runSummaryFromEvents(input: {
  readonly events: readonly SessionEvent[];
  readonly runId?: string;
}): RunSummary | undefined {
  const runId = input.runId;
  if (runId === undefined || runId === "") return undefined;
  const window = input.events.filter((event) => event.runId === runId);
  if (window.length === 0) return undefined;
  let outcome: RunSummary["outcome"] | undefined;
  for (const event of window) {
    if (event.type !== "run.status") continue;
    const status =
      typeof event.payload?.status === "string"
        ? TERMINAL_RUN_STATUSES[event.payload.status.toLowerCase()]
        : undefined;
    if (status !== undefined) outcome = status;
  }
  if (outcome === undefined) return undefined;
  const startedAt = Date.parse(window[0]!.at);
  const settledAt = Date.parse(window[window.length - 1]!.at);
  const ms =
    Number.isFinite(startedAt) &&
    Number.isFinite(settledAt) &&
    settledAt >= startedAt
      ? settledAt - startedAt
      : undefined;
  // A complete window starts with the prompt that opened the run. Anything
  // else means the oldest events were trimmed, so a count would be a floor
  // presented as a total.
  const complete = window[0]!.kind === "user";
  if (!complete) return { outcome, ...(ms === undefined ? {} : { ms }) };
  let tokens = 0;
  let tokenRecords = 0;
  let tools = 0;
  const paths = new Set<string>();
  let tests: "passed" | "failed" | undefined;
  for (const event of window) {
    if (event.kind === "usage") {
      // The harness reviewer spends on its own account after the turn settles,
      // so its usage is a separate record and not part of this run's cost.
      if (event.payload?.source === "harness") continue;
      const total =
        typeof event.payload?.total_tokens === "number" &&
        Number.isFinite(event.payload.total_tokens)
          ? event.payload.total_tokens
          : undefined;
      if (total === undefined) continue;
      tokens += total;
      tokenRecords += 1;
      continue;
    }
    if (event.kind !== "tool") continue;
    if (event.type === "tool.started") {
      tools += 1;
      const toolName =
        typeof event.payload?.tool === "string" ? event.payload.tool : "";
      if (!isFileWriteTool(toolName)) continue;
      const path = toolPath(toolDetailRecord(event.payload?.arguments));
      if (path !== undefined && path !== "") paths.add(path);
      continue;
    }
    if (event.type !== "tool.result") continue;
    const verdict = runTestsVerdict(
      toolOutputText(event.payload?.result).join("\n"),
    );
    if (verdict !== undefined) tests = verdict;
  }
  return {
    outcome,
    ...(ms === undefined ? {} : { ms }),
    ...(tokenRecords === 0 ? {} : { tokens }),
    tools,
    files: paths.size,
    ...(tests === undefined ? {} : { tests }),
  };
}

/** The activity a child's own transcript proves, as the rail reads it. */
export type SubagentActivity = Pick<
  SubagentSession,
  "lastEventType" | "lastTool" | "lastTarget" | "lastState"
>;

/** A tool result that reports its own failure, in the recorded payload. */
function toolResultFailed(payload: Record<string, unknown> | undefined): boolean {
  if (payload?.isError === true) return true;
  if (toolDetailRecord(payload?.result)?.isError === true) return true;
  const status =
    typeof payload?.status === "string" ? payload.status.toLowerCase() : "";
  return status === "failed" || status === "error";
}

/** The recorded path, else the recorded command, of a tool call. */
function toolActivityTarget(
  args: Record<string, unknown> | undefined,
): string | undefined {
  const path = toolPath(args);
  if (path !== undefined && path !== "") return path;
  const command = toolArgumentText(args, TOOL_COMMAND_KEYS);
  if (command === undefined) return undefined;
  const line = redactToolDetail(command).split("\n", 1)[0]!.trim();
  return line === "" ? undefined : line;
}

/**
 * The latest real tool event in a child's own transcript, or undefined.
 *
 * `Workbench.get(id)` is a plain session map lookup that returns undefined for
 * an unknown id and never throws, so a child that vanished between `list()`
 * and this read simply yields no activity. A result event usually carries no
 * arguments of its own, so its target is recovered from the started event with
 * the same call id. Nothing is derived from the parent's events: a child's
 * work is only reported when the child's own transcript recorded it.
 */
export function subagentActivityFromEvents(
  events: readonly SessionEvent[] | undefined,
): SubagentActivity | undefined {
  if (!Array.isArray(events) || events.length === 0) return undefined;
  const toolEvents = events.filter(
    (event) =>
      event.kind === "tool" &&
      (event.type === "tool.started" || event.type === "tool.result"),
  );
  const latest = toolEvents.at(-1);
  if (latest === undefined) return undefined;
  const payload = latest.payload;
  const tool = typeof payload?.tool === "string" ? payload.tool.trim() : "";
  if (tool === "") return undefined;
  const callId = typeof payload?.callId === "string" ? payload.callId : "";
  let started: SessionEvent | undefined =
    latest.type === "tool.started" ? latest : undefined;
  if (started === undefined && callId !== "") {
    for (let index = toolEvents.length - 1; index >= 0; index -= 1) {
      const event = toolEvents[index]!;
      if (event.type === "tool.started" && event.payload?.callId === callId) {
        started = event;
        break;
      }
    }
  }
  const args =
    toolDetailRecord(payload?.arguments) ??
    toolDetailRecord(started?.payload?.arguments);
  const target = toolActivityTarget(args);
  const state: SubagentActivityState =
    latest.type === "tool.started"
      ? "running"
      : toolResultFailed(payload)
        ? "failed"
        : "completed";
  return {
    lastEventType: latest.type,
    lastTool: tool,
    ...(target === undefined ? {} : { lastTarget: target }),
    lastState: state,
  };
}

/**
 * The fixed right column of the Chat body: TODO first, SUBAGENTS second, then
 * the settled run's receipt.
 *
 * The blocks share a fixed budget. The receipt is a fixed six row card, so it
 * is shown whole or not at all: a card cut after its duration would read as if
 * that were the only thing measured. The checklist and the child cards keep a
 * heading plus one real row each before anything else grows, then the rest is
 * handed out one row at a time in block order. A rule separates the blocks.
 */
export function chatRailLines(input: {
  readonly todos: readonly TodoItem[];
  readonly subagents: readonly SubagentSession[];
  readonly runSummary?: RunSummary;
  readonly width: number;
  readonly height: number;
  readonly now?: number;
  readonly indicator?: string;
}): string[] {
  const width = Number.isFinite(input.width)
    ? Math.max(1, Math.floor(input.width))
    : 1;
  const maximum = Number.isFinite(input.height)
    ? Math.max(0, Math.floor(input.height))
    : 0;
  if (maximum < 1) return [];
  const hasTodos = input.todos.length > 0;
  const hasSubagents = input.subagents.length > 0;
  const hasSummary = input.runSummary !== undefined;
  // A block that cannot reach a heading and one real row is dropped whole
  // rather than printed as a heading with nothing under it.
  const blocks: { key: "todo" | "sub" | "run"; need: number; floor: number }[] =
    [];
  if (hasTodos) blocks.push({ key: "todo", need: input.todos.length + 1, floor: 2 });
  if (hasSubagents)
    blocks.push({
      key: "sub",
      // Each child keeps a title and a state row; its activity row is counted
      // only when the child really reports one, so the budget asks for the
      // rows the rail will print and no more.
      need:
        input.subagents.reduce(
          (total, entry) => total + subagentCardRows(entry),
          1,
        ),
      floor: 3,
    });
  if (hasSummary) blocks.push({ key: "run", need: 6, floor: 6 });
  const shown = blocks.filter((block) => block.floor <= maximum);
  if (shown.length === 0) return [];
  const separators = Math.max(0, shown.length - 1);
  const available = Math.max(0, maximum - separators);
  // The receipt is reserved first, but only when the other blocks still keep
  // their floor afterwards: the live work outranks its receipt.
  const floors = shown.map((block) => Math.min(block.need, block.floor));
  let summaryRows = 0;
  if (hasSummary) {
    const others = floors
      .slice(0, shown.length - 1)
      .reduce((total, floor) => total + floor, 0);
    if (available - others >= 6) summaryRows = 6;
  }
  const granted = floors.slice();
  if (summaryRows > 0) granted[granted.length - 1] = summaryRows;
  const open = summaryRows > 0 ? granted.length - 1 : granted.length;
  let left = available - granted.slice(0, open).reduce((sum, n) => sum + n, 0);
  if (summaryRows > 0) left -= summaryRows;
  // Round robin in block order: every block reaches its floor first, then each
  // takes one row per pass. Nothing is starved and nothing overruns its own
  // need, so a short checklist never hides the whole subagent block.
  while (left > 0) {
    let handed = false;
    for (let index = 0; index < open && left > 0; index += 1) {
      if (granted[index]! >= shown[index]!.need) continue;
      granted[index] += 1;
      left -= 1;
      handed = true;
    }
    if (!handed) break;
  }
  const budget = new Map<string, number>();
  shown.forEach((block, index) => budget.set(block.key, granted[index]!));
  const rows: string[] = [];
  const rule = fit("─".repeat(width), width);
  const todoBudget = budget.get("todo");
  if (todoBudget !== undefined) {
    rows.push(
      ...todoRailLines(input.todos, width, todoBudget, {
        ...(input.indicator === undefined ? {} : { indicator: input.indicator }),
      }),
    );
  }
  const subagentBudget = budget.get("sub");
  if (subagentBudget !== undefined) {
    if (rows.length) rows.push(rule);
    rows.push(
      ...subagentRailLines(
        input.subagents,
        width,
        subagentBudget,
        input.now,
      ),
    );
  }
  if (summaryRows > 0) {
    if (rows.length) rows.push(rule);
    rows.push(...runSummaryLines(input.runSummary!, width));
  }
  return rows.slice(0, maximum);
}

/**
 * A token rate, only when a provider actually reported one.
 *
 * Workbench usage events carry token counts and no rate. Wall-clock division
 * would turn a paused stream into a plausible looking number, so an absent
 * rate is printed as `n/a`.
 */
export function tokensPerSecondLabel(
  usage: Record<string, unknown> | undefined,
): string {
  for (const key of [
    "tokens_per_second",
    "tokensPerSecond",
    "tokens_per_sec",
    "tok_per_sec",
    "tps",
  ]) {
    const value = usage?.[key];
    if (typeof value === "number" && Number.isFinite(value) && value >= 0)
      return value.toFixed(1);
  }
  return "n/a";
}

/** A path with the home directory folded to `~`, when it is under home. */
export function shortenHomePath(
  value: string,
  home = process.env.HOME,
): string {
  const path = sanitizeText(stripAnsi(value)).trim();
  if (path === "") return "";
  const root = home ? sanitizeText(stripAnsi(home)).replace(/[\\/]+$/, "") : "";
  if (root === "") return path;
  if (path === root) return "~";
  if (path.startsWith(`${root}/`) || path.startsWith(`${root}\\`))
    return `~${path.slice(root.length)}`;
  return path;
}

/** The directory keeps this many cells when the row can also hold the branch. */
const LOCATION_DIRECTORY_FLOOR = 8;
/** The footer's own cap on the working directory, unchanged by the branch. */
const LOCATION_DIRECTORY_CAP = 28;

/**
 * The working directory plus the branch it is on, fitted into `available`
 * cells.
 *
 * The directory stays the anchor and keeps its usual cap, and the branch is
 * appended after it. The branch is fitted first: it keeps every cell it needs
 * while the directory still has `LOCATION_DIRECTORY_FLOOR` cells, and a
 * narrow row drops the directory rather than shortening the branch, because a
 * branch the operator cannot read is the same as no branch at all. `status` is
 * `undefined` before the first probe and `null` when git could not answer:
 * both print the directory alone, because an unknown branch is never invented.
 */
export function locationLabel(
  cwd: string,
  status: GitStatus | null | undefined,
  available: number,
): string {
  // Below four cells nothing readable fits, and a lone `.` is noise, not a
  // location.
  if (available < 4) return "";
  const directory = shortenHomePath(cwd);
  const branch = status ? sanitizeBranch(status.branch) : "";
  if (!status || branch === "") return fit(directory, available);
  const label = `${branch}${status.dirty ? "*" : ""}`;
  const labelLength = visibleLength(label);
  // The branch is fitted first and keeps every cell it needs. The directory
  // keeps its floor when the row can hold the whole branch, and otherwise
  // yields to it, because a readable branch is the reason this segment
  // exists. When less than three cells are left, no directory is printed at
  // all and the branch takes the whole row: a one character path stub is
  // noise, not a location.
  const directoryReserve = Math.max(
    1,
    Math.min(LOCATION_DIRECTORY_FLOOR, available - 1 - labelLength),
  );
  const branchShown = fit(
    label,
    Math.max(1, available - 1 - directoryReserve),
  );
  const directoryRoom = available - visibleLength(branchShown) - 1;
  if (directoryRoom < 3) return fit(label, available);
  return `${fit(directory, Math.min(LOCATION_DIRECTORY_CAP, directoryRoom))} ${branchShown}`;
}

/**
 * The composer's motion cadences, in 100 ms frames.
 *
 * A focus sweep is six frames: long enough to read as a deliberate handoff of
 * the keyboard, short enough that a settled frame is the normal frame. The
 * streaming cell travels one cell every eight frames, which is the 800 ms
 * cadence the design pins. Neither cadence is a clock: both are pure
 * functions of the frame counter, so a paused frame is byte identical to the
 * frame it froze on.
 */
export const COMPOSER_SWEEP_FRAMES = 6;
export const COMPOSER_STREAM_FRAMES = 8;
/** The startup splash stays up for 900 ms unless a key dismisses it. */
export const PET_SPLASH_MS = 900;
/** Below this column count a hint keeps only its first clause. */
export const COMPOSER_HINT_FULL_WIDTH = 56;

export type ComposerHintInput = {
  /** The current draft, read only to decide whether it is a command. */
  readonly draft: string;
  /** True when the Chat composer owns the keyboard. */
  readonly focused: boolean;
  /** True while a run is in flight. */
  readonly running: boolean;
  /** True while this session has a pending approval hold. */
  readonly approval: boolean;
  /** True while the newest visible event is a run error the rail still shows. */
  readonly failed?: boolean;
  /** Terminal columns, so a narrow frame keeps the first clause only. */
  readonly width: number;
};

/**
 * One contextual hint at a time.
 *
 * The order is the order of what blocks the operator: an approval they have
 * not answered, a failed run whose rail is still up, a run they can stop, a
 * composer they do not own, then what Enter does with what they typed. A hint
 * that named two unrelated surfaces at once would read as a legend rather
 * than as the next action.
 */
export function composerHint(input: ComposerHintInput): string {
  const full = Math.floor(input.width) > COMPOSER_HINT_FULL_WIDTH;
  const clauses = (first: string, rest: readonly string[] = []): string =>
    full ? [first, ...rest].join(" · ") : first;
  if (input.approval) return "/approvals to review";
  if (input.failed) return clauses("Esc dismiss");
  if (input.running) return clauses("Esc stop", ["Ctrl+O detail"]);
  if (!input.focused) return clauses("Tab to write");
  if (input.draft.trimStart().startsWith("/"))
    return clauses("Tab complete", ["Enter run"]);
  return clauses("Enter send", ["Ctrl+J new line"]);
}

export type ComposerRailInput = {
  readonly label: string;
  /** The contextual hint, or empty to spend no cells on one. */
  readonly hint: string;
  /** The NIB dock text, or empty when the pet lives elsewhere. */
  readonly dock?: string;
  /** The real `@path` the draft references, or empty when it references none. */
  readonly attachment?: string;
  /** The selected model chip, or empty when no model is selected. */
  readonly model?: string;
  /** The context meter, or empty when no prompt tokens were reported. */
  readonly context?: string;
  readonly queue?: string;
  readonly width: number;
  readonly tl: string;
  readonly h: string;
  readonly tr: string;
  /** Gap between the label and the hint. The approval rail uses two cells. */
  readonly gap?: string;
  /** Focus sweep step, or a negative value once the sweep has settled. */
  readonly sweep?: number;
};

/**
 * The top rail: `╭─ <label> <hint> <dock> <chips> ───╮`, exactly `width` cells.
 *
 * Optional slots are added whole, in priority order. The queue can use
 * remaining space, but cannot displace the action hint or a review key.
 *
 * The focus sweep lights one fill cell for six frames and then settles; it
 * changes a glyph, not only a colour, so it survives a monochrome terminal.
 */
export function composerTopRail(input: ComposerRailInput): string {
  const width = Math.max(1, Math.floor(input.width));
  const gap = input.gap ?? " ";
  const lit = input.h === "-" ? "=" : "━";
  let left = `${input.tl}${input.h} ${input.label}`;
  for (const extra of [
    input.hint,
    input.dock ?? "",
    input.attachment ?? "",
    input.model ?? "",
    input.context ?? "",
    input.queue ?? "",
  ]) {
    if (extra === "") continue;
    const candidate = `${left}${gap}${extra}`;
    // A slot that does not fit is dropped whole, and the next one is still
    // considered: a long model name must not cost the operator the short
    // context meter behind it.
    if (visibleLength(candidate) + 1 <= width) left = candidate;
  }
  const room = Math.max(1, width - 1);
  if (visibleLength(left) > room) left = fit(left, room);
  // One space separates the last slot from the fill, as the rail template
  // shows; a rail too narrow for it keeps the corner instead of the space.
  const space = width - visibleLength(left) - 1 >= 1 ? " " : "";
  const span = Math.max(0, width - visibleLength(left) - space.length - 1);
  const cells = Array.from({ length: span }, () => input.h);
  const sweep = input.sweep ?? -1;
  if (sweep >= 0 && sweep < COMPOSER_SWEEP_FRAMES && span > 0)
    cells[sweep % span] = lit;
  return `${left}${space}${cells.join("")}${input.tr}`;
}

/** The tones the composer rail can take, decided by the frame's real state. */
export type ComposerRailTone = "muted" | "accent" | "warning" | "error";

export type ComposerRailState = {
  /** True when the Chat composer owns the keyboard. */
  readonly focused: boolean;
  /** True while a hold is waiting on this session. */
  readonly approval: boolean;
  /** True while the newest visible event is a run error still on the rail. */
  readonly failed: boolean;
};

/**
 * The rail tone: an unanswered approval outranks a failed run, a failed run
 * outranks the focus accent, and an idle rail stays muted.
 *
 * A tone is decoration; the label and the hint already say the same thing in
 * words, which is what keeps the rail readable with colour off.
 */
export function composerRailTone(state: ComposerRailState): ComposerRailTone {
  if (state.approval) return "warning";
  if (state.failed) return "error";
  if (state.focused) return "accent";
  return "muted";
}

/** The most colour stops a truecolor rail gradient spends on one row. */
const COMPOSER_GRADIENT_STOPS = 12;

function hexChannels(hex: string): readonly [number, number, number] {
  const value = Number.parseInt(hex.slice(1), 16);
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
}

function mixHex(from: string, to: string, ratio: number): string {
  const [fr, fg, fb] = hexChannels(from);
  const [tr, tg, tb] = hexChannels(to);
  const channel = (start: number, end: number) =>
    Math.round(start + (end - start) * ratio)
      .toString(16)
      .padStart(2, "0");
  return `#${channel(fr, tr)}${channel(fg, tg)}${channel(fb, tb)}`;
}

/**
 * Paint the top rail, with a muted-to-tone gradient on a truecolor terminal.
 *
 * The gradient runs from the muted tone at the left edge to the state tone at
 * the right, so an unfocused rail reads as quiet, a focused one picks up the
 * accent, an approval warms to warning and a failed run ends in error. It is
 * quantised to a few stops so a wide rail costs a handful of SGR sequences
 * rather than one per cell, and it paints foreground only: the terminal
 * canvas is never filled.
 *
 * A 256 colour, 16 colour or monochrome terminal gets one flat tone instead,
 * and with colour off the rail is the plain string the caller built.
 */
export function paintComposerRail(
  text: string,
  tone: ComposerRailTone,
  palette: ColorPalette,
  capabilities: TerminalCapabilities,
): string {
  if (!capabilities.ansi || capabilities.colorDepth === 0) return text;
  const from = palette.muted;
  const to = palette[tone];
  if (capabilities.colorDepth !== 24 || from === to)
    return paintWithPalette(text, tone, palette, capabilities);
  const cells = [...text];
  if (cells.length === 0) return text;
  const stops = Math.max(1, Math.min(COMPOSER_GRADIENT_STOPS, cells.length));
  const stopAt = (index: number) =>
    Math.min(stops - 1, Math.floor((index * stops) / cells.length));
  let painted = "";
  let index = 0;
  while (index < cells.length) {
    const stop = stopAt(index);
    let end = index;
    while (end < cells.length && stopAt(end) === stop) end += 1;
    const ratio = stops === 1 ? 0 : stop / (stops - 1);
    painted += `\u001b[${trueColor(mixHex(from, to, ratio))}m${cells.slice(index, end).join("")}`;
    index = end;
  }
  return `${painted}\u001b[0m`;
}

/** The widest a model name may be before the chip truncates it. */
const COMPOSER_MODEL_CHIP_MAX = 24;
/** The cells in the context meter. */
const COMPOSER_CONTEXT_CELLS = 5;
/** The widest an attachment chip may be before it truncates. */
const COMPOSER_ATTACHMENT_CHIP_MAX = 32;
/** The widest the dock caption may be before the rail drops or fits it. */
const COMPOSER_PET_DOCK_MAX = 24;
/** Below this height the composer and the review keys own every row. */
const COMPOSER_PET_BUBBLE_MIN_HEIGHT = 16;

/**
 * The model chip: `◐ model`, or empty when no model is selected.
 *
 * It names the model the next turn will use, so an unset model prints nothing
 * rather than a placeholder that could read as a real choice.
 */
export function composerModelChip(
  model: string | undefined,
  icon: string,
): string {
  const name = sanitizeText(model ?? "")
    .replace(/\s+/g, " ")
    .trim();
  if (name === "") return "";
  return `${icon} ${fit(name, COMPOSER_MODEL_CHIP_MAX)}`;
}

/**
 * The context meter: `ctx ▰▰▰▱▱ 62%`, or empty when the share is unknown.
 *
 * The percentage is the caller's reported prompt tokens against the real
 * context window. Without both there is no share, so the chip is omitted
 * rather than drawn at zero. The ASCII preset keeps `#` and `-` so the
 * compact identity stays ASCII.
 */
export function composerContextChip(
  percent: number | undefined,
  preset: SymbolPreset = "unicode",
): string {
  if (percent === undefined || !Number.isFinite(percent)) return "";
  const value = Math.max(0, Math.min(100, Math.round(percent)));
  const filled = Math.max(
    0,
    Math.min(
      COMPOSER_CONTEXT_CELLS,
      Math.round(value / (100 / COMPOSER_CONTEXT_CELLS)),
    ),
  );
  const empty = COMPOSER_CONTEXT_CELLS - filled;
  const bar =
    preset === "ascii"
      ? `${"#".repeat(filled)}${"-".repeat(empty)}`
      : `${"▰".repeat(filled)}${"▱".repeat(empty)}`;
  return `ctx ${bar} ${value}%`;
}

/**
 * The attachment chip: `@path` for each path the draft mentions.
 *
 * Only a path that exists in the conversation's managed documents counts, so
 * the chip never claims an attachment the send path would reject as unknown.
 */
export function composerAttachmentChip(
  draft: string,
  paths: readonly string[],
): string {
  if (!draft.includes("@") || paths.length === 0) return "";
  const referenced: string[] = [];
  for (const found of draft.matchAll(/@([^\s@][^\s]*)/g)) {
    const path = found[1]!;
    if (paths.includes(path) && !referenced.includes(path))
      referenced.push(path);
  }
  if (referenced.length === 0) return "";
  return fit(
    referenced.map((path) => `@${path}`).join(" "),
    COMPOSER_ATTACHMENT_CHIP_MAX,
  );
}

/**
 * The dock caption: the pet's real reaction, or its state word when idle.
 *
 * The reaction is derived from the drawn state and, where the caller has
 * them, the real tool and provider names, so the dock cannot claim activity
 * the run did not report. It is capped so a long provider name cannot crowd
 * the hint or the status chips beside it.
 */
export function composerPetDockCaption(
  state: PetState,
  context: PetContext = {},
  width = COMPOSER_PET_DOCK_MAX,
): string {
  const prefix = `${PET_DOCK_MARK} `;
  const reaction = petReaction(state, context).replace(/^NIB:\s*/, "");
  const room = Math.max(1, Math.floor(width) - visibleLength(prefix));
  return `${prefix}${fit(reaction, room)}`;
}

export type ComposerPetBubbleInput = {
  readonly state: PetState;
  readonly context?: PetContext;
  readonly width: number;
  readonly height: number;
  /** False when the pet is off; the bubble then never draws. */
  readonly enabled: boolean;
  /** True while a hold is waiting on this session. */
  readonly approval: boolean;
  /** True while a review owns the keyboard. */
  readonly confirmation: boolean;
};

/**
 * The NIB bubble above the composer, or no rows at all.
 *
 * It is drawn only where the frame can afford the two rows and nothing is
 * waiting on a human: an approval banner and its decision keys keep their
 * rows, and below sixteen rows the composer, the transcript and the review
 * keys come first. An idle pet draws none, so the bubble is never a permanent
 * row of furniture.
 */
export function composerPetBubble(input: ComposerPetBubbleInput): string[] {
  if (!input.enabled) return [];
  if (input.approval || input.confirmation) return [];
  if (Math.floor(input.width) < PET_BUBBLE_MIN_WIDTH) return [];
  if (Math.floor(input.height) < COMPOSER_PET_BUBBLE_MIN_HEIGHT) return [];
  if (input.state === "idle") return [];
  return renderPetBubble(input.state, input.context ?? {}, input.width) ?? [];
}

/**
 * The failed run's error event, when the newest visible event is a run error.
 *
 * A run still in flight has no failure to report, and a status event is not an
 * error: only an event the transcript itself shows can raise the rail, so the
 * rail and the transcript always name the same failure.
 */
export function runErrorEvent(
  events: readonly SessionEvent[],
  status?: string,
): SessionEvent | undefined {
  if (status === "running") return undefined;
  const last = chatEventSummary(events).lastVisible;
  return last?.type === "run.error" ? last : undefined;
}

export type ComposerBottomRailInput = {
  readonly width: number;
  readonly bl: string;
  readonly br: string;
  readonly h: string;
  /** True while a run is producing output and is not waiting on a human. */
  readonly streaming: boolean;
  /** The frame counter the cell position is derived from. */
  readonly frame: number;
  /** True when motion is off or reduced; the cell then holds its first cell. */
  readonly reduced: boolean;
};

/**
 * The bottom rail, with one slow travelling lit cell while a run streams.
 *
 * The cell never touches the draft: the draft rows are rendered from the
 * cursor arithmetic alone, so a travelling cell can never change wrapping or
 * move the caret. Reduced motion holds the cell at its first position rather
 * than hiding it, so the rail still says the run is live.
 */
export function composerBottomRail(input: ComposerBottomRailInput): string {
  const width = Math.max(1, Math.floor(input.width));
  const span = Math.max(1, width - 2);
  const lit = input.h === "-" ? "=" : "━";
  const cells = Array.from({ length: span }, () => input.h);
  if (input.streaming) {
    const step = input.reduced
      ? 0
      : Math.max(0, Math.floor(input.frame / COMPOSER_STREAM_FRAMES));
    cells[step % span] = lit;
  }
  return `${input.bl}${cells.join("")}${input.br}`;
}

/**
 * The startup splash frame: the three-row NIB card, centred on the terminal.
 *
 * Returns null below the width the card needs, and the caller then draws the
 * normal frame rather than a clipped card. The frame is blank outside the
 * card: a splash that painted the workspace behind itself would have to be
 * redrawn row by row, and the point of this one is that it costs nothing.
 */
export function renderPetSplashFrame(
  columns: number,
  rows: number,
): string | null {
  const width = Math.max(1, Math.floor(columns));
  const height = Math.max(1, Math.floor(rows));
  const card = renderPetSplash(width);
  if (card === null) return null;
  const top = Math.max(0, Math.floor((height - card.length) / 2));
  return Array.from({ length: height }, (_, row) => {
    const line = card[row - top];
    if (line === undefined) return " ".repeat(width);
    const lead = Math.max(0, Math.floor((width - visibleLength(line)) / 2));
    return pad(`${" ".repeat(lead)}${line}`, width);
  }).join("\n");
}

/** @path completion reads managed document paths of live sessions. */
export function mentionCandidates(
  prefix: string,
  paths: readonly string[],
): string[] {
  const needle = prefix.toLocaleLowerCase();
  return paths
    .filter((item) => item.toLocaleLowerCase().startsWith(needle))
    .slice(0, 8);
}
/** The @ token right before the cursor, if the operator typed one. */
export function mentionToken(
  value: string,
  cursor: number,
): string | undefined {
  const before = [...value].slice(0, cursor).join("");
  const found = /@([^\s@]*)$/.exec(before);
  return found ? (found[1] ?? "") : undefined;
}

/** External harness CLIs detected on PATH, never executed by this check. */
export async function detectHarnesses(
  env: Readonly<NodeJS.ProcessEnv>,
): Promise<{ id: string; path: string | null }[]> {
  const found: { id: string; path: string | null }[] = [];
  const pathEnv = env.PATH ?? "";
  for (const id of ["prime-agent", "opencode"]) {
    let path: string | null = null;
    for (const dir of pathEnv.split(":")) {
      if (!dir) continue;
      const candidate = join(dir, id);
      try {
        await access(candidate);
        path = candidate;
        break;
      } catch {
        continue;
      }
    }
    found.push({ id, path });
  }
  return found;
}

/** Gated shell escape refuses anything that can carry key material. */
const SHELL_REFUSALS = [
  /\$[A-Za-z_]*(KEY|TOKEN|SECRET|PASSWORD)/,
  /api[_-]?key/i,
  /tokenharbor|tokenrouter/i,
  /secret|password|passwd|authorization|bearer/i,
  /private[_-]?key|id_rsa|\.pem\b/i,
  /\.env\b|\.nomo|keychain/i,
];
const runShellFile = promisify(execFile);

const STARTER_DOC = `# Plan

## Goal

Describe what this workspace should achieve.

## Steps

- [ ] First concrete step
- [ ] Second concrete step

## Notes

Decisions and open questions live here.
`;

const COMMAND_PALETTE_NOTICE =
  "Palette: type to filter, Up/Down select, Enter run, Esc close.";

function documentPreviewLayout(columns: number, viewportHeight: number) {
  const width = Math.max(1, Math.floor(columns));
  const height = Math.max(1, viewportHeight);
  const sideBySide = width >= 72 && height >= 6;
  return {
    width,
    height,
    sideBySide,
    treeWidth: sideBySide
      ? Math.max(28, Math.floor((width - 2) * 0.45))
      : width,
  };
}

/**
 * Terminal width at which the sessions browser keeps its inspector beside the
 * list instead of replacing it.
 *
 * Below it the inspector would leave the list too narrow to read a title in,
 * so Enter swaps the list for the inspector and Esc swaps back. The threshold
 * is in terminal columns, which is what an operator sees; the frame reserves
 * four of them as side padding, so the caller adds them back before asking.
 */
export const SESSION_INSPECTOR_MIN_COLUMNS = 120;

/**
 * Columns the frame spends before the sessions body sees its width.
 *
 * A panel is drawn two columns narrower than the terminal and `lines()` is
 * handed four fewer than that, so a body width plus six is the terminal width
 * the threshold is written in.
 */
export const SESSION_FRAME_COLUMNS = 6;

export function sessionInspectorLayout(
  columns: number,
  viewportHeight: number,
) {
  const width = Math.max(1, Math.floor(columns));
  const height = Math.max(1, Math.floor(viewportHeight));
  const sideBySide = width >= SESSION_INSPECTOR_MIN_COLUMNS;
  const inspectorWidth = sideBySide
    ? Math.min(40, Math.max(28, Math.floor(width * 0.3)))
    : width;
  return {
    width,
    height,
    sideBySide,
    inspectorWidth,
    listWidth: sideBySide
      ? Math.max(20, width - inspectorWidth - 3)
      : width,
  };
}

function findTreeAncestors(
  nodes: readonly TreeNode[],
  targetId: string,
  ancestors: readonly string[] = [],
): readonly string[] | undefined {
  for (const node of nodes) {
    if (node.id === targetId) return ancestors;
    if (node.children?.length) {
      const found = findTreeAncestors(node.children, targetId, [
        ...ancestors,
        node.id,
      ]);
      if (found) return found;
    }
  }
  return undefined;
}

function refreshedTreeState(
  previous:
    | { readonly nodes: readonly TreeNode[]; readonly state: TreeState }
    | undefined,
  nodes: readonly TreeNode[],
): TreeState {
  const initial = initialTreeState(nodes);
  if (!previous || nodes.length === 0) return initial;

  // Session status, recency and message-count changes rebuild the rows while
  // a conversation is running. Keep the operator's expansion and cursor
  // anchored to the same stable node id across that refresh.
  const previousNode = flattenTree(previous.nodes, previous.state)[
    previous.state.cursor
  ];
  const expandable = new Set<string>();
  const collectExpandable = (entries: readonly TreeNode[]) => {
    for (const node of entries) {
      if (node.hasChildren || (node.children?.length ?? 0) > 0)
        expandable.add(node.id);
      if (node.children?.length) collectExpandable(node.children);
    }
  };
  collectExpandable(nodes);
  const expanded = new Set(
    [...previous.state.expanded].filter((id) => expandable.has(id)),
  );
  if (previousNode) {
    for (const ancestor of findTreeAncestors(nodes, previousNode.id) ?? [])
      expanded.add(ancestor);
  }
  const visible = flattenTree(nodes, { expanded, cursor: 0 });
  const selected = previousNode
    ? visible.findIndex((node) => node.id === previousNode.id)
    : -1;
  return {
    expanded,
    cursor:
      selected >= 0
        ? selected
        : Math.max(0, Math.min(previous.state.cursor, visible.length - 1)),
  };
}

/**
 * What a clickable composer chip or session row icon does.
 *
 * Every action has a keyboard equivalent the frame already documents: the
 * model chip is `/model`, the context chip is `/usage`, the attachment chip is
 * `/documents`, the NIB dock is Alt+Shift+N, and the session row icons open
 * the same panels their rows describe. The pointer is an alternative path,
 * never the only one.
 */
export type ChipAction =
  | "model"
  | "usage"
  | "documents"
  | "pet"
  | "models-panel";

/** Same persistent workbench as the web. Rendering never grants tool authority. */
export class WorkspaceTui {
  readonly workbench: Workbench;
  readonly proxy: ProxyWorkspace;
  readonly env: Readonly<NodeJS.ProcessEnv>;
  tab: WorkspaceTab = "chat";
  tabHitTargets: Array<{
    tab: WorkspaceTab;
    row: number;
    start: number;
    end: number;
  }> = [];
  rowHitTargets: Array<
    | { row: number; start: number; end: number; kind: "item"; index: number }
    | { row: number; start: number; end: number; kind: "tree"; index: number }
    | {
        row: number;
        start: number;
        end: number;
        kind: "provider";
        index: number;
      }
    | { row: number; start: number; end: number; kind: "model"; index: number }
    | {
        row: number;
        start: number;
        end: number;
        kind: "setting";
        index: number;
      }
    | {
        row: number;
        start: number;
        end: number;
        kind: "chip";
        index: number;
        action: ChipAction;
      }
    | { row: number; start: number; end: number; kind: "toast"; index: number }
  > = [];
  hoveredRow?: {
    readonly kind: "item" | "tree" | "provider" | "model" | "setting";
    readonly index: number;
  };
  selected = 0;
  scroll = 0;
  viewport: {
    offset: number;
    height: number;
    total: number;
    width?: number;
    /**
     * Visible transcript cells per row. The chat rail is painted right of
     * them, so this is what a mouse selection may cover.
     */
    textWidth?: number;
    /** One-based column of the first rail cell, when a rail is painted. */
    railStart?: number;
    /** One-based first row of the rail band. */
    railTop?: number;
    /** Rows the rail band paints below `railTop`. */
    railRows?: number;
    /**
     * Rows of the body budget the sticky transcript line took, 0 when it is
     * not drawn. Paging counts them as window, so a page down still lands on
     * live follow instead of stopping one row short.
     */
    stickyRows?: number;
  } = {
    offset: 0,
    height: 1,
    total: 0,
    width: 76,
  };
  /** Current content width for list details built before the next draw. */
  layoutColumns = 76;
  /** Viewport offsets of user prompt rows, for { and } jumps. */
  promptRows: number[] = [];
  sessionId?: string;
  documentPath?: string;
  projectId?: string;
  agentId?: string;
  lastRecoveryJob?: { sessionId: string; jobId: string };
  model = "";
  activeShellCommands = 0;
  filter = "";
  /**
   * The filter typed into the /keybindings table. Separate from filter above
   * because that one narrows the item list, and sharing one field would let a
   * keystroke meant for a table row silently hide list items instead.
   */
  keybindingQuery = "";
  /** True while the visible detail is the keybinding table. */
  keybindingDetail = false;
  /**
   * The cheat sheet, summoned from anywhere.
   *
   * Separate from keybindingDetail on purpose. The keybinding table is a page
   * an operator visits to read every binding, and it renders into the detail
   * pane. The cheat sheet answers "that key did not do what I expected",
   * which is a question about right now, and it opens over whatever was on
   * screen. It still renders into detail because that pane is the only thing
   * in the frame that does not disturb the body behind it, and re-laying the
   * body would drop the scroll position the operator was reading at.
   */
  cheatSheet = false;
  /**
   * The filter typed into the cheat sheet. Its own field, not keybindingQuery,
   * for the reason the keybinding query has its own field: two overlays sharing
   * one filter would let a keystroke meant for one narrow the other.
   */
  cheatQuery = "";
  /** Terminal width the cheat sheet was last laid out for. */
  cheatWidth = 0;
  /**
   * Grouping for the documents and sessions tabs. Present only while one of
   * those is open, which is what makes its presence the signal that the tree
   * keys are live rather than another meaning for left and right.
   */
  groupTree?: { nodes: TreeNode[]; state: TreeState };
  private groupTreeKey?: string;
  /**
   * The sessions browser model that goes with `groupTree`.
   *
   * The tree still owns navigation, because the arrow and Enter keys already
   * speak it; this map is what turns a session node into the facts its row
   * prints. It is absent on Documents, which has no rows to describe.
   */
  sessionBrowser?: SessionBrowserModel;
  /**
   * True while the narrow-layout session inspector owns the detail pane.
   *
   * Below SESSION_INSPECTOR_MIN_COLUMNS the inspector replaces the list, so
   * the pane has to know that Enter inside it opens the conversation and that
   * Esc (which clears every detail) returns to the list.
   */
  sessionInspectorDetail = false;
  /**
   * Screen lines the sessions body published for the renderer: which content
   * row carries the cursor, which are section headings, and which carry a
   * selectable row. The renderer cannot re-derive these from the text, because
   * a heading and a row both start with the same two-cell gutter.
   */
  sessionBrowserLines?: {
    readonly selected: number;
    readonly headers: readonly number[];
    readonly rows: readonly { readonly line: number; readonly index: number }[];
  };
  /** Terminal width the keybinding table was last laid out for. */
  keybindingWidth = 0;
  /**
   * Animation frame counter, published by the renderer before it asks for
   * lines. The list rows are built by the model, which has no access to the
   * frame otherwise, and the viewport and prompt rows are already published
   * the same way for the same reason.
   */
  frame = 0;
  /**
   * Whether the composer is taking typing, published by the renderer.
   *
   * The runner owns that state as input.editing and the model has no other way
   * to see it. Published the same way as frame, for the same reason: the
   * cheat sheet asks which keys apply now, and "now" includes whether the
   * keyboard belongs to the prompt.
   */
  editingInput = false;
  toolActivityMode: ToolActivityMode = "details";
  hideToolActivity = false;
  mode: TuiMode = "normal";
  private modeBeforePlan?: TuiMode;
  /** Runtime theme overrides. Undefined keeps the NOMO_TUI_* environment. */
  colorOverride?: boolean;
  motionOverride?: boolean;
  /**
   * Whether NIB the pet is drawn. NOMO_TUI_PET turns it on or off at startup
   * and wins over the saved choice; Alt+N or /pet toggles it, and the choice
   * is remembered for this workspace. It is display only, so the toggle never
   * sends a prompt or writes to the draft.
   */
  petEnabled = true;
  /**
   * Where the pet was asked to live. See PetPlacement. Saved beside the other
   * TUI state by savePetPreference.
   */
  petPlacement: PetPlacement = "auto";
  /**
   * True while the NIB signal card is open over the Chat body. It is an
   * overlay, not a panel: the composer, the transcript and the dock keep their
   * rows, so closing the card never re-lays the frame.
   */
  petCard = false;
  /**
   * Epoch milliseconds until which the startup splash owns the frame. Zero
   * means no splash. The runner sets it once per process at the first
   * interactive frame; any key clears it.
   */
  petSplashUntil = 0;
  /**
   * The frame the composer gained focus on, or -1 when it is unfocused or the
   * sweep has settled. The six-frame focus sweep is derived from this and the
   * current frame, so it is reproducible from the frame counter alone.
   */
  composerFocusFrame = -1;
  /**
   * The failed run the operator dismissed from the composer rail.
   *
   * A dismissal is per conversation and per event, so a new failure raises the
   * rail again while the transcript keeps the error it always had. It is a
   * display state: dismissing never edits the draft or resends the prompt.
   */
  dismissedRunError?: { readonly sessionId: string; readonly seq: number };
  /**
   * True when the pet was drawn in an animating state on the last frame. The
   * runner reads it to decide whether an idle redraw has anything new to show;
   * a settled or hidden pet never costs a repaint.
   */
  petAnimating = false;
  themeConfig: ThemeConfig;
  chatPanelVisuals: ChatPanelVisuals;
  keybindingsOverride?: string;
  readonly localTabIcons: LocalTabIcons | undefined;
  queuedPrompt: string | null = null;
  queuedPromptPaused = false;
  /** Live command palette. Present means the overlay owns the keyboard. */
  palette?: PaletteState;
  /** Frecency state persists across palette opens. */
  paletteState?: { recent: Map<string, { count: number; lastUsed: number }> };
  /**
   * Transient events that must be seen but not re-read. The sticky approval
   * banner stays authoritative, so nothing safety related is raised here.
   */
  toasts: ToastHost = { toasts: [], active: undefined };
  /** Which outstanding operation the /diff panel is showing. */
  diffIndex = 0;
  /**
   * Review state for the visible diff panel: cursor, staged hunks and side.
   * Present only while /diff is on screen, so its presence is the signal that
   * the review keys are live rather than another meaning for the same letters.
   */
  diffView?: DiffViewState;
  notice = "Ready";
  detail?: string[];
  settingsOpen = false;
  settingsSelected = 0;
  settingsQuery = "";
  settingsQueryCursor = 0;
  settingsRowLines: number[] = [];
  settingsEdit?: { key: string; draft: string; cursor: number };
  confirmation?: Confirmation;
  private branchIntent?: {
    sessionId: string;
    seq: number;
    command: "branch" | "retry";
    key: string;
  };
  provider?: Awaited<ReturnType<Workbench["providerState"]>>;
  /**
   * Local credential sources, the only IDs /connect imports.
   *
   * Discovery is asynchronous while command completion runs inside the
   * synchronous render and key loops, so the last result is cached here and in
   * the module level cache commandSuggestions reads. Empty means discovery has
   * not run or failed, not that no source exists.
   */
  connectSources: readonly ConnectSource[] = [];
  /**
   * The host subscription selected by /connect.
   *
   * A host subscription has no token NOMO can store, so /connect registers the
   * installed host as a Workbench host runner and this selection only names
   * it. Its presence means prompts run through that host; the run itself is a
   * real Workbench session with a transcript and a signed ledger record.
   */
  hostSubscription?: {
    readonly sourceId: string;
    readonly host: HostCliId;
    readonly providerId: string;
    readonly displayName: string;
  };
  modelProjection: ReturnType<Workbench["providerModelsProjection"]> = {
    activeProviderId: null,
    providers: [],
  };
  modelPicker?: ModelPickerState;
  private readonly pendingModelCatalogs = new Set<string>();
  private modelPickerGeneration = 0;
  private modelCatalogKey(providerId: string): string {
    return `${this.modelPickerGeneration}:${providerId}`;
  }
  /**
   * Provider catalog metadata can arrive through an on-demand model lookup,
   * while the Workbench's passive state snapshot still carries an older
   * catalog. Retain only verified context capacities so a refresh cannot
   * erase a known value from the chat rail.
   */
  private readonly modelContextWindows = new Map<
    string,
    ReadonlyMap<string, number>
  >();
  private rememberModelContextWindows(
    providerIds: readonly (string | null | undefined)[],
    models: readonly { readonly id: string; readonly contextWindow?: number }[],
    replace = false,
  ) {
    const contexts = new Map<string, number>();
    for (const model of models) {
      if (
        typeof model.contextWindow === "number" &&
        Number.isSafeInteger(model.contextWindow) &&
        model.contextWindow > 0
      )
        contexts.set(model.id, model.contextWindow);
    }
    for (const providerId of new Set(
      providerIds.filter((id): id is string => Boolean(id)),
    )) {
      const previous = this.modelContextWindows.get(providerId);
      if (!replace && previous) {
        const merged = new Map(previous);
        for (const [modelId, contextWindow] of contexts)
          merged.set(modelId, contextWindow);
        this.modelContextWindows.delete(providerId);
        this.modelContextWindows.set(providerId, merged);
      } else if (contexts.size) {
        this.modelContextWindows.delete(providerId);
        this.modelContextWindows.set(providerId, contexts);
      } else if (replace) {
        this.modelContextWindows.delete(providerId);
      }
    }
    while (this.modelContextWindows.size > 32)
      this.modelContextWindows.delete(
        this.modelContextWindows.keys().next().value!,
      );
  }
  modelContextWindow(
    providerId: string | undefined,
    modelIds: ReadonlySet<string>,
  ): number | undefined {
    if (!providerId) return undefined;
    const contexts = this.modelContextWindows.get(providerId);
    if (!contexts) return undefined;
    for (const modelId of modelIds) {
      const contextWindow = contexts.get(modelId);
      if (contextWindow !== undefined) return contextWindow;
    }
    return undefined;
  }
  /** True only for the passive document preview shown while browsing its tree. */
  documentPreview = false;
  modelCatalogStatus: "idle" | "ready" | "unavailable" = "idle";
  proofs = new Map<string, JsonlEntry[]>();
  proofErrors = new Map<string, string>();
  /**
   * The key the workbench verified the managed ledger with, and the claim it
   * supports. The managed proofs are read through `Workbench.ledger`, which
   * resolves its own key, so the TUI has to carry that resolution out to the
   * record view rather than assert "verified" with nothing behind it.
   */
  managedVerificationStatus: string | undefined;
  managedVerificationNote: string | undefined;
  private proofStamp = "";
  private verifiedLedgerRevision = -1;
  private readonly proofEventSequences = new Map<
    string,
    { lastSeq: number; stableSeq: number }
  >();
  private renderedChatRows?: {
    sessionId: string;
    events: readonly SessionEvent[];
    width: number;
    terminalHeight: number;
    activityMode: ToolActivityMode;
    hideToolActivity: boolean;
    density: ChatDensity;
    timestamps: boolean;
    symbolPreset: SymbolPreset;
    stableCount: number;
    stableRows: ChatRow[];
    partialText: string;
    rows: ChatRow[];
  };
  constructor(
    workbench: Workbench,
    env: Readonly<NodeJS.ProcessEnv> = process.env,
  ) {
    this.workbench = workbench;
    this.env = env;
    this.proxy = new ProxyWorkspace(env);
    this.themeConfig = getThemeConfig(env);
    this.chatPanelVisuals = chatPanelVisualsFrom(env);
    this.keybindingsOverride = env.NOMO_TUI_KEYBINDINGS;
    // The operator's startup override wins over the saved choice, and a
    // missing or corrupt file reads as the documented default: on, automatic.
    // Reading is the only thing that happens here, so a session that never
    // touches the pet never writes this file.
    const preference = readPetPreference(env);
    this.petEnabled =
      env.NOMO_TUI_PET === undefined
        ? preference.enabled
        : env.NOMO_TUI_PET !== "0";
    this.petPlacement = this.petEnabled ? preference.placement : "off";
    // The icon pack and the optional NIB image travel on the same Kitty
    // transfer, so both follow the same terminal verdict: Ghostty, native
    // Kitty, or an explicitly declared multiplexer passthrough. Every other
    // terminal keeps its text glyphs and never receives an escape.
    this.localTabIcons =
      detectCapabilities(env).ansi && detectPetTerminal(env).graphics
        ? loadLocalTabIcons(env)
        : undefined;
  }
  private providerGlyph(id: string, name = ""): string {
    const isLocal =
      /\b(?:local|ollama|lm[ -]?studio)\b|localhost|127\.0\.0\.1|::1/i.test(
        `${id} ${name}`,
      );
    return this.localTabIcons
      ? (isLocal
          ? kittyTabIconLabel(
              "models",
              this.localTabIcons,
              this.themeConfig.colorTheme,
            )
          : kittyProviderIconLabel(
              this.localTabIcons,
              this.themeConfig.colorTheme,
            )) || modelProviderIcon(id, name)
      : modelProviderIcon(id, name);
  }
  private modelGlyph(): string {
    return this.localTabIcons
      ? kittyTabIconLabel(
          "models",
          this.localTabIcons,
          this.themeConfig.colorTheme,
        ) || ROW_ICONS.model
      : ROW_ICONS.model;
  }
  private rememberConnectSources(sources: readonly ConnectSource[]) {
    this.connectSources = sources;
    // The render and key loops hold no workspace reference, so the list they
    // complete from is published here rather than passed through the runner.
    discoveredConnectSources = sources;
  }
  /**
   * Refresh the local credential sources /connect accepts.
   *
   * desktopSetup reports one entry per discovered source, with a reason when it
   * is unavailable, and never throws. A failure here therefore keeps the last
   * known list instead of turning valid IDs into refusals.
   */
  private async refreshConnectSources(): Promise<readonly ConnectSource[]> {
    try {
      this.rememberConnectSources((await desktopSetup(this.env)).sources);
    } catch {
      // Keep the previous list. Refusing an ID because one scan failed would
      // be a regression in a path that only ever reads local files.
    }
    return this.connectSources;
  }
  /**
   * Select an installed host as the runner for a subscription.
   *
   * The runner is registered with Workbench here, so a host run is a real
   * session with a transcript and a ledger record instead of a private stream
   * this screen owns. No token is read or stored: the host owns its login.
   */
  selectHostSubscription(provider: HostCliProvider): void {
    this.workbench.registerHostRunner(
      new HostCliRunner({
        host: provider.host,
        providerId: provider.providerId,
        cwd: process.cwd(),
        env: this.env,
      }),
    );
    this.hostSubscription = {
      sourceId: provider.sourceId,
      host: provider.host,
      providerId: provider.providerId,
      displayName: provider.displayName,
    };
    this.notice = `Connected to ${provider.sourceId} through ${provider.host}. The credential stays in the host; NOMO never reads it.`;
  }
  clearHostSubscription(): void {
    this.hostSubscription = undefined;
  }
  /** True while a host run owns the prompt slot, so the runner can queue. */
  hostRunBusy(): boolean {
    return this.workbench.running();
  }
  /**
   * Run one prompt through the selected host.
   *
   * The run is prepared and started by Workbench, which creates the session,
   * the transcript and the signed ledger entries, then this screen waits for
   * that session to settle and shows its recorded state. Nothing here spawns
   * the host or writes a transcript of its own.
   */
  async runHostPrompt(prompt: string): Promise<void> {
    const selection = this.hostSubscription;
    if (!selection)
      throw Error(
        "No host subscription is selected. /connect prime:openai-codex or /connect claude:claude-code.",
      );
    const preview = await this.workbench.prepareHostRun({
      sourceId: selection.sourceId,
      host: selection.host,
      task: prompt,
      cwdDigest: `sha256:${createHash("sha256").update(process.cwd()).digest("hex")}`,
    });
    const started = await this.workbench.startHostRun({
      consentId: preview.id,
      consentDigest: preview.consentDigest,
    });
    this.useSession(started.id);
    this.choose("chat");
    this.notice = `Running through ${selection.host}. Tools and credential stay in the host.`;
    const settled = await this.workbench.waitForRun(started.id);
    this.notice =
      settled.status === "idle"
        ? `Host run completed through ${selection.host}.`
        : `Host run ${settled.status}. /runs and the ledger hold the recorded state.`;
  }
  async initialize() {
    try {
      this.provider = await this.workbench.providerState();
      this.modelProjection = this.workbench.providerModelsProjection();
      this.rememberModelContextWindows(
        [this.provider.baseUrl, this.modelProjection.activeProviderId],
        this.provider.models,
      );
      this.model = this.provider.defaultModel ?? "";
      this.modelCatalogStatus =
        this.provider.connected && this.provider.models.length > 0
          ? "ready"
          : "unavailable";
    } catch (error) {
      this.modelCatalogStatus = "unavailable";
      this.notice = message(error);
    }
    // Completion is synchronous, so the source list is discovered once at
    // startup rather than on the keystroke that needs it.
    await this.refreshConnectSources();
    await this.refresh(true);
  }
  async refresh(force = false) {
    await this.proxy.refresh(force);
    const stamp = this.workbench
      .allViews()
      .map((session) => {
        // Deltas do not change signed evidence. Remember the latest stable
        // sequence and inspect only newly appended events during a stream;
        // rescanning a long delta tail every refresh made long runs quadratic.
        const lastSeq = session.events.at(-1)?.seq ?? 0;
        const prior = this.proofEventSequences.get(session.id);
        let stableSeq = prior?.stableSeq ?? 0;
        if (!prior || lastSeq < prior.lastSeq) {
          stableSeq = 0;
          for (let index = session.events.length - 1; index >= 0; index--) {
            const event = session.events[index]!;
            if (event.type !== "message.delta") {
              stableSeq = event.seq;
              break;
            }
          }
        } else if (lastSeq > prior.lastSeq) {
          for (let index = session.events.length - 1; index >= 0; index--) {
            const event = session.events[index]!;
            if (event.seq <= prior.lastSeq) break;
            if (event.type !== "message.delta") {
              stableSeq = event.seq;
              break;
            }
          }
        }
        this.proofEventSequences.set(session.id, { lastSeq, stableSeq });
        return `${session.id}:${stableSeq}:${session.status}`;
      })
      .join("|");
    const ledgerRevision = this.workbench.ledgerRevision();
    if (
      !force &&
      stamp === this.proofStamp &&
      ledgerRevision === this.verifiedLedgerRevision
    )
      return;
    this.proofStamp = stamp;
    this.provider = await this.workbench.providerState();
    this.modelProjection = this.workbench.providerModelsProjection();
    this.rememberModelContextWindows(
      [this.provider.baseUrl, this.modelProjection.activeProviderId],
      this.provider.models,
    );
    this.modelCatalogStatus =
      this.provider.connected && this.provider.models.length > 0
        ? "ready"
        : "unavailable";
    if (force || ledgerRevision !== this.verifiedLedgerRevision) {
      this.proofs.clear();
      this.proofErrors.clear();
      // Every managed workspace verifies with the same resolved key, so the
      // last one read is the one that verified them all. Recording it is what
      // lets the record view name the key instead of only asserting a result.
      this.managedVerificationStatus = undefined;
      this.managedVerificationNote = undefined;
      for (const session of this.workbench.list()) {
        try {
          const proof = await this.workbench.ledger(session.workspace);
          if (proof) {
            this.proofs.set(session.id, [...proof.entries]);
            this.managedVerificationStatus = verificationStatus(
              proof.verification,
            );
            this.managedVerificationNote = verificationKeyNote(
              proof.verification,
            );
          }
        } catch {
          this.proofErrors.set(
            session.id,
            "Signature / integrity ERROR. Recovery and export cannot be considered verified.",
          );
        }
      }
      this.verifiedLedgerRevision = ledgerRevision;
    }
    this.selected = Math.min(
      this.selected,
      Math.max(0, this.items().length - 1),
    );
  }
  applySavedSettings(value: unknown) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return;
    const saved = value as Partial<TuiLocalSettings>;
    if (
      this.env.NOMO_TUI_THEME === undefined &&
      typeof saved.colorTheme === "string" &&
      Object.hasOwn(COLOR_THEMES, saved.colorTheme)
    )
      this.themeConfig = {
        ...this.themeConfig,
        colorTheme: saved.colorTheme,
      };
    if (
      this.env.NOMO_TUI_SYMBOLS === undefined &&
      typeof saved.symbolPreset === "string" &&
      Object.hasOwn(SYMBOL_SETS, saved.symbolPreset)
    )
      this.themeConfig = {
        ...this.themeConfig,
        symbolPreset: saved.symbolPreset,
      };
    if (
      this.env.NOMO_TUI_CHAT_FRAME === undefined &&
      ["filled", "rounded", "square", "double"].includes(saved.chatFrame ?? "")
    )
      this.chatPanelVisuals = {
        ...this.chatPanelVisuals,
        // Older local state persisted the former default. Adopt the current
        // Prime/OMP hybrid default once; the filled style remains selectable.
        frame: saved.chatFrame === "filled" ? "rounded" : saved.chatFrame!,
      };
    if (
      this.env.NOMO_TUI_CHAT_DENSITY === undefined &&
      ["comfortable", "compact"].includes(saved.chatDensity ?? "")
    )
      this.chatPanelVisuals = {
        ...this.chatPanelVisuals,
        density: saved.chatDensity!,
      };
    if (
      this.env.NOMO_TUI_CHAT_TIMESTAMPS === undefined &&
      typeof saved.chatTimestamps === "boolean"
    )
      this.chatPanelVisuals = {
        ...this.chatPanelVisuals,
        timestamps: saved.chatTimestamps,
      };
    if (
      this.env.NOMO_TUI_CHAT_COMPOSER_HEIGHT_PX === undefined &&
      Number.isSafeInteger(saved.chatComposerHeightPx) &&
      saved.chatComposerHeightPx! >= MIN_CHAT_COMPOSER_HEIGHT_PX &&
      saved.chatComposerHeightPx! <= MAX_CHAT_COMPOSER_HEIGHT_PX
    )
      this.chatPanelVisuals = {
        ...this.chatPanelVisuals,
        composerHeightPx: saved.chatComposerHeightPx!,
      };
    if (
      this.env.NOMO_TUI_COLOR === undefined &&
      typeof saved.terminalColor === "boolean"
    )
      this.colorOverride = saved.terminalColor;
    if (
      this.env.NOMO_TUI_MOTION === undefined &&
      typeof saved.motion === "boolean"
    )
      this.motionOverride = saved.motion;
    if (
      this.env.NOMO_TUI_KEYBINDINGS === undefined &&
      typeof saved.keybindings === "string" &&
      !parseWorkspaceKeybindings(saved.keybindings).error
    )
      this.keybindingsOverride = saved.keybindings || undefined;
  }
  localSettings(): TuiLocalSettings {
    return {
      colorTheme: this.themeConfig.colorTheme,
      symbolPreset: this.themeConfig.symbolPreset,
      chatFrame: this.chatPanelVisuals.frame,
      chatDensity: this.chatPanelVisuals.density,
      chatTimestamps: this.chatPanelVisuals.timestamps,
      chatComposerHeightPx: this.chatPanelVisuals.composerHeightPx,
      ...(this.keybindingsOverride === undefined
        ? {}
        : { keybindings: this.keybindingsOverride }),
      ...(this.colorOverride === undefined
        ? {}
        : { terminalColor: this.colorOverride }),
      ...(this.motionOverride === undefined
        ? {}
        : { motion: this.motionOverride }),
    };
  }
  /**
   * Remember the current pet display choice for this workspace.
   *
   * The choice is decoration, so a write that cannot land returns false and
   * leaves the live choice in place rather than failing the session. Nothing
   * but the on/off flag and the placement is stored; the pet never persists
   * run state, a session id or a provider name.
   */
  savePetPreference(): boolean {
    return writePetPreference(this.env, {
      enabled: this.petEnabled,
      placement: this.petPlacement,
    });
  }
  /**
   * Dismiss the startup splash if it still owns the frame.
   *
   * Returns true only when a splash was actually up, so the runner can redraw
   * once for the dismissal without redrawing on every later key. The splash is
   * a display state: dismissing it never sends a prompt or edits the draft.
   */
  dismissPetSplash(now = Date.now()): boolean {
    if (this.petSplashUntil <= now) return false;
    this.petSplashUntil = 0;
    return true;
  }
  /**
   * Dismiss the failed run's composer rail if it is still up.
   *
   * Returns true only when a failure was actually dismissed, so the runner
   * redraws once for the dismissal rather than on every later Escape. The
   * transcript keeps the error event; only the rail's call to action goes.
   */
  dismissRunError(): boolean {
    const session = this.session();
    if (!session) return false;
    const failed = runErrorEvent(session.events, session.status);
    if (!failed) return false;
    if (
      this.dismissedRunError?.sessionId === session.id &&
      this.dismissedRunError.seq === failed.seq
    )
      return false;
    this.dismissedRunError = { sessionId: session.id, seq: failed.seq };
    return true;
  }
  choose(requestedTab: WorkspaceTab | "overview") {
    // Keep old callers source-compatible while routing the retired landing
    // panel to Chat. It is not part of the visible panel registry.
    const tab: WorkspaceTab =
      requestedTab === "overview" ? "chat" : requestedTab;
    this.tab = tab;
    this.settingsOpen = false;
    this.settingsEdit = undefined;
    this.settingsRowLines = [];
    this.modelPickerGeneration += 1;
    this.modelPicker = undefined;
    this.hoveredRow = undefined;
    if (tab === "models")
      this.modelCatalogStatus =
        this.provider?.connected && this.provider.models.length > 0
          ? "ready"
          : "unavailable";
    this.selected = 0;
    this.scroll = tab === "chat" ? -1 : 0;
    this.detail = undefined;
    this.documentPreview = false;
    // Cleared here rather than at each of the other five places that drop the
    // detail view, because a stale flag would make ordinary typing filter a
    // table that is no longer on screen.
    this.keybindingDetail = false;
    // Same reason, same hazard: the sheet is filtered by ordinary typing, so a
    // flag left set after the panel changed would eat every letter typed next.
    this.cheatSheet = false;
    this.cheatQuery = "";
    // The tree belongs to Sessions and Documents. Left on elsewhere it would
    // let the arrow keys fold a tree the operator is not even looking at.
    this.groupTree = undefined;
    this.groupTreeKey = undefined;
    this.sessionBrowser = undefined;
    this.sessionInspectorDetail = false;
    this.sessionBrowserLines = undefined;
    this.filter = "";
  }
  cycle(direction: number) {
    this.choose(
      WORKSPACE_TABS[
        (WORKSPACE_TABS.indexOf(this.tab) + direction + WORKSPACE_TABS.length) %
          WORKSPACE_TABS.length
      ]!,
    );
  }
  private activeModelCatalog() {
    if (this.modelCatalogStatus !== "ready") return [];
    const provider = this.modelProjection.providers.find(
      (candidate) => candidate.id === this.modelProjection.activeProviderId,
    );
    return provider?.catalogStatus === "ready" ? provider.models : [];
  }
  async openModelPicker(selection: "default" | "session" = "default") {
    const generation = ++this.modelPickerGeneration;
    const session = selection === "session" ? this.session() : undefined;
    if (selection === "session" && !session)
      throw new Error(
        "Start or resume a conversation before choosing its model.",
      );
    const sessionCatalog = session
      ? await this.workbench.sessionModelCatalog(session.id)
      : undefined;
    if (
      generation !== this.modelPickerGeneration ||
      (session && this.sessionId !== session.id)
    )
      return;
    if (sessionCatalog)
      this.rememberModelContextWindows(
        [sessionCatalog.providerId, session?.provider],
        sessionCatalog.models,
        true,
      );
    if (
      sessionCatalog &&
      sessionCatalog.providerId ===
        this.workbench.providerModelsProjection().activeProviderId &&
      this.provider
    ) {
      this.provider = { ...this.provider, models: sessionCatalog.models };
    }
    const imports =
      selection === "default" ? await ompProviderSources(this.env) : [];
    if (
      generation !== this.modelPickerGeneration ||
      (session && this.sessionId !== session.id)
    )
      return;
    const providers: ModelPickerProvider[] = sessionCatalog
      ? [
          {
            id: sessionCatalog.providerId,
            name:
              this.modelProjection.providers.find(
                (provider) => provider.id === sessionCatalog.providerId,
              )?.name ??
              session?.provider ??
              sessionCatalog.providerId,
            attached: true,
            catalogStatus: sessionCatalog.models.length
              ? "ready"
              : "unavailable",
            models: sessionCatalog.models,
          },
        ]
      : this.modelProjection.providers.map(
          ({ id, name, attached, catalogStatus, models }) => ({
            id,
            name,
            attached,
            catalogStatus,
            models,
          }),
        );
    for (const source of imports) {
      if (!source.available) continue;
      const providerId = source.id === "omp:nvidia" ? "nvidia" : "openrouter";
      const preset = PROVIDER_PRESETS.find((entry) => entry.id === providerId);
      if (
        !preset ||
        providers.some((provider) => provider.id === preset.baseUrl)
      )
        continue;
      providers.push({
        id: preset.baseUrl,
        name: preset.name,
        attached: false,
        catalogStatus: "idle",
        importSourceId: source.id,
      });
    }
    const providerIndex = sessionCatalog
      ? 0
      : Math.max(
          0,
          providers.findIndex(
            (provider) => provider.id === this.modelProjection.activeProviderId,
          ),
        );
    const provider = providers[providerIndex];
    const activeModels =
      provider?.attached && provider.catalogStatus === "ready"
        ? (provider.models ?? [])
        : [];
    const selectedModelId =
      selection === "session"
        ? session?.model
        : provider?.id === this.modelProjection.activeProviderId
          ? this.model
          : undefined;
    const models = [...activeModels];
    this.modelPicker = {
      open: true,
      origin: this.tab === "chat" ? "chat" : "workspace",
      selection,
      providers,
      query: "",
      cursor: 0,
      selected: Math.max(
        0,
        models.findIndex((model) => model.id === selectedModelId),
      ),
      providerIndex,
      ...(provider ? { providerId: provider.id } : {}),
      focusedPane: models.length ? "models" : "providers",
      catalogStatus:
        provider?.catalogStatus === "ready"
          ? "ready"
          : provider?.attached
            ? "unavailable"
            : "idle",
      models,
    };
    if (
      provider?.id ===
      this.workbench.providerModelsProjection().activeProviderId
    ) {
      // Refresh a missing live context window in the background; opening the
      // picker stays immediate and the ordinary redraw picks up the result.
      void this.loadModelPickerProvider(provider.id);
    }
    if (selection === "session" && !models.length)
      this.notice = "This conversation's provider has no available models.";
    else if (this.modelCatalogStatus !== "ready")
      this.notice = providers.some((provider) => provider.importSourceId)
        ? "An OMP provider key is available. Choose its provider row and press Right to load models."
        : providers.length
          ? "Choose a configured provider row and press Right to load its models."
          : "Use /sources and /connect SOURCE-ID to connect a provider before choosing a model.";
  }
  closeModelPicker() {
    this.modelPickerGeneration += 1;
    this.modelPicker = undefined;
  }
  selectModelPickerProvider(index: number) {
    const picker = this.modelPicker;
    if (!picker?.open) return;
    const providers = picker.providers;
    if (!providers.length) return;
    const providerIndex = Math.max(0, Math.min(providers.length - 1, index));
    const provider = providers[providerIndex]!;
    const columns = Math.max(1, (this.viewport.width ?? 80) - 4);
    const visibleRows = Math.max(
      1,
      this.viewport.height - (columns >= 88 ? 2 : 5),
    );
    const providerWindowStart = modelPickerSelectionWindowStart(
      picker.providerIndex,
      providerIndex,
      providers.length,
      visibleRows,
      picker.providerWindowStart,
    );
    const ready =
      provider.catalogStatus === "ready" && !!provider.models?.length;
    const loading = this.pendingModelCatalogs.has(
      this.modelCatalogKey(provider.id),
    );
    this.modelPicker = {
      ...picker,
      providerIndex,
      providerId: provider.id,
      focusedPane: "providers",
      query: "",
      cursor: 0,
      selected: 0,
      providerWindowStart,
      modelWindowStart: undefined,
      catalogStatus: ready
        ? "ready"
        : loading
          ? "loading"
          : provider.catalogStatus,
      models: ready ? (provider.models ?? []) : [],
    };
  }
  async loadModelPickerProvider(providerId: string) {
    const generation = this.modelPickerGeneration;
    const pendingKey = this.modelCatalogKey(providerId);
    const picker = this.modelPicker;
    const pickerSessionId =
      picker?.selection === "session" ? this.sessionId : undefined;
    const provider = picker?.providers.find(
      (candidate) => candidate.id === providerId,
    );
    if (!picker?.open || picker.providerId !== providerId || !provider) return;
    const selectedModel =
      picker.selection === "session" ? this.session()?.model : this.model;
    const activeOpenRouterContextMissing =
      providerId === this.modelProjection.activeProviderId &&
      this.provider?.providerId === "openrouter" &&
      typeof selectedModel === "string" &&
      selectedModel.length > 0 &&
      !this.provider.models.some(
        (model) =>
          model.id === selectedModel &&
          typeof model.contextWindow === "number" &&
          Number.isSafeInteger(model.contextWindow) &&
          model.contextWindow > 0,
      );
    if (
      provider.catalogStatus === "ready" &&
      provider.models?.length &&
      !activeOpenRouterContextMissing
    ) {
      this.modelPicker = {
        ...picker,
        focusedPane: "models",
        catalogStatus: "ready",
        models: provider.models ?? [],
      };
      return;
    }
    if (this.pendingModelCatalogs.has(pendingKey)) {
      this.modelPicker = {
        ...picker,
        focusedPane: "models",
        catalogStatus: "loading",
        models: [],
      };
      return;
    }
    this.pendingModelCatalogs.add(pendingKey);
    this.modelPicker = {
      ...picker,
      focusedPane: "models",
      selected: 0,
      modelWindowStart: undefined,
      catalogStatus: "loading",
      models: [],
    };
    try {
      let catalog: readonly {
        readonly id: string;
        readonly name: string;
        readonly contextWindow?: number;
      }[];
      if (provider.importSourceId) {
        catalog = await desktopProviderModels(
          provider.importSourceId,
          this.env,
          this.workbench,
        );
      } else {
        catalog = await this.workbench.providerModels(providerId);
      }
      const currentPicker = this.modelPicker;
      if (
        generation !== this.modelPickerGeneration ||
        (pickerSessionId !== undefined && this.sessionId !== pickerSessionId) ||
        !currentPicker?.open ||
        !currentPicker.providers.some(
          (candidate) => candidate.id === providerId,
        )
      )
        return;
      const activeProjection = this.workbench.providerModelsProjection();
      if (
        providerId === activeProjection.activeProviderId &&
        !provider.importSourceId
      ) {
        const refreshedProvider = await this.workbench.providerState({
          probeEnvironment: false,
        });
        const latestProjection = this.workbench.providerModelsProjection();
        if (
          generation === this.modelPickerGeneration &&
          (pickerSessionId === undefined ||
            this.sessionId === pickerSessionId) &&
          latestProjection.activeProviderId === providerId
        ) {
          this.provider = { ...refreshedProvider, models: catalog };
          this.modelProjection = latestProjection;
        }
      }
      const refreshedPicker = this.modelPicker;
      if (
        generation !== this.modelPickerGeneration ||
        (pickerSessionId !== undefined && this.sessionId !== pickerSessionId) ||
        !refreshedPicker?.open ||
        !refreshedPicker.providers.some(
          (candidate) => candidate.id === providerId,
        )
      )
        return;
      this.rememberModelContextWindows(
        [
          providerId,
          providerId === activeProjection.activeProviderId
            ? this.provider?.baseUrl
            : undefined,
          refreshedPicker.selection === "session"
            ? this.session()?.provider
            : undefined,
        ],
        catalog,
        true,
      );
      const models = catalog
        .filter(
          (model, index, all) =>
            all.findIndex((candidate) => candidate.id === model.id) === index,
        )
        .map((model) => ({ ...model }));
      const providers: ModelPickerProvider[] = refreshedPicker.providers.map(
        (candidate) =>
          candidate.id === providerId
            ? {
                ...candidate,
                catalogStatus: models.length ? "ready" : "unavailable",
                models,
              }
            : candidate,
      );
      if (refreshedPicker.providerId !== providerId) {
        this.modelPicker = { ...refreshedPicker, providers };
        return;
      }
      const matches = modelPickerMatches(models, refreshedPicker.query);
      this.modelPicker = {
        ...refreshedPicker,
        providers,
        selected: Math.max(
          0,
          matches.findIndex(
            (model) =>
              model.id ===
              (refreshedPicker.selection === "session"
                ? this.session()?.model
                : providerId === this.modelProjection.activeProviderId
                  ? this.model
                  : undefined),
          ),
        ),
        modelWindowStart: undefined,
        catalogStatus: models.length ? "ready" : "unavailable",
        models,
      };
      if (!models.length)
        this.notice = "This provider has no available models.";
    } catch (error) {
      const currentPicker = this.modelPicker;
      if (
        generation !== this.modelPickerGeneration ||
        (pickerSessionId !== undefined && this.sessionId !== pickerSessionId) ||
        !currentPicker?.open ||
        !currentPicker.providers.some(
          (candidate) => candidate.id === providerId,
        )
      )
        return;
      const providers: ModelPickerProvider[] = currentPicker.providers.map(
        (candidate) =>
          candidate.id === providerId
            ? { ...candidate, catalogStatus: "unavailable", models: [] }
            : candidate,
      );
      const isStillSelected = currentPicker.providerId === providerId;
      this.modelPicker = {
        ...currentPicker,
        providers,
        ...(isStillSelected
          ? { catalogStatus: "unavailable" as const, models: [] }
          : {}),
      };
      if (isStillSelected) {
        this.notice =
          error instanceof ProviderRequestError
            ? error.message
            : "Provider catalog unavailable. Check credentials or reconnect with /connect.";
      }
    } finally {
      this.pendingModelCatalogs.delete(pendingKey);
    }
  }
  async selectModel(modelId: string) {
    const picker = this.modelPicker;
    const generation = this.modelPickerGeneration;
    if (!picker?.open)
      throw new Error("Open /models before selecting a model.");
    if (
      !picker.providerId ||
      !picker.models.some((entry) => entry.id === modelId)
    )
      throw new Error("Model is not in the selected provider catalog.");
    if (picker.selection === "session") {
      const session = this.session();
      if (!session)
        throw new Error("The selected conversation is unavailable.");
      await this.workbench.selectSessionModel(session.id, modelId);
      if (generation === this.modelPickerGeneration) {
        this.closeModelPicker();
        this.notice = `This conversation now uses ${modelId}; other conversations keep their model.`;
      }
      return;
    }
    const provider = picker.providers.find(
      (candidate) => candidate.id === picker.providerId,
    );
    if (provider?.importSourceId) {
      this.provider = await importDesktopProvider(
        provider.importSourceId,
        this.env,
        this.workbench,
        modelId,
      );
    } else {
      await this.workbench.selectProviderModel(picker.providerId, modelId);
    }
    this.provider = await this.workbench.providerState({
      probeEnvironment: false,
    });
    this.modelProjection = this.workbench.providerModelsProjection();
    this.modelCatalogStatus =
      this.provider.connected && this.provider.models.length > 0
        ? "ready"
        : "unavailable";
    this.model = modelId;
    if (generation === this.modelPickerGeneration) {
      this.closeModelPicker();
      this.notice =
        "Future conversations use this model; active conversations keep their model.";
    }
  }
  cycleMode() {
    const previous = this.mode;
    const next =
      TUI_MODES[(TUI_MODES.indexOf(this.mode) + 1) % TUI_MODES.length]!;
    this.mode = next;
    this.modeBeforePlan = next === "plan" ? previous : undefined;
    this.notice =
      next === "plan"
        ? "Plan mode. Prompts ask for a plan before any tool runs."
        : next === "accept"
          ? "Accept mode. Shorter edit keys, approvals stay explicit."
          : "Normal mode. Every change and approval needs your key.";
  }
  private setPlanMode() {
    if (this.mode !== "plan") this.modeBeforePlan = this.mode;
    this.mode = "plan";
    this.notice = "Plan mode. Prompts ask for a plan before any tool runs.";
  }
  togglePlanMode() {
    if (this.mode === "plan") {
      this.mode = this.modeBeforePlan ?? "normal";
      this.modeBeforePlan = undefined;
      this.notice =
        this.mode === "accept"
          ? "Accept mode restored. Tool approvals stay explicit."
          : "Normal mode restored. Every change and approval needs your key.";
      return;
    }
    this.setPlanMode();
  }
  queuePrompt(value: string | undefined) {
    this.queuedPromptPaused = false;
    if (value === undefined) {
      this.queuedPrompt = null;
      this.notice = "Queued prompt cancelled.";
      return;
    }
    this.queuedPrompt = [...value].slice(0, 32000).join("");
    this.notice =
      "Run is active. The prompt is queued and sends when it stops.";
  }
  queueFollowUpPrompt(value: string): boolean {
    if (!value.trim()) {
      this.notice = "Type a prompt before queueing it.";
      return false;
    }
    if (this.queuedPrompt !== null) {
      this.notice = this.queuedPromptPaused
        ? "A queued prompt is paused. Resume or cancel it before queueing another."
        : "A prompt is already queued. Restore or cancel it before queueing another.";
      return false;
    }
    this.queuePrompt(value);
    return true;
  }
  dequeueQueuedPrompt(): string | null {
    if (!this.queuedPrompt) return null;
    if (this.queuedPromptPaused) {
      this.notice =
        "Queued prompt is paused after recovery. Reconcile the outcome, then use /queue resume.";
      return null;
    }
    const queued = this.queuedPrompt;
    this.queuedPrompt = null;
    this.notice = "Queued prompt restored to the composer.";
    return queued;
  }
  private queueBlockedByRuntime() {
    return (
      this.workbench.running() ||
      this.workbench
        .runs()
        .some(
          (run) =>
            run.sessionId === this.sessionId &&
            ["unknown", "stopping", "paused"].includes(run.state),
        )
    );
  }
  takeQueued(): string | null {
    if (
      !this.queuedPrompt ||
      this.confirmation ||
      this.queuedPromptPaused ||
      this.queueBlockedByRuntime()
    )
      return null;
    const next = this.queuedPrompt;
    this.queuedPrompt = null;
    return next;
  }
  /**
   * Raise a transient notice. Toasts carry events that would otherwise be
   * missed in the scrollback: a finished save, a dropped connector, a run
   * that stopped. Anything an operator must act on stays in the sticky
   * approval banner instead, because a toast can expire.
   */
  notify(
    id: string,
    tone: "info" | "success" | "warning" | "danger" | "pending",
    message: string,
    ttl = DEFAULT_TOAST_LIMITS.defaultTtl,
  ) {
    this.toasts = raiseToast(
      this.toasts,
      {
        id,
        tone,
        message,
        icon: toastIcon(tone),
        at: Date.now(),
        ttl,
      },
      DEFAULT_TOAST_LIMITS,
    );
  }
  /**
   * Set the one line notice and raise a toast for the same event.
   *
   * The notice is overwritten by the next keystroke, so an event that matters
   * after the operator looks away needs a second home. The id is stable per
   * event kind, so repeating the event updates the existing toast rather than
   * stacking a new one on every keypress.
   *
   * A danger or pending tone gets ttl 0 and therefore never expires: an event
   * the operator has to act on must not be allowed to time out while they are
   * looking at something else.
   */
  announce(
    id: string,
    tone: "info" | "success" | "warning" | "danger" | "pending",
    message: string,
  ) {
    this.notice = message;
    this.notify(
      id,
      tone,
      message,
      tone === "danger" || tone === "pending"
        ? 0
        : DEFAULT_TOAST_LIMITS.defaultTtl,
    );
  }
  /**
   * Every subsystem, checked, with the reason it is in that state.
   *
   * The point of this is a single answer to "is this workspace actually
   * working", which until now meant checking the provider here, the ledger
   * there, and connectors somewhere else, and noticing a corrupted ledger only
   * after a run had already failed on it.
   *
   * A check that could not run is reported as unknown and never as ok. A panel
   * that says a subsystem it could not reach is healthy turns an absence of
   * information into an assurance, which is strictly worse than no panel.
   */
  healthChecks(): Check[] {
    const checks: Check[] = [];
    const add = (
      name: string,
      area: string,
      state: HealthState,
      detail: string,
      remedy?: string,
    ) => checks.push({ name, area, state, detail, remedy });

    // Provider. It is undefined only when providerState threw, and that is
    // exactly the case that must not read as fine.
    if (!this.provider) {
      add(
        "provider",
        "runtime",
        "unknown",
        "Provider state has not been read yet.",
        "Run /connect, or r to retry.",
      );
    } else {
      const connected = this.provider.connected;
      const status = this.provider.status;
      const setupRequired = status === "setup-required";
      const rateLimited = status === "rate-limited";
      const detail =
        status === "ready"
          ? `Connected to ${this.provider.providerId ?? "a provider"}.`
          : `${status}: ${this.provider.detail ?? (setupRequired ? "No provider credential is configured." : "Provider is not ready.")}${this.provider.retryAt ? ` Retry at ${this.provider.retryAt}.` : ""}`;
      add(
        "provider",
        "runtime",
        status === "ready" && connected
          ? "ok"
          : setupRequired || rateLimited
            ? "warn"
            : "fail",
        detail,
        setupRequired
          ? "Run /connect to show credential setup."
          : rateLimited
            ? "Retry when the provider rate limit clears."
            : status === "unavailable"
              ? "Review the configured credential and endpoint; confirm provider availability before retrying."
              : connected
                ? undefined
                : "Run /connect to attach one.",
      );
      const models = this.provider.models?.length ?? 0;
      add(
        "models",
        "runtime",
        connected && models === 0 ? "warn" : "ok",
        connected
          ? models === 0
            ? "Connected, but no model is listed."
            : `${models} model(s) available.`
          : "Not listed until a provider is connected.",
        connected && models === 0
          ? "Reconnect to refresh the model list."
          : undefined,
      );
    }

    // Ledger. A proof error is the one failure that invalidates recovery and
    // export, so it is a fail and not a warn.
    if (this.proofErrors.size) {
      for (const [id, error] of this.proofErrors)
        add(
          `ledger ${id.slice(0, 8)}`,
          "records",
          "fail",
          error,
          "Run /verify, then /rewind to inspect what the chain lost.",
        );
    } else if (this.managedVerificationStatus) {
      add(
        "ledger",
        "records",
        this.managedVerificationStatus.startsWith("verified") ||
          /verified/i.test(this.managedVerificationStatus)
          ? "ok"
          : "warn",
        `Hash chain ${this.managedVerificationStatus}.`,
        this.managedVerificationNote,
      );
    } else {
      add(
        "ledger",
        "records",
        "unknown",
        "No managed workspace has been verified yet.",
        "Run /verify.",
      );
    }

    // Runs needing reconciliation are work that stopped without a decision.
    const stuck = this.workbench.runs().filter((run) => run.reconcileRequired);
    add(
      "runs",
      "records",
      stuck.length ? "warn" : "ok",
      stuck.length
        ? `${stuck.length} run(s) need reconciliation.`
        : "No run needs reconciliation.",
      stuck.length ? "Open /runs to decide each one." : undefined,
    );

    // Connectors, by consent state. An unconfirmed connector is skipped, not
    // failed: it has not been asked for anything yet.
    const connectors = this.workbench.connectionState().connectors;
    const unconfirmed = connectors.filter(
      (c) => "consentState" in c && c.consentState !== "confirmed",
    );
    add(
      "connectors",
      "integrations",
      unconfirmed.length ? "warn" : "ok",
      connectors.length
        ? `${connectors.length} connector(s), ${unconfirmed.length} not confirmed.`
        : "No connector configured.",
      unconfirmed.length ? "Confirm the ones you intend to use." : undefined,
    );

    // Workspace storage. An init that never ran is the difference between a
    // workspace that survives a restart and one that does not.
    const storage = this.workbench.allViews().length;
    add(
      "storage",
      "runtime",
      storage ? "ok" : "warn",
      storage
        ? `${storage} workspace view(s) on disk.`
        : "No workspace view has been created.",
      storage ? undefined : "Run /init to set up workspace storage.",
    );

    // Agent identity and revocation. The only implemented authority is this
    // local Workbench and its signed workspace evidence. Fleet-wide revoke is
    // always named unavailable rather than inferred from a local success.
    const boundViews = this.workbench
      .allViews()
      .filter((view) => view.agent !== undefined && view.runId !== undefined);
    if (boundViews.length === 0) {
      add(
        "agent revocation",
        "identity",
        "unknown",
        "No run-scoped agent identity has been observed; local and fleet revocation are unmeasured.",
        "Start a local Workbench run before evaluating revocation.",
      );
    } else {
      const current = this.session();
      const view =
        current?.agent !== undefined && current.runId !== undefined
          ? current
          : boundViews.at(-1)!;
      const agentId = view.agent!;
      const revoked = this.workbench.isAgentRevoked(agentId);
      add(
        "agent revocation",
        "identity",
        "warn",
        `principal ${LOCAL_AGENT_PRINCIPAL_ID} · workspace ${view.workspace} · agent ${agentId} · run ${view.runId} · agent ${revoked ? "revoked" : "active"}; local agent revoke ${revoked ? "applied" : "available"}; fleet-wide revoke unavailable because no node inventory or acknowledgement barrier exists.`,
        revoked
          ? "Fleet acknowledgement remains unavailable; disconnected nodes cannot be proven revoked."
          : `/revoke-agent ${agentId} reviews local revocation.`,
      );
    }

    return checks;
  }
  /**
   * The health panel body, plus a line saying which way to read it.
   *
   * The summary comes first because a panel an operator has to read to the
   * bottom before finding out whether anything is wrong is a panel they will
   * not open twice.
   */
  healthLines(): string[] {
    const checks = this.healthChecks();
    return [
      ...renderHealth(checks, 72, {
        motion: motionContext(this.frame),
      }),
      "",
      healthSummary(checks),
    ];
  }
  /**
   * Fold or unfold the group under the cursor in a Sessions or Documents tree.
   *
   * Returns false when there is no tree or no folder at the cursor, so the
   * caller falls back to the normal arrow behaviour. Returning true only
   * when a folder actually moved is what keeps the arrows meaning one thing
   * at a time.
   */
  collapseOrExpand(open: boolean): boolean {
    const tree = this.groupTree;
    if (!tree) return false;
    const visible = flattenTree(tree.nodes, tree.state);
    const node = visible[tree.state.cursor];
    if (!node?.hasChildren) return false;
    tree.state = toggleTreeNode(tree.state, node.id, tree.nodes);
    this.notice = `${open ? "Opened" : "Collapsed"} ${node.label}.`;
    return true;
  }
  /** Activate the visible tree cursor: expand groups or select their leaf row. */
  activateTreeCursor(): "group" | "row" | undefined {
    const tree = this.groupTree;
    if (!tree) return undefined;
    // The narrow session inspector is already showing the conversation the
    // cursor selected, so Enter there is the second half of the gesture and
    // opens it in Chat. Returning "row" is what asks the caller to navigate.
    // Escape clears the detail pane without knowing about this flag, so the
    // pane's own presence is what keeps the flag honest.
    if (this.sessionInspectorDetail) {
      if (this.detail) return "row";
      this.sessionInspectorDetail = false;
    }
    const node = flattenTree(tree.nodes, tree.state)[tree.state.cursor];
    if (!node) return undefined;
    if (node.hasChildren) {
      this.collapseOrExpand(!tree.state.expanded.has(node.id));
      this.detail = undefined;
      this.sessionInspectorDetail = false;
      this.documentPreview = false;
      this.scroll = 0;
      return "group";
    }
    const selected = this.items().findIndex((row) => row.id === node.id);
    if (selected < 0) return undefined;
    this.selected = selected;
    // Below the side-by-side threshold there is no room for a second pane,
    // so the inspector takes the list's place until Esc gives it back.
    if (this.tab === "sessions" && !this.sessionSideBySide()) {
      this.sessionInspectorDetail = true;
      this.detail = this.sessionInspectorLines(node.id, this.layoutColumns);
      this.documentPreview = false;
      this.scroll = 0;
      return "group";
    }
    return "row";
  }
  /** Whether the sessions inspector can sit beside the list at this width. */
  private sessionSideBySide(): boolean {
    return sessionInspectorLayout(
      this.layoutColumns + SESSION_FRAME_COLUMNS,
      1,
    ).sideBySide;
  }
  /**
   * Fold or unfold the section the sessions cursor is on.
   *
   * Enter on a heading already does this; the method exists so a dedicated
   * group key can call the same behaviour without a second implementation.
   * Returns false when the cursor is on a conversation rather than a heading.
   */
  toggleSessionGroup(): boolean {
    const tree = this.groupTree;
    if (!tree || this.tab !== "sessions") return false;
    const node = flattenTree(tree.nodes, tree.state)[tree.state.cursor];
    if (!node?.hasChildren) return false;
    return this.collapseOrExpand(!tree.state.expanded.has(node.id));
  }
  /**
   * Put the cursor on the next or previous section heading, opening it.
   *
   * Cycling by section is the fast way through a list whose headings are the
   * only structure it has. It wraps, so one direction always reaches every
   * section, and it expands what it lands on so the rows are visible without
   * a second keystroke.
   */
  cycleSessionGroup(direction: number): boolean {
    const tree = this.groupTree;
    if (!tree || this.tab !== "sessions") return false;
    const visible = flattenTree(tree.nodes, tree.state);
    const headings = visible.flatMap((node, index) =>
      node.hasChildren ? [{ node, index }] : [],
    );
    if (!headings.length) return false;
    const current = headings.findIndex(
      (heading) => heading.index >= tree.state.cursor,
    );
    const step = direction < 0 ? -1 : 1;
    const target =
      current < 0
        ? direction < 0
          ? headings.length - 1
          : 0
        : (current + step + headings.length) % headings.length;
    const heading = headings[target]!;
    const expanded = new Set(tree.state.expanded);
    expanded.add(heading.node.id);
    tree.state = { expanded, cursor: heading.index };
    this.sessionInspectorDetail = false;
    this.detail = undefined;
    this.scroll = 0;
    this.notice = `Section ${heading.node.label}.`;
    return true;
  }
  /**
   * Move the Sessions or Documents tree cursor. Returns false when there is
   * no tree, so the caller falls back to moving through the flat item list.
   */
  moveTreeCursor(delta: number): boolean {
    const tree = this.groupTree;
    if (!tree) return false;
    tree.state = moveTree(tree.state, delta, tree.nodes);
    this.syncTreeCursorSelection();
    return true;
  }
  /** Page a tree without wrapping, matching OMP's selector paging. */
  moveTreeCursorByPage(direction: number, pageSize: number): boolean {
    const tree = this.groupTree;
    if (!tree) return false;
    const visible = flattenTree(tree.nodes, tree.state);
    if (!visible.length) return true;
    tree.state = {
      ...tree.state,
      cursor: Math.max(
        0,
        Math.min(
          visible.length - 1,
          tree.state.cursor + direction * Math.max(1, pageSize),
        ),
      ),
    };
    this.syncTreeCursorSelection();
    return true;
  }
  /** Put the grouped selector cursor on an exact visible row, as a mouse hit does. */
  selectTreeCursor(index: number): boolean {
    const tree = this.groupTree;
    if (!tree) return false;
    const visible = flattenTree(tree.nodes, tree.state);
    if (!visible.length) return true;
    tree.state = {
      ...tree.state,
      cursor: Math.max(0, Math.min(visible.length - 1, index)),
    };
    this.syncTreeCursorSelection();
    return true;
  }
  private syncTreeCursorSelection(): void {
    const tree = this.groupTree;
    if (!tree) return;
    const visible = flattenTree(tree.nodes, tree.state);
    const node = visible[tree.state.cursor];
    const selected = node?.hasChildren
      ? -1
      : this.items().findIndex((row) => row.id === node?.id);
    if (selected >= 0) this.selected = selected;
    // Live document preview: when cursor lands on a document (leaf), show
    // a preview in the detail pane without requiring Enter. The operator
    // can scan documents with arrow keys and see content instantly.
    if (this.tab === "documents") {
      this.detail = undefined;
      this.documentPreview = false;
      if (node && !node.hasChildren && node.id) {
        const separator = node.id.indexOf(":");
        const sessionId = separator < 0 ? "" : node.id.slice(0, separator);
        const path = separator < 0 ? "" : node.id.slice(separator + 1);
        if (sessionId && path) {
          const doc = this.workbench.document(sessionId, path);
          if (doc) {
            this.documentPreview = true;
            const preview = doc.content
              ? doc.content.split("\n").slice(0, 20).join("\n")
              : "(empty)";
            this.detail = [
              ...renderInspector(
                {
                  title: path,
                  subtitle: `${sessionId.slice(0, 8)} · ${doc.bytes} B`,
                  icon: ROW_ICONS.document,
                  sections: [
                    {
                      title: "preview (first 20 lines)",
                      fields: [
                        {
                          label: "content",
                          value: preview,
                          tone: "muted",
                        },
                      ],
                    },
                  ],
                  hint: "Up/Down moves through files. PageUp/Down or Left/Right pages the tree. Enter toggles folders. /document path opens it.",
                },
                { width: this.layoutColumns },
              ),
            ];
            this.scroll = 0;
          }
        }
      } else {
        this.detail = undefined;
        this.documentPreview = false;
        this.scroll = 0;
      }
    }
  }
  /** Move a grouped tree to its first or last currently visible row. */
  moveTreeCursorToBoundary(end: boolean): boolean {
    const tree = this.groupTree;
    if (!tree) return false;
    const visible = flattenTree(tree.nodes, tree.state);
    if (!visible.length) return true;
    tree.state = { ...tree.state, cursor: end ? visible.length - 1 : 0 };
    this.syncTreeCursorSelection();
    return true;
  }
  /**
   * Announce holds that are about to close, or already have.
   *
   * An expired approval cannot release its tool, so silence is the one
   * response that is actively misleading: the operator sees a pending row,
   * presses the key, and only then learns the window closed. Keyed by hold id
   * so one hold raises one notice that updates in place, rather than a new
   * line on every refresh tick.
   *
   * Sticky in both cases. A hold closing in twenty seconds and one that
   * closed a minute ago are both things the operator has to see, and neither
   * should time out while they are looking somewhere else.
   */
  watchHoldsForExpiry(now = Date.now()) {
    for (const hold of this.workbench.pending()) {
      const left = holdSecondsLeft(hold as { expiresAt?: number }, now);
      if (left === null) continue;
      const tool = String(
        (hold.call as { tool?: unknown } | undefined)?.tool ?? "tool",
      );
      if (left <= 0) {
        this.notify(
          `expiry:${hold.holdId}`,
          "danger",
          `Approval for ${tool} expired. It can no longer release the tool.`,
          0,
        );
        continue;
      }
      if (left <= EXPIRY_WARNING_SECONDS)
        this.notify(
          `expiry:${hold.holdId}`,
          "warning",
          `Approval for ${tool} closes in ${left}s.`,
          0,
        );
    }
  }

  /** Drop expired toasts. A sticky one survives any amount of elapsed time. */
  expireToasts(now = Date.now()) {
    this.toasts = expireToasts(this.toasts, now);
  }
  /**
   * Whether the visible detail is still the keybinding table.
   *
   * Checked against the rendered content rather than trusted from the flag
   * alone, because several command paths replace detail with something else
   * without knowing a flag exists. A stale flag would make ordinary typing
   * filter a table that is no longer on screen, and the keystrokes would
   * vanish with nothing to show for it.
   */
  get showingKeybindings(): boolean {
    return (
      this.keybindingDetail && !!this.detail?.[0]?.startsWith("KEYBINDINGS")
    );
  }
  /**
   * Re-render the keybinding table after the query changes, or after the
   * terminal changed width. The table is sized to the terminal rather than to
   * a constant, because a fixed width truncates the action column on a wide
   * terminal and wastes the space on a narrow one.
   */
  refreshKeybindings(width = 72) {
    this.detail = keybindingLines(this.keybindingQuery, width);
    this.keybindingWidth = width;
    this.scroll = 0;
  }
  /**
   * True while the cheat sheet is the visible detail.
   *
   * The flag is checked together with a content test, same as the keybinding
   * table. Roughly a dozen command paths replace detail with something else
   * without knowing an overlay flag exists, and a stale flag would leave the
   * ordinary typing keys filtering a sheet nobody can see.
   */
  get showingCheatSheet(): boolean {
    return (
      this.cheatSheet && this.detail?.[0]?.startsWith("? Cheat sheet") === true
    );
  }
  /**
   * Which bindings apply right now.
   *
   * The context is read from published fields rather than passed in, because
   * the runner knows the keyboard state and the model knows what is on screen,
   * and neither of them alone can answer "which keys work now".
   */
  liveBindings() {
    return bindingsFor({
      editing: this.editingInput,
      running: this.session()?.status === "running",
      suspendSupported: process.platform !== "win32",
      queued: !!this.queuedPrompt && !this.queuedPromptPaused,
      retryable: this.canRetryLastTurn(),
      reviewing: !!this.diffView || !!this.confirmation,
      backable:
        this.cheatSheet ||
        this.keybindingDetail ||
        (this.tab !== "chat" && !!this.detail) ||
        !!this.filter ||
        !!this.palette ||
        this.modelPicker?.open === true,
      tab: this.tab,
    });
  }
  canRetryLastTurn(): boolean {
    const session = this.session();
    if (!session || session.status !== "failed") return false;
    let lastUserIndex = -1;
    for (let index = session.events.length - 1; index >= 0; index -= 1) {
      if (session.events[index]?.kind === "user") {
        lastUserIndex = index;
        break;
      }
    }
    return (
      lastUserIndex >= 0 &&
      session.events
        .slice(lastUserIndex + 1)
        .some((event) => event.kind === "error")
    );
  }
  /** Open the cheat sheet, optionally with a filter already typed. */
  openCheatSheet(query = "") {
    this.cheatSheet = true;
    this.cheatQuery = query;
    this.refreshCheatSheet();
  }
  /**
   * Close it and hand the frame back to whatever was on screen.
   *
   * The detail is dropped rather than restored, because nothing under it
   * changed while the sheet was open, so re-deriving it would cost a render
   * pass to produce a result identical to the one already in the body rows.
   */
  closeCheatSheet() {
    this.cheatSheet = false;
    this.cheatQuery = "";
    this.detail = undefined;
    this.scroll = 0;
    this.notice = "Cheat sheet closed.";
  }
  /** Re-lay the cheat sheet after a keystroke or a terminal width change. */
  refreshCheatSheet(width = 72) {
    const all = this.liveBindings();
    const shown = filterBindings(all, this.cheatQuery);
    this.detail = renderCheatSheet(
      { bindings: shown, query: this.cheatQuery },
      { width },
    );
    this.cheatWidth = width;
    this.scroll = 0;
  }
  reject() {
    if (!this.confirmation) return;
    this.confirmation = undefined;
    this.scroll = 0;
    this.notice = "Rejected. Nothing was applied.";
  }
  /** Previous user prompts of this conversation, most recent first. */
  promptHistory(): string[] {
    return (this.session()?.events ?? [])
      .filter(
        (event) =>
          event.kind === "user" &&
          (!event.type || event.type === "message.completed"),
      )
      .map((event) => event.text)
      .reverse();
  }
  documentPaths(): string[] {
    return [
      ...new Set(this.workbench.documentsList().map((item) => item.path)),
    ];
  }
  /** Transcript size and cumulative usage are not the model's context window. */
  contextNumbers() {
    const session = this.session();
    const events = session?.events ?? [];
    const messages = events.filter(
      (event) => event.kind === "user" || event.kind === "assistant",
    ).length;
    const usageEvents = events.filter((event) => event.kind === "usage");
    const known = usageEvents.some(
      (event) => typeof event.payload?.total_tokens === "number",
    );
    const tokens = usageEvents.reduce(
      (sum, event) =>
        sum +
        (typeof event.payload?.total_tokens === "number"
          ? (event.payload.total_tokens as number)
          : 0),
      0,
    );
    let docs = 0;
    if (session) {
      try {
        docs = Object.keys(
          this.workbench.workspace(session.id).files ?? {},
        ).length;
      } catch {
        docs = 0;
      }
    }
    const contextMessages = session?.contextMessages ?? null;
    // The ceiling is the agent profile's own limit, not a guess. A meter drawn
    // against an invented maximum would report the context as half full when
    // the only honest answer is that no limit has been declared.
    const limit = session
      ? (this.workbench.agents().profiles.find((p) => p.maxContextTokens > 0)
          ?.maxContextTokens ?? null)
      : null;
    return {
      messages,
      contextMessages,
      tokens: known ? tokens : null,
      docs,
      contextUsed: known ? tokens : null,
      contextTokens: limit,
    };
  }
  private redactSecrets(value: string) {
    let out = value;
    for (const key of [
      "TOKENHARBOR_API_KEY",
      "TOKENROUTER_API_KEY",
      "NVIDIA_API_KEY",
      "OPENROUTER_API_KEY",
      "NOMO_SIGNING_KEY",
      "NOMO_VERIFY_KEY",
      "NOMO_WORKSPACE_KEY",
    ]) {
      const secret = this.env[key];
      if (secret) out = out.split(secret).join("[redacted]");
    }
    return out;
  }
  async runShell(raw: string) {
    const cmd = raw.slice(1).trim();
    if (!cmd) throw Error("Usage: !command (local shell, 10 s limit)");
    if (SHELL_REFUSALS.some((re) => re.test(cmd)))
      throw Error(
        "Refused: the command references credentials or key material.",
      );
    this.activeShellCommands += 1;
    try {
      let out: string;
      try {
        // The shell is the operator's, so name it per platform rather than
        // assuming sh: on Windows there is no sh on PATH without Git Bash, which
        // made every !command fail with ENOENT. PATH stays narrowed on both
        // sides, because the point is to expose a small tool set and not the
        // operator's whole environment.
        const windows = process.platform === "win32";
        const shell = windows ? (process.env.ComSpec ?? "cmd.exe") : "sh";
        // cmd needs /c to run anything at all; /d only turns AutoRun off and
        // /s strips the surrounding quotes. Without /c it starts an interactive
        // prompt and the 10 s timeout is what ends it.
        const args = windows ? ["/d", "/s", "/c", cmd] : ["-c", cmd];
        const systemRoot = process.env.SystemRoot ?? "C:\\Windows";
        const result = await runShellFile(shell, args, {
          env: windows
            ? {
                PATH: `${systemRoot}\\System32`,
                SystemRoot: systemRoot,
                ComSpec: shell,
              }
            : { PATH: "/usr/bin:/bin", LANG: "C" },
          timeout: 10000,
          maxBuffer: 1024 * 64,
        });
        const r = result as { stdout: string; stderr: string };
        out = `${r.stdout ?? ""}` + (r.stderr ? `\n[stderr]\n${r.stderr}` : "");
      } catch (error) {
        const failed = error as { stdout?: unknown; stderr?: unknown };
        const partial = `${failed.stdout ?? ""}${failed.stderr ?? ""}`.trim();
        throw Error(
          partial
            ? "Local command failed. Partial output stays out of the ledger."
            : `Local command failed. ${this.redactSecrets(message(error))}`,
        );
      }
      const shown = this.redactSecrets(out).slice(0, 4000) || "(no output)";
      this.detail = [
        `LOCAL SHELL, not stored in the ledger (exit 0): ${this.redactSecrets(cmd).slice(0, 120)}`,
        "",
        ...shown.split("\n"),
      ];
      this.scroll = 0;
      this.notice = "Shell output is shown once and never persisted.";
    } finally {
      this.activeShellCommands = Math.max(0, this.activeShellCommands - 1);
    }
  }
  /** @path tokens quote managed document content into the prompt. */
  expandMentions(prompt: string, sessionId: string) {
    let paths = new Set<string>();
    try {
      paths = new Set(
        Object.keys(this.workbench.workspace(sessionId).files ?? {}),
      );
    } catch {
      paths = new Set();
    }
    const missing: string[] = [];
    const hasBinary = (path: string) => {
      const ext = path.slice(path.lastIndexOf(".")).toLowerCase();
      return [".pdf", ".exe", ".dll", ".so", ".dylib", ".bin", ".dat"].includes(
        ext,
      );
    };
    const expanded = prompt.replace(
      /@([^\s@][^\s]*)/g,
      (token, path: string) => {
        if (!paths.has(path)) {
          if (!missing.includes(path)) missing.push(path);
          return token;
        }
        const doc = this.workbench.document(sessionId, path);
        const isBinary = hasBinary(path);
        if (isBinary) {
          return `${path} [binary file — capability check required]`;
        }
        return `${path} (quoted context):
${(doc.content ?? "").slice(0, 2000)}`;
      },
    );
    return { expanded, missing };
  }
  prepareCompact() {
    const session = this.session();
    if (!session) throw Error("Select a conversation to compact.");
    const lastSeq = session.events.at(-1)?.seq;
    this.confirmation = {
      title: `COMPACT CONTEXT ${session.title ?? session.id}?`,
      lines: [
        "This changes the context sent to the model on the next turn.",
        "The Workbench chooses which messages to retain and summarizes older context.",
        "The complete transcript, documents and signed ledger remain unchanged.",
        "Token savings are unknown. No provider summarization is promised.",
      ],
      apply: async () => {
        this.confirmation = undefined;
        if (this.workbench.get(session.id)?.events.at(-1)?.seq !== lastSeq)
          throw Error("The conversation changed. Request /compact again.");
        const result = this.workbench.compact(session.id);
        this.detail = [
          "CONTEXT COMPACTION RESULT",
          `Omitted messages: ${result.omittedMessageCount}`,
          `Created: ${result.createdAt}`,
          "Retained message IDs:",
          ...result.retainedMessageIds,
          "",
          "Summary:",
          result.summary || "No messages needed compaction.",
          "",
          "Transcript and ledger preserved. /context shows reported counts.",
        ];
        this.notice = result.omittedMessageCount
          ? "Context compacted. The next turn uses the retained context."
          : "Context unchanged. No messages needed compaction.";
      },
    };
    this.scroll = 0;
  }
  /**
   * Outstanding operations, newest last. /diff steps through this list one
   * operation at a time. The helper exists so /diff and /diff-next agree on
   * what "outstanding" means; a second definition would let them disagree and
   * show an index that does not exist.
   */
  openOperations() {
    if (!this.sessionId) return [];
    const ops = this.workbench.workspace(this.sessionId).operations;
    const undone = new Set(ops.flatMap((o) => (o.undoes ? [o.undoes] : [])));
    return ops.filter(
      (o) =>
        o.kind !== "undo" &&
        !undone.has(o.id) &&
        (!this.documentPath || o.path === this.documentPath),
    );
  }
  /**
   * Every operation in this workspace as recovery rows, settled ones included.
   *
   * openOperations answers "what can I still undo", which is the diff panel's
   * question. This answers "what happened to this workspace and what is still
   * open", which nobody could answer before. Same source, different filter,
   * and the reason for that filter is named rather than left in the reader.
   */
  recoveryRows(): RecoveryRow[] {
    if (!this.sessionId) return [];
    const ops = this.workbench.workspace(this.sessionId).operations;
    const undone = new Set(ops.flatMap((o) => (o.undoes ? [o.undoes] : [])));
    return ops.map((o) => {
      const settled = o.kind === "undo" || undone.has(o.id);
      return {
        id: o.id,
        kind:
          o.kind === "undo"
            ? ("undo" as const)
            : o.kind === "delete"
              ? ("delete" as const)
              : ("edit" as const),
        path: o.path,
        seq: 0,
        // A decided operation is not something to act on. An operation still
        // open is recoverable, because the captured state is what makes it so.
        recoverable: settled
          ? o.kind === "undo"
            ? "already-undone"
            : "kept"
          : "recoverable",
        // The workspace record carries no timestamp and no reason. Both are
        // left undefined rather than derived: an age the terminal worked out
        // itself would not be the age the system recorded.
        at: undefined,
        undoesId: typeof o.undoes === "string" ? o.undoes : undefined,
      };
    });
  }
  /** The /diff panel body for the currently selected operation. */
  diffDetailLines(
    open: readonly {
      id: string;
      path: string;
      kind: string;
      before?: string | null;
      after?: string | null;
    }[],
    width = Math.max(1, (this.viewport.width ?? 76) - 4),
    height = Math.max(8, this.viewport.height || 0),
  ) {
    const operation = open[this.diffIndex];
    if (!operation) {
      this.diffView = undefined;
      return ["No outstanding changes. Every edit is undone or kept."];
    }
    // The state is built once and kept, so j/k, space and s mutate a value
    // rather than re-deriving one. Rebuilding on every keypress would reset
    // the cursor and silently drop the staged flags the operator just set.
    this.diffView ??= buildDiffView(
      operation.before ?? "[does not exist]",
      operation.after ?? "[does not exist]",
    );
    return [
      `DIFF ${this.diffIndex + 1} of ${open.length}: ${operation.path} (${operation.kind} ${operation.id.slice(0, 8)})`,
      "",
      ...renderDiffPanel(this.diffView, width, height),
      "",
      "Esc closes diff review.",
      "/diff-next steps to the next outstanding operation.",
      "/undo ID for reviewed Undo of one operation.",
      "a sets all hunks staged; when all are staged, it clears them.",
    ];
  }
  /**
   * Re-render the diff panel from its state after a review key. The panel
   * keeps its cursor and staged flags because they live in diffView, not in
   * the lines that were printed.
   */
  rediff() {
    if (!this.diffView) return;
    this.detail = this.diffDetailLines(this.openOperations());
    // Cursor moves inside the body, so the scroll has to follow it or the
    // hunk the operator just moved to may be off screen.
    this.scroll = Math.max(0, this.detail.length - 1);
  }
  /**
   * The confirmation behind `/harness approve` and `/harness reject`.
   *
   * The operator sees the complete proposal before anything is decided: the
   * summary, the rationale, the expected outcome, the full digest, the cited
   * chain position and the exact diff. The approve path is the only one in
   * this file that changes the prompt every later conversation runs under,
   * so it is the one path that never acts on a list row or a bare command.
   */
  async prepareHarnessDecision(
    digestPrefix: string,
    decision: "approve" | "reject",
  ) {
    if (!this.sessionId) throw Error("Select a conversation.");
    if (!/^[a-f0-9]{8,64}$/.test(digestPrefix))
      throw Error("Enter at least 8 hexadecimal digest characters.");
    const pending = await this.workbench.pendingApprovalsFor(this.sessionId);
    const matches = pending.filter((proposal) =>
      proposal.digest.startsWith(digestPrefix),
    );
    if (matches.length !== 1)
      throw Error(
        matches.length > 1
          ? `Digest prefix ${digestPrefix} is ambiguous. Enter more characters.`
          : pending.length
            ? `No pending proposal starts with ${digestPrefix}. /harness lists them.`
            : "No Harness proposal is awaiting an operator decision.",
      );
    const match = matches[0]!;
    const sessionId = this.sessionId;
    // Proposal text is operator- and model-authored and lands in terminal
    // rows, so control characters are escaped before paint, not after.
    const proposalLines = escapeTerminalText(
      JSON.stringify(match.proposal, null, 2),
    ).split("\n");
    this.confirmation = {
      title: `${decision === "approve" ? "APPROVE" : "REJECT"} HARNESS PROPOSAL ${match.digest.slice(0, 8)}?`,
      lines: [
        decision === "approve"
          ? "This applies the exact proposal after checking its digest and provenance."
          : "This records rejection and activates none of the proposed edits.",
        "",
        `Summary: ${escapeTerminalText(match.summary)}`,
        `Rationale: ${escapeTerminalText(match.proposal.rationale)}`,
        `Expected outcome: ${escapeTerminalText(match.proposal.expectedOutcome)}`,
        `Full digest: ${match.digest}`,
        `Cited chain position: ${match.atSeq}.`,
        "",
        "Full proposal:",
        ...proposalLines,
        "",
        "This changes no policy, permissions, tool catalog, or credentials.",
      ],
      apply: async () => {
        this.confirmation = undefined;
        if (decision === "approve") {
          const result = await this.workbench.approveHarnessProposal(
            sessionId,
            match.digest,
          );
          this.notice = `Harness proposal approved: ${result.applied.length} edit(s) activated.`;
          this.detail = [
            "HARNESS PROPOSAL ACTIVATED",
            `Digest: ${match.digest}`,
            `Summary: ${escapeTerminalText(match.summary)}`,
            "The signed chain records the approval and activation.",
          ];
        } else {
          await this.workbench.rejectHarnessProposal(sessionId, match.digest);
          this.notice = `Harness proposal rejected: ${match.digest.slice(0, 8)}.`;
          this.detail = [
            "HARNESS PROPOSAL REJECTED",
            `Digest: ${match.digest}`,
            `Summary: ${escapeTerminalText(match.summary)}`,
            "The signed chain records the rejection. No edit was activated.",
          ];
        }
        await this.refresh(true);
      },
    };
    this.scroll = 0;
  }
  costLines() {
    const usage = activity(this.workbench.allViews());
    const lines = [
      "COST AND USAGE, provider reported, never estimated",
      "",
      `Sessions: ${usage.overview.sessions} | Runs: ${usage.overview.runs} | ` +
        `Records: ${usage.overview.usageRecords}`,
      `Total tokens: ${usage.overview.totalTokens ?? "unknown"} | Cost: unknown`,
      "",
    ];
    // The shape of the spend is the first thing an operator wants and a table
    // of twenty rows buries it. The sparkline reads from the data rather than
    // from zero, because a series that tripled still looks flat on a zero
    // baseline, and "flat" would be the wrong conclusion to draw from it.
    const recent = usage.usage.slice(-24);
    const totals = recent
      .map((record) => record.totalTokens)
      .filter((value): value is number => typeof value === "number");
    if (totals.length > 1) {
      const sparkLabel =
        this.layoutColumns >= 30 ? "tokens per run  " : "tok/run ";
      const sparkWidth = Math.max(
        0,
        this.layoutColumns - visibleLength(sparkLabel),
      );
      lines.push(
        `${sparkLabel}${sparkline({ values: totals }, sparkWidth)}`,
        "  sparkline scaled to the series, not to zero",
        "",
      );
    }
    if (totals.length)
      lines.push(
        `peak ${Math.max(...totals)} tok / median ${median(totals)} tok`,
        // How the latest run compares with the one before it. The direction
        // is a word as well as a glyph, because an arrow is the only signal
        // for anyone who cannot see it.
        `latest vs previous  ${deltaLabel(
          totals[totals.length - 1] ?? 0,
          totals[totals.length - 2] ?? 0,
          { suffix: " tok" },
        )}`,
        "",
      );
    // A bar per run, newest first, because the most recent run is the one an
    // operator looks at. The number sits before the bar so a narrow terminal
    // truncates the fill rather than the measurement.
    if (totals.length > 1)
      lines.push(
        ...barChart(
          { values: totals.slice(-10) },
          Math.max(1, this.layoutColumns - 2),
        ).map((row) => "  " + row),
        "",
      );
    // Context pressure as a gauge, but only against a declared ceiling. A
    // gauge drawn against an invented maximum would report pressure where
    // the only honest answer is that no limit was declared.
    const context = this.contextNumbers();
    const limit = context.contextTokens;
    const used = context.contextUsed;
    if (typeof limit === "number" && limit > 0 && typeof used === "number")
      lines.push(
        `context  ${gauge(used, limit, { label: `${used} / ${limit}` })}`,
        "",
      );
    for (const record of recent.slice(-20))
      lines.push(
        `${record.sessionId.slice(0, 8)} ${record.model} ` +
          `in ${record.inputTokens ?? "?"} out ${record.outputTokens ?? "?"} ` +
          `total ${record.totalTokens ?? "unknown"}`,
      );
    if (!usage.usage.length)
      lines.push("No usage records yet. Send a prompt first.");
    return lines;
  }
  /**
   * The provider as one line, for the panes that have other things to say.
   *
   * The provider is one line here; /status owns the full inspector.
   */
  providerSummary(): string {
    const provider = this.provider;
    const status = String(provider?.status ?? "unavailable");
    return `${providerStatusIcon(status)} Provider ${provider?.providerId ?? "unknown"} | ${status}`;
  }
  providerLines() {
    const provider = this.provider;
    // The provider is the single most common source of a run that silently
    // does nothing, and it used to be one loose line of text in a column of
    // many. As fields it is the thing an operator looks for by name, and the
    // status carries a tone rather than only a word.
    const status = String(provider?.status ?? "unavailable");
    const tone =
      status === "ready"
        ? "success"
        : status === "rate-limited"
          ? "warning"
          : status === "setup-required"
            ? "warning"
            : "error";
    return [
      ...renderInspector(
        {
          title: provider?.providerId ?? "unknown provider",
          subtitle: status,
          icon:
            tone === "success"
              ? ROW_ICONS.settled
              : tone === "error"
                ? ROW_ICONS.failed
                : ROW_ICONS.unknown,
          sections: [
            {
              title: "provider",
              fields: [
                {
                  label: "status",
                  value: status,
                  // Colour is decoration: the word says the same thing on a
                  // monochrome terminal and to a screen reader.
                  tone,
                },
                {
                  label: "model",
                  value: this.session()?.model || this.model || "not selected",
                },
                ...(provider?.retryAt
                  ? [{ label: "retry at", value: provider.retryAt }]
                  : []),
              ],
              body: provider?.detail ? [provider.detail] : [],
            },
            ...(provider?.status === "setup-required"
              ? [
                  {
                    title: "what to do",
                    fields: [] as const,
                    body: [
                      "/connect shows credential setup.",
                      "Never type a key into the terminal.",
                    ],
                  },
                ]
              : []),
          ],
        },
        { width: this.layoutColumns },
      ),
    ];
  }
  statusLines() {
    const session = this.session();
    const usage = chatEventSummary(session?.events ?? []).usage;
    const tokens =
      typeof usage?.total_tokens === "number"
        ? String(usage.total_tokens)
        : "?";
    const cost =
      typeof usage?.cost === "number" ? `$${usage.cost.toFixed(4)}` : "?";
    const runs = this.workbench
      .runs()
      .filter((run) => run.sessionId === this.sessionId);
    const run =
      runs.find((item) => item.runId === session?.runId) ?? runs.at(-1);
    return [
      ...this.providerLines(),
      `Model: ${session?.model || this.model || "-"}`,
      `Usage: ${tokens} tokens | cost: ${cost}`,
      `State: ${run?.state ?? "unknown"}${run?.reconcileRequired ? " | reconciliation required" : ""}`,
      `Run: ${run?.state ?? "unavailable"}${run?.reconcileRequired ? " | reconciliation required" : ""}`,
      session ? "" : "No conversation selected.",
      `Conversations: ${this.workbench.list().length} | ` +
        `Pending: ${this.workbench.pending().length + this.proxy.holds.length}`,
      this.queuedPrompt
        ? this.queuedPromptPaused
          ? "One prompt is paused after recovery. Inspect /queue before resuming."
          : "One prompt is queued for the end of the run."
        : "No queued prompt.",
    ];
  }
  agentsLines() {
    const catalog = this.workbench.agents();
    const rows = [...this.workbench.list()].reverse();
    // An agent profile is a set of limits, and an operator checking one is
    // reading numbers, not prose. The system prompt stays last and bounded,
    // because it is the one field that is text rather than a limit.
    return [
      ...renderInspector(
        {
          title: "AGENTS",
          subtitle: `selected: ${this.agentId ?? "runtime default"}`,
          icon: ROW_ICONS.agent,
          sections: [
            {
              title: "runtime catalog",
              fields: catalog.agents.map((agent) => ({
                label: agent.id,
                value: agent.description,
                badge: agent.id === this.agentId ? "selected" : undefined,
                tone: agent.id === this.agentId ? "success" : "default",
              })),
            },
            {
              title: "profiles and their limits",
              fields: catalog.profiles.flatMap((profile) => [
                { label: profile.id, value: `policy ${profile.policyProfile}` },
                {
                  label: `  max turns`,
                  value: String(profile.maxTurns),
                },
                {
                  label: `  max context`,
                  value: `${profile.maxContextTokens} tokens`,
                },
                {
                  label: `  tools`,
                  value: profile.allowedTools.join(", ") || "none",
                  tone: profile.allowedTools.length ? "default" : "warning",
                },
              ]),
            },
            {
              title: "available policy profiles",
              fields: [
                {
                  label: "profiles",
                  value: catalog.policyProfiles.join(", ") || "none",
                },
              ],
            },
            {
              // The prompt is the one field that is text rather than a limit,
              // and this view names it as saveable, so not printing it left
              // the operator unable to check what a profile actually says to
              // the model. Bounded because a prompt is prose, and the marker
              // says it was cut rather than letting a truncated prompt read
              // as the whole one.
              title: "system prompts",
              fields: catalog.profiles.map((profile) => {
                const prompt = profile.systemPrompt.trim();
                return {
                  // The label keeps the field's own name. This view tells the
                  // operator that systemPrompt is saveable, so the row has to
                  // be findable by that word and not only by the profile id.
                  label: `System prompt / ${profile.id}`,
                  value: !prompt
                    ? "(empty)"
                    : prompt.length > 160
                      ? `${prompt.slice(0, 160)}… (+${prompt.length - 160} chars)`
                      : prompt,
                  tone: prompt ? ("default" as const) : ("warning" as const),
                };
              }),
            },
          ],
          hint: "/agent ID selects. Existing conversations keep their own snapshot.",
        },
        { width: this.layoutColumns },
      ),
      "",
      "Prompt text does not grant tool or policy authority.",
      "/agent-file path.json reviews a custom profile before saving.",
      "File fields: id, name, systemPrompt, allowedTools, policyProfile, maxTurns, maxContextTokens.",
      "",
      "CONVERSATIONS",
      ...(rows.length
        ? rows.map(
            (item) =>
              `${stateIcon(item.status)} [${item.status}] ${item.title ?? item.id} ${item.id.slice(0, 8)} ${item.model}${item.parentId ? ` [child of ${item.parentId.slice(0, 8)}]` : ""}`,
          )
        : ["No conversations yet."]),
      "",
      ...this.workbench
        .connectionState()
        .connectors.map(
          (item) =>
            `${ROW_ICONS.connector} connector: ${item.name} (${item.tools.length} tools)`,
        ),
    ];
  }
  memoryLines() {
    const views = this.workbench.allViews();
    const events = views.reduce((sum, item) => sum + item.events.length, 0);
    const drafts = this.workbench.documentsList().length;
    // This view listed two totals and four sentences. An operator opening it
    // wants to know what they have and where it is, so both are now said
    // plainly and the per-conversation breakdown follows.
    const byConversation = views
      .map((view) => ({ view, count: view.events.length }))
      .sort((a, b) => b.count - a.count);
    return [
      ...renderInspector(
        {
          title: "MEMORY",
          subtitle: "retained local history, encrypted at rest",
          icon: ROW_ICONS.learned,
          sections: [
            {
              title: "what is stored",
              fields: [
                { label: "conversations", value: String(views.length) },
                { label: "events", value: String(events) },
                { label: "managed documents", value: String(drafts) },
                {
                  label: "location",
                  value: this.env.NOMO_DATA_DIR ?? "~/.nomo/workbench",
                  tone: this.env.NOMO_DATA_DIR ? "default" : "warning",
                },
              ],
            },
            {
              title: "what is kept",
              fields: [],
              body: [
                "Drafts persist per conversation between runs.",
                "Conversations retain their provider and model snapshot.",
                "Unreported cost stays unknown rather than being estimated.",
                "Nothing is read from private cloud conversations.",
              ],
            },
          ],
        },
        { width: this.layoutColumns },
      ),
      "",
      "LARGEST CONVERSATIONS",
      ...(byConversation.length
        ? byConversation
            .slice(0, 10)
            .map(
              ({ view, count }) =>
                `  ${ROW_ICONS.session} ${view.id.slice(0, 8)} ${String(count).padStart(4)} events  ${view.status}`,
            )
        : ["  No conversations yet."]),
    ];
  }
  settingsControls(): SettingsControl[] {
    const icons = getSymbols(this.themeConfig.symbolPreset).icons;
    const limits = harnessSettingsView(this.workbench.harnessSettings());
    const appearance: SettingsControl[] = [
      {
        key: "terminal.color",
        group: "Appearance",
        label: "Terminal color",
        icon: icons.appearance,
        value:
          this.colorOverride === undefined
            ? this.env.NOMO_TUI_COLOR === "0"
              ? "off"
              : "on"
            : this.colorOverride
              ? "on"
              : "off",
        options: ["on", "off"],
        description:
          "Use terminal color when supported. NOMO_TUI_COLOR=0 overrides the saved preference and suppresses color.",
      },
      {
        key: "terminal.motion",
        group: "Appearance",
        label: "Motion effects",
        icon: icons.heartbeat,
        value:
          this.motionOverride === undefined
            ? this.env.NOMO_TUI_MOTION === "0" || this.env.TERM === "dumb"
              ? "off"
              : "on"
            : this.motionOverride
              ? "on"
              : "off",
        options: ["on", "off"],
        description:
          "Enable subtle motion effects. NOMO_TUI_MOTION=0 overrides the saved preference.",
      },
      {
        key: "theme.color",
        group: "Appearance",
        label: "Color theme",
        icon: icons.appearance,
        value: this.themeConfig.colorTheme,
        options: Object.keys(COLOR_THEMES),
        description:
          "Terminal foreground palette. Saved locally; NOMO_TUI_THEME overrides it. The terminal background stays inherited.",
      },
      {
        key: "theme.symbols",
        group: "Appearance",
        label: "Symbol set",
        icon: icons.appearance,
        value: this.themeConfig.symbolPreset,
        options: Object.keys(SYMBOL_SETS),
        description:
          "Semantic TUI glyphs. Saved locally; NOMO_TUI_SYMBOLS overrides it. Nerd needs a compatible patched font.",
      },
      {
        key: "chat.density",
        group: "Appearance",
        label: "Chat spacing",
        icon: icons.context,
        value: this.chatPanelVisuals.density,
        options: ["comfortable", "compact"],
        description:
          "Choose spacing between transcript messages. Saved locally; NOMO_TUI_CHAT_DENSITY overrides it.",
      },
      {
        key: "chat.timestamps",
        group: "Appearance",
        label: "Message timestamps",
        icon: icons.time,
        value: this.chatPanelVisuals.timestamps ? "on" : "off",
        options: ["off", "on"],
        description:
          "Show or hide message timestamps. Saved locally; NOMO_TUI_CHAT_TIMESTAMPS overrides it.",
      },
      {
        key: "chat.composerHeightPx",
        group: "Appearance",
        label: "Composer height",
        icon: icons.composer,
        value: `${this.chatPanelVisuals.composerHeightPx} px`,
        number: this.chatPanelVisuals.composerHeightPx,
        min: MIN_CHAT_COMPOSER_HEIGHT_PX,
        max: MAX_CHAT_COMPOSER_HEIGHT_PX,
        description:
          "Maximum draft height in pixels. Converted to rows using the terminal cell height (24 px fallback). Saved locally; NOMO_TUI_CHAT_COMPOSER_HEIGHT_PX overrides it.",
      },
      {
        key: "tool.activity",
        group: "Appearance",
        label: "Tool activity",
        icon: icons.tool,
        value: this.hideToolActivity ? "hidden" : "visible",
        options: ["visible", "hidden"],
        description:
          "Show tool activity in the Chat transcript. Saved in local TUI state; Ctrl+Shift+O also toggles it.",
      },
    ];
    const interaction: SettingsControl[] = [
      {
        key: "terminal.keybindings",
        group: "Interaction",
        label: "Workspace shortcuts",
        icon: icons.key,
        value: this.keybindingsOverride || "built-in defaults",
        description:
          "JSON object mapping supported actions to Ctrl+letter shortcuts. Blank restores defaults. Reserved and duplicate keys are rejected. Saved locally; NOMO_TUI_KEYBINDINGS overrides it.",
        text: true,
        maxLength: 512,
      },
    ];
    const harnessIconBySetting: Record<string, keyof typeof icons> = {
      maxTurns: "run",
      maxOutputTokens: "tokens",
      maxPromptCharacters: "composer",
      maxQueuedRuns: "queue",
      maxRequestBytes: "network",
      maxRunTimeoutMs: "time",
      maxToolCallsPerTurn: "tool",
      hookTimeoutMs: "hook",
      retryAttempts: "retry",
      retryBaseDelayMs: "retry",
      maxConcurrentRuns: "agent",
      maxContinuations: "run",
      maxRunTokens: "tokens",
      retryMaxDelayMs: "retry",
      contextEntryLimit: "context",
      contextCharsPerEntry: "context",
      refinementEnabled: "refinement",
      refinementTurnInterval: "refinement",
      refinementCooldownMs: "time",
      refinementLensCount: "refinement",
    };
    const runtime: SettingsControl[] = limits.map((row) => ({
      key: row.key,
      group: "Harness",
      label: row.label,
      icon: icons[harnessIconBySetting[row.key] ?? "settings"],
      value:
        row.key === "refinementEnabled"
          ? row.value
            ? "on"
            : "off"
          : String(row.value),
      description: `${row.description} Consumer: ${row.consumer}.`,
      ...(row.key === "refinementEnabled"
        ? { options: ["off", "on"] }
        : { number: row.value, min: row.min, max: row.max }),
    }));
    const selections: SettingsControl[] = harnessTextSettingsView(
      this.workbench.harnessTextSettings(),
    ).map((row) => ({
      key: row.key,
      group: row.key === "refinementModel" ? "Models and Providers" : "Harness",
      label: row.label,
      icon: icons.model,
      value: row.value || "inherit conversation model",
      description: `${row.description} Consumer: ${row.consumer}.`,
      text: true,
      maxLength: HARNESS_TEXT_SETTINGS[row.key].maxLength,
    }));
    return [...appearance, ...interaction, ...runtime, ...selections];
  }
  visibleSettingsControls(): SettingsControl[] {
    const controls = this.settingsControls();
    const query = this.settingsQuery.trim();
    if (!query) return controls;
    return controls.filter(
      (control) =>
        fuzzyTextScore(query, [
          control.group,
          control.label,
          control.key,
          control.description,
        ]) !== undefined,
    );
  }
  settingsTextValue(key: string): string {
    if (key === "terminal.keybindings") return this.keybindingsOverride ?? "";
    if (key === "refinementModel")
      return this.workbench.harnessTextSettings().refinementModel;
    return "";
  }
  settingsLines() {
    const controls = this.visibleSettingsControls();
    const symbols = getSymbols(this.themeConfig.symbolPreset);
    const icons = symbols.icons;
    const width = Math.max(1, this.layoutColumns);
    const trustedIcons = trustedLocalIconLabels(
      this.localTabIcons,
      this.themeConfig.colorTheme,
    );
    const fitSettingLine = (value: string, limit = width) =>
      fitWithTrustedIcons(value, limit, trustedIcons);
    const iconoir = (key: string, fallback: string) => {
      if (!this.localTabIcons || width < 48) return fallback;
      return (
        kittySemanticIconLabel(
          key,
          this.localTabIcons,
          this.themeConfig.colorTheme,
        ) ||
        (key === "models" || key === "tools" || key === "help"
          ? kittyTabIconLabel(
              key,
              this.localTabIcons,
              this.themeConfig.colorTheme,
            )
          : "") ||
        fallback
      );
    };
    const iconBySetting: Readonly<Record<string, string>> = {
      "terminal.color": "appearance",
      "terminal.motion": "heartbeats",
      "theme.color": "appearance",
      "theme.symbols": "appearance",
      "chat.density": "composer",
      "chat.timestamps": "timestamps",
      "chat.composerHeightPx": "composer",
      "tool.activity": "tools",
      "terminal.keybindings": "interaction",
      maxTurns: "run",
      maxOutputTokens: "context",
      maxPromptCharacters: "composer",
      maxQueuedRuns: "queue",
      maxRequestBytes: "network",
      maxRunTimeoutMs: "timeout",
      maxToolCallsPerTurn: "tools",
      hookTimeoutMs: "timeout",
      retryAttempts: "retry",
      retryBaseDelayMs: "retry",
      maxConcurrentRuns: "subagents",
      maxContinuations: "run",
      maxRunTokens: "context",
      retryMaxDelayMs: "retry",
      contextEntryLimit: "context",
      contextCharsPerEntry: "context",
      refinementEnabled: "refinement",
      refinementTurnInterval: "refinement",
      refinementCooldownMs: "timeout",
      refinementLensCount: "refinement",
      refinementModel: "models",
    };
    const selected = controls[this.settingsSelected] ?? controls[0];
    const groupIcons: Record<SettingsControl["group"], string> = {
      Appearance: iconoir("appearance", icons.appearance),
      Interaction: iconoir("interaction", icons.key),
      "Models and Providers": iconoir("models", icons.model),
      Harness: iconoir("subagents", icons.agent),
    };
    const groupCounts = new Map<SettingsControl["group"], number>();
    for (const control of controls)
      groupCounts.set(control.group, (groupCounts.get(control.group) ?? 0) + 1);
    const activeGroup = selected?.group;
    const settingsCategoryRail = activeGroup
      ? width >= 80
        ? (
            [
              "Appearance",
              "Interaction",
              "Models and Providers",
              "Harness",
            ] as const
          )
            .map((group) => {
              const label =
                width >= 112
                  ? group.toUpperCase()
                  : group === "Appearance"
                    ? "VISUALS"
                    : group === "Interaction"
                      ? "INPUT"
                      : group === "Models and Providers"
                        ? "MODELS"
                        : "LIMITS";
              return `${activeGroup === group ? "›" : " "} ${groupIcons[group]} ${label} ${groupCounts.get(group) ?? 0}`;
            })
            .join("  ·  ")
        : `${groupIcons[activeGroup]} ${activeGroup.toUpperCase()} · ${groupCounts.get(activeGroup) ?? 0} settings`
      : "No settings match this filter.";
    const selectedDescription = selected
      ? `${iconoir("help", icons.help)} ${selected.description}${
          selected.number !== undefined
            ? ` Range: ${selected.min}–${selected.max}; use ←/→ or Enter to edit.`
            : selected.text
              ? selected.key === "terminal.keybindings"
                ? ` Maximum ${selected.maxLength} characters; Enter saves valid JSON, or leave empty for built-in shortcuts.`
                : ` Maximum ${selected.maxLength} characters; Enter saves, or leave empty to inherit the conversation model.`
              : ""
        }`
      : "";
    // Settings rows keep one physical line at every terminal width. Details
    // are clipped in-place instead of wrapping into the next control row.
    const selectedDescriptionLines = selected
      ? [fitSettingLine(selectedDescription)]
      : [""];
    const actionHelp =
      width >= 80
        ? "↑/↓ select · ←/→ change · Enter edit/save · Space apply · type filter · Esc clear/back"
        : width >= 64
          ? "↑/↓ select · ←/→ change · Enter/Space apply · type filter"
          : width >= 48
            ? "↑↓ select · ←→ set · Enter/Space apply"
            : width >= 32
              ? "↑↓ move · ←→ set · Enter/Space"
              : "↑↓ move · Enter apply";
    const navigationHelp = this.settingsQuery
      ? width >= 80
        ? "Ctrl+←/→ filter cursor · Home/End select · PgUp/PgDn · click · double-click apply · wheel · Esc clear"
        : width >= 64
          ? "Ctrl+←/→ filter cursor · Esc clears filter"
          : width >= 48
            ? "Ctrl←/→ filter cursor · Esc clears filter"
            : "Ctrl←/→ cursor · Esc clear"
      : width >= 80
        ? "Ctrl+←/→ groups · Home/End · PgUp/PgDn · click select · double-click apply · wheel"
        : width >= 64
          ? "Ctrl+←/→ groups · Home/End · PgUp/PgDn · wheel"
          : width >= 48
            ? "Type filter · Esc back · Ctrl+←/→ groups"
            : width >= 32
              ? "Type · Esc · Ctrl←/→ groups"
              : "←→ set · Esc filter";
    this.settingsRowLines = [];
    const lines = [
      fitSettingLine(
        `${iconoir("settings", icons.settings)} SETTINGS · ${controls.length ? this.settingsSelected + 1 : 0}/${controls.length} · ${selected?.group.toUpperCase() ?? "NO MATCHES"}`,
      ),
      fitSettingLine(settingsCategoryRail),
      fitSettingLine(
        `${iconoir("search", icons.search)} ${
          this.settingsQuery
            ? settingsCursorWindow(
                this.settingsQuery,
                this.settingsQueryCursor,
                Math.max(
                  1,
                  width - visibleLength(iconoir("search", icons.search)) - 1,
                ),
              )
            : "> Type to filter settings…"
        }`,
      ),
      fitSettingLine(actionHelp),
      fitSettingLine(navigationHelp),
      ...(selected ? [] : [fitSettingLine("No settings match this filter.")]),
      ...selectedDescriptionLines,
    ];
    for (const [index, control] of controls.entries()) {
      if (index === 0 || control.group !== controls[index - 1]!.group)
        lines.push(
          ...(index > 0 ? [""] : []),
          fitSettingLine(
            `${groupIcons[control.group]} ${control.group.toUpperCase()} · ${groupCounts.get(control.group) ?? 0}`,
          ),
        );
      // Keep the focus marker independent of the optional Nerd Font preset.
      // A private-use glyph can disappear on terminals without that font.
      const prefix = `${index === this.settingsSelected ? ">" : " "} ${iconoir(iconBySetting[control.key] ?? "", control.icon)} `;
      const edit =
        this.settingsEdit?.key === control.key ? this.settingsEdit : undefined;
      const shownValue = edit
        ? `${this.settingsEdit!.draft.slice(0, this.settingsEdit!.cursor)}▏${this.settingsEdit!.draft.slice(this.settingsEdit!.cursor)}`
        : control.value;
      const value = control.options
        ? `‹ ${shownValue} ›`
        : edit
          ? `[${shownValue}]`
          : `= ${control.value}`;
      this.settingsRowLines.push(lines.length);
      if (width < 48) {
        const compactValue =
          edit && control.text
            ? `[${settingsCursorWindow(
                edit.draft,
                edit.cursor,
                Math.max(1, Math.floor((width - visibleLength(prefix)) / 3)),
              )}]`
            : edit
              ? shownValue
              : control.value;
        const remainingWidth = Math.max(1, width - visibleLength(prefix));
        const separatorWidth = remainingWidth > 1 ? 1 : 0;
        const labelWidth = Math.min(
          visibleLength(control.label),
          Math.max(
            1,
            Math.min(
              remainingWidth - separatorWidth,
              Math.ceil((remainingWidth - separatorWidth) * 0.62),
            ),
          ),
        );
        const valueWidth = Math.max(
          0,
          remainingWidth - labelWidth - separatorWidth,
        );
        lines.push(
          fitSettingLine(
            `${prefix}${fit(control.label, labelWidth)}${
              valueWidth
                ? `${separatorWidth ? " " : ""}${fit(compactValue, valueWidth)}`
                : ""
            }`,
          ),
        );
      } else if (edit && control.text) {
        const labelWidth = Math.min(
          visibleLength(control.label),
          Math.max(1, Math.floor((width - visibleLength(prefix)) / 3)),
        );
        const editorWidth = Math.max(
          1,
          width - visibleLength(prefix) - labelWidth - 3,
        );
        lines.push(
          fitSettingLine(
            `${prefix}${fit(control.label, labelWidth)} [${settingsCursorWindow(edit.draft, edit.cursor, editorWidth)}]`,
          ),
        );
      } else {
        const labelWidth = Math.max(
          1,
          width - visibleLength(prefix) - visibleLength(value) - 1,
        );
        lines.push(
          fitSettingLine(`${prefix}${fit(control.label, labelWidth)} ${value}`),
        );
      }
    }
    lines.push(
      "",
      "Appearance and shortcut choices save locally; explicit NOMO_TUI_* values override them.",
      "Tool visibility saves in local TUI state. Harness settings save in the local Workbench store.",
    );
    return lines;
  }
  refreshSettingsPanel() {
    this.settingsOpen = true;
    this.settingsSelected = Math.max(
      0,
      Math.min(
        this.settingsSelected,
        this.visibleSettingsControls().length - 1,
      ),
    );
    this.detail = this.settingsLines();
  }
  selectSetting(index: number) {
    const controls = this.visibleSettingsControls();
    if (!controls.length) {
      this.settingsSelected = 0;
      this.detail = this.settingsLines();
      return;
    }
    const next = Math.max(0, Math.min(controls.length - 1, index));
    if (next !== this.settingsSelected && this.settingsEdit) {
      this.settingsEdit = undefined;
      this.notice = "Setting edit cancelled.";
    }
    this.settingsSelected = next;
    this.hoveredRow = undefined;
    this.detail = this.settingsLines();
    const line = this.settingsRowLines[this.settingsSelected] ?? 0;
    const height = Math.max(1, this.viewport.height);
    if (line < this.scroll) this.scroll = line;
    else if (line >= this.scroll + height) this.scroll = line - height + 1;
  }
  applySetting(key: string, raw: string) {
    const value = raw.toLowerCase();
    if (key === "terminal.color") {
      if (value !== "on" && value !== "off")
        throw Error("Terminal color accepts on or off.");
      this.colorOverride = value === "on";
      this.notice =
        value === "off"
          ? "Terminal color is off and saved locally. An explicit NOMO_TUI_COLOR value overrides it on the next launch."
          : "Terminal color is on and saved locally. An explicit NOMO_TUI_COLOR value overrides it on the next launch.";
    } else if (key === "terminal.motion") {
      if (value !== "on" && value !== "off")
        throw Error("Motion effects accept on or off.");
      this.motionOverride = value === "on";
      this.notice =
        value === "off"
          ? "Motion effects are off and saved locally. NOMO_TUI_MOTION=0 overrides them on the next launch."
          : "Motion effects are on and saved locally. NOMO_TUI_MOTION=0 overrides them on the next launch.";
    } else if (key === "theme.color") {
      if (!Object.hasOwn(COLOR_THEMES, value))
        throw Error(`Unknown color theme: ${raw}.`);
      this.themeConfig = {
        ...this.themeConfig,
        colorTheme: value as ColorTheme,
      };
      this.notice = `Color theme ${value} saved locally. NOMO_TUI_THEME overrides it on the next launch.`;
    } else if (key === "theme.symbols") {
      if (!Object.hasOwn(SYMBOL_SETS, value))
        throw Error(`Unknown symbol set: ${raw}.`);
      this.themeConfig = {
        ...this.themeConfig,
        symbolPreset: value as SymbolPreset,
      };
      this.notice = `Symbol set ${value} saved locally. NOMO_TUI_SYMBOLS overrides it on the next launch.`;
    } else if (key === "chat.frame") {
      throw Error("The composer is now borderless. Use chat.density to change spacing.");
    } else if (key === "chat.density") {
      if (!(value === "comfortable" || value === "compact"))
        throw Error("Chat spacing accepts comfortable or compact.");
      this.chatPanelVisuals = { ...this.chatPanelVisuals, density: value };
      this.notice = `Chat spacing ${value} saved locally. NOMO_TUI_CHAT_DENSITY overrides it on the next launch.`;
    } else if (key === "chat.timestamps") {
      if (!(value === "on" || value === "off"))
        throw Error("Message timestamps accept on or off.");
      this.chatPanelVisuals = {
        ...this.chatPanelVisuals,
        timestamps: value === "on",
      };
      this.notice = `Message timestamps ${value} saved locally. NOMO_TUI_CHAT_TIMESTAMPS overrides them on the next launch.`;
    } else if (key === "chat.composerHeightPx") {
      const height = Number(raw);
      if (
        !Number.isSafeInteger(height) ||
        height < MIN_CHAT_COMPOSER_HEIGHT_PX ||
        height > MAX_CHAT_COMPOSER_HEIGHT_PX
      )
        throw Error(
          `Composer height must be a whole number from ${MIN_CHAT_COMPOSER_HEIGHT_PX} to ${MAX_CHAT_COMPOSER_HEIGHT_PX} pixels.`,
        );
      this.chatPanelVisuals = {
        ...this.chatPanelVisuals,
        composerHeightPx: height,
      };
      this.notice = `Composer height ${height} px saved locally. NOMO_TUI_CHAT_COMPOSER_HEIGHT_PX overrides it on the next launch.`;
    } else if (key === "tool.activity") {
      if (!(value === "visible" || value === "hidden"))
        throw Error("Tool activity accepts visible or hidden.");
      this.hideToolActivity = value === "hidden";
      this.notice = `Tool activity is now ${value}.`;
    } else if (key === "terminal.keybindings") {
      const candidate = raw.trim();
      const parsed = parseWorkspaceKeybindings(candidate || undefined);
      if (parsed.error)
        throw Error(
          parsed.error.replace(/^NOMO_TUI_KEYBINDINGS ignored: /, ""),
        );
      this.keybindingsOverride = candidate || undefined;
      this.notice = candidate
        ? "Workspace shortcuts saved locally and applied. NOMO_TUI_KEYBINDINGS overrides them on the next launch."
        : "Built-in workspace shortcuts restored and saved locally.";
    } else if (Object.hasOwn(HARNESS_TEXT_SETTINGS, key)) {
      const stored = this.workbench.patchHarnessTextSettings({ [key]: raw });
      const applied = harnessTextSettingsView(stored).find(
        (row) => row.key === key,
      );
      this.notice = `${applied?.label ?? key} is now ${applied?.value || "inherited from the conversation"}.`;
    } else if (key === "refinementEnabled") {
      if (!(
        value === "on" ||
        value === "off" ||
        value === "1" ||
        value === "0"
      ))
        throw Error("Harness refinement accepts on or off.");
      const stored = this.workbench.patchHarnessSettings({
        refinementEnabled: value === "on" || value === "1" ? 1 : 0,
      });
      const applied = harnessSettingsView(stored).find(
        (row) => row.key === key,
      );
      this.notice = `${applied?.label ?? key} is now ${stored.refinementEnabled ? "on" : "off"}.`;
    } else {
      if (!Object.hasOwn(HARNESS_SETTINGS, key))
        throw Error(
          `Unknown setting: ${key}. Use /settings to browse supported values.`,
        );
      const numeric = Number(raw);
      if (!Number.isFinite(numeric))
        throw Error(`/settings ${key}: ${raw} is not a number.`);
      const stored = this.workbench.patchHarnessSettings({ [key]: numeric });
      const applied = harnessSettingsView(stored).find(
        (row) => row.key === key,
      );
      this.notice = `${applied?.label ?? key} is now ${applied?.value ?? numeric}.`;
    }
    this.refreshSettingsPanel();
  }
  adjustSetting(direction: -1 | 1, multiplier = 1) {
    const control = this.visibleSettingsControls()[this.settingsSelected];
    if (!control) return;
    if (control.options?.length) {
      const index = control.options.indexOf(control.value);
      const next =
        (index + direction + control.options.length) % control.options.length;
      this.applySetting(control.key, control.options[next]!);
      return;
    }
    if (control.text) {
      const value = this.settingsTextValue(control.key);
      this.settingsEdit = {
        key: control.key,
        draft: value,
        cursor: value.length,
      };
      this.detail = this.settingsLines();
      this.notice = `Edit ${control.label}; Enter saves, Esc cancels.`;
      return;
    }
    if (
      control.number === undefined ||
      control.min === undefined ||
      control.max === undefined
    )
      return;
    if (control.min === control.max) {
      this.notice = `${control.label} is fixed at ${control.value} by the active run contract.`;
      return;
    }
    const span = control.max - control.min;
    const step =
      span >= 100_000 ? 1_000 : span >= 10_000 ? 100 : span >= 1_000 ? 10 : 1;
    const next = Math.max(
      control.min,
      Math.min(control.max, control.number + direction * step * multiplier),
    );
    this.applySetting(control.key, String(next));
  }
  activateSetting() {
    const control = this.visibleSettingsControls()[this.settingsSelected];
    if (!control) return;
    if (control.options?.length) {
      this.adjustSetting(1);
      return;
    }
    if (control.text) {
      const value = this.settingsTextValue(control.key);
      this.settingsEdit = {
        key: control.key,
        draft: value,
        cursor: value.length,
      };
      this.detail = this.settingsLines();
      this.notice = `Edit ${control.label}; Enter saves, Esc cancels.`;
      return;
    }
    if (
      control.number === undefined ||
      control.min === undefined ||
      control.max === undefined
    )
      return;
    if (control.min === control.max) {
      this.notice = `${control.label} is fixed at ${control.value} by the active run contract.`;
      return;
    }
    this.settingsEdit = {
      key: control.key,
      draft: String(control.number),
      cursor: String(control.number).length,
    };
    this.detail = this.settingsLines();
    this.notice = `Edit ${control.label}; Enter saves, Esc cancels.`;
  }
  insertSettingsText(text: string) {
    const edit = this.settingsEdit;
    if (!edit) {
      const inserted = sanitizeText(stripAnsi(text).replace(/[\r\n\t]+/g, " "));
      const points = [...this.settingsQuery];
      const remaining = Math.max(0, 80 - points.length);
      const next = [...inserted].slice(0, remaining);
      if (!next.length) return;
      points.splice(this.settingsQueryCursor, 0, ...next);
      this.settingsQuery = points.join("");
      this.settingsQueryCursor += next.length;
      this.settingsSelected = 0;
      this.scroll = 0;
      this.detail = this.settingsLines();
      return;
    }
    const control = this.settingsControls().find((row) => row.key === edit.key);
    const maxLength = control?.maxLength ?? 12;
    const available = Math.max(0, maxLength - edit.draft.length);
    const allowedText =
      control?.key === "terminal.keybindings"
        ? /[^\x20-\x7e]/g
        : /[^A-Za-z0-9._:@/-]/g;
    const inserted = sanitizeText(text)
      .replace(control?.text ? allowedText : /[^0-9]/g, "")
      .slice(0, available);
    if (!inserted) return;
    const before = edit.draft.slice(0, edit.cursor);
    const after = edit.draft.slice(edit.cursor);
    this.settingsEdit = {
      ...edit,
      draft: `${before}${inserted}${after}`,
      cursor: edit.cursor + inserted.length,
    };
    this.detail = this.settingsLines();
  }
  handleSettingsKey(
    value: string | undefined,
    key: { name?: string; ctrl?: boolean; meta?: boolean },
  ) {
    if (!this.settingsOpen) return false;
    if (key.ctrl && ["c", "d"].includes(key.name ?? "")) return false;
    const edit = this.settingsEdit;
    if (edit) {
      const control = this.settingsControls().find(
        (row) => row.key === edit.key,
      );
      if (key.name === "escape") {
        this.settingsEdit = undefined;
        this.notice = "Setting edit cancelled.";
      } else if (key.ctrl && key.name === "a") {
        this.settingsEdit = { ...edit, draft: "", cursor: 0 };
      } else if (key.name === "left") {
        this.settingsEdit = { ...edit, cursor: Math.max(0, edit.cursor - 1) };
      } else if (key.name === "right") {
        this.settingsEdit = {
          ...edit,
          cursor: Math.min(edit.draft.length, edit.cursor + 1),
        };
      } else if (key.name === "home") {
        this.settingsEdit = { ...edit, cursor: 0 };
      } else if (key.name === "end") {
        this.settingsEdit = { ...edit, cursor: edit.draft.length };
      } else if (key.name === "backspace") {
        if (edit.cursor > 0) {
          this.settingsEdit = {
            ...edit,
            draft: `${edit.draft.slice(0, edit.cursor - 1)}${edit.draft.slice(edit.cursor)}`,
            cursor: edit.cursor - 1,
          };
        }
      } else if (key.name === "delete") {
        this.settingsEdit = {
          ...edit,
          draft: `${edit.draft.slice(0, edit.cursor)}${edit.draft.slice(edit.cursor + 1)}`,
        };
      } else if (key.name === "enter" || key.name === "return") {
        if (!control?.text) {
          if (
            !/^\d+$/.test(edit.draft) ||
            !Number.isSafeInteger(Number(edit.draft))
          ) {
            this.notice = "Enter a whole number within the displayed range.";
            return true;
          }
        }
        try {
          this.applySetting(edit.key, edit.draft);
          this.settingsEdit = undefined;
        } catch (error) {
          this.notice = message(error);
        }
      } else if (
        value &&
        !key.ctrl &&
        !key.meta &&
        edit.draft.length < (control?.maxLength ?? 12) &&
        (control?.text
          ? control.key === "terminal.keybindings"
            ? /^[\x20-\x7e]$/.test(value)
            : /^[A-Za-z0-9._:@/-]$/.test(value)
          : /^\d$/.test(value))
      ) {
        this.insertSettingsText(value);
      }
      this.detail = this.settingsLines();
      return true;
    }
    const controls = this.visibleSettingsControls();
    const page = Math.max(1, this.viewport.height - 3);
    if (key.name === "escape") {
      if (this.settingsQuery) {
        this.settingsQuery = "";
        this.settingsQueryCursor = 0;
        this.settingsSelected = 0;
        this.scroll = 0;
        this.detail = this.settingsLines();
        this.notice = "Settings filter cleared.";
      } else {
        this.choose("chat");
        this.notice = "Returned to Chat.";
      }
    } else if (key.ctrl && (key.name === "u" || key.name === "a")) {
      this.settingsQuery = "";
      this.settingsQueryCursor = 0;
      this.settingsSelected = 0;
      this.scroll = 0;
      this.detail = this.settingsLines();
    } else if (key.name === "backspace" || key.name === "delete") {
      const points = [...this.settingsQuery];
      if (key.name === "backspace" && this.settingsQueryCursor > 0) {
        points.splice(this.settingsQueryCursor - 1, 1);
        this.settingsQueryCursor -= 1;
      } else if (
        key.name === "delete" &&
        this.settingsQueryCursor < points.length
      ) {
        points.splice(this.settingsQueryCursor, 1);
      }
      if (points.join("") !== this.settingsQuery) {
        this.settingsQuery = points.join("");
        this.settingsSelected = Math.min(
          this.settingsSelected,
          Math.max(0, this.visibleSettingsControls().length - 1),
        );
        this.scroll = 0;
        this.detail = this.settingsLines();
      }
    } else if (key.ctrl && (key.name === "left" || key.name === "right")) {
      if (this.settingsQuery) {
        this.settingsQueryCursor = Math.max(
          0,
          Math.min(
            [...this.settingsQuery].length,
            this.settingsQueryCursor + (key.name === "left" ? -1 : 1),
          ),
        );
      } else if (controls.length) {
        const groups = [...new Set(controls.map((control) => control.group))];
        const currentGroup = controls[this.settingsSelected]?.group;
        const currentIndex = Math.max(0, groups.indexOf(currentGroup!));
        const nextIndex =
          (currentIndex + (key.name === "left" ? -1 : 1) + groups.length) %
          groups.length;
        const target = controls.findIndex(
          (control) => control.group === groups[nextIndex],
        );
        if (target >= 0) {
          this.selectSetting(target);
          return true;
        }
      }
      this.detail = this.settingsLines();
    } else if (value && value !== " " && !key.ctrl && !key.meta) {
      this.insertSettingsText(value);
      return true;
    } else if (!controls.length) {
      this.detail = this.settingsLines();
    } else if (key.name === "up" || (key.ctrl && key.name === "p")) {
      this.selectSetting(
        (this.settingsSelected - 1 + controls.length) % controls.length,
      );
    } else if (key.name === "down" || (key.ctrl && key.name === "n")) {
      this.selectSetting((this.settingsSelected + 1) % controls.length);
    } else if (key.name === "home") {
      this.selectSetting(0);
    } else if (key.name === "end") {
      this.selectSetting(controls.length - 1);
    } else if (key.name === "pageup") {
      this.selectSetting(Math.max(0, this.settingsSelected - page));
    } else if (key.name === "pagedown") {
      this.selectSetting(
        Math.min(controls.length - 1, this.settingsSelected + page),
      );
    } else if (key.name === "left" || key.name === "right") {
      this.adjustSetting(key.name === "left" ? -1 : 1);
    } else if (key.name === "enter" || key.name === "return") {
      this.activateSetting();
    } else if (value === " " && !key.ctrl && !key.meta) {
      this.activateSetting();
    }
    return true;
  }
  session() {
    return this.sessionId ? this.workbench.get(this.sessionId) : undefined;
  }
  renderChatRows(
    events: readonly SessionEvent[],
    width: number,
    terminalHeight = 40,
  ) {
    const cached = this.renderedChatRows;
    const cacheMatches = !!(
      cached &&
      cached.sessionId === this.sessionId &&
      cached.width === width &&
      cached.terminalHeight === terminalHeight &&
      cached.activityMode === this.toolActivityMode &&
      cached.hideToolActivity === this.hideToolActivity &&
      cached.density === this.chatPanelVisuals.density &&
      cached.timestamps === this.chatPanelVisuals.timestamps &&
      cached.symbolPreset === this.themeConfig.symbolPreset
    );
    if (cacheMatches && cached.events === events) return cached.rows;
    let stableCount = events.length;
    while (stableCount > 0 && events[stableCount - 1]?.type === "message.delta")
      stableCount--;
    // Workbench appends immutable delta events during a streamed response.
    // Reuse the settled transcript prefix until a non-delta event arrives.
    const canReusePrefix = !!(
      cacheMatches &&
      cached.stableCount === stableCount &&
      (stableCount === 0 ||
        events[stableCount - 1] === cached.events[stableCount - 1])
    );
    const render = (slice: readonly SessionEvent[]) =>
      chatRows(
        slice,
        width,
        this.toolActivityMode,
        this.chatPanelVisuals.density,
        this.chatPanelVisuals.timestamps,
        this.hideToolActivity,
        this.themeConfig.symbolPreset,
        terminalHeight,
      );
    const stableRows = canReusePrefix
      ? cached.stableRows
      : render(events.slice(0, stableCount));
    const appendOnlyDeltaTail = !!(
      cacheMatches &&
      cached.stableCount === stableCount &&
      events.length >= cached.events.length &&
      (stableCount === 0 ||
        events[stableCount - 1] === cached.events[stableCount - 1]) &&
      (cached.events.length === stableCount ||
        events[cached.events.length - 1] ===
          cached.events[cached.events.length - 1])
    );
    const partialText = appendOnlyDeltaTail
      ? cached.partialText +
        events
          .slice(cached.events.length)
          .map((event) => event.text)
          .join("")
      : events
          .slice(stableCount)
          .map((event) => event.text)
          .join("");
    const tailRows = appendOnlyDeltaTail
      ? stableCount < events.length
        ? render([{ ...events.at(-1)!, text: partialText }])
        : []
      : render(events.slice(stableCount));
    const rows = [...stableRows, ...tailRows];
    this.renderedChatRows = {
      sessionId: this.sessionId ?? "",
      events,
      width,
      terminalHeight,
      activityMode: this.toolActivityMode,
      hideToolActivity: this.hideToolActivity,
      density: this.chatPanelVisuals.density,
      timestamps: this.chatPanelVisuals.timestamps,
      symbolPreset: this.themeConfig.symbolPreset,
      stableCount,
      stableRows,
      partialText: stableCount < events.length ? partialText : "",
      rows,
    };
    return rows;
  }
  private useSession(id: string) {
    if (!this.workbench.get(id)) throw Error("Conversation not found.");
    this.sessionId = id;
    this.documentPath = undefined;
  }
  items(): Item[] {
    let rows: Item[] = [];
    const sessionIcons = getSymbols(this.themeConfig.symbolPreset).icons;
    if (this.tab === "sessions")
      rows = [...this.workbench.list()]
        .sort((a, b) => {
          const pinnedOrder = Number(!!b.pinned) - Number(!!a.pinned);
          if (pinnedOrder !== 0) return pinnedOrder;
          const aTime = Date.parse(a.updatedAt ?? a.createdAt ?? "");
          const bTime = Date.parse(b.updatedAt ?? b.createdAt ?? "");
          const aValid = Number.isFinite(aTime);
          const bValid = Number.isFinite(bTime);
          if (aValid !== bValid) return aValid ? -1 : 1;
          if (aValid && bValid && aTime !== bTime) return bTime - aTime;
          return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
        })
        .map((s) => ({
          id: s.id,
          sessionId: s.id,
          label: `${s.archived ? ROW_ICONS.archived : stateIcon(s.status)} ${s.status} · ${s.pinned ? "pinned · " : ""}${s.title ?? s.id}`,
          lines: [
            `${sessionIcons.session} Conversation: ${s.title ?? s.id}`,
            `${stateIcon(s.status)} Status: ${s.status}${s.archived ? " · archived" : ""}${s.pinned ? " · pinned" : ""}`,
            `${sessionIcons.model} Model: ${s.model || "unknown"}`,
            `${sessionIcons.provider} Provider: ${s.provider ?? "unknown"}`,
            `${sessionIcons.document} Workspace: ${s.workspace || "not set"}`,
            `${sessionIcons.document} Project: ${s.project || "not recorded"}`,
            `${sessionIcons.agent} Agent profile: ${s.agent ?? "not recorded"}`,
            `${sessionIcons.time} Updated: ${sessionTimestamp(s.updatedAt ?? s.createdAt)}`,
            `${sessionIcons.time} Created: ${sessionTimestamp(s.createdAt)}`,
            `${sessionIcons.session} Messages: ${numberOr(s.contextMessages, "unknown")}`,
            `${sessionIcons.run} Run: ${s.runId ?? "none"} · ${s.state ?? "unknown"}`,
            `${sessionIcons.tokens} Run tokens: ${s.runTokenCount}`,
            `${sessionIcons.retry} Continuations: ${s.continuationCount}`,
            `${sessionIcons.usage} Retained events: ${s.events.length}`,
            ...(s.parentId ? [`Parent conversation: ${s.parentId}`] : []),
          ],
        }));
    if (this.tab === "runs")
      rows = [...this.workbench.runs()]
        .sort((left, right) => {
          const leftTime = Date.parse(left.updatedAt ?? left.createdAt);
          const rightTime = Date.parse(right.updatedAt ?? right.createdAt);
          const leftValid = Number.isFinite(leftTime);
          const rightValid = Number.isFinite(rightTime);
          if (leftValid !== rightValid) return leftValid ? -1 : 1;
          if (leftValid && rightValid && leftTime !== rightTime)
            return rightTime - leftTime;
          return left.runId < right.runId
            ? -1
            : left.runId > right.runId
              ? 1
              : 0;
        })
        .map((run) => {
          const progress =
            typeof run.progress === "number" &&
            Number.isFinite(run.progress) &&
            run.progress >= 0 &&
            run.progress <= 1
              ? `${Math.round(run.progress * 100)}%`
              : "progress not reported";
          const duration =
            typeof run.durationMs === "number" &&
            Number.isFinite(run.durationMs) &&
            run.durationMs >= 0
              ? `${Math.round(run.durationMs / 100) / 10}s`
              : "time unknown";
          return {
            id: `${run.sessionId}:${run.runId}`,
            sessionId: run.sessionId,
            run,
            label: `${stateIcon(run.state)} ${sanitizeText(run.state)} · ${sanitizeText(run.model)} · ${progress} · ${run.sessionId.slice(0, 8)}`,
            lines: [
              `${sessionIcons.run} Run: ${sanitizeText(run.runId)}`,
              `${stateIcon(run.state)} State: ${sanitizeText(run.state)} · provider status ${sanitizeText(run.status)}`,
              `${sessionIcons.model} Model: ${sanitizeText(run.model)}`,
              `${sessionIcons.provider} Provider: ${sanitizeText(run.provider ?? "not reported")}`,
              `${sessionIcons.session} Conversation: ${run.sessionId}`,
              `${sessionIcons.usage} Progress: ${progress}`,
              `${sessionIcons.tool} Tool steps: ${run.steps}`,
              `${sessionIcons.time} Duration: ${duration}`,
              `${sessionIcons.time} Started: ${sessionTimestamp(run.createdAt)}`,
              `${sessionIcons.time} Updated: ${sessionTimestamp(run.updatedAt)}`,
              `${sessionIcons.retry} Record: ${run.legacy ? "legacy event stream" : "run-scoped event stream"}`,
              `${run.reconcileRequired ? ROW_ICONS.queued : ROW_ICONS.settled} Reconciliation: ${run.reconcileRequired ? "required before treating outcome as settled" : "not required by current run state"}`,
            ],
          };
        });
    if (this.tab === "documents")
      rows = this.workbench.documentsList().map((d) => ({
        id: `${d.sessionId}:${d.path}`,
        sessionId: d.sessionId,
        path: d.path,
        label: `${ROW_ICONS.document} ${d.path}  ${d.bytes} B  ${d.sessionId.slice(0, 8)}`,
        lines: json(d),
      }));
    if (this.tab === "ledger") {
      for (const [id, entries] of this.proofs)
        for (const e of entries) {
          const b = e.body as Record<string, unknown>;
          rows.push({
            id: `${id}:${e.seq}`,
            sessionId: id,
            ...(typeof b.operationId === "string"
              ? { operationId: b.operationId }
              : {}),
            kind: "entry",
            ledgerEntry: e,
            label: `${text(b.decision) || "recorded"} · ${text(b.tool) || "unknown tool"} · ${id.slice(0, 8)} #${e.seq}`,
            lines: [
              this.managedVerificationStatus ?? "Managed verification status unavailable",
              ...(this.managedVerificationNote === undefined
                ? []
                : [`Verification key: ${this.managedVerificationNote}`]),
              ...json(e),
            ],
          });
        }
      for (const [workspace, entries] of this.proxy.entries)
        for (const e of entries) {
          const b = e.body as Record<string, unknown>;
          rows.push({
            id: `proxy:${workspace}:${e.seq}`,
            kind: "proxy",
            ledgerEntry: e,
            label: `${text(b.decision) || "recorded"} · ${text(b.tool) || "unknown tool"} · ${workspace} #${e.seq}`,
            lines: [
              this.proxy.signed
                ? this.proxy.verificationStatus
                : "[!] Proxy: hash integrity only, signature NOT VERIFIED",
              ...(this.proxy.verificationNote
                ? [`Verification key: ${this.proxy.verificationNote}`]
                : []),
              ...json(e),
            ],
          });
        }
      // What the chain taught, as rows of its own. The rules are mined from
      // these same verified entries rather than recomputed from a snapshot, so
      // an unverified refusal cannot appear here as if it had authority.
      for (const [id, entries] of this.proofs) {
        const learned = mineLearnedRules(entries);
        // A workspace that taught nothing still gets a record, because
        // "nothing was mined here" and "this row was never built" are
        // indistinguishable on screen. An operator who sees no learning row
        // cannot otherwise tell a chain that was read and found no pattern
        // from a chain that was never consulted. Those are different facts,
        // so they get different wording: verified entries with no recurring
        // refusal is a *result*, while no entries at all is simply nothing
        // observed yet.
        if (learned.length === 0) {
          rows.push({
            id: `learned:${id}:none`,
            sessionId: id,
            kind: "learned",
            label: `${ROW_ICONS.learned} learned ${id.slice(0, 8)} nothing learned`,
            lines: [
              entries.length
                ? `0 recurring refusals across ${entries.length} verified ${entries.length === 1 ? "entry" : "entries"}.`
                : "0 verified entries, so no refusal has been observed and no rule was mined.",
              "Mined from the verified chain.",
            ],
          });
        }
        for (const rule of learned) {
          rows.push({
            // The class belongs in the identity as well as the label: the
            // same tool refused under two different classes is two separate
            // patterns, and an id built from the tool alone collides them.
            id: `learned:${id}:${String(rule.match.tool)}:${String(rule.match.class)}`,
            sessionId: id,
            kind: "learned",
            label: `${ROW_ICONS.learned} learned ${id.slice(0, 8)} ${text(rule.match.tool)} [${text(rule.match.class)}] -> ${rule.decision}`,
            lines: [
              this.managedVerificationStatus === undefined
                ? "[OK] Mined from the verified chain"
                : `[OK] Mined from the verified chain, ${this.managedVerificationStatus}`,
              ...(this.managedVerificationNote === undefined
                ? []
                : [`Verification key: ${this.managedVerificationNote}`]),
              rule.rationale ?? "",
              "A learned rule is evidence, not authority: it is appended after the operator's own rules, and under the mandatory terminal catch-all it never binds.",
            ],
          });
        }
      }
      // With no verified workspace at all there is no loop iteration to hang
      // the empty record on, and the tab would otherwise show nothing, which
      // an operator reads as "no learning record exists" rather than "nothing
      // has been verified yet". Same distinction as above, one level up.
      if (this.proofs.size === 0)
        rows.push({
          id: "learned:none",
          // The empty record belongs under the learned heading too: a reader
          // who sees no heading cannot tell "nothing was mined" from "this
          // section was never built".
          kind: "learned",
          label: `${ROW_ICONS.learned} learned nothing learned`,
          lines: [
            "0 verified entries, so no refusal has been observed and no rule was mined.",
            "Mined from the verified chain.",
          ],
        });
      // What the chain costs a human, measured rather than asserted. The
      // figures are descriptive: they print beside the records they were
      // measured from and reach no gate, policy or permission. A metric the
      // chain cannot support is reported as unavailable instead of being
      // rendered as a number nobody checked.
      {
        // Score only the managed chains above: each verified workspace chain
        // is one case. Proxy chains have a separate verification state and are
        // not mixed into this descriptive, non-authoritative report.
        const scoreBoard = measureBoard(
          verifiedScoreCases(this.proofs),
          new Date().toISOString(),
        );
        rows.push({
          id: "harness:scores",
          kind: "score",
          label: `${ROW_ICONS.harness} harness score ${scoreBoard.verdict} · ${scoreBoard.caseCount} case${scoreBoard.caseCount === 1 ? "" : "s"}`,
          lines: [
            `Verdict: ${scoreBoard.verdict}.`,
            "Descriptive only; never changes a decision or permission.",
            // `first_pass_rate` is computed from an empty case list, so its
            // sample count is structurally zero. Printing a rate and a CI for
            // it implied a measurement that cannot exist.
            "First-pass rate: unmeasured; no producer writes this metric yet.",
            // The verdict is a sentence, not a grade: "flat" means nothing was
            // compared, which reads as "measured and unchanged" unless the
            // reason is printed next to it.
            `Reason: ${scoreBoard.reasons.join("; ")}.`,
            ...unmeasuredMetrics(scoreBoard)
              .filter((key) => key !== "first_pass_rate")
              .map((key) => `${key}: no sample, so no rate can be computed.`),
            ...(() => {
              // The last activation is the one an operator can still roll
              // back. Naming a regression without naming the digest would be a
              // warning nobody can act on; claiming "no regression" when a
              // guardrail was unmeasured would be worse than saying nothing.
              const newest = mineRefinementEffects(
                [...this.proofs.values()].flat(),
              ).sort((a, b) => b.activationSeq - a.activationSeq)[0];
              if (!newest || newest.status !== "activated") return [];
              const short = newest.digest ? newest.digest.slice(0, 8) : null;
              const breaches = newest.effect.guardrailBreaches;
              const unmeasured = newest.effect.unmeasuredGuardrails;
              if (breaches.length > 0)
                return [
                  `Rollback candidate: ${short ?? "activation"} at seq ${newest.activationSeq} regressed ${breaches.join(", ")}.`,
                ];
              if (unmeasured.length > 0)
                return [
                  `Last activation ${short ?? "at seq " + newest.activationSeq}: ${unmeasured.join(", ")} unmeasured, so no pass is claimed.`,
                ];
              return [
                `Last activation ${short ?? "at seq " + newest.activationSeq}: no guardrail regressed.`,
              ];
            })(),
          ],
        });
      }
      {
        const loaded = [...this.proofs.values()].reduce(
          (sum, entries) => sum + entries.length,
          0,
        );
        const issues = this.proofErrors.size + this.proxy.errors.length;
        rows.push({
          id: "ledger:verification",
          kind: "verification",
          label: `Chain evidence · ${loaded} managed entries loaded · ${issues} issues`,
          lines: [
            `Managed: ${this.managedVerificationStatus ?? "no verification result"}`,
            `Proxy: ${this.proxy.verificationStatus}`,
            ...this.proofErrors.values(),
            ...this.proxy.errors,
          ],
        });
      }
      // The harness that produced this chain: which runtime is the default,
      // which profile new conversations get, and what hooks are wired.
      // /harness and /hooks print the same facts on demand; this is where
      // the chain itself is shown, so the chain and its producer stay
      // together on one tab.
      const harnessCatalog = this.workbench.agents();
      const prefs = this.workbench.getPreferences();
      rows.push({
        id: "harness:current",
        kind: "harness",
        label: `${ROW_ICONS.harness} harness ${prefs.defaultAgent ?? "cloud"}`,
        lines: [
          `Default for new conversations: ${prefs.defaultAgent ?? "cloud"}.`,
          `Selected agent profile: ${this.agentId ?? "runtime default"}.`,
          harnessCatalog.hooksSupported
            ? `Hooks are executable; ${harnessCatalog.hooks.length} saved.`
            : "Hook execution unsupported on this host: none can run.",
        ],
      });
      for (const hook of harnessCatalog.hooks) {
        rows.push({
          id: `hook:${hook.id}`,
          kind: "hook",
          label: `${hook.enabled ? ROW_ICONS.hook : ROW_ICONS.archived} hook ${hook.id} ${hook.enabled ? "on" : "off"}`,
          lines: [
            `Event: ${hook.event}.`,
            `Command: ${boundedHookCommand(hook.command)}`,
            "/hook enable|disable <id> toggles it; /hook-file reviews a save.",
          ],
        });
      }
      if (harnessCatalog.hooks.length === 0)
        rows.push({
          id: "hook:none",
          kind: "hook",
          label: `${ROW_ICONS.hook} hook none saved`,
          lines: [
            harnessCatalog.hooksSupported
              ? "No hooks saved. /hook-file path.json reviews a save."
              : "No hooks saved, and execution is unsupported on this host.",
          ],
        });
      // One row per selectable agent, presets and saved profiles alike: the
      // harness row above says which profile is selected, and these rows are
      // the panel it is selected from. The label carries the selection so it
      // is visible without opening anything, and Enter makes the same
      // assignment /agent <id> makes, so selection never leaves the tab.
      for (const agent of harnessCatalog.agents) {
        const profile = harnessCatalog.profiles.find(
          (candidate) => candidate.id === agent.id,
        );
        const selected = agent.id === this.agentId;
        // Same bound as /agents prints: a prompt is prose, and the marker
        // says it was cut rather than letting a truncated prompt read as
        // the whole one.
        const prompt = profile?.systemPrompt.trim() ?? "";
        const shown = !prompt
          ? "(empty)"
          : prompt.length > 160
            ? `${prompt.slice(0, 160)}… (+${prompt.length - 160} chars)`
            : prompt;
        rows.push({
          id: `agent:${agent.id}`,
          kind: "agent",
          label: `◆ agent ${agent.id}${selected ? " [selected]" : ""}`,
          lines: [
            ...(profile
              ? [
                  `Profile ${profile.id}: policy ${profile.policyProfile}, max turns ${profile.maxTurns}, max context tokens ${profile.maxContextTokens}`,
                  `Allowed tools: ${profile.allowedTools.join(", ") || "none"}`,
                  `System prompt: ${shown}`,
                ]
              : [`Preset ${agent.id}: ${agent.name}. ${agent.description}`]),
            selected
              ? "Selected for new conversations."
              : "Enter selects it for new conversations; Enter again returns to the runtime default.",
            "Existing conversations keep their profile snapshot. /agent-file path.json reviews a save.",
          ],
        });
      }
      rows.reverse();
      // Grouped by kind, in the order an operator reasons in. Without this
      // the groups rendered in whatever order the records happened to be
      // built in, so agents came before the signed entries they relate to.
      // Sorting the rows themselves rather than the rendered lines is what
      // keeps the printed numbers matching the selection index.
      rows.sort(
        (a, b) =>
          LEDGER_GROUP_ORDER.indexOf(
            (a.kind ?? "entry") as (typeof LEDGER_GROUP_ORDER)[number],
          ) -
          LEDGER_GROUP_ORDER.indexOf(
            (b.kind ?? "entry") as (typeof LEDGER_GROUP_ORDER)[number],
          ),
      );
    }
    if (this.tab === "approvals")
      rows = this.workbench
        .approvals()
        .map((value) => {
          const h = value as {
            holdId: string;
            status: string;
            call: {
              tool: string;
              klass?: string;
              blastRadius?: number;
              reason?: string;
            };
            expiresAt: number;
          };
          return {
            id: h.holdId,
            hold: h,
            // A rejected hold is not an open obligation, so it gets a
            // different glyph from a pending one. The status word beside it
            // stays authoritative either way.
            // The countdown rides on the row because the row is what the
            // operator is looking at when they decide whether to read the
            // detail first. The risk badge comes from the reversibility class
            // the registry gave the call, and both are words, so the row
            // still reads without colour.
            label:
              expirySuffix(h, Date.now()) +
              approvalRiskBadge(h) +
              " " +
              holdRowIcon(h) +
              " " +
              approvalLabel(h),
            lines: json(h),
          };
        })
        // Most consequential first, not newest first. The list used to
        // arrive in backend order, which put a read next to a write and let
        // an operator clear three harmless holds before reaching the one
        // that touches every document.
        .sort((a, b) => holdSeverity(b.hold) - holdSeverity(a.hold));
    if (this.tab === "approvals")
      rows.push(
        ...this.proxy.holds.map(({ decisionToken, ...h }) => ({
          id: `proxy:${h.holdId}`,
          // The hold itself is carried so the summary can count its real
          // class and deadline instead of parsing the rendered label back.
          hold: {
            status: h.status,
            ...(Number.isFinite(h.expiresAt)
              ? { expiresAt: h.expiresAt as number }
              : {}),
            call: {
              tool: h.call.tool,
              ...(h.call.klass === undefined ? {} : { klass: h.call.klass }),
              ...(h.call.blastRadius === undefined
                ? {}
                : { blastRadius: h.call.blastRadius }),
              ...(h.call.unclassified === undefined
                ? {}
                : { unclassified: h.call.unclassified }),
            },
          },
          label: `${expirySuffix(h, Date.now())}${approvalRiskBadge(h)} ${ROW_ICONS.approval} [proxy pending] ${h.call.tool} ${h.holdId}`,
          lines: json(h),
        })),
      );
    if (this.tab === "tools")
      rows = this.workbench
        .availableTools(this.sessionId)
        .tools.map((tool) => ({
          id: tool.id,
          // The Undo marker is decoration on top of a label that already
          // states the fact in words, so a monochrome terminal and a screen
          // reader lose nothing by not seeing the glyph.
          label:
            `${ROW_ICONS.tool} ${tool.klass.toUpperCase()} ${tool.name} / ${tool.source}` +
            `${
              tool.capturedUndo ? " / ↩ captured Undo" : " / no captured Undo"
            }`,
          // The detail is the schema as a property table rather than as JSON.
          // Raw JSON buried the two facts the operator actually reads, which
          // property is required and what the call does, under a dozen keys
          // nobody scans.
          lines: [
            ...toolSchemaLines(
              {
                id: tool.id,
                name: tool.name,
                klass: tool.klass,
                source: tool.source,
                description: tool.description,
                capturedUndo: tool.capturedUndo,
                inputSchema: tool.inputSchema,
              },
              this.layoutColumns,
            ),
            "",
            `Scope: ${this.sessionId ? "current conversation" : "new conversations"}`,
            tool.capturedUndo
              ? "Captured document Undo available."
              : "Undo is not guaranteed for this tool.",
            "",
            "The model requests tools through NOMO policy and approvals.",
            "",
            REGISTRY_DISCLAIMER,
          ],
        }));
    if (this.tab === "mcp")
      rows = this.connectorRows().map((connector) => ({
        id: connector.id,
        connector: {
          id: connector.id,
          name: connector.name,
          tools: connector.tools,
          consentState: connector.consent,
        },
        label: `${connectorConsentIcon(connector.consent)} ${connector.consent.toUpperCase()} · ${sanitizeText(connector.name)} · ${connector.tools.length} tools`,
        lines: [
          `id ${sanitizeText(connector.id)}`,
          `endpoint ${sanitizeText(connector.endpoint)}`,
          `consent ${connector.consent}`,
          `tools ${connector.tools.length}: ${this.toolNames(connector.tools)}`,
          `policy ${policySummary(connector.policy)}`,
        ],
      }));
    if (this.tab === "policy")
      rows = this.workbench.connectionState().connectors.map((c) => ({
        id: c.id,
        label: `${ROW_ICONS.connector} ${c.name} (${c.tools.length} tools)`,
        connector: {
          id: c.id,
          name: c.name,
          tools: c.tools,
          consentState: c.consentState,
        },
        lines: json(c),
      }));
    if (this.tab === "status")
      rows = orderChecks(this.healthChecks()).map((check) => ({
        id: `${check.area}:${check.name}`,
        check,
        label: `${healthIcon(check.state)} ${healthWord(check.state).toUpperCase()} · ${sanitizeText(check.area)} · ${sanitizeText(check.name)}`,
        lines: [
          sanitizeText(check.detail),
          ...(check.remedy ? [`Next step: ${sanitizeText(check.remedy)}`] : []),
        ],
      }));
    if (this.tab === "models")
      rows = this.activeModelCatalog().map((m) => ({
        id: m.id,
        // The [*] marker is what says which model new conversations get. The
        // glyph in front is only a shape to scan by; the marker stays.
        label: `${this.providerGlyph(this.provider?.baseUrl ?? "", this.provider?.providerId ?? "")} ${this.modelGlyph()} ${m.id === this.model ? "[*]" : "[ ]"} ${m.name}  ${m.id}`,
        lines: json(m),
      }));
    if (this.tab === "usage")
      rows = activity(this.workbench.allViews()).usage
        .sort((a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id))
        .map((r) => ({
          id: r.id,
          sessionId: r.sessionId,
          label: `${typeof r.totalTokens === "number" && r.totalTokens >= 0 ? numberOr(r.totalTokens, "unknown") : "unknown"} tokens · ${r.model} · ${r.sessionId.slice(0, 8)}`,
          usage: r,
          lines: json(r),
        }));
    const filteredRows = this.filter
      ? rows.filter((r) =>
          `${r.label} ${r.lines.join(" ")}`
            .toLowerCase()
            .includes(this.filter.toLowerCase()),
        )
      : rows;
    if (this.tab === "documents" || this.tab === "sessions") {
      const treeKey =
        `${this.tab}\0${this.filter.toLowerCase()}\0` +
        filteredRows
          .map(
            (row) =>
              // Session details and recency change without changing the
              // title/status label; include them so tree rows stay fresh.
              `${row.id}\0${row.label}\0${this.tab === "sessions" ? row.lines.join("\0") : ""}`,
          )
          .join("\u0001");
      if (!this.groupTree || this.groupTreeKey !== treeKey) {
        const matchingIds = new Set(filteredRows.map((row) => row.id));
        if (this.tab === "documents") {
          const nodes = buildDocumentTree(
            this.workbench
              .documentsList()
              .filter((document) =>
                matchingIds.has(`${document.sessionId}:${document.path}`),
              )
              .map((document) => ({
                id: `${document.sessionId}:${document.path}`,
                path: document.path,
                detail: `${document.bytes} B · ${document.sessionId.slice(0, 8)}`,
                kind: "document",
              })),
          );
          this.groupTree = {
            nodes,
            state: refreshedTreeState(this.groupTree, nodes),
          };
          this.sessionBrowser = undefined;
        } else {
          // Sessions keep the filtered row order, which is pinned first and
          // then most recently updated. The browser only regroups it, so the
          // rows an operator sees never reorder behind their back.
          const sessions = new Map(
            this.workbench.list().map((session) => [session.id, session]),
          );
          const model = buildSessionBrowser(
            filteredRows.flatMap((row) => {
              const session = sessions.get(row.id);
              return session ? [session] : [];
            }),
          );
          this.groupTree = {
            nodes: model.nodes,
            state: this.groupTree
              ? refreshedTreeState(this.groupTree, model.nodes)
              : initialSessionBrowserState(model),
          };
          this.sessionBrowser = model;
        }
        this.groupTreeKey = treeKey;
      }
    }
    return filteredRows;
  }
  /**
   * How many existing conversations already ran on a model.
   *
   * Switching does not move a conversation: a conversation keeps the model
   * it started on. An operator about to switch needs to know how much of
   * their history that leaves behind, and the honest answer is a count rather
   * than a reassurance.
   */
  conversationsOnModel(modelId: string): string {
    const count = this.workbench
      .list()
      .filter((s) => s.model === modelId).length;
    if (!count) return "no existing conversation";
    return `${count} existing conversation${count === 1 ? "" : "s"} (they keep their own model)`;
  }

  async openSelected() {
    const row = this.items()[this.selected];
    if (!row) return;
    // Enter on a conversation resumes it in Chat, matching the session
    // selector interaction used by OMP.
    if (this.tab === "sessions") {
      this.useSession(row.sessionId!);
      this.choose("chat");
      return;
    }
    if (this.tab === "documents") {
      this.documentPreview = false;
      this.useSession(row.sessionId!);
      this.documentPath = row.path;
      this.showDocument();
      return;
    }
    if (this.tab === "runs" && row.run) {
      const run = row.run;
      const session = this.workbench.get(run.sessionId);
      const events = (session?.events ?? []).filter(
        (event) =>
          event.runId === run.runId ||
          (run.legacy && event.runId === undefined),
      );
      const runUsage = activity(this.workbench.allViews()).usage.filter(
        (entry) => entry.runId === run.runId,
      );
      const reportedTokens = runUsage
        .map((entry) => entry.totalTokens)
        .filter(
          (value): value is number =>
            typeof value === "number" && Number.isFinite(value) && value >= 0,
        );
      const progress =
        typeof run.progress === "number" &&
        Number.isFinite(run.progress) &&
        run.progress >= 0 &&
        run.progress <= 1
          ? `${Math.round(run.progress * 100)}%`
          : "not reported";
      const duration =
        typeof run.durationMs === "number" &&
        Number.isFinite(run.durationMs) &&
        run.durationMs >= 0
          ? `${Math.round(run.durationMs / 100) / 10}s`
          : "time unknown";
      const timeline = buildTimeline(
        events.map((event) => ({
          type: event.type ?? event.kind,
          at: event.at,
          tool:
            typeof event.payload?.tool === "string"
              ? event.payload.tool
              : undefined,
          detail:
            typeof event.payload?.name === "string"
              ? event.payload.name
              : undefined,
        })),
      );
      this.detail = [
        ...renderInspector(
          {
            title: `RUN ${sanitizeText(run.state).toUpperCase()}`,
            subtitle: run.runId,
            icon: ROW_ICONS.run,
            sections: [
              {
                title: "run",
                fields: [
                  {
                    label: "state",
                    value: run.state,
                    tone:
                      run.state === "failed"
                        ? "error"
                        : run.state === "running"
                          ? "accent"
                          : "default",
                  },
                  { label: "provider status", value: run.status },
                  { label: "model", value: run.model },
                  { label: "provider", value: run.provider ?? "not reported" },
                  { label: "run id", value: run.runId },
                  {
                    label: "record",
                    value: run.legacy
                      ? "legacy event stream"
                      : "run-scoped event stream",
                  },
                ],
              },
              {
                title: "execution",
                fields: [
                  { label: "progress", value: progress },
                  { label: "tool steps", value: String(run.steps) },
                  { label: "duration", value: duration },
                  { label: "started", value: sessionTimestamp(run.createdAt) },
                  { label: "updated", value: sessionTimestamp(run.updatedAt) },
                  { label: "events", value: String(events.length) },
                ],
              },
              {
                title: "conversation",
                fields: [
                  { label: "id", value: run.sessionId },
                  { label: "title", value: session?.title ?? "not recorded" },
                  {
                    label: "workspace",
                    value: session?.workspace || "not set",
                  },
                  {
                    label: "project",
                    value: session?.project || "not recorded",
                  },
                  {
                    label: "agent profile",
                    value: session?.agent ?? "not recorded",
                  },
                ],
              },
              {
                title: "usage and recovery",
                fields: [
                  {
                    label: "reported tokens",
                    value: reportedTokens.length
                      ? reportedTokens
                          .reduce((sum, value) => sum + value, 0)
                          .toLocaleString("en-US")
                      : "not reported",
                  },
                  {
                    label: "reconciliation",
                    value: run.reconcileRequired
                      ? "required"
                      : "not required by current state",
                    tone: run.reconcileRequired ? "warning" : "success",
                  },
                  { label: "resume", value: `/resume ${run.sessionId}` },
                  ...(run.reconcileRequired
                    ? [
                        {
                          label: "recovery",
                          value:
                            "/recovery refreshes the recorded recovery state",
                          tone: "warning" as const,
                        },
                      ]
                    : []),
                ],
              },
            ],
            hint: "Esc returns to Runs · Enter on a run opens this read-only inspector",
          },
          { width: this.layoutColumns, motion: motionContext(this.frame) },
        ),
        "",
        `${getSymbols(this.themeConfig.symbolPreset).icons.run} RECORDED ACTIVITY`,
        ...renderTimeline(timeline, this.layoutColumns, 10, {
          motion: motionContext(this.frame),
        }),
        "",
        "Only recorded run metadata is shown; code and tool output remain in the Chat activity stream.",
      ];
      this.scroll = 0;
      return;
    }
    // An approval is the one row where Enter should read as "show me what I
    // am about to decide", not as raw JSON. The hold is already carried on the
    // row for ordering, so this reads the same object the list sorted by.
    if (this.tab === "approvals" && row.hold) {
      this.detail = approvalInspectLines(
        row.hold,
        row.lines,
        this.layoutColumns,
      );
      this.scroll = 0;
      return;
    }
    if (this.tab === "mcp" && row.connector) {
      const connector = this.connectorRows().find(
        (candidate) => candidate.id === row.connector?.id,
      );
      if (!connector) throw Error("Connector changed. Refresh the MCP list.");
      this.detail = this.connectorInspect(connector);
      this.notice = `${connector.name} is ${connector.consent}.`;
      this.scroll = 0;
      return;
    }
    if (this.tab === "status" && row.check) {
      const check = row.check;
      this.detail = renderInspector(
        {
          title: sanitizeText(check.name),
          subtitle: `${check.area} · ${healthWord(check.state)}`,
          icon: healthIcon(check.state),
          sections: [
            {
              title: "health state",
              fields: [
                {
                  label: "state",
                  value: healthWord(check.state),
                  tone: healthTone(check.state),
                },
                { label: "subsystem", value: sanitizeText(check.area) },
              ],
            },
            {
              title: "evidence",
              fields: [
                { label: "current result", value: sanitizeText(check.detail) },
              ],
            },
            {
              title: "next step",
              fields: [
                {
                  label: "remedy",
                  value: sanitizeText(check.remedy ?? "No action is recorded."),
                  tone: check.remedy ? "warning" : "muted",
                },
                { label: "execution", value: "Read-only status inspection" },
              ],
            },
          ],
          hint: "Esc returns to Status · this inspection does not run the suggested action",
        },
        { width: this.layoutColumns, motion: motionContext(this.frame) },
      );
      this.scroll = 0;
      return;
    }
    // Same reasoning for a connector. What the operator came to this tab to
    // find out is what a connector is allowed to do and whether they have
    // agreed to it, and both are two lines down inside the JSON dump they used
    // to get.
    if (this.tab === "policy" && row.connector) {
      const c = row.connector;
      const confirmed = c.consentState === "confirmed";
      this.detail = [
        ...renderInspector(
          {
            title: c.name || c.id,
            subtitle: c.id,
            icon: ROW_ICONS.connector,
            sections: [
              {
                title: "consent",
                fields: [
                  {
                    label: "state",
                    value: c.consentState,
                    // Not confirmed is not a warning about the connector. It
                    // is a statement that nothing has been granted yet, and
                    // colouring it as a problem would imply otherwise.
                    badge: confirmed ? "granted" : "not granted",
                    tone: confirmed ? "success" : "muted",
                  },
                  {
                    label: "means",
                    value: confirmed
                      ? "Calls go through without asking again."
                      : "Calls ask before they run. /connector-file confirms it.",
                  },
                  {
                    label: "tools",
                    value: `${c.tools.length}`,
                    tone: c.tools.length ? "default" : "warning",
                  },
                ],
              },
              {
                title: "tool list",
                fields: c.tools.map((tool) => ({
                  label: tool,
                  value: "available through this connector",
                  tone: "muted",
                })),
              },
            ],
            hint: "/mcp lists connectors; /connector-file reviews a save.",
          },
          { width: this.layoutColumns },
        ),
        "",
        "RAW RECORD",
        ...row.lines,
      ];
      this.scroll = 0;
      return;
    }
    // And for usage. The row carries one number; the detail breaks it into
    // where it went, which is the question the row cannot answer at a glance.
    if (this.tab === "usage" && row.usage) {
      const u = row.usage;
      const total = numberOr(u.totalTokens, "unknown");
      const input = numberOr(u.inputTokens, "unknown");
      const output = numberOr(u.outputTokens, "unknown");
      this.detail = [
        ...renderInspector(
          {
            title: u.model,
            subtitle: u.sessionId.slice(0, 8),
            icon: ROW_ICONS.ledgerEntry,
            sections: [
              {
                title: "tokens",
                fields: [
                  { label: "total", value: total, badge: "all calls" },
                  { label: "in", value: input },
                  { label: "out", value: output },
                  {
                    label: "cost",
                    // Not computed anywhere. Printing a currency figure from
                    // a price this software does not hold would be a number
                    // with no source behind it.
                    value: "unknown, this build does not price",
                    tone: "muted",
                  },
                ],
              },
              {
                title: "where it came from",
                fields: [
                  { label: "provider", value: u.provider ?? "unknown" },
                  { label: "source", value: u.source ?? "unknown" },
                  { label: "at", value: u.at ?? "not stamped" },
                ],
              },
            ],
            hint: "Every number here is what the provider recorded, not an estimate.",
          },
          { width: this.layoutColumns },
        ),
        "",
        "RAW RECORD",
        ...row.lines,
      ];
      this.scroll = 0;
      return;
    }
    if (this.tab === "models") {
      await this.command(`/model ${row.id}`);
      return;
    }
    // A hook row on the ledger tab is the saved hook, so Enter toggles it
    // through the same upsertHook path /hook uses rather than opening
    // details: the id ties a hook to its runs, and the operator allowlist
    // is re-checked on the write either way.
    const hookId = /^hook:(?!none$)(.+)$/.exec(row.id)?.[1];
    if (this.tab === "ledger" && hookId) {
      const hook = this.workbench
        .agents()
        .hooks.find((candidate) => candidate.id === hookId);
      if (!hook) throw Error("Hook not saved. Use /hooks for ids.");
      const saved = this.workbench.upsertHook({
        ...hook,
        enabled: !hook.enabled,
      });
      this.detail = [
        `HOOK ${saved.enabled ? "ENABLED" : "DISABLED"}`,
        ...json(saved),
      ];
      this.notice = `Hook ${saved.id} is now ${saved.enabled ? "on" : "off"}. Existing conversations keep their hook snapshot.`;
      this.scroll = 0;
      return;
    }
    // An agent row is the profile itself, so Enter makes the same selection
    // /agent <id> makes rather than only opening details: new conversations
    // get the profile, existing ones keep theirs, and Enter on the selected
    // row clears the selection back to the runtime default.
    const agentRowId = /^agent:(.+)$/.exec(row.id)?.[1];
    if (this.tab === "ledger" && agentRowId) {
      const agent = this.workbench
        .agents()
        .agents.find((candidate) => candidate.id === agentRowId);
      if (!agent) throw Error("Agent not found. Use /agents for ids.");
      const selected = this.agentId !== agent.id;
      this.agentId = selected ? agent.id : undefined;
      this.detail = [
        selected
          ? `AGENT PROFILE ${agent.id} SELECTED`
          : "AGENT PROFILE CLEARED",
        ...row.lines,
      ];
      this.notice = selected
        ? `Agent profile ${agent.id} selected for new conversations. Existing conversations keep their profile.`
        : "Agent profile cleared. New conversations use the runtime default.";
      this.scroll = 0;
      return;
    }
    // A ledger entry or proxy entry is the core record. Enter reads it as
    // an aligned inspector rather than a JSON dump.
    if (
      this.tab === "ledger" &&
      row.ledgerEntry
    ) {
      const entry = row.ledgerEntry;
      const b = entry.body && typeof entry.body === "object"
        ? entry.body as Record<string, unknown>
        : {};
      const isProxy = row.kind === "proxy";
      const workspace = isProxy ? entry.workspace : row.sessionId;
      this.detail = [
        ...renderInspector(
          {
            title: isProxy
              ? `PROXY LEDGER ${workspace}`
              : `MANAGED LEDGER ${workspace?.slice(0, 8)}`,
            subtitle: row.id,
            icon: isProxy ? ROW_ICONS.proxyEntry : ROW_ICONS.ledgerEntry,
            sections: [
              {
                title: "record",
                fields: [
                  {
                    label: "kind",
                    value: text(b.klass),
                    tone: "muted",
                  },
                  {
                    label: "decision",
                    value: text(b.decision),
                    tone:
                      text(b.decision) === "approved"
                        ? "success"
                        : text(b.decision) === "denied"
                          ? "error"
                          : "warning",
                  },
                  {
                    label: "tool",
                    value: text(b.tool) || "unknown",
                  },
                  {
                    label: "operation",
                    value: row.operationId ?? "n/a",
                    tone: "muted",
                  },
                  {
                    label: "sequence",
                    value: String(entry.seq),
                  },
                ],
              },
              {
                title: isProxy ? "proxy verification" : "managed verification",
                fields: [
                  {
                    label: "status",
                    value: isProxy
                      ? this.proxy.signed
                        ? this.proxy.verificationStatus
                        : "integrity only; signature not verified"
                      : (this.managedVerificationStatus ?? "unknown"),
                    tone: isProxy && !this.proxy.signed ? "warning" : "muted",
                  },
                  {
                    label: isProxy ? "verification key" : "verification note",
                    value: isProxy
                      ? (this.proxy.verificationNote ?? "unknown")
                      : (this.managedVerificationNote ?? "unknown"),
                    tone: "muted",
                  },
                ],
              },
              {
                title: "chain links",
                fields: [
                  { label: "entry hash", value: entry.hash },
                  { label: "previous hash", value: entry.prev_hash },
                  { label: "key ID", value: entry.key_id },
                  { label: "algorithm", value: entry.alg },
                ],
              },
            ],
            hint: "/export ledger exports the full records only when verification permits.",
          },
          { width: this.layoutColumns },
        ),
      ];
      this.scroll = 0;
      return;
    }
    this.detail = row.lines;
    this.scroll = 0;
  }
  showDocument() {
    if (!this.sessionId || !this.documentPath)
      throw Error("Select a document with Enter or /document path.");
    const d = this.workbench.document(this.sessionId, this.documentPath);
    // The identity of the document renders as aligned fields and the content
    // follows as body. Printing "Revision: x" as a loose line made it look
    // like part of the document rather than a fact about it.
    this.detail = [
      ...renderInspector(
        {
          title: this.documentPath,
          subtitle: `revision ${d.revision?.slice(0, 8) ?? "new"}`,
          icon: ROW_ICONS.document,
          sections: [
            {
              title: "document",
              fields: [
                {
                  label: "revision",
                  value: d.revision ?? "new document",
                  tone: d.revision ? "default" : "warning",
                },
                {
                  label: "size",
                  value: `${(d.content ?? "").length} characters`,
                },
                {
                  label: "conversation",
                  value: this.sessionId ?? "none",
                },
              ],
              // The content is the reason this view exists, so it is body
              // under the facts rather than another field.
              body: (d.content ?? "").split("\n"),
            },
          ],
          hint: "/edit edit · /history revisions · /undo preview recovery · /export document",
        },
        { width: this.layoutColumns },
      ),
    ];
    this.scroll = 0;
  }
  editTarget() {
    if (!this.sessionId || !this.documentPath)
      throw Error("Select a document first.");
    const d = this.workbench.document(this.sessionId, this.documentPath);
    return {
      sessionId: this.sessionId,
      path: this.documentPath,
      revision: d.revision,
      content: d.content ?? "",
    };
  }
  prepareEdit(target: ReturnType<WorkspaceTui["editTarget"]>, content: string) {
    if (content === target.content) {
      this.notice = "Document unchanged.";
      return;
    }
    this.confirmation = {
      title: `SAVE ${target.path}?`,
      lines: unifiedDiff(target.content, content),
      apply: async () => {
        await this.workbench.editDocument(
          target.sessionId,
          { path: target.path, content, expectedRevision: target.revision },
          "tui-operator",
        );
        this.useSession(target.sessionId);
        this.documentPath = target.path;
        this.showDocument();
        this.announce(
          "saved",
          "success",
          "Saved. The signed change and Undo are in the ledger.",
        );
      },
    };
    this.scroll = 0;
  }
  async prepareUndo(id?: string) {
    this.queuedPromptPaused = true;
    const selected = this.items()[this.selected];
    if (this.tab === "ledger" && selected?.operationId && !id) {
      this.useSession(selected.sessionId!);
      id = selected.operationId;
    }
    // The documents list is the one tab where the selection is already the
    // undo target: Enter inspects on purpose (reading a document is not
    // aiming an undo), so documentPath would otherwise still name whatever
    // an earlier command opened, and u would undo the wrong file or nothing.
    if (this.tab === "documents" && selected?.path && !id) {
      this.useSession(selected.sessionId!);
      this.documentPath = selected.path;
    }
    if (!this.sessionId) throw Error("Select a conversation or ledger entry.");
    const sessionId = this.sessionId;
    const ops = this.workbench.workspace(sessionId).operations;
    const undone = new Set(ops.flatMap((o) => (o.undoes ? [o.undoes] : [])));
    id ??= [...ops]
      .reverse()
      .find(
        (o) =>
          o.path === this.documentPath &&
          o.kind !== "undo" &&
          !undone.has(o.id),
      )?.id;
    if (!id)
      throw Error(
        "Select a document with an outstanding change or use /undo ID.",
      );
    const operationId = id,
      preview = await this.workbench.undoPreview(sessionId, operationId);
    if (!preview.canApply) throw Error(preview.reason);
    this.confirmation = {
      title: `UNDO ${preview.path}?`,
      lines: [
        `Operation: ${operationId}`,
        "Drift check passed: the document still matches the captured image,",
        "and no newer change to this document exists. The preview is",
        "rechecked before anything is applied.",
        ...unifiedDiff(
          preview.before ?? "[does not exist]",
          preview.after ?? "[does not exist]",
        ),
      ],
      apply: async () => {
        this.confirmation = undefined;
        const current = await this.workbench.undoPreview(
          sessionId,
          operationId,
        );
        if (canonicalJson(current) !== canonicalJson(preview)) {
          this.detail = [
            `UNDO PREVIEW CHANGED: ${preview.path}`,
            `Operation: ${operationId}`,
            current.reason ||
              "The captured state no longer matches this review.",
            "Refresh the document and request /undo again. No change was applied.",
            "Latest preview:",
            ...json(current),
          ];
          this.scroll = 0;
          throw Error("The preview changed. Refresh and request /undo again.");
        }
        await this.workbench.undo(sessionId, operationId, "tui-operator");
        this.detail = undefined;
        // An Undo rewrites a managed document and signs the change. It is the
        // most consequential thing the TUI does on its own, so it gets a toast
        // rather than a notice the next keystroke replaces.
        this.announce(
          "undo-done",
          "success",
          "Undo completed and signed. History is preserved.",
        );
      },
    };
    this.scroll = 0;
  }
  async prepareRecovery(
    selection: Parameters<Workbench["planRecoveryJob"]>[1]["selection"],
  ) {
    if (!this.sessionId) throw Error("Select a conversation for recovery.");
    this.queuedPromptPaused = true;
    const sessionId = this.sessionId;
    this.confirmation = undefined;
    const plan = await this.workbench.planRecoveryJob(sessionId, {
      jobId: randomUUID(),
      selection,
    });
    this.lastRecoveryJob = { sessionId, jobId: plan.jobId };
    const lines = [
      `Job: ${plan.jobId}`,
      `Plan digest: ${plan.planDigest}`,
      `Conversation: ${sessionId}`,
      ...(plan.selection.kind === "run"
        ? [`Requested run: ${plan.selection.runId}`]
        : []),
      `Boundary sequence: ${plan.boundary.sequence}`,
      `Boundary digest: ${plan.boundary.digest}`,
      "",
      "Server-verified recovery order:",
      ...plan.steps.flatMap((step) => [
        `#${step.sequence} ${step.operationId}`,
        `Scope: ${step.scope}`,
        ...step.resources.map((resource) => `Resource: ${resource}`),
      ]),
      "",
      "Residuals:",
      ...json(plan.residuals),
      "",
      "Changed resources pause recovery. No automatic retry or historical tool replay.",
      `/recovery ${plan.jobId} refreshes status without applying anything.`,
    ];
    this.detail = ["RECOVERY PREVIEW", ...lines];
    this.scroll = 0;
    if (!plan.steps.length) {
      this.notice =
        "No recoverable steps. Review residuals; no change was applied.";
      return;
    }
    this.confirmation = {
      title: `RECOVER ${plan.steps.length} OPERATIONS?`,
      lines,
      apply: async () => {
        this.confirmation = undefined;
        const current = await this.workbench.recoveryJobStatus(
          sessionId,
          plan.jobId,
        );
        if (canonicalJson(current) !== canonicalJson(plan)) {
          this.detail = [
            "RECOVERY PREVIEW CHANGED",
            ...json(current),
            `/recovery ${plan.jobId} refreshes status only. Request /rewind again for a new review.`,
          ];
          throw Error(
            "The recovery preview changed. Refresh before another action.",
          );
        }
        let result;
        try {
          result = await this.workbench.applyRecoveryJob(
            sessionId,
            {
              jobId: plan.jobId,
              planDigest: plan.planDigest,
              approved: true,
            },
            "tui-operator",
          );
        } catch (error) {
          this.detail = [
            "RECOVERY OUTCOME UNCONFIRMED",
            message(error),
            "",
            ...lines,
            "Refresh status and reconcile before any further action.",
          ];
          throw error;
        }
        this.detail = [
          "RECOVERY RESULT",
          ...json(result),
          "",
          "No automatic retry. Unknown outcomes require reconciliation.",
          `/recovery ${plan.jobId} refreshes status only.`,
          "Request /rewind with explicit operation IDs for a new review.",
        ];
        this.notice = `Recovery ${result.status}. Review outcomes and residuals before any further action.`;
      },
    };
  }
  async showRecovery(jobId?: string) {
    const sessionId = jobId ? this.sessionId : this.lastRecoveryJob?.sessionId;
    jobId ||= this.lastRecoveryJob?.jobId;
    if (!sessionId || !jobId)
      throw Error("Select a conversation and use /recovery job-ID.");
    this.confirmation = undefined;
    this.queuedPromptPaused = true;
    const result = await this.workbench.recoveryJobStatus(sessionId, jobId);
    this.useSession(sessionId);
    this.lastRecoveryJob = { sessionId, jobId };
    this.detail = [
      "RECOVERY STATUS",
      ...json(result),
      "",
      "Read-only refresh. No automatic retry. Unknown outcomes require reconciliation.",
      "Request /rewind with explicit operation IDs for a new review.",
    ];
    this.scroll = 0;
  }
  /** Toggle one diff hunk in the open review. Number keys drive this;
   * out of range input only renames the notice, never the selection. */
  toggleHunk(index: number) {
    const confirmation = this.confirmation;
    const hunks = confirmation?.hunks;
    if (!confirmation || !hunks || !hunks.chunks.length) {
      this.notice = "This review has no diff hunks to toggle.";
      return;
    }
    if (!Number.isInteger(index) || index < 0 || index >= hunks.chunks.length) {
      this.notice = `No hunk ${index + 1}. This review has ${hunks.chunks.length}.`;
      return;
    }
    hunks.selected[index] = !hunks.selected[index];
    confirmation.lines = [
      ...(confirmation.hunkBase ?? []),
      ...renderHunkSelection(hunks.chunks, hunks.selected),
    ];
    this.scroll = 0;
    this.notice = hunks.selected.some(Boolean)
      ? `Hunk ${index + 1} ${hunks.selected[index] ? "selected" : "deselected"}. The scope rides with the decision.`
      : "No hunks selected. The decision still covers the full call until the server enforces scope.";
  }
  /** Client side diff scope for the decision reason. Shape: full when the
   * review carries no diff, otherwise hunks:a,b/N. The server does not
   * enforce this yet (another lane); it is recorded so the ledger shows
   * which hunks the operator reviewed. */
  hunkScopeSuffix(): string {
    const hunks = this.confirmation?.hunks;
    if (!hunks || !hunks.chunks.length) return "";
    const picked = hunks.selected
      .map((keep, index) => (keep ? index + 1 : -1))
      .filter((index) => index > 0);
    return `[diff-scope: hunks ${picked.length ? picked.join(",") : "none"}/${hunks.chunks.length}]`;
  }
  /** Build the review lines for an approval: evidence first, then an
   * optional selectable diff, then the raw record. Module level so tests
   * can drive it without a running session. */
  private approvalReviewLines = approvalReview;
  prepareApproval(kind: "approved" | "denied", id?: string, reason = "") {
    id ??= this.items()[this.selected]?.id;
    if (id?.startsWith("proxy:")) {
      const hold = this.proxy.holds.find((h) => `proxy:${h.holdId}` === id);
      if (!hold) throw Error("Proxy hold is no longer active.");
      const review = this.approvalReviewLines(
        hold as Parameters<typeof approvalReview>[0],
      );
      this.confirmation = {
        title: `PROXY ${kind === "approved" ? "APPROVE" : "DENY"}?`,
        lines: review.lines,
        hunks: review.hunks,
        hunkBase: review.hunkBase ? [...review.hunkBase] : undefined,
        apply: async () => {
          const suffix = this.hunkScopeSuffix();
          this.proxy.decide(
            hold.holdId,
            kind,
            suffix ? `${reason} ${suffix}`.trim() : reason,
          );
          this.notice =
            "Decision queued for the proxy. Completion is not yet confirmed.";
        },
      };
      this.scroll = 0;
      return;
    }
    const hold = this.workbench.pending().find((h) => h.holdId === id);
    if (!hold) throw Error("Approval is no longer active. Refresh /approvals.");
    const review = this.approvalReviewLines(
      hold as Parameters<typeof approvalReview>[0],
    );
    this.confirmation = {
      title: `${kind === "approved" ? "APPROVE" : "DENY"} ${sanitizeText(hold.call.tool) || "TOOL"}?`,
      lines: [
        ...review.lines,
        "",
        `Reason: ${reason || "(not provided)"}`,
        "External effects may not support Undo.",
      ],
      hunks: review.hunks,
      hunkBase: review.hunkBase
        ? [
            ...review.hunkBase,
            "",
            `Reason: ${reason || "(not provided)"}`,
            "External effects may not support Undo.",
          ]
        : undefined,
      apply: async () => {
        const suffix = this.hunkScopeSuffix();
        if (
          !this.workbench.decide(hold.holdId, {
            kind,
            by: "tui-operator",
            reason: suffix ? `${reason} ${suffix}`.trim() : reason,
          })
        )
          throw Error("Approval expired or was already resolved.");
        this.notice =
          kind === "denied"
            ? "Decision accepted. denied; check the ledger."
            : "Decision accepted. approved; check the ledger.";
        this.detail = undefined;
      },
    };
    this.scroll = 0;
  }
  prepareProjectAccess(
    root: string,
    skills: readonly ProjectSkillSnapshot[],
    sandboxConfigured: string,
  ) {
    const drifted = skills.filter((skill) => skill.drifted);
    this.confirmation = {
      title: "ALLOW THIS PROJECT TO REACH THE SELECTED MODEL?",
      lines: [
        `Canonical project: ${root}`,
        `Workspace skills: ${skills.length ? skills.map((skill) => skill.id).join(", ") : "none"}`,
        ...(drifted.length
          ? [
              `Lock drift: ${drifted.map((skill) => skill.id).join(", ")}`,
              ...drifted.map(
                (skill) =>
                  `  ${skill.id}: locked ${skill.lockedHash}; current ${skill.actualHash}`,
              ),
            ]
          : ["Lock drift: none"]),
        `Sandbox runtime: ${sandboxConfigured}`,
        "WARNING: project files, selected skill text, command arguments, and command output may be sent to the configured model and retained in local session history.",
        "Secrets inside this project are not protected from the model. The container blocks network and host paths, but can print any mounted project file.",
        "The project tool still requires an explicitly configured custom profile, R3 policy approval, and a local immutable sandbox image.",
      ],
      apply: async () => {
        const result = await this.workbench.confirmProjectAccess(root, skills);
        this.notice = `Project access confirmed. ${result.restoredSessions} matching saved session(s) restored.`;
        this.detail = undefined;
      },
    };
    this.scroll = 0;
  }
  async confirm() {
    const value = this.confirmation;
    if (!value) return;
    // Keep the review available if persistence or revision validation fails.
    await value.apply();
    this.confirmation = undefined;
    this.scroll = 0;
    await this.refresh(true);
  }
  /** Host and path only. A connector URL is operator supplied and this view
   * is a screen that gets shared, so a query string never reaches it. */
  private endpoint(value: string | undefined) {
    if (!value) return "builtin";
    try {
      const url = new URL(value);
      return `${url.host}${url.pathname === "/" ? "" : url.pathname}`;
    } catch {
      return "(unreadable endpoint)";
    }
  }
  /** The built in document workspace and external servers arrive in one list
   * but only external ones carry an endpoint, so the view reads a uniform row
   * instead of narrowing at every access. */
  private connectorRows(): ConnectorRow[] {
    return this.workbench.connectionState().connectors.map((c) => ({
      id: c.id,
      name: c.name || c.id,
      builtin: "builtin" in c,
      consent: c.consentState,
      tools: [...c.tools],
      endpoint: "url" in c ? this.endpoint(c.url) : "builtin",
      policy: "policy" in c ? c.policy : undefined,
      facts: "facts" in c ? c.facts : undefined,
      mapping: "mapping" in c ? c.mapping : undefined,
    }));
  }
  /** A catalog can carry 100 tools, so the view names a few and counts the
   * rest rather than growing a line past the 80 column budget. */
  private toolNames(tools: readonly string[], width = 60) {
    if (!tools.length) return "none";
    const shown = tools.slice(0, 6).join(", ");
    return tools.length > 6
      ? `${fit(shown, width - 8)} +${tools.length - 6}`
      : fit(shown, width);
  }
  /** What this connector's policy would do to each tool it lists, read from
   * the same classify-then-decide path a call takes. The blast radius is
   * unknown until a measured probe produces one, and this says so rather
   * than implying a count NOMO does not have. */
  private policyPreviewLines(c: ConnectorRow) {
    const preview = this.workbench.policyPreview(c.id);
    return [
      `  decisions ${preview.counts.allow} allow, ${preview.counts.hold} held, ${preview.counts.deny} denied`,
      ...preview.tools.map(
        (tool) =>
          `    ${fit(tool.tool, 20)} ${tool.decision.padEnd(5)} ${tool.klass} ${fit(tool.mapped, 28)}  radius ${tool.blastRadius}`,
      ),
    ];
  }
  private connectorList() {
    // Grouped by consent state, because the question an operator opens this
    // view with is "what can I actually use yet", and the answer is one group
    // rather than a consent word repeated down a column. Confirmed comes
    // first because it is the only state that grants a conversation tools.
    const order = ["confirmed", "probed", "staged"] as const;
    const rows = this.connectorRows();
    const groups: { consent: string; members: ConnectorRow[] }[] = order
      .map((consent) => ({
        consent: String(consent),
        members: rows.filter((c) => c.consent === consent),
      }))
      .filter((group) => group.members.length);
    // Anything the server reports in a state this list does not name still
    // gets shown. An unknown state is not "none".
    const known = new Set(order.map((c) => String(c)));
    const other = rows.filter((c) => !known.has(String(c.consent)));
    if (other.length) groups.push({ consent: "other", members: other });
    return [
      `${ROW_ICONS.connector} CONNECTORS · confirmed connectors expose tools to conversations`,
      "",
      ...groups.flatMap((group) => [
        `${connectorConsentIcon(group.consent)} ${String(group.consent).toUpperCase()} / ${group.members.length}`,
        ...group.members.flatMap((c) => [
          `  ${pad(c.name, 22)} ${String(c.tools.length).padStart(3)} tools  ${fit(c.endpoint, 34)}`,
          `    id ${c.id}`,
          c.builtin
            ? "    in use: the NOMO document workspace"
            : `    next: ${MCP_NEXT[c.consent as keyof typeof MCP_NEXT]?.(c.id) ?? "/mcp inspect " + c.id}`,
        ]),
        "",
      ]),
      "/mcp inspect ID | /mcp add URL [name] | /mcp probe ID",
      "/mcp confirm ID | /mcp rename ID name | /mcp remove ID",
      "Only /mcp probe contacts a server, and only after confirmation.",
    ];
  }
  private connectorInspect(c: ConnectorRow) {
    const facts = Object.entries(c.facts ?? {})
        .map(([k, v]) => `${k} -> ${v}`)
        .join(", "),
      mapping = Object.entries(c.mapping ?? {})
        .map(([k, v]) => `${k} -> ${v}`)
        .join(", ");
    return [
      `CONNECTOR ${fit(c.name, 40)}`,
      `  id ${c.id}`,
      `  endpoint ${fit(c.endpoint, 60)}`,
      `  consent ${c.consent}`,
      `  policy ${fit(policySummary(c.policy), 60)}`,
      `  facts ${fit(facts || "none", 60)}`,
      `  mapping ${fit(mapping || "none", 60)}`,
      `  tools ${c.tools.length}: ${this.toolNames(c.tools, 48)}`,
      "",
      ...(c.builtin || !c.tools.length ? [] : this.policyPreviewLines(c)),
      c.builtin
        ? "The document workspace is built in and always in use."
        : `next: ${MCP_NEXT[c.consent](c.id)}`,
    ];
  }
  /** An unknown id or subcommand answers with the usage block, so a mistyped
   * id never reads as a connector that quietly does nothing. */
  private mcpUsage(headline: string) {
    this.detail = [
      fit(headline, this.layoutColumns),
      "",
      "CONNECTOR COMMANDS",
      "/mcp lists connectors and the next step for each.",
      "/mcp inspect ID",
      "/mcp add URL [name] stages one and contacts nothing.",
      "/mcp probe ID is the only request, and only on confirmation.",
      "/mcp confirm ID | /mcp rename ID name | /mcp remove ID",
      "",
      "KNOWN CONNECTORS",
      ...this.connectorRows().map((c) => `  ${c.id}  ${c.consent}`),
    ];
    this.scroll = 0;
    this.notice = "Nothing matched that. The usage block is on screen.";
  }
  /** Both staging paths say the same thing, because neither one contacted
   * anything and the next step is the same explicit probe. */
  private stagedView(c: {
    id: string;
    name?: string;
    url?: string;
    consentState: string;
  }) {
    return [
      `STAGED ${fit(c.name || c.id, 40)}`,
      `  id ${c.id}`,
      `  endpoint ${fit(this.endpoint(c.url), 60)}`,
      `  consent ${c.consentState}`,
      "",
      "Nothing was contacted. Staging is a local write.",
      `next: /mcp probe ${c.id}`,
    ];
  }
  private async mcpCommand(arg: string) {
    this.choose("mcp");
    const space = arg.indexOf(" "),
      verb = (space < 0 ? arg : arg.slice(0, space)).toLowerCase(),
      rest = space < 0 ? "" : arg.slice(space + 1).trim(),
      // rename carries a second argument, so its id is only the first token.
      id = (verb === "rename" ? (rest.split(" ")[0] ?? "") : rest).trim();
    if (!verb) {
      this.notice = "Only a confirmed connector gives a conversation tools.";
      return;
    }
    if (!MCP_COMMANDS.includes(verb))
      return this.mcpUsage(`Unknown connector command: ${verb}`);
    if (verb === "inspect") {
      const c = this.connectorRows().find((row) => row.id === id);
      if (!c) return this.mcpUsage(`Unknown connector: ${id}`);
      this.detail = this.connectorInspect(c);
      this.scroll = 0;
      this.notice = `${c.name} is ${c.consent}.`;
      return;
    }
    if (verb === "add") {
      const [url = "", ...name] = rest.split(/\s+/);
      if (!/^https?:\/\/\S+$/i.test(url))
        throw Error("/mcp add https://host/mcp [name]");
      const staged = (
        await this.workbench.addConnector({
          url,
          ...(name.length ? { name: name.join(" ") } : {}),
        })
      ).connectors.at(-1)!;
      this.detail = [...this.stagedView(staged), "", ...this.connectorList()];
      this.scroll = 0;
      this.notice = `Staged ${staged.name || staged.id}. No request was made.`;
      return;
    }
    const c = this.connectorRows().find((row) => row.id === id);
    if (!c) return this.mcpUsage(`Unknown connector: ${id}`);
    if (c.builtin)
      throw Error(
        "The document workspace is built in. /mcp add stages an external one.",
      );
    if (verb === "probe") {
      this.confirmation = {
        title: `PROBE ${c.name}?`,
        lines: [
          `This is the only request NOMO makes, and it goes to ${c.endpoint}.`,
          "",
          c.consent === "confirmed"
            ? "A confirmed connector returns to probed and needs confirming again."
            : "A staged connector is probed in place. Nothing else is written.",
          "The catalog is kept only if you confirm it with /mcp confirm.",
          "Declining sends no request.",
        ],
        apply: async () => {
          try {
            await this.workbench.probeConnector(c.id);
            const probed = this.connectorRows().find((r) => r.id === c.id)!;
            this.detail = this.connectorInspect(probed);
            this.notice =
              `${probed.name} listed ${probed.tools.length} tools. ` +
              "Confirm it before a conversation may use them.";
          } catch (error) {
            const why = this.redactSecrets(message(error));
            this.detail = [
              `PROBE ${fit(c.name, 40)} REFUSED`,
              "",
              why,
              "",
              `${c.name} stays ${c.consent}. No catalog was kept.`,
            ];
            this.notice = `Probe refused: ${why}`;
          }
          this.scroll = 0;
        },
      };
      this.scroll = 0;
      return;
    }
    if (verb === "confirm") {
      if (c.consent !== "probed")
        throw Error(
          `${c.name} is ${c.consent}. Only a probed catalog can be confirmed.`,
        );
      this.confirmation = {
        title: `CONFIRM ${c.name}?`,
        lines: [
          `New conversations may call ${c.tools.length} tools from ${c.endpoint}.`,
          "",
          ...c.tools.slice(0, 8).map((t) => `  ${fit(t, 60)}`),
          ...(c.tools.length > 8 ? [`  and ${c.tools.length - 8} more`] : []),
          "",
          "A conversation that already started keeps the tools it snapshotted.",
        ],
        apply: async () => {
          await this.workbench.confirmConnector(c.id);
          this.detail = this.connectorList();
          this.scroll = 0;
          this.notice = `${c.name} is confirmed for new conversations.`;
        },
      };
      this.scroll = 0;
      return;
    }
    if (verb === "rename") {
      const name = rest.slice(id.length).trim();
      if (!id || !name) throw Error("/mcp rename connector-ID new-name");
      const renamed = await this.workbench.updateConnector(c.id, { name });
      this.detail = this.connectorList();
      this.scroll = 0;
      this.notice =
        `Renamed to ${renamed.name || name}. It is staged again, ` +
        "so it must be probed before use.";
      return;
    }
    this.confirmation = {
      title: `REMOVE ${c.name}?`,
      lines: [
        `${c.name} and its probed catalog are deleted from this workspace.`,
        "",
        "New conversations will not see it.",
        "A conversation that already started keeps the tools it snapshotted.",
      ],
      apply: async () => {
        this.workbench.removeConnector(c.id);
        this.detail = this.connectorList();
        this.scroll = 0;
        this.notice = `${c.name} removed. New conversations will not see it.`;
      },
    };
    this.scroll = 0;
  }
  async command(raw: string): Promise<"edit" | "quit" | void> {
    const value = raw.trim();
    if (!value) return;
    const match = /^\/(\S+)(?:\s+([\s\S]*))?$/.exec(value);
    if (!match) {
      if (value.startsWith("!")) {
        await this.runShell(value);
        return;
      }
      if (this.workbench.running()) {
        this.queuePrompt(raw);
        return;
      }
      // A selected host subscription takes the prompt instead of the provider
      // adapter. The run is not awaited here so /stop and the render loop keep
      // working while Workbench observes the host.
      if (this.hostSubscription) {
        this.choose("chat");
        void this.runHostPrompt(raw).catch((error) => {
          this.notice = message(error);
        });
        return;
      }
      let prompt = raw;
      if (this.sessionId) {
        const mentions = this.expandMentions(raw, this.sessionId);
        if (mentions.missing.length)
          throw Error(
            `Unknown @path: ${mentions.missing.join(", ")}. Mention a managed document.`,
          );
        prompt = mentions.expanded;
      }
      if (this.mode === "plan")
        prompt =
          "Plan only. Describe the steps and the documents that would " +
          `change. Do not request state changing tools yet.\n\n${prompt}`;
      if (this.sessionId)
        this.workbench.send(this.sessionId, prompt, randomUUID());
      else
        this.useSession(
          (
            await this.workbench.start(
              prompt,
              this.model || undefined,
              randomUUID(),
              this.projectId,
              this.agentId,
            )
          ).id,
        );
      this.choose("chat");
      return;
    }
    const cmd = match[1]!,
      arg = match[2]?.trim() ?? "";
    // Record frecency for palette (slash commands only, not shell or prompts).
    const fullCmd = "/" + cmd;
    const baseState: PaletteState = {
      query: "",
      selected: 0,
      visible: 8,
      recent: this.paletteState?.recent ?? new Map(),
    };
    const updated = recordPaletteCommand(baseState, fullCmd);
    this.paletteState = { recent: new Map(updated.recent) };
    if (cmd === "runs") {
      this.choose("runs");
      this.filter = arg;
      return;
    }
    if (cmd === "mcp") {
      await this.mcpCommand(arg);
      return;
    }
    const tab = workspaceTab(cmd);
    if (cmd === "models") {
      await this.openModelPicker();
      return;
    }
    if (tab) {
      this.choose(tab);
      this.filter = arg;
      return;
    }
    if (cmd === "expand") {
      this.toolActivityMode = "expanded";
      this.notice = "Agent activity: expanded.";
      return;
    }
    if (cmd === "quit" || cmd === "exit") return "quit";
    if (cmd === "cancel") {
      this.queuePrompt(undefined);
      this.notice = "Queued prompt cancelled.";
      return;
    }
    if (cmd === "plan") {
      this.setPlanMode();
      return;
    }
    if (cmd === "stats") {
      this.choose("usage");
      this.detail = this.costLines();
      this.scroll = 0;
      return;
    }
    if (cmd === "diff") {
      if (!this.sessionId) throw Error("Select a conversation.");
      // openOperations, not a second copy of the filter: /diff, /diff-next and
      // rediff all have to agree on which changes are outstanding, and three
      // copies of that predicate is how one of them ends up out of step.
      const open = this.openOperations();
      if (!open.length) {
        this.diffView = undefined;
        this.detail = ["No outstanding changes. Every edit is undone or kept."];
        this.scroll = 0;
        return;
      }
      // Each operation gets its own panel rather than one concatenated
      // diff. A single stream of hunks from several files is impossible to
      // review, because a line number means nothing without knowing which
      // file it came from.
      this.diffIndex = 0;
      this.diffView = undefined;
      this.detail = this.diffDetailLines(open);
      this.scroll = 0;
      return;
    }
    if (cmd === "diff-next") {
      const open = this.openOperations();
      if (!open.length) throw Error("No outstanding changes to step through.");
      this.diffIndex = (this.diffIndex + 1) % open.length;
      // A different operation is a different document, so the cursor and the
      // staged flags from the previous one do not carry over.
      this.diffView = undefined;
      this.detail = this.diffDetailLines(open);
      this.scroll = 0;
      this.notice = `Diff ${this.diffIndex + 1} of ${open.length}.`;
      return;
    }
    if (cmd === "pet") {
      // /pet on | /pet off | /pet dock | /pet perch, and /pet alone reports
      // the current state. A display choice only: it never sends a prompt,
      // never inserts text and never touches the draft. Every real choice is
      // also remembered for this workspace, so a restart keeps it.
      const choice = arg.toLowerCase();
      if (choice === "on" || choice === "auto") {
        this.petEnabled = true;
        this.petPlacement = "auto";
        this.savePetPreference();
        this.notice = "Pet is on. Alt+N hides it again.";
        return;
      }
      if (choice === "off") {
        this.petEnabled = false;
        this.petPlacement = "off";
        this.savePetPreference();
        this.notice = "Pet is off. Alt+N shows it again.";
        return;
      }
      if (choice === "dock" || choice === "perch") {
        this.petEnabled = true;
        this.petPlacement = choice;
        this.savePetPreference();
        this.notice =
          choice === "dock"
            ? "Pet docks on the composer rail when the terminal has room."
            : "Pet perches in the header when the header has room.";
        return;
      }
      this.notice = `Pet is ${this.petEnabled ? `on (${this.petPlacement})` : "off"}. Use /pet on or /pet off; /pet dock or /pet perch chooses the spot.`;
      return;
    }
    if (cmd === "keybindings") {
      this.keybindingQuery = arg ?? "";
      this.keybindingDetail = true;
      this.detail = keybindingLines(this.keybindingQuery, 72);
      this.scroll = 0;
      if (this.notice === COMMAND_PALETTE_NOTICE) this.notice = "";
      return;
    }
    if (cmd === "theme") {
      // /theme [color-theme] [symbol-preset] | list | preview | reset
      // Choices are saved in local TUI state by the command submit path;
      // explicit environment values remain higher-priority overrides.
      const themes = Object.keys(COLOR_THEMES) as ColorTheme[];
      const symbols = Object.keys(SYMBOL_SETS) as SymbolPreset[];

      if (!arg) {
        this.detail = [
          `THEME: ${this.themeConfig.colorTheme} + ${this.themeConfig.symbolPreset}`,
          "",
          "Usage: /theme <color-theme> [symbol-preset] | preview <color-theme> [symbol-preset] | list | reset",
          "Theme choices save locally. NOMO_TUI_THEME and NOMO_TUI_SYMBOLS override them on the next launch.",
          "",
          "Color themes:",
          ...themes.map(
            (t) => `  ${t === this.themeConfig.colorTheme ? "▸" : " "} ${t}`,
          ),
          "",
          "Symbol presets:",
          ...symbols.map(
            (s) => `  ${s === this.themeConfig.symbolPreset ? "▸" : " "} ${s}`,
          ),
          "",
          "The nerd preset uses Codicons glyphs and requires a compatible Nerd Font.",
          "Examples: /theme paper unicode  |  /theme dark  |  /theme preview solarized-dark classic",
        ];
        this.scroll = 0;
        return;
      }

      const parts = arg.split(/\s+/);
      const sub = parts[0].toLowerCase();

      if (sub === "list") {
        this.detail = [
          "COLOR THEMES:",
          ...themes.map((t) => `  ${t}`),
          "",
          "SYMBOL PRESETS:",
          ...symbols.map((s) => `  ${s}`),
        ];
        this.scroll = 0;
        return;
      }

      if (sub === "preview") {
        const color = (parts[1] ?? "").toLowerCase() as ColorTheme;
        const symbol = (parts[2] ?? "").toLowerCase() as SymbolPreset;
        if (!themes.includes(color) || !symbols.includes(symbol)) {
          throw Error(
            `Unknown theme or preset. Use: /theme preview <color> <symbol>`,
          );
        }
        const old = this.themeConfig;
        this.themeConfig = { colorTheme: color, symbolPreset: symbol };
        this.notice = `Preview: ${color} + ${symbol}. ${symbol === "nerd" ? "A compatible Nerd Font is required. " : ""}Press Enter to keep, /theme reset to revert.`;
        this.scroll = 0;
        return;
      }

      if (sub === "reset") {
        this.themeConfig = getThemeConfig(this.env);
        this.notice = `Theme reset to environment defaults (${this.themeConfig.colorTheme} + ${this.themeConfig.symbolPreset}).`;
        this.scroll = 0;
        return;
      }

      const color = sub as ColorTheme;
      const symbol = (parts[1] ?? "").toLowerCase() as SymbolPreset;

      if (!themes.includes(color))
        throw Error(`Unknown color theme: ${color}. Run /theme list.`);
      if (symbol && !symbols.includes(symbol))
        throw Error(`Unknown symbol preset: ${symbol}. Run /theme list.`);

      this.themeConfig = {
        colorTheme: color,
        symbolPreset: symbol ?? this.themeConfig.symbolPreset,
      };
      this.notice = `Theme ${this.themeConfig.colorTheme} + ${this.themeConfig.symbolPreset} saved locally.${this.themeConfig.symbolPreset === "nerd" ? " A compatible Nerd Font is required." : ""} Explicit NOMO_TUI_THEME/NOMO_TUI_SYMBOLS values override it on the next launch.`;
      this.scroll = 0;
      return;
    }
    if (cmd === "status") {
      this.choose("status");
      this.notice = healthSummary(this.healthChecks());
      return;
    }
    if (cmd === "health") {
      this.choose("status");
      this.notice = healthSummary(this.healthChecks());
      return;
    }
    if (cmd === "discover") {
      this.choose("help");
      this.detail = discoverLines(this.layoutColumns);
      this.scroll = 0;
      return;
    }
    if (cmd === "context") {
      if (!this.sessionId) {
        this.choose("documents");
        this.notice = "Select a conversation for live context numbers.";
        return;
      }
      const ctx = this.contextNumbers();
      this.choose("documents");
      this.detail = [
        `CONTEXT ${this.session()?.title ?? this.sessionId}`,
        "",
        `Model: ${this.session()?.model ?? this.model}`,
        `Messages: ${ctx.messages} in the complete transcript`,
        `Retained context messages: ${ctx.contextMessages ?? "unknown"}`,
        "Context token use and model limit: unknown",
        `Cumulative provider tokens: ${ctx.tokens ?? "unknown"}`,
        "Cost: unknown",
        `Managed documents: ${ctx.docs}`,
        "",
        ...this.workbench
          .documentsList()
          .filter((item) => item.sessionId === this.sessionId)
          .map((item) => `${item.path} ${item.bytes} B`),
      ];
      this.scroll = 0;
      return;
    }
    if (cmd === "permissions") {
      this.choose("policy");
      this.notice =
        "Connector policy stays authoritative. Use /tools for the catalog.";
      return;
    }
    if (cmd === "clear") {
      this.sessionId = undefined;
      this.documentPath = undefined;
      this.choose("chat");
      this.notice =
        "New conversation. Prior history remains available in /sessions.";
      return;
    }
    if (cmd === "cost") {
      this.choose("usage");
      this.detail = this.costLines();
      this.scroll = 0;
      return;
    }
    if (cmd === "queue") {
      if (arg && arg !== "resume") throw Error("/queue [resume]");
      if (arg === "resume") {
        if (this.confirmation)
          throw Error(
            "Finish or cancel the review before resuming queued text.",
          );
        if (this.queueBlockedByRuntime())
          throw Error(
            "The runtime is not ready. Reconcile unknown or stopping work before resuming queued text.",
          );
        if (this.lastRecoveryJob) {
          const status = await this.workbench.recoveryJobStatus(
            this.lastRecoveryJob.sessionId,
            this.lastRecoveryJob.jobId,
          );
          if ("status" in status && status.status === "unknown")
            throw Error(
              "Recovery outcome is unknown. Reconcile it before resuming queued text.",
            );
        }
        this.queuedPromptPaused = false;
      }
      const queued = this.queuedPrompt;
      this.detail = [
        "QUEUED MESSAGE",
        "",
        queued ? `Pending: ${queued}` : "No queued prompt.",
        "",
        this.queuedPromptPaused
          ? "Paused after recovery. Reconcile the outcome, then use /queue resume explicitly."
          : "The queued prompt waits for runtime dispatch to be allowed and for all reviews to close.",
        "Use /cancel to cancel the queued prompt.",
        "",
        ...(queued
          ? ["⚠️ Queued prompt is active - use /cancel to remove it."]
          : []),
      ];
      this.scroll = 0;
      return;
    }
    if (cmd === "compact") {
      this.prepareCompact();
      return;
    }
    if (cmd === "todos") {
      const session = this.session();
      if (!session) throw Error("Select a conversation.");
      // The same derivation the rail and the chip read, so the detail view
      // cannot disagree with the frame behind it about the checklist.
      const summary = chatEventSummary(session.events);
      const todos = summary.todos;
      const open = summary.openTodos;
      this.detail = [
        `Latest agent checklist, ${open} open of ${todos.length}`,
        "",
        ...(todos.length
          ? todos.map(
              (item) =>
                `${item.done ? "[x]" : item.status === "in_progress" ? "[~]" : "[ ]"} ${item.text} (#${item.seq})`,
            )
          : ["No checklist items in this conversation yet."]),
      ];
      this.scroll = 0;
      return;
    }
    if (cmd === "projects" || cmd === "project") {
      if (cmd === "project" && arg) {
        const project = this.workbench
          .listProjects()
          .find((item) => item.id === arg);
        if (arg !== "none" && !project)
          throw Error("Unknown project. Use /projects for IDs.");
        this.projectId = project?.id;
      }
      this.detail = [
        "PROJECTS",
        `Selected for new conversations: ${this.projectId ?? "none"}`,
        ...this.workbench
          .listProjects()
          .map(
            (item) =>
              `${item.id === this.projectId ? ">" : " "} ${item.id}: ${item.name} / ${item.root}`,
          ),
        "",
        "/project ID selects; /project none clears. Existing conversations do not change.",
        "/project-file path.json creates or updates a project after review.",
        'File fields: {"name":"Project name","root":"/descriptive/root"}',
        "A project root is descriptive. It grants no access to host files.",
      ];
      this.scroll = 0;
      return;
    }
    if (cmd === "project-file") {
      if (!arg) throw Error("/project-file path.json");
      const input = JSON.parse(await readFile(resolve(arg), "utf8"));
      this.confirmation = {
        title: "SAVE PROJECT?",
        lines: [...json(input), "Project roots grant no filesystem authority."],
        apply: async () => {
          const project = this.workbench.upsertProject(input);
          this.projectId = project.id;
          this.detail = ["PROJECT SAVED", ...json(project)];
          this.notice = "Project selected for new conversations only.";
        },
      };
      this.scroll = 0;
      return;
    }
    if (cmd === "agent-file" || cmd === "hook-file") {
      const catalog = this.workbench.agents();
      if (cmd === "hook-file" && !catalog.hooksSupported)
        throw Error(
          "Hook execution is unsupported on this host. No operator allowlist is enabled.",
        );
      if (!arg) throw Error(`/${cmd} path.json`);
      const input = JSON.parse(await readFile(resolve(arg), "utf8"));
      this.confirmation = {
        title: cmd === "agent-file" ? "SAVE AGENT PROFILE?" : "SAVE HOOK?",
        lines: [
          ...json(input),
          "",
          "The Workbench validates tool access, policy and operator allowlists.",
          "Existing conversations keep their profile snapshot.",
        ],
        apply: async () => {
          this.confirmation = undefined;
          if (cmd === "agent-file") {
            const profile = this.workbench.upsertAgent(input);
            this.agentId = profile.id;
            this.detail = ["AGENT PROFILE SAVED", ...json(profile)];
            this.notice = "Profile selected for new conversations only.";
          } else {
            const hook = this.workbench.upsertHook(input);
            this.detail = ["HOOK SAVED", ...json(hook)];
            this.notice = "Hook configuration saved by the Workbench.";
          }
        },
      };
      this.scroll = 0;
      return;
    }
    if (cmd === "hooks") {
      const catalog = this.workbench.agents();
      this.detail = [
        "HOOKS",
        catalog.hooksSupported
          ? "Hooks are validated against the runtime operator allowlist."
          : "Hook execution is unsupported on this host. No operator allowlist is enabled.",
        `Allowed commands: ${catalog.hookCommands.join(", ") || "none"}`,
        ...json(catalog.hooks),
        ...(catalog.hooksSupported
          ? ["/hook-file path.json reviews a hook before saving."]
          : []),
      ];
      this.scroll = 0;
      return;
    }
    if (cmd === "hook") {
      const [action, id] = (arg ?? "").split(/\s+/).filter(Boolean);
      if (action !== "enable" && action !== "disable")
        throw Error("/hook enable id | /hook disable id");
      const catalog = this.workbench.agents();
      const hook = catalog.hooks.find((item) => item.id === id);
      if (!hook) throw Error("Unknown hook. Use /hooks for ids.");
      // Re-saving the same hook with the flag flipped rather than adding one:
      // the id is what ties a hook to its runs, and `upsertHook` re-checks the
      // operator allowlist on the way through either way.
      const saved = this.workbench.upsertHook({
        ...hook,
        enabled: action === "enable",
      });
      this.detail = [`HOOK ${action.toUpperCase()}D`, ...json(saved)];
      this.notice = `Hook ${action}d. Existing conversations keep their hook snapshot.`;
      this.scroll = 0;
      return;
    }
    if (cmd === "agents" || cmd === "agent") {
      if (cmd === "agent" && arg) {
        const agent = this.workbench
          .agents()
          .agents.find((item) => item.id === arg);
        if (!agent) throw Error("Unknown agent. Use /agents for IDs.");
        this.agentId = agent.id;
      }
      this.detail = this.agentsLines();
      this.scroll = 0;
      return;
    }
    if (cmd === "learned") {
      // The rules are mined from the verified chain, not recomputed from a
      // snapshot: `proofs` only ever holds entries `ledger()` returned as
      // verified, so an unverified or tampered refusal cannot teach a rule.
      // Every visible workspace, not just the selected one: a rule learned in
      // one conversation is still in force in the next, and an operator asking
      // what NOMO has learned is asking about the ledger as a whole.
      const learned = [...this.proofs.entries()].flatMap(([id, entries]) =>
        mineLearnedRules(entries).map((rule) => ({ id, rule })),
      );
      const verified = [...this.proofs.values()].reduce(
        (sum, e) => sum + e.length,
        0,
      );
      // Per workspace, mirror the ledger tab's rule rows: a workspace that
      // taught nothing still speaks, and in the tab's words, so the command
      // and the tab cannot disagree about what "nothing observed" means.
      const perWorkspace = [...this.proofs.entries()].flatMap(
        ([id, entries]) => {
          const rules = mineLearnedRules(entries);
          return rules.length
            ? rules.flatMap((rule) => [
                `${id.slice(0, 8)} ${rule.match.tool} (${rule.match.class}) -> ${rule.decision}`,
                `  ${rule.rationale ?? "no rationale recorded"}`,
              ])
            : [
                entries.length
                  ? `0 recurring refusals across ${entries.length} verified ${entries.length === 1 ? "entry" : "entries"}.`
                  : "0 verified entries, so no refusal has been observed and no rule was mined.",
              ];
        },
      );
      this.detail = [
        "LEARNED RULES, mined from the verified chain",
        "",
        ...(verified
          ? [
              `${verified} verified entries, ${learned.length} recurring refusals.`,
              "",
            ]
          : this.proofs.size === 0
            ? [
                "0 verified entries, so no refusal has been observed and no rule was mined.",
                "",
              ]
            : []),
        ...perWorkspace,
        ...(perWorkspace.length ? [""] : []),
        "A learned rule is evidence, not authority: it is appended after the",
        "operator's own rules, and under the mandatory terminal catch-all it never binds.",
      ];
      this.scroll = 0;
      return;
    }
    if (cmd === "config") {
      this.detail = [
        "CONFIG, secret values never print",
        "",
        ...resolveConfig(this.env).map(
          (entry) => `${entry.key}: ${entry.value} [${entry.source}]`,
        ),
      ];
      this.scroll = 0;
      return;
    }
    if (cmd === "settings") {
      const [key, raw] = arg.split(/\s+/).filter(Boolean);
      if (!key) {
        this.settingsOpen = true;
        this.settingsEdit = undefined;
        this.settingsQuery = "";
        this.settingsQueryCursor = 0;
        this.settingsSelected = Math.max(
          0,
          Math.min(this.settingsSelected, this.settingsControls().length - 1),
        );
        this.detail = this.settingsLines();
        this.scroll = 0;
        return;
      }
      if (raw === undefined)
        throw Error("/settings key value, or /settings alone to list them.");
      this.applySetting(key, raw);
      const selected = this.settingsControls().findIndex(
        (row) => row.key === key,
      );
      if (selected >= 0) this.selectSetting(selected);
      this.scroll = 0;
      return;
    }
    if (cmd === "memory") {
      this.detail = this.memoryLines();
      this.scroll = 0;
      return;
    }
    if (cmd === "vim" || cmd === "terminal-setup" || cmd === "output-style")
      throw Error(
        `/${cmd} has no NOMO equivalent. Use /expand for tool output style.`,
      );
    if (cmd === "resume") {
      if (!arg) {
        this.choose("sessions");
        this.notice =
          "Enter opens a conversation. Use /resume NUMBER or /resume ID to open it directly.";
        return;
      }
      const rows = [...this.workbench.list()].reverse();
      const selected =
        rows.find((item) => item.id === arg) ?? rows[Number(arg) - 1];
      if (!selected) throw Error("/resume conversation-number-or-ID");
      this.useSession(selected.id);
      this.choose("chat");
      return;
    }
    if (cmd === "recovery") {
      await this.showRecovery(arg || undefined);
      return;
    }
    if (cmd === "rewind") {
      if (arg) {
        const ids = arg.split(/\s+/);
        if (ids[0] === "run") {
          if (ids.length !== 2) throw Error("/rewind run exact-run-ID");
          await this.prepareRecovery({ kind: "run", runId: ids[1]! });
        } else if (ids.length > 1) {
          await this.prepareRecovery({ kind: "operations", operationIds: ids });
        } else await this.prepareUndo(arg);
        return;
      }
      const sessionId = this.sessionId;
      if (!sessionId) {
        this.choose("ledger");
        this.notice =
          "Select a conversation to rewind its recoverable operations.";
        return;
      }
      this.choose("ledger");
      this.filter = sessionId;
      const recoverable = this.items().findIndex(
        (row) => row.operationId && row.sessionId === sessionId,
      );
      if (recoverable < 0) {
        this.notice = "No recoverable operations in this conversation.";
        return;
      }
      const selected = this.items()[recoverable];
      const deps = selected.label.match(/\(([^)]+)\)/);
      if (deps) {
        this.notice = `Dependency warning: ${deps[1]}. Press u for reviewed Undo.`;
      } else {
        this.notice =
          "Latest recoverable operation selected. Press u for reviewed Undo.";
      }
      this.selected = recoverable;
      return;
    }
    if (cmd === "doctor") {
      const lines: string[] = [];
      const code = await runDoctorCommand(
        arg ? [arg] : [],
        {
          stdout: (line) => {
            lines.push(line);
          },
          stderr: (line) => {
            lines.push(line);
          },
        },
        { env: this.env },
      );
      this.detail = [`doctor exit ${code}`, "", ...lines];
      this.scroll = 0;
      return;
    }
    if (cmd === "conformance") {
      const adapter = arg || "managed-documents";
      if (
        adapter !== "managed-documents" &&
        adapter !== "filesystem.managed" &&
        adapter !== "git.managed"
      )
        throw Error(
          "/conformance managed-documents | filesystem.managed | git.managed",
        );
      // Disposable fixtures only, same command the release gate runs. Slow
      // adapters block the prompt with the busy spinner, never silently.
      const lines: string[] = [];
      const code = await runConformanceCommand(
        ["--adapter", adapter],
        (line) => {
          lines.push(line);
        },
      );
      let summary = "report is not JSON";
      try {
        const report = JSON.parse(lines.join("\n")) as {
          passed: boolean;
          scenarios: {
            operation: string;
            passed: boolean;
            checks: { id: string; passed: boolean }[];
          }[];
        };
        summary = report.scenarios
          .map((scenario) => {
            const failed = scenario.checks.filter((check) => !check.passed);
            return `${scenario.operation}: ${scenario.passed ? "PASS" : `FAIL ${failed.map((check) => check.id).join(",")}`}`;
          })
          .join(" | ");
        this.detail = [
          `conformance ${adapter} exit ${code}, passed: ${report.passed}`,
          `capability: ${adapter} v1, certification: false`,
          "",
          ...report.scenarios.flatMap((scenario) => [
            `${scenario.operation}: ${scenario.passed ? "PASS" : "FAIL"}`,
            ...scenario.checks.map(
              (check) => `  ${check.passed ? "[+]" : "[x]"} ${check.id}`,
            ),
          ]),
        ];
      } catch {
        this.detail = [`conformance ${adapter} exit ${code}`, ...lines];
      }
      this.scroll = 0;
      this.notice =
        code === 0
          ? `Conformance ${adapter} passed: ${summary}`
          : `Conformance ${adapter} FAILED: ${summary}`;
      return;
    }
    if (cmd === "init") {
      const lines: string[] = [];
      const code = await runInitCommand(
        arg ? [arg] : [],
        {
          stdout: (line) => {
            lines.push(line);
          },
          stderr: (line) => {
            lines.push(line);
          },
        },
        { env: this.env },
      );
      this.detail = [`init exit ${code}`, "", ...lines];
      this.scroll = 0;
      const target = this.sessionId;
      if (target && !this.workbench.running()) {
        try {
          const starter = this.workbench.document(target, "plan.md");
          if (!starter.content?.trim()) {
            await this.workbench.editDocument(
              target,
              { path: "plan.md", content: STARTER_DOC, expectedRevision: null },
              "tui-operator",
            );
            this.notice = "Storage ready. A starter plan.md was created.";
          } else this.notice = "Storage ready. plan.md already exists.";
        } catch (error) {
          this.notice = `Storage ready. Starter doc skipped: ${message(error)}`;
        }
      } else if (!target)
        this.notice = "Storage ready. Open a conversation for plan.md.";
      return;
    }
    if (cmd === "logout") {
      const hadHost = this.hostSubscription !== undefined;
      // Clearing the provider can refuse while a run is active, so it runs
      // first: a refusal must leave the host selection exactly as it was.
      this.workbench.clearProvider();
      this.clearHostSubscription();
      this.provider = await this.workbench.providerState();
      this.modelProjection = this.workbench.providerModelsProjection();
      this.model = "";
      this.modelCatalogStatus =
        this.provider.connected && this.provider.models.length > 0
          ? "ready"
          : "unavailable";
      this.notice = hadHost
        ? "Host subscription selection cleared. The host keeps its own login; sign out there to revoke it."
        : "Logged out locally. Saved provider profiles were removed; revoke keys with their providers.";
      return;
    }
    if (cmd === "bottom") {
      this.choose("chat");
      this.scroll = -1;
      this.notice = "Following latest messages.";
      return;
    }
    if (cmd === "find") {
      if (!arg) throw Error("/find text: search this conversation");
      const events = this.session()?.events;
      if (!events) throw Error("Select a conversation.");
      const matches = events.filter(
        (e) =>
          e.type !== "message.delta" &&
          e.type !== "run.status" &&
          e.kind !== "usage" &&
          e.text.toLocaleLowerCase().includes(arg.toLocaleLowerCase()),
      );
      this.detail = [
        `Search: ${arg}`,
        `${matches.length} matching messages`,
        "",
        ...transcript(matches),
      ];
      this.scroll = 0;
      this.notice = "Search results / PgUp PgDn scroll / Esc close";
      return;
    }
    if (cmd === "new") {
      this.sessionId = undefined;
      this.documentPath = undefined;
      this.choose("chat");
      if (arg) await this.command(arg);
      return;
    }
    if (cmd === "open") {
      const rows = [...this.workbench.list()].reverse();
      const s = rows.find((s) => s.id === arg) ?? rows[Number(arg) - 1];
      if (!s) throw Error("/open conversation-number-or-ID");
      this.useSession(s.id);
      this.choose("chat");
      return;
    }
    if (cmd === "subagent") {
      const selected = this.session();
      if (!selected?.parentId)
        throw Error("Select a verified spawned child in sessions.");
      if (arg === "cancel") {
        const parentId = selected.parentId;
        const childId = selected.id;
        await this.workbench.verifySubagent(parentId, childId);
        const current = this.workbench.get(childId);
        if (!current || current.parentId !== parentId)
          throw Error(
            "Selected child relationship changed. Refresh the sessions inspector.",
          );
        if (!["running", "queued", "paused"].includes(current.status))
          throw Error("This child is not in a cancellable state.");
        const apply = async () =>
          this.workbench.cancelSubagent(parentId, childId);
        if (current.status === "running" || current.state === "stopping") {
          this.confirmation = {
            title: "CANCEL RUNNING SUBAGENT?",
            lines: [
              `Child: ${childId}`,
              `Parent: ${parentId}`,
              "A dispatched tool may still complete.",
              "Capacity remains occupied until the run settles.",
            ],
            apply,
          };
        } else await apply();
        return;
      }
      if (arg === "review") {
        const result = await this.workbench.subagentResult(
          selected.parentId,
          selected.id,
        );
        if (!result) throw Error("No settled successful result is available.");
        const current = this.workbench.get(selected.id);
        if (
          !current ||
          current.parentId !== selected.parentId ||
          current.runId !== result.runId
        )
          throw Error("Subagent run changed. Refresh the sessions inspector.");
        const preview = escapeTerminalText(result.text);
        const lines = [
          `Child: ${result.childId}`,
          `Parent: ${current.parentId}`,
          `Run: ${result.runId}`,
          `Status: ${current.status}`,
          "Source: latest assistant completion for this successful run.",
          "Content is untrusted; review before acting.",
          "",
          preview,
        ];
        if (result.truncated) {
          this.detail = [
            ...lines,
            "",
            "Delivery unavailable: result may be incomplete.",
          ];
          this.notice =
            "Result may be truncated; preview only, delivery blocked.";
          return;
        }
        this.confirmation = {
          title: "DELIVER SUBAGENT RESULT?",
          lines,
          apply: async () =>
            this.workbench.deliverSubagentResult(
              current.parentId!,
              current.id,
              result.runId,
            ),
        };
        return;
      }
      throw Error("/subagent cancel|review");
    }
    if (cmd === "revoke-agent") {
      if (!arg) throw Error("/revoke-agent agent-id");
      const sessions = this.workbench
        .allViews()
        .filter((view) => view.agent === arg);
      if (!sessions.length)
        throw Error("No local Workbench session uses that agent identity.");
      if (this.workbench.isAgentRevoked(arg))
        throw Error(`Agent ${arg} is already revoked locally.`);
      const latest = sessions.at(-1)!;
      const workspaceCount = new Set(sessions.map((view) => view.workspace)).size;
      this.confirmation = {
        title: `LOCAL AGENT REVOKE ${arg}?`,
        lines: [
          `Agent: ${arg}`,
          `Principal: ${LOCAL_AGENT_PRINCIPAL_ID}`,
          `Workspace: ${latest.workspace}`,
          `Run: ${latest.runId ?? "none"}`,
          `Known local sessions: ${sessions.length} in ${workspaceCount} workspace(s).`,
          "",
          "This local Workbench will stop its sessions for the agent, drop every local grant,",
          "refuse new grants and new runs for it, and append signed agent_revoke evidence.",
          "This does not revoke the agent on any other node. Fleet-wide revoke is unavailable",
          "because NOMO has no node inventory or acknowledgement barrier.",
        ],
        apply: async () => {
          const result = await this.workbench.revokeAgent(arg, "tui-operator");
          this.notice = `Local agent ${arg} revoked: ${result.stoppedSessions.length} session(s) stopped, ${result.droppedGrants} grant(s) dropped.`;
          this.detail = [
            `LOCAL AGENT ${arg} REVOKED`,
            "Scope: this Workbench and the signed workspace evidence it wrote.",
            "Fleet-wide revoke remains unavailable: no node inventory or acknowledgement barrier exists.",
          ];
        },
      };
      this.scroll = 0;
      return;
    }
    if (cmd === "stop") {
      if (!this.sessionId) throw Error("Select a running conversation.");
      // A host session stops through Workbench like any other run, so the
      // cancellation and whatever it could prove land in the same ledger.
      const hostOnly = this.session()?.hostOnly === true;
      this.workbench.stopRun(this.sessionId);
      this.notice = hostOnly
        ? "Host stop requested. The host owns its process; its outcome may stay unproven."
        : "Stop requested. A dispatched tool may still complete; /runs shows the confirmed state.";
      return;
    }
    if (cmd === "retry" || cmd === "branch") {
      const s = this.session();
      const seq = arg
        ? Number(arg)
        : [...(s?.events ?? [])].reverse().find((e) => e.kind === "user")?.seq;
      if (!s || !seq) throw Error("Select a message to branch from.");
      if (this.workbench.running())
        throw Error("Wait for cancellation to finish.");
      const intent =
        this.branchIntent?.sessionId === s.id &&
        this.branchIntent.seq === seq &&
        this.branchIntent.command === cmd
          ? this.branchIntent
          : (this.branchIntent = {
              sessionId: s.id,
              seq,
              command: cmd,
              key: randomUUID(),
            });
      const child = await this.workbench.branch(s.id, {
        seq,
        snapshotDocuments: true,
        idempotencyKey: intent.key,
      });
      this.branchIntent = undefined;
      this.useSession(child.id);
      this.choose("chat");
      this.notice =
        "Branch created. Historical tools are not replayed. Write your next prompt.";
      if (cmd === "retry") {
        const key = randomUUID();
        this.confirmation = {
          title: "RETRY IN A NEW BRANCH?",
          lines: [
            "The model will respond to the previous prompt again.",
            "Current documents are copied. New tool calls go through NOMO again.",
            "Historical tools are not replayed.",
          ],
          apply: async () => {
            this.workbench.send(
              child.id,
              "Respond to the preceding user message. Inspect existing documents before making changes.",
              key,
            );
          },
        };
      }
      return;
    }
    if (cmd === "model") {
      if (!this.activeModelCatalog().some((model) => model.id === arg))
        throw Error(
          "Select a current connected-provider model ID from /models.",
        );
      this.workbench.patchPreferences({ defaultModel: arg });
      this.model = arg;
      if (this.provider)
        this.provider = { ...this.provider, defaultModel: arg };
      this.notice = `Model for new conversations: ${arg}; active conversation keeps its model.`;
      return;
    }
    if (cmd === "connect" || cmd === "login") {
      if (!arg) {
        this.provider = await this.workbench.providerState({
          reconnectEnvironment: true,
        });
        this.modelProjection = this.workbench.providerModelsProjection();
        this.model = this.provider.defaultModel ?? "";
        this.modelCatalogStatus =
          this.provider.connected && this.provider.models.length > 0
            ? "ready"
            : "unavailable";
        this.detail = this.providerLines();
        // Three outcomes, not two. A workspace with nothing configured is told
        // to set a key; a workspace whose configured key was rejected is told
        // what the provider reported, because repeating the setup advice would
        // send the operator to re-enter a credential that already exists.
        this.notice = this.provider.connected
          ? "Current provider is connected. /sources lists local imports; /connect SOURCE-ID selects one."
          : this.provider.setupRequired
            ? "No provider is connected. Set an API key in the host environment or use /sources and /connect SOURCE-ID. No key is accepted in chat."
            : `Provider ${String(this.provider.status)}: ${this.provider.detail ?? "the configured credential was not accepted"}. /status inspects it; no key is accepted in chat.`;
        this.scroll = 0;
        return;
      }
      // The vendor name an operator types is not the source ID: sources are
      // namespaced by the store they are imported from, so "nvidia" means the
      // OMP credential rather than a second spelling of the reconnect above.
      const requested = arg === "nvidia" ? "omp:nvidia" : arg;
      const sources = await this.refreshConnectSources();
      const hostProvider = HOST_CLI_PROVIDERS.find(
        (provider) => provider.sourceId === requested,
      );
      if (hostProvider) {
        const source = sources.find((candidate) => candidate.id === requested);
        // Discovery is the authority for a host subscription: a missing host,
        // a logged-out host or an API-key-only host is a clear unavailable
        // state, never a run that pretends to be connected. When discovery
        // returned nothing, the host itself is asked before selecting.
        const reason = source
          ? source.available
            ? undefined
            : "reason" in source
              ? source.reason
              : undefined
          : (await probeHostCli(hostProvider.host, this.env)).reason;
        if (reason !== undefined)
          throw Error(
            [
              `Host subscription ${requested} is unavailable: ${
                HOST_AVAILABILITY[String(reason)] ?? "host unavailable"
              }.`,
              `Sign in with the ${hostProvider.host} host, then run /connect ${requested} again.`,
              "NOMO never reads or stores the host credential.",
            ].join("\n"),
          );
        this.selectHostSubscription(hostProvider);
        return;
      }
      // Discovery owns the ID list, so an unknown ID is refused with the IDs
      // that do exist instead of reaching the importer. When discovery
      // returned nothing the importer keeps the final word, because an empty
      // list cannot prove an ID is invalid.
      if (
        sources.length &&
        !sources.some((source) => source.id === requested)
      )
        // One line per fact rather than one long line: the Chat notice band
        // wraps each line, so the ID list is readable instead of being cut
        // after the tenth entry. /providers repeats the whole list on a
        // surface that scrolls with PgDn.
        throw Error(
          [
            `Unknown source ID "${arg}".`,
            `Use /${cmd} with one of these ${sources.length} source IDs:`,
            sources.map((source) => source.id).join(", "),
            "All IDs: /providers (PgDn scrolls).",
          ].join("\n"),
        );
      this.provider = await importDesktopProvider(
        requested,
        this.env,
        this.workbench,
      );
      this.modelProjection = this.workbench.providerModelsProjection();
      this.model = this.provider.defaultModel ?? "";
      this.modelCatalogStatus =
        this.provider.connected && this.provider.models.length > 0
          ? "ready"
          : "unavailable";
      this.notice = `Connected to ${requested}. The key is stored encrypted.`;
      return;
    }
    if (cmd === "sources") {
      // The listing and the completion cache come from one scan, so the JSON
      // shown here is exactly the ID set /connect will accept next.
      const setup = await desktopSetup(this.env);
      this.rememberConnectSources(setup.sources);
      this.detail = json(setup);
      return;
    }
    if (cmd === "filter") {
      this.filter = arg;
      this.selected = 0;
      this.detail = undefined;
      this.keybindingDetail = false;
      return;
    }
    if (cmd === "verify") {
      await this.refresh(true);
      this.choose("ledger");
      // Third parties recheck without this software through the standalone
      // script, so the notice names it instead of hiding that path.
      const standalone =
        "Third parties recheck exports with packages/verifier/verify-ledger.mjs.";
      this.notice =
        this.proofErrors.size || this.proxy.errors.length
          ? `VERIFICATION FAILED. Review /status. ${standalone}`
          : `Verified ${[...this.proofs.values()].reduce((n, v) => n + v.length, 0)} signed entries. ${standalone}`;
      return;
    }
    if (cmd === "document") {
      if (!this.sessionId) throw Error("Select a conversation.");
      this.documentPath = arg;
      this.choose("documents");
      this.showDocument();
      return;
    }
    if (cmd === "edit") return "edit";
    if (cmd === "history") {
      if (!this.sessionId) throw Error("Select a document.");
      this.detail = this.workbench
        .workspace(this.sessionId)
        .operations.filter(
          (o) => !this.documentPath || o.path === this.documentPath,
        )
        .flatMap((o) => [...json(o), ""]);
      this.scroll = 0;
      return;
    }
    if (cmd === "undo") {
      await this.prepareUndo(arg || undefined);
      return;
    }
    if (cmd === "approve" || cmd === "deny") {
      const [id, ...reason] = arg.split(/\s+/);
      this.prepareApproval(
        cmd === "approve" ? "approved" : "denied",
        id || undefined,
        reason.join(" "),
      );
      return;
    }
    // Prompt proposals are inert until one of these names their exact digest.
    // Listing shows diffs; only approve activates, only reject settles, and
    // both refuse an unknown digest rather than guessing. Approval runs through
    // a confirmation that prints the complete proposal first: it is the one
    // path that changes the prompt every later conversation runs under.
    if (cmd === "harness") {
      const [verb = "", ...rest] = arg.split(/\s+/).filter(Boolean);
      if (verb === "scores") {
        const board = measureBoard(
          verifiedScoreCases(this.proofs),
          new Date().toISOString(),
        );
        this.detail = [
          `HARNESS SCORES, verdict: ${board.verdict}`,
          "Descriptive only; never changes a decision or permission.",
          "First-pass rate: unmeasured; no producer writes this metric yet.",
          `Case count: ${board.caseCount} verified tool-call case${board.caseCount === 1 ? "" : "s"}`,
          `Reason: ${board.reasons.join("; ")}.`,
          ...unmeasuredMetrics(board)
            .filter((key) => key !== "first_pass_rate")
            .map((key) => `${key}: no sample, so no rate can be computed.`),
        ];
        this.scroll = 0;
        return;
      }
      if (verb === "review") {
        if (!this.sessionId) throw Error("Select a conversation.");
        const sessionId = this.sessionId;
        this.confirmation = {
          title: "REQUEST A HARNESS REVIEW?",
          lines: [
            "This may spend one model call: the reviewer looks for a durable lesson in the signed chain.",
            "The settled-turn interval is skipped because you asked; the harness switch, the cooldown and the nothing-new check still apply, and a refusal costs nothing.",
            "If the conversation is running, the request is recorded and served at the next settled boundary.",
            "The reviewer can only propose. Nothing is activated without your approval.",
          ],
          apply: async () => {
            this.confirmation = undefined;
            const result = await this.workbench.requestHarnessReview(sessionId);
            const note = escapeTerminalText(result.note);
            this.notice = `Harness review ${result.kind}. ${note}`;
            this.detail = [
              `HARNESS REVIEW ${result.kind.toUpperCase()}`,
              "",
              note,
              ...(result.kind === "ran"
                ? [
                    "",
                    "The signed chain records the outcome. /harness lists any proposal awaiting a decision.",
                  ]
                : []),
              "",
              "The reviewer can only propose. Nothing is activated without your approval.",
            ];
            this.scroll = 0;
            await this.refresh(true);
          },
        };
        this.scroll = 0;
        return;
      }
      if (verb === "approve" || verb === "reject") {
        await this.prepareHarnessDecision(rest.join(" "), verb);
        return;
      }
      if (verb && verb !== "cloud" && verb !== "prime-agent")
        throw Error(
          "/harness cloud | prime-agent | scores | review | approve DIGEST | reject DIGEST",
        );
      if (verb) {
        this.workbench.patchPreferences({ defaultAgent: verb });
        this.notice =
          verb === "prime-agent"
            ? "Harness: prime-agent. New conversations route there when the bridge runs."
            : "Harness: cloud. New conversations run in the managed session.";
      }
      const prefs = this.workbench.getPreferences();
      const found = await detectHarnesses(this.env);
      const pending = this.sessionId
        ? await this.workbench.pendingApprovalsFor(this.sessionId)
        : [];
      this.detail = [
        `HARNESS, current default: ${prefs.defaultAgent ?? "cloud"}`,
        "",
        "cloud: managed session in this workspace, approvals in the TUI.",
        "prime-agent: local harness CLI for team agents, needs the bridge.",
        "",
        ...found.map(
          (item) => `${item.id}: ${item.path ?? "not detected on PATH"}`,
        ),
        "",
        ...pending.map(
          (approval) =>
            `${approval.digest.slice(0, 8)}… ${escapeTerminalText(approval.summary)} (${approval.proposal.edits.length} edits)`,
        ),
        pending.length
          ? "/harness approve DIGEST or /harness reject DIGEST opens the exact proposal for confirmation."
          : `No Harness proposal is awaiting a decision in this conversation (${this.sessionId ?? "none selected"}).`,
        "",
        "/harness cloud | /harness prime-agent switches the default; /harness scores reports verified chains.",
        "/harness review asks the reviewer by hand; /harness approve DIGEST or /harness reject DIGEST shows the complete proposal before confirmation.",
      ];
      this.scroll = 0;
      return;
    }
    if (cmd === "rename") {
      if (!this.sessionId) throw Error("Select a conversation.");
      this.workbench.patchSession(this.sessionId, { title: arg });
      return;
    }
    if (cmd === "archive") {
      if (!this.sessionId) throw Error("Select a conversation.");
      this.workbench.patchSession(this.sessionId, { archived: true });
      this.choose("sessions");
      return;
    }
    if (cmd === "policy-file") {
      const space = arg.indexOf(" ");
      const id = arg.slice(0, space),
        path = arg.slice(space + 1);
      if (space < 1) throw Error("/policy-file connector-ID path-to-YAML");
      const policy = await readFile(resolve(path), "utf8");
      if (!loadPolicy(policy).ok) throw Error("Invalid policy.");
      this.confirmation = {
        title: `CHANGE POLICY ${id}?`,
        lines: [
          policy,
          "",
          "Applies to new conversations; existing conversations keep their policy snapshot.",
        ],
        apply: async () => {
          await this.workbench.updateConnector(id, { policy });
          this.notice = "Policy saved. Start a new conversation.";
        },
      };
      return;
    }
    if (cmd === "connector-file") {
      const config = JSON.parse(await readFile(resolve(arg), "utf8"));
      const staged = (await this.workbench.addConnector(config)).connectors.at(
        -1,
      )!;
      this.choose("tools");
      // Staging contacts nothing, so saying "connected" here would be a claim
      // no request backs.
      this.notice =
        "MCP connector staged. Nothing was contacted; /mcp lists it.";
      this.detail = this.stagedView(staged);
      return;
    }
    if (cmd === "test-connector") {
      this.detail = json(await this.workbench.testConnector(arg));
      return;
    }
    if (cmd === "export") {
      await this.export(arg || "ledger");
      return;
    }
    if (cmd === "providers") {
      const current =
        this.provider?.providerId ??
        this.workbench.getPreferences().defaultProvider;
      const sources = await this.refreshConnectSources();
      const rows: string[] = [];
      const claimed = new Set<string>();
      for (const preset of PROVIDER_PRESETS) {
        const mapped = sourcesForPreset(preset, sources);
        for (const source of mapped) claimed.add(source.id);
        rows.push(...providerDirectoryLines(preset, current, mapped));
      }
      // A discovered credential whose vendor has no preset is still a choice
      // /connect accepts, so it is listed rather than silently dropped.
      const unlisted = sources.filter((source) => !claimed.has(source.id));
      this.detail = [
        PROVIDERS_DETAIL_TITLE,
        ...rows,
        ...(unlisted.length
          ? [
              "",
              "DISCOVERED SOURCES WITHOUT A PRESET",
              ...unlisted.map(
                (source) =>
                  `${source.id}  ${source.name}  auth=${sourceAuth(source)}` +
                  `  ${sourceAvailability(source)}`,
              ),
            ]
          : []),
        "",
        "Local entries need Ollama or LM Studio running on this machine.",
        "Keys stay encrypted in local provider storage, never in the repo.",
        `${[...ENV_CONNECT_PROVIDERS].join(", ")} also connect from a host environment key; /connect with no ID re-reads it.`,
        "auth=oauth is declared by the provider, but this terminal has no OAuth lifecycle.",
        "auth=host-subscription runs through the installed host CLI; the login and token stay in that host.",
        "auth=unsupported has no local source or host key path here; configure it outside this terminal.",
      ];
      this.scroll = 0;
      return;
    }
    if (cmd === "attest") {
      if (!this.sessionId) throw Error("Select a conversation.");
      // Signed slice of this conversation for a third party. The bundle
      // from /export ledger plus this document verify fully offline.
      const doc = await this.workbench.attest(this.sessionId);
      this.detail = [
        `ATTESTATION ${this.session()?.title ?? this.sessionId}`,
        "",
        ...json(doc),
        "",
        "Check offline: standalone verifier --attestation this file.",
      ];
      this.scroll = 0;
      this.notice = `Attested ${doc.entriesCount} entries, head ${doc.headHash.slice(0, 16)}.`;
      return;
    }
    if (cmd === "command-palette") {
      // The palette is a live overlay, not a printed list. Open it explicitly
      // with /command-palette or choose it from a command suggestion.
      // Palette keeps frecency across opens: recent commands float to top.
      this.palette = initialPaletteState(paletteFromCommands(TUI_COMMANDS));
      if (this.paletteState?.recent) {
        this.palette = { ...this.palette, recent: this.paletteState.recent };
      }
      // palette.recent is ReadonlyMap, paletteState.recent is Map
      this.paletteState = { recent: new Map(this.palette.recent) };
      this.choose("help");
      this.detail = undefined;
      this.notice = COMMAND_PALETTE_NOTICE;
      return;
    }
    throw Error("Unknown command. Use /help to see available commands.");
  }
  async export(kind: string) {
    const folder = resolve(this.env.NOMO_EXPORT_DIR ?? "nomo-exports");
    await mkdir(folder, { recursive: true, mode: 0o700 });
    const name = `${kind}-${Date.now()}-${randomUUID().slice(0, 8)}`;
    let content: string, suffix: string;
    if (kind === "ledger") {
      await this.refresh(true);
      if (
        this.proofErrors.size ||
        this.proxy.errors.length ||
        (this.proxy.entries.size && !this.proxy.signed)
      )
        throw Error("Export refused: a ledger has not been verified.");
      content =
        [...this.proofs.values(), ...this.proxy.entries.values()]
          .flat()
          .map((e) => JSON.stringify(e))
          .join("\n") + "\n";
      suffix = ".jsonl";
    } else if (kind === "chat") {
      const session = this.session();
      if (!session) throw Error("Select a conversation.");
      content = JSON.stringify(session, null, 2);
      suffix = ".json";
    } else if (kind === "document") {
      const d = this.editTarget();
      content = d.content;
      suffix = ".txt";
    } else throw Error("/export ledger | chat | document");
    const path = join(folder, name + suffix);
    await writeFile(path, content, { flag: "wx", mode: 0o600 });
    this.notice = `Export: ${path}`;
  }
  scrollPage(direction: number) {
    const { offset, total } = this.viewport;
    // The sticky transcript line shares the body budget with the transcript,
    // so the paging window is the two together; otherwise a page down from the
    // last full page would stop one row short of live follow.
    const height = this.viewport.height + (this.viewport.stickyRows ?? 0);
    const next = Math.max(
      0,
      Math.min(
        Math.max(0, total - height),
        offset + direction * Math.max(1, height - 2),
      ),
    );
    this.scroll =
      this.tab === "chat" &&
      !this.detail &&
      !this.confirmation &&
      next >= total - height
        ? -1
        : next;
  }
  lines(columns = 76, viewportHeight = 24): string[] {
    this.layoutColumns = Math.max(1, Math.floor(columns));
    const picker = this.modelPicker;
    if (picker?.open) {
      const matches = modelPickerMatches(picker.models, picker.query);
      const motion = motionContext(this.frame);
      const query = [...picker.query];
      query.splice(Math.max(0, Math.min(picker.cursor, query.length)), 0, "▌");
      const queryLabel = picker.query
        ? sanitizeText(query.join(""))
        : "▌(all models)";
      const providers = picker.providers;
      const selectedProvider = providers[picker.providerIndex];
      const catalogStatusLabel =
        picker.catalogStatus === "ready"
          ? "CATALOG READY"
          : picker.catalogStatus === "loading"
            ? "LOADING"
            : picker.catalogStatus === "unavailable"
              ? "UNAVAILABLE"
              : "NOT LOADED";
      const statusLabel = selectedProvider?.importSourceId
        ? `${catalogStatusLabel} · OMP KEY FOUND`
        : catalogStatusLabel;
      const providerRows = providers.map((provider, index) => {
        const selected = index === picker.providerIndex;
        const loading = this.pendingModelCatalogs.has(
          this.modelCatalogKey(provider.id),
        );
        const catalogStatus = selected
          ? picker.catalogStatus
          : loading
            ? "loading"
            : provider.catalogStatus;
        const catalogState =
          catalogStatus === "ready"
            ? provider.attached
              ? "active"
              : "catalog ready"
            : catalogStatus === "loading"
              ? "loading"
              : catalogStatus === "idle"
                ? "not loaded"
                : "unavailable";
        const state = [
          catalogState,
          ...(provider.importSourceId ? ["OMP key found"] : []),
          ...(catalogStatus === "idle" ? ["press →"] : []),
          ...(catalogStatus === "unavailable" ? ["press → retry"] : []),
        ].join(" · ");
        return `${selected && picker.focusedPane === "providers" ? "›" : selected ? "◆" : " "} ${this.providerGlyph(provider.id, provider.name)} ${sanitizeText(provider.name)} · ${state}`;
      });
      const selectedModelId =
        picker.selection === "session"
          ? this.session()?.model
          : selectedProvider?.id === this.modelProjection.activeProviderId
            ? this.model
            : undefined;
      const modelRows = matches.map(
        (model, index) =>
          `${cursorMarker(index === picker.selected, motion)} ${this.providerGlyph(picker.providerId ?? "", selectedProvider?.name)} ${this.modelGlyph()} ${sanitizeText(model.name || model.id)}  ${sanitizeText(model.id)}${model.id === selectedModelId ? (picker.selection === "session" ? "  [current]" : "  [default]") : ""}`,
      );
      const selectedModel = matches[picker.selected];
      const selectedContextWindow = selectedModel
        ? (selectedModel.contextWindow ??
          this.modelContextWindow(
            picker.providerId,
            new Set([selectedModel.id]),
          ))
        : undefined;
      const contextWindowLabel =
        typeof selectedContextWindow === "number" &&
        Number.isSafeInteger(selectedContextWindow) &&
        selectedContextWindow > 0
          ? selectedContextWindow >= 1_000_000
            ? `${Math.round(selectedContextWindow / 100_000) / 10}m`.replace(
                /\.0m$/,
                "m",
              )
            : `${Math.round(selectedContextWindow / 1_000)}k`
          : "context not reported";
      const selectedCapabilities = selectedModel?.capabilities
        ?.map((capability) => sanitizeText(capability))
        .filter(Boolean)
        .join(" · ");
      const selectedPriceParts = [
        ...(selectedModel?.inputPrice
          ? [`input ${sanitizeText(selectedModel.inputPrice)}`]
          : []),
        ...(selectedModel?.outputPrice
          ? [`output ${sanitizeText(selectedModel.outputPrice)}`]
          : []),
      ];
      const selectedPrice =
        selectedPriceParts.length > 0
          ? selectedPriceParts.join(" · ")
          : undefined;
      const selectedModelDetails = selectedModel
        ? [
            `${this.modelGlyph()} ${sanitizeText(selectedModel.name || selectedModel.id)}`,
            contextWindowLabel,
            ...(selectedModel.maxTokens
              ? [`max output ${selectedModel.maxTokens}`]
              : []),
            ...(selectedCapabilities ? [selectedCapabilities] : []),
            ...(selectedPrice ? [selectedPrice] : []),
          ].join(" · ")
        : `${this.providerGlyph(selectedProvider?.id ?? "", selectedProvider?.name)} ${sanitizeText(selectedProvider?.name ?? "No provider")} · ${statusLabel}`;
      const emptyMessage =
        picker.catalogStatus === "loading"
          ? "Loading this provider's catalog…"
          : picker.catalogStatus === "idle"
            ? "Press → to load this provider's models."
            : picker.catalogStatus === "unavailable"
              ? "Catalog unavailable. Press → to retry; check credentials or /connect."
              : "No models match the current filter.";
      const providerSummary = selectedProvider
        ? `${this.providerGlyph(selectedProvider.id, selectedProvider.name)} ${sanitizeText(selectedProvider.name)} · ${picker.providerIndex + 1}/${providers.length} · ${statusLabel}`
        : "No provider configured · /sources then /connect";
      if (columns < 88) {
        const visibleRows = Math.max(1, viewportHeight - 5);
        const activeRows =
          picker.focusedPane === "providers" ? providerRows : modelRows;
        const selectedIndex =
          picker.focusedPane === "providers"
            ? picker.providerIndex
            : picker.selected;
        const windowStart = modelPickerWindowStart(
          selectedIndex,
          activeRows.length,
          visibleRows,
          picker.focusedPane === "providers"
            ? picker.providerWindowStart
            : picker.modelWindowStart,
        );
        const pickerHelp =
          columns < 50
            ? columns < 36
              ? picker.focusedPane === "providers"
                ? "↑↓prov →models ↵load Esc"
                : picker.query
                  ? "↑↓model ←prov Esc clear"
                  : `↑↓model ←prov ↵${picker.selection === "session" ? "use" : "set"} Esc`
              : picker.focusedPane === "providers"
                ? "↑↓ prov · → models · Enter load · Tab panes"
                : picker.query
                  ? "↑↓ models · ← providers · Esc clears · Tab panes"
                  : `↑↓ models · ← providers · Enter ${picker.selection === "session" ? "use" : "select"} · Esc`
            : `${picker.focusedPane === "providers" ? "↑/↓ provider · → models" : "↑/↓ model · ← providers"} · Tab/Shift+Tab switches panes · Type search · Ctrl+←/→ caret · Enter ${picker.selection === "session" ? "use for conversation" : "open/select"} · Esc`;
        return [
          `MODELS · ${matches.length}/${picker.models.length}`,
          `PROVIDER · ${providerSummary}`,
          `FILTER · ${queryLabel}`,
          ...(picker.focusedPane === "providers"
            ? activeRows.length
              ? activeRows.slice(windowStart, windowStart + visibleRows)
              : ["No configured providers."]
            : activeRows.length
              ? activeRows.slice(windowStart, windowStart + visibleRows)
              : [emptyMessage]),
          fit(selectedModelDetails, columns),
          pickerHelp,
        ].map((line) => fit(line, columns));
      }
      const sidebarWidth = Math.min(
        28,
        Math.max(20, Math.floor(columns * 0.27)),
      );
      const listWidth = Math.max(1, columns - sidebarWidth - 3);
      const joinPanes = (sidebar: string, content: string) =>
        `${pad(fit(sidebar, sidebarWidth), sidebarWidth)} │ ${fit(content, listWidth)}`;
      const visibleRows = Math.max(1, viewportHeight - 4);
      const providerStart = modelPickerWindowStart(
        picker.providerIndex,
        providerRows.length,
        visibleRows,
        picker.providerWindowStart,
      );
      const modelStart = modelPickerWindowStart(
        picker.selected,
        modelRows.length,
        visibleRows,
        picker.modelWindowStart,
      );
      return [
        joinPanes(
          `PROVIDERS · ${providers.length}`,
          `MODELS · ${selectedProvider?.name ?? "No provider"} · ${matches.length}/${picker.models.length}`,
        ),
        joinPanes(
          providerSummary,
          `⌕ > ${queryLabel} · ${picker.selection === "session" ? "Enter uses model" : "Enter selects"}`,
        ),
        ...Array.from({ length: visibleRows }, (_, index) =>
          joinPanes(
            providerRows[providerStart + index] ?? "",
            modelRows[modelStart + index] ??
              (index === 0 && !modelRows.length ? emptyMessage : ""),
          ),
        ),
        joinPanes("", selectedModelDetails),
        joinPanes(
          "",
          `${picker.focusedPane === "providers" ? "↑/↓ providers · → models" : "↑/↓ models · ← providers"} · Tab/Shift+Tab panes · type search · Ctrl+←/→ caret · Enter ${picker.selection === "session" ? "use model" : "select"} · Esc close`,
        ),
      ];
    }
    if (this.confirmation)
      return [
        this.confirmation.title,
        ...(this.tab === "chat" || viewportHeight < 12 || viewportHeight >= 20
          ? []
          : [
              "y confirm · n reject · Esc cancel",
              `PgUp/Dn scroll${this.confirmation.hunks?.chunks.length ? " · 1–9 scope" : ""}`,
            ]),
        ...(viewportHeight < 12 ? [] : [""]),
        ...this.confirmation.lines.flatMap((l) => l.split("\n")),
      ];
    if (
      this.detail &&
      this.documentPreview &&
      this.tab === "documents" &&
      this.groupTree
    ) {
      const layout = documentPreviewLayout(columns, viewportHeight);
      if (layout.sideBySide) {
        const previewWidth = Math.max(1, layout.width - layout.treeWidth - 2);
        const tree = renderTree(
          this.groupTree.nodes,
          this.groupTree.state,
          layout.treeWidth,
          layout.height,
          { motion: motionContext(this.frame) },
        );
        const preview = wrap(
          ["DOCUMENT PREVIEW", ...this.detail],
          previewWidth,
        );
        return Array.from(
          { length: Math.max(tree.length, preview.length) },
          (_, index) =>
            `${fit(tree[index] ?? "", layout.treeWidth)}  ${fit(preview[index] ?? "", previewWidth)}`,
        );
      }
      const treeHeight = Math.max(1, Math.floor(layout.height / 2));
      return [
        ...renderTree(
          this.groupTree.nodes,
          this.groupTree.state,
          layout.width,
          treeHeight,
          { motion: motionContext(this.frame) },
        ),
        "",
        "DOCUMENT PREVIEW",
        ...this.detail,
      ];
    }
    if (this.settingsOpen) this.detail = this.settingsLines();
    if (this.detail?.[0]?.startsWith("DIFF "))
      this.detail = this.diffDetailLines(
        this.openOperations(),
        columns,
        viewportHeight,
      );
    // The /providers detail opens with the same string the panel frame uses
    // as its title. The frame already shows it, so the body starts at the
    // first source row instead of spending its first rows on a repeat.
    if (this.detail)
      return this.detail[0] === PROVIDERS_DETAIL_TITLE
        ? this.detail.slice(1)
        : this.detail;
    if (this.tab === "models" && this.modelCatalogStatus !== "ready") {
      const providers = this.modelProjection.providers;
      return [
        `MODELS · ${providers.length} configured provider${providers.length === 1 ? "" : "s"}`,
        "",
        ...(providers.length
          ? providers.map((provider) => {
              const state = provider.attached
                ? `${provider.catalogStatus} · active`
                : "configured · catalog loads on selection";
              return `${this.providerGlyph(provider.id, provider.name)} ${sanitizeText(provider.name)} · ${state}`;
            })
          : ["No provider is configured."]),
        "",
        providers.length
          ? "Alt+M opens the provider and model picker. Catalogs load only for the selected provider."
          : "Configure a provider with /connect, then open Alt+M to browse its models.",
      ];
    }
    if (this.tab === "help") {
      const commands = TUI_COMMANDS.length;
      return [
        "QUICK KEYS",
        "Ctrl+P  Find a command",
        "Alt+M   Choose provider and model",
        "/keybindings  See the active keymap",
        "",
        `HELP · ${commands} commands · ${DISCOVERY_GROUPS.length} groups`,
        "",
        ...helpLines(columns),
      ];
    }
    if (this.tab === "mcp") {
      const connectors = this.items().flatMap((row) =>
        row.connector ? [row.connector] : [],
      );
      if (!connectors.length)
        return this.filter
          ? [
              `No MCP connectors match ${sanitizeText(this.filter)}.`,
              "Backspace edits the filter. Esc clears it.",
            ]
          : [
              `${getSymbols(this.themeConfig.symbolPreset).icons.network} MCP CONNECTORS · 0`,
              "",
              "No connector records are available.",
              "Use /mcp add URL [name] to stage one locally; staging makes no request.",
            ];
      const byConsent = new Map<string, number>();
      for (const connector of connectors)
        byConsent.set(
          connector.consentState,
          (byConsent.get(connector.consentState) ?? 0) + 1,
        );
      const confirmed = connectors.filter(
        (connector) => connector.consentState === "confirmed",
      );
      const offeredTools = confirmed.reduce(
        (sum, connector) => sum + connector.tools.length,
        0,
      );
      const consentEntries = [...byConsent.entries()].sort(([left], [right]) =>
        left.localeCompare(right),
      );
      return [
        `${getSymbols(this.themeConfig.symbolPreset).icons.network} MCP · ${connectors.length} connectors · ${confirmed.length} confirmed · ${offeredTools} tools offered`,
        "Confirmed connectors serve new conversations; NOMO policy still applies.",
        "",
        "CONSENT STATES",
        ...barChart(
          {
            values: consentEntries.map(([, count]) => count),
            labels: consentEntries.map(([state]) => state),
          },
          Math.max(1, columns - 2),
          { motion: motionContext(this.frame) },
        ).map((line) => `  ${line}`),
        "",
        ...this.listRows(),
        "",
        "Type to filter · Up/Down selects · Enter inspects",
        "/mcp probe ID contacts a server only after confirmation · /mcp confirm ID grants the probed connector",
      ];
    }
    if (this.tab === "status") {
      const statusRows = this.items();
      const checks = statusRows.flatMap((row) =>
        row.check ? [row.check] : [],
      );
      const states = ["fail", "unknown", "warn", "skipped", "ok"] as const;
      const counts = states
        .map((state) => ({
          state,
          count: checks.filter((c) => c.state === state).length,
        }))
        .filter((entry) => entry.count > 0);
      const failures = checks.filter((check) => check.state === "fail").length;
      const unknown = checks.filter(
        (check) => check.state === "unknown",
      ).length;
      const warnings = checks.filter((check) => check.state === "warn").length;
      if (!checks.length)
        return this.filter
          ? [
              `No status checks match ${sanitizeText(this.filter)}.`,
              "Backspace edits the filter. Esc clears it.",
            ]
          : [
              "STATUS · no checks reported",
              "",
              "The Workbench returned no subsystem checks.",
            ];
      const session = this.session();
      const usage = chatEventSummary(session?.events ?? []).usage;
      const tokens =
        typeof usage?.total_tokens === "number"
          ? String(usage.total_tokens)
          : "?";
      const cost =
        typeof usage?.cost === "number" ? `$${usage.cost.toFixed(4)}` : "?";
      return [
        `${getSymbols(this.themeConfig.symbolPreset).icons.settings} STATUS · ${healthSummary(checks)}`,
        `${failures} fail · ${unknown} unknown · ${warnings} warn · ${checks.length} checks`,
        "",
        "SUBSYSTEM STATES",
        ...barChart(
          {
            values: counts.map((entry) => entry.count),
            labels: counts.map((entry) => entry.state),
          },
          Math.max(1, columns - 2),
          { motion: motionContext(this.frame) },
        ).map((line) => `  ${line}`),
        "",
        "RUNTIME",
        `${this.providerSummary()}`,
        `run ${session?.status ?? "none"} · queue ${this.queuedPrompt ? (this.queuedPromptPaused ? "paused" : "1 queued") : "0"} · context ${tokens} tokens · cost ${cost}`,
        "",
        ...this.listRows(),
        "",
        "Up/Down selects · Enter explains evidence and remedy · /verify rechecks signed ledger chains",
        "This screen reports current Workbench checks; selecting a remedy never executes it.",
      ];
    }
    // Tools are grouped by class, low risk first, because that is the order
    // an operator reasoning about authority reads them in. A flat list put a
    // read next to a write with nothing between them.
    if (this.tab === "tools") {
      const summaries: ToolSummary[] = this.workbench
        .availableTools(this.sessionId)
        .tools.map((tool) => ({
          id: tool.id,
          name: tool.name,
          klass: tool.klass,
          source: tool.source,
          description: tool.description,
          capturedUndo: tool.capturedUndo,
          inputSchema: tool.inputSchema,
        }));
      const shown = filterTools(summaries, this.filter);
      const browser = toolRows(shown, columns, {
        selected: this.selected,
        motion: motionContext(this.frame),
      });
      const byClass = new Map<string, number>();
      for (const tool of summaries) {
        const klass = tool.klass ?? "unknown";
        byClass.set(klass, (byClass.get(klass) ?? 0) + 1);
      }
      const classCounts = [...byClass.entries()]
        .sort((a, b) => a[0].localeCompare(b[0]))
        .map(([klass, count]) => `${count} ${klass}`)
        .join(", ");
      return [
        `${getSymbols(this.themeConfig.symbolPreset).icons.tool} TOOLS · ${summaries.length} available · ${classCounts}`,
        "",
        ...browser,
        "",
        this.filter
          ? `Filter: ${this.filter} (Esc clears, Backspace deletes)`
          : "Type to filter by name, class, source or description.",
        "Type to filter. Up/Down selects and wraps. Home/End jumps to either end; PageUp/Down pages. Enter inspects a tool; inspection never executes it.",
      ];
    }
    if (this.tab === "chat")
      return this.session()
        ? [
            // The shape of the conversation before the words of it. An
            // operator opening a chat after an hour away wants to see where it
            // got to, and scrolling a wall of events to find that is the work
            // the strip is meant to remove.
            ...renderActivity(
              buildActivity(this.session()!.events),
              this.layoutColumns,
              {
                motion: motionContext(this.frame),
                symbolPreset: this.themeConfig.symbolPreset,
              },
            ),
            "",
            ...transcript(this.session()!.events),
          ]
        : [
            "NEW CONVERSATION",
            "",
            `Model: ${this.model || "not connected"}`,
            `Project: ${this.projectId ?? "none"} | Agent: ${this.agentId ?? "runtime default"}`,
            "Press i to type; Enter to send; Shift+Enter or Ctrl+J for a new line.",
            "Example: Create a plan and save it to plan.md.",
            "",
            "/connect shows provider setup without switching existing conversations.",
          ];
    // The policy tab used to open with the raw YAML and then a JSON dump per
    // connector. The question it exists to answer is what this workspace is
    // allowed to do, and that is a summary of classes and decisions, not the
    // text of the rules. The YAML stays below for the operator who wants it.
    if (this.tab === "policy") {
      const connectors = this.workbench.connectionState().connectors;
      const policyTools = connectors.flatMap((c) =>
        c.tools.map((tool) => ({ name: tool, source: c.name || c.id })),
      );
      const byClass = new Map<string, number>();
      for (const connector of connectors) {
        const summary = policySummary(
          "policy" in connector ? (connector.policy as string) : undefined,
        );
        byClass.set(String(summary), (byClass.get(String(summary)) ?? 0) + 1);
      }
      const byConsent = new Map<string, number>();
      for (const connector of connectors) {
        const consent =
          "consentState" in connector ? connector.consentState : "unknown";
        byConsent.set(consent, (byConsent.get(consent) ?? 0) + 1);
      }
      const consentCounts = [...byConsent.entries()]
        .map(([state, count]) => `${count} ${state}`)
        .join(", ");
      return [
        `POLICY, ${connectors.length} connectors: ${consentCounts}`,
        "",
        ...renderInspector(
          {
            title: "POLICY",
            subtitle: "R0 reads; R1 writes with capture and verified Undo",
            icon: ROW_ICONS.harness,
            sections: [
              {
                title: "what is allowed",
                fields: [
                  { label: "classes", value: "R0 read, R1 write, R2 bulk" },
                  {
                    label: "unknown tools",
                    value: "denied",
                    tone: "success",
                  },
                  {
                    label: "expired approval",
                    value: "cannot release a tool",
                    tone: "warning",
                  },
                  {
                    label: "snapshot",
                    value: "each conversation takes its own copy",
                  },
                  {
                    label: "connectors",
                    value: `${connectors.length} connected, ${policyTools.length} tools offered`,
                  },
                ],
              },
              {
                title: "per connector",
                fields: connectors.map((c) => ({
                  label: (c.name || c.id).slice(0, 22),
                  value: `${c.tools.length} tools, ${c.consentState}`,
                  tone: c.consentState === "confirmed" ? "success" : "warning",
                })),
              },
            ],
            hint: "/policy-file ID path.yaml changes the policy for one connector.",
          },
          { width: columns },
        ),
        "",
        "DEFAULT POLICY FOR EXTERNAL MCP",
        ...DEFAULT_POLICY.split("\n"),
        "",
        ...this.items().flatMap((r) => [r.label, ...r.lines, ""]),
      ];
    }
    const rows = this.items();
    if (this.tab === "sessions")
      return this.sessionBrowserLinesFor(rows, columns, viewportHeight);
    if (this.groupTree && !rows.length && this.filter) {
      return [
        `No matches for ${sanitizeText(this.filter)}.`,
        "Backspace edits the filter. Esc clears it.",
      ];
    }
    if (this.tab === "runs") {
      const runs = rows.flatMap((row) => (row.run ? [row.run] : []));
      if (!runs.length)
        return this.filter
          ? [
              `No runs match ${sanitizeText(this.filter)}.`,
              "Backspace edits the filter. Esc clears it.",
            ]
          : [
              `${getSymbols(this.themeConfig.symbolPreset).icons.run} RUNS · 0 recorded`,
              "",
              "No run records are available in this workspace yet.",
              "Runs appear here after a conversation emits run events.",
              "",
              this.providerSummary(),
              "",
              "Type to filter · /sessions opens conversation history",
            ];
      const byState = new Map<string, number>();
      for (const run of runs)
        byState.set(run.state, (byState.get(run.state) ?? 0) + 1);
      const active = runs.filter((run) =>
        ["running", "awaiting-approval", "stopping"].includes(run.state),
      ).length;
      const reconciliation = runs.filter((run) => run.reconcileRequired).length;
      const progressValues = runs.flatMap((run) =>
        typeof run.progress === "number" &&
        Number.isFinite(run.progress) &&
        run.progress >= 0 &&
        run.progress <= 1
          ? [run.progress * 100]
          : [],
      );
      const stateEntries = [...byState.entries()].sort(([left], [right]) =>
        left.localeCompare(right),
      );
      const chart = barChart(
        {
          values: stateEntries.map(([, count]) => count),
          labels: stateEntries.map(([state]) => state),
        },
        Math.max(1, columns - 2),
        { motion: motionContext(this.frame) },
      );
      const progressSummary = progressValues.length
        ? `Progress reported for ${progressValues.length}/${runs.length} runs · average ${Math.round(progressValues.reduce((sum, value) => sum + value, 0) / progressValues.length)}%`
        : `Progress not reported for these ${runs.length} runs`;
      return [
        `${getSymbols(this.themeConfig.symbolPreset).icons.run} RUNS · ${runs.length} recorded · ${active} active · ${reconciliation} need reconciliation`,
        progressSummary,
        "",
        "STATUS DISTRIBUTION",
        ...chart.map((line) => `  ${line}`),
        "",
        ...this.listRows(),
        "",
        "Type to filter · Up/Down selects · Enter inspects · /resume ID opens the conversation",
        "Unknown outcomes stay marked for reconciliation; inspection does not change run state.",
      ];
    }
    if (this.tab === "documents" && !rows.length && !this.filter)
      return ["DOCUMENT TREE", "No managed documents yet.", "Use /document PATH to inspect a saved workspace document."];
    // Documents group by folder and conversations by state, for the same</path>
    // reason: a flat list of forty rows cannot be scanned, and a group the
    // operator does not care about should be one keystroke to hide rather
    // than forty rows to scroll past.
    // The sessions tab is answered above, by the browser. What reaches this
    // point with a tree is the Documents tab.
    if (this.groupTree && rows.length) {
      // A folder tree answers "what is here". It does not answer "what
      // happened to it", so the recovery line sits under it rather than
      // replacing it. Two panes for one tab would mean the operator has to
      // choose which question to be able to ask at all.
      const openOps = this.recoveryRows().filter(
        (row) => row.recoverable === "recoverable",
      );
      const footer = [
        "",
        collapsedSummary(this.groupTree.state, this.groupTree.nodes, {
          group: "folder",
          row: "document",
        }),
        openOps.length
          ? `${openOps.length} of ${this.recoveryRows().length} changes can still be undone. /diff steps through them.`
          : "Every change has been decided: undone or kept.",
        "Type filters. Up/Down moves the tree cursor. Enter opens document details or toggles a folder. Home/End jump to the first/last row; PageUp/Down or Left/Right pages. /document path opens a document.",
      ];
      const header = [`DOCUMENT TREE · ${rows.length} files`, ""];
      return [
        ...header,
        ...renderTree(
          this.groupTree.nodes,
          this.groupTree.state,
          Math.max(1, columns),
          Math.max(1, viewportHeight - header.length - footer.length),
          { motion: motionContext(this.frame) },
        ),
        ...footer,
      ];
    }
    // The tools tab is answered earlier, by the grouped browser, so the
    // /mcp hint that used to sit here has no tab left to attach to.
    // Models gets a hint because Enter changes the future default while
    // existing conversations keep their own model snapshots.
    if (this.tab === "models" && rows.length) {
      const activeProvider = this.modelProjection.providers.find(
        (provider) => provider.id === this.modelProjection.activeProviderId,
      );
      const providerName = sanitizeText(
        activeProvider?.name ??
          this.provider?.providerId ??
          "connected provider",
      );
      return [
        "ACTIVE PROVIDER",
        `${providerName} · ${rows.length} models`,
        `New chats: ${sanitizeText(this.model || "no default set")}`,
        `Alt+M switches provider/model · ${this.modelProjection.providers.length} profiles`,
        "",
        ...this.listRows(),
        "",
        "Enter sets the default for new conversations. /model ID selects by name; existing conversations keep their model.",
      ];
    }
    // The usage tab is one row per record, which answers "what happened" and
    // not "what did it cost me". Records arrive newest last, so the summary
    // leads with the shape and the list follows it. Every figure comes from a
    // record the provider wrote; a metric nobody reported prints n/a rather
    // than zero, because absent and zero are different measurements.
    if (this.tab === "usage") {
      if (!rows.length)
        return this.filter
          ? ["No usage records match the filter.", "Esc clears the filter."]
          : [
              "TOKEN ACTIVITY",
              "No usage records yet.",
              "no usage reported · tokens n/a · cost n/a",
              "Provider-reported usage appears after a conversation run.",
            ];
      const records = rows.flatMap((row) => (row.usage ? [row.usage] : []));
      return [
        "TOKEN ACTIVITY",
        ...usageSummaryLines(
          records,
          columns,
          viewportHeight,
          motionContext(this.frame),
        ),
        ...(viewportHeight >= 7 ? ["RECORDS · newest last"] : []),
        ...this.listRows(),
      ];
    }
    // The documents tab is a tree, so the summary line goes under it rather
    // than over it. The tree already answers "what is here"; the summary says
    // how much of it is still open.
    if (this.tab === "documents" && rows.length) {
      const bySession = new Map<string, number>();
      for (const row of rows) {
        const session = row.sessionId ?? "unknown";
        bySession.set(session, (bySession.get(session) ?? 0) + 1);
      }
      const counts = [...bySession.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 4)
        .map(([session, count]) => `${session.slice(0, 8)}: ${count}`)
        .join(", ");
      const openOps = this.recoveryRows().filter(
        (row) => row.recoverable === "recoverable",
      );
      return [
        ...this.listRows(),
        "",
        `${getSymbols(this.themeConfig.symbolPreset).icons.document} DOCUMENTS · ${rows.length} across ${bySession.size} conversations`,
        "",
        counts + (bySession.size > 4 ? ", ..." : ""),
        "",
        openOps.length
          ? `${openOps.length} of ${this.recoveryRows().length} changes can still be undone. /diff steps through them.`
          : "Every change has been decided: undone or kept.",
        "Type to filter. Up/Down selects and wraps. Enter opens document details. Home/End jump to either end; PageUp/Down pages.",
        "Esc returns. /document path opens a document.",
      ];
    }
    // The ledger tab mixes signed evidence with derived records. Keep real
    // entry counts and verification claims separate from the derived rows;
    // those rows are useful context, but are not ledger entries themselves.
    // The chain line draws the entries the verifier returned, so a reader sees
    // the shape of the evidence before the counts, and a failed workspace is
    // marked degraded rather than drawn as an empty chain.
    if (this.tab === "ledger") {
      const managedEntries = [...this.proofs.values()].reduce(
        (sum, entries) => sum + entries.length,
        0,
      );
      const proxyEntries = [...this.proxy.entries.values()].reduce(
        (sum, entries) => sum + entries.length,
        0,
      );
      const managedVerification =
        this.proofErrors.size > 0
          ? `${this.proofErrors.size} workspace(s) failed verification`
          : managedEntries > 0
            ? (this.managedVerificationStatus ??
              "verification status unavailable")
            : "no managed entries recorded";
      const proxyVerification =
        proxyEntries === 0
          ? "no proxy entries recorded"
          : this.proxy.signed
            ? this.proxy.verificationStatus
            : `hash integrity only; signature not verified (${this.proxy.verificationStatus})`;
      const issues = [
        ...[...this.proofErrors.values()].map(
          (error) => `Managed ledger: ${error}`,
        ),
        ...this.proxy.errors.map((error) => `Proxy store: ${error}`),
      ];
      // The managed chain is verified only when the workbench returned proofs
      // and named the key it verified them with. A proof with no verification
      // status behind it is not a pass, so it degrades rather than borrowing
      // the mark. A failed workspace is counted separately: it contributed no
      // entries, so it cannot make the entries that were drawn unverified.
      const managedVerified =
        managedEntries > 0 && this.managedVerificationStatus !== undefined;
      const proxyVerified = proxyEntries > 0 && this.proxy.signed;
      return [
        "CHAIN STATUS",
        ...ledgerChainLines(
          {
            label: "managed",
            entries: managedEntries,
            verified: managedVerified,
            failedWorkspaces: this.proofErrors.size,
          },
          {
            label: "proxy",
            entries: proxyEntries,
            verified: proxyVerified,
            // An unsigned proxy store keeps its entries, so the exact reason
            // it is degraded belongs on the chain line rather than nowhere.
            ...(proxyEntries > 0 && !this.proxy.signed
              ? { reason: proxyVerification }
              : {}),
          },
          columns,
        ),
        `Managed ${managedEntries} · ${managedVerification}`,
        `Proxy ${proxyEntries} · ${proxyVerification}`,
        ...(issues.length ? [`${issues.length} issue(s) · /verify rechecks`] : []),
        // A degraded ledger is the one state that must not be hidden by a
        // short frame: the reason recovery cannot be trusted is the whole
        // point of the tab.
        ...issues,
        ...(rows.length ? this.listRows() : ["No records match the filter."]),
      ];
    }
    // The approvals tab answers "what is waiting on me", and the answer is a
    // deadline and a blast radius, not a list. The summary counts the risk the
    // hold classes actually carry, names the soonest real deadline, and shows
    // the diff the selected hold carries or says it carries none. The list
    // below is sorted by the same blast radius.
    if (this.tab === "approvals") {
      if (!rows.length)
        return ["REVIEW QUEUE", this.filter ? "No approvals match the filter." : "No approvals waiting."];
      const now = Date.now();
      const holds = rows.flatMap((row) => (row.hold ? [row.hold] : []));
      // The risk badge is derived from the reversibility class on the hold, so
      // these counts move with the real calls rather than with the labels.
      let external = 0;
      let local = 0;
      let unclassified = 0;
      for (const hold of holds) {
        const badge = approvalRiskBadge(hold);
        if (badge === "[0] local") local += 1;
        else if (badge === "[!] external") external += 1;
        else unclassified += 1;
      }
      const risk = [
        `${external} external`,
        `${local} local`,
        ...(unclassified ? [`${unclassified} unclassified`] : []),
      ].join(" · ");
      const left = holds
        .map((hold) => holdSecondsLeft(hold, now))
        .filter((seconds): seconds is number => seconds !== null);
      const expired = left.filter((seconds) => seconds <= 0).length;
      const running = left.filter((seconds) => seconds > 0);
      const undated = holds.length - left.length;
      const soonest = running.length ? `${Math.min(...running)}s` : undefined;
      const selectedHold = rows[this.selected]?.hold;
      const preview = selectedHold
        ? holdDiffRows(
            selectedHold as Parameters<typeof holdDiffRows>[0],
          )
        : undefined;
      const previewLines = preview?.length
        ? [
            `preview · ${preview.length} diff rows on ${sanitizeText(selectedHold?.call.tool ?? "the selected hold")}`,
            ...preview.slice(0, 4).map((line) => `  ${sanitizeText(line)}`),
          ]
        : ["preview n/a · the selected hold carries no diff"];
      return [
        "REVIEW QUEUE",
        `${rows.length} waiting · ${risk}`,
        expired
          ? `${expired} already expired and did not run.`
          : soonest
            ? `soonest deadline: ${soonest}${undated ? ` · ${undated} with no deadline` : ""}`
            : "no deadline reported",
        ...previewLines,
        "",
        ...this.listRows(),
        "",
        "[a] approve  [d] deny · Enter inspects",
      ];
    }
    return rows.length ? this.listRows() : ["No entries yet.", ""];
  }
  /**
   * The item list as numbered rows with a selection marker.
   *
   * Three call sites rendered this by hand, and each had drifted: only one of
   * them respected the active filter. Rendering it once means a fix to the
   * cursor gutter or the numbering reaches all three.
   */
  listRows(): string[] {
    const rows = this.items();
    if (!rows.length) return [];
    // The cursor marker is a fixed two cells, so selecting a row never shifts
    // the numbering of the rows below it. It breathes between two shapes
    // rather than blinking: a blinking cursor is hard to follow in a redraw
    // that happens four times a second.
    const motion = motionContext(this.frame);
    const mark = (index: number) =>
      cursorMarker(index === this.selected, motion);
    // A tab that mixes kinds gets a heading above each run of them. Headings
    // carry no number on purpose: the number is how an operator refers to a
    // row, and a number that counts a heading would make every reference
    // after it wrong.
    if (!rows.some((row) => row.kind))
      return [
        ...rows.map((row, i) => `${mark(i)}${i + 1}. ${row.label}`),
        "Type to filter. Up/Down selects and wraps. Home/End jumps to either end; PageUp/Down moves a page.",
      ];
    const out: string[] = [];
    const counts = new Map<string, number>();
    for (const row of rows)
      if (row.kind) counts.set(row.kind, (counts.get(row.kind) ?? 0) + 1);
    let kind: string | undefined;
    rows.forEach((row, index) => {
      if (!row.kind) {
        out.push(`${mark(index)}${index + 1}. ${row.label}`);
        kind = undefined;
        return;
      }
      if (row.kind !== kind) {
        kind = row.kind;
        const key = row.kind ?? "";
        // The heading says what the rows under it are evidence of, so the
        // signed section and the derived section stay distinct without colour
        // and without relying on a glyph difference alone.
        out.push(
          ledgerGroupHeading({
            kind: key,
            title: LEDGER_GROUP_TITLE[key] ?? key,
            icon: LEDGER_GROUP_ICON[key] ?? "·",
            count: counts.get(key) ?? 0,
          }),
        );
      }
      out.push(`${mark(index)}${index + 1}. ${row.label}`);
    });
    out.push(
      "Type to filter. Up/Down selects and wraps. Home/End jumps to either end; PageUp/Down moves a page.",
    );
    return out;
  }
  /**
   * The sessions body: one full-width row per conversation, under the
   * collapsible section headings, with the inspector beside it only when the
   * terminal can afford a second pane.
   *
   * The list is windowed here rather than by the outer viewport because the
   * cursor lives in the tree: the frame has to show the row the cursor is on,
   * and it has to keep the headings above it in view so the row still says
   * which section it belongs to.
   */
  sessionBrowserLinesFor(
    rows: readonly Item[],
    columns: number,
    viewportHeight: number,
  ): string[] {
    const width = Math.max(1, Math.floor(columns));
    const height = Math.max(1, Math.floor(viewportHeight));
    // Escape clears the detail pane without knowing about this flag, so a
    // flag left set would make the next Enter open Chat instead of showing
    // the inspector again.
    if (this.sessionInspectorDetail && !this.detail)
      this.sessionInspectorDetail = false;
    // The threshold is written in terminal columns; this body is narrower.
    const layout = sessionInspectorLayout(
      width + SESSION_FRAME_COLUMNS,
      height,
    );
    const listWidth = layout.sideBySide ? layout.listWidth : width;
    const tree = this.groupTree;
    const model = this.sessionBrowser;
    const visible = tree ? flattenTree(tree.nodes, tree.state) : [];
    const cursor = tree
      ? Math.max(
          0,
          Math.min(tree.state.cursor, Math.max(0, visible.length - 1)),
        )
      : 0;
    const running = [...(model?.entries.values() ?? [])].filter(
      (entry) =>
        entry.section === "active" &&
        /run|active/.test(entry.status.toLowerCase()),
    ).length;
    const attention = [...(model?.entries.values() ?? [])].filter(
      (entry) => entry.section === "attention",
    ).length;
    const summary = fit(
      rows.length
        ? `SESSIONS · ${rows.length} ${rows.length === 1 ? "conversation" : "conversations"} · ${running} running · ${attention} attention`
        : "SESSIONS · 0 conversations",
      width,
    );
    this.sessionBrowserLines = undefined;
    if (!rows.length) {
      if (this.filter)
        return [
          summary,
          fit(`No matches for ${sanitizeText(this.filter)}.`, width),
          fit("Backspace edits the filter. Esc clears it.", width),
        ];
      return [summary, fit("No sessions yet. /new starts one.", width)];
    }
    const hint = sessionBrowserHint(width, this.themeConfig.symbolPreset);
    const hintRows = height >= 6 ? 1 : 0;
    const area = Math.max(1, height - 1 - hintRows);
    const start =
      cursor < area
        ? 0
        : Math.min(cursor - area + 1, Math.max(0, visible.length - 1));
    const listRows: string[] = [];
    const headers: number[] = [];
    const rowLines: { line: number; index: number }[] = [];
    let selected = -1;
    for (
      let index = start;
      index < Math.min(visible.length, start + area);
      index += 1
    ) {
      const node = visible[index]!;
      // "›" marks the cursor here and "▸" marks a spawned child, so the two
      // shapes never mean the same thing on one row.
      const marker = index === cursor ? "› " : "  ";
      const line = listRows.length + 1;
      if (node.hasChildren) {
        const expanded = tree?.state.expanded.has(node.id) === true;
        listRows.push(
          fit(
            `${marker}${sessionSectionChevron(expanded, this.themeConfig.symbolPreset)} ${sanitizeText(node.label)}`,
            listWidth,
          ),
        );
        headers.push(line);
      } else {
        const entry = model?.entries.get(node.id);
        listRows.push(
          fit(
            `${marker}${
              entry
                ? sessionRowLine(
                    entry,
                    Math.max(1, listWidth - 2),
                    sessionRowIcons(this.themeConfig.symbolPreset),
                  )
                : sanitizeText(node.label)
            }`,
            listWidth,
          ),
        );
        rowLines.push({ line, index });
      }
      if (index === cursor) selected = line;
    }
    this.sessionBrowserLines = { selected, headers, rows: rowLines };
    if (layout.sideBySide) {
      const divider = getSymbols(this.themeConfig.symbolPreset).frame.v;
      const inspectorRows = this.sessionInspectorFor(
        visible[cursor],
        layout.inspectorWidth,
        area,
      );
      const panes = Array.from(
        { length: area },
        (_, index) =>
          `${fit(listRows[index] ?? "", listWidth)} ${divider} ${fit(inspectorRows[index] ?? "", layout.inspectorWidth)}`,
      );
      return [summary, ...panes, ...(hintRows ? [fit(hint, width)] : [])];
    }
    const body = [...listRows];
    while (body.length < area) body.push("");
    return [summary, ...body, ...(hintRows ? [fit(hint, width)] : [])];
  }
  /**
   * The inspector for whatever the browser cursor is on.
   *
   * A conversation gets its recorded facts and its last five retained events.
   * A section heading gets the section's count and what Enter does there,
   * because a heading has no conversation of its own and borrowing the last
   * one would describe a row the cursor is not on.
   */
  private sessionInspectorFor(
    node: TreeNode | undefined,
    width: number,
    height: number,
  ): string[] {
    const options = {
      width,
      height,
      motion: motionContext(this.frame),
    };
    const session =
      node && !node.hasChildren ? this.workbench.get(node.id) : undefined;
    if (session)
      return renderInspector(this.sessionInspectorSpec(session), options);
    const section = node
      ? this.sessionBrowser?.sections.find(
          (candidate) => `section:${candidate.id}` === node.id,
        )
      : undefined;
    const count = section?.count ?? 0;
    return renderInspector(
      {
        title: section ? `${section.id} sessions` : "Sessions",
        subtitle: `${count} ${count === 1 ? "conversation" : "conversations"} in this section`,
        sections: [
          {
            title: "section",
            fields: [
              {
                label: "state",
                value:
                  node && this.groupTree?.state.expanded.has(node.id)
                    ? "expanded"
                    : "collapsed",
              },
              { label: "rows", value: String(count) },
            ],
          },
        ],
        hint: "Enter folds this section. Up/Down selects a conversation.",
      },
      options,
    );
  }
  /** The inspector lines for one conversation, from recorded fields only. */
  private sessionInspectorSpec(session: SessionView): InspectorSpec {
    const icons = sessionRowIcons(this.themeConfig.symbolPreset);
    // The status label carries the same glyph the row shows, so the two panes
    // name one state instead of two spellings of it.
    const statusGlyph = sessionRowGlyph(session, sessionSection(session));
    const children = this.workbench
      .list()
      .filter((candidate) => candidate.parentId === session.id);
    const parent = session.parentId
      ? this.workbench.get(session.parentId)
      : undefined;
    const statusTone: FieldTone =
      session.status === "failed"
        ? "error"
        : session.status === "running"
          ? "accent"
          : session.status === "queued" || session.status === "paused"
            ? "warning"
            : session.status === "idle"
              ? "success"
              : "muted";
    const recent = session.events
      .filter((event) => event.kind !== "usage")
      .slice(-5)
      .map(sessionEventLine);
    return {
      title: session.title || session.id,
      subtitle: session.id,
      icon: icons.created,
      sections: [
        {
          title: "conversation",
          fields: [
            {
              label: `${statusGlyph} status`,
              value: session.status,
              tone: statusTone,
            },
            {
              label: `${icons.model} model`,
              value: session.model || "not set",
            },
            {
              label: `${icons.created} created`,
              value: sessionTimestamp(session.createdAt),
            },
            {
              label: `${icons.time} elapsed`,
              value:
                sessionElapsedLabel(
                  session.createdAt,
                  session.updatedAt ?? session.createdAt,
                ) || "not recorded",
            },
            {
              label: `${icons.tokens} tokens`,
              value:
                typeof session.runTokenCount === "number"
                  ? `${session.runTokenCount} run tokens`
                  : "not reported",
            },
            ...(parent
              ? [{ label: `${icons.parent} parent`, value: parent.id }]
              : []),
            ...(children.length
              ? [
                  {
                    label: `${icons.children} children`,
                    value: `${children.length} spawned`,
                  },
                ]
              : []),
          ],
        },
        {
          title: "recent events",
          fields: [],
          body: recent.length ? recent : ["No retained events."],
        },
      ],
      hint: "Enter opens this conversation in Chat.",
    };
  }
  /** The narrow inspector: it replaces the list until Esc gives it back. */
  private sessionInspectorLines(id: string, width: number): string[] {
    const session = this.workbench.get(id);
    if (!session) return [];
    return renderInspector(this.sessionInspectorSpec(session), {
      width: Math.max(1, width),
      motion: motionContext(this.frame),
    });
  }
}

export function message(error: unknown) {
  return error instanceof Error ? error.message : "Operation failed.";
}
export function transcript(events: readonly SessionEvent[]): string[] {
  const rows: string[] = [];
  let partial = "";
  for (const e of events) {
    if (e.type === "message.delta") {
      partial += e.text;
      continue;
    }
    if (e.kind === "assistant") partial = "";
    if (e.type === "run.status" || e.kind === "usage") continue;
    if (e.kind === "tool" || e.kind === "error")
      rows.push(
        `[${e.at.slice(11, 19)}] ${e.kind === "tool" ? "TOOL" : "ERROR"}`,
      );
    rows.push(...e.text.split("\n"), "");
  }
  if (partial) rows.push(...partial.split("\n"));
  return rows;
}
type ChatRow = {
  text: string;
  style:
    | "assistant"
    | "user"
    | "role-tool"
    | "role-error"
    | "heading"
    | "code"
    | "diff-add"
    | "diff-remove"
    | "diff-context"
    | "tool"
    | "error"
    | "text"
    | "quote"
    | "reasoning";
  promptStart?: boolean;
  markdown?: boolean;
};
export type ToolActivityMode = "compact" | "details" | "expanded";
const TOOL_ACTIVITY_MODES: readonly ToolActivityMode[] = [
  "compact",
  "details",
  "expanded",
];
export function nextToolActivityMode(
  current: ToolActivityMode,
): ToolActivityMode {
  const index = TOOL_ACTIVITY_MODES.indexOf(current);
  return TOOL_ACTIVITY_MODES[(index + 1) % TOOL_ACTIVITY_MODES.length]!;
}
function normalizeToolActivityMode(
  mode: ToolActivityMode | boolean,
): ToolActivityMode {
  return typeof mode === "boolean" ? (mode ? "compact" : "details") : mode;
}
type InlineMarkdownPart = {
  text: string;
  style?: "strong" | "code";
};
function inlineMarkdownParts(value: string): InlineMarkdownPart[] {
  const parts: InlineMarkdownPart[] = [];
  const pattern = /\*\*([^*]+)\*\*|__([^_]+)__|`([^`]+)`/g;
  let cursor = 0;
  for (const match of value.matchAll(pattern)) {
    const index = match.index ?? 0;
    if (index > cursor) parts.push({ text: value.slice(cursor, index) });
    const code = match[3];
    parts.push({
      text: code ?? match[1] ?? match[2] ?? "",
      style: code === undefined ? "strong" : "code",
    });
    cursor = index + match[0].length;
  }
  if (cursor < value.length) parts.push({ text: value.slice(cursor) });
  return parts.length ? parts : [{ text: value }];
}
function displayedEventText(event: SessionEvent): string {
  if (event.kind !== "error") return event.text;
  // Older persisted transcripts used the generic failure copy for HTTP 503,
  // which incorrectly suggested credential and rate-limit problems. Keep
  // historical rows truthful without changing the stored Workbench event.
  return event.text.replace(
    /Provider request failed \(HTTP 503\)\. Check credentials, model access or rate limits\./g,
    "Provider service unavailable (HTTP 503). Try again later.",
  );
}

function toolDetailRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function redactToolDetail(value: string): string {
  // Preserve real line boundaries for activity previews. Sanitizing the whole
  // value first turns newlines into visible question marks and flattens code.
  return stripAnsi(value)
    .split(/\r\n?|\n/)
    .map((line) => sanitizeText(line))
    .join("\n")
    .replace(
      /\b(?:sk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9_]{12,}|xox[baprs]-[A-Za-z0-9-]{12,})\b/g,
      "[redacted]",
    )
    .replace(
      /\b((?:api[_-]?key|access[_-]?token|refresh[_-]?token|secret|password|authorization)\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;&]+)/gi,
      "$1[redacted]",
    )
    .replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi, "Bearer [redacted]")
    .replace(
      /([?&](?:api[_-]?key|token|secret|password)=)[^&\s]+/gi,
      "$1[redacted]",
    );
}

/**
 * Gutter and range options for a code preview.
 *
 * `startLine` numbers the rows from the position the recorded content starts
 * at; without it the plain `│` gutter is kept, which is what the generic tool
 * fallback has always printed. `totalLines` is only ever the number the result
 * itself states, never a guess from the shown rows.
 */
interface ToolCodePreviewOptions {
  readonly startLine?: number;
  readonly totalLines?: number;
}

function toolCodePreview(
  label: string,
  value: string,
  mode: ToolActivityMode,
  maximumCharacters: number,
  maximumLines: number,
  options?: ToolCodePreviewOptions,
): string[] {
  const lines = value.split("\n");
  const shown = value.slice(0, maximumCharacters);
  const shownLines = shown.split("\n");
  const preview =
    mode === "expanded"
      ? shownLines
      : shownLines
          .slice(0, maximumLines)
          .map((line) => (line.length > 180 ? `${line.slice(0, 179)}…` : line));
  const startLine = options?.startLine;
  const totalLines = options?.totalLines;
  const endLine =
    startLine === undefined ? undefined : startLine + preview.length - 1;
  // The header names the shown range only when the result states the total it
  // belongs to; otherwise it stays the measured count of recorded lines.
  const header =
    startLine !== undefined && totalLines !== undefined && endLine !== undefined
      ? `${label} · lines ${startLine}-${endLine} of ${totalLines}`
      : `${label} · ${lines.length} lines · ${value.length} chars`;
  const omitted: string[] = [];
  const hiddenLines =
    startLine !== undefined && totalLines !== undefined && endLine !== undefined
      ? Math.max(0, totalLines - endLine)
      : mode !== "expanded"
        ? Math.max(0, lines.length - maximumLines)
        : 0;
  if (hiddenLines > 0) omitted.push(`… ${hiddenLines} more lines`);
  if (value.length > maximumCharacters)
    omitted.push(`… ${value.length - maximumCharacters} characters omitted`);
  if (mode !== "expanded" && value.length > maximumCharacters)
    omitted.push(`… ${value.length} characters total`);
  return [
    header,
    "  ┌ code",
    ...preview.map((line, index) =>
      startLine === undefined
        ? `  │ ${line}`
        : `  ${String(startLine + index).padStart(2)} │ ${line}`,
    ),
    "  └ code",
    ...omitted,
  ];
}

const PRIVATE_TOOL_DETAIL_KEY =
  /(?:^|[_-])(?:chain[_-]?of[_-]?thought|(?:private|internal)[_-]?(?:reasoning|thoughts?)|reasoning|thoughts?)(?:$|[_-])/i;

function isPrivateToolDetailKey(key: string): boolean {
  return PRIVATE_TOOL_DETAIL_KEY.test(key);
}

function toolDetailValue(
  key: string,
  value: unknown,
  mode: ToolActivityMode = "details",
  depth = 0,
): string[] {
  if (isPrivateToolDetailKey(key)) return [];
  if (
    /(?:^|[_-])(?:api[_-]?)?(?:key|token|secret|password|credential|authorization)(?:$|[_-])/i.test(
      key,
    )
  )
    return [`${key}: [redacted]`];
  if (typeof value === "string") {
    const safe = redactToolDetail(value);
    const lines = safe.split("\n");
    const isCodeOrPayload =
      /^(?:content|text|body|prompt|patch|diff|script|command|old_str|new_str|source|replacement|code)$/i.test(
        key,
      ) || lines.length > 1;
    if (!isCodeOrPayload && mode !== "expanded")
      return [`${key}: ${safe.replace(/\s+/g, " ").trim().slice(0, 180)}`];
    const maximumCharacters = mode === "expanded" ? 16 * 1024 : 900;
    return toolCodePreview(key, safe, mode, maximumCharacters, 5);
  }
  if (typeof value === "number" && Number.isFinite(value))
    return [`${key}: ${value}`];
  if (typeof value === "boolean") return [`${key}: ${value ? "yes" : "no"}`];
  if (Array.isArray(value)) {
    if (mode !== "expanded" || depth >= 5)
      return [`${key}: ${value.length} items`];
    const shown = value.slice(0, 32);
    return [
      `${key}: ${value.length} items`,
      ...shown.flatMap((item, index) =>
        toolDetailValue(`[${index}]`, item, mode, depth + 1),
      ),
      ...(shown.length < value.length
        ? [`… ${value.length - shown.length} more items`]
        : []),
    ];
  }
  const nested = toolDetailRecord(value);
  if (nested) {
    const visibleKeys = Object.keys(nested).filter(
      (childKey) => !isPrivateToolDetailKey(childKey),
    );
    const keys = visibleKeys.slice(0, 8);
    const suffix = keys.length < visibleKeys.length ? ", …" : "";
    if (mode === "expanded" && depth < 5) {
      const visibleEntries = Object.entries(nested).filter(
        ([childKey]) => !isPrivateToolDetailKey(childKey),
      );
      const entries = visibleEntries.slice(0, 32);
      return [
        `${key}: {`,
        ...entries.flatMap(([childKey, childValue]) =>
          toolDetailValue(childKey, childValue, mode, depth + 1),
        ),
        `}${entries.length < visibleEntries.length ? ` … ${visibleEntries.length - entries.length} more fields` : ""}`,
      ];
    }
    return [`${key}: { ${keys.join(", ")}${suffix} }`];
  }
  return [`${key}: unavailable`];
}

function toolOutputText(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(toolOutputText);
  const record = toolDetailRecord(value);
  if (!record) return [];
  if (Array.isArray(record.content)) {
    const content = record.content.flatMap((block) => {
      const item = toolDetailRecord(block);
      return typeof item?.text === "string" ? [item.text] : [];
    });
    if (content.length) return content;
  }
  return ["stdout", "output", "text", "message", "stderr"].flatMap((key) =>
    typeof record[key] === "string" ? [record[key] as string] : [],
  );
}

type ToolCardKind = "read" | "write" | "edit" | "bash";

// Only names that unambiguously describe one of the four operations are
// specialised. Everything else keeps the generic card, which already names
// every recorded argument and output, so an unknown tool is never squeezed
// into a shape it does not have.
const TOOL_CARD_KINDS: Readonly<Record<string, ToolCardKind>> = {
  read: "read",
  read_file: "read",
  readfile: "read",
  view_file: "read",
  open_file: "read",
  write: "write",
  write_file: "write",
  create_file: "write",
  edit: "edit",
  edit_file: "edit",
  replace_in_file: "edit",
  str_replace: "edit",
  apply_patch: "edit",
  bash: "bash",
  shell: "bash",
  run_bash: "bash",
  run_command: "bash",
  terminal: "bash",
};

function toolCardKind(toolName: string): ToolCardKind | undefined {
  return TOOL_CARD_KINDS[toolName.trim().toLowerCase()];
}

const TOOL_PATH_KEYS = [
  "path",
  "file_path",
  "filename",
  "file",
  "uri",
  "target_file",
];
const TOOL_COMMAND_KEYS = ["command", "cmd", "script"];
const TOOL_REMOVED_KEYS = [
  "old_str",
  "old_string",
  "oldText",
  "old_text",
  "old",
  "search",
  "find",
  "before",
];
const TOOL_ADDED_KEYS = [
  "new_str",
  "new_string",
  "newText",
  "new_text",
  "new",
  "replace",
  "replacement",
  "after",
];
const TOOL_WRITE_KEYS = ["content", "text", "body", "source", "code", "data"];
// A read result sometimes states where the returned content sits in the file.
// Only these recorded counts are used for the range label; nothing is inferred
// from the argument list or from the size of the shown text.
const TOOL_READ_START_KEYS = ["start_line", "startLine", "line_start", "lineStart"];
const TOOL_READ_TOTAL_KEYS = [
  "total_lines",
  "totalLines",
  "line_count",
  "lineCount",
  "num_lines",
  "numLines",
];

function toolArgumentText(
  args: Record<string, unknown> | undefined,
  keys: readonly string[],
): string | undefined {
  if (!args) return undefined;
  for (const key of keys) {
    const value = args[key];
    if (typeof value === "string" && value.trim() !== "") return value;
  }
  return undefined;
}

function toolPath(args: Record<string, unknown> | undefined): string | undefined {
  const value = toolArgumentText(args, TOOL_PATH_KEYS);
  return value === undefined
    ? undefined
    : redactToolDetail(value).split("\n", 1)[0]!.trim();
}

function toolRecordedCount(
  record: Record<string, unknown> | undefined,
  keys: readonly string[],
): number | undefined {
  if (!record) return undefined;
  for (const key of keys) {
    const value = record[key];
    const number =
      typeof value === "number"
        ? value
        : typeof value === "string" && /^\s*\d+\s*$/.test(value)
          ? Number(value.trim())
          : NaN;
    if (Number.isInteger(number) && number >= 1) return number;
  }
  return undefined;
}

/**
 * The recorded read range, or undefined when the result does not state one.
 *
 * A partial read reports the lines it returned; printing "of N" needs both
 * ends recorded and the returned content inside them, so an incomplete or
 * inconsistent record falls back to the measured line count.
 */
function toolReadRange(
  result: Record<string, unknown> | undefined,
  lineCount: number,
): { startLine: number; totalLines: number } | undefined {
  const startLine = toolRecordedCount(result, TOOL_READ_START_KEYS);
  const totalLines = toolRecordedCount(result, TOOL_READ_TOTAL_KEYS);
  if (startLine === undefined || totalLines === undefined) return undefined;
  if (totalLines < startLine + Math.max(0, lineCount - 1)) return undefined;
  return { startLine, totalLines };
}

/**
 * A diff-style preview for a write or an edit.
 *
 * The counts come from the recorded arguments, and the preview keeps the same
 * code fence the rest of the transcript uses. Anything the row or character
 * budget hides is named on its own row, so a cut preview never reads as a
 * short one.
 */
function toolDiffPreviewRows(
  label: string,
  removedText: string,
  addedText: string,
  mode: ToolActivityMode,
  addedStartLine?: number,
): string[] {
  const removed = removedText === "" ? [] : removedText.split("\n");
  const added = addedText === "" ? [] : addedText.split("\n");
  const entries: Array<{ sign: "-" | "+"; line: string; number?: number }> = [
    ...removed.map((line) => ({ sign: "-" as const, line })),
    // A whole new file records its own line positions; a replacement records
    // the text only, so an edit stays unnumbered rather than guessing one.
    ...added.map((line, index) => ({
      sign: "+" as const,
      line,
      ...(addedStartLine === undefined
        ? {}
        : { number: addedStartLine + index }),
    })),
  ];
  const maximumCharacters = mode === "expanded" ? 16 * 1024 : 900;
  const maximumLines = mode === "expanded" ? entries.length : 8;
  const shown: typeof entries = [];
  let used = 0;
  for (const entry of entries.slice(0, maximumLines)) {
    const cost = entry.line.length + 1;
    if (used + cost > maximumCharacters) break;
    shown.push(entry);
    used += cost;
  }
  const totalCharacters = entries.reduce(
    (total, entry) => total + entry.line.length + 1,
    0,
  );
  const rows = [
    `${label} · +${added.length} -${removed.length} lines`,
    "  ┌ code",
    ...shown.map((entry) => {
      const safe = redactToolDetail(entry.line);
      // The sign stays explicit in every mode: the tone is an extra cue, never
      // the only one, so a monochrome terminal reads the diff correctly.
      const gutter =
        entry.number === undefined
          ? `${entry.sign} `
          : `${entry.sign}${String(entry.number).padStart(2)} │ `;
      // The ellipsis marks the cut on the line itself; the counts below name
      // how many whole lines and characters are missing.
      return `  ${gutter}${safe.length > 180 ? `${safe.slice(0, 179)}…` : safe}`;
    }),
    "  └ code",
  ];
  const hiddenLines = entries.length - shown.length;
  if (hiddenLines > 0) rows.push(`  … ${hiddenLines} more lines`);
  if (totalCharacters > used)
    rows.push(`  … ${totalCharacters - used} characters omitted`);
  return rows;
}

/**
 * The specialised card body for a tool result, or undefined when the recorded
 * data does not support it. Undefined falls back to the generic card, which
 * still shows everything the event carried.
 */
function toolCardDetails(
  kind: ToolCardKind,
  event: SessionEvent,
  mode: ToolActivityMode,
  startedArguments: Record<string, unknown> | undefined,
): string[] | undefined {
  const result = toolDetailRecord(event.payload?.result);
  if (!result || result.isError === true) return undefined;
  const output = toolOutputText(result).join("\n");
  const maximumCharacters = mode === "expanded" ? 16 * 1024 : 900;
  const maximumLines = mode === "expanded" ? 24 : 6;
  const path = toolPath(startedArguments);
  if (kind === "read") {
    if (output.trim() === "") return undefined;
    const range = toolReadRange(result, output.split("\n").length);
    return toolCodePreview(
      path ?? "read",
      output,
      mode,
      maximumCharacters,
      maximumLines,
      {
        startLine: range?.startLine ?? 1,
        ...(range === undefined ? {} : { totalLines: range.totalLines }),
      },
    );
  }
  if (kind === "write") {
    const content = toolArgumentText(startedArguments, TOOL_WRITE_KEYS) ?? "";
    if (content === "") return undefined;
    // A write records the whole new file, so its lines carry their real
    // positions from the first one.
    return toolDiffPreviewRows(path ?? "write", "", content, mode, 1);
  }
  if (kind === "edit") {
    const removed = toolArgumentText(startedArguments, TOOL_REMOVED_KEYS) ?? "";
    const added = toolArgumentText(startedArguments, TOOL_ADDED_KEYS) ?? "";
    if (removed === "" && added === "") return undefined;
    return toolDiffPreviewRows(path ?? "edit", removed, added, mode);
  }
  if (output.trim() === "") return undefined;
  const rows: string[] = [];
  const command = toolArgumentText(startedArguments, TOOL_COMMAND_KEYS);
  if (command !== undefined) {
    const lines = redactToolDetail(command).split("\n");
    rows.push(
      `command: ${lines[0]!.trim()}${
        lines.length > 1 ? ` · ${lines.length - 1} more lines` : ""
      }`,
    );
  }
  rows.push(
    ...toolCodePreview(
      "Output",
      output,
      mode,
      maximumCharacters,
      maximumLines,
      { startLine: 1 },
    ),
  );
  const exitCode =
    typeof result.exit_code === "number"
      ? result.exit_code
      : typeof result.exitCode === "number"
        ? result.exitCode
        : undefined;
  if (exitCode !== undefined) rows.push(`exit code: ${exitCode}`);
  return rows;
}

function compactToolText(event: SessionEvent, toolName: string): string {
  const result = toolDetailRecord(event.payload?.result);
  const verb =
    event.type === "tool.started"
      ? "Requested"
      : result?.isError === true
        ? "Failed"
        : "Completed";
  if (event.type === "tool.started") {
    const args = toolDetailRecord(event.payload?.arguments);
    if (args) {
      const previews = [
        "command",
        "cmd",
        "script",
        "path",
        "file_path",
        "filename",
        "file",
        "uri",
      ];
      for (const key of previews) {
        const value = args[key];
        if (typeof value !== "string" || !value.trim()) continue;
        const firstLine = redactToolDetail(value).split("\n", 1)[0]!.trim();
        return `${verb} · ${toolName} · ${key}: ${firstLine.slice(0, 140)}`;
      }
    }
  }
  const output = result ? toolOutputText(result).join("\n").trim() : "";
  if (output) {
    const outputLines = redactToolDetail(output).split("\n");
    const firstLine = outputLines[0]!.trim();
    const omitted = [
      ...(outputLines.length > 1
        ? [`${outputLines.length - 1} more lines`]
        : []),
      ...(firstLine.length > 140
        ? [`${firstLine.length - 140} more chars`]
        : []),
    ];
    return `${verb} · ${toolName} · ${firstLine.slice(0, 140)}${
      omitted.length ? ` · ${omitted.join(" · ")}` : ""
    }`;
  }
  return `${verb} · ${displayedEventText(event)}`;
}

function toolEventDetails(
  event: SessionEvent,
  mode: ToolActivityMode,
  startedArguments?: Record<string, unknown>,
): string[] {
  // Render only recorded tool I/O. Provider-private reasoning is not present
  // in these events and is never synthesized from the model response.
  const payload = event.payload;
  if (event.type === "tool.result") {
    const toolName =
      typeof payload?.tool === "string" ? sanitizeText(payload.tool) : "";
    const kind = toolCardKind(toolName);
    if (kind) {
      const card = toolCardDetails(
        kind,
        event,
        mode,
        startedArguments ?? toolDetailRecord(payload?.arguments),
      );
      if (card) return card;
    }
  }
  if (event.type === "tool.started") {
    const args = toolDetailRecord(payload?.arguments);
    if (!args) {
      const summary = redactToolDetail(event.text).trim();
      return summary ? [summary] : ["Arguments unavailable"];
    }
    const priority = [
      "command",
      "cmd",
      "script",
      "path",
      "file_path",
      "filename",
      "file",
      "uri",
      "patch",
      "diff",
      "old_str",
      "new_str",
      "content",
      "query",
    ];
    const rank = (key: string) => {
      const index = priority.indexOf(key.toLowerCase());
      return index < 0 ? priority.length : index;
    };
    const entries = Object.entries(args)
      .filter(([key]) => !isPrivateToolDetailKey(key))
      .sort(([left], [right]) => rank(left) - rank(right));
    const shown =
      mode === "expanded" ? entries.slice(0, 32) : entries.slice(0, 8);
    const details = shown.flatMap(([key, value]) =>
      toolDetailValue(key, value, mode),
    );
    if (shown.length < entries.length)
      details.push(`… ${entries.length - shown.length} more fields`);
    return details.length
      ? ["Arguments", ...details]
      : ["Arguments unavailable"];
  }
  const result = payload?.result;
  const output = toolOutputText(result).join("\n").trim();
  const details: string[] = [];
  if (output) {
    const safe = redactToolDetail(output);
    const maximumCharacters = mode === "expanded" ? 16 * 1024 : 1200;
    details.push(
      ...toolCodePreview("Output", safe, mode, maximumCharacters, 6),
    );
  } else {
    const summary = redactToolDetail(event.text).trim();
    if (summary) details.push(summary);
  }
  return details.length ? details : ["No output returned"];
}

/**
 * How many recorded reasoning lines a collapsed block may show.
 *
 * The bound follows the terminal the operator has, so a short viewport keeps
 * its composer and approval keys rather than spending them on thinking text.
 * The expanded activity mode (Ctrl+O) lifts the bound; the label always names
 * the state, so a monochrome terminal loses nothing.
 */
function reasoningLineBudget(width: number, terminalHeight: number): number {
  const narrow = width < 60;
  if (terminalHeight <= 14) return narrow ? 1 : 2;
  if (terminalHeight <= 26) return narrow ? 2 : 3;
  if (terminalHeight <= 38) return narrow ? 4 : 5;
  return narrow ? 6 : 8;
}

/** Terminal-only presentation. Never evaluate Markdown, HTML or terminal escapes. */
export function chatRows(
  events: readonly SessionEvent[],
  width: number,
  requestedActivityMode: ToolActivityMode | boolean = "details",
  density: ChatDensity = "comfortable",
  timestamps = false,
  hideToolActivity = false,
  symbolPreset: SymbolPreset = "unicode",
  terminalHeight = 40,
): ChatRow[] {
  const activityMode = normalizeToolActivityMode(requestedActivityMode);
  const rows: ChatRow[] = [];
  let partial = "";
  const add = (
    value: string,
    style: ChatRow["style"],
    promptStart = false,
    markdown = false,
  ) => {
    const wrapped = wrap([value], width);
    rows.push(
      ...wrapped.map((text, index) => ({
        text,
        style,
        ...(promptStart && index === 0 ? { promptStart: true } : {}),
        ...(markdown ? { markdown: true } : {}),
      })),
    );
  };
  const messageRows = (
    value: string,
    kind: SessionEvent["kind"],
    label: string,
    spacerAfter = true,
  ) => {
    const roleStyle: ChatRow["style"] =
      kind === "assistant"
        ? "assistant"
        : kind === "error"
          ? "role-error"
          : "role-tool";
    if (kind !== "user" && label) add(label, roleStyle);
    let promptMarked = false;
    const addBody = (text: string, style: ChatRow["style"]) => {
      if (kind === "user") {
        const marker = getSymbols(symbolPreset).role.user;
        const inset = visibleLength(marker) + 1;
        const chunks = wrap([text], Math.max(1, width - inset));
        rows.push(
          ...chunks.map((chunk, index) => ({
            text: `${index === 0 ? `${marker} ` : " ".repeat(inset)}${chunk}`,
            style: "user" as const,
            ...(!promptMarked && index === 0 ? { promptStart: true } : {}),
          })),
        );
        promptMarked = true;
        return;
      }
      add(text, style, false, kind === "assistant" && style === "text");
    };
    let fence = "",
      lineNumber = 0;
    const todoPattern = /^\s*[-*+]\s*\[( |x|X)\]\s+(.+)$/;
    const checklist =
      kind === "assistant" ? extractTodos([{ seq: 0, kind, text: value }]) : [];
    const completedTodos = checklist.filter((item) => item.done).length;
    for (const raw of value.split("\n")) {
      const marker = /^\s{0,3}(`{3,}|~{3,})(.*)$/.exec(raw);
      if (
        kind !== "user" &&
        marker &&
        (!fence ||
          (marker[1]![0] === fence[0] &&
            marker[1]!.length >= fence.length &&
            !marker[2]!.trim()))
      ) {
        if (fence) {
          addBody("  └ end code", "tool");
          fence = "";
        } else {
          fence = marker[1]!;
          lineNumber = 0;
          addBody(`  ┌ ${marker[2]!.trim() || "code"}`, "code");
        }
      } else if (fence) {
        const prefix = `  ${String(++lineNumber).padStart(2)} │ `;
        for (const [i, chunk] of wrap(
          [raw],
          Math.max(1, width - prefix.length),
        ).entries())
          addBody(
            (i ? " ".repeat(prefix.length - 2) + "│ " : prefix) + chunk,
            "code",
          );
      } else {
        const heading = kind === "assistant" && /^#{1,6}\s/.test(raw);
        const quote = kind === "assistant" && /^>\s?/.exec(raw);
        const task = kind === "assistant" ? todoPattern.exec(raw) : null;
        const bullet = kind === "assistant" && /^\s*[-*+]\s+/.exec(raw);
        const todoHeading =
          kind === "assistant" &&
          checklist.length > 0 &&
          /^(?:#{1,6}\s*)?TODO:?$/i.test(raw.trim());
        const body = todoHeading
          ? `TODO · ${completedTodos}/${checklist.length}`
          : task
            ? `${/^\s*/.exec(raw)?.[0] ?? ""}${task[1] === " " ? "○" : "✓"} ${task[2]}`
            : quote
              ? `│ ${raw.slice(quote[0].length)}`
              : bullet
                ? `${raw.slice(0, bullet[0].length - 1)}• ${raw.slice(bullet[0].length)}`
                : heading
                  ? raw.replace(/^#{1,6}\s+/, "")
                  : raw;
        addBody(
          body,
          quote ? "quote" : heading || todoHeading ? "heading" : "text",
        );
      }
    }
    if (spacerAfter && density === "comfortable") add("", "text");
  };
  // Provider reasoning is recorded as its own `reasoning.delta` events. They
  // are shown as a bounded, labeled block before the answer they precede.
  // Nothing here synthesizes thinking from elapsed time or a run phase: no
  // recorded event, no block.
  const expandedReasoning = activityMode === "expanded";
  const addReasoning = (value: string) => {
    const content = value
      .split(/\r\n?|\n/)
      .map((line) => line.trimEnd())
      .filter((line) => line.trim().length > 0)
      .flatMap((line) => wrap([line], Math.max(1, width - 2)))
      .map((line) => `  ${line}`);
    if (content.length === 0) return;
    const budget = expandedReasoning
      ? content.length
      : reasoningLineBudget(width, terminalHeight);
    const shown = content.slice(0, budget);
    const hidden = content.length - shown.length;
    rows.push({
      text: expandedReasoning ? "~ thinking · expanded" : "~ thinking",
      style: "reasoning",
    });
    for (const line of shown) rows.push({ text: line, style: "reasoning" });
    if (hidden > 0) {
      // Name the remainder instead of silently cutting it. The key hint
      // shortens or drops out before the count does, because the count is the
      // fact and the key is only advice.
      const count = `  ... ${hidden} more thinking lines`;
      const line =
        [
          `${count} · Ctrl+O expand`,
          `${count} · Ctrl+O`,
          count,
        ].find((candidate) => visibleLength(candidate) <= width) ?? count;
      for (const text of wrap([line], width))
        rows.push({ text, style: "reasoning" });
    }
  };
  // Consecutive reasoning deltas form one block. A skipped status or usage
  // event does not split it, and the flush happens before the next visible
  // event so the block keeps its place ahead of the answer or tool card.
  let reasoningText = "";
  let reasoningOpen = false;
  const flushReasoning = () => {
    if (!reasoningOpen) return;
    const value = reasoningText;
    reasoningText = "";
    reasoningOpen = false;
    addReasoning(value);
  };
  const nextVisibleKind = (start: number): SessionEvent["kind"] | undefined => {
    for (let index = start; index < events.length; index++) {
      const event = events[index]!;
      if (
      event.type === "run.status" ||
      event.kind === "usage" ||
      (event.type ?? "").startsWith("harness.")
    )
      continue;
      return event.kind;
    }
    return undefined;
  };
  const toolStartedAt = new Map<string, number>();
  // The arguments of a call are recorded on its start event; a result event
  // carries only the output. Pairing them by call id lets a result card name
  // the path or command it belongs to instead of guessing.
  const toolStartedArguments = new Map<string, Record<string, unknown>>();
  for (let eventIndex = 0; eventIndex < events.length; eventIndex++) {
    const event = events[eventIndex]!;
    if (event.type === "reasoning.delta") {
      reasoningText += event.text;
      reasoningOpen = true;
      continue;
    }
    if (event.type === "message.delta") {
      // The answer follows the reasoning it was produced after, so the block
      // is closed before the streamed answer text accumulates.
      flushReasoning();
      partial += event.text;
      continue;
    }
    if (event.kind === "assistant") partial = "";
    if (
      event.type === "run.status" ||
      event.kind === "usage" ||
      (event.type ?? "").startsWith("harness.")
    )
      continue;
    flushReasoning();
    if (hideToolActivity && event.kind === "tool") continue;
    // Keep role and time context for non-user events; user content stays plain.
    const toolName =
      typeof event.payload?.tool === "string"
        ? sanitizeText(event.payload.tool)
        : "Tool";
    const callId =
      typeof event.payload?.callId === "string"
        ? event.payload.callId
        : undefined;
    if (event.kind === "tool" && event.type === "tool.started" && callId) {
      const startedAt = Date.parse(event.at);
      if (Number.isFinite(startedAt)) toolStartedAt.set(callId, startedAt);
      const argumentsRecord = toolDetailRecord(event.payload?.arguments);
      if (argumentsRecord)
        toolStartedArguments.set(callId, argumentsRecord);
    }
    const completedAt = Date.parse(event.at);
    const startedAt = callId ? toolStartedAt.get(callId) : undefined;
    const toolDuration =
      event.kind === "tool" &&
      event.type === "tool.result" &&
      startedAt !== undefined &&
      Number.isFinite(completedAt) &&
      completedAt >= startedAt
        ? completedAt - startedAt
        : undefined;
    const time = timestamps ? `  ${event.at.slice(11, 19)}` : "";
    const label =
      event.kind === "user"
        ? ""
        : event.kind === "assistant"
          ? time.trim()
          : event.kind === "error"
            ? `${roleIcon("error")} ERROR${time}`
            : event.type === "tool.started"
              ? `${roleIcon("tool")} ${toolName} running${time}`
              : `${roleIcon("tool")} ${toolName} result${time}`;
    if (event.kind === "error" || event.kind === "tool") {
      const bodyBudget =
        event.kind === "error" ? 6 : activityMode === "compact" ? 4 : undefined;
      const toolText =
        event.kind === "tool" && activityMode !== "compact"
          ? toolEventDetails(
              event,
              activityMode,
              callId ? toolStartedArguments.get(callId) : undefined,
            ).join("\n")
          : event.kind === "tool"
            ? compactToolText(event, toolName)
            : displayedEventText(event);
      const resultRecord = toolDetailRecord(event.payload?.result);
      const blockRows = renderBlock(
        {
          role: event.kind === "error" ? "error" : "tool",
          text: toolText,
          ...(timestamps ? { at: event.at } : {}),
          ...(event.kind === "tool" ? { heading: toolName } : {}),
          ...(event.kind === "tool" && toolDuration !== undefined
            ? { durationMs: toolDuration }
            : {}),
          ...(event.kind === "tool"
            ? {
                status:
                  event.type === "tool.started"
                    ? ("running" as const)
                    : resultRecord?.isError === true
                      ? ("failed" as const)
                      : ("done" as const),
              }
            : {}),
          collapsible: true,
        },
        {
          width,
          motion: motionContext(0, false, true),
          symbolPreset,
        },
        bodyBudget,
      );
      let inCodeBlock = false;
      blockRows.forEach((row, index) => {
        const opensCodeBlock = row.trim() === "┌ code";
        const closesCodeBlock = row.trim() === "└ code";
        if (opensCodeBlock) inCodeBlock = true;
        // A diff preview row keeps its explicit sign in the text; the style
        // only adds the success/error tone where colour is available, so the
        // meaning never depends on it. The sign sits in the two-space gutter
        // the diff rows are built with, which keeps a numbered preview row
        // (`  1 │ ...`) from being mistaken for a diff line.
        //
        // The fence rows, the `path · +N -M lines` header and the omission
        // notes are context: they are muted rather than toned, so a reader can
        // tell a change from the frame that reports it. A diff card indents
        // its omission note under the code block while a read card prints it
        // flush, so the note is recognised at either indent.
        const diffContextRow =
          row.trim() === "┌ code" ||
          row.trim() === "└ code" ||
          /^ {0,2}… \d+ (?:more lines|characters omitted)$/u.test(row) ||
          /^[^\s].* · \+\d+ -\d+ lines$/u.test(row);
        const codeStyle: ChatRow["style"] = diffContextRow
          ? "diff-context"
          : /^ {2}\+[ 0-9]/.test(row)
            ? "diff-add"
            : /^ {2}-[ 0-9]/.test(row)
              ? "diff-remove"
              : "code";
        const style: ChatRow["style"] =
          index === 0
            ? event.kind === "error"
              ? "role-error"
              : "role-tool"
            : index === blockRows.length - 1
              ? event.kind === "error"
                ? "error"
                : "tool"
              : inCodeBlock || diffContextRow
                ? codeStyle
                : "text";
        add(row, style);
        if (closesCodeBlock) inCodeBlock = false;
      });
      if (density === "comfortable") add("", "text");
      continue;
    }
    messageRows(
      displayedEventText(event),
      event.kind,
      label,
      !(event.kind === "user" && nextVisibleKind(eventIndex + 1) === "error"),
    );
  }
  flushReasoning();
  if (partial) messageRows(partial, "assistant", "");
  return rows;
}

export function wrap(
  lines: readonly string[],
  width: number,
  trustedIcons: readonly string[] = [],
): string[] {
  const out: string[] = [];
  for (const line of lines) {
    let part = "";
    let partWidth = 0;
    let spaceStart = -1;
    let spaceEnd = -1;
    for (const point of safeTextUnits(line, trustedIcons)) {
      const pointWidth = visibleLength(point);
      const whitespace = point.trim() === "";
      if (part && partWidth + pointWidth > width) {
        if (spaceStart > 0) {
          out.push(part.slice(0, spaceStart));
          part = part.slice(spaceEnd);
          partWidth = visibleLength(part);
          spaceStart = -1;
          spaceEnd = -1;
        }
        if (part && partWidth + pointWidth > width) {
          out.push(part);
          part = "";
          partWidth = 0;
          spaceStart = -1;
          spaceEnd = -1;
        }
        if (whitespace && part === "") continue;
      }
      const pointStart = part.length;
      part += point;
      partWidth += pointWidth;
      if (whitespace) {
        if (spaceEnd !== pointStart) spaceStart = pointStart;
        spaceEnd = part.length;
      }
    }
    out.push(part);
  }
  return out;
}
export const TUI_COMMANDS = [
  ["/new", "New conversation"],
  ["/clear", "Start fresh and retain history"],
  ["/chat", "Return to chat"],
  ["/bottom", "Follow latest messages"],
  ["/find", "Search conversation text"],
  ["/sessions", "Open conversation history"],
  ["/resume", "Resume a conversation"],
  ["/runs", "Run states, progress and reconciliation"],
  ["/rewind", "Review operation IDs or run ID for recovery"],
  ["/recovery", "Refresh a recovery job without applying it"],
  ["/queue", "Inspect queued text or /queue resume when runtime allows"],
  ["/cancel", "Cancel queued text without stopping a run"],
  ["/documents", "Documents and revisions"],
  ["/context", "Managed documents and context"],
  ["/ledger", "Signed operations"],
  ["/approvals", "Pending decisions"],
  ["/models", "Available models"],
  ["/doctor", "Environment checks"],
  ["/init", "Set up workspace storage"],
  ["/conformance", "Run adapter conformance checks"],
  ["/status", "Workspace status"],
  ["/health", "Pass, warn, fail or unknown for every subsystem"],
  ["/discover", "Commands grouped by the task you arrived with"],
  ["/cost", "Token usage and cost"],
  ["/compact", "Review real context compaction"],
  ["/subagent", "Cancel a verified child or review and deliver its result"],
  ["/todos", "Checklist from agent output"],
  ["/agents", "Runtime profiles, conversations and connectors"],
  ["/agent", "Select a profile for new conversations"],
  ["/agent-file", "Review and save a custom profile from path.json"],
  ["/revoke-agent", "Review local agent revocation"],
  ["/hooks", "Runtime hook support and operator allowlist"],
  ["/hook-file", "Review a hook if the host supports execution"],
  ["/hook", "Enable or disable a saved hook by id"],
  ["/projects", "List persisted projects"],
  ["/project", "Select a project ID or none for new conversations"],
  ["/project-file", "Review and save a project from path.json"],
  ["/config", "Resolved paths and flags"],
  ["/settings", "Interactive appearance and workspace settings"],
  ["/memory", "Retained local history"],
  ["/model", "Set model for new chats"],
  ["/plan", "Switch to plan mode"],
  ["/stats", "Token usage and cost"],
  ["/diff", "Outstanding document changes"],
  ["/diff-next", "Next outstanding change in the diff panel"],
  ["/theme", "Color and motion for this session"],
  ["/pet", "Show, hide or place NIB: /pet on, off, dock or perch"],
  ["/keybindings", "Keyboard shortcut reference"],
  ["/exit", "Save and quit"],
  ["/export", "Save ledger, chat or document"],
  ["/attest", "Signed slice for a third party"],
  ["/providers", "Model providers and local open models"],
  [
    "/harness",
    "Agent harness: cloud, prime-agent, scores, review, approve, reject",
  ],
  ["/login", "Connect a provider"],
  ["/logout", "Disconnect the provider"],
  ["/verify", "Verify signatures"],
  ["/undo", "Preview Undo"],
  ["/edit", "Open document editor"],
  ["/history", "Document history"],
  ["/branch", "Create a branch"],
  ["/retry", "Retry with confirmation"],
  ["/tools", "Search tools and inspect schemas"],
  ["/expand", "Toggle full tool output"],
  ["/connect opencode:zen", "Connect OpenCode Zen from local auth"],
  ["/connect omp:nvidia", "Connect NVIDIA NIM from the local OMP auth store"],
  [
    "/connect omp:openrouter",
    "Connect OpenRouter from the local OMP auth store",
  ],
  [
    "/connect prime:openai-codex",
    "Run OpenAI Codex through the installed Prime Agent login",
  ],
  [
    "/connect claude:claude-code",
    "Run Claude Code through the installed Claude host login",
  ],
  ["/policy", "Tool policies"],
  ["/permissions", "Tool policies and approvals"],
  ["/mcp", "MCP connectors: add, probe, confirm, rename, remove"],
  ["/usage", "Model usage"],
  ["/stop", "Stop run"],
  ["/help", "All commands"],
  ["/quit", "Save and quit"],
] as const;

/** A local credential source, as the discovery API reports it. */
type ConnectSource = Awaited<
  ReturnType<typeof desktopSetup>
>["sources"][number];

/**
 * Providers whose credential providerState reads from the host environment when
 * nothing is configured yet (packages/workbench/src/index.ts:1697-1783).
 *
 * Every other provider is reached through a local credential source or not at
 * all, so the directory never advertises an environment path NOMO does not
 * actually read.
 */
const ENV_CONNECT_PROVIDERS: ReadonlySet<string> = new Set([
  "nvidia",
  "openrouter",
  "qwen",
]);

/** True when the pinned provider manifest declares OAuth for this provider. */
function declaresOAuth(providerId: string): boolean {
  return PROVIDER_MODEL_MANIFEST.providers.some(
    (provider) =>
      provider.status === "in-scope" &&
      provider.providerId === providerId &&
      provider.authentication.methods.some((method) =>
        method.startsWith("oauth"),
      ),
  );
}

/**
 * Local sources that carry a credential for one preset.
 *
 * Discovery reports the store and the vendor name, not the preset id, so the
 * name is the join key; the source id suffix covers a vendor whose display name
 * was reworded. Nothing is inferred past those two matches.
 */
function sourcesForPreset(
  preset: { readonly id: string; readonly name: string },
  sources: readonly ConnectSource[],
): readonly ConnectSource[] {
  const name = preset.name.toLocaleLowerCase();
  return sources.filter(
    (source) =>
      source.name.toLocaleLowerCase() === name ||
      source.id.slice(source.id.indexOf(":") + 1) === preset.id,
  );
}

/**
 * The auth method one discovered source carries.
 *
 * Discovery reports an OAuth source as unavailable with an oauth reason
 * (apps/control-plane/api/desktop-setup.ts:sourceStatus), so the reason is the
 * only signal needed: everything else it returns is an API-key source. A
 * source whose api-key route is unavailable is still an API-key source, just an
 * unusable one, which the availability word already says.
 */
function sourceAuth(
  source: ConnectSource,
): "api-key" | "oauth" | "host-subscription" {
  if ("authMethod" in source && source.authMethod === "host-subscription")
    return "host-subscription";
  const reason = "reason" in source ? source.reason : undefined;
  return reason?.startsWith("oauth") ? "oauth" : "api-key";
}

/** Human words for the fixed host probe reasons. No account data, no path. */
const HOST_AVAILABILITY: Readonly<Record<string, string>> = {
  "host-not-installed": "host CLI not installed",
  "host-login-required": "host login required",
  "host-api-key-only": "host login required (API key only, not a subscription)",
  "host-login-unknown": "host login could not be verified",
  "host-provider-unavailable": "provider not in the host catalog",
  "host-probe-failed": "host probe failed",
};

/**
 * The availability word for one discovered source.
 *
 * Discovery reports an OAuth source as unavailable with a reason
 * (apps/control-plane/api/desktop-setup.ts:sourceStatus). "not available"
 * alone leaves the operator guessing whether the entry is missing, stale or
 * simply unreachable by this terminal, so the OAuth reason is repeated in
 * short form. It is a fixed word from the discovery record: no token, no file
 * path and no endpoint ever reaches this row.
 */
function sourceAvailability(source: ConnectSource): string {
  if (source.available) return "available";
  const reason = "reason" in source ? source.reason : undefined;
  if (sourceAuth(source) === "host-subscription")
    return HOST_AVAILABILITY[String(reason)] ?? "host unavailable";
  if (sourceAuth(source) === "oauth" && reason)
    return `oauth unavailable: ${reason.replace(/^oauth-/, "")}`;
  return "not available";
}

/**
 * The /providers rows for one preset.
 *
 * One row per discovered source, because availability belongs to a source and
 * not to a vendor: a vendor can have an importable key in one store and an
 * unusable OAuth entry in another. A preset with no source gets one row that
 * names the connect path that exists instead. No credential value and no file
 * path ever reaches these rows.
 */
function providerDirectoryLines(
  preset: (typeof PROVIDER_PRESETS)[number],
  current: string | undefined,
  sources: readonly ConnectSource[],
): string[] {
  const marker = preset.id === current ? "[*]" : "[ ]";
  const local =
    "local" in preset && preset.local
      ? "  (local, runs open models like Hermes)"
      : "";
  const prefix = `${marker} ${preset.id}  ${preset.name}${local}`;
  if (sources.length)
    return sources.map(
      (source) =>
        `${prefix}  auth=${sourceAuth(source)}` +
        `  ${source.id} (${sourceAvailability(source)})`,
    );
  const methods: string[] = [];
  if (ENV_CONNECT_PROVIDERS.has(preset.id)) methods.push("env");
  if (declaresOAuth(preset.id)) methods.push("oauth");
  const connect = methods.includes("env")
    ? "host environment"
    : methods.includes("oauth")
      ? "oauth only"
      : "no connect path";
  const availability = methods.includes("env")
    ? "not probed"
    : methods.includes("oauth")
      ? "not available"
      : "unavailable";
  return [
    `${prefix}  auth=${methods.join(",") || "unsupported"}` +
      `  ${connect} (${availability})`,
  ];
}

/**
 * The /providers frame title.
 *
 * It is the detail's first line so the panel title carries it, and lines()
 * drops that line from the body: the frame already names the directory, and a
 * short terminal cannot afford to print the same sentence twice before the
 * first source row.
 */
const PROVIDERS_DETAIL_TITLE = "PROVIDERS · /connect ID";

/**
 * The latest source list any workspace discovered.
 *
 * Command completion runs inside the synchronous render and key loops, which
 * cannot await discovery. They read this cache; the palette and /providers pass
 * the workspace's own list explicitly, so a stale cache never changes what
 * those surfaces claim.
 */
let discoveredConnectSources: readonly ConnectSource[] = [];

/**
 * IDs the help already documents, used until discovery has run.
 *
 * Derived from TUI_COMMANDS rather than declared again: the help entries are
 * the one place a source ID is already written down, and completion must not
 * promise an ID that the help does not name.
 */
const DOCUMENTED_CONNECT_IDS = TUI_COMMANDS.filter(([name]) =>
  name.startsWith("/connect "),
).map(([name, hint]) => ({ id: name.slice("/connect ".length), hint }));

/**
 * Complete the source ID argument of /connect and /login.
 *
 * Discovery is the authority: every ID it returned is offered with the name and
 * store it came from and whether its credential is available. The hint carries
 * no value and no path, only what an operator needs to choose.
 */
function connectSourceSuggestions(
  command: string,
  partial: string,
  sources: readonly ConnectSource[],
): readonly (readonly [string, string])[] {
  const prefix = partial.trim().toLocaleLowerCase();
  const candidates: readonly { readonly id: string; readonly hint: string }[] =
    sources.length
    ? sources.map((source) => ({
        id: source.id,
        hint: `${source.name} (${source.source}) ${
          source.available ? "available" : "not available"
        }`,
      }))
    : DOCUMENTED_CONNECT_IDS;
  return candidates
    .filter((candidate) => candidate.id.toLocaleLowerCase().startsWith(prefix))
    .map((candidate) => [`/${command} ${candidate.id}`, candidate.hint] as const);
}

export function commandSuggestions(
  input: string,
  sources: readonly ConnectSource[] = discoveredConnectSources,
): readonly (readonly [string, string])[] {
  // One command takes a fixed, discoverable ID list, so its argument completes
  // from the same menu as command names. Every other command keeps the
  // bare-name contract: after the space, the argument hint speaks instead.
  const connect = /^\/(connect|login)\s+(\S*)$/.exec(input);
  if (connect)
    return connectSourceSuggestions(connect[1]!, connect[2]!, sources);
  if (!/^\/[^\s]*$/.test(input)) return [];
  const query = input.slice(1).toLocaleLowerCase();
  const matches = ([name]: (typeof TUI_COMMANDS)[number]) => {
    const command = name.slice(1).split(" ")[0]!.toLocaleLowerCase();
    let cursor = 0;
    for (const point of command) if (point === query[cursor]) cursor++;
    return cursor === query.length;
  };
  return TUI_COMMANDS.filter(matches).sort(
    (left, right) =>
      Number(!left[0].startsWith(input)) - Number(!right[0].startsWith(input)),
  );
}
/**
 * The argument each command takes, for the hint that appears once the
 * operator has typed the command and a space.
 *
 * Declared rather than inferred. TUI_COMMANDS carries a description and no
 * argument, and the only other place the shape of an argument appears is the
 * error message a handler throws when it is missing. Reading a contract out
 * of an error string would couple the hint to wording that exists for a
 * different reader, and a command whose error message was reworded would
 * silently start showing a stale placeholder.
 *
 * Commands absent here take no argument, and the hint stays silent for them
 * rather than guessing.
 */
const COMMAND_ARGUMENTS: Record<string, string> = {
  "/model": "exact-ID",
  "/connect": "SOURCE-ID",
  "/login": "SOURCE-ID",
  "/agent": "ID",
  "/document": "path",
  "/open": "number-or-ID",
  "/resume": "number-or-ID",
  "/branch": "seq",
  "/rename": "title",
  "/project": "ID or none",
  "/undo": "operation-ID",
  "/rewind": "operation-IDs",
  "/recovery": "job-ID",
  "/queue": "",
  "/export": "ledger, chat or document",
  "/filter": "text",
  "/settings": "key value",
  "/harness":
    "cloud, prime-agent, scores, review, approve DIGEST, reject DIGEST",
  "/theme": "color, mono, motion, still or reset",
  "/approve": "hold-ID [reason]",
  "/deny": "hold-ID [reason]",
  "/tools": "search text",
  "/policy-file": "connector-ID path.yaml",
  "/connector-file": "path.json",
  "/agent-file": "path.json",
  "/revoke-agent": "agent-id",
  "/hook-file": "path.json",
  "/conformance": "adapter",
  "/compact": "",
  "/new": "conversation",
  "/mcp": "inspect, add, probe, confirm, rename or remove",
  "/mcp inspect": "ID",
  "/mcp add": "URL [name]",
  "/mcp probe": "ID",
  "/mcp confirm": "ID",
  "/mcp rename": "ID name",
  "/mcp remove": "ID",
  "/subagent": "cancel or review",
};

/**
 * The argument a command takes, or undefined when it takes none.
 *
 * A subcommand carries its own shape: "/mcp probe" takes an id while "/mcp"
 * alone takes several. The longest matching prefix wins, so a hint never
 * says "verb" when the operator has already typed the noun.
 */
export function commandArgumentHint(command: string): string | undefined {
  if (!command.startsWith("/")) return undefined;
  const words = command.trim().split(/\s+/);
  for (let take = words.length; take > 0; take -= 1) {
    const key = words.slice(0, take).join(" ");
    if (key in COMMAND_ARGUMENTS) return COMMAND_ARGUMENTS[key] || undefined;
  }
  return undefined;
}

export type WorkspaceVisuals = {
  now?: number;
  color?: boolean;
  capabilities?: TerminalCapabilities;
  frame?: number;
  motion?: boolean;
  boot?: boolean;
  command?: string;
  suggestion?: number;
  suggestionsDismissed?: boolean;
  cursor?: number;
  /**
   * The directory the location segment describes. The runner leaves it unset
   * so the frame reports `process.cwd()`; tests and the preview pin it to a
   * fixture repository instead of changing the process directory.
   */
  cwd?: string;
};

const CHAT_TAB_LABELS: Record<
  WorkspaceTab,
  { compact: string; short: string }
> = {
  chat: { compact: "C", short: "CHAT" },
  sessions: { compact: "S", short: "SESS" },
  runs: { compact: "R", short: "RUNS" },
  documents: { compact: "D", short: "DOCS" },
  ledger: { compact: "L", short: "LEDG" },
  approvals: { compact: "A", short: "APPR" },
  policy: { compact: "P", short: "POLI" },
  tools: { compact: "T", short: "TOOL" },
  mcp: { compact: "N", short: "MCP" },
  status: { compact: "H", short: "STAT" },
  models: { compact: "M", short: "MODE" },
  usage: { compact: "U", short: "USAG" },
  help: { compact: "H", short: "HELP" },
};

export const TAB_ICON_TONE: Record<WorkspaceTab, string> = {
  chat: "38;5;117",
  sessions: "38;5;183",
  runs: "38;5;75",
  documents: "38;5;78",
  ledger: "38;5;179",
  approvals: "38;5;203",
  policy: "38;5;245",
  tools: "38;5;214",
  mcp: "38;5;81",
  status: "38;5;117",
  models: "38;5;75",
  usage: "38;5;228",
  help: "38;5;245",
};
// Single cell symbols only, so visibleLength stays exact on every terminal.
// Geometric shapes (U+25A0 to U+25FF) count one cell in layout.ts, while emoji
// and dingbat ranges count two. Icons never carry safety meaning alone, the
// [0] to [3] and [+]/[!]/[x] markers stay authoritative.
export const TAB_ICONS: Record<WorkspaceTab, string> = {
  chat: "●",
  sessions: "≡",
  runs: "▶",
  documents: "▤",
  ledger: "▪",
  approvals: "◉",
  policy: "§",
  tools: "+",
  mcp: "↔",
  status: "●",
  models: "◐",
  usage: "◔",
  help: "?",
};
/**
 * Row icons for the item lists.
 *
 * Every list row gets a glyph so a column of rows can be scanned by shape
 * before it is read. Like the tab icons these are single cell geometric shapes,
 * and none of them is the only signal for anything: the state word stays in
 * the label, so removing the icon loses speed, not meaning.
 */
export const ROW_ICONS = {
  running: "◉",
  run: "▶",
  settled: "●",
  failed: "×",
  queued: "◔",
  unknown: "?",
  archived: "□",
  session: "●",
  document: "▤",
  ledgerEntry: "▪",
  proxyEntry: "▫",
  learned: "◇",
  hook: "◇",
  harness: "◈",
  agent: "◆",
  tool: "+",
  connector: "▣",
  provider: "◈",
  model: "◐",
  approval: "◉",
  rejected: "×",
  undo: "↩",
  // U+25B7 rather than the pencil U+270E, which counts two cells and would
  // shift every label one column to the right of this glyph.
  edit: "▷",
  create: "+",
  delete: "×",
} as const;

/**
 * Icon for a run or session state. An unknown state gets the question mark
 * rather than a default, because guessing a settled dot for a state nobody
 * recognised would read as a fact the terminal had not been told.
 */
export function stateIcon(state: string): string {
  const key = state.toLowerCase();
  if (key.includes("await") || key.includes("approval"))
    return ROW_ICONS.approval;
  if (key.includes("run") || key.includes("active")) return ROW_ICONS.running;
  if (key.includes("fail") || key.includes("error")) return ROW_ICONS.failed;
  if (
    key.includes("queue") ||
    key.includes("pending") ||
    key.includes("stopp") ||
    key.includes("paus")
  )
    return ROW_ICONS.queued;
  if (key.includes("archiv")) return ROW_ICONS.archived;
  if (
    key.includes("idle") ||
    key.includes("settl") ||
    key.includes("done") ||
    key.includes("complet")
  )
    return ROW_ICONS.settled;
  return ROW_ICONS.unknown;
}

export const MODE_ICON: Record<TuiMode, string> = {
  normal: "◆",
  accept: "●",
  plan: "○",
};

// Iconoir's CPU Chip, Network, and Server forms become one-cell marks here;
// terminal rows cannot embed the source SVGs without changing the renderer.
export function modelProviderIcon(id: string, name = ""): string {
  const key = `${id} ${name}`.toLowerCase();
  if (key.includes("nvidia")) return "▦";
  if (key.includes("openrouter")) return "◎";
  return ROW_ICONS.provider;
}
// Clean prompt frame. Box drawing characters are removed in favour of
// a minimal border that reads as a modern input surface.
export function promptFrameTop(title: string, width: number): string {
  const fitted = fit(title, Math.max(1, width - 4));
  return `┌ ${fitted} ${"─".repeat(Math.max(0, width - visibleLength(fitted) - 4))}┐`;
}
export function promptFrameBottom(width: number): string {
  return `└${"─".repeat(Math.max(0, width - 2))}┘`;
}
export function promptFrameRow(content: string, width: number): string {
  return `  ${pad(content, Math.max(0, width - 4))}  `;
}
// Progress bar with gradient
export function progressBar(
  current: number,
  total: number,
  width: number,
): string {
  const filled = Math.max(
    0,
    Math.min(width, Math.round((current / Math.max(1, total)) * width)),
  );
  const empty = Math.max(0, width - filled);
  return `█`.repeat(filled) + `░`.repeat(empty);
}
// Spinner frames for loading
export const SPINNER_FRAMES = [
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
];
function hasVisibleTextFrom(value: string, start = 0): boolean {
  for (let index = start; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (
      code !== 0x09 &&
      code !== 0x0a &&
      code !== 0x0b &&
      code !== 0x0c &&
      code !== 0x0d &&
      code !== 0x20 &&
      code !== 0x00a0 &&
      code !== 0x1680 &&
      !(code >= 0x2000 && code <= 0x200a) &&
      code !== 0x2028 &&
      code !== 0x2029 &&
      code !== 0x202f &&
      code !== 0x205f &&
      code !== 0x3000 &&
      code !== 0xfeff
    )
      return true;
  }
  return false;
}

/** Keep whole words that fit, so a clipped hint never ends mid-word. */
function truncateWords(value: string, width: number): string {
  if (width <= 0) return "";
  if (visibleLength(value) <= width) return value;
  let kept = "";
  for (const word of value.split(" ")) {
    const next = kept ? `${kept} ${word}` : word;
    if (visibleLength(next) > width) break;
    kept = next;
  }
  return kept || fit(value, width);
}

/**
 * A suggestion hint that fits the room left on the row.
 *
 * The description of a source ends with whether it can be used, and a plain
 * truncation cuts that word in half on a narrow terminal: the operator sees
 * "availab" and cannot tell available from unavailable. The availability word
 * is kept whole when it fits and the rest is dropped at a word boundary.
 */
function suggestionHint(description: string, room: number): string {
  if (visibleLength(description) <= room) return description;
  const availability = /(not available|available)$/.exec(description)?.[1];
  if (availability)
    return visibleLength(availability) <= room
      ? availability
      : fit(availability, room);
  return truncateWords(description, room);
}

/**
 * The Chat notice band.
 *
 * A panel prints the notice in its status row, but Chat has no status row of
 * its own, so a refused command, a saved export or a dropped connector used to
 * reach no surface there. The band wraps the notice and yields rows to the
 * transcript when the terminal is short; a clipped notice ends with an
 * ellipsis so it never reads as a complete message.
 */
function chatNoticeRows(
  notice: string,
  width: number,
  maxRows: number,
): string[] {
  if (!notice || notice === "Ready" || maxRows <= 0) return [];
  const rows = wrap(notice.split("\n"), Math.max(1, width));
  if (rows.length <= maxRows) return rows;
  const shown = rows.slice(0, maxRows);
  shown[maxRows - 1] = `${truncateWords(shown[maxRows - 1]!, Math.max(1, width - 2))} …`;
  return shown;
}

/**
 * The one-line form of a notice, for the panel status row.
 *
 * Chat renders the whole notice in its own band; a panel has one status row,
 * and a newline inside it would paint as a replacement character.
 */
function noticeLine(notice: string): string {
  if (!notice.includes("\n")) return notice;
  return notice.split("\n").find((line) => line.trim())?.trim() ?? "";
}

/**
 * The terminal width from which the palette can afford a preview pane.
 *
 * Below it the list keeps every cell: a preview that squeezed the command ids
 * into a narrow column would cost the operator the thing they opened the
 * palette for. The threshold is the terminal, not the inner panel width, so it
 * is the same number at every tab and border.
 */
export const PALETTE_PREVIEW_MIN_COLUMNS = 100;

/** The widest the palette preview pane may grow, and the gap beside it. */
const PALETTE_PREVIEW_MAX = 40;
const PALETTE_PREVIEW_GAP = 2;
/** The narrowest the command list may become before the preview is dropped. */
const PALETTE_LIST_MIN = 24;

/** The preview pane width for a terminal, or 0 when the frame cannot afford it. */
export function palettePreviewWidth(
  columns: number,
  innerWidth: number,
): number {
  if (Math.floor(columns) < PALETTE_PREVIEW_MIN_COLUMNS) return 0;
  const inner = Math.max(1, Math.floor(innerWidth));
  const width = Math.min(
    PALETTE_PREVIEW_MAX,
    Math.max(24, Math.floor(inner * 0.34)),
  );
  return inner - width - PALETTE_PREVIEW_GAP >= PALETTE_LIST_MIN ? width : 0;
}

/**
 * What the palette preview says about the selected command.
 *
 * Every line is real: the command's own id, the group the palette filed it in,
 * the summary it was registered with and the argument shape the command
 * handler actually accepts. A command with no declared argument prints no
 * usage line rather than a placeholder that would read as a real one.
 */
export function palettePreviewLines(
  item: PaletteItem | undefined,
  width: number,
): string[] {
  const cells = Math.max(1, Math.floor(width));
  const row = (value: string): string => pad(fit(value, cells), cells);
  if (!item) return [row("PREVIEW"), row(""), row("No command selected.")];
  const lines: string[] = [row(`PREVIEW · ${item.group.toUpperCase()}`), row("")];
  lines.push(row(sanitizeText(item.id)));
  for (const line of wrap([sanitizeText(item.hint)], cells)) lines.push(row(line));
  const usage = commandArgumentHint(item.id);
  if (usage !== undefined && usage !== "") {
    for (const line of wrap(
      [`usage: ${sanitizeText(item.id)} ${sanitizeText(usage)}`],
      cells,
    ))
      lines.push(row(line));
  }
  lines.push(row(""));
  lines.push(row("Enter runs it"));
  lines.push(row("Esc closes"));
  return lines;
}

/**
 * Join the palette list and its preview pane into `left + gap + right` rows.
 *
 * Both sides are fitted to their own column, so the merged row is exactly
 * `leftWidth + gap + rightWidth` cells wide whatever the command text is.
 */
export function paletteWithPreview(
  left: readonly string[],
  preview: readonly string[],
  leftWidth: number,
  previewWidth: number,
  gap = PALETTE_PREVIEW_GAP,
): string[] {
  const listWidth = Math.max(1, Math.floor(leftWidth));
  const paneWidth = Math.max(1, Math.floor(previewWidth));
  const space = " ".repeat(Math.max(0, Math.floor(gap)));
  const height = Math.max(left.length, preview.length);
  return Array.from({ length: height }, (_, index) =>
    `${pad(left[index] ?? "", listWidth)}${space}${pad(preview[index] ?? "", paneWidth)}`,
  );
}

/** The most toasts the stack shows at once, and where it is allowed to draw. */
export const TOAST_STACK_MAX = 3;
export const TOAST_STACK_MIN_COLUMNS = 60;
export const TOAST_STACK_MIN_ROWS = 18;
/** The narrowest stack that still reads as a message rather than a stub. */
const TOAST_STACK_MIN_WIDTH = 24;
/** The widest one toast may become, so it stays a notice, not a panel. */
const TOAST_STACK_MAX_WIDTH = 48;
/** Cells the remaining-life bar spends in front of the message. */
const TOAST_STACK_BAR_CELLS = 4;

/**
 * Whether a frame may carry the transient toast stack at all.
 *
 * Below this size the composer and the review keys own every row, and a toast
 * that pushed either off the frame would cost more than it delivered. The
 * sticky approval banner is a different surface and stays.
 */
export function toastStackVisible(columns: number, rows: number): boolean {
  return (
    Math.floor(columns) >= TOAST_STACK_MIN_COLUMNS &&
    Math.floor(rows) >= TOAST_STACK_MIN_ROWS
  );
}

/** The width of one right-aligned toast row, or 0 when none can be drawn. */
export function toastStackWidth(width: number): number {
  const cells = Math.max(0, Math.floor(width));
  if (cells < TOAST_STACK_MIN_WIDTH + 2) return 0;
  return Math.min(TOAST_STACK_MAX_WIDTH, cells - 2);
}

export type ToastStackOptions = {
  /** The inner frame width the rows are laid out in. */
  readonly width: number;
  /** Epoch milliseconds the frame was drawn at, for the life bar. */
  readonly now: number;
  readonly color: boolean;
  /** The preset's filled and empty progress cells. */
  readonly filled: string;
  readonly empty: string;
  /** The dismiss glyph, one cell in every preset. */
  readonly close: string;
  readonly max?: number;
};

/**
 * The transient notice stack: the newest few toasts, right aligned.
 *
 * Each row carries a thin bar of the life the toast has left, so a notice
 * about to fade says so instead of vanishing mid-read. A sticky toast (ttl 0)
 * carries a full bar because it has no deadline to measure. The rows are
 * exactly `width` cells wide and never wider than one readable message, which
 * is what keeps the stack off the composer keys below it.
 */
export function toastStackRows(
  host: ToastHost,
  options: ToastStackOptions,
): string[] {
  const width = Math.max(0, Math.floor(options.width));
  const toastWidth = toastStackWidth(width);
  if (toastWidth === 0 || host.toasts.length === 0) return [];
  const maximum = Math.max(1, Math.floor(options.max ?? TOAST_STACK_MAX));
  const shown = host.toasts.slice(0, maximum);
  const messageWidth = Math.max(1, toastWidth - TOAST_STACK_BAR_CELLS - 3);
  const messages = renderToasts(
    { toasts: shown, active: shown[0] },
    messageWidth,
    { color: options.color },
  );
  const filledGlyph =
    visibleLength(options.filled) === 1 ? options.filled : "#";
  const emptyGlyph = visibleLength(options.empty) === 1 ? options.empty : "-";
  const closeGlyph = visibleLength(options.close) === 1 ? options.close : "x";
  const lead = width - toastWidth;
  return shown.map((toast, index) => {
    const remaining =
      toast.ttl <= 0
        ? 1
        : Math.max(0, Math.min(1, 1 - (options.now - toast.at) / toast.ttl));
    const filledCells = Math.max(
      0,
      Math.min(TOAST_STACK_BAR_CELLS, Math.ceil(remaining * TOAST_STACK_BAR_CELLS)),
    );
    const bar =
      filledGlyph.repeat(filledCells) +
      emptyGlyph.repeat(TOAST_STACK_BAR_CELLS - filledCells);
    const message = messages[index] ?? "";
    const row = `${bar} ${pad(message, messageWidth)} ${closeGlyph}`;
    return `${" ".repeat(Math.max(0, lead))}${pad(row, toastWidth)}`;
  });
}

export type StickyTranscriptInput = {
  /** The conversation title, or undefined while it has none. */
  readonly title?: string;
  /** The phase word the frame already uses for this run. */
  readonly phase: string;
  /** The scrolled-up marker, one cell in the active preset. */
  readonly arrow: string;
  readonly width: number;
};

/**
 * The slim line that names the conversation while the transcript is scrolled.
 *
 * It rides a body row the frame already budgeted, so the composer, the status
 * row and the review keys keep their places. The breadcrumb is the one thing
 * the visible transcript rows no longer show, because the message that named
 * the conversation has scrolled out of view.
 */
export function stickyTranscriptLine(input: StickyTranscriptInput): string {
  const width = Math.max(1, Math.floor(input.width));
  const title = sanitizeText(stripAnsi(input.title ?? ""))
    .replace(/\s+/g, " ")
    .trim();
  const phase = sanitizeText(stripAnsi(input.phase)).replace(/\s+/g, " ").trim();
  const breadcrumb = title === "" ? "Chat" : `Chat > ${title}`;
  const arrow = visibleLength(input.arrow) === 1 ? input.arrow : "^";
  return fit(`${arrow} ${breadcrumb}${phase === "" ? "" : ` · ${phase}`}`, width);
}

/** A horizontal span in terminal cells, zero based. */
export type CellSpan = { readonly start: number; readonly end: number };

/** The first visible span of `needle` in a possibly painted row. */
export function cellSpan(rowText: string, needle: string): CellSpan | undefined {
  if (needle === "") return undefined;
  const plain = stripAnsi(rowText);
  const at = plain.indexOf(needle);
  if (at < 0) return undefined;
  const start = visibleLength(plain.slice(0, at));
  return { start, end: start + visibleLength(needle) - 1 };
}

/**
 * The model and token fact spans in one session browser row.
 *
 * The row prints its facts after the title, each behind its own icon, so the
 * only reliable place to look is the trailing segment list. Scanning it from
 * the last separator keeps a title that happens to contain the same glyph from
 * claiming a hit target the fact does not own.
 */
export function sessionRowFactSpans(
  line: string,
  icons: SessionRowIcons,
): { model?: CellSpan; tokens?: CellSpan } {
  // The wide layout paints the inspector beside the list on the same row, so
  // the fact scan stops at the pane divider rather than reading the inspector's
  // own values as the row's. The divider is one cell wide in both symbol
  // presets: the Unicode box-drawing bar and the ASCII pipe.
  const plain = stripAnsi(line).split(/ [│|] /)[0] ?? "";
  const parts = plain.split(" · ");
  if (parts.length < 2) return {};
  let cursor = 0;
  const spans: CellSpan[] = [];
  for (const part of parts) {
    const start = cursor;
    spans.push({ start, end: start + visibleLength(part) - 1 });
    cursor = start + visibleLength(part) + 3;
  }
  const spanFor = (icon: string): CellSpan | undefined => {
    const prefix = `${icon} `;
    for (let index = parts.length - 1; index >= 1; index -= 1) {
      const part = parts[index]!;
      if (!part.startsWith(prefix)) continue;
      const span = spans[index]!;
      // The span names the icon and its value, not the separator before it.
      return { start: span.start, end: span.end };
    }
    return undefined;
  };
  const model = spanFor(icons.model);
  const tokens = spanFor(icons.tokens);
  return {
    ...(model === undefined ? {} : { model }),
    ...(tokens === undefined ? {} : { tokens }),
  };
}

export function renderWorkspace(
  ui: WorkspaceTui,
  columns: number,
  rows: number,
  input = "",
  editing = false,
  busy = false,
  visuals: WorkspaceVisuals = {},
): string {
  const terminalWidth = Math.max(1, Math.floor(columns)),
    terminalHeight = Math.max(1, Math.floor(rows));
  ui.tabHitTargets = [];
  ui.rowHitTargets = [];
  if (terminalWidth < 20 || terminalHeight < 8) {
    ui.viewport = { offset: 0, height: 0, total: 0, width: terminalWidth };
    // Nothing is drawn below the minimum size, so the idle pet has nothing to
    // animate and must not keep asking the runner for a frame.
    ui.petAnimating = false;
    const message =
      terminalWidth < 20 && terminalHeight < 8
        ? "Widen and heighten terminal"
        : terminalWidth < 20
          ? "Widen terminal"
          : "Heighten terminal";
    const messageRow = Math.floor((terminalHeight - 1) / 2);
    return Array.from({ length: terminalHeight }, (_, row) =>
      pad(row === messageRow ? fit(message, terminalWidth) : "", terminalWidth),
    ).join("\n");
  }
  // The startup splash owns the whole frame for its short life, so it is
  // decided before any panel state is read. `now` comes from the caller when
  // it supplied one, which is what makes the dismissal testable; otherwise
  // the real clock decides. The runner is the only writer of the deadline.
  const splashNow = typeof visuals.now === "number" ? visuals.now : Date.now();
  if (ui.petSplashUntil > splashNow) {
    const splash = renderPetSplashFrame(terminalWidth, terminalHeight);
    if (splash !== null) {
      ui.petAnimating = false;
      ui.viewport = { offset: 0, height: 0, total: 0, width: terminalWidth };
      return splash;
    }
  }
  const modelPickerOpen = ui.modelPicker?.open === true;
  const chatBaseVisible =
    ui.tab === "chat" &&
    !ui.detail &&
    !ui.confirmation &&
    !ui.palette &&
    !modelPickerOpen &&
    !ui.diffView &&
    !ui.showingKeybindings &&
    !ui.showingCheatSheet;
  const panelOverlay = !chatBaseVisible;
  const panelFrameRows = panelOverlay ? 2 : 0;
  const panelTopOffset = panelOverlay ? 1 : 0;
  const chatPanelMarginX = chatBaseVisible
    ? terminalWidth >= 56
      ? 2
      : terminalWidth >= 40
        ? 1
        : 0
    : 0;
  const chatPanelTopMarginY = chatBaseVisible
    ? terminalHeight >= 24
      ? 2
      : terminalHeight >= 16
        ? 1
        : 0
    : 0;
  const width = panelOverlay
    ? Math.max(1, terminalWidth - 2)
    : chatBaseVisible
      ? Math.max(1, terminalWidth - chatPanelMarginX * 2)
      : terminalWidth;
  const height = panelOverlay
    ? Math.max(1, terminalHeight - panelFrameRows)
    : terminalHeight;
  const trustedIcons = trustedLocalIconLabels(
    ui.localTabIcons,
    ui.themeConfig.colorTheme,
  );
  const spaciousShell =
    !panelOverlay &&
    terminalHeight >= 22 &&
    terminalWidth >= 78 &&
    !ui.confirmation;
  const panelIcons = getSymbols(ui.themeConfig.symbolPreset).icons;
  const tabIcon = (tab: WorkspaceTab, fallback: string) =>
    ui.localTabIcons
      ? kittyTabIconLabel(tab, ui.localTabIcons, ui.themeConfig.colorTheme) ||
        fallback
      : fallback;
  const tabPanelIcons: Record<WorkspaceTab, string> = {
    chat: tabIcon("chat", panelIcons.agent),
    sessions: tabIcon("sessions", panelIcons.session),
    runs: tabIcon("runs", panelIcons.run),
    documents: tabIcon("documents", panelIcons.document),
    ledger: tabIcon("ledger", panelIcons.ledger),
    approvals: tabIcon("approvals", panelIcons.approval),
    policy: tabIcon("policy", panelIcons.policy),
    tools: tabIcon("tools", panelIcons.tool),
    mcp: tabIcon("mcp", panelIcons.network),
    status: tabIcon("status", panelIcons.settings),
    models: tabIcon("models", panelIcons.model),
    usage: tabIcon("usage", panelIcons.usage),
    help: tabIcon("help", panelIcons.help),
  };
  const panelTitle = modelPickerOpen
    ? `${tabPanelIcons.models} Models`
    : ui.settingsOpen
      ? `${tabPanelIcons.status} Settings`
      : ui.confirmation
      ? `${tabPanelIcons.approvals} Review`
      : ui.showingKeybindings
        ? `${panelIcons.key} Keybindings`
        : ui.showingCheatSheet
          ? `${panelIcons.help} Shortcuts`
          : ui.diffView
            ? `${tabPanelIcons.documents} Diff`
            : ui.tab !== "chat"
              ? `${tabPanelIcons[ui.tab]} ${ui.tab[0]!.toUpperCase()}${ui.tab.slice(1)}`
              : ui.detail?.[0]
                ? safeTextUnits(ui.detail[0], trustedIcons).join("")
                : `${panelIcons.help} Details`;
  // The keybinding table sizes its columns to the terminal, so a resize has to
  // re-lay it out. Re-rendering on every frame would be wasteful, so it only
  // happens when the width actually moved.
  if (ui.showingKeybindings && ui.keybindingWidth !== width)
    ui.refreshKeybindings(width);
  // Same for the cheat sheet: it sizes its columns to the terminal, so a
  // resize has to re-lay it. Only on an actual width change, for the same
  // reason the keybinding table does not re-lay every frame.
  if (ui.showingCheatSheet && ui.cheatWidth !== width)
    ui.refreshCheatSheet(width);
  // Terminal capabilities for theme rendering (omp-style)
  const detectedCaps = visuals.capabilities
    ? {
        ...visuals.capabilities,
        columns: terminalWidth,
        rows: terminalHeight,
      }
    : detectCapabilities(ui.env, {
        columns: terminalWidth,
        rows: terminalHeight,
        isTTY: false,
      });
  const colorEnabled = detectedCaps.ansi && visuals.color !== false;
  visuals = { ...visuals, color: colorEnabled };
  const caps: TerminalCapabilities = {
    ...detectedCaps,
    columns: width,
    rows: height,
    ansi: colorEnabled,
    colorDepth: colorEnabled ? detectedCaps.colorDepth : 0,
  };
  const ink = (value: string, code: string) =>
    visuals.color ? `\x1b[${code}m${value}\x1b[0;39m` : value;
  const text = (value: string) => fit(sanitizeText(value), width);
  const amber = "38;5;215",
    ice = "38;5;117",
    mutedAnsi = "38;5;245";
  const workbenchRunning = ui.workbench.running();
  const sessionRunning = ui.session()?.status === "running";
  const running = busy || workbenchRunning;
  const frame = visuals.motion === false ? 0 : (visuals.frame ?? 0);
  // One motion context drives every effect in the frame, so they stay in phase
  // with each other and a paused frame pauses all of them together.
  const motion = motionContext(visuals.frame ?? 0, visuals.motion !== false);
  // Published before anything asks the model for lines, because the list rows
  // animate their cursor marker and are built on the model side.
  ui.frame = motion.frame;
  // Published before the detail is asked for lines, same reason as the frame
  // above: the cheat sheet lists editing bindings and has to know whether the
  // keyboard currently belongs to the prompt.
  //
  // The previous value is what tells this frame whether focus was just gained,
  // so the six-frame sweep starts once and settles rather than restarting on
  // every redraw.
  const composerFocusGained = editing && !ui.editingInput;
  ui.editingInput = editing;
  if (composerFocusGained) ui.composerFocusFrame = motion.frame;
  else if (!editing) ui.composerFocusFrame = -1;
  const pending = ui.workbench.pending();
  const holds = pending.length + ui.proxy.holds.length;
  const workbenchSessions = ui.workbench.list();
  const conversationCount = workbenchSessions.length;
  // One summary for the whole frame: the pet, the task header, the rails and
  // the footer all read the same cached derivation of the events, so none of
  // them can disagree about the checklist or the usage report.
  const sessionEvents = ui.session()?.events ?? [];
  const sessionSummary = chatEventSummary(sessionEvents);
  const sessionTodos = sessionSummary.todos;
  // A child card names the work its own transcript proves. Workbench.list()
  // strips events from every view, so the child's own view is read for them;
  // `Workbench.get` is a map lookup that returns undefined rather than
  // throwing for an id that is no longer present, and a child without a tool
  // event keeps its two-row card and gets no activity line.
  const childSessions: readonly SubagentSession[] = ui.sessionId
    ? workbenchSessions
        .filter((session) => session.parentId === ui.sessionId)
        .map((session) => {
          const activity = subagentActivityFromEvents(
            ui.workbench.get(session.id)?.events,
          );
          return activity === undefined ? session : { ...session, ...activity };
        })
    : [];
  // The receipt for the run that just settled, from the events that carry the
  // session's current run id. A run still in flight has no receipt: the task
  // header above names its phase instead.
  const sessionRunId = ui.session()?.runId;
  const runSummary = running
    ? undefined
    : runSummaryFromEvents({
        events: sessionEvents,
        ...(sessionRunId === undefined ? {} : { runId: sessionRunId }),
      });
  // The rail is requested only when it has something real to carry, so an
  // empty conversation keeps the full transcript width. The thresholds are
  // the operator's terminal size, not the inner panel width.
  const railRequested =
    chatBaseVisible &&
    terminalWidth >= CHAT_RAIL_MIN_WIDTH &&
    terminalHeight >= CHAT_RAIL_MIN_HEIGHT &&
    (sessionTodos.length > 0 ||
      childSessions.length > 0 ||
      runSummary !== undefined);
  const chatRailWidth = railRequested
    ? Math.min(34, Math.max(24, Math.floor(width * 0.28)))
    : 0;
  const latestUserAt = sessionSummary.latestUser
    ? Date.parse(sessionSummary.latestUser.at)
    : NaN;
  const nowMs =
    typeof visuals.now === "number" && Number.isFinite(visuals.now)
      ? visuals.now
      : undefined;
  const runningSeconds =
    nowMs !== undefined &&
    Number.isFinite(latestUserAt) &&
    ui.session()?.status === "running"
      ? Math.max(0, Math.floor((nowMs - latestUserAt) / 1_000))
      : undefined;
  const waiting = pending.some((hold) =>
    hold.holdId.startsWith(`${ui.sessionId}:`),
  );
  // A run that is waiting on a human is not a run that is progressing. The
  // marker says so at a glance: a slower, heavier glyph, because the next
  // thing that happens will be a decision, not output.
  const spinner = running
    ? waiting
      ? cautionSpinner(motion)
      : runningIndicator(motion)
    : "◆";
  // Sticky approval banner: the oldest pending hold stays pinned above the
  // body on every tab, so a hold is never hidden behind a panel switch.
  const banner = approvalBannerLines(
    [
      ...pending.map((hold) => ({
        holdId: hold.holdId,
        call: {
          tool: String((hold.call as { tool?: unknown }).tool ?? "unknown"),
          klass: (hold.call as { klass?: unknown }).klass as string | undefined,
        },
      })),
      ...ui.proxy.holds.map((hold) => ({
        holdId: hold.holdId,
        call: { tool: hold.call.tool, klass: hold.call.klass },
      })),
    ],
    width,
    ui.tab !== "chat" &&
      (!ui.editingInput &&
        !ui.filter &&
        !ui.detail &&
        !ui.diffView &&
        !ui.confirmation &&
        !ui.palette &&
        !ui.modelPicker &&
        !ui.showingKeybindings &&
        !ui.showingCheatSheet),
  );
  // Toasts sit below the approval banner and above the body on a panel. The
  // banner is sticky and authoritative; toasts are the transient layer under
  // it, so a raise never has to choose between being seen and being safe.
  //
  // Chat places the same queue as a right aligned stack just above the
  // composer, where the operator is already looking, and suppresses it below
  // 60x18: at that size the composer and the review keys own every row, and a
  // toast that pushed either off the frame would charge more than it
  // delivered. The approval banner is a different surface and is never
  // suppressed.
  const toastPresetSymbols = getSymbols(ui.themeConfig.symbolPreset);
  const toastRows = chatBaseVisible
    ? toastStackVisible(terminalWidth, terminalHeight)
      ? toastStackRows(ui.toasts, {
          width,
          now:
            typeof visuals.now === "number" && Number.isFinite(visuals.now)
              ? visuals.now
              : Date.now(),
          color: visuals.color === true,
          filled: toastPresetSymbols.progress.filled,
          empty: toastPresetSymbols.progress.empty,
          close: ui.themeConfig.symbolPreset === "ascii" ? "x" : "×",
        })
      : []
    : renderToasts(ui.toasts, width - 4, {
        color: visuals.color === true,
      });
  const header: string[] = [];
  const tallBrand = chatBaseVisible && height >= 22 && width >= 64;
  if (chatBaseVisible) {
    if (tallBrand) header.push(...brandHeader("NOMO  Chat", caps));
    else header.push(fit(`${compactBrandMark(caps)}  ${ink("NOMO", `1;${ice}`)}  Chat`, width));
  } else {
    const backLabel = "← Chat";
    const navRow = panelTopOffset + 1;
    const navColumn = panelTopOffset + 1;
    header.push(
      fit(
        ink(backLabel, `1;${ice}`) + ink("  ·  Esc returns to Chat", mutedAnsi),
        width,
      ),
    );
    ui.tabHitTargets.push({
      tab: "chat",
      row: navRow,
      start: navColumn,
      end: navColumn + visibleLength(backLabel) - 1,
    });
  }
  // The task header needs a row of its own only where the frame can spare
  // one. A frame that cannot keeps it on the brand row it already prints, in
  // the one word form, so a 40x12 terminal still names the phase and the real
  // checklist count without losing the composer or the decision keys.
  const taskRowEligible =
    !panelOverlay && running && height - header.length >= 13;
  if (chatBaseVisible && !tallBrand && running && !taskRowEligible) {
    const compact = compactTaskHeaderLabel({
      phase: compactPhaseWord(sessionSummary.lastVisible, waiting),
      todos: todoProgress(sessionTodos),
    });
    if (compact !== "")
      header[0] = fit(
        `${compactBrandMark(caps)}  ${ink("NOMO", `1;${ice}`)}  Chat  ${ink(compact, mutedAnsi)}`,
        width,
      );
  }
  // NIB the pet shares a row the frame already owns, so it never adds a row
  // and a 40x12 terminal keeps its logo, composer, transcript and review
  // keys. Its state comes from the run signals the status row reads; nothing
  // here is inferred from elapsed time.
  //
  // The composer dock is preferred where it fits, because the rail has cells
  // to spare and the header does not on a compact frame. `auto` therefore
  // docks from 56x18 up and falls back to the header below that; `perch`
  // forces the header form; a dock request on a terminal too small for it
  // also falls back rather than spending a row.
  const petLast = sessionSummary.lastVisible;
  const petSignal: PetSignal = {
    approval: waiting,
    status: ui.session()?.status ?? (running ? "running" : "idle"),
    lastEventKind: petLast?.kind,
    lastEventType: petLast?.type,
    toolCallsPresent: petLast?.payload?.toolCallsPresent === true,
    error: petLast?.type === "run.error",
  };
  const petState = petStateFrom(petSignal);
  // The reaction reads only facts the run reported: the tool a real event
  // named and the provider the session is configured for. A missing fact
  // stays missing rather than being guessed from the clock.
  const petToolName =
    typeof petLast?.payload?.tool === "string"
      ? sanitizeText(petLast.payload.tool)
      : "";
  const petProviderName = (() => {
    const id = ui.provider?.providerId;
    if (!id) return "";
    const preset = ui.provider?.presets?.find(
      (candidate) => candidate.id === id,
    );
    return preset?.name ?? id;
  })();
  const petContext: PetContext = {
    ...(petToolName === "" ? {} : { tool: petToolName }),
    ...(petProviderName === "" ? {} : { provider: petProviderName }),
  };
  const petDockEligible = terminalWidth >= 56 && terminalHeight >= 18;
  const petPlacement = ui.petEnabled ? ui.petPlacement : "off";
  const petDocked =
    chatBaseVisible &&
    petPlacement !== "off" &&
    petPlacement !== "perch" &&
    petDockEligible;
  const petPlace = petLayout(
    terminalWidth,
    terminalHeight,
    header.reduce((widest, row) => Math.max(widest, visibleLength(row)), 0),
    petState,
    chatBaseVisible && ui.petEnabled && !petDocked,
  );
  // The bubble is drawn above the composer only where the pet itself is on
  // screen, the frame can afford the rows and nothing is waiting on a human.
  // Its rows are counted with the rest of the composer chrome below, so it
  // can never push the composer or the review keys off the frame.
  const petBubbleRows = composerPetBubble({
    state: petState,
    context: petContext,
    width,
    height,
    enabled:
      chatBaseVisible &&
      ui.petEnabled &&
      (petDocked || petPlace.kind === "mini"),
    approval: waiting,
    confirmation: !!ui.confirmation,
  });
  ui.petAnimating =
    petPlace.kind !== "hidden" &&
    petPose(petState, motion.frame, motion, ui.themeConfig.symbolPreset).moving;
  if (petPlace.kind === "perch") {
    const petRows = renderPetRows(
      petState,
      petPlace.width,
      motion,
      ui.themeConfig.symbolPreset,
    );
    // The image form is opt-in and only reachable where the startup transfer
    // already went out, which the icon channel owns. Every other frame keeps
    // the ASCII rows, so a refused or unreachable image can never leave a hole
    // where the pet was. The caption row stays text either way: the state word
    // is the one thing the pet must never express with pixels alone.
    const image = petImagePlan(ui.env, terminalWidth, motion);
    const rows =
      image.available && ui.localTabIcons !== undefined
        ? [...image.block, petRows[PET_PERCH_ROWS - 1]!]
        : petRows;
    rows.forEach((row, index) => {
      if (index < header.length)
        header[index] = attachPetRow(header[index]!, row, terminalWidth);
    });
  } else if (petPlace.kind === "mini") {
    header[0] = attachPetRow(
      header[0] ?? "",
      renderPetMini(petState, ui.themeConfig.symbolPreset),
      terminalWidth,
    );
  }
  // One header slot carries the run's state. While the run is in flight it is
  // a travelling wave under the task header, which names the phase, the
  // conversation, the checklist gauge and the turn's elapsed time. Once the
  // run settles the same slot carries its receipt: outcome, real duration,
  // provider reported tokens, tool count, written files and the test verdict
  // a tool result actually stated. Either way it is a row the frame already
  // budgeted, so the settled receipt costs no new band. A frame that has the
  // rail prints the receipt there instead, so the two never say it twice.
  if (!panelOverlay && height - header.length >= 13) {
    if (running)
      header.push(
        ink(
          phaseWave(
            taskHeaderLabel({
              phase: taskPhaseWord(sessionSummary.lastVisible, waiting),
              title: ui.session()?.title,
              elapsedSeconds: runningSeconds,
              todos: todoProgress(sessionTodos),
              tokensPerSecond: tokensPerSecondLabel(sessionSummary.usage),
            }),
            width,
            motion,
            {
              paint: (value, tone, bold) =>
                ink(value, bold ? `1;${ice}` : mutedAnsi),
            },
          ),
          mutedAnsi,
        ),
      );
    else if (runSummary && chatRailWidth === 0)
      header.push(ink(fit(runSummaryRow(runSummary, width), width), mutedAnsi));
  }
  const candidates =
    editing && !ui.confirmation && !visuals.suggestionsDismissed
      ? commandSuggestions(visuals.command ?? "", ui.connectSources)
      : [];
  const selection = Math.max(
    0,
    Math.min(visuals.suggestion ?? 0, candidates.length - 1),
  );
  // A short terminal shows only two suggestion rows, so a fixed three-row
  // lookback would scroll the selected row off the window even though Enter
  // still runs it. The window keeps the selection visible and still prefers
  // three rows of context above it.
  const menuRowBudget = Math.min(
    5,
    Math.max(
      0,
      height - header.length - banner.length - (width >= 72 ? 7 : 9),
    ),
  );
  const menuStart =
    menuRowBudget > 0
      ? Math.max(
          Math.min(
            Math.max(0, selection - 3),
            Math.max(0, candidates.length - menuRowBudget),
          ),
          selection - menuRowBudget + 1,
        )
      : 0;
  const menu =
    menuRowBudget > 0
      ? candidates.slice(menuStart, menuStart + menuRowBudget)
      : [];
  // Once a command and a space are typed, the useful hint is what it wants
  // next rather than which command it is. A hint that has not been earned
  // yet, before the space, would only repeat the command list.
  const typedCommand = visuals.command ?? "";
  const argumentHint =
    editing && !ui.confirmation && /^\/\S*\s/.test(typedCommand)
      ? commandArgumentHint(typedCommand)
      : undefined;
  const composerTextWidth = Math.max(1, width - 4);
  // The palette query stands in for the draft while the overlay is open, so
  // the same wrapping and cursor arithmetic serve both surfaces.
  const composerLines = ui.palette
    ? [ui.palette.query]
    : (
        input ||
        (ui.tab === "chat"
          ? ""
          : editing
            ? "Type to filter…"
            : ui.groupTree
              ? "Type filter / Enter open or fold"
              : "Type filters / Enter opens")
      ).split("\n");
  const composerCursor = ui.palette
    ? [...ui.palette.query].length
    : ui.tab === "chat"
      ? (visuals.cursor ?? [...input].length)
      : editing
        ? (visuals.cursor ?? [...input].length)
        : undefined;
  const composerPoints = [...composerLines.join("\n")];
  const composerCharacters = new Set(composerPoints);
  let markerCodePoint = 0xe000;
  while (composerCharacters.has(String.fromCodePoint(markerCodePoint))) {
    markerCodePoint =
      markerCodePoint === 0xf8ff ? 0xf0000 : markerCodePoint + 1;
  }
  const composerCursorMarker = String.fromCodePoint(markerCodePoint);
  if (composerCursor !== undefined) {
    const cursor = Math.max(0, Math.min(composerPoints.length, composerCursor));
    composerPoints.splice(cursor, 0, composerCursorMarker);
  }
  const composer = wrap(composerPoints.join("").split("\n"), composerTextWidth);
  const chatStatusRowCount = height <= 12 ? 1 : width >= 72 ? 1 : 3;
  const closeDraftRail = height >= 12;
  // The pet bubble is chrome like the rails: its rows are reserved here, so
  // the body and the composer shrink around it instead of the frame growing
  // past the terminal and slicing the activity and review keys away.
  const chatComposerChromeRows =
    3 + chatStatusRowCount + Number(closeDraftRail) + petBubbleRows.length;
  const availableChatComposerRows = Math.max(
    1,
    height -
      header.length -
      banner.length -
      chatPanelTopMarginY -
      menu.length -
      (argumentHint ? 1 : 0) -
      chatComposerChromeRows -
      1,
  );
  // Target the outer composer in physical pixels, then translate to rows.
  // Some terminals do not report cell geometry; the stable fallback assumes
  // 24 px per row.
  const cellHeightPixels =
    visuals.capabilities?.cellHeightPixels &&
    Number.isFinite(visuals.capabilities.cellHeightPixels) &&
    visuals.capabilities.cellHeightPixels > 0
      ? visuals.capabilities.cellHeightPixels
      : 24;
  const draftHeightLimit = Math.max(
    1,
    Math.round(ui.chatPanelVisuals.composerHeightPx / cellHeightPixels),
  );
  const targetChatComposerRows = Math.min(
    Math.max(3, composer.length + Number(composer.length % 2 === 0)),
    draftHeightLimit,
    availableChatComposerRows,
  );
  const composerHeight = chatBaseVisible
    ? targetChatComposerRows - Number(targetChatComposerRows % 2 === 0)
    : Math.min(composer.length, height >= 18 ? 3 : 1);
  const cursorLine = composer.findIndex((line) =>
    line.includes(composerCursorMarker),
  );
  // Allow blank rows on either side so the draft scrolls around the caret.
  const composerStart = cursorLine < 0 ? 0 : cursorLine - Math.floor(composerHeight / 2);
  const composerViewport = Array.from(
    { length: composerHeight },
    (_, row) => composer[composerStart + row] ?? "",
  );
  // An open palette owns the body. It is a filter surface, so whatever the
  // underlying tab would have shown is exactly the noise the operator is
  // trying to see past. From 100 columns the frame can also afford a preview
  // pane beside the list, so the selected command's own summary and argument
  // shape are readable before it runs; below that the list keeps every cell.
  const palettePane = palettePreviewWidth(terminalWidth, width - 4);
  const paletteListWidth = palettePane > 0 ? width - 4 - palettePane - 2 : width - 4;
  const paletteView = ui.palette
    ? renderPalette(
        ui.palette,
        filterPalette(
          paletteFromCommands(TUI_COMMANDS),
          ui.palette.query,
          ui.palette.recent,
        ),
        Math.max(1, paletteListWidth),
        { color: visuals.color },
      )
    : undefined;
  const paletteBody =
    paletteView === undefined
      ? undefined
      : palettePane > 0
        ? paletteWithPreview(
            paletteView.lines,
            palettePreviewLines(
              paletteView.items[paletteView.selected],
              palettePane,
            ),
            Math.max(1, paletteListWidth),
            palettePane,
          )
        : [...paletteView.lines];
  // The legend is rendered after the paint helpers exist and before the body
  // height is known, because the body height is what decides how many legend
  // rows fit. Measuring it here is what keeps the frame exactly height rows
  // tall on every terminal size, which the parity tests pin.
  const pickerMatches = ui.modelPicker
    ? modelPickerMatches(ui.modelPicker.models, ui.modelPicker.query)
    : undefined;
  const selectedPickerModel = pickerMatches?.[ui.modelPicker?.selected ?? 0];
  const panelHint = modelPickerOpen
    ? ui.modelPicker?.focusedPane === "providers"
      ? width < 50
        ? "↑↓ provider · → models · Tab/⇧Tab panes"
        : "↑/↓ providers · → models · Tab/Shift+Tab panes · Enter load · Esc"
      : ui.modelPicker?.query
        ? width < 50
          ? "↑↓ model · ← provider · Tab/⇧Tab panes · Esc clears"
          : "↑/↓ models · ← providers · Tab/Shift+Tab panes · Type search · Esc clear"
        : ui.modelPicker?.selection === "session"
          ? width < 50
            ? "↑↓ model · ← provider · Tab/⇧Tab · Enter use"
            : "↑/↓ models · ← provider · Tab/Shift+Tab panes · Enter use · Esc close"
          : width < 50
            ? "↑↓ model · ← provider · Tab/⇧Tab · Enter set"
            : "↑/↓ models · ← providers · Tab/Shift+Tab panes · Enter set default · Esc close"
    : ui.confirmation
      ? "y allow · n deny · Esc cancel"
      : paletteView
        ? "↑/↓ choose · Enter run · Esc close"
        : ui.diffView
          ? width < 50
            ? "↑↓ review · Esc Chat"
            : "↑/↓ review · Esc returns to Chat"
          : ui.settingsOpen
            ? ui.settingsQuery
              ? width < 50
                ? "type filter · Ctrl+←→ caret · ↑↓ select · Esc clear"
                : "Type to filter · Ctrl+←/→ caret · ↑/↓ select · ←/→ change · Esc clear"
              : width < 50
                ? "type search · ↑↓ select · Ctrl+←→ groups · ←→ change · Enter edit · Esc Chat"
                : "Type to search · ↑/↓ select · Ctrl+←/→ groups · ←/→ change · Enter edit/change · PgUp/PgDn · Esc Chat"
            : ui.detail || ui.showingKeybindings || ui.showingCheatSheet
              ? "PgUp/PgDn scroll · Esc back"
              : ui.groupTree
                ? width < 50
                  ? "↑↓ move · Enter fold/open · Esc Chat"
                  : "↑/↓ move · Enter open or fold · Esc returns to Chat"
                : ui.tab === "help"
                  ? width < 50
                    ? "↑↓/PgUp/PgDn scroll · Esc Chat"
                    : "↑/↓ scroll · PgUp/PgDn page · Esc returns to Chat"
                  : width < 50
                    ? "↑↓ select · Enter open · Esc Chat"
                    : "Type to filter · ↑/↓ select · Enter open · Tab/Esc Chat";
  const legendRows = chatBaseVisible
    ? []
    : modelPickerOpen
      ? [
          fit(
            selectedPickerModel
              ? `${selectedPickerModel.name} · ${selectedPickerModel.id}${selectedPickerModel.id === (ui.modelPicker?.selection === "session" ? ui.session()?.model : ui.model) ? (ui.modelPicker?.selection === "session" ? " · current conversation model" : " · current default") : ""}`
              : "No model selected",
            width,
          ),
          ...(width >= 72
            ? [
                "↑/↓ select · Home/End bounds · PgUp/PgDn page · Type to search",
                width < 60
                  ? "↑/↓ select · ←/→ panes · type · Esc close"
                  : `↑/↓ select · Tab/Shift+Tab/←/→ switch panes · click row · double-click open/load · wheel · Esc close`,
              ]
            : [panelHint]
          ).map((row) => fit(row, width)),
        ]
      : [fit(panelHint, width)];
  // A run in flight may get a timeline above the status bar. What it would
  // cost is measured here; whether it is affordable is decided below, from
  // the shared budget rather than from a second guess at the same numbers.
  //
  // The timeline follows the run this process started, not whichever run is
  // newest. During the initial pass a busy run can be reported from a
  // different conversation than the one just sent, and the operator watching
  // a stopwatch saw another conversation's phases.
  const ownRun =
    ui.workbench
      .runs()
      .find((run: { sessionId?: string }) => run.sessionId === ui.sessionId)
      ?.runId ?? ui.session()?.runId;
  const timelineRows =
    ui.tab !== "chat" && sessionRunning && !waiting && ownRun
      ? renderTimeline(buildTimeline(ui.session()?.events ?? []), width, 8, {
          motion,
          paint: (value, tone, bold) =>
            visuals.color
              ? paintWithPalette(
                  value,
                  tone as Parameters<typeof paintWithPalette>[1],
                  getPalette(ui.themeConfig.colorTheme),
                  caps,
                  bold,
                )
              : value,
        })
      : [];
  // The composer starts with one editable row; a framed surface adds its top
  // and bottom edges. Wrapped drafts consume only the rows they need.
  //
  // Header, approval banner, composer rows/frame, summary/status, suggestions,
  // and one body row are reserved first. Optional bands share only what remains.
  const compactConfirmation = !!ui.confirmation && height < 14;
  // A compact review frame has room for exactly one dock row, and that row is
  // the status line carrying the decision keys. The status row is appended
  // last, so a two row summary would push the only way to accept or reject off
  // a 40x12 terminal. Model and authority context return at 40x16, where the
  // legend and the full summary both fit.
  const summaryRowsCount = compactConfirmation ? 0 : width < 100 ? 2 : 1;
  const chatFooterRows = chatBaseVisible ? chatComposerChromeRows : 0;
  // The rail is a fixed right column, so the transcript is laid out to the
  // narrower width it leaves. Nothing is ever painted over a transcript row:
  // the two panes cannot overlap because the text was wrapped for the pane.
  const bodyTextWidth = Math.max(1, width - 4 - chatRailWidth);
  const reserved =
    header.length +
    banner.length +
    (panelOverlay
      ? (compactConfirmation ? 0 : legendRows.length) + summaryRowsCount + 1
      : composerHeight + chatFooterRows) +
    (chatBaseVisible ? chatPanelTopMarginY : 0) +
    menu.length +
    (argumentHint ? 1 : 0) +
    1; /* one row of body, always */
  let spare = Math.max(0, height - reserved);

  // Toasts come first among the optional bands: they are the only ones
  // carrying an event the operator has not read yet. They are clipped rather
  // than dropped whole, because a partial queue is still a queue and the
  // sticky ones are ordered ahead of the rest.
  const takeToasts = Math.min(toastRows.length, spare);
  const shownToastRows = toastRows.slice(0, takeToasts);
  spare -= takeToasts;

  // Then the timeline of a run in flight. Dropped whole, never clipped: half
  // a timeline reads as a rendering fault rather than as a summary.
  const shownTimelineRows =
    timelineRows.length > 0 && spare >= timelineRows.length ? timelineRows : [];
  spare -= shownTimelineRows.length;

  // Then the rule that marks where the body ends and the controls begin. It
  // breathes while a run is in flight, which is the only reason it earns a
  // row ahead of the legend below it.
  const shownRuleRows =
    !chatBaseVisible &&
    !spaciousShell &&
    (spare > legendRows.length || (summaryRowsCount === 1 && spare >= 1))
      ? [separator(width, motion, running)]
      : [];
  spare -= shownRuleRows.length;

  // The legend is advice, and /keybindings carries the same list, so it takes
  // whatever is left and no more.
  const shownLegendRows =
    !compactConfirmation && spare >= legendRows.length ? legendRows : [];
  spare -= shownLegendRows.length;

  const ruleRows = shownRuleRows;
  const visibleLegendRows = shownLegendRows;
  const bodyHeight = Math.max(1, spare + 1);
  const chatRail =
    chatRailWidth > 0
      ? chatRailLines({
          todos: sessionTodos,
          subagents: childSessions,
          ...(runSummary === undefined ? {} : { runSummary }),
          width: chatRailWidth,
          height: bodyHeight,
          // The marker is the spinner of a run that is actually happening.
          // The row it lands on comes from the model's own in-progress state,
          // so an idle conversation never spins and no row is guessed.
          ...(sessionRunning
            ? { indicator: runningIndicator(motion) }
            : {}),
          ...(nowMs === undefined ? {} : { now: nowMs }),
        })
      : [];
  const documentLayout =
    ui.tab === "documents" && ui.documentPreview
      ? documentPreviewLayout(width - 4, bodyHeight)
      : undefined;
  const richChat =
    ui.tab === "chat" &&
    !!ui.session() &&
    !ui.detail &&
    !ui.confirmation &&
    !paletteView &&
    !modelPickerOpen;
  let content = modelPickerOpen
    ? ui.lines(width - 4, bodyHeight)
    : paletteBody !== undefined
      ? [...paletteBody]
      : richChat
        ? []
        : ui.lines(width - 4, bodyHeight);
  if (ui.confirmation && height < 14 && content[1] === "") {
    content.splice(1, 1);
  }
  const styled = richChat
    ? ui.renderChatRows(ui.session()!.events, bodyTextWidth, terminalHeight)
    : undefined;
  const noWrapPanel = modelPickerOpen || ui.settingsOpen || ui.tab === "models";
  const lines =
    (richChat && styled?.length === 0 ? [] : styled?.map((row) => row.text)) ??
    (paletteBody !== undefined
      ? paletteBody
      : noWrapPanel
        ? content.map((line) =>
            fitWithTrustedIcons(line, bodyTextWidth, trustedIcons),
          )
        : wrap(content, bodyTextWidth, trustedIcons));
  let offset = ui.scroll;
  // The Models picker and command palette window their lists internally.
  if (modelPickerOpen || paletteView) offset = 0;
  else if (ui.settingsOpen) {
    const selectedStart = ui.settingsRowLines[ui.settingsSelected] ?? 0;
    if (selectedStart < offset) offset = selectedStart;
    else if (selectedStart >= offset + bodyHeight)
      offset = selectedStart - bodyHeight + 1;
  } else if (
    !ui.detail &&
    !ui.confirmation &&
    ui.tab === "chat" &&
    ui.scroll < 0
  ) {
    let followEnd = lines.length;
    if (sessionRunning && bodyHeight === 1 && styled) {
      followEnd = 0;
      for (let index = styled.length - 1; index >= 0; index -= 1) {
        const row = styled[index]!;
        const pipe = row.style === "code" ? row.text.indexOf("│") : -1;
        if (hasVisibleTextFrom(row.text, pipe < 0 ? 0 : pipe + 1)) {
          followEnd = index + 1;
          break;
        }
      }
    } else if (sessionRunning) {
      followEnd = 0;
      for (let index = lines.length - 1; index >= 0; index -= 1) {
        if (hasVisibleTextFrom(lines[index]!)) {
          followEnd = index + 1;
          break;
        }
      }
    }
    offset = Math.max(0, followEnd - bodyHeight);
  } else if (ui.groupTree && !ui.detail) offset = 0;
  else if (
    !ui.detail &&
    !ui.confirmation &&
    !["chat", "policy", "help"].includes(ui.tab)
  ) {
    const selectedLine = content.findIndex((line) => /^(?:▸|›) /.test(line));
    if (selectedLine >= 0) {
      const selectedStart = noWrapPanel
        ? selectedLine
        : wrap(content.slice(0, selectedLine), width - 4, trustedIcons).length;
      if (selectedStart < offset) offset = selectedStart;
      else if (selectedStart >= offset + bodyHeight)
        offset = selectedStart - bodyHeight + 1;
    } else {
      offset = Math.max(0, ui.selected - bodyHeight + 1);
    }
  }
  offset = Math.min(
    Math.max(0, offset),
    Math.max(0, lines.length - bodyHeight),
  );
  ui.viewport = {
    offset,
    height: bodyHeight,
    total: lines.length,
    width,
    // The transcript is laid out to `bodyTextWidth`, so the rail's first cell
    // is one column past it. Publishing both keeps mouse selection on the
    // transcript instead of letting it repaint the status rail.
    textWidth: bodyTextWidth,
    ...(chatRailWidth > 0
      ? { railStart: chatPanelMarginX + 1 + bodyTextWidth }
      : {}),
  };
  // User prompt rows drive the { and } jumps without depending on display text.
  ui.promptRows = lines
    .map((_line, index) => (styled?.[index]?.promptStart ? index : -1))
    .filter((index) => index >= 0);
  const body = lines.slice(offset, offset + bodyHeight);
  while (body.length < bodyHeight) body.push("");
  if (
    lines[0] === "No entries yet." &&
    (lines.length === 1 || (lines.length === 2 && lines[1] === ""))
  ) {
    body.fill("");
    body[Math.floor((body.length - 1) / 2)] = "No entries yet.";
  }
  const palette = getPalette(ui.themeConfig.colorTheme);
  const symbols = getSymbols(ui.themeConfig.symbolPreset);
  // The NIB card is an overlay on the body viewport, not a panel: it replaces
  // the top body rows for as long as it is open, so the composer, the dock and
  // the frame height never move. The title names the key that closes it.
  if (chatBaseVisible && ui.petCard) {
    const card = box(
      "NIB  Alt+Shift+N close",
      petCardLines(petState, petSignal),
      bodyTextWidth,
    );
    card.forEach((row, index) => {
      if (index < body.length) body[index] = row;
    });
  }
  const userMessageMarker = `${symbols.role.user} `;
  const paintMarkdownLine = (
    value: string,
    width: number,
    tone: Parameters<typeof paintWithPalette>[1],
  ) => {
    const parts = inlineMarkdownParts(value);
    const plainWidth = parts.reduce(
      (total, part) => total + visibleLength(part.text),
      0,
    );
    const body = parts
      .map((part) =>
        paintWithPalette(
          part.text,
          part.style === "code" ? "info" : tone,
          palette,
          caps,
          part.style === "strong",
        ),
      )
      .join("");
    return body + " ".repeat(Math.max(0, width - plainWidth));
  };
  const frameColor = ui.confirmation ? amber : mutedAnsi;
  // Recorded reasoning is a dim block in colour and a labeled block in mono.
  // The `~ thinking` label and its state word carry the meaning, so no state
  // is colour-only and reduced motion has nothing to animate here.
  const dimRow = (value: string) =>
    caps.ansi && caps.colorDepth !== 0 ? `\u001b[2m${value}\u001b[0m` : value;
  const approvalReviewOpen =
    ui.confirmation?.title.startsWith("APPROVE ") ?? false;
  const undoConfirmationOpen =
    ui.confirmation?.title.startsWith("UNDO ") ?? false;
  const bodyRows = body.map((line, index) => {
    const style = styled?.[offset + index]?.style;
    const chatTone: Parameters<typeof paintWithPalette>[1] =
      style === "assistant" || style === "heading"
        ? "accent"
        : style === "code" || style === "text"
          ? "fg"
          : style === "quote" || style === "reasoning"
            ? "muted"
            : style === "role-tool"
              ? "warning"
              : style === "role-error"
                ? "warning"
                : style === "diff-add"
                  ? "success"
                  : style === "diff-remove"
                    ? "error"
                    : style === "diff-context"
                      ? "muted"
                      : style === "error"
                  ? "error"
                  : style === "tool"
                    ? "muted"
                    : /^(Error|Invalid|Failed)/.test(line)
                      ? "error"
                      : "fg";
    // A sweep crosses the newest run's last row while it is live, so the eye
    // is drawn to the line that just changed. It rides on a row that is
    // already coloured and already scrolled to, so it adds attention without
    // adding meaning that a monochrome terminal would lose.
    const isLiveTail =
      sessionRunning &&
      !ui.confirmation &&
      offset + index === lines.length - 1 &&
      lines.length > 1;
    const rowWidth = bodyTextWidth;
    const userWithoutColor =
      ui.tab === "chat" && style === "user" && !colorEnabled;
    const displayLine = userWithoutColor ? `${symbols.frame.v} ${line}` : line;
    const painted = isLiveTail
      ? sweepRow(pad(displayLine, rowWidth), rowWidth, motion, {
          paint: (value) => (visuals.color ? ink(value, `1;${amber}`) : value),
        })
      : pad(displayLine, rowWidth);
    const approvalTitle = approvalReviewOpen && line === ui.confirmation?.title;
    const undoTitle = undoConfirmationOpen && line === ui.confirmation?.title;
    const approvalField =
      approvalReviewOpen &&
      (line.startsWith(APPROVAL_EVIDENCE_LABELS.tool) ||
        line.startsWith(APPROVAL_EVIDENCE_LABELS.class) ||
        line.startsWith(APPROVAL_EVIDENCE_LABELS.blastRadius) ||
        line.startsWith(APPROVAL_EVIDENCE_LABELS.matchedRule) ||
        line.startsWith(APPROVAL_EVIDENCE_LABELS.precondition) ||
        line.startsWith(APPROVAL_EVIDENCE_LABELS.postcondition));
    const operationLabel =
      undoConfirmationOpen && line.startsWith(UNDO_OPERATION_LABEL);
    const contentLabelLength = approvalField
      ? 15
      : operationLabel
        ? UNDO_OPERATION_LABEL.length
        : 0;
    const statusTone =
      /\b(?:error|failed|blocked|denied|refused|unavailable|invalid|stale|missing|corrupt|not verified|no-go)\b/i.test(
        line,
      )
        ? "error"
        : /\b(?:pending|queued|paused|review|unknown|warning|not connected)\b/i.test(
              line,
            )
          ? "warning"
          : /\b(?:ready|connected|verified|approved|settled|healthy|passed|enabled)\b/i.test(
                line,
              )
            ? "success"
            : "fg";
    const settingsRowIndex = ui.settingsOpen
      ? ui.settingsRowLines.indexOf(offset + index)
      : -1;
    const selectedSettingsRow =
      ui.settingsOpen && settingsRowIndex === ui.settingsSelected;
    const selectedListRow =
      (ui.tab !== "chat" && /^(?:▸ |› )\d+\.\s/.test(line)) ||
      selectedSettingsRow;
    // The sessions browser publishes the content rows it used, because a
    // heading and a conversation both start with a two-cell gutter and the
    // text alone does not say which one the cursor is on.
    const sessionBodyLine = ui.tab === "sessions" && !ui.detail;
    const selectedSessionRow =
      sessionBodyLine && ui.sessionBrowserLines?.selected === offset + index;
    const sessionHeadingRow =
      sessionBodyLine &&
      (ui.sessionBrowserLines?.headers.includes(offset + index) ?? false);
    const sectionHeading =
      (ui.tab !== "chat" || ui.settingsOpen) &&
      /^(?:OVERVIEW|SETTINGS|APPEARANCE|INTERACTION|HARNESS|WORKSPACE LIMITS|WORKSPACE|HEALTH|STATUS|CONVERSATIONS?|SESSIONS|DOCUMENTS?|LEDGER|APPROVALS?|POLICY|TOOLS|MCP|MODELS|USAGE|HELP|RECOVERY|PROVIDER|RUNS?|CHAIN STATUS|TOKEN ACTIVITY|TOP \d+ MODELS|RECORDS|REVIEW QUEUE|ACTIVE PROVIDER|DOCUMENT TREE|QUICK KEYS|[▪▫◇◕▰◈◆◔] [A-Z][A-Z ]+ · \d+)(?:$|[\s,·:])/i.test(
        line.trim(),
      );
    const fieldColon = ui.tab !== "chat" && ui.detail ? line.indexOf(":") : -1;
    const chatBold =
      style === "assistant" ||
      style === "role-tool" ||
      style === "role-error" ||
      style === "heading";
    const contentRow = contentLabelLength
      ? ink(painted.slice(0, contentLabelLength), `1;${ice}`) +
        paintWithPalette(
          painted.slice(contentLabelLength),
          chatTone,
          palette,
          caps,
        )
      : selectedSettingsRow
        ? paintWithPalette(painted, "accent", palette, caps)
        : ui.settingsOpen && sectionHeading
          ? paintWithPalette(painted, "accent", palette, caps, true)
          : ui.tab === "chat" && style === "user"
            ? painted.startsWith(userMessageMarker)
              ? `${paintWithPalette(userMessageMarker, "accent", palette, caps, true)}${paintUserMessage(
                  painted.slice(userMessageMarker.length),
                  palette,
                  colorEnabled ? caps : { ...caps, ansi: false, colorDepth: 0 },
                )}`
              : paintUserMessage(
                  painted,
                  palette,
                  colorEnabled ? caps : { ...caps, ansi: false, colorDepth: 0 },
                )
            : ui.tab === "chat" && style === "reasoning"
              ? dimRow(paintWithPalette(painted, "muted", palette, caps))
              : ui.tab === "chat" &&
                  styled?.[offset + index]?.markdown &&
                  !isLiveTail
                ? paintMarkdownLine(displayLine, rowWidth, chatTone)
                : ui.tab === "chat"
                  ? paintWithPalette(
                      painted,
                      approvalTitle || undoTitle ? "warning" : chatTone,
                      palette,
                      caps,
                      approvalTitle || undoTitle || chatBold,
                    )
                  : selectedSessionRow || selectedListRow
                    ? paintWithPalette(painted, "accent", palette, caps, true)
                    : sessionHeadingRow || sectionHeading
                      ? paintWithPalette(painted, "accent", palette, caps, true)
                      : fieldColon > 0 && fieldColon < 30
                        ? paintWithPalette(
                          painted.slice(0, fieldColon + 1),
                          "muted",
                          palette,
                          caps,
                        ) +
                        paintWithPalette(
                          painted.slice(fieldColon + 1),
                          statusTone,
                          palette,
                          caps,
                        )
                      : paintWithPalette(painted, statusTone, palette, caps);
    const sideTone = frameColor;
    return (
      ink(ui.confirmation ? "! " : "  ", sideTone) +
      contentRow +
      (ui.confirmation ? ink(" !", frameColor) : ink("  ", sideTone))
    );
  });
  const renderedBodyRows = bodyRows;
  const baseListVisible =
    ui.tab !== "chat" &&
    !ui.confirmation &&
    !modelPickerOpen &&
    !paletteView &&
    (!ui.detail || (ui.tab === "documents" && ui.documentPreview)) &&
    !ui.diffView &&
    !ui.palette &&
    !ui.showingKeybindings &&
    !ui.showingCheatSheet;
  if (ui.tab === "sessions" && ui.sessionBrowserLines && !ui.detail) {
    // The sessions browser publishes its own rows: a heading and a
    // conversation share the same two-cell gutter, so the renderer cannot
    // tell them apart by reading the text, and a heading must not be
    // selectable as a conversation.
    const bodyStart = header.length + banner.length + shownToastRows.length;
    const sessionPane = sessionInspectorLayout(width, bodyHeight);
    const listEnd = sessionPane.sideBySide
      ? sessionPane.listWidth + 3
      : width;
    const rowIcons = sessionRowIcons(ui.themeConfig.symbolPreset);
    for (const target of ui.sessionBrowserLines.rows) {
      const bodyIndex = target.line - offset;
      const screenRow = bodyStart + bodyIndex + 1 + panelTopOffset;
      if (
        bodyIndex < 0 ||
        bodyIndex >= bodyHeight ||
        screenRow > height + panelTopOffset
      )
        continue;
      // The fact icons are pushed before the row so the narrower rect wins the
      // hit test: clicking the model icon opens Models and the token icon
      // opens Usage, exactly as `/models` and `/usage` do, while a click on the
      // rest of the row still selects and opens the conversation.
      const factSpans = sessionRowFactSpans(
        lines[offset + bodyIndex] ?? "",
        rowIcons,
      );
      // A body row paints a two-cell gutter before its content, so a fact span
      // measured on the raw line starts two cells later on the screen.
      const factColumn = 3 + panelTopOffset;
      if (factSpans.model)
        ui.rowHitTargets.push({
          row: screenRow,
          start: factColumn + factSpans.model.start,
          end: factColumn + factSpans.model.end,
          kind: "chip",
          index: target.index,
          action: "models-panel",
        });
      if (factSpans.tokens)
        ui.rowHitTargets.push({
          row: screenRow,
          start: factColumn + factSpans.tokens.start,
          end: factColumn + factSpans.tokens.end,
          kind: "chip",
          index: target.index,
          action: "usage",
        });
      ui.rowHitTargets.push({
        row: screenRow,
        start: 1 + panelTopOffset,
        end: listEnd + panelTopOffset,
        kind: "tree",
        index: target.index,
      });
    }
  } else if (baseListVisible) {
    const bodyStart = header.length + banner.length + shownToastRows.length;
    const treeNodes = ui.groupTree
      ? flattenTree(ui.groupTree.nodes, ui.groupTree.state)
      : [];
    const treeHeight =
      ui.tab === "documents" && ui.documentPreview
        ? documentLayout?.sideBySide
          ? bodyHeight
          : Math.max(1, Math.floor(bodyHeight / 2))
        : Math.max(1, bodyHeight - 4);
    const treePaneEnd =
      ui.tab === "documents" && ui.documentPreview && documentLayout?.sideBySide
        ? documentLayout.treeWidth + 3 + panelTopOffset
        : undefined;
    const treeStart =
      ui.groupTree && ui.groupTree.state.cursor >= treeHeight
        ? Math.min(
            ui.groupTree.state.cursor - treeHeight + 1,
            Math.max(0, treeNodes.length - 1),
          )
        : 0;
    let visibleTreeIndex = treeStart;
    body.forEach((line, index) => {
      let kind: "item" | "tree" | undefined;
      let targetIndex = -1;
      if (ui.groupTree && /^(?:▸ |› |  )(?:\[(?:[-+])\] | {4})/.test(line)) {
        kind = "tree";
        targetIndex = visibleTreeIndex++;
      } else {
        const match = /^(?:▸ |› |  )(\d+)\.\s/.exec(line);
        if (match) {
          kind = "item";
          targetIndex = Number(match[1]) - 1;
        }
      }
      const screenRow = bodyStart + index + 1 + panelTopOffset;
      if (
        kind &&
        targetIndex >= 0 &&
        screenRow <= height + panelTopOffset &&
        (kind !== "item" || targetIndex < ui.items().length) &&
        (kind !== "tree" || targetIndex < treeNodes.length)
      ) {
        ui.rowHitTargets.push({
          row: screenRow,
          start: 1 + panelTopOffset,
          end:
            kind === "tree" && treePaneEnd !== undefined
              ? treePaneEnd
              : width + panelTopOffset,
          kind,
          index: targetIndex,
        });
      }
    });
  } else if (ui.settingsOpen) {
    const bodyStart = header.length + banner.length + shownToastRows.length;
    ui.settingsRowLines.forEach((contentRow, index) => {
      const bodyIndex = contentRow - offset;
      const screenRow = bodyStart + bodyIndex + 1 + panelTopOffset;
      if (
        bodyIndex < 0 ||
        bodyIndex >= bodyHeight ||
        screenRow > height + panelTopOffset
      )
        return;
      ui.rowHitTargets.push({
        row: screenRow,
        start: 1 + panelTopOffset,
        end: width + panelTopOffset,
        kind: "setting",
        index,
      });
    });
  } else if (modelPickerOpen && ui.modelPicker) {
    const picker = ui.modelPicker;
    const matches = modelPickerMatches(picker.models, picker.query);
    const bodyStart = header.length + banner.length + shownToastRows.length;
    const pickerColumns = width - 4;
    const sideBySidePicker = pickerColumns >= 88;
    const sidebarWidth = sideBySidePicker
      ? Math.min(28, Math.max(20, Math.floor(pickerColumns * 0.27)))
      : 0;
    const addPickerHitTarget = (
      kind: "provider" | "model",
      index: number,
      contentRow: number,
    ) => {
      const rowStart = contentRow;
      const rowHeight = 1;
      for (let line = 0; line < rowHeight; line++) {
        const bodyIndex = rowStart + line - offset;
        const screenRow = bodyStart + bodyIndex + 1 + panelTopOffset;
        if (
          bodyIndex < 0 ||
          bodyIndex >= bodyHeight ||
          screenRow > height + panelTopOffset
        )
          continue;
        ui.rowHitTargets.push({
          row: screenRow,
          start:
            !sideBySidePicker || kind === "provider"
              ? 1 + panelTopOffset
              : Math.min(width, sidebarWidth + 6 + panelTopOffset),
          end:
            sideBySidePicker && kind === "provider"
              ? sidebarWidth + 1 + panelTopOffset
              : width + panelTopOffset,
          kind,
          index,
        });
      }
    };
    if (sideBySidePicker) {
      // The wide layout shows independent provider and model windows. Map each
      // hit target to its row within the same window the renderer displayed.
      const visibleRows = Math.max(1, bodyHeight - 2);
      const providerStart = modelPickerWindowStart(
        picker.providerIndex,
        picker.providers.length,
        visibleRows,
        picker.providerWindowStart,
      );
      const modelStart = modelPickerWindowStart(
        picker.selected,
        matches.length,
        visibleRows,
        picker.modelWindowStart,
      );
      for (
        let rowOffset = 0;
        rowOffset < visibleRows &&
        providerStart + rowOffset < picker.providers.length;
        rowOffset++
      )
        addPickerHitTarget(
          "provider",
          providerStart + rowOffset,
          2 + rowOffset,
        );
      for (
        let rowOffset = 0;
        rowOffset < visibleRows && modelStart + rowOffset < matches.length;
        rowOffset++
      )
        addPickerHitTarget("model", modelStart + rowOffset, 2 + rowOffset);
    } else if (picker.focusedPane === "providers") {
      const visibleRows = Math.max(1, bodyHeight - 5);
      const providerStart = modelPickerWindowStart(
        picker.providerIndex,
        picker.providers.length,
        visibleRows,
        picker.providerWindowStart,
      );
      for (
        let rowOffset = 0;
        rowOffset < visibleRows &&
        providerStart + rowOffset < picker.providers.length;
        rowOffset++
      )
        addPickerHitTarget(
          "provider",
          providerStart + rowOffset,
          3 + rowOffset,
        );
    } else {
      const visibleRows = Math.max(1, bodyHeight - 5);
      const modelStart = modelPickerWindowStart(
        picker.selected,
        matches.length,
        visibleRows,
        picker.modelWindowStart,
      );
      for (
        let rowOffset = 0;
        rowOffset < visibleRows && modelStart + rowOffset < matches.length;
        rowOffset++
      )
        addPickerHitTarget("model", modelStart + rowOffset, 3 + rowOffset);
    }
  }
  if (ui.hoveredRow) {
    const hovered = ui.rowHitTargets.find(
      (target) =>
        target.kind === ui.hoveredRow?.kind &&
        target.index === ui.hoveredRow?.index,
    );
    const topRow =
      header.length + banner.length + shownToastRows.length + panelTopOffset;
    const bodyIndex = hovered ? hovered.row - topRow - 1 : -1;
    const selected =
      hovered?.kind === "item"
        ? ui.selected === hovered.index
        : hovered?.kind === "tree"
          ? ui.groupTree?.state.cursor === hovered.index
          : hovered?.kind === "provider"
            ? ui.modelPicker?.providerIndex === hovered.index
            : hovered?.kind === "model"
              ? ui.modelPicker?.selected === hovered.index
              : hovered?.kind === "setting"
                ? ui.settingsSelected === hovered.index
                : true;
    if (!selected && bodyIndex >= 0 && bodyIndex < bodyRows.length) {
      const row = bodyRows[bodyIndex]!;
      const ansiPrefix = row.match(/^(?:\x1b\[[0-9;]*m)*/)?.[0] ?? "";
      const unstyled = row.slice(ansiPrefix.length);
      if (unstyled.startsWith("  "))
        bodyRows[bodyIndex] = `${ansiPrefix}› ${unstyled.slice(2)}`;
    }
  }
  const events = sessionEvents;
  const eventSummary = sessionSummary;
  // The elapsed time is measured once, from the turn's own start timestamp,
  // and shared by the task header and the status row so the two cannot
  // disagree about how long the turn has been open.
  const elapsed =
    runningSeconds === undefined ? "" : ` / ${runningSeconds}s`;
  const lastEvent = eventSummary.lastVisible;
  // The phase icon carries the same word as the label beside it, so the glyph
  // is recognition speed rather than the only signal.
  //
  // Every glyph here is single cell. The pencil U+270E that would read as
  // "writing" counts two in layout.ts, which would push this status row one
  // column past its width and, on a narrow terminal, drop the Esc stop hint
  // off the end.
  const activeToolName =
    (lastEvent?.type === "tool.started" || lastEvent?.type === "tool.result") &&
    typeof lastEvent.payload?.tool === "string"
      ? sanitizeText(lastEvent.payload.tool)
      : "";
  const lastToolResult =
    lastEvent?.type === "tool.result"
      ? toolDetailRecord(lastEvent.payload?.result)
      : undefined;
  const phase =
    lastEvent?.type === "tool.started"
      ? `${ROW_ICONS.tool} ${compactToolText(lastEvent, activeToolName || "tool")}`
      : lastEvent?.type === "message.delta"
        ? `${ROW_ICONS.edit} Writing response`
        : lastEvent?.type === "tool.result"
          ? `${ROW_ICONS.tool} ${activeToolName || "Tool"} · ${lastToolResult?.isError === true ? "failed" : "result received"}`
          : lastEvent?.type === "message.completed" &&
              lastEvent.payload?.toolCallsPresent === true
            ? `${ROW_ICONS.tool} Dispatching requested tools`
            : `◌ Waiting for provider`;
  // Live ellipsis, frozen when motion is off so paused frames stay equal.
  const dots =
    visuals.motion === false ? "" : ".".repeat(1 + (Math.floor(frame / 3) % 3));
  const historyStatus =
    richChat && ui.scroll >= 0
      ? `History ${offset + 1}-${Math.min(offset + bodyHeight, lines.length)}/${lines.length} / /bottom to follow`
      : undefined;
  const usage = eventSummary.usage;
  const usageTokens =
    typeof usage?.total_tokens === "number" ? usage.total_tokens : "?";
  // Status segments with theme colors (omp-style segment catalog)
  // ink() takes an SGR code, not a pre-painted glyph.
  const muted = mutedAnsi;
  const seg = (
    label: string,
    value: string,
    tone: keyof typeof palette = "accent",
  ) =>
    `${paintWithPalette(label, "muted", palette, caps)} ${paintWithPalette(value, tone, palette, caps)}`;

  const segments: string[] = [];
  // Model segment
  let modelShown = fit(
    sanitizeText(ui.session()?.model || ui.model || "offline"),
    24,
  );
  segments.push(seg("model", modelShown, "accent"));
  // Mode segment
  const modeLabel = modeAuthorityLabel(ui.mode);
  // The mode is the one setting that changes what a later key is allowed to
  // do, so it gets a pill: a shape the eye finds without reading it. The word
  // stays inside the pill, so the rails are never the only signal.
  segments.push(
    seg(
      "mode",
      pill(`${MODE_ICON[ui.mode]} ${modeLabel}`, "info", motion, {
        paint: (value, tone, bold) =>
          paintWithPalette(value, tone, palette, caps, bold),
      }),
      "info",
    ),
  );
  // Tokens & cost
  const costStr =
    typeof usage?.cost === "number" ? `$${usage.cost.toFixed(4)}` : "?";
  segments.push(seg("tokens", String(usageTokens), "success"));
  segments.push(seg("cost", costStr, "warning"));
  // Approvals & queue
  const holdCount = ui.workbench.pending().length + ui.proxy.holds.length;
  if (holdCount > 0) segments.push(seg("holds", `◉ ${holdCount}`, "error"));
  if (ui.tab === "chat" && ui.queuedPrompt)
    segments.push(
      seg("queue", ui.queuedPromptPaused ? "paused" : "+1 queued", "warning"),
    );
  segments.push(seg("activity", ui.toolActivityMode, "muted"));
  // A run with no reported progress gets an indeterminate bar rather than a
  // percentage, because there is no honest fraction to print and a frozen 0%
  // would read as stalled rather than running.
  if (sessionRunning && !waiting) {
    const activeRun = ui.workbench
      .runs()
      .find((run: { sessionId: string }) => run.sessionId === ui.sessionId);
    if (activeRun && activeRun.progress === null) {
      segments.push(
        paintWithPalette(indeterminateBar(12, motion), "accent", palette, caps),
      );
    } else if (activeRun && typeof activeRun.progress === "number") {
      segments.push(
        paintWithPalette(
          animatedBar(activeRun.progress, 1, 12, motion),
          "accent",
          palette,
          caps,
        ),
      );
    }
  }

  // Live run badges-named sessions that are actively running.
  // Shows up to 3 running sessions with their progress.
  const runningRuns = [...ui.workbench.runs()].filter(
    (run: { state: string; sessionId: string }) =>
      run.state === "running" ||
      run.state === "stopping" ||
      run.state === "paused",
  );
  if (runningRuns.length > 0) {
    const runBadges = runningRuns.slice(0, 3).map((run) => {
      const sess = ui.workbench.list().find((s) => s.id === run.sessionId);
      const title = sess?.title ?? run.sessionId.slice(0, 8);
      const pct =
        run.progress === null ? "?" : `${Math.round(run.progress * 100)}%`;
      return `${title} ${pct}`;
    });
    segments.push(
      paintWithPalette("▶", "accent", palette, caps) +
        " " +
        runBadges.join(" · "),
    );
  }

  // Live approval pulse-the oldest pending hold gets a breathing dot.
  // Only when there are holds and not in a confirmation modal.
  const pendingHolds = ui.workbench.pending();
  if (pendingHolds.length > 0 && !ui.confirmation) {
    // Holds have expiresAt; the one expiring soonest is the most urgent.
    const oldest = pendingHolds.reduce((a, b) =>
      a.expiresAt < b.expiresAt ? a : b,
    );
    const pulse =
      motion.enabled && !motion.reduced ? approvalPulse(motion) : "●";
    const tool = oldest.call?.tool ?? "tool";
    const badge = paintWithPalette(
      `${pulse} ${tool} ${oldest.holdId.slice(0, 6)}`,
      "error",
      palette,
      caps,
    );
    segments.push(badge);
  }

  // Queue indicator with live count and animation.
  if (ui.queuedPrompt) {
    const qPulse =
      motion.enabled && !motion.reduced
        ? ".".repeat(1 + (Math.floor(motion.frame / 4) % 3))
        : "";
    const qState = ui.queuedPromptPaused ? "paused" : `+1${qPulse}`;
    segments.push(
      paintWithPalette("⏳", "warning", palette, caps) +
        ` ${seg("queue", qState, "warning")}`,
    );
  }

  const compactContextOrQueue =
    ui.tab === "chat" || !ui.queuedPrompt
      ? segments[2]!
      : seg("queue", ui.queuedPromptPaused ? "paused" : "+1 queued", "warning");
  // Join with theme separator, respecting width
  const sep = paintWithPalette(symbols.separator.dot, "muted", palette, caps);
  let summary = segments.join(` ${sep} `);
  // Measure the row that actually contains the model, not the unsplit summary.
  while (
    visibleLength(
      width < 50
        ? `${segments[0]} ${sep} ${compactContextOrQueue}`
        : width < 100
          ? segments.slice(0, 2).join(` ${sep} `)
          : summary,
    ) > width &&
    visibleLength(modelShown) > 8
  ) {
    const next = fit(modelShown, visibleLength(modelShown) - 1);
    if (next === modelShown) break;
    modelShown = next;
    segments[0] = seg("model", modelShown, "accent");
    summary = segments.join(` ${sep} `);
  }
  const summaryRows = compactConfirmation
    ? []
    : width < 50
      ? [
          paintWithPalette(modeAuthorityLabel(ui.mode), "info", palette, caps),
          `${segments[0]} ${sep} ${compactContextOrQueue}`,
        ]
      : width < 100
        ? [
            segments.slice(0, 2).join(` ${sep} `),
            segments.slice(2).join(` ${sep} `),
          ]
        : [summary];
  // Compact color legends arrive painted; spacious-shell hints are kept plain
  // until this point so they can be quieted without exposing escape bytes.
  const paintedLegendRows =
    visuals.color === true
      ? spaciousShell
        ? visibleLegendRows.map((row) => ink(row, mutedAnsi))
        : visibleLegendRows
      : visibleLegendRows.map((row) => ink(text(row), muted));
  const todoBadge = (() => {
    try {
      return eventSummary.totalTodos
        ? ` | ✓ ${eventSummary.totalTodos - eventSummary.openTodos}/${eventSummary.totalTodos} todos`
        : "";
    } catch {
      return "";
    }
  })();
  const paletteMatches = paletteView?.items.length ?? 0;
  // The palette status names the match count and the key that runs the
  // selection, because an empty result set and a closed overlay look the
  // same otherwise.
  const status = paletteView
    ? `${paletteMatches} command${paletteMatches === 1 ? "" : "s"}${width < 50 ? "" : " match"} / Enter run / Esc close`
    : ui.confirmation
      ? compactConfirmation
        ? // A compact review puts y/n on the top rail, because the summary
          // rows that used to carry them are dropped. The dock row still names
          // the cancel key, so Esc is never hidden.
          "Esc cancel"
        : width < 50
          ? "Review y allow n deny Esc cancel"
          : "[!] REVIEW / y allow / n deny / Esc cancel / PgDn preview"
      : sessionRunning
        ? `${spinner} ${waiting ? "[wait] Waiting for approval" : `● ${phase}${dots}`}${elapsed} / Esc stop${historyStatus ? " / [history] reading history" : ""}${todoBadge}`
        : busy
          ? `${spinner} Working${dots}`
          : workbenchRunning
            ? `${spinner} Workspace working`
            : `${historyStatus ?? (panelOverlay && ui.notice === "Ready" ? "" : noticeLine(ui.notice))}`;
  // The typed prefix is already in the composer, so a suggestion for an
  // argument shows only the part Enter would add. That is what leaves room
  // for the availability word on a forty column terminal.
  const typedPrefix = visuals.command ?? "";
  const menuRows = menu.map(([name, description], i) => {
    const selected = i + menuStart === selection;
    const label =
      typedPrefix.endsWith(" ") && name.startsWith(typedPrefix)
        ? name.slice(typedPrefix.length)
        : name;
    const prefix = `${selected ? " ›" : "  "} ${label.padEnd(13)} `;
    const room = Math.max(0, width - visibleLength(prefix));
    return ink(
      text(`${prefix}${suggestionHint(description, room)}`),
      selected ? `1;${ice}` : muted,
    );
  });
  // The caret marker is a one-cell placeholder so animation cannot alter
  // wrapping in the fixed Chat composer. Only a focused composer draws it: an
  // unfocused rail names "Tab to write" instead of faking an editing cursor.
  const caret = typeCursor(ui.palette !== undefined || editing, motion);
  // Narrow overflows cannot fit a page hint in the status row, so reuse the
  // body/control divider only when the current view has more content.
  const scrollCue = ui.confirmation
    ? " PgDn preview "
    : ui.showingKeybindings
      ? " PgDn scroll "
      : undefined;
  const scrollCueRuleRows =
    scrollCue &&
    width >= scrollCue.length &&
    width < 50 &&
    ui.viewport.total > ui.viewport.height
      ? ruleRows.map((row) => {
          const start = Math.floor((row.length - scrollCue.length) / 2);
          return (
            `${row.slice(0, start)}${scrollCue}` +
            row.slice(start + scrollCue.length)
          );
        })
      : ruleRows;
  if (chatBaseVisible) {
    const sessions = workbenchSessions;
    const activeSubagents = sessions.filter(
      (session) => session.parentId && session.status === "running",
    ).length;
    // Workbench has no heartbeat source yet. Keep the dock honest instead of
    // presenting an unsupported count as zero.
    const activeHeartbeats: number | null = null;
    const activeShells = ui.activeShellCommands;
    // Match OMP's compact status rail and Prime's theme-derived composer.
    // Framed input stays transparent; only the optional filled surface gets
    // a background. The terminal canvas remains inherited in either mode.
    const currentSession = ui.session();
    const selectedModel = currentSession?.model || ui.model;
    const contextModelIds = (modelId: string) => {
      const ids = [modelId];
      const effortSuffix = /:(?:minimal|low|medium|high|xhigh)$/i.exec(modelId);
      if (effortSuffix?.index !== undefined)
        ids.push(modelId.slice(0, effortSuffix.index));
      return ids;
    };
    const selectedContextModelIds = new Set(contextModelIds(selectedModel));
    const usageMatchesSelectedModel = (modelId: string) =>
      contextModelIds(modelId).some((candidate) =>
        selectedContextModelIds.has(candidate),
      );
    const sessionProviderMatches = currentSession
      ? typeof currentSession.provider === "string" &&
        currentSession.provider === ui.provider?.baseUrl
      : true;
    const contextProviderId = currentSession?.provider ?? ui.provider?.baseUrl;
    const catalogContextModel = sessionProviderMatches
      ? ui.provider?.models.find((model) =>
          selectedContextModelIds.has(model.id),
        )
      : undefined;
    const catalogContextWindow =
      catalogContextModel?.contextWindow ??
      ui.modelContextWindow(contextProviderId, selectedContextModelIds);
    const contextDescriptor =
      sessionProviderMatches &&
      ui.provider?.providerId &&
      ui.provider.transport &&
      ui.provider.baseUrl
        ? ui.provider.availableProviderDescriptors.find(
            (descriptor) =>
              descriptor.providerId === ui.provider?.providerId &&
              descriptor.transport === ui.provider?.transport &&
              descriptor.endpoint === ui.provider?.baseUrl &&
              descriptor.models.some((modelId) =>
                selectedContextModelIds.has(modelId),
              ),
          )
        : undefined;
    const descriptorModelId = contextDescriptor?.models.find((modelId) =>
      selectedContextModelIds.has(modelId),
    );
    const manifestContextWindow = contextDescriptor
      ? modelCapabilityDisclosure(
          contextDescriptor.id,
          descriptorModelId ?? selectedModel,
        )
      : undefined;
    const disclosedContextWindow =
      manifestContextWindow?.status === "known"
        ? manifestContextWindow.contextWindow
        : undefined;
    const contextWindow =
      typeof catalogContextWindow === "number" &&
      Number.isFinite(catalogContextWindow) &&
      catalogContextWindow > 0
        ? catalogContextWindow
        : disclosedContextWindow;
    const usageModel = eventSummary.usage?.model;
    const usageMatchesContext =
      sessionProviderMatches &&
      (typeof usageModel !== "string" || usageMatchesSelectedModel(usageModel));
    const reportedPromptTokens = usageMatchesContext
      ? (eventSummary.usage?.prompt_tokens ?? eventSummary.usage?.input_tokens)
      : undefined;
    const outputTokens =
      eventSummary.usage?.completion_tokens ??
      eventSummary.usage?.output_tokens;
    const totalReportedTokens = eventSummary.usage?.total_tokens;
    const promptTokens =
      typeof reportedPromptTokens === "number" &&
      Number.isFinite(reportedPromptTokens) &&
      reportedPromptTokens >= 0
        ? reportedPromptTokens
        : usageMatchesContext &&
            typeof totalReportedTokens === "number" &&
            Number.isFinite(totalReportedTokens) &&
            typeof outputTokens === "number" &&
            Number.isFinite(outputTokens) &&
            outputTokens >= 0 &&
            totalReportedTokens >= outputTokens
          ? totalReportedTokens - outputTokens
          : undefined;
    const contextPercentage =
      typeof contextWindow === "number" &&
      Number.isFinite(contextWindow) &&
      contextWindow > 0 &&
      typeof promptTokens === "number" &&
      Number.isFinite(promptTokens) &&
      promptTokens >= 0
        ? `${Math.min(100, Math.round((promptTokens / contextWindow) * 100))}%`
        : "—";
    const contextCapacity =
      typeof contextWindow === "number" &&
      Number.isFinite(contextWindow) &&
      contextWindow > 0
        ? contextWindow >= 1_000_000
          ? `${Math.round(contextWindow / 100_000) / 10}m`.replace(/\.0m$/, "m")
          : `${Math.round(contextWindow / 1_000)}k`
        : "unknown";
    const chatRunActive = busy || sessionRunning;
    const activityLabel = ui.hideToolActivity
      ? "Activity hidden · Ctrl+Shift+O show"
      : chatRunActive
        ? `Activity ${ui.toolActivityMode} · Ctrl+O cycle`
        : `Activity ${ui.toolActivityMode}`;
    const paintRail = (text: string) =>
      paintWithPalette(text, editing ? "accent" : "muted", palette, caps);
    const chatInputRows = composerViewport.map((value) => {
      const cursorIndex = value.indexOf(composerCursorMarker);
      // Only the caret is trusted rendering. Draft text may contain controls.
      const draftText =
        cursorIndex < 0
          ? sanitizeText(value)
          : `${sanitizeText(value.slice(0, cursorIndex))}${caret}${sanitizeText(value.slice(cursorIndex + composerCursorMarker.length))}`;
      const available = Math.max(0, width - 4 - visibleLength(draftText));
      return `${paintRail("│")} ${draftText}${" ".repeat(available)} ${paintRail("│")}`;
    });
    // The rail carries the label, one contextual hint, the NIB dock and the
    // status chips. The draft itself is never animated, so a hint, a dock or
    // a chip can never move the caret or change where the text wraps.
    const contextPercentValue = /^\d+%$/.test(contextPercentage)
      ? Number.parseInt(contextPercentage, 10)
      : undefined;
    // A failed run keeps its rail until the operator dismisses it. The rail
    // says Error in words and the status row repeats the provider's message,
    // so the failure survives a monochrome terminal and a colour blind reader.
    const failedEvent = runErrorEvent(
      sessionEvents,
      ui.session()?.status,
    );
    const dismissed = ui.dismissedRunError;
    const failedDismissed =
      failedEvent !== undefined &&
      dismissed !== undefined &&
      dismissed.sessionId === ui.sessionId &&
      dismissed.seq === failedEvent.seq;
    const failedRun = failedEvent !== undefined && !failedDismissed;
    const failedText = failedRun
      ? sanitizeText(failedEvent.text).replace(/\s+/g, " ").trim()
      : "";
    const railHint = composerHint({
      draft: input,
      focused: editing,
      running: chatRunActive,
      approval: waiting,
      failed: failedRun,
      width,
    });
    const petDock = petDocked
      ? composerPetDockCaption(petState, petContext)
      : "";
    // Only a path that really exists in this conversation's managed
    // documents counts, so the chip never promises an attachment the send
    // path would reject as unknown.
    const railAttachment = (() => {
      if (!input.includes("@")) return "";
      const sessionId = ui.sessionId;
      if (!sessionId) return "";
      try {
        return composerAttachmentChip(
          input,
          Object.keys(ui.workbench.workspace(sessionId).files ?? {}),
        );
      } catch {
        return "";
      }
    })();
    // The chips report only what the session knows: no model means no chip,
    // and an unreported prompt share means no meter.
    const railContext = composerContextChip(
      contextPercentValue,
      ui.themeConfig.symbolPreset,
    );
    // The label carries the live phase, because a run in flight is the one
    // state the operator has to be able to read without parsing the status
    // row. The hint beside it carries the action, never a second status.
    const railLabel = failedRun && !editing
      ? "Error"
      : chatRunActive
        ? waiting
          ? "Draft Review required"
          : `Draft ${phase}${dots}`
        : "Draft";
    const sweep =
      editing && motion.enabled && !motion.reduced && ui.composerFocusFrame >= 0
        ? motion.frame - ui.composerFocusFrame
        : -1;
    // The plain rail is kept beside the painted one: the chip hit targets are
    // published from the same string the operator reads, so a chip that was
    // dropped for want of cells can never keep a clickable region.
    const railText = composerTopRail({
      label: railLabel,
      hint: railHint,
      dock: petDock,
      attachment: railAttachment,
      model: "",
      context: railContext,
      queue: ui.queuedPrompt
        ? `${symbols.icons.queue} ${ui.queuedPromptPaused ? "Queue paused" : "1 queued"}`
        : "",
      width,
      tl: symbols.frame.tl,
      h: symbols.frame.h,
      tr: symbols.frame.tr,
      sweep: sweep >= 0 && sweep < COMPOSER_SWEEP_FRAMES ? sweep : -1,
    });
    const draftTitle = paintComposerRail(
      railText,
      composerRailTone({
        focused: editing,
        approval: waiting,
        failed: failedRun,
      }),
      palette,
      caps,
    );
    const draftEnd = closeDraftRail
      ? [
          paintRail(
            composerBottomRail({
              width,
              bl: symbols.frame.bl,
              br: symbols.frame.br,
              h: symbols.frame.h,
              streaming: chatRunActive && !waiting,
              frame: motion.frame,
              reduced: !motion.enabled || motion.reduced,
            }),
          ),
        ]
      : [];
    const chatNav =
      ui.scroll >= 0 && historyStatus
        ? historyStatus
        : width >= 96
          ? "← Sessions · double-click"
          : "← Sessions ×2";
    const modelIcon = ui.localTabIcons
      ? kittyTabIconLabel("models", ui.localTabIcons, ui.themeConfig.colorTheme)
      : symbols.icons.model;
    const contextIcon =
      (ui.localTabIcons
        ? kittySemanticIconLabel(
            "context",
            ui.localTabIcons,
            ui.themeConfig.colorTheme,
          )
        : "") || symbols.icons.context;
    const queueIcon =
      (ui.localTabIcons
        ? kittySemanticIconLabel(
            "queue",
            ui.localTabIcons,
            ui.themeConfig.colorTheme,
          )
        : "") || symbols.icons.queue;
    const contextBar =
      contextPercentValue === undefined
        ? ""
        : ` ${"▰".repeat(Math.round(contextPercentValue / 20))}${"▱".repeat(5 - Math.round(contextPercentValue / 20))}`;
    const modelStatusText = `${selectedModel ? sanitizeText(selectedModel) : "No model selected"}${chatRunActive && width >= 56 ? " · Esc stop" : ""}`;
    const modelStatusIcon = paintWithPalette(
      modelIcon,
      "accent",
      palette,
      caps,
    );
    const contextStatusText = `${contextIcon} ${contextCapacity} ${contextBar} ${contextPercentage}`;
    const contextStatusRow = `${paintWithPalette(contextIcon, "info", palette, caps)} ${paintWithPalette(contextCapacity, "muted", palette, caps)}${contextBar ? ` ${paintWithPalette(contextBar.trim(), contextPercentValue !== undefined && contextPercentValue >= 80 ? "warning" : "info", palette, caps)}` : ""} ${paintWithPalette(contextPercentage, contextPercentValue !== undefined && contextPercentValue >= 80 ? "warning" : "muted", palette, caps)}`;
    const contextStatusCompact = `${contextCapacity} ${contextPercentage}`;
    const contextStatusIconCompact = `${symbols.icons.context} ${contextStatusCompact}`;
    const contextStatusRowFor = (availableWidth: number) => {
      if (visibleLength(contextStatusRow) <= availableWidth)
        return contextStatusRow;
      if (visibleLength(contextStatusIconCompact) <= availableWidth)
        return paintWithPalette(
          contextStatusIconCompact,
          "info",
          palette,
          caps,
        );
      if (visibleLength(contextStatusCompact) <= availableWidth)
        return paintWithPalette(contextStatusCompact, "muted", palette, caps);
      return paintWithPalette(
        fit(contextPercentage, availableWidth),
        "muted",
        palette,
        caps,
      );
    };
    const modelStatusRow = (availableWidth: number) => {
      const iconFits = visibleLength(modelIcon) + 2 <= availableWidth;
      const icon = iconFits ? `${modelStatusIcon} ` : "";
      return `${icon}${paintWithPalette(
        fit(
          modelStatusText,
          Math.max(
            1,
            availableWidth - (iconFits ? visibleLength(modelIcon) + 1 : 0),
          ),
        ),
        "accent",
        palette,
        caps,
      )}`;
    };
    // The footer reports only what the session actually knows. The token rate
    // is `n/a` unless a provider reported one, the context share comes from
    // the reported prompt tokens against the real window, and the location is
    // the working directory folded to `~` plus the branch git reports. The
    // branch comes from a cache the frame never waits on, so the first frame
    // of a session prints the directory alone.
    const speedText = `tok/s ${tokensPerSecondLabel(usage)}`;
    // The status row names the streaming phase in words beside the model, the
    // real token rate and the context share. It is the same word the pet and
    // the rail use, so the frame cannot say two different things about one run.
    const writingText = chatRunActive && !waiting ? "writing" : "";
    const cwd = visuals.cwd ?? process.cwd();
    const cwdText = shortenHomePath(cwd);
    // The probe is cached, so this frame reads a value or omits the branch. It
    // never waits for git and never guesses one.
    const gitStatus = cachedGitStatus(cwd);
    // The branch is appended only where the footer has room for it: from 56
    // terminal columns up. Below that the row keeps the directory alone,
    // exactly as it did before a branch source existed.
    const locationFor = (available: number): string =>
      locationLabel(cwd, gitStatus, available);
    const footerExtra = (
      base: string,
      extra: string,
      limit: number,
    ): string =>
      extra !== "" && visibleLength(base) + 1 + visibleLength(extra) <= limit
        ? `${base} ${paintWithPalette(extra, "muted", palette, caps)}`
        : base;
    // A failed run puts its message in the status row the frame already
    // prints, so the rail's word Error is backed by the provider's own text
    // rather than by a colour. The row count never changes: at one row the
    // error replaces the model and context segments, and at three rows it
    // takes the model row while the context keeps its own.
    const failedStatusRow = (limit: number): string =>
      paintWithPalette(
        fit(`! ${failedText}`, Math.max(1, limit)),
        "error",
        palette,
        caps,
      );
    const chatStatusRows =
      chatStatusRowCount === 1
        ? (() => {
            const rightLimit = Math.max(
              1,
              width - visibleLength(chatNav) - 1,
            );
            let rightStatus: string;
            if (failedText !== "") rightStatus = failedStatusRow(rightLimit);
            else {
              const modelSpace = Math.max(
                1,
                width -
                  visibleLength(chatNav) -
                  visibleLength(contextStatusText) -
                  4,
              );
              const modelRow = modelStatusRow(modelSpace);
              rightStatus = `${modelRow}  ${contextStatusRowFor(width)}`;
              rightStatus = footerExtra(rightStatus, writingText, rightLimit);
              rightStatus = footerExtra(rightStatus, speedText, rightLimit);
              const locationShown =
                terminalWidth >= 56
                  ? locationFor(
                      Math.max(0, rightLimit - visibleLength(rightStatus) - 1),
                    )
                  : fit(cwdText, LOCATION_DIRECTORY_CAP);
              rightStatus = footerExtra(rightStatus, locationShown, rightLimit);
            }
            return [
              `${paintWithPalette(chatNav, "muted", palette, caps)}${" ".repeat(
                Math.max(
                  1,
                  width - visibleLength(chatNav) - visibleLength(rightStatus),
                ),
              )}${rightStatus}`,
            ];
          })()
        : [
            paintWithPalette(fit(chatNav, width), "muted", palette, caps),
            failedText !== ""
              ? failedStatusRow(width)
              : footerExtra(
                  footerExtra(modelStatusRow(width), writingText, width),
                  speedText,
                  width,
                ),
            footerExtra(
              contextStatusRowFor(width),
              terminalWidth >= 56
                ? locationFor(
                    Math.max(
                      0,
                      width - visibleLength(contextStatusRowFor(width)) - 1,
                    ),
                  )
                : fit(
                    cwdText,
                    Math.max(
                      0,
                      width - visibleLength(contextStatusRowFor(width)) - 1,
                    ),
                  ),
              width,
            ),
          ];
    const activitySegment = (
      icon: string,
      fallbackIcon: string,
      value: string,
      label: string,
      tone: Parameters<typeof paintWithPalette>[1],
    ) => {
      // Keep measured values stable. Image icons get a small animated activity
      // bead; terminals without Kitty graphics pulse the semantic fallback.
      const pulse = motion.enabled && !motion.reduced && motion.frame % 8 < 2;
      const isActive =
        value !== "0" && value !== "n/a" && value !== "unavailable";
      const iconContent = icon
        ? `${icon}${pulse && isActive ? paintWithPalette("•", tone, palette, caps) : ""}`
        : paintWithPalette(fallbackIcon, tone, palette, caps, pulse);
      return `${iconContent} ${value}${label ? ` ${label}` : ""}`;
    };
    const activityIconLabel = (key: string) =>
      ui.localTabIcons
        ? kittyActivityIconLabel(
            key,
            ui.localTabIcons,
            ui.themeConfig.colorTheme,
          )
        : "";
    const activityIcons = {
      subagents: activityIconLabel("subagents"),
      heartbeats: activityIconLabel("heartbeats"),
      shells: activityIconLabel("shells"),
      queue: ui.localTabIcons
        ? kittySemanticIconLabel(
            "queue",
            ui.localTabIcons,
            ui.themeConfig.colorTheme,
          )
        : "",
    };
    const activityFallbackIcons = {
      subagents: symbols.icons.agent,
      heartbeats: symbols.icons.heartbeat,
      shells: symbols.icons.shell,
      queue: symbols.icons.queue,
    };
    const queuedCount = ui.queuedPrompt ? "1" : "0";
    const queuedLabel = ui.queuedPrompt
      ? ui.queuedPromptPaused
        ? "paused"
        : "queued"
      : "queued";
    const chatActivityFull =
      `  ${activitySegment(activityIcons.subagents, activityFallbackIcons.subagents, String(activeSubagents), `subagent${activeSubagents === 1 ? "" : "s"}`, "success")}  ·  ` +
      `${activitySegment(activityIcons.heartbeats, activityFallbackIcons.heartbeats, activeHeartbeats === null ? "unavailable" : String(activeHeartbeats), activeHeartbeats === null ? "" : `heartbeat${activeHeartbeats === 1 ? "" : "s"}`, "warning")}  ·  ` +
      activitySegment(
        activityIcons.shells,
        activityFallbackIcons.shells,
        String(activeShells),
        `shell${activeShells === 1 ? "" : "s"}`,
        "info",
      ) +
      `  ·  ${activitySegment(activityIcons.queue, activityFallbackIcons.queue, queuedCount, queuedLabel, "warning")}`;
    const chatActivityCompact =
      `  ${activitySegment(activityIcons.subagents, activityFallbackIcons.subagents, String(activeSubagents), "sub", "success")}  ·  ` +
      `${activitySegment(activityIcons.heartbeats, activityFallbackIcons.heartbeats, activeHeartbeats === null ? "n/a" : String(activeHeartbeats), "hb", "warning")}  ·  ` +
      activitySegment(
        activityIcons.shells,
        activityFallbackIcons.shells,
        String(activeShells),
        "sh",
        "info",
      ) +
      `  ·  ${activitySegment(activityIcons.queue, activityFallbackIcons.queue, queuedCount, ui.queuedPromptPaused ? "pause" : "q", "warning")}`;
    const chatActivityNarrow =
      ` ${activitySegment(activityIcons.subagents, activityFallbackIcons.subagents, String(activeSubagents), "", "success")} · ` +
      `${activitySegment(activityIcons.heartbeats, activityFallbackIcons.heartbeats, activeHeartbeats === null ? "n/a" : String(activeHeartbeats), "", "warning")} · ` +
      activitySegment(
        activityIcons.shells,
        activityFallbackIcons.shells,
        String(activeShells),
        "",
        "info",
      ) +
      ` · ${activitySegment(activityIcons.queue, activityFallbackIcons.queue, queuedCount, "", "warning")}`;
    // The checklist rides on the activity row the chat already prints, so the
    // count is visible without spending a row. The rail owns the wide layout,
    // the readable chip serves a mid-size terminal and the count alone is what
    // a forty column row can carry.
    const todoFullChip =
      chatRailWidth > 0 ? "" : todoChip(sessionTodos, "full");
    const todoCountChip =
      chatRailWidth > 0 ? "" : todoChip(sessionTodos, "count");
    const activityWithTodo = (
      row: string,
      separator: string,
      chip: string,
    ): string =>
      chip === ""
        ? row
        : `${row}${separator}${paintWithPalette(chip, "accent", palette, caps)}`;
    const activityCandidates: string[] =
      width >= TODO_CHIP_MIN_WIDTH
        ? [
            activityWithTodo(chatActivityFull, "  ·  ", todoFullChip),
            activityWithTodo(chatActivityCompact, "  ·  ", todoFullChip),
            activityWithTodo(chatActivityNarrow, " · ", todoCountChip),
          ]
        : [activityWithTodo(chatActivityNarrow, " · ", todoCountChip)];
    const chatActivityRow = fit(
      activityCandidates.find((row) => visibleLength(row) <= width) ??
        activityWithTodo(chatActivityNarrow, " · ", todoCountChip),
      width,
    );
    const separatorRow = ink("─".repeat(width), mutedAnsi);
    const chatInputFooter = [
      // The bubble sits above the rail, on the rows the chrome budget already
      // reserved for it. It is never between the draft and its status row, so
      // the caret and the keys keep their places.
      ...petBubbleRows,
      draftTitle,
      ...chatInputRows,
      ...draftEnd,
      ...chatStatusRows,
      separatorRow,
      chatActivityRow,
    ];
    const chatPrefix = [
      ...header,
      ...banner.map((row) =>
        ink(
          text(banner.length ? row.replace("[!]", approvalPulse(motion)) : row),
          `1;${amber}`,
        ),
      ),
    ];
    const noticeBand = chatNoticeRows(
      ui.notice,
      width,
      Math.max(
        0,
        height -
          chatPrefix.length -
          // The toast stack is drawn above the composer below, but it spends
          // the same rows, so the notice band's budget counts it here or the
          // frame would grow past the terminal.
          shownToastRows.length -
          menuRows.length -
          (argumentHint ? 1 : 0) -
          chatInputFooter.length -
          chatPanelTopMarginY -
          1,
      ),
    );
    const chatOverlays = [
      ...menuRows,
      ...(argumentHint
        ? [
            ink(
              fit(`  ${ROW_ICONS.unknown} expects: ${argumentHint}`, width),
              muted,
            ),
          ]
        : []),
      // A command result used to be invisible in Chat: the panel branch prints
      // it in the status row, and Chat has no status row of its own.
      ...noticeBand.map((row) => ink(fit(row, width), muted)),
      // The transient stack sits directly above the composer, on rows the
      // frame already budgeted, so it never covers the draft or the keys.
      ...shownToastRows,
    ];
    const availableBodyRows = Math.max(
      0,
      height -
        chatPrefix.length -
        chatOverlays.length -
        chatInputFooter.length -
        chatPanelTopMarginY,
    );
    // The rail occupies the fixed right column the transcript was laid out
    // around. It never scrolls with the transcript and never paints over it:
    // each row is the transcript row plus the rail cell for the same screen
    // line, and the two add up to exactly the panel width.
    // Section headings are the only accented rows: bold plus accent keeps the
    // rail's structure visible without colour, because the heading word is
    // still printed. The gauge on the TODO heading shares that tone.
    const railRow = (value: string): string => {
      const plain = fit(value, chatRailWidth);
      const heading = /^(?:TODO|SUBAGENTS|RUN)\b/.test(plain);
      return paintWithPalette(
        pad(plain, chatRailWidth),
        heading ? "accent" : "muted",
        palette,
        caps,
        heading,
      );
    };
    const chatBodyRows =
      chatRail.length > 0
        ? bodyRows.map((row, index) => `${row}${railRow(chatRail[index] ?? "")}`)
        : bodyRows;
    // The sticky breadcrumb is drawn only while the transcript is scrolled up
    // and there is more transcript than the body can show. It takes one body
    // row rather than adding one, so the composer, the status row and the
    // review keys keep their places on every terminal size.
    // The sticky breadcrumb is drawn only while the operator has scrolled to an
    // explicit offset and there is more transcript than the body can show.
    // Following the tail keeps the full window: the newest row is the one the
    // operator is reading, and a breadcrumb there would cost them a line of it.
    const scrolledUp =
      ui.scroll >= 0 && offset > 0 && lines.length > availableBodyRows;
    const stickyRow =
      scrolledUp && availableBodyRows >= 2
        ? ink(
            pad(
              stickyTranscriptLine({
                ...(ui.session()?.title === undefined
                  ? {}
                  : { title: ui.session()?.title }),
                phase: waiting
                  ? "Waiting for approval"
                  : sessionRunning || chatRunActive
                    ? taskPhaseWord(sessionSummary.lastVisible, waiting)
                    : "Idle",
                arrow: symbols.arrow.up,
                width,
              }),
              width,
            ),
            muted,
          )
        : undefined;
    const bodyRowBudget = Math.max(
      0,
      availableBodyRows - (stickyRow === undefined ? 0 : 1),
    );
    const visibleChatBody = chatBodyRows.slice(0, bodyRowBudget);
    const footerBase =
      chatPrefix.length +
      chatPanelTopMarginY +
      (stickyRow === undefined ? 0 : 1) +
      visibleChatBody.length +
      chatOverlays.length;
    const statusRowNumber =
      footerBase +
      petBubbleRows.length +
      chatInputRows.length +
      draftEnd.length +
      1;
    // SGR mouse coordinates are one-based, so publish the rendered status row
    // and horizontal hitbox in terminal coordinates rather than array offsets.
    const chatStatusStart = chatPanelMarginX + 1;
    ui.tabHitTargets.push({
      tab: "sessions",
      row: statusRowNumber + 1,
      start: chatStatusStart,
      end: chatStatusStart + Math.min(width, visibleLength(chatNav)) - 1,
    });
    // Composer chips are real click targets: the model chip opens the picker
    // the same way `/model` does, the context meter opens Usage, the
    // attachment chip opens Documents and the NIB dock opens the signal card.
    // Each rect comes from the plain row the operator is reading, so a chip
    // that was dropped for want of cells publishes nothing.
    const chipTarget = (
      rowText: string,
      needle: string,
      action: ChipAction,
      row: number,
    ) => {
      const span = cellSpan(rowText, needle);
      if (span === undefined) return;
      ui.rowHitTargets.push({
        row,
        start: chatStatusStart + span.start,
        end: chatStatusStart + span.end,
        kind: "chip",
        index: 0,
        action,
      });
    };
    const railRowNumber = footerBase + petBubbleRows.length + 1;
    chipTarget(railText, petDock, "pet", railRowNumber);
    chipTarget(railText, railAttachment, "documents", railRowNumber);
    const modelNeedle = selectedModel
      ? sanitizeText(selectedModel)
      : "No model selected";
    const contextNeedles = [
      contextStatusText,
      contextStatusIconCompact,
      contextStatusCompact,
      contextPercentage,
    ];
    const statusPlain = chatStatusRows.map((row) => stripAnsi(row));
    if (chatStatusRowCount === 1) {
      const row = statusRowNumber + 1;
      chipTarget(statusPlain[0] ?? "", modelNeedle, "model", row);
      for (const needle of contextNeedles) {
        if (cellSpan(statusPlain[0] ?? "", needle) === undefined) continue;
        chipTarget(statusPlain[0] ?? "", needle, "usage", row);
        break;
      }
    } else {
      chipTarget(statusPlain[1] ?? "", modelNeedle, "model", statusRowNumber + 2);
      for (const needle of contextNeedles) {
        if (cellSpan(statusPlain[2] ?? "", needle) === undefined) continue;
        chipTarget(statusPlain[2] ?? "", needle, "usage", statusRowNumber + 3);
        break;
      }
    }
    // A click anywhere on a toast row dismisses it. The queue already ages
    // out on its own, so this is an accelerator, not the only way to clear it.
    const toastStackWidthCells = toastStackWidth(width);
    if (shownToastRows.length > 0 && toastStackWidthCells > 0) {
      const firstToastRow =
        chatPrefix.length +
        chatPanelTopMarginY +
        (stickyRow === undefined ? 0 : 1) +
        visibleChatBody.length +
        chatOverlays.length -
        shownToastRows.length;
      shownToastRows.forEach((_row, index) => {
        ui.rowHitTargets.push({
          row: firstToastRow + index + 1,
          start: chatStatusStart + (width - toastStackWidthCells),
          end: chatStatusStart + width - 1,
          kind: "toast",
          index,
        });
      });
    }
    ui.viewport = {
      ...ui.viewport,
      height: visibleChatBody.length,
      // The sticky line is window, not transcript: paging counts it so a page
      // down still reaches live follow.
      stickyRows: stickyRow === undefined ? 0 : 1,
      // The rail paints on the transcript rows only, so the band starts after
      // the header, the sticky line and the overlay rows. A click inside it
      // belongs to the rail.
      ...(chatRail.length > 0
        ? {
            railTop:
              chatPrefix.length +
              chatPanelTopMarginY +
              (stickyRow === undefined ? 0 : 1) +
              1,
            railRows: visibleChatBody.length,
          }
        : {}),
    };
    const chatRows = [
      ...(stickyRow === undefined ? [] : [stickyRow]),
      ...visibleChatBody,
      ...chatOverlays,
      ...chatInputFooter,
    ].map((row) => pad(row, width));
    const horizontalMargin = " ".repeat(chatPanelMarginX);
    const laidOutChat = [
      ...chatPrefix.map((row) => pad(row, terminalWidth)),
      ...Array.from({ length: chatPanelTopMarginY }, () =>
        pad("", terminalWidth),
      ),
      ...chatRows.map((row) => `${horizontalMargin}${row}${horizontalMargin}`),
    ].map((row) =>
      visuals.color
        ? `\x1b[39m${pad(row, terminalWidth)}\x1b[0m`
        : pad(row, terminalWidth),
    );
    return laidOutChat.slice(0, terminalHeight).join("\n");
  }
  const panelContent = [
    ...header,
    // The leading marker pulses in place rather than adding a row. The banner
    // still states the hold in words on the same line, so the pulse is
    // attention and never the meaning.
    ...banner.map((row) =>
      ink(
        text(banner.length ? row.replace("[!]", approvalPulse(motion)) : row),
        `1;${amber}`,
      ),
    ),
    // renderToasts paints by tone already. Wrapping the row in ink() again
    // would repaint the whole line in one muted colour and throw the tone
    // away, which is the only signal separating a danger from a success.
    ...shownToastRows,
    ...renderedBodyRows,
    // The timeline follows the run this process started and stays with its
    // transcript, ahead of the controls and bottom status dock.
    ...shownTimelineRows,
    // The rule marks where the body ends and the controls begin, so the
    // operator does not have to read the composer frame to know it is about
    // to type into it.
    ...scrollCueRuleRows.map((row) => ink(row, muted)),
    ...menuRows,
    ...(argumentHint
      ? [
          ink(
            fit(`  ${ROW_ICONS.unknown} expects: ${argumentHint}`, width),
            muted,
          ),
        ]
      : []),
    // The legend sits above the composer, never after it. A legend placed
    // below would be the last thing the slice(0, height) drops on a short
    // terminal, and the operator would lose the prompt frame's bottom rule.
    ...paintedLegendRows,
    // Panels use the whole framed surface. Their filter/search state is
    // keyboard-driven, so the persistent Chat composer stays on Chat only.
    ...summaryRows.map((row) =>
      ink(fit(row, width), spaciousShell ? mutedAnsi : ice),
    ),
    ink(text(status), ui.confirmation ? `1;${amber}` : running ? amber : muted),
  ];
  // A compact review has no summary rows left to carry the decision keys, so
  // the title row becomes a rail that names them. It costs no extra row and
  // cannot be pushed off the frame by evidence, which is what keeps y and n
  // reachable at 40x12. Wider reviews keep the title and the full legend.
  const compactReviewRail =
    ui.confirmation && compactConfirmation
      ? composerTopRail({
          label: "Review",
          hint: "y allow · n deny",
          gap: "  ",
          width: terminalWidth,
          tl: symbols.frame.tl,
          h: symbols.frame.h,
          tr: symbols.frame.tr,
        })
      : undefined;
  const panelFrameTitle = fitWithTrustedIcons(
    ` NOMO  ${panelTitle}`,
    width,
    trustedIcons,
  );
  const panelInterior = panelContent.slice(0, height);
  while (panelInterior.length < height) panelInterior.push("");
  const framedPanel = [
    compactReviewRail === undefined
      ? pad(
          paintWithPalette(panelFrameTitle, "accent", palette, caps, true),
          terminalWidth,
        )
      : paintWithPalette(compactReviewRail, "accent", palette, caps, true),
    ...panelInterior.map((row) => ` ${pad(row, width)} `),
    pad("", terminalWidth),
  ];
  return framedPanel
    .slice(0, terminalHeight)
    .map((row) => (visuals.color ? `\x1b[39m${row}\x1b[0m` : row))
    .join("\n");
}
export const STATUS_ICONS = {
  success: "+",
  error: "!",
  warning: "!",
  info: "i",
  pending: "?",
  running: ">",
  waiting: "?",
  approval: "!",
  document: "#",
  ledger: "=",
  tool: "+",
  model: "@",
  session: "#",
  document_list: "=",
  approval_list: "!",
  settings: "*",
  help: "?",
  search: "/",
  filter: "/",
  undo: "<",
  redo: ">",
  save: "S",
  export: "E",
  import: "I",
  connect: "+",
  disconnect: "-",
  theme: "*",
  keybindings: "?",
  quit: "Q",
  new: "+",
  edit: "E",
  delete: "X",
  copy: "C",
  paste: "P",
} as const;
/**
 * Every shortcut as data rather than as one packed sentence per line.
 *
 * The packed form read fine on paper and badly on screen: a line held three
 * unrelated bindings separated by pipes, so a reader scanning for one key had
 * to parse the whole line before knowing whether it was there. As rows it
 * can be rendered as a table, filtered by typing, and scrolled.
 */
const KEYBINDING_ROWS: readonly {
  readonly keys: string;
  readonly action: string;
  readonly group: string;
}[] = [
  { group: "send", keys: "Enter in Chat composer", action: "Send the prompt" },
  {
    group: "navigate",
    keys: "Enter / Return on non-Chat lists and trees",
    action:
      "Open/inspect the selected row, open a Sessions conversation, or toggle a tree group/folder",
  },
  {
    group: "send",
    keys: "Shift+Enter / Alt+Enter / Ctrl+J",
    action: "Insert a newline",
  },
  {
    group: "input",
    keys: "Ctrl+O",
    action:
      "Cycle compact, details and expanded agent activity; expanded reveals the recorded reasoning block; never resizes the composer",
  },
  {
    group: "input",
    keys: "Alt+N",
    action: "Show or hide NIB the pet; never sends a prompt or edits the draft",
  },
  {
    group: "input",
    keys: "Alt+Shift+N",
    action: "Open or close the NIB signal card over the Chat body",
  },
  {
    group: "input",
    keys: "Left / Right while editing",
    action: "Move the input cursor",
  },
  {
    group: "input",
    keys: "Up / Down while editing",
    action: "History, command suggestions, or multiline cursor",
  },
  {
    group: "input",
    keys: "Up / Down in single-line Chat input",
    action: "Browse prompt history",
  },
  {
    group: "navigate",
    keys: "Ctrl+P / Ctrl+N outside the composer",
    action: "Move the selected row up or down",
  },
  {
    group: "input",
    keys: "Ctrl+N in Chat input",
    action: "Newer prompt in single-line history; move down in multiline text",
  },
  {
    group: "input",
    keys: "Ctrl+A / Ctrl+E",
    action: "Start or end of the line",
  },
  {
    group: "input",
    keys: "Alt+B/F/Left/Right or Ctrl+Left/Right",
    action: "Jump by word",
  },
  {
    group: "input",
    keys: "Ctrl+] / Ctrl+Alt+] then a character",
    action: "Jump to the next or previous matching character",
  },
  {
    group: "input",
    keys: "Alt+D / Alt+Delete",
    action: "Delete the next word",
  },
  {
    group: "input",
    keys: "Alt+Backspace / Ctrl+Backspace / Ctrl+W",
    action: "Delete the previous word",
  },
  { group: "input", keys: "Ctrl+K", action: "Delete to end of prompt" },
  { group: "input", keys: "Ctrl+U", action: "Delete to start of prompt" },
  {
    group: "input",
    keys: "Ctrl+Y / Alt+Y",
    action: "Paste or cycle killed text",
  },
  {
    group: "input",
    keys: "Alt+Up / Shift+Up when a prompt is queued",
    action: "Restore the queued prompt to Chat and keep the current draft",
  },
  {
    group: "input",
    keys: "Ctrl+Q / Ctrl+Enter while a run is active",
    action: "Queue the Chat draft behind the active turn",
  },
  {
    group: "input",
    keys: "Alt+Shift+C while editing",
    action: "Copy the current Chat prompt to the system clipboard",
  },
  {
    group: "input",
    keys: "Ctrl+_ / Ctrl+Shift+Z",
    action: "Undo / redo the last edit",
  },
  { group: "input", keys: "Ctrl+D", action: "Delete forward, twice exit" },
  {
    group: "input",
    keys: "Tab with command/@ suggestions",
    action: "Complete a command or @ mention",
  },
  { group: "navigate", keys: "Tab from a panel", action: "Return to Chat" },
  {
    group: "navigate",
    keys: "Mouse click / double-click / wheel",
    action:
      "Select or open rows; wheel scrolls Chat/details or moves lists; Shift+drag selects and copies text",
  },
  {
    group: "navigate",
    keys: "Left / Right in a tree",
    action: "Page the tree selection; Enter expands or collapses groups",
  },
  {
    group: "navigate",
    keys: "Up / Down in list/tree views",
    action:
      "Select and wrap through flat rows or move the tree cursor; scroll open details/previews",
  },
  { group: "navigate", keys: "{ and }", action: "Jump between your prompts" },
  {
    group: "navigate",
    keys: "PgUp / PgDn",
    action:
      "Scroll a focused detail or Chat; page a list/tree selection otherwise",
  },
  {
    group: "navigate",
    keys: "Esc",
    action:
      "Cancel/close overlays; clear queries/filters; exit input/detail; stop run",
  },
  {
    group: "navigate",
    keys: "Esc Esc",
    action: "Clear the input, or list checkpoints when empty",
  },
  {
    group: "navigate",
    keys: "Shift+Tab",
    action: "Cycle mode: normal, accept, plan",
  },
  {
    group: "review",
    keys: "y / n / Esc",
    action: "Accept, reject or cancel a review",
  },
  {
    group: "review",
    keys: "Enter on Approvals",
    action:
      "Enter inspects; Esc closes. On a base view, a/d opens the oldest pending review; y/n decides",
  },
  { group: "review", keys: "1 to 9", action: "Toggle a hunk in the diff" },
  {
    group: "session",
    keys: "Ctrl+R while editing",
    action: "Search this conversation or cycle matching prompts",
  },
  {
    group: "session",
    keys: "Ctrl+T outside editing",
    action: "Show the checklist from the current conversation's output",
  },
  {
    group: "session",
    keys: "F5 / Alt+R after a failed turn",
    action: "Retry the prompt in a new branch after confirmation",
  },
  {
    group: "session",
    keys: "Ctrl+Shift+O",
    action: "Hide or show tool activity; saved for the next session",
  },
  {
    group: "session",
    keys: "Alt+L",
    action: "Redraw the current terminal view",
  },
  ...(process.platform === "win32"
    ? []
    : [
        {
          group: "session",
          keys: "Ctrl+Z (POSIX)",
          action: "Suspend NOMO to the shell; resume with fg",
        },
      ]),
  { group: "session", keys: "Ctrl+S", action: "Stash, press again to restore" },
  {
    group: "session",
    keys: "Ctrl+G or Ctrl+X Ctrl+E",
    action: "Open the editor",
  },
  {
    group: "session",
    keys: "Alt+M",
    action: "Open provider/model picker; selection sets future default",
  },
  {
    group: "session",
    keys: "Alt+P",
    action: "Choose a model for the current conversation; provider stays fixed",
  },
  {
    group: "session",
    keys: "Alt+A",
    action: "Open the read-only Agents panel",
  },
  {
    group: "session",
    keys: "Alt+Shift+P in Chat",
    action:
      "Toggle local plan mode; restore the previous local mode when turned off",
  },
  {
    group: "session",
    keys: "Left / Right / Tab / Shift+Tab in Models picker",
    action:
      "Switch focus between configured providers and the selected provider's model catalog",
  },
  {
    group: "session",
    keys: "Ctrl+Left / Ctrl+Right in Models search",
    action: "Move the search caret without changing provider/model focus",
  },
  {
    group: "session",
    keys: "Mouse hover / click / double-click / wheel",
    action:
      "Highlight, select or open rows; wheel scrolls Chat/details; Shift+drag selects and copies text",
  },
  {
    group: "session",
    keys: "Ctrl+L",
    action: "Redraw, twice clear the screen",
  },
  {
    group: "session",
    keys: "Ctrl+C",
    action: "Clear, then cancel, then exit",
  },
];

const KEYBINDING_GROUP_ICON: Record<string, string> = {
  send: ">",
  input: "|",
  navigate: "±",
  review: "◆",
  session: "≡",
};

const KEYBINDING_GROUP_TITLE: Record<string, string> = {
  send: "SENDING",
  input: "EDITING",
  navigate: "NAVIGATION",
  review: "REVIEW",
  session: "SESSION",
};

/**
 * The /keybindings view as a grouped table.
 *
 * Grouping is the whole point: a reader looking for how to undo an input
 * should land on one short block, not on a screen where that binding shares a
 * line with two unrelated ones.
 */
function keybindingLines(query: string, width: number): string[] {
  const needle = query.trim().toLowerCase();
  const matching = KEYBINDING_ROWS.filter(
    (row) =>
      !needle ||
      row.keys.toLowerCase().includes(needle) ||
      row.action.toLowerCase().includes(needle) ||
      row.group.includes(needle),
  );
  const lines = [
    fit(
      "KEYBINDINGS, same action as the reference terminal where NOMO has it",
      width,
    ),
    "",
    fit(`${matching.length} of ${KEYBINDING_ROWS.length} bindings`, width),
    "",
  ];
  if (!matching.length) {
    lines.push(fit(`No binding matches "${query.trim()}".`, width));
    lines.push("");
    lines.push(
      fit("Backspace deletes a character, Esc clears the search.", width),
    );
    return lines;
  }
  // The key column is sized to its content rather than to a guess: a binding
  // like "Alt+B / Alt+F or Ctrl+Left / Ctrl+Right" is long enough that a
  // fixed column would push every action to the right edge. The cap stops a
  // narrow terminal from leaving no room at all for the action column.
  const indent = "  ";
  const keyWidth = Math.min(
    Math.max(...matching.map((row) => visibleLength(row.keys))),
    Math.max(6, Math.floor(width / 2) - indent.length),
  );
  for (const group of ["send", "input", "navigate", "review", "session"]) {
    const rows = matching.filter((row) => row.group === group);
    if (!rows.length) continue;
    lines.push(
      fit(
        `${indent}${KEYBINDING_GROUP_ICON[group] ?? "-"} ${KEYBINDING_GROUP_TITLE[group] ?? group}`,
        width,
      ),
    );
    // The action is dropped before the key is truncated. A key with no
    // description is useless, while a truncated key is still recognisable.
    const room = Math.max(0, width - indent.length - keyWidth - 2);
    for (const row of rows)
      lines.push(
        `${indent}${fit(row.keys, keyWidth)}  ${fit(row.action, room)}`,
      );
    lines.push("");
  }
  lines.push(
    fit(
      "No NOMO equivalent: background tasks, clipboard paste/image attachment, Vim editing.",
      width,
    ),
  );
  lines.push(
    fit("Type to filter these bindings. Esc clears the search.", width),
  );
  return lines;
}
/**
 * The help view as sections rather than as a wall of prose.
 *
 * It used to end with twenty lines listing every command by hand, which was
 * a copy of the palette that already lists them all and a third place for a
 * new command to be forgotten. The list now lives in exactly one place and
 * this view says where it is.
 */
/**
 * The command set grouped by the task it serves, plus what is not here.
 *
 * The palette searches by name, so it answers "what is the command for X" for
 * someone who already knows what X is called. This answers the earlier
 * question: an operator who has just opened the product and knows five
 * commands has no idea which of the sixty seven to reach for, and a flat list
 * gives them no way to find out.
 */
function discoverLines(width = 72): string[] {
  const entries: CommandEntry[] = TUI_COMMANDS.map(([id, summary]) => ({
    id,
    summary,
    group: discoveryGroupFor(id),
  }));
  const rows = discoveryRows(entries, { width });
  return [...rows, "", ...absentCapabilities().map((line) => `  ${line}`)];
}
/**
 * Which task a command belongs to.
 *
 * Derived from the command name rather than declared per entry, because the
 * table below and the command list would then be two lists that could drift.
 * A command with no entry falls through as unrecognised, which the panel shows
 * last instead of guessing a group for it.
 */
function discoveryGroupFor(id: string): string {
  const name = id.slice(1).split(" ")[0] ?? "";
  if (COMMAND_GROUPS[name]) return COMMAND_GROUPS[name]!;
  return (
    DISCOVERY_GROUPS.find((group) =>
      DISCOVERY_MEMBERS[group]?.some((member) => name.startsWith(member)),
    ) ?? ""
  );
}
/**
 * Commands grouped by the situation a person arrives in, not the order they
 * happen to be declared in. The order is the one a first time operator thinks
 * in: start something, read what is there, change it, run it, watch it, share
 * it, configure it.
 */
const DISCOVERY_MEMBERS: Record<string, readonly string[]> = {
  starting: ["new", "resume", "sessions", "chat", "init", "bottom", "clear"],
  reading: [
    "documents",
    "context",
    "ledger",
    "history",
    "runs",
    "find",
    "todos",
    "memory",
    "stats",
    "cost",
    "usage",
    "keybindings",
    "help",
    "diff",
  ],
  writing: [
    "edit",
    "document",
    "undo",
    "approval",
    "approve",
    "deny",
    "compact",
    "refine",
    "rewrite",
    "expand",
    "export",
  ],
  running: [
    "queue",
    "cancel",
    "stop",
    "retry",
    "branch",
    "rewind",
    "recovery",
    "verify",
    "attest",
    "conformance",
  ],
  watching: [
    "status",
    "health",
    "policy",
    "permissions",
    "mcp",
    "doctor",
    "tools",
    "models",
    "agents",
    "config",
    "settings",
    "themes",
  ],
  sharing: [
    "projects",
    "project",
    "project-file",
    "agent-file",
    "hook",
    "hook-file",
    "hooks",
    "connector-file",
    "test-connector",
    "policy-file",
  ],
  configuring: [
    "model",
    "connect",
    "login",
    "logout",
    "providers",
    "harness",
    "theme",
    "vim",
    "terminal-setup",
    "output-style",
    "init",
    "agent",
  ],
};
/** Which group each command belongs to, for the handful that do not match. */
const COMMAND_GROUPS: Record<string, string> = {
  chat: "starting",
  plan: "writing",
  open: "reading",
  rename: "sharing",
  sources: "reading",
  harness: "configuring",
  agent: "configuring",
  command: "starting",
};
function helpLines(width: number): string[] {
  const commands = TUI_COMMANDS.length;
  return renderInspector(
    {
      title: "NOMO",
      subtitle: "real local data, no demo metrics",
      icon: ROW_ICONS.harness,
      sections: [
        {
          title: "working",
          fields: [
            {
              label: "chat",
              value:
                "Type to send; Enter sends; Shift+Enter adds a line. PgUp/PgDn scroll; Up/Down browse one-line history.",
            },
            {
              label: "selection",
              value:
                "Escape returns to Chat; Enter opens or inspects the selected row; y/n decides after review.",
            },
            {
              label: "paste",
              value:
                "Paste focuses the composer. Control characters are removed.",
            },
            {
              label: "commands",
              value: "/ opens them, arrows select, Tab completes",
            },
            {
              label: "subagents",
              value: "/subagent cancel|review for verified spawned children",
            },
            {
              label: "palette",
              value: `/ opens command suggestions; /command-palette opens a searchable list of ${commands} commands`,
            },
            {
              label: "shortcuts",
              value: "/keybindings, searchable by key or by action",
            },
            {
              label: "panels",
              value:
                "Escape returns to Chat; Up/Down selects; Enter opens rows or toggles groups; Left/Right pages a tree.",
            },
            {
              label: "mode",
              value: "Shift+Tab: normal, accept, plan",
            },
            {
              label: "scroll",
              value: "PgUp/PgDn, or /bottom to follow the latest",
            },
            {
              label: "stop",
              value:
                "Esc closes a picker, review or detail, clears a filter, or stops the selected run",
              tone: "warning",
            },
          ],
        },
        {
          title: "modes that change what a key does",
          fields: [
            {
              label: "normal",
              value: "Every action asks before it changes anything",
            },
            {
              label: "accept",
              value: "Edit keys are shortened. Tool approvals stay explicit.",
            },
            {
              label: "plan",
              value: "Prompts are prefixed so the model plans before acting",
            },
          ],
        },
        {
          title: "things that are not here",
          fields: [
            {
              label: "no equivalent",
              value:
                "background tasks, clipboard paste/image attachment, live voice, speech input, Vim editing, /hooks, /vim",
              tone: "muted",
            },
          ],
        },
        {
          title: "guarantees",
          fields: [],
          body: [
            "Revision conflicts never overwrite changes.",
            "Undo and approvals require an explicit confirmation.",
            "Branches copy text and documents; tools are never replayed.",
            "The free model is never silently replaced with a paid one.",
            "Exports use 0600 and never overwrite an existing file.",
            "Data is encrypted in NOMO_DATA_DIR, default ~/.nomo/workbench.",
            "The local TUI never reads private cloud conversations.",
          ],
        },
        {
          title: "environment",
          fields: [
            {
              label: "color",
              value:
                "NO_COLOR disables colour; NOMO_TUI_COLOR=0 keeps output monochrome",
            },
            {
              label: "motion",
              value: "NOMO_TUI_MOTION=0 freezes animation",
            },
            {
              label: "editor",
              value: 'NOMO_TUI_EDITOR is a JSON array, e.g. ["code","--wait"]',
            },
            {
              label: "fallback",
              value:
                "Otherwise EDITOR, default nano. Confirm edits in the TUI.",
            },
          ],
        },
      ],
      hint: "Type / for commands; press ? with an empty Chat composer to open this view.",
    },
    { width },
  );
}

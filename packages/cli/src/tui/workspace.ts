import { ProxyWorkspace } from "./workspace-proxy.ts";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { promisify } from "node:util";
import { resolveConfig } from "../config.ts";
import {
  Workbench,
  DEFAULT_POLICY,
  type SessionEvent,
} from "../../../workbench/src/index.ts";
import { activity, type ViewName } from "../../../workbench/src/gui.ts";
import { PROVIDER_PRESETS } from "../../../workbench/src/provider-defaults.ts";
import { canonicalJson } from "../../../ledger/src/canonical.ts";
import type { JsonlEntry } from "../../../ledger/src/store.ts";
import { mineLearnedRules } from "../../../workbench/src/learned-rules.ts";
import { harnessScoreRows } from "./harness-score-rows.ts";
import { harnessProposalRows } from "./harness-proposal-rows.ts";

import { harnessSettingsView } from "../../../workbench/src/harness-settings.ts";
import {
  verificationKeyNote,
  verificationStatus,
} from "../../../ledger/src/verify-key.ts";
import {
  importDesktopProvider,
  desktopSetup,
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
  paintWithPalette,
} from "./theme.ts";
import { brandHeader } from "./brand.ts";
import { runDoctorCommand } from "../doctor.ts";
import { runInitCommand } from "../init.ts";
import { runConformanceCommand } from "../conformance.ts";
import {
  fit,
  pad,
  renderHunkSelection,
  sanitizeText,
  splitDiffHunks,
  unifiedDiff,
  visibleLength,
} from "./layout.ts";
import { detectCapabilities } from "./caps.ts";
import { renderShortcutLegend } from "./shortcuts.ts";
import {
  advanceSelection as advancePaletteSelection,
  backspaceInPalette,
  filterPalette,
  initialPaletteState,
  paletteFromCommands,
  renderPalette,
  typeInPalette,
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
  completionRing,
  cursorMarker,
  idleBreath,
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
import { barChart, deltaLabel, gauge, sparkline } from "./charts.ts";
import {
  buildDiffView,
  moveHunk,
  renderDiffPanel,
  setSide,
  toggleHunk,
  type DiffViewState,
} from "./diff-panel.ts";
import { renderInspector } from "./inspector.ts";
import { roleIcon } from "./blocks.ts";
import {
  filterTools,
  toolRows,
  toolSchemaLines,
  type ToolSummary,
} from "./tool-browser.ts";
import { renderRecovery, type RecoveryRow } from "./recovery-view.ts";
import {
  healthSummary,
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
import { buildTimeline, renderTimeline } from "./run-timeline.ts";
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
] as const;
export type WorkspaceTab = (typeof WORKSPACE_TABS)[number];
export const WORKSPACE_VIEWS = {
  overview: "runs",
  chat: "chat",
  sessions: "sessions",
  documents: "documents",
  ledger: "ledger",
  approvals: "approvals",
  policy: null,
  tools: "tools",
  models: "models",
  usage: "models",
  help: null,
} as const satisfies Record<WorkspaceTab, ViewName | null>;
export function workspaceTab(value: string): WorkspaceTab | undefined {
  if (value === "runs") return "overview";
  return WORKSPACE_TABS.includes(value as WorkspaceTab)
    ? (value as WorkspaceTab)
    : undefined;
}
type Item = {
  id: string;
  label: string;
  lines: string[];
  sessionId?: string;
  path?: string;
  operationId?: string;
  digest?: string;
  /**
   * What kind of record this is, used to group a tab that mixes several.
   * The ledger tab holds signed entries, proxy entries, mined rules, harness
   * scores, proposals, hooks and agents in one list, and a reader scanning it
   * for a refusal was stepping over four other kinds to get there.
   */
  kind?:
    | "entry"
    | "proxy"
    | "learned"
    | "score"
    | "proposal"
    | "harness"
    | "hook"
    | "agent"
    | "verification";
  /** The raw hold behind an approval row, kept only so the list can order by
   * severity. It is not rendered: the label and the lines carry everything. */
  hold?: {
    status: string;
    expiresAt: number;
    call: { tool: string; klass?: string; blastRadius?: number };
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
    source?: string;
  };
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
    expiresAt: number;
    call: {
      tool: string;
      klass?: string;
      blastRadius?: number;
      reason?: string;
    };
  },
  raw: readonly string[],
): string[] {
  const radius =
    hold.call.blastRadius === undefined
      ? "unknown"
      : String(hold.call.blastRadius);
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
              value: Number.isFinite(hold.expiresAt)
                ? new Date(hold.expiresAt).toISOString()
                : "never",
              tone: "muted",
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
      hint: "y or a approves, n or d denies, Esc cancels.",
    },
    { width: 76 },
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
 * The order is the order an operator reasons in: what was signed, then what
 * the chain taught, then the machinery that produced it. Signed entries come
 * first because they are the only ones that are evidence of anything.
 */
const LEDGER_GROUP_ORDER = [
  "verification",
  "entry",
  "proxy",
  "learned",
  "proposal",
  "score",
  "harness",
  "agent",
  "hook",
] as const;

const LEDGER_GROUP_TITLE: Record<string, string> = {
  verification: "VERIFICATION",
  entry: "SIGNED ENTRIES",
  proxy: "PROXY ENTRIES",
  learned: "LEARNED FROM THE CHAIN",
  proposal: "PROPOSALS WAITING",
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
  proposal: "◉",
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
 * A hold with no deadline gets nothing: that means the server sent no
 * deadline, not that it never closes. A hold already past its deadline says
 * so in a word, because "0s left" reads like a value that is about to change.
 */
function expirySuffix(hold: { expiresAt?: number }, now: number): string {
  const left = holdSecondsLeft(hold, now);
  if (left === null) return "";
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

/** The group a conversation is filed under on the sessions tab.
 *
 * Archived conversations get their own group rather than being mixed into a
 * status: an archived conversation is not idle, it was put away on purpose,
 * and a list that hides the distinction will have somebody re-open one and
 * wonder why it did not continue.
 */
function sessionGroup(status: string, archived: boolean): string {
  if (archived) return "archived";
  const key = status.toLowerCase();
  if (key.includes("run") || key.includes("active")) return "running";
  if (key.includes("fail") || key.includes("error")) return "failed";
  if (key.includes("queue") || key.includes("pending")) return "queued";
  // "idle" is what a settled conversation that nobody is looking at reports.
  // Filing it under other would put every finished conversation in a bucket
  // named after the states that are not happening.
  if (key.includes("idle") || key.includes("settl") || key.includes("done"))
    return "settled";
  if (key.includes("complet") || key.includes("archiv")) return "settled";
  return "other";
}

/** One line banner for the oldest pending hold, pinned above every tab so
 * an approval is never hidden behind a panel switch. The status bar badge
 * keeps the count; this banner keeps the decision and its keys. */
export function approvalBannerLines(
  holds: readonly {
    readonly holdId: string;
    readonly call: { readonly tool: string; readonly klass?: string };
  }[],
  width: number,
): string[] {
  if (!holds.length) return [];
  const first = holds[0]!;
  const klass = first.call.klass ? ` [${first.call.klass.toUpperCase()}]` : "";
  const rest =
    holds.length > 1
      ? ` (+${holds.length - 1} more, /approvals)`
      : " (/approvals)";
  return [
    fit(
      sanitizeText(
        `[!] APPROVAL PENDING${klass} ${first.call.tool} ${first.holdId.slice(0, 8)} | [a] approve [d] deny${rest}`,
      ),
      width,
    ),
  ];
}

/** The TUI mode is a local prompt prefix only. No server readiness channel
 * exists behind this UI yet, so the label always says local only, the same
 * way the control plane labels an unenforced preset. */
export function modeAuthorityLabel(mode: TuiMode): string {
  return `mode: ${mode} (local only, not enforced)`;
}

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
    `tool           ${sanitizeText(tool)}`,
    `class          ${sanitizeText(klass)}`,
    `blast radius   ${sanitizeText(radius)}`,
    `matched rule   ${sanitizeText(ruleIndex)}`,
    `precondition   ${sanitizeText(precondition)}`,
    `postcondition  ${sanitizeText(postcondition)}`,
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

/** Tabs where typing filters the list, like a finder. Chat, overview,
 * policy text and help take no filter; every other tab lists items. */
const FILTER_TABS: readonly WorkspaceTab[] = [
  "sessions",
  "documents",
  "ledger",
  "approvals",
  "policy",
  "tools",
  "models",
  "usage",
];

/** Navigation keys keep their action; any other printable character filters.
 * Returns the character to append, or undefined when the key stays bound. */
export function filterKeyForTab(
  value: string | undefined,
  key: { name?: string; ctrl?: boolean; meta?: boolean },
  tab: WorkspaceTab,
): string | undefined {
  if (!FILTER_TABS.includes(tab)) return undefined;
  if (!value || [...value].length !== 1 || key.ctrl || key.meta)
    return undefined;
  if (/[\x00-\x1f\x7f-\x9f]/.test(value)) return undefined;
  if (
    [
      "q",
      "i",
      "n",
      "u",
      "a",
      "d",
      "r",
      "?",
      "j",
      "k",
      "/",
      "!",
      "{",
      "}",
    ].includes(value)
  )
    return undefined;
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

/** Checklist items are read from real messages, never invented. */
export interface TuiTodo {
  readonly done: boolean;
  readonly text: string;
  readonly seq: number;
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
    if (event.type && event.type !== "message.completed") continue;
    if (event.kind !== "assistant" && event.kind !== "user") continue;
    for (const line of event.text.split("\n")) {
      const found = /^\s*[-*]\s*\[( |x|X)\]\s+(.+)$/.exec(line);
      if (found)
        out.push({
          done: found[1] !== " ",
          text: found[2]!.trim().slice(0, 200),
          seq: event.seq,
        });
    }
  }
  return out;
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

/** Same persistent workbench as the web. Rendering never grants tool authority. */
export class WorkspaceTui {
  readonly workbench: Workbench;
  readonly proxy: ProxyWorkspace;
  readonly env: Readonly<NodeJS.ProcessEnv>;
  tab: WorkspaceTab = "overview";
  selected = 0;
  scroll = 0;
  viewport = { offset: 0, height: 1, total: 0 };
  /** Viewport offsets of user prompt rows, for { and } jumps. */
  promptRows: number[] = [];
  sessionId?: string;
  documentPath?: string;
  projectId?: string;
  agentId?: string;
  lastRecoveryJob?: { sessionId: string; jobId: string };
  model = "";
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
  compactTools = true;
  mode: TuiMode = "normal";
  /** Runtime theme overrides. Undefined keeps the NOMO_TUI_* environment. */
  colorOverride?: boolean;
  motionOverride?: boolean;
  themeConfig: ThemeConfig;
  queuedPrompt: string | null = null;
  queuedPromptPaused = false;
  /** Live command palette. Present means the overlay owns the keyboard. */
  palette?: PaletteState;
  /** The typed prefix Ctrl+P carried into the palette, consumed on open. */
  pendingPaletteQuery?: string;
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
  notice = "Tab: panels | i: type | /help: commands";
  detail?: string[];
  confirmation?: Confirmation;
  private branchIntent?: {
    sessionId: string;
    seq: number;
    command: "branch" | "retry";
    key: string;
  };
  provider?: Awaited<ReturnType<Workbench["providerState"]>>;
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
  constructor(
    workbench: Workbench,
    env: Readonly<NodeJS.ProcessEnv> = process.env,
  ) {
    this.workbench = workbench;
    this.env = env;
    this.proxy = new ProxyWorkspace(env);
    this.themeConfig = getThemeConfig(env);
  }
  async initialize() {
    try {
      this.provider = await this.workbench.providerState();
      this.model = this.provider.defaultModel ?? "";
    } catch (error) {
      this.notice = message(error);
    }
    await this.refresh(true);
  }
  async refresh(force = false) {
    await this.proxy.refresh(force);
    const stamp = this.workbench
      .allViews()
      .map((s) => `${s.id}:${s.events.at(-1)?.seq}:${s.status}`)
      .join("|");
    if (!force && stamp === this.proofStamp) return;
    this.proofStamp = stamp;
    this.provider = await this.workbench.providerState();
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
    this.selected = Math.min(
      this.selected,
      Math.max(0, this.items().length - 1),
    );
  }
  choose(tab: WorkspaceTab) {
    this.tab = tab;
    this.selected = 0;
    this.scroll = tab === "chat" ? -1 : 0;
    this.detail = undefined;
    // Cleared here rather than at each of the other five places that drop the
    // detail view, because a stale flag would make ordinary typing filter a
    // table that is no longer on screen.
    this.keybindingDetail = false;
    // Same reason, same hazard: the sheet is filtered by ordinary typing, so a
    // flag left set after the panel changed would eat every letter typed next.
    this.cheatSheet = false;
    this.cheatQuery = "";
    // The tree belongs to the documents tab. Left on elsewhere it would let
    // the arrow keys collapse a folder the operator is not even looking at.
    this.groupTree = undefined;
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
  cycleMode() {
    const next =
      TUI_MODES[(TUI_MODES.indexOf(this.mode) + 1) % TUI_MODES.length]!;
    this.mode = next;
    this.notice =
      next === "plan"
        ? "Plan mode. Prompts ask for a plan before any tool runs."
        : next === "accept"
          ? "Accept mode. Shorter edit keys, approvals stay explicit."
          : "Normal mode. Every change and approval needs your key.";
  }
  queuePrompt(value: string | undefined) {
    this.queuedPromptPaused = false;
    if (value === undefined) {
      this.queuedPrompt = null;
      this.notice = "Queued prompt cancelled.";
      return;
    }
    this.queuedPrompt = value.slice(0, 32000);
    this.notice =
      "Run is active. The prompt is queued and sends when it stops.";
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
      add(
        "provider",
        "runtime",
        connected ? "ok" : "fail",
        connected
          ? `Connected to ${this.provider.providerId ?? "a provider"}.`
          : "No provider is connected.",
        connected ? undefined : "Run /connect to attach one.",
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
   * Fold or unfold the folder under the cursor in the documents tree.
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
  /**
   * Move the documents tree cursor. Returns false when there is no tree, so
   * the caller falls back to moving through the flat item list.
   *
   * The cursor clamps against the flattened visible list, not the full tree,
   * so moving after a collapse cannot land on a row that is no longer there.
   */
  moveDocumentCursor(delta: number): boolean {
    const tree = this.groupTree;
    if (!tree) return false;
    tree.state = moveTree(tree.state, delta, tree.nodes);
    // The selected row in the flat list follows the cursor, so Enter opens
    // whatever the tree is pointing at rather than whatever it pointed at
    // before the tree was folded.
    this.selected = Math.max(0, this.selected);
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
      running: this.workbench.running(),
      reviewing: !!this.diffView || !!this.confirmation,
    });
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
          return `${path} [binární soubor - capability check required]`;
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
      ...renderDiffPanel(this.diffView, 76, 24),
      "",
      "/diff-next steps to the next outstanding operation.",
      "/undo ID for reviewed Undo of one operation.",
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
    if (totals.length > 1)
      lines.push(
        `tokens per run  ${sparkline({ values: totals }, 40)}`,
        "  sparkline scaled to the series, not to zero",
        "",
      );
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
        ...barChart({ values: totals.slice(-10) }, 68).map((row) => "  " + row),
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
   * The overview pane is a fixed height frame, and a twelve row inspector in
   * the middle of it pushed the run counts off the bottom. The full inspector
   * belongs to /status, where the provider is the subject; here it only has to
   * be findable, which one line with the state word in it achieves.
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
        { width: 76 },
      ),
    ];
  }
  statusLines() {
    const session = this.session();
    const ctx = session ? this.contextNumbers() : null;
    const runs = this.workbench
      .runs()
      .filter((run) => run.sessionId === this.sessionId);
    const run =
      runs.find((item) => item.runId === session?.runId) ?? runs.at(-1);
    return [
      ...this.providerLines(),
      `model: ${this.session()?.model || this.model || "-"} | ${modeAuthorityLabel(this.mode)}`,
      `State: ${run?.state ?? "unknown"}${run?.reconcileRequired ? " | reconciliation required" : ""}`,
      `Run: ${run?.state ?? "unavailable"}${run?.reconcileRequired ? " | reconciliation required" : ""}`,
      ctx
        ? `Context messages: ${ctx.contextMessages ?? "unknown"} | transcript: ${ctx.messages} | ` +
          `cumulative provider tokens: ${ctx.tokens ?? "unknown"} | cost: unknown`
        : "No conversation selected.",
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
        { width: 76 },
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
              `${stateIcon(item.status)} [${item.status}] ${item.title ?? item.id} ${item.id.slice(0, 8)} ${item.model}`,
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
        { width: 76 },
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
  settingsLines() {
    return [
      "HARNESS SETTINGS, limits this workspace runs under",
      "",
      ...harnessSettingsView(this.workbench.harnessSettings()).flatMap(
        (row) => [
          `${row.icon} ${row.key}  ${row.value}  [${row.min}-${row.max}]${row.changed ? "  (changed)" : ""}`,
          `  ${row.label}: ${row.description}`,
          `  read by ${row.consumer}`,
        ],
      ),
      "",
      "/settings KEY VALUE sets one limit; the range is what the run path can honour.",
    ];
  }
  session() {
    return this.sessionId ? this.workbench.get(this.sessionId) : undefined;
  }
  private useSession(id: string) {
    if (!this.workbench.get(id)) throw Error("Conversation not found.");
    this.sessionId = id;
    this.documentPath = undefined;
  }
  items(): Item[] {
    let rows: Item[] = [];
    if (this.tab === "overview")
      rows = [...this.workbench.runs()].reverse().map((run) => ({
        id: run.id,
        sessionId: run.sessionId,
        // An unknown outcome is the one case where the glyph has to agree with
        // the word beside it. A failed run and a run whose result was never
        // observed look identical as a dot, and only one of them is safe to
        // keep building on.
        label: `${run.reconcileRequired ? ROW_ICONS.unknown : stateIcon(run.state)} [${run.state}] ${run.model} ${run.sessionId.slice(0, 8)} | progress ${run.progress === null ? "unknown" : `${Math.round(run.progress * 100)}%`}${run.reconcileRequired ? " | reconciliation required" : ""}`,
        lines: [
          "RUN",
          ...json(run),
          "",
          "/stop requests a stop for this conversation. /chat opens its messages.",
          ...(run.reconcileRequired
            ? ["Outcome unknown. Reconcile before starting any further action."]
            : []),
        ],
      }));
    if (this.tab === "sessions")
      rows = [...this.workbench.list()].reverse().map((s) => ({
        id: s.id,
        sessionId: s.id,
        label: `${s.archived ? ROW_ICONS.archived : stateIcon(s.status)} [${s.status}] ${s.title ?? s.id}${s.archived ? " [archived]" : ""}`,
        lines: json(s),
      }));
    if (this.tab === "documents")
      rows = this.workbench.documentsList().map((d) => ({
        id: `${d.sessionId}:${d.path}`,
        sessionId: d.sessionId,
        path: d.path,
        label: `${ROW_ICONS.document} ${d.path}  ${d.bytes} B  ${d.sessionId.slice(0, 8)}`,
        lines: json(d),
      }));
    // The document and session lists are grouped for reading, but the rows
    // stay flat underneath so selecting, filtering and opening still index
    // into one list. Two parallel lists would mean the row the operator
    // selected and the row Enter opens could drift apart.
    if (
      !this.groupTree &&
      (this.tab === "documents" || this.tab === "sessions")
    ) {
      const nodes =
        this.tab === "documents"
          ? buildDocumentTree(
              this.workbench.documentsList().map((d) => ({
                id: `${d.sessionId}:${d.path}`,
                path: d.path,
                detail: `${d.bytes} B`,
                kind: "document",
              })),
            )
          : buildSessionTree(
              this.workbench.list().map((s) => ({
                id: s.id,
                // Conversations have no folder structure worth inventing, so
                // the useful cut is by state: what is still running, what
                // settled, what failed.
                path: s.title ?? s.id,
                detail: `${s.id.slice(0, 8)} ${s.model}`,
                kind: sessionGroup(s.status, s.archived === true),
              })),
            );
      this.groupTree = { nodes, state: initialTreeState(nodes) };
    }
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
            label: `${ROW_ICONS.ledgerEntry} ${id.slice(0, 8)} #${e.seq} [${text(b.klass)}] ${text(b.decision)} ${text(b.tool)}`,
            lines: [
              this.managedVerificationStatus === undefined
                ? "[OK] Hash chain and signature verified"
                : `[OK] Hash chain and signature verified — ${this.managedVerificationStatus}`,
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
            label: `${ROW_ICONS.proxyEntry} proxy:${workspace} #${e.seq} [${text(b.klass)}] ${text(b.decision)} ${text(b.tool)}`,
            lines: [
              this.proxy.signed
                ? `[OK] Proxy signatures and hash chain verified — ${this.proxy.verificationStatus}`
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
                : `[OK] Mined from the verified chain — ${this.managedVerificationStatus}`,
              ...(this.managedVerificationNote === undefined
                ? []
                : [`Verification key: ${this.managedVerificationNote}`]),
              rule.rationale ?? "",
              "A learned rule is evidence, not authority: it is appended after the operator's own rules, so it can only fill a gap they left open.",
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
      for (const score of harnessScoreRows(this.proofs))
        rows.push({ ...score, kind: "score" });
      // The ring closes as the chain verifies. Its shape reports how far the
      // check got, so an operator can see progress without reading a count,
      // and the word beside it stays authoritative.
      {
        const total = [...this.proofs.values()].reduce(
          (sum, entries) => sum + entries.length,
          0,
        );
        const failed = this.proofErrors.size + this.proxy.errors.length;
        const ok = Math.max(0, total - failed);
        rows.push({
          id: "ledger:verification",
          kind: "verification",
          label: `${completionRing(ok, Math.max(1, total), motionContext(this.frame))} ${ok} of ${total} ledger entries verified`,
          lines: [
            failed
              ? `${failed} entries could not be verified.`
              : "Every entry in the chain verified.",
            "The ring is the shape of the check, not a score.",
          ],
        });
      }
      // Prompt proposals waiting on this operator: the exact diff and its
      // provenance, inspectable with Enter like every other row. Approval
      // itself stays an explicit command naming the digest, never a side
      // effect of looking.
      for (const proposal of harnessProposalRows(this.proofs))
        rows.push({
          ...proposal,
          kind: "proposal",
          sessionId: proposal.id.split(":")[1],
        });
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
            // detail first. A hold with no deadline prints nothing: that
            // means the server sent no deadline, not that it never closes.
            label:
              expirySuffix(h, Date.now()) +
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
          label: `${ROW_ICONS.approval} [proxy pending] ${h.call.tool} ${h.holdId}`,
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
              76,
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
    if (this.tab === "models")
      rows = (this.provider?.models ?? []).map((m) => ({
        id: m.id,
        // The [*] marker is what says which model new conversations get. The
        // glyph in front is only a shape to scan by; the marker stays.
        label: `${ROW_ICONS.model} ${m.id === this.model ? "[*]" : "[ ]"} ${m.name}  ${m.id}`,
        lines: json(m),
      }));
    if (this.tab === "usage")
      rows = activity(this.workbench.allViews()).usage.map((r) => ({
        id: r.id,
        sessionId: r.sessionId,
        label: `${ROW_ICONS.ledgerEntry} ${r.model} ${r.sessionId.slice(0, 8)} | tokens ${r.totalTokens ?? "unknown"} | cost unknown`,
        // The row's own numbers stay on the row. The detail repeats them in a
        // readable block rather than leaving the operator to find them inside
        // a JSON dump, which is where they used to be.
        usage: r,
        lines: json(r),
      }));
    return this.filter
      ? rows.filter((r) =>
          `${r.label} ${r.lines.join(" ")}`
            .toLowerCase()
            .includes(this.filter.toLowerCase()),
        )
      : rows;
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
    if (this.tab === "overview") {
      this.useSession(row.sessionId!);
      this.detail = row.lines;
      this.scroll = 0;
      return;
    }
    // A session row is the conversation, so Enter goes to it. A usage row is
    // not: the operator is on the spend tab to read spend, and jumping to the
    // transcript would leave the question they arrived with unanswered and
    // make them come back to ask it a second time. It inspects instead, the
    // same way a model row does.
    if (this.tab === "sessions") {
      this.useSession(row.sessionId!);
      this.choose("chat");
      return;
    }
    if (this.tab === "documents") {
      this.useSession(row.sessionId!);
      this.documentPath = row.path;
      this.showDocument();
      return;
    }
    // An approval is the one row where Enter should read as "show me what I
    // am about to decide", not as raw JSON. The hold is already carried on the
    // row for ordering, so this reads the same object the list sorted by.
    if (this.tab === "approvals" && row.hold) {
      this.detail = approvalInspectLines(row.hold, row.lines);
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
          { width: 76 },
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
          { width: 76 },
        ),
        "",
        "RAW RECORD",
        ...row.lines,
      ];
      this.scroll = 0;
      return;
    }
    if (this.tab === "models") {
      // Enter inspects rather than selects. Choosing a model changes what
      // every future conversation runs on, and doing that from a list row
      // with no second look was the one irreversible action on this tab.
      // /model <id> stays the way to choose, and it names the model.
      const model = (this.provider?.models ?? []).find((m) => m.id === row.id);
      this.detail = model
        ? [
            ...renderInspector(
              {
                title: model.name || model.id,
                subtitle: model.id,
                icon: ROW_ICONS.model,
                sections: [
                  {
                    title: "model",
                    fields: [
                      {
                        label: "id",
                        value: model.id,
                        tone: "muted",
                      },
                      {
                        label: "selected",
                        value:
                          model.id === this.model
                            ? "yes, new conversations use this"
                            : "no, /model " + model.id + " selects it",
                        tone: model.id === this.model ? "success" : "default",
                      },
                      {
                        label: "in use by",
                        value: this.conversationsOnModel(model.id),
                      },
                    ],
                  },
                ],
                hint: "/model ID selects it for new conversations.",
              },
              { width: 76 },
            ),
            "",
            "RAW RECORD",
            ...row.lines,
          ]
        : row.lines;
      this.scroll = 0;
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
        { width: 76 },
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
    if (!hold)
      throw Error("Approval is no longer active. Refresh the overview.");
    const review = this.approvalReviewLines(
      hold as Parameters<typeof approvalReview>[0],
    );
    this.confirmation = {
      title: `${kind === "approved" ? "APPROVE" : "DENY"} TOOL?`,
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
          "Decision accepted. Check the ledger for tool completion.";
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
      "CONNECTORS, only confirmed ones give a conversation tools",
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
      fit(headline, 76),
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
    this.choose("policy");
    const space = arg.indexOf(" "),
      verb = (space < 0 ? arg : arg.slice(0, space)).toLowerCase(),
      rest = space < 0 ? "" : arg.slice(space + 1).trim(),
      // rename carries a second argument, so its id is only the first token.
      id = (verb === "rename" ? (rest.split(" ")[0] ?? "") : rest).trim();
    if (!verb) {
      this.detail = this.connectorList();
      this.scroll = 0;
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
    const tab = workspaceTab(cmd);
    if (tab) {
      this.choose(tab);
      this.filter = arg;
      return;
    }
    if (cmd === "expand") {
      this.compactTools = !this.compactTools;
      this.notice = this.compactTools
        ? "Compact tool output. /expand shows full results."
        : "Full tool output. /expand collapses results.";
      return;
    }
    if (cmd === "quit" || cmd === "exit") return "quit";
    if (cmd === "cancel") {
      this.queuePrompt(undefined);
      this.notice = "Queued prompt cancelled.";
      return;
    }
    if (cmd === "plan") {
      this.mode = "plan";
      this.notice = "Plan mode. Prompts ask for a plan before any tool runs.";
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
    if (cmd === "keybindings") {
      this.keybindingQuery = arg ?? "";
      this.keybindingDetail = true;
      this.detail = keybindingLines(this.keybindingQuery, 72);
      this.scroll = 0;
      return;
    }
    if (cmd === "theme") {
      // /theme [color-theme] [symbol-preset] | list | preview | reset
      // Session override only. Lasting choice stays in the environment
      // (NOMO_TUI_THEME, NOMO_TUI_SYMBOLS). A checked-out repo never
      // restyles another operator.
      const themes = Object.keys(COLOR_THEMES) as ColorTheme[];
      const symbols = Object.keys(SYMBOL_SETS) as SymbolPreset[];

      if (!arg) {
        this.detail = [
          `THEME: ${this.themeConfig.colorTheme} + ${this.themeConfig.symbolPreset}`,
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
          "Usage: /theme <color-theme> [symbol-preset] | preview <color-theme> [symbol-preset] | list | reset",
          "Examples: /theme paper unicode  |  /theme dark  |  /theme preview solarized-dark classic",
          "Persist: NOMO_TUI_THEME=<color> NOMO_TUI_SYMBOLS=<preset> in your shell rc.",
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
        this.notice = `Preview: ${color} + ${symbol}. Press Enter to keep, /theme reset to revert.`;
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
      this.notice = `Theme set: ${this.themeConfig.colorTheme} + ${this.themeConfig.symbolPreset}. Set NOMO_TUI_THEME and NOMO_TUI_SYMBOLS to persist.`;
      this.scroll = 0;
      return;
    }
    if (cmd === "status") {
      this.choose("overview");
      this.detail = [...this.statusLines(), "", ...this.healthLines()];
      this.scroll = 0;
      return;
    }
    if (cmd === "health") {
      this.choose("overview");
      this.detail = this.healthLines();
      this.scroll = 0;
      return;
    }
    if (cmd === "discover") {
      this.choose("help");
      this.detail = discoverLines();
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
    if (cmd === "mcp") {
      await this.mcpCommand(arg);
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
      this.choose("overview");
      const queued = this.queuedPrompt;
      this.detail = [
        "QUEUED PROMPT",
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
      const todos = extractTodos(session.events);
      const open = todos.filter((item) => !item.done).length;
      this.detail = [
        `TODOS from real agent output, ${open} open of ${todos.length}`,
        "",
        ...(todos.length
          ? todos.map(
              (item) =>
                `${item.done ? "[x]" : "[ ]"} ${item.text} (#${item.seq})`,
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
        "operator's own rules, so it can only fill a gap they left open.",
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
        this.detail = this.settingsLines();
        this.scroll = 0;
        return;
      }
      if (raw === undefined)
        throw Error("/settings key value, or /settings alone to list them.");
      // Number() turns a typo into NaN and an empty field into 0, and the
      // server clamp would then store the minimum as though the operator had
      // chosen it, so the value is proved numeric here before the patch sees it.
      const value = Number(raw);
      if (!Number.isFinite(value))
        throw Error(`/settings ${key}: ${raw} is not a number.`);
      const stored = this.workbench.patchHarnessSettings({ [key]: value });
      // Read back from the resolved set rather than echoing the argument: the
      // server clamps, so the number that takes effect may not be the number
      // that was typed, and a notice naming the wrong one would be a lie.
      const applied = harnessSettingsView(stored).find(
        (row) => row.key === key,
      );
      this.notice = `${applied?.label ?? key} is now ${applied?.value ?? value}.`;
      this.detail = this.settingsLines();
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
        this.notice = "Select a conversation and press Enter to resume.";
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
      this.workbench.clearProvider();
      this.provider = await this.workbench.providerState();
      this.model = "";
      this.notice =
        "Logged out locally. Saved provider profiles were removed; revoke keys with their providers.";
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
    if (cmd === "stop") {
      if (!this.sessionId) throw Error("Select a running conversation.");
      this.workbench.stopRun(this.sessionId);
      this.notice =
        "Stop requested. A dispatched tool may still complete; /runs shows the confirmed state.";
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
      if (!this.provider?.models.some((m) => m.id === arg))
        throw Error("Select an ID from /models.");
      this.model = arg;
      this.notice = `Model for new conversations: ${arg}`;
      return;
    }
    if (cmd === "connect" || cmd === "login") {
      if (!arg || arg === "nvidia") {
        this.provider = await this.workbench.providerState({
          reconnectEnvironment: true,
        });
        this.detail = this.providerLines();
        this.notice =
          !this.provider.providerId || this.provider.providerId === "nvidia"
            ? "No provider is configured, so set NVIDIA_API_KEY in the host environment for the NVIDIA preset, or use /sources and /connect for an explicit local import. No key is accepted in chat."
            : "Current provider is unchanged. /sources lists explicit local imports; /connect source-ID selects one.";
        this.scroll = 0;
        return;
      }
      this.provider = await importDesktopProvider(
        arg,
        this.env,
        this.workbench,
      );
      this.model = this.provider.defaultModel ?? "";
      this.notice = `Connected to ${this.provider.providerId}. The key is stored encrypted.`;
      return;
    }
    if (cmd === "sources") {
      this.detail = json(await desktopSetup(this.env));
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
          ? `VERIFICATION FAILED. See the overview. ${standalone}`
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
    // both refuse an unknown digest rather than guessing.
    if (cmd === "refine") {
      const [sub, digest, ...reason] = arg.split(/\s+/);
      if ((sub === "approve" || sub === "reject") && !this.sessionId)
        throw Error("Select a conversation.");
      if (sub === "proposals" || sub === undefined || sub === "") {
        this.choose("ledger");
        this.filter = "proposal";
        return;
      }
      if (sub === "approve" && digest) {
        const result = await this.workbench.approveHarnessProposal(
          this.sessionId!,
          digest,
        );
        this.detail = [
          `REFINEMENT APPROVED ${digest.slice(0, 19)}`,
          `${result.applied.length} edit(s) activated.`,
          "Recorded on the signed chain; later sessions retrieve it.",
        ];
        this.notice = `Proposal approved: ${result.applied.length} edit(s) active.`;
        this.scroll = 0;
        return;
      }
      if (sub === "reject" && digest) {
        await this.workbench.rejectHarnessProposal(
          this.sessionId!,
          digest,
          reason.join(" "),
        );
        this.detail = [
          `REFINEMENT REJECTED ${digest.slice(0, 19)}`,
          "Recorded on the signed chain; nothing was activated.",
        ];
        this.notice = "Proposal rejected on the record.";
        this.scroll = 0;
        return;
      }
      throw Error(
        "/refine proposals | /refine approve <digest> | /refine reject <digest> [reason]",
      );
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
      this.detail = [
        "PROVIDERS, pick with /connect ID or /login",
        "",
        ...PROVIDER_PRESETS.map(
          (preset) =>
            `${preset.id === current ? "[*]" : "[ ]"} ${preset.id}  ${preset.name}` +
            ("local" in preset && preset.local
              ? "  (local, runs open models like Hermes)"
              : ""),
        ),
        "",
        "Local entries need Ollama or LM Studio running on this machine.",
        "Keys stay encrypted in local provider storage, never in the repo.",
      ];
      this.scroll = 0;
      return;
    }
    if (cmd === "harness") {
      // The setting is shared with the control plane. Detection only looks
      // at PATH presence; nothing is executed, so listing is always safe.
      if (arg && arg !== "cloud" && arg !== "prime-agent")
        throw Error("/harness cloud | prime-agent");
      if (arg) {
        this.workbench.patchPreferences({ defaultAgent: arg });
        this.notice =
          arg === "prime-agent"
            ? "Harness: prime-agent. New conversations route there when the bridge runs."
            : "Harness: cloud. New conversations run in the managed session.";
      }
      const prefs = this.workbench.getPreferences();
      const found = await detectHarnesses(this.env);
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
        "/harness cloud | /harness prime-agent switches the default.",
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
      // The palette is a live overlay, not a printed list. Opening it seeds
      // the query from whatever the operator already typed after Ctrl+P, so
      // the keystroke that summoned the palette narrows it immediately.
      const seed = this.pendingPaletteQuery ?? "";
      this.palette = initialPaletteState(paletteFromCommands(TUI_COMMANDS));
      if (seed) this.palette = typeInPalette(this.palette, seed);
      this.choose("help");
      this.detail = undefined;
      this.notice =
        "Palette: type to filter, Up/Down select, Enter run, Esc close.";
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
    const { offset, height, total } = this.viewport;
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
  lines(): string[] {
    if (this.confirmation)
      return [
        this.confirmation.title,
        "",
        ...this.confirmation.lines.flatMap((l) => l.split("\n")),
      ];
    if (this.detail) return this.detail;
    if (
      this.tab === "ledger" &&
      (this.proofErrors.size || this.proxy.errors.length)
    )
      return [
        ...this.proofErrors.values(),
        ...this.proxy.errors,
        "",
        ...this.listRows(),
      ];
    if (this.tab === "help") return helpLines();
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
      const browser = toolRows(shown, 76, {
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
        `TOOLS, ${summaries.length} available: ${classCounts}`,
        "",
        ...browser,
        "",
        this.filter
          ? `Filter: ${this.filter} (Esc clears, Backspace deletes)`
          : "Type to filter by name, class, source or description.",
        "Enter inspects a tool. Inspecting never executes it.",
      ];
    }
    if (this.tab === "chat")
      return this.session()
        ? [
            // The shape of the conversation before the words of it. An
            // operator opening a chat after an hour away wants to see where it
            // got to, and scrolling a wall of events to find that is the work
            // the strip is meant to remove.
            ...renderActivity(buildActivity(this.session()!.events), 76, {
              motion: motionContext(this.frame),
            }),
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
    if (this.tab === "overview") {
      const o = activity(this.workbench.allViews()).overview;
      const openTodos = this.sessionId
        ? extractTodos(this.session()?.events ?? []).filter(
            (item) => !item.done,
          )
        : [];
      const planLines = openTodos.length
        ? [
            "",
            "Plan, from real agent output (/todos for all):",
            ...openTodos
              .slice(0, 5)
              .map((item) => `[ ] ${item.text} (#${item.seq})`),
          ]
        : ["", "Plan: no open checklist items. /todos shows them all."];
      const holds = this.workbench.pending().length + this.proxy.holds.length;
      const errors = this.proofErrors.size + this.proxy.errors.length;
      // The overview answers "is anything wrong right now" before it answers
      // "what does this workspace contain". The counts were there; what was
      // missing was the order, so a workspace with three conversations and
      // one unverified chain looked identical to a quiet one.
      const attention = holds || errors || o.failed;
      return [
        "NOMO / LOCAL WORKSPACE",
        "",
        attention
          ? `${ROW_ICONS.approval} Needs attention: ${holds} approvals waiting, ${errors} errors, ${o.failed} failed runs.`
          : `${ROW_ICONS.settled} Nothing waiting. No approvals, no errors, no failed runs.`,
        "",
        this.providerSummary(),
        // The health verdict, as one line, before the numbers below it. An
        // operator reads the top of this panel and decides whether to keep
        // reading; a verdict four rows down is a verdict nobody gets to.
        healthSummary(this.healthChecks()),
        `Model: ${this.model || "-"} | ${this.workbench.running() ? "running or settling" : "idle"}`,
        // Where the selected conversation got to and when, in one sentence.
        // Recency is what an operator who was away actually wants, and it was
        // previously only available by scrolling for the last timestamp.
        ...(this.session()
          ? [activitySummary(buildActivity(this.session()!.events), Date.now())]
          : []),
        `Conversations ${this.workbench.list().length} | Documents ${this.workbench.documentsList().length} | Runs ${o.runs}`,
        // Which runs are live, named. The count says there is work; this says
        // which work, so an operator looking at a busy workspace knows where
        // to go rather than only that somewhere is busy.
        ...(this.workbench.running()
          ? [
              "Active:",
              ...[...this.workbench.runs()]
                .filter(
                  (run) =>
                    run.state === "running" ||
                    run.state === "stopping" ||
                    run.state === "paused" ||
                    run.state === "awaiting-approval",
                )
                .slice(0, 4)
                .map(
                  (run) =>
                    `  ${stateIcon(run.state)} ${run.sessionId.slice(0, 8)} ${run.model} / progress ${run.progress === null ? "unknown" : `${Math.round(run.progress * 100)}%`}${run.reconcileRequired ? " / reconcile first" : ""}`,
                ),
            ]
          : []),
        `Ledger ${[...this.proofs.values()].reduce((n, p) => n + p.length, 0)} managed + ${[...this.proxy.entries.values()].reduce((n, p) => n + p.length, 0)} proxy`,
        // The bare word "verified" is the defect the audit named here: it does
        // not say which key answered, so a chain checked against a trust file
        // the agent can also replace read the same as one checked against a
        // key the operator handed over. The status names the answer, and the
        // long caveat follows it on its own line.
        `Signatures: ${this.proxy.entries.size ? (this.proxy.signed ? this.proxy.verificationStatus : "NOT VERIFIED (integrity only)") : "no entries"}`,
        ...(this.proxy.entries.size && this.proxy.verificationNote
          ? [`Proxy verification key: ${this.proxy.verificationNote}`]
          : []),
        "",
        ...this.listRows(),
        `Provider tokens: ${o.totalTokens ?? "unknown"} | Cost: unknown`,
        ...planLines,
        "",
        "START: n new conversation, i type a prompt, Enter send.",
        "DOCUMENTS: Enter open, /edit edit, u preview Undo.",
        "CONTROL: ledger + approvals; /verify rechecks signatures.",
        "",
        "Managed documents are not files on your computer's disk.",
        "MCP tools require explicit connection and classification.",
        "External writes do not have automatic Undo.",
        `Proxy ledger: ${this.proxy.ledgerDir}`,
        `Proxy approvals: ${this.proxy.approvalDir}`,
        ...this.proxy.errors,
      ];
    }
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
          { width: 76 },
        ),
        "",
        "DEFAULT POLICY FOR EXTERNAL MCP",
        ...DEFAULT_POLICY.split("\n"),
        "",
        ...this.items().flatMap((r) => [r.label, ...r.lines, ""]),
      ];
    }
    const rows = this.items();
    // Documents group by folder and conversations by state, for the same</path>
    // reason: a flat list of forty rows cannot be scanned, and a group the
    // operator does not care about should be one keystroke to hide rather
    // than forty rows to scroll past.
    if (this.groupTree && rows.length) {
      // A folder tree answers "what is here". It does not answer "what
      // happened to it", so the recovery line sits under it rather than
      // replacing it. Two panes for one tab would mean the operator has to
      // choose which question to be able to ask at all.
      const openOps = this.recoveryRows().filter(
        (row) => row.recoverable === "recoverable",
      );
      return [
        ...renderTree(this.groupTree.nodes, this.groupTree.state, 76, 24, {
          motion: motionContext(this.frame),
        }),
        "",
        collapsedSummary(
          this.groupTree.state,
          this.groupTree.nodes,
          this.tab === "documents"
            ? { group: "folder", row: "document" }
            : { group: "group", row: "conversation" },
        ),
        ...(this.tab === "documents"
          ? [
              openOps.length
                ? `${openOps.length} of ${this.recoveryRows().length} changes can still be undone. /diff steps through them.`
                : "Every change has been decided: undone or kept.",
            ]
          : []),
        this.tab === "documents"
          ? "Left/Right collapse and expand a folder. Enter opens the document."
          : "Left/Right collapse and expand a group. Enter opens the conversation.",
      ];
    }
    // The tools tab is answered earlier, by the grouped browser, so the
    // /mcp hint that used to sit here has no tab left to attach to.
    // The models tab gets a hint of its own because Enter means something
    // different here than on every other list: it inspects rather than
    // selects.
    if (this.tab === "models" && rows.length) {
      const byProvider = new Map<string, number>();
      for (const row of rows) {
        const match = /\[([^\]]+)\]/.exec(row.label);
        const provider = match?.[1] ?? "unknown";
        byProvider.set(provider, (byProvider.get(provider) ?? 0) + 1);
      }
      const counts = [...byProvider.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([provider, count]) => `${count} ${provider}`)
        .join(", ");
      return [
        `MODELS, ${rows.length} available: ${counts}`,
        "",
        ...this.listRows(),
        "",
        "Enter inspects a model. /model ID selects it for new conversations.",
      ];
    }
    // The usage tab is one row per record, which answers "what happened" and
    // not "what did it cost me". Records arrive newest last, so the summary
    // leads with the shape and the list follows it.
    if (this.tab === "usage" && rows.length) {
      const known = rows
        .map((r) => /tokens (\d+)/.exec(r.label)?.[1])
        .filter((v): v is string => !!v)
        .map(Number);
      return [
        `USAGE, ${rows.length} records across ${new Set(rows.map((r) => r.sessionId)).size} conversations`,
        "",
        known.length
          ? `tokens, last ${Math.min(24, known.length)} records  ${sparkline({ values: known.slice(-24) }, 40)}`
          : "No token counts reported yet.",
        known.length
          ? `median ${median(known)} / peak ${Math.max(...known)} / total ${known.reduce((a, b) => a + b, 0)} tokens`
          : "",
        "",
        "Each record, newest last.",
        ...this.listRows(),
      ];
    }
    // The sessions tab falls through to the default list below. It gets a
    // summary of its own because the question it answers is not "which
    // conversation" but "what state is everything in", and a flat list of
    // titles says nothing about that until it is read.
    if (this.tab === "sessions" && rows.length) {
      const byState = new Map<string, number>();
      for (const row of rows) {
        const match = /\[([^\]]+)\]/.exec(row.label);
        const state = match?.[1] ?? "unknown";
        byState.set(state, (byState.get(state) ?? 0) + 1);
      }
      const counts = [...byState.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([state, count]) => `${count} ${state}`)
        .join(", ");
      return [
        `CONVERSATIONS, ${rows.length} total: ${counts}`,
        "",
        ...this.listRows(),
        "",
        "Enter opens a conversation. /resume picks one by number.",
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
        `DOCUMENTS, ${rows.length} total across ${bySession.size} conversations`,
        "",
        counts + (bySession.size > 4 ? ", ..." : ""),
        "",
        openOps.length
          ? `${openOps.length} of ${this.recoveryRows().length} changes can still be undone. /diff steps through them.`
          : "Every change has been decided: undone or kept.",
        "Enter opens a document. Left/Right folds the tree.",
      ];
    }
    // The ledger tab groups by kind, but the question an operator arrives with
    // is "is this chain intact and how long is it", which the grouping answers
    // only by listing every group.
    if (this.tab === "ledger" && rows.length) {
      const byKind = new Map<string, number>();
      for (const row of rows) {
        const kind = row.kind ?? "entry";
        byKind.set(kind, (byKind.get(kind) ?? 0) + 1);
      }
      const counts = [...byKind.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([kind, count]) => `${count} ${kind}`)
        .join(", ");
      const errors = this.proofErrors.size + this.proxy.errors.length;
      return [
        `LEDGER, ${rows.length} entries: ${counts}`,
        "",
        errors
          ? `${errors} chain(s) could not be verified. /verify rechecks.`
          : `All ${rows.length} entries verified against the managed chain.`,
        "",
        ...this.listRows(),
      ];
    }
    // The approvals tab answers "what is waiting on me", and the answer is a
    // deadline, not a list. The list below is sorted by blast radius, which
    // answers a different question: which is riskiest. Both matter, so the
    // summary leads with how many are waiting and how long the soonest one
    // has, then the list follows.
    if (this.tab === "approvals" && rows.length) {
      const byStatus = new Map<string, number>();
      for (const row of rows) {
        const match = /\[([^\]]+)\]/.exec(row.label);
        const status = match?.[1] ?? "unknown";
        byStatus.set(status, (byStatus.get(status) ?? 0) + 1);
      }
      const counts = [...byStatus.entries()]
        .map(([status, count]) => `${count} ${status}`)
        .join(", ");
      // The deadline rides at the front of the label in one of two shapes:
      // "NNNs left | " while it runs and "EXPIRED | " once it has. Matching the
      // shape rather than any number is what keeps a hold id or a tool name
      // from being read as a deadline.
      const expiries = rows
        .map((row) => /^(\d+)s left \| /.exec(row.label)?.[1])
        .filter((v): v is string => !!v)
        .map(Number);
      const expired = rows.filter((row) =>
        row.label.startsWith("EXPIRED"),
      ).length;
      const soonest = expiries.length ? `${Math.min(...expiries)}s` : undefined;
      return [
        `APPROVALS, ${rows.length} waiting: ${counts}`,
        "",
        expired
          ? `${expired} already expired and did not run.`
          : soonest
            ? `soonest deadline: ${soonest}`
            : "no deadline reported",
        "",
        ...this.listRows(),
        "",
        "Enter opens the decision. a approves, d denies, y accepts a diff.",
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
      return rows.map((row, i) => `${mark(i)}${i + 1}. ${row.label}`);
    const out: string[] = [];
    let kind: string | undefined;
    rows.forEach((row, index) => {
      if (row.kind !== kind) {
        kind = row.kind;
        const key = row.kind ?? "";
        out.push(
          `${LEDGER_GROUP_ICON[key] ?? "-"} ${LEDGER_GROUP_TITLE[key] ?? key}`,
        );
      }
      out.push(`${mark(index)}${index + 1}. ${row.label}`);
    });
    return out;
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
    rows.push(
      `[${e.at.slice(11, 19)}] ${e.kind === "user" ? "YOU" : e.kind === "assistant" ? "NOMO" : e.kind.toUpperCase()}`,
      ...e.text.split("\n"),
      "",
    );
  }
  if (partial) rows.push("NOMO [stream]", ...partial.split("\n"));
  return rows;
}
type ChatRow = {
  text: string;
  style: "user" | "assistant" | "heading" | "code" | "tool" | "error" | "text";
};
/** Terminal-only presentation. Never evaluate Markdown, HTML or terminal escapes. */
export function chatRows(
  events: readonly SessionEvent[],
  width: number,
  compactTools = false,
): ChatRow[] {
  const rows: ChatRow[] = [];
  let partial = "";
  const add = (value: string, style: ChatRow["style"]) => {
    rows.push(...wrap([value], width).map((text) => ({ text, style })));
  };
  const messageRows = (
    value: string,
    kind: SessionEvent["kind"],
    label: string,
  ) => {
    add(label, kind === "usage" ? "text" : kind);
    let fence = "",
      lineNumber = 0;
    for (const raw of value.split("\n")) {
      const marker = /^\s{0,3}(`{3,}|~{3,})(.*)$/.exec(raw);
      if (
        kind === "assistant" &&
        marker &&
        (!fence ||
          (marker[1]![0] === fence[0] &&
            marker[1]!.length >= fence.length &&
            !marker[2]!.trim()))
      ) {
        if (fence) {
          add("  └ end code", "tool");
          fence = "";
        } else {
          fence = marker[1]!;
          lineNumber = 0;
          add(`  ┌ ${marker[2]!.trim() || "code"}`, "code");
        }
      } else if (fence) {
        const prefix = `  ${String(++lineNumber).padStart(2)} │ `;
        for (const [i, chunk] of wrap(
          [raw],
          Math.max(1, width - prefix.length),
        ).entries())
          add(
            (i ? " ".repeat(prefix.length - 2) + "│ " : prefix) + chunk,
            "code",
          );
      } else
        add(
          raw,
          kind === "error"
            ? "error"
            : kind === "tool"
              ? "tool"
              : kind === "assistant" && /^#{1,6}\s/.test(raw)
                ? "heading"
                : "text",
        );
    }
    add("", "text");
  };
  for (const event of events) {
    if (event.type === "message.delta") {
      partial += event.text;
      continue;
    }
    if (event.kind === "assistant") partial = "";
    if (event.type === "run.status" || event.kind === "usage") continue;
    // The role word and the glyph come from the block renderer so the
    // transcript and the block view cannot drift apart. The word stays in
    // every label: the glyph is recognition speed, never the only signal.
    const label =
      event.kind === "user"
        ? `${roleIcon("user")} YOU`
        : event.kind === "assistant"
          ? `${roleIcon("assistant")} NOMO`
          : event.kind === "error"
            ? `${roleIcon("error")} ERROR`
            : event.type === "tool.started"
              ? `${roleIcon("tool")} TOOL REQUEST`
              : `${roleIcon("tool")} TOOL RESULT`;
    if (compactTools && event.kind === "tool") {
      const output = wrap(event.text.split("\n"), width);
      if (output.length > 4) {
        add(`${label}  ${event.at.slice(11, 19)}`, "tool");
        for (const line of output.slice(0, 3)) add(line, "tool");
        add(`  … ${output.length - 3} more lines /expand`, "tool");
        add("", "text");
        continue;
      }
    }
    messageRows(event.text, event.kind, `${label}  ${event.at.slice(11, 19)}`);
  }
  if (partial)
    messageRows(
      partial,
      "assistant",
      `${roleIcon("assistant")} NOMO streaming`,
    );
  return rows;
}
export function wrap(lines: readonly string[], width: number): string[] {
  const out: string[] = [];
  for (const line of lines) {
    let part = "";
    for (const point of sanitizeText(line)) {
      if (part && visibleLength(part + point) > width) {
        out.push(part);
        part = "";
      }
      part += point;
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
  ["/overview", "Workspace overview"],
  ["/doctor", "Environment checks"],
  ["/init", "Set up workspace storage"],
  ["/conformance", "Run adapter conformance checks"],
  ["/status", "Workspace status"],
  ["/health", "Pass, warn, fail or unknown for every subsystem"],
  ["/discover", "Commands grouped by the task you arrived with"],
  ["/cost", "Token usage and cost"],
  ["/compact", "Review real context compaction"],
  ["/todos", "Checklist from agent output"],
  ["/agents", "Runtime profiles, conversations and connectors"],
  ["/agent", "Select a profile for new conversations"],
  ["/agent-file", "Review and save a custom profile from path.json"],
  ["/hooks", "Runtime hook support and operator allowlist"],
  ["/hook-file", "Review a hook if the host supports execution"],
  ["/hook", "Enable or disable a saved hook by id"],
  ["/projects", "List persisted projects"],
  ["/project", "Select a project ID or none for new conversations"],
  ["/project-file", "Review and save a project from path.json"],
  ["/config", "Resolved paths and flags"],
  ["/settings", "Harness limits, or set one with /settings key value"],
  ["/memory", "Retained local history"],
  ["/model", "Set model for new chats"],
  ["/plan", "Switch to plan mode"],
  ["/stats", "Token usage and cost"],
  ["/diff", "Outstanding document changes"],
  ["/diff-next", "Next outstanding change in the diff panel"],
  ["/theme", "Color and motion for this session"],
  ["/keybindings", "Keyboard shortcut reference"],
  ["/exit", "Save and quit"],
  ["/export", "Save ledger, chat or document"],
  ["/attest", "Signed slice for a third party"],
  ["/providers", "Model providers and local open models"],
  ["/harness", "Agent harness: cloud or prime-agent"],
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
  ["/policy", "Tool policies"],
  ["/permissions", "Tool policies and approvals"],
  ["/mcp", "MCP connectors: add, probe, confirm, rename, remove"],
  ["/usage", "Model usage"],
  ["/stop", "Stop run"],
  ["/help", "All commands"],
  ["/quit", "Save and quit"],
] as const;
export function commandSuggestions(input: string) {
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
  "/harness": "cloud or prime-agent",
  "/theme": "color, mono, motion, still or reset",
  "/approve": "hold-ID [reason]",
  "/deny": "hold-ID [reason]",
  "/refine": "approve <digest> or reject <digest> [reason]",
  "/tools": "search text",
  "/policy-file": "connector-ID path.yaml",
  "/connector-file": "path.json",
  "/agent-file": "path.json",
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
  frame?: number;
  motion?: boolean;
  boot?: boolean;
  command?: string;
  suggestion?: number;
  cursor?: number;
};
// The NOMO mark is rasterized from gui-web/icon.svg by brandHeader().
// The old block-capital wordmark was removed: it duplicated the brand
// mark and read as jagged at narrow widths.
// Decorative tab identity colors. Safety state never rides on these;
// classes and decisions keep their text markers in every surface.
export const TAB_ICON_TONE: Record<WorkspaceTab, string> = {
  overview: "38;5;215",
  chat: "38;5;117",
  sessions: "38;5;183",
  documents: "38;5;78",
  ledger: "38;5;179",
  approvals: "38;5;203",
  policy: "38;5;245",
  tools: "38;5;214",
  models: "38;5;75",
  usage: "38;5;228",
  help: "38;5;245",
};
// Single cell symbols only, so visibleLength stays exact on every terminal.
// Geometric shapes (U+25A0 to U+25FF) count one cell in layout.ts, while emoji
// and dingbat ranges count two. Icons never carry safety meaning alone, the
// [0] to [3] and [+]/[!]/[x] markers stay authoritative.
export const TAB_ICONS: Record<WorkspaceTab, string> = {
  overview: "◈",
  chat: "●",
  sessions: "≡",
  documents: "▤",
  ledger: "▪",
  approvals: "◉",
  policy: "§",
  tools: "+",
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
  if (key.includes("run") || key.includes("active")) return ROW_ICONS.running;
  if (key.includes("fail") || key.includes("error")) return ROW_ICONS.failed;
  if (key.includes("queue") || key.includes("pending")) return ROW_ICONS.queued;
  if (key.includes("archiv")) return ROW_ICONS.archived;
  if (key.includes("settl") || key.includes("done") || key.includes("complet"))
    return ROW_ICONS.settled;
  return ROW_ICONS.unknown;
}

export const MODE_ICON: Record<TuiMode, string> = {
  normal: "◆",
  accept: "●",
  plan: "○",
};
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
export function renderWorkspace(
  ui: WorkspaceTui,
  columns: number,
  rows: number,
  input = "",
  editing = false,
  busy = false,
  visuals: WorkspaceVisuals = {},
): string {
  const width = Math.max(20, columns),
    height = Math.max(8, rows);
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
  const caps = detectCapabilities(ui.env, {
    columns: width,
    rows: height,
    isTTY: true,
  });
  const ink = (value: string, code: string) =>
    visuals.color ? `\x1b[${code}m${value}\x1b[0;48;5;234;38;5;252m` : value;
  const text = (value: string) => fit(sanitizeText(value), width);
  const amber = "38;5;215",
    ice = "38;5;117",
    mutedAnsi = "38;5;245",
    violet = "38;5;183";
  const running = busy || ui.workbench.running();
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
  ui.editingInput = editing;
  const pending = ui.workbench.pending();
  const holds = pending.length + ui.proxy.holds.length;
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
  );
  // Toasts sit below the approval banner and above the body. The banner is
  // sticky and authoritative; toasts are the transient layer under it, so a
  // raise never has to choose between being seen and being safe.
  //
  // On a terminal too short to carry them they are dropped rather than
  // squeezed. A toast that costs the operator their input surface has
  // charged more than it delivered, and the approval banner above still
  // carries everything they actually have to act on.
  const toastRows = renderToasts(ui.toasts, width - 4, {
    color: visuals.color === true,
  });
  const header: string[] = [];
  if (
    height >= 22 &&
    width >= 50 &&
    !ui.confirmation &&
    (!ui.session() || ui.tab !== "chat" || visuals.boot)
  ) {
    // Web aperture mark plus the wordmark, the same pair as the site
    // header. The mark is 7 rows, the wordmark 5, so the wordmark rides
    // centered with one blank row top and bottom.
    const aside = [
      "NOMO / local workspace",
      ui.session()?.model || ui.model || "Connect a model with /connect",
      // While nothing is happening the breathing dot says the process is
      // alive and idle. It is decoration on a line that already says what is
      // going on, and it is the first thing to go when motion is off.
      running
        ? "Working / Esc to stop"
        : `${idleBreath(motion)} Your work. Your control.`,
      `${ui.workbench.list().length} conversations / ${holds} pending approvals`,
      "[/] commands   [Esc] navigation",
      "/keybindings lists every shortcut",
      "Shift+Tab mode | Tab panels",
    ];
    const mark = brandHeader("", {
      interactive: true,
      ansi: visuals.color === true,
      colorDepth: visuals.color === true ? 24 : 0,
      columns: width,
      rows: height,
      reason: "interactive",
    });
    mark.forEach((markRow, i) => {
      header.push(
        ink(
          markRow,
          (visuals.boot || running) && frame % 5 === i ? ice : mutedAnsi,
        ) +
          (width >= 78
            ? ink(
                fit(
                  sanitizeText("   " + (aside[i] ?? "")),
                  width - visibleLength(markRow),
                ),
                i === 1 ? ice : mutedAnsi,
              )
            : ""),
      );
    });
  } else
    header.push(
      ink(
        text(
          ` /V/  NOMO  ${ui.session()?.model || ui.model || ui.tab}  |  ${holds} approvals`,
        ),
        `1;${amber}`,
      ),
    );
  const tabIndex = WORKSPACE_TABS.indexOf(ui.tab);
  const tabs =
    WORKSPACE_TABS.join("  ").length < width - 2
      ? WORKSPACE_TABS
      : WORKSPACE_TABS.slice(Math.max(0, tabIndex - 1), tabIndex + 3);
  header.push(
    fit(
      tabs
        .map((t) => {
          const icon = ink(`${TAB_ICONS[t]}`, TAB_ICON_TONE[t]);
          const active = t === ui.tab;
          const name = active
            ? ink(` [${t}] `, `1;${ice};48;5;24`)
            : ink(` ${t} `, mutedAnsi);
          return `${icon}${name}`;
        })
        .join(""),
      width,
    ),
  );
  // An underline under the tab row gives the selected panel a second signal
  // that survives a monochrome terminal, and the active bar animates its
  // weight so the eye lands on it without any colour change.
  //
  // It costs a row, and every extra row has to come out of the body. It is
  // therefore added before the body height is computed, never after, so
  // header.length already accounts for it. Adding it later and patching the
  // arithmetic is how the frame stops being exactly height rows tall.
  //
  // The reserve below is the smallest frame worth decorating: header, one row
  // of underline, two body rows, the summary and status rows and the three
  // composer rows. Anything narrower keeps the body instead.
  if (height - header.length >= 12)
    header.push(
      fit(
        tabs
          .map((t) => {
            const label = `${TAB_ICONS[t]} ${t} `;
            return ink(
              tabUnderline(t === ui.tab, visibleLength(label), motion),
              t === ui.tab ? ice : mutedAnsi,
            );
          })
          .join(""),
        width,
      ),
    );
  // A travelling wave under the header while a run is in flight. It is
  // attention, never the only signal: the status row below still names the
  // phase in words.
  if (running && height - header.length >= 13)
    header.push(
      ink(
        phaseWave("Working", width, motion, {
          paint: (value, tone, bold) =>
            ink(value, bold ? `1;${ice}` : mutedAnsi),
        }),
        mutedAnsi,
      ),
    );
  const candidates =
    editing && !ui.confirmation
      ? commandSuggestions(visuals.command ?? "")
      : [];
  const selection = Math.max(
    0,
    Math.min(visuals.suggestion ?? 0, candidates.length - 1),
  );
  const menuStart = Math.max(0, selection - 3);
  const menu = candidates.slice(
    menuStart,
    menuStart + Math.min(5, Math.max(0, height - header.length - 8)),
  );
  // Once a command and a space are typed, the useful hint is what it wants
  // next rather than which command it is. A hint that has not been earned
  // yet, before the space, would only repeat the command list.
  const typedCommand = visuals.command ?? "";
  const argumentHint =
    editing && !ui.confirmation && /^\/\S*\s/.test(typedCommand)
      ? commandArgumentHint(typedCommand)
      : undefined;
  // Inside the frame the row keeps 2 side cells plus a 2 cell prompt prefix,
  // so text wraps at width - 6 and the border never breaks mid line.
  const composerInner = Math.max(1, width - 6);
  // The palette query stands in for the draft while the overlay is open, so
  // the same wrapping and cursor arithmetic serve both surfaces.
  const composerText = ui.palette
    ? [ui.palette.query]
    : (
        input ||
        (editing
          ? "Ask anything or type / for commands"
          : "i type / Enter details")
      ).split("\n");
  const composer = wrap(composerText, composerInner);
  const composerHeight = Math.min(composer.length, height >= 18 ? 3 : 1);
  const cursorLine =
    visuals.cursor === undefined
      ? Math.max(
          0,
          composer.findIndex((line) => line.includes("▌")),
        )
      : wrap(
          ([...input].slice(0, visuals.cursor).join("") + "_").split("\n"),
          composerInner,
        ).length - 1;
  const composerStart = Math.max(0, cursorLine - composerHeight + 1);
  // An open palette owns the body. It is a filter surface, so whatever the
  // underlying tab would have shown is exactly the noise the operator is
  // trying to see past.
  const paletteView = ui.palette
    ? renderPalette(
        ui.palette,
        filterPalette(paletteFromCommands(TUI_COMMANDS), ui.palette.query),
        width - 4,
        { color: visuals.color },
      )
    : undefined;
  // The legend is rendered after the paint helpers exist and before the body
  // height is known, because the body height is what decides how many legend
  // rows fit. Measuring it here is what keeps the frame exactly height rows
  // tall on every terminal size, which the parity tests pin.
  const legendRows = paletteView
    ? renderShortcutLegend(
        { editing: false, confirming: false, running: false, pending: 0 },
        { width, caps },
      )
    : renderShortcutLegend(
        {
          editing,
          confirming: !!ui.confirmation,
          running,
          pending: holds,
        },
        {
          width,
          caps,
          symbolPreset: ui.themeConfig.symbolPreset,
          colorTheme: ui.themeConfig.colorTheme,
          paint: visuals.color
            ? (text, tone, bold) =>
                paintWithPalette(
                  text,
                  tone,
                  getPalette(ui.themeConfig.colorTheme),
                  caps,
                  bold,
                )
            : undefined,
        },
      );
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
    running && !waiting && ownRun
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
  // One budget for every row that is not the body.
  //
  // The earlier version gave each optional band its own guessed reserve, and
  // three guesses that cannot see each other add up to more than the terminal
  // has. On a twelve row terminal with three toasts they overcommitted by one
  // row and the prompt frame lost its bottom rule, which is the one row an
  // operator cannot afford to lose.
  //
  // The rows that must always exist are counted first and never traded away:
  // the header, the approval banner, the prompt frame with its two rules, the
  // summary and status rows, the suggestion menu and one row of body. What is
  // left is the only pool the optional bands may draw from, and each takes
  // what is still there when its turn comes.
  const reserved =
    header.length +
    banner.length +
    composerHeight +
    2 /* the prompt frame's own top and bottom rules */ +
    2 /* the summary and status rows */ +
    menu.length +
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
  const shownRuleRows = spare >= 1 ? [separator(width, motion, running)] : [];
  spare -= shownRuleRows.length;

  // The legend is advice, and /keybindings carries the same list, so it takes
  // whatever is left and no more.
  const shownLegendRows = spare >= legendRows.length ? legendRows : [];
  spare -= shownLegendRows.length;

  const ruleRows = shownRuleRows;
  const visibleLegendRows = shownLegendRows;
  const bodyHeight = Math.max(1, spare + 1);
  const richChat =
    ui.tab === "chat" &&
    !!ui.session() &&
    !ui.detail &&
    !ui.confirmation &&
    !paletteView;
  let content = paletteView
    ? [...paletteView.lines]
    : richChat
      ? []
      : ui.lines();
  if (
    ui.tab === "chat" &&
    !ui.session() &&
    !ui.detail &&
    !ui.confirmation &&
    !paletteView
  )
    content = [
      "",
      "  Welcome to NOMO.",
      "  Describe what you want to build. Follow the work here.",
      "",
      "  > Create a project plan and save it to plan.md",
      "",
      "  + Documents    Captured changes and confirmed Undo",
      "  + Ledger       Signed history of every operation",
      "  + Approvals    Your decision before an external tool",
      "",
      "  / commands     Tab complete     Esc navigate",
    ];
  const styled = richChat
    ? chatRows(ui.session()!.events, width - 4, ui.compactTools)
    : undefined;
  const lines = styled?.map((row) => row.text) ?? wrap(content, width - 4);
  let offset = ui.scroll;
  // The palette windows its own list internally and the window follows the
  // selection, so the body always starts at the top here.
  if (paletteView) offset = 0;
  else if (!ui.detail && !ui.confirmation && ui.tab === "chat" && ui.scroll < 0)
    offset = Math.max(0, lines.length - bodyHeight);
  else if (
    !ui.detail &&
    !ui.confirmation &&
    !["chat", "overview", "policy", "help"].includes(ui.tab)
  )
    offset = Math.max(0, ui.selected - bodyHeight + 1);
  offset = Math.min(
    Math.max(0, offset),
    Math.max(0, lines.length - bodyHeight),
  );
  ui.viewport = { offset, height: bodyHeight, total: lines.length };
  // User prompt rows drive the { and } jumps. Rich chat marks the prompt
  // label by style; plain transcript rows end with the YOU marker instead.
  ui.promptRows = lines
    .map((line, index) =>
      styled?.[index]?.style === "user" ||
      line.startsWith(`${roleIcon("user")} YOU`) ||
      / YOU$/.test(line)
        ? index
        : -1,
    )
    .filter((index) => index >= 0);
  const body = lines.slice(offset, offset + bodyHeight);
  while (body.length < bodyHeight) body.push("");
  const frameColor = ui.confirmation ? amber : mutedAnsi;
  const bodyRows = body.map((line, index) => {
    const style = styled?.[offset + index]?.style;
    const tone =
      style === "user"
        ? `1;${violet};48;5;236`
        : style === "assistant" || style === "heading"
          ? `1;${amber}`
          : style === "code"
            ? `${ice};48;5;235`
            : style === "tool"
              ? mutedAnsi
              : style === "error"
                ? "38;5;203"
                : style === "text"
                  ? "38;5;252"
                  : /^>/.test(line)
                    ? `1;${ice}`
                    : / YOU$/.test(line)
                      ? `1;${violet}`
                      : / NOMO(?: streaming)?$/.test(line)
                        ? `1;${amber}`
                        : /^(Error|Invalid|Failed)/.test(line)
                          ? "38;5;203"
                          : "38;5;252";
    // A sweep crosses the newest run's last row while it is live, so the eye
    // is drawn to the line that just changed. It rides on a row that is
    // already coloured and already scrolled to, so it adds attention without
    // adding meaning that a monochrome terminal would lose.
    const isLiveTail =
      running &&
      !ui.confirmation &&
      offset + index === lines.length - 1 &&
      lines.length > 1;
    const painted = isLiveTail
      ? sweepRow(pad(line, width - 4), width - 4, motion, {
          paint: (value) => (visuals.color ? ink(value, `1;${amber}`) : value),
        })
      : pad(line, width - 4);
    return (
      ink(ui.confirmation ? "! " : "  ", frameColor) +
      ink(painted, tone) +
      (ui.confirmation ? ink(" !", frameColor) : "  ")
    );
  });
  const events = ui.session()?.events ?? [];
  const latestUser = [...events].reverse().find((e) => e.kind === "user");
  const elapsed =
    visuals.now && latestUser && ui.session()?.status === "running"
      ? ` / ${Math.max(0, Math.floor((visuals.now - Date.parse(latestUser.at)) / 1000))}s`
      : "";
  const lastEvent = [...events]
    .reverse()
    .find((e) => e.type !== "run.status" && e.kind !== "usage");
  // The phase icon carries the same word as the label beside it, so the glyph
  // is recognition speed rather than the only signal.
  //
  // Every glyph here is single cell. The pencil U+270E that would read as
  // "writing" counts two in layout.ts, which would push this status row one
  // column past its width and, on a narrow terminal, drop the Esc stop hint
  // off the end.
  const phase =
    lastEvent?.type === "tool.started"
      ? `${ROW_ICONS.tool} Calling tool`
      : lastEvent?.type === "message.delta"
        ? `${ROW_ICONS.edit} Writing response`
        : `${ROW_ICONS.unknown} Thinking`;
  // Live ellipsis, frozen when motion is off so paused frames stay equal.
  const dots =
    visuals.motion === false ? "" : ".".repeat(1 + (Math.floor(frame / 3) % 3));
  const historyStatus =
    richChat && ui.scroll >= 0
      ? `History ${offset + 1}-${Math.min(offset + bodyHeight, lines.length)}/${lines.length} / /bottom to follow`
      : undefined;
  // Context pressure on the chat tab itself. The status bar carries it too,
  // but the chat is where an operator decides whether to compact, so the
  // answer has to be in the pane that prompts the decision.
  //
  // Only where a ceiling was declared. A meter against an invented maximum
  // would report pressure where the honest answer is that no limit is known.
  const chatContext = ui.session() ? ui.contextNumbers() : null;
  const chatContextBadge =
    chatContext &&
    typeof chatContext.contextTokens === "number" &&
    chatContext.contextTokens > 0 &&
    typeof chatContext.contextUsed === "number"
      ? `ctx ${levelMeter(chatContext.contextUsed, chatContext.contextTokens, 6, motion)} ${Math.round((chatContext.contextUsed / chatContext.contextTokens) * 100)}% / /compact`
      : undefined;
  const usage = [...(ui.session()?.events ?? [])]
    .reverse()
    .find((event) => event.kind === "usage")?.payload;
  const usageTokens =
    typeof usage?.total_tokens === "number" ? usage.total_tokens : "?";
  const cost = typeof usage?.cost === "number" ? usage.cost : "unknown";
  const model = sanitizeText(
    ui.session()?.model || ui.model || "not connected",
  );
  const ctx = ui.session() ? ui.contextNumbers() : null;
  const ctxText = ctx
    ? `${ctx.contextMessages ?? "unknown"} msgs`
    : "no session";

  // Status segments with theme colors (omp-style segment catalog)
  const symbols = getSymbols(ui.themeConfig.symbolPreset);
  const palette = getPalette(ui.themeConfig.colorTheme);
  const accent = paintWithPalette("●", "accent", palette, caps, true);
  const muted = paintWithPalette("│", "muted", palette, caps);
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
  // Context
  const ctxVal = ctx ? `${ctx.contextMessages ?? "?"} msgs` : "no session";
  segments.push(seg("ctx", ctxVal, "warning"));
  // Tokens & cost
  const costStr =
    typeof usage?.cost === "number" ? `$${usage.cost.toFixed(4)}` : "?";
  segments.push(seg("tok", String(usageTokens), "success"));
  segments.push(seg("cost", costStr, "warning"));
  // A context meter, but only where there is a real maximum to measure
  // against. A bar drawn against an invented ceiling would say the context is
  // half full when the only honest answer is that no ceiling is known yet.
  const contextLimit = ctx?.contextTokens ?? null;
  if (
    typeof contextLimit === "number" &&
    contextLimit > 0 &&
    ctx?.contextUsed
  ) {
    const ratio = ctx.contextUsed / contextLimit;
    segments.push(
      `${paintWithPalette("ctx", "muted", palette, caps)} ${paintWithPalette(
        levelMeter(ctx.contextUsed, contextLimit, 6, motion, {
          paint: (value, tone, bold) =>
            paintWithPalette(value, tone, palette, caps, bold),
        }),
        "muted",
        palette,
        caps,
      )} ${paintWithPalette(`${Math.round(ratio * 100)}%`, ratio > 0.9 ? "error" : "success", palette, caps)}`,
    );
  }
  // Approvals & queue
  const holdCount = ui.workbench.pending().length + ui.proxy.holds.length;
  if (holdCount > 0) segments.push(seg("holds", `◉ ${holdCount}`, "error"));
  if (ui.queuedPrompt)
    segments.push(
      seg("queue", ui.queuedPromptPaused ? "paused" : "+1 queued", "warning"),
    );
  // Compact mode
  segments.push(seg("tools", ui.compactTools ? "compact" : "full", "muted"));
  // A run with no reported progress gets an indeterminate bar rather than a
  // percentage, because there is no honest fraction to print and a frozen 0%
  // would read as stalled rather than running.
  if (running && !waiting) {
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

  // Join with theme separator, respecting width
  const sep = paintWithPalette(symbols.separator.dot, "muted", palette, caps);
  let summary = segments.join(` ${sep} `);
  // Measure the raw model value. Fitting the ANSI-painted segment sees only
  // visible cells, returns it unchanged, and can leave this loop stuck.
  while (visibleLength(summary) > width - 4 && visibleLength(modelShown) > 8) {
    const next = fit(modelShown, visibleLength(modelShown) - 1);
    if (next === modelShown) break;
    modelShown = next;
    segments[0] = seg("model", modelShown, "accent");
    summary = segments.join(` ${sep} `);
  }
  const summaryLine = summary;
  // The legend strings were measured above, before the body was sliced, so the
  // body height could subtract what they actually took. Paint them here, where
  // the muted helper exists.
  const paintedLegendRows = visibleLegendRows.map((row) =>
    ink(text(row), muted),
  );
  const todoBadge = (() => {
    try {
      const todos = extractTodos(ui.session()?.events ?? []);
      const open = todos.filter((item) => !item.done).length;
      return todos.length
        ? ` | ✓ ${todos.length - open}/${todos.length} todos`
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
    ? `${paletteMatches} command${paletteMatches === 1 ? "" : "s"} match / Enter run / Esc close`
    : ui.confirmation
      ? "[!] REVIEW / y accept / n reject / Esc cancel / PgDn preview"
      : running && (busy || ui.session()?.status === "running")
        ? `${spinner} ${ui.session()?.status === "running" ? (waiting ? "[wait] Waiting for approval" : `● ${phase}${dots}`) : `[run] Finishing operation${dots}`}${elapsed} / Esc stop${historyStatus ? " / [history] reading history" : ""}${todoBadge}${chatContextBadge ? ` / ${chatContextBadge}` : ""}`
        : `${historyStatus ?? ui.notice}${chatContextBadge ? `${historyStatus ? " / " : ""}${chatContextBadge}` : ""}`;
  const menuRows = menu.map(([name, description], i) =>
    ink(
      text(
        `${i + menuStart === selection ? " ›" : "  "} ${name.padEnd(13)} ${description}`,
      ),
      i + menuStart === selection ? `1;${ice};48;5;24` : muted,
    ),
  );
  // Add mode indicator with icon
  const modeIndicator =
    ui.mode === "plan" ? "○" : ui.mode === "accept" ? "●" : "◆";
  // While the palette is open the composer shows the query rather than the
  // prompt draft, because that is the text the operator is editing.
  const frameTitle = paletteView
    ? `⌘ ${ui.palette?.query || "all commands"}`
    : editing
      ? `${modeIndicator} Write a prompt [${ui.mode.toUpperCase()}]`
      : `${TAB_ICONS[ui.tab]} ${ui.tab} / navigation`;
  // The caret the runner splices into the draft is a single cell placeholder.
  // Swapping it for the animated glyph here is what makes the caret blink,
  // and it is safe to do at render time because both glyphs are exactly one
  // cell, so no wrapping or padding downstream can notice the difference.
  const caret = typeCursor(ui.palette ? true : editing, motion);
  const promptBox = [
    promptFrameTop(frameTitle, width),
    ...composer
      .slice(composerStart, composerStart + composerHeight)
      .map((value, i) =>
        promptFrameRow(
          `${i === 0 ? (editing ? "› " : ": ") : "  "}${value.replace("▌", caret)}`,
          width,
        ),
      ),
    promptFrameBottom(width),
  ];
  // The frame border follows the permission mode, like the reference
  // terminal: ice for normal, green for accept, blue for plan. The title
  // always states the mode in text, so color stays redundant information.
  const frameTone = !editing
    ? muted
    : ui.mode === "plan"
      ? "38;5;75"
      : ui.mode === "accept"
        ? "38;5;78"
        : ice;
  return [
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
    ...bodyRows,
    // The timeline sits between the body and the summary, so it reads as
    // belonging to the run the body is showing rather than to the controls
    // below it.
    ...shownTimelineRows,
    // The rule marks where the body ends and the controls begin, so the
    // operator does not have to read the composer frame to know it is about
    // to type into it.
    ...ruleRows.map((row) => ink(row, muted)),
    ink(fit(summary, width), ice),
    ink(text(status), ui.confirmation ? `1;${amber}` : running ? amber : muted),
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
    ...promptBox.map((row) => ink(row, frameTone)),
  ]
    .slice(0, height)
    .map((row) =>
      visuals.color ? `\x1b[48;5;234;38;5;252m${pad(row, width)}\x1b[0m` : row,
    )
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
  { group: "send", keys: "Enter", action: "Send the prompt" },
  {
    group: "send",
    keys: "Shift+Enter / Alt+Enter / Ctrl+J",
    action: "Insert a newline",
  },
  { group: "input", keys: "Left / Right", action: "Move the cursor" },
  { group: "input", keys: "Up / Down", action: "Previous or next prompt" },
  {
    group: "input",
    keys: "Ctrl+P / Ctrl+N",
    action: "History, same as Up and Down",
  },
  {
    group: "input",
    keys: "Ctrl+A / Ctrl+E",
    action: "Start or end of the line",
  },
  {
    group: "input",
    keys: "Alt+B / Alt+F or Ctrl+Left / Ctrl+Right",
    action: "Jump by word",
  },
  { group: "input", keys: "Alt+D or Ctrl+W", action: "Delete a word" },
  { group: "input", keys: "Ctrl+K", action: "Delete to end of line" },
  { group: "input", keys: "Ctrl+U", action: "Clear the input" },
  { group: "input", keys: "Ctrl+Y", action: "Paste the killed text" },
  { group: "input", keys: "Ctrl+_", action: "Undo the last edit" },
  { group: "input", keys: "Ctrl+D", action: "Delete forward, twice exit" },
  { group: "navigate", keys: "Tab", action: "Next panel or complete" },
  {
    group: "navigate",
    keys: "Left / Right outside editing",
    action: "Cycle panels",
  },
  { group: "navigate", keys: "Ctrl+P", action: "Open the command palette" },
  { group: "navigate", keys: "{ and }", action: "Jump between your prompts" },
  { group: "navigate", keys: "PgUp / PgDn", action: "Scroll the body" },
  {
    group: "navigate",
    keys: "Esc",
    action: "Stop a run, or close the detail view",
  },
  {
    group: "navigate",
    keys: "Esc Esc",
    action: "Clear the input, or list checkpoints when empty",
  },
  {
    group: "navigate",
    keys: "Shift+Tab or Alt+M",
    action: "Cycle mode: normal, accept, plan",
  },
  {
    group: "review",
    keys: "y / n / Esc",
    action: "Accept, reject or cancel a review",
  },
  { group: "review", keys: "1 to 9", action: "Toggle a hunk in the diff" },
  { group: "session", keys: "Ctrl+R", action: "Search prompts and text" },
  {
    group: "session",
    keys: "Ctrl+T",
    action: "Show the checklist from output",
  },
  { group: "session", keys: "Ctrl+O", action: "Toggle tool output" },
  { group: "session", keys: "Ctrl+S", action: "Stash, press again to restore" },
  {
    group: "session",
    keys: "Ctrl+G or Ctrl+X Ctrl+E",
    action: "Open the editor",
  },
  { group: "session", keys: "Meta+P", action: "Switch model" },
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
  const indent = 2;
  const keyWidth = Math.min(
    Math.max(...matching.map((row) => visibleLength(row.keys))),
    Math.max(6, Math.floor(width / 2) - indent),
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
    const room = Math.max(0, width - indent - keyWidth - 2);
    for (const row of rows)
      lines.push(
        `${indent}${fit(row.keys, keyWidth)}  ${fit(row.action, room)}`,
      );
    lines.push("");
  }
  lines.push(
    fit(
      "No NOMO equivalent: background tasks, image paste, suspend, Vim editing.",
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
function discoverLines(): string[] {
  const entries: CommandEntry[] = TUI_COMMANDS.map(([id, summary]) => ({
    id,
    summary,
    group: discoveryGroupFor(id),
  }));
  const rows = discoveryRows(entries, { width: 72 });
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
    "overview",
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
function helpLines(): string[] {
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
            { label: "chat", value: "Start typing. i types, Enter sends." },
            {
              label: "commands",
              value: "/ opens them, arrows select, Tab completes",
            },
            {
              label: "palette",
              value: `Ctrl+P. ${commands} commands, searchable`,
            },
            {
              label: "shortcuts",
              value: "/keybindings, searchable by key or by action",
            },
            {
              label: "panels",
              value: "Tab or Left/Right. Enter opens the selected row.",
            },
            {
              label: "mode",
              value: "Shift+Tab or Alt+M: normal, accept, plan",
            },
            {
              label: "scroll",
              value: "PgUp/PgDn, or /bottom to follow the latest",
            },
            {
              label: "stop",
              value: "Esc stops a run or closes details",
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
                "background tasks, image paste, suspend, Vim editing, /hooks, /vim",
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
              value: "NOMO_TUI_COLOR=0 disables colour",
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
      hint: "Type / for commands, or press ? for this view at any time.",
    },
    { width: 76 },
  );
}

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
import { VOID_PALETTE } from "./theme.ts";
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
  /\.env\b|\.void|keychain/i,
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
  compactTools = true;
  mode: TuiMode = "normal";
  /** Runtime theme overrides. Undefined keeps the VOID_TUI_* environment. */
  colorOverride?: boolean;
  motionOverride?: boolean;
  queuedPrompt: string | null = null;
  queuedPromptPaused = false;
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
    return { messages, contextMessages, tokens: known ? tokens : null, docs };
  }
  private redactSecrets(value: string) {
    let out = value;
    for (const key of [
      "TOKENHARBOR_API_KEY",
      "TOKENROUTER_API_KEY",
      "NVIDIA_API_KEY",
      "OPENROUTER_API_KEY",
      "VOID_SIGNING_KEY",
      "VOID_VERIFY_KEY",
      "VOID_WORKSPACE_KEY",
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
    for (const record of usage.usage.slice(-20))
      lines.push(
        `${record.sessionId.slice(0, 8)} ${record.model} ` +
          `in ${record.inputTokens ?? "?"} out ${record.outputTokens ?? "?"} ` +
          `total ${record.totalTokens ?? "unknown"}`,
      );
    if (!usage.usage.length)
      lines.push("No usage records yet. Send a prompt first.");
    return lines;
  }
  providerLines() {
    const provider = this.provider;
    return [
      `Provider: ${provider?.providerId ?? "unknown"} | ${provider?.status ?? "unavailable"}`,
      ...(provider?.detail ? [provider.detail] : []),
      ...(provider?.retryAt ? [`Retry at: ${provider.retryAt}`] : []),
      ...(provider?.status === "setup-required"
        ? [
            "/connect shows credential setup. Never type a key into the terminal.",
          ]
        : []),
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
    return [
      "AGENTS, runtime catalog",
      `Selected for new conversations: ${this.agentId ?? "runtime default"}`,
      ...catalog.agents.map(
        (agent) =>
          `${agent.id === this.agentId ? ">" : " "} ${agent.id}: ${agent.name} / ${agent.description}`,
      ),
      "/agent ID selects a profile. Existing conversations keep their snapshot.",
      "/agent-file path.json reviews a custom profile before saving.",
      "File fields: id, name, systemPrompt, allowedTools, policyProfile, maxTurns, maxContextTokens.",
      `Operator policy profiles: ${catalog.policyProfiles.join(", ") || "none"}`,
      ...catalog.profiles.flatMap((profile) => {
        // This view names systemPrompt as a saveable field and then never
        // prints it, so the one line an operator needs to check what a profile
        // actually says to the model was the one line missing. Bounded because
        // a prompt is prose, and the marker says it was cut rather than
        // letting a truncated prompt look like the whole one.
        const prompt = profile.systemPrompt.trim();
        const shown = !prompt
          ? "(empty)"
          : prompt.length > 160
            ? `${prompt.slice(0, 160)}… (+${prompt.length - 160} chars)`
            : prompt;
        return [
          `Profile ${profile.id}: policy ${profile.policyProfile}, max turns ${profile.maxTurns}, max context tokens ${profile.maxContextTokens}`,
          `Allowed tools: ${profile.allowedTools.join(", ") || "none"}`,
          `System prompt: ${shown}`,
        ];
      }),
      "Prompt text does not grant tool or policy authority.",
      "",
      "CONVERSATIONS",
      ...(rows.length
        ? rows.map(
            (item) =>
              `[${item.status}] ${item.title ?? item.id} ${item.id.slice(0, 8)} ${item.model}`,
          )
        : ["No conversations yet."]),
      "",
      ...this.workbench
        .connectionState()
        .connectors.map(
          (item) => `connector: ${item.name} (${item.tools.length} tools)`,
        ),
    ];
  }
  memoryLines() {
    const views = this.workbench.allViews();
    const events = views.reduce((sum, item) => sum + item.events.length, 0);
    return [
      "MEMORY, retained local history, encrypted at rest",
      "",
      `Conversations: ${views.length} | Stored events: ${events}`,
      `Storage: ${this.env.VOID_DATA_DIR ?? "default workbench directory"}`,
      "Drafts persist per conversation between runs.",
      "Conversations retain their provider/model snapshot. Unreported cost stays unknown.",
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
        label: `[${run.state}] ${run.model} ${run.sessionId.slice(0, 8)} | progress ${run.progress === null ? "unknown" : `${Math.round(run.progress * 100)}%`}${run.reconcileRequired ? " | reconciliation required" : ""}`,
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
        label: `[${s.status}] ${s.title ?? s.id}${s.archived ? " [archived]" : ""}`,
        lines: json(s),
      }));
    if (this.tab === "documents")
      rows = this.workbench.documentsList().map((d) => ({
        id: `${d.sessionId}:${d.path}`,
        sessionId: d.sessionId,
        path: d.path,
        label: `${d.path}  ${d.bytes} B  ${d.sessionId.slice(0, 8)}`,
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
            label: `${id.slice(0, 8)} #${e.seq} [${text(b.klass)}] ${text(b.decision)} ${text(b.tool)}`,
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
            label: `proxy:${workspace} #${e.seq} [${text(b.klass)}] ${text(b.decision)} ${text(b.tool)}`,
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
            label: `learned ${id.slice(0, 8)} nothing learned`,
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
            label: `learned ${id.slice(0, 8)} ${text(rule.match.tool)} [${text(rule.match.class)}] -> ${rule.decision}`,
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
          label: "learned nothing learned",
          lines: [
            "0 verified entries, so no refusal has been observed and no rule was mined.",
            "Mined from the verified chain.",
          ],
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
        label: `harness ${prefs.defaultAgent ?? "cloud"}`,
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
          label: `hook ${hook.id} ${hook.enabled ? "on" : "off"}`,
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
          label: "hook none saved",
          lines: [
            harnessCatalog.hooksSupported
              ? "No hooks saved. /hook-file path.json reviews a save."
              : "No hooks saved, and execution is unsupported on this host.",
          ],
        });
      rows.reverse();
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
            label: approvalLabel(h),
            lines: json(h),
          };
        })
        .reverse();
    if (this.tab === "approvals")
      rows.push(
        ...this.proxy.holds.map(({ decisionToken, ...h }) => ({
          id: `proxy:${h.holdId}`,
          label: `[proxy pending] ${h.call.tool} ${h.holdId}`,
          lines: json(h),
        })),
      );
    if (this.tab === "tools")
      rows = this.workbench
        .availableTools(this.sessionId)
        .tools.map((tool) => ({
          id: tool.id,
          label: `[${tool.klass.toUpperCase()}] ${tool.name} / ${tool.source}${tool.capturedUndo ? " / captured Undo" : ""}`,
          lines: [
            `TOOL ${tool.name}`,
            `Source: ${tool.source}`,
            `Scope: ${this.sessionId ? "current conversation" : "new conversations"}`,
            tool.capturedUndo
              ? "Captured document Undo available."
              : "Undo is not guaranteed for this tool.",
            "",
            tool.description,
            "",
            "INPUT SCHEMA",
            ...json(tool.inputSchema),
            "",
            "The model requests tools through VOID policy and approvals.",
            "",
            REGISTRY_DISCLAIMER,
          ],
        }));
    if (this.tab === "policy")
      rows = this.workbench.connectionState().connectors.map((c) => ({
        id: c.id,
        label: `${c.name} (${c.tools.length} tools)`,
        lines: json(c),
      }));
    if (this.tab === "models")
      rows = (this.provider?.models ?? []).map((m) => ({
        id: m.id,
        label: `${m.id === this.model ? "[*]" : "[ ]"} ${m.name}  ${m.id}`,
        lines: json(m),
      }));
    if (this.tab === "usage")
      rows = activity(this.workbench.allViews()).usage.map((r) => ({
        id: r.id,
        sessionId: r.sessionId,
        label: `${r.model} ${r.sessionId.slice(0, 8)} | tokens ${r.totalTokens ?? "unknown"} | cost unknown`,
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
  async openSelected() {
    const row = this.items()[this.selected];
    if (!row) return;
    if (this.tab === "overview") {
      this.useSession(row.sessionId!);
      this.detail = row.lines;
      this.scroll = 0;
      return;
    }
    if (this.tab === "sessions" || this.tab === "usage") {
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
    if (this.tab === "models") {
      this.model = row.id;
      this.notice = `New conversation model: ${row.id}. Existing conversations keep their original model.`;
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
    this.detail = row.lines;
    this.scroll = 0;
  }
  showDocument() {
    if (!this.sessionId || !this.documentPath)
      throw Error("Select a document with Enter or /document path.");
    const d = this.workbench.document(this.sessionId, this.documentPath);
    this.detail = [
      `DOCUMENT ${this.documentPath}`,
      `Revision: ${d.revision ?? "new document"}`,
      "",
      ...(d.content ?? "").split("\n"),
      "",
      "/edit edit | /history revisions | /undo preview recovery | /export document",
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
        this.notice = "Saved. The signed change and Undo are in the ledger.";
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
        this.notice = "Undo completed and signed. History is preserved.";
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
   * than implying a count VOID does not have. */
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
    return [
      "CONNECTORS, only confirmed ones give a conversation tools",
      "",
      ...this.connectorRows().flatMap((c) => [
        `${pad(c.name, 22)}  ${c.consent}  ${c.tools.length} tools`,
        `  ${fit(c.endpoint, 60)}`,
        `  id ${c.id}`,
        c.builtin
          ? "  in use: the VOID document workspace"
          : `  next: ${MCP_NEXT[c.consent](c.id)}`,
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
          `This is the only request VOID makes, and it goes to ${c.endpoint}.`,
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
      const ops = this.workbench.workspace(this.sessionId).operations;
      const undone = new Set(ops.flatMap((o) => (o.undoes ? [o.undoes] : [])));
      const open = ops.filter(
        (o) =>
          o.kind !== "undo" &&
          !undone.has(o.id) &&
          (!this.documentPath || o.path === this.documentPath),
      );
      if (!open.length) {
        this.detail = ["No outstanding changes. Every edit is undone or kept."];
        this.scroll = 0;
        return;
      }
      this.detail = [
        `DIFF of outstanding changes${this.documentPath ? ` in ${this.documentPath}` : ""}, newest last`,
        "",
        ...open.flatMap((o) => [
          `--- ${o.path} (${o.kind} ${o.id.slice(0, 8)})`,
          ...unifiedDiff(
            o.before ?? "[does not exist]",
            o.after ?? "[does not exist]",
          ),
          "",
        ]),
        "Use /undo ID for reviewed Undo of one operation.",
      ];
      this.scroll = 0;
      return;
    }
    if (cmd === "keybindings") {
      this.detail = [...KEYBINDINGS];
      this.scroll = 0;
      return;
    }
    if (cmd === "theme") {
      // Session override only. Lasting choice stays in the environment,
      // so a checked out repository can never restyle another operator.
      if (arg === "color") this.colorOverride = true;
      else if (arg === "mono") this.colorOverride = false;
      else if (arg === "motion") this.motionOverride = true;
      else if (arg === "still") this.motionOverride = false;
      else if (arg === "reset") {
        this.colorOverride = undefined;
        this.motionOverride = undefined;
      } else if (arg)
        throw Error("/theme color | mono | motion | still | reset");
      const color = this.colorOverride ?? this.env.VOID_TUI_COLOR !== "0";
      const motion =
        this.motionOverride ??
        (this.env.VOID_TUI_MOTION !== "0" && this.env.TERM !== "dumb");
      this.detail = [
        `THEME this session: ${color ? "full color" : "monochrome"}, motion ${motion ? "on" : "off"}`,
        "",
        ...Object.entries(VOID_PALETTE).map(
          ([name, hex]) => `${name.padEnd(6)} ${hex}`,
        ),
        "",
        "Color never carries safety meaning; classes keep their markers.",
        "Persist with VOID_TUI_COLOR=0 or VOID_TUI_MOTION=0. /theme reset restores them.",
      ];
      this.scroll = 0;
      this.notice = `Theme: ${color ? "full color" : "monochrome"}, motion ${motion ? "on" : "off"}.`;
      return;
    }
    if (cmd === "status") {
      this.choose("overview");
      this.detail = this.statusLines();
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
      // what VOID has learned is asking about the ledger as a whole.
      const learned = [...this.proofs.entries()].flatMap(([id, entries]) =>
        mineLearnedRules(entries).map((rule) => ({ id, rule })),
      );
      const verified = [...this.proofs.values()].reduce(
        (sum, e) => sum + e.length,
        0,
      );
      this.detail = [
        "LEARNED RULES, mined from the verified chain",
        "",
        verified
          ? `${verified} verified entries, ${learned.length} recurring refusals.`
          : "No verified entries yet, so nothing has been learned.",
        "",
        ...(learned.length
          ? learned.flatMap(({ id, rule }) => [
              `${id.slice(0, 8)} ${rule.match.tool} (${rule.match.class}) -> ${rule.decision}`,
              `  ${rule.rationale ?? "no rationale recorded"}`,
            ])
          : []),
        "",
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
    if (cmd === "memory") {
      this.detail = this.memoryLines();
      this.scroll = 0;
      return;
    }
    if (cmd === "vim" || cmd === "terminal-setup" || cmd === "output-style")
      throw Error(
        `/${cmd} has no VOID equivalent. Use /expand for tool output style.`,
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
            "Current documents are copied. New tool calls go through VOID again.",
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
      this.choose("help");
      this.detail = [
        "COMMAND PALETTE",
        "",
        "Fuzzy search every / command; Enter runs the selection.",
        "Recent commands first (this conversation).",
        "",
        ...TUI_COMMANDS.map(([c, hint]) => `${c}  ${hint}`),
      ];
      this.scroll = 0;
      this.notice = "Palette: type to filter, Enter run, Esc close.";
      return;
    }
    throw Error("Unknown command. Use /help to see available commands.");
  }
  async export(kind: string) {
    const folder = resolve(this.env.VOID_EXPORT_DIR ?? "void-exports");
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
        ...this.items().map(
          (r, i) => `${i === this.selected ? ">" : " "} ${i + 1}. ${r.label}`,
        ),
      ];
    if (this.tab === "help") return HELP;
    if (this.tab === "chat")
      return this.session()
        ? transcript(this.session()!.events)
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
      return [
        "VOID / LOCAL WORKSPACE",
        "",
        ...this.providerLines(),
        `Model: ${this.model || "-"}`,
        `Active work: ${this.workbench.running() ? "running or settling" : "none"}`,
        `Conversations: ${this.workbench.list().length} | Documents: ${this.workbench.documentsList().length} | Pending approvals: ${this.workbench.pending().length + this.proxy.holds.length}`,
        `Ledger: ${[...this.proofs.values()].reduce((n, p) => n + p.length, 0)} managed + ${[...this.proxy.entries.values()].reduce((n, p) => n + p.length, 0)} proxy entries`,
        // The bare word "verified" is the defect the audit named here: it does
        // not say which key answered, so a chain checked against a trust file
        // the agent can also replace read the same as one checked against a
        // key the operator handed over. The status names the answer, and the
        // long caveat follows it on its own line.
        `Proxy signatures: ${this.proxy.entries.size ? (this.proxy.signed ? this.proxy.verificationStatus : "NOT VERIFIED (integrity only)") : "no entries"} | Errors: ${this.proofErrors.size + this.proxy.errors.length}`,
        ...(this.proxy.entries.size && this.proxy.verificationNote
          ? [`Proxy verification key: ${this.proxy.verificationNote}`]
          : []),
        "",
        `Runs: ${o.runs} | Failures: ${o.failed}`,
        ...this.items().map(
          (row, i) =>
            `${i === this.selected ? ">" : " "} ${i + 1}. ${row.label}`,
        ),
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
    if (this.tab === "policy")
      return [
        "MANAGED DOCUMENTS",
        "R0 reads; R1 writes with capture and verified Undo.",
        "",
        "DEFAULT POLICY FOR EXTERNAL MCP",
        ...DEFAULT_POLICY.split("\n"),
        "Unknown tools are denied. Expired approvals cannot release tools.",
        "Each new conversation snapshots its policy.",
        "",
        "/policy-file ID path.yaml changes the policy for a specific connector.",
        "",
        ...this.items().flatMap((r) => [r.label, ...r.lines, ""]),
      ];
    const rows = this.items();
    return rows.length
      ? rows.map(
          (r, i) => `${i === this.selected ? ">" : " "} ${i + 1}. ${r.label}`,
        )
      : [
          "No entries yet.",
          this.tab === "tools"
            ? "/mcp add https://host/mcp stages a server. /mcp probe ID contacts it."
            : "",
        ];
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
      `[${e.at.slice(11, 19)}] ${e.kind === "user" ? "YOU" : e.kind === "assistant" ? "VOID" : e.kind.toUpperCase()}`,
      ...e.text.split("\n"),
      "",
    );
  }
  if (partial) rows.push("VOID [stream]", ...partial.split("\n"));
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
    const label =
      event.kind === "user"
        ? "› You"
        : event.kind === "assistant"
          ? "● VOID"
          : event.kind === "error"
            ? "! Error"
            : event.type === "tool.started"
              ? "◇ Tool request"
              : "◆ Tool result";
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
  if (partial) messageRows(partial, "assistant", "● VOID  streaming");
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
  ["/memory", "Retained local history"],
  ["/model", "Set model for new chats"],
  ["/plan", "Switch to plan mode"],
  ["/stats", "Token usage and cost"],
  ["/diff", "Outstanding document changes"],
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
// Block capitals, one stroke width everywhere. The slashed ASCII logo
// read as jagged because every row leaned; full blocks stay uniform at
// any width and count one cell each in layout.ts.
const VOID_LOGO = [
  "█     █   █████   █████  ████   ",
  "█     █  █     █    █    █   █  ",
  "█     █  █     █    █    █   █  ",
  " █   █   █     █    █    █   █  ",
  "  █ █     █████   █████  ████   ",
];
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
export const MODE_ICON: Record<TuiMode, string> = {
  normal: "◆",
  accept: "●",
  plan: "○",
};
// Continuous prompt frame. The old dashed rails left the composer sides open,
// which read as interrupted lines. Box drawing with joined corners keeps one
// unbroken border at every width.
export function promptFrameTop(title: string, width: number): string {
  // Titles longer than the frame truncate with a marker, never wrap past it.
  const fitted = fit(title, Math.max(1, width - 6));
  const head = `╭─ ${fitted} `;
  const tail = Math.max(0, width - visibleLength(head) - 1);
  return `${head}${"─".repeat(tail)}╮`;
}
export function promptFrameBottom(width: number): string {
  return `╰${"─".repeat(Math.max(0, width - 2))}╯`;
}
export function promptFrameRow(content: string, width: number): string {
  return `│ ${pad(content, Math.max(0, width - 4))} │`;
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
  const ink = (value: string, code: string) =>
    visuals.color ? `\x1b[${code}m${value}\x1b[0;48;5;234;38;5;252m` : value;
  const text = (value: string) => fit(sanitizeText(value), width);
  const amber = "38;5;215",
    ice = "38;5;117",
    muted = "38;5;245",
    violet = "38;5;183";
  const running = busy || ui.workbench.running();
  const frame = visuals.motion === false ? 0 : (visuals.frame ?? 0);
  const spinner = running ? SPINNER_FRAMES[frame % SPINNER_FRAMES.length] : "◆";
  const pending = ui.workbench.pending();
  const holds = pending.length + ui.proxy.holds.length;
  const waiting = pending.some((hold) =>
    hold.holdId.startsWith(`${ui.sessionId}:`),
  );
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
      "VOID / local workspace",
      ui.session()?.model || ui.model || "Connect a model with /connect",
      running ? "Working / Esc to stop" : "Your work. Your control.",
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
      const logoRow =
        i === 0 || i === mark.length - 1
          ? " ".repeat(32)
          : (VOID_LOGO[i - 1] ?? " ".repeat(32));
      const left =
        markRow +
        "  " +
        ink(
          logoRow,
          `1;${(visuals.boot || running) && frame % 5 === i ? ice : amber}`,
        );
      header.push(
        left +
          (width >= 78
            ? ink(
                fit(
                  sanitizeText("   " + (aside[i] ?? "")),
                  width - visibleLength(left),
                ),
                i === 1 ? ice : muted,
              )
            : ""),
      );
    });
  } else
    header.push(
      ink(
        text(
          ` /V/  VOID  ${ui.session()?.model || ui.model || ui.tab}  |  ${holds} approvals`,
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
          const name =
            t === ui.tab
              ? ink(` [${t}] `, `1;${ice};48;5;24`)
              : ink(` ${t} `, muted);
          return `${icon}${name}`;
        })
        .join(""),
      width,
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
  // Inside the frame the row keeps 2 side cells plus a 2 cell prompt prefix,
  // so text wraps at width - 6 and the border never breaks mid line.
  const composerInner = Math.max(1, width - 6);
  const composer = wrap(
    (
      input ||
      (editing
        ? "Ask anything or type / for commands"
        : "i type / Enter details")
    ).split("\n"),
    composerInner,
  );
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
  const bodyHeight = Math.max(
    1,
    height - header.length - banner.length - 5 - composerHeight - menu.length,
  );
  const richChat =
    ui.tab === "chat" && !!ui.session() && !ui.detail && !ui.confirmation;
  let content = richChat ? [] : ui.lines();
  if (ui.tab === "chat" && !ui.session() && !ui.detail && !ui.confirmation)
    content = [
      "",
      "  Welcome to VOID.",
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
  if (!ui.detail && !ui.confirmation && ui.tab === "chat" && ui.scroll < 0)
    offset = Math.max(0, lines.length - bodyHeight);
  if (
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
      line.startsWith("› You") ||
      / YOU$/.test(line)
        ? index
        : -1,
    )
    .filter((index) => index >= 0);
  const body = lines.slice(offset, offset + bodyHeight);
  while (body.length < bodyHeight) body.push("");
  const frameColor = ui.confirmation ? amber : muted;
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
              ? muted
              : style === "error"
                ? "38;5;203"
                : style === "text"
                  ? "38;5;252"
                  : /^>/.test(line)
                    ? `1;${ice}`
                    : /YOU$/.test(line)
                      ? `1;${violet}`
                      : /VOID(?: \[stream\])?$/.test(line)
                        ? `1;${amber}`
                        : /^(Error|Invalid|Failed)/.test(line)
                          ? "38;5;203"
                          : "38;5;252";
    return (
      ink(ui.confirmation ? "! " : "  ", frameColor) +
      ink(pad(line, width - 4), tone) +
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
  const phase =
    lastEvent?.type === "tool.started"
      ? "[tool] Calling tool"
      : lastEvent?.type === "message.delta"
        ? "[write] Writing response"
        : "[think] Thinking";
  // Live ellipsis, frozen when motion is off so paused frames stay equal.
  const dots =
    visuals.motion === false ? "" : ".".repeat(1 + (Math.floor(frame / 3) % 3));
  const historyStatus =
    richChat && ui.scroll >= 0
      ? `History ${offset + 1}-${Math.min(offset + bodyHeight, lines.length)}/${lines.length} / /bottom to follow`
      : undefined;
  const usage = [...(ui.session()?.events ?? [])]
    .reverse()
    .find((event) => event.kind === "usage")?.payload;
  const tokens =
    typeof usage?.total_tokens === "number" ? usage.total_tokens : "unknown";
  const cost = typeof usage?.cost === "number" ? usage.cost : "unknown";
  const model = sanitizeText(
    ui.session()?.model || ui.model || "not connected",
  );
  const ctx = ui.session() ? ui.contextNumbers() : null;
  const ctxText = ctx
    ? `${ctx.contextMessages ?? "unknown"} messages`
    : "no session";
  const holdBadge =
    holds > 0 ? ` | ◉ ${holds} approval${holds === 1 ? "" : "s"}` : "";
  const queuedBadge = ui.queuedPrompt
    ? ` | +1 ${ui.queuedPromptPaused ? "paused" : "queued"}`
    : "";
  // The tail (mode, tokens, compact) must survive narrow frames, so a long
  // model name shrinks first instead of truncating the status fields.
  let modelShown = fit(model, 20);
  // Cost stays visible when it fits; the full cost report lives in /cost.
  const costSeg = ` | cost: ${cost}`;
  let dropCost = false;
  const summaryTail = (): string =>
    ` | ${MODE_ICON[ui.mode]} ${modeAuthorityLabel(ui.mode)} | ctx: ${ctxText} | ` +
    `tokens: ${tokens}${dropCost ? "" : costSeg} | ${ui.compactTools ? "compact" : "full"}${holdBadge}${queuedBadge}`;
  if (visibleLength(`◐ model: ${modelShown}${summaryTail()}`) > width)
    dropCost = true;
  while (
    visibleLength(`◐ model: ${modelShown}${summaryTail()}`) > width &&
    visibleLength(modelShown) > 8
  )
    modelShown = fit(modelShown, visibleLength(modelShown) - 1);
  const summary = `◐ model: ${modelShown}${summaryTail()}`;
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
  const status = ui.confirmation
    ? "[!] REVIEW / y accept / n reject / Esc cancel / PgDn preview"
    : running && (busy || ui.session()?.status === "running")
      ? `${spinner} ${ui.session()?.status === "running" ? (waiting ? "[wait] Waiting for approval" : `● ${phase}${dots}`) : `[run] Finishing operation${dots}`}${elapsed} / Esc stop${historyStatus ? " / [history] reading history" : ""}${todoBadge}`
      : (historyStatus ?? ui.notice);
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
  // One frame, joined corners, no gaps: top, rows with vertical sides, bottom.
  const frameTitle = editing
    ? `${modeIndicator} Write a prompt [${ui.mode.toUpperCase()}]`
    : `${TAB_ICONS[ui.tab]} ${ui.tab} / navigation`;
  const promptBox = [
    promptFrameTop(frameTitle, width),
    ...composer
      .slice(composerStart, composerStart + composerHeight)
      .map((value, i) =>
        promptFrameRow(
          `${i === 0 ? (editing ? "› " : ": ") : "  "}${value}`,
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
    ...banner.map((row) => ink(text(row), `1;${amber}`)),
    ...bodyRows,
    ink(text(summary), ice),
    ink(text(status), ui.confirmation ? `1;${amber}` : running ? amber : muted),
    ...menuRows,
    ...promptBox.map((row) => ink(row, frameTone)),
    ink(
      text(
        candidates.length
          ? "↑↓ select / Tab complete / Enter run / Esc close"
          : editing
            ? ui.mode === "plan"
              ? "○ PLAN / Enter sends a plan request / Shift+Tab or Alt+M mode / Ctrl+J newline / Ctrl+T todos / Esc navigate"
              : ui.mode === "accept"
                ? "● ACCEPT / approvals stay explicit / Enter send / Shift+Tab or Alt+M mode / Ctrl+J newline / Ctrl+T todos"
                : "Enter send / Shift+Enter or Ctrl+J or \\+Enter newline / Ctrl+R search / Ctrl+O output / Ctrl+T todos / Esc Esc clear / Esc navigate"
            : "Tab panels / i type / Enter open / Esc back / u Undo / ? keys",
      ),
      muted,
    ),
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
const KEYBINDINGS = [
  "KEYBINDINGS, same action as the reference terminal where VOID has it",
  "",
  "Enter send | Shift+Enter, Alt+Enter, Ctrl+J or backslash+Enter newline",
  "Left/Right move cursor, or cycle panels outside editing",
  "Esc stop a run or close | Esc Esc clear input, or checkpoints when empty",
  "Shift+Tab or Alt+M cycle mode (normal / accept / plan)",
  "Tab panels, complete, accept suggestion | Up/Down or Ctrl+P/N history",
  "Ctrl+R search prompts | Ctrl+O tool output | Ctrl+L redraw, twice clear",
  "Ctrl+S stash, again restore | Ctrl+G or Ctrl+X Ctrl+E editor",
  "Ctrl+T checklist | Meta+P models | { and } jump between prompts",
  "Ctrl+W to whitespace, Alt+D word, Ctrl+K line, Ctrl+U clear, Ctrl+Y paste",
  "Ctrl+_ undo input | Alt+B/F or Ctrl+Left/Right word jump | Ctrl+A/E line ends",
  "Ctrl+D delete forward, twice exit | Ctrl+C clear, cancel, exit",
  "y accept, n reject, Esc cancel a review | PgUp/PgDn scroll",
  "No VOID equivalent: background tasks, image paste, suspend, Vim editing.",
];
const HELP = [
  "VOID TUI: real local data, no demo metrics",
  "",
  "Tab panels (Left/Right too); Shift+Tab or Alt+M: mode (normal / accept / plan); Enter: details.",
  "Chat: start typing. / opens commands; arrows select; Tab completes.",
  "@path mentions quote a managed document into the prompt on send.",
  "PgUp/PgDn: scroll; /bottom or Ctrl+End: follow latest; i: type.",
  "/find text searches the current conversation; Esc closes results.",
  "Esc stops a run, or closes details. Esc Esc clears input, or lists checkpoints when empty.",
  "A prompt sent during a run is queued and sends when the run stops.",
  "!command runs a gated local shell; output shows once, never persists.",
  "Up/Down or Ctrl+P/Ctrl+N browse your previous prompts in single-line input.",
  "VOID_TUI_COLOR=0 disables colors; VOID_TUI_MOTION=0 disables animation.",
  "Enter sends; Shift+Enter, Alt+Enter, Ctrl+J or backslash+Enter inserts a newline.",
  "Ctrl+R searches your prompts, or conversation text from empty input.",
  "Ctrl+O toggles tool output; Ctrl+L redraws, twice clears; Ctrl+S stashes input.",
  "Ctrl+G opens the document editor; Meta+P jumps to models.",
  "/keybindings lists every shortcut; /plan switches to plan mode.",
  "Ctrl+T shows the checklist from agent output; { and } jump between prompts.",
  "Ctrl+X Ctrl+E opens the editor; Ctrl+D deletes forward, twice exits.",
  "Ctrl+D exits only from an empty input. Ctrl+C clears, cancels or exits.",
  "Alt+B/F move by word; Alt+D deletes a word; Ctrl+Y pastes killed text; Ctrl+_ undoes input.",
  "Confirmations show a unified diff; y accepts, n rejects, Esc cancels.",
  "Plan mode prefixes prompts so the model plans before acting.",
  "Accept mode shortens edit keys; tool approvals always stay explicit.",
  "Navigation: n new chat; u preview Undo; a/d approvals; q quit.",
  "",
  "/new [prompt] | /clear | /open number-or-ID | /resume [number-or-ID]",
  "/status | /cost | /context | /compact | /rewind [operation-IDs]",
  "/rewind run exact-run-ID | /recovery [job-ID] (read-only status)",
  "/queue [resume] | /cancel (queued text)",
  "/todos | /agents | /agent ID | /memory | /permissions | /sessions",
  "/mcp inspect ID | /mcp add URL [name] | /mcp probe ID",
  "/mcp confirm ID | /mcp rename ID name | /mcp remove ID",
  "/projects | /project ID|none | /project-file path.json",
  "/agent-file path.json | /hooks | /hook-file path.json (if supported)",
  "/stop | /branch [seq] | /retry | /rename title | /archive",
  "/models | /model exact-ID | /connect opencode:zen | /login | /logout",
  "/providers lists model providers incl. local open models",
  "/harness cloud | /harness prime-agent switches the agent harness",
  "/conformance [adapter] runs the disposable adapter checks",
  "/theme [color|mono|motion|still|reset] session theme",
  "/documents | /document path | /edit | /history | /undo [operation-ID]",
  "/ledger | /verify | /filter text | /export ledger|chat|document",
  "/attest signs this conversation slice for offline third party checks",
  "/approvals | /approve [hold-ID] [reason] | /deny [hold-ID] [reason]",
  "/tools [search] | Enter inspect tool | /expand compact/full tool output",
  "/config shows paths and flags without secrets; /sources lists providers.",
  "/hooks /vim /terminal-setup /output-style have no VOID equivalent.",
  "Ctrl+B background tasks, image paste, suspend and Vim editing have no VOID equivalent.",
  "/connector-file path.json stages a server | /test-connector ID",
  "Multiline: Up/Down move cursor | Ctrl+W delete to whitespace | Ctrl+K delete to line end | Ctrl+U clear",
  "/policy | /policy-file connector-ID path.yaml | /usage | /overview",
  "",
  'Editor: VOID_TUI_EDITOR is a JSON array, e.g. ["code","--wait"].',
  "Otherwise EDITOR is an executable path; default: nano. Confirm edits in TUI.",
  "Revision conflicts never overwrite changes. Undo and approvals require confirmation.",
  "Branches copy text context and current documents; tools are never replayed.",
  "The free model is never automatically replaced with a paid model.",
  "Exports use file permissions 0600 and never overwrite existing files.",
  "Data is encrypted in VOID_DATA_DIR, default: ~/.void/workbench.",
  "Local TUI does not read private cloud conversations.",
];

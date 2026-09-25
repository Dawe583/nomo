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
import { activity } from "../../../workbench/src/gui.ts";
import { PROVIDER_PRESETS } from "../../../workbench/src/provider-defaults.ts";
import { canonicalJson } from "../../../ledger/src/canonical.ts";
import type { JsonlEntry } from "../../../ledger/src/store.ts";
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
  meter,
  pad,
  sanitizeText,
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
  apply: () => Promise<void>;
};
const json = (value: unknown) =>
  JSON.stringify(value, null, 2)?.split("\n") ?? [];
const text = (value: unknown) => String(value ?? "unknown");

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
  model = "";
  filter = "";
  compactTools = true;
  mode: TuiMode = "normal";
  /** Runtime theme overrides. Undefined keeps the VOID_TUI_* environment. */
  colorOverride?: boolean;
  motionOverride?: boolean;
  queuedPrompt: string | null = null;
  notice = "Tab: panels | i: type | /help: commands";
  detail?: string[];
  confirmation?: Confirmation;
  provider?: Awaited<ReturnType<Workbench["providerState"]>>;
  proofs = new Map<string, JsonlEntry[]>();
  proofErrors = new Map<string, string>();
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
    this.proofs.clear();
    this.proofErrors.clear();
    for (const session of this.workbench.list()) {
      try {
        const proof = await this.workbench.ledger(session.workspace);
        if (proof) this.proofs.set(session.id, [...proof.entries]);
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
  queuePrompt(value: string) {
    this.queuedPrompt = value.slice(0, 32000);
    this.notice =
      "Run is active. The prompt is queued and sends when it stops.";
  }
  takeQueued(): string | null {
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
  /** Message and token counts from retained events, never estimated. */
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
    return { messages, limit: 199, tokens: known ? tokens : null, docs };
  }
  private redactSecrets(value: string) {
    let out = value;
    for (const key of [
      "TOKENHARBOR_API_KEY",
      "TOKENROUTER_API_KEY",
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
      const result = await runShellFile("sh", ["-c", cmd], {
        env: { PATH: "/usr/bin:/bin", LANG: "C" },
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
          : `Local command failed. ${message(error)}`,
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
      return [".pdf", ".exe", ".dll", ".so", ".dylib", ".bin", ".dat"].includes(ext);
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
  /** Local extractive summary; the provider path has no contract yet. */
  compactLines() {
    const session = this.session();
    if (!session) throw Error("Select a conversation to summarize.");
    const turns = (session.events ?? []).filter(
      (event) => event.kind === "user" || event.kind === "assistant",
    );
    const first = turns.find((event) => event.kind === "user");
    const last = [...turns]
      .reverse()
      .find((event) => event.kind === "assistant");
    const ctx = this.contextNumbers();
    const todos = extractTodos(session.events ?? []);
    const open = todos.filter((item) => !item.done).length;
    return [
      `COMPACT SUMMARY, local fallback: ${session.title ?? session.id}`,
      "Provider summarization is not part of the Workbench contract,",
      "so this summary is built from retained events only.",
      "",
      `Messages: ${ctx.messages} of ${ctx.limit} | ` +
        `Tokens: ${ctx.tokens ?? "unknown"} | Documents: ${ctx.docs}`,
      `Open checklist items: ${open} of ${todos.length}`,
      "",
      `First request: ${(first?.text ?? "(none)").slice(0, 300)}`,
      "",
      `Latest answer: ${(last?.text ?? "(none)").slice(0, 500)}`,
      "",
      "Use /branch to continue from an earlier message in a safe copy.",
    ];
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
  statusLines() {
    const ctx = this.session() ? this.contextNumbers() : null;
    return [
      `Provider: ${this.provider?.connected ? this.provider.providerId : "NOT CONNECTED"}`,
      `model: ${this.session()?.model || this.model || "-"} | Mode: ${this.mode}`,
      `Run: ${this.workbench.running() ? "running or settling" : "idle"}`,
      ctx
        ? `Context: ${ctx.messages}/${ctx.limit} messages | ` +
          `tokens: ${ctx.tokens ?? "unknown"} | cost: unknown`
        : "No conversation selected.",
      `Conversations: ${this.workbench.list().length} | ` +
        `Pending: ${this.workbench.pending().length + this.proxy.holds.length}`,
      this.queuedPrompt
        ? "One prompt is queued for the end of the run."
        : "No queued prompt.",
    ];
  }
  agentsLines() {
    const rows = [...this.workbench.list()].reverse();
    return [
      "AGENTS, conversations and connectors, live data",
      "",
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
      "The free model is never replaced with a paid model.",
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
            lines: ["[OK] Hash chain and signature verified", ...json(e)],
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
                ? "[OK] Proxy signatures and hash chain verified"
                : "[!] Proxy: hash integrity only, signature NOT VERIFIED",
              ...json(e),
            ],
          });
        }
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
      rows = activity(this.workbench.allViews()).runs.map((r) => ({
        id: r.id,
        sessionId: r.sessionId,
        label: `${r.status} ${r.model} ${r.sessionId.slice(0, 8)}`,
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
        const current = await this.workbench.undoPreview(
          sessionId,
          operationId,
        );
        if (canonicalJson(current) !== canonicalJson(preview))
          throw Error("The preview changed. Request /undo again.");
        await this.workbench.undo(sessionId, operationId, "tui-operator");
        this.detail = undefined;
        this.notice = "Undo completed and signed. History is preserved.";
      },
    };
    this.scroll = 0;
  }
  prepareApproval(kind: "approved" | "denied", id?: string, reason = "") {
    id ??= this.items()[this.selected]?.id;
    if (id?.startsWith("proxy:")) {
      const hold = this.proxy.holds.find((h) => `proxy:${h.holdId}` === id);
      if (!hold) throw Error("Proxy hold is no longer active.");
      const { decisionToken, ...visible } = hold;
      this.confirmation = {
        title: `PROXY ${kind === "approved" ? "APPROVE" : "DENY"}?`,
        lines: json(visible),
        apply: async () => {
          this.proxy.decide(hold.holdId, kind, reason);
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
    this.confirmation = {
      title: `${kind === "approved" ? "APPROVE" : "DENY"} TOOL?`,
      lines: [
        ...json(hold),
        "",
        `Reason: ${reason || "(not provided)"}`,
        "External effects may not support Undo.",
      ],
      apply: async () => {
        if (
          !this.workbench.decide(hold.holdId, {
            kind,
            by: "tui-operator",
            reason,
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
            )
          ).id,
        );
      this.choose("chat");
      return;
    }
    const cmd = match[1]!,
      arg = match[2]?.trim() ?? "";
    if (WORKSPACE_TABS.includes(cmd as WorkspaceTab)) {
      this.choose(cmd as WorkspaceTab);
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
      // queuePrompt only ever stores text, so cancelling means dropping the
      // queued value. Claiming a cancel with nothing queued would report a
      // state the operator cannot verify.
      this.notice = this.queuedPrompt
        ? "Queued prompt cancelled."
        : "No prompt is queued.";
      this.queuedPrompt = null;
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
      const used = ctx.messages;
      const limit = ctx.limit;
      const percent = Math.round((used / limit) * 100);
      const thresholdWarn = percent >= 90 ? " ⚠️ threshold exceeded" : "";
      this.detail = [
        `CONTEXT ${this.session()?.title ?? this.sessionId}`,
        "",
        `Model: ${this.session()?.model ?? this.model}`,
        `Messages: ${ctx.messages} of ${ctx.limit} ${percent > 0 ? `(${percent}%)` : ""}${thresholdWarn}`,
        `Tokens reported: ${ctx.tokens ?? "unknown"}`,
        "Cost: unknown",
        `Managed documents: ${ctx.docs}`,
        "",
        ...this.workbench
          .documentsList()
          .filter((item) => item.sessionId === this.sessionId)
          .map((item) => `${item.path} ${item.bytes} B`),
        "",
        progressBar(used, limit, 20),
      ];
      this.scroll = 0;
      return;
    }
    if (cmd === "permissions" || cmd === "mcp") {
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
      this.choose("overview");
      const queued = this.queuedPrompt;
      this.detail = [
        "QUEUED PROMPT",
        "",
        queued ? `Pending: ${queued}` : "No queued prompt.",
        "",
        "The queued prompt will be sent at the end of the current run.",
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
      this.detail = this.compactLines();
      this.scroll = 0;
      this.notice = "Local summary. Provider summarization is unavailable.";
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
    if (cmd === "agents") {
      this.detail = this.agentsLines();
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
    if (
      cmd === "hooks" ||
      cmd === "vim" ||
      cmd === "terminal-setup" ||
      cmd === "output-style"
    )
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
    if (cmd === "rewind") {
      if (arg) {
        await this.prepareUndo(arg);
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
    if (cmd === "login") {
      this.provider = await importDesktopProvider(
        arg || "opencode:zen",
        this.env,
        this.workbench,
      );
      this.model = this.provider.defaultModel ?? "";
      this.notice = `Connected to ${this.provider.providerId}. The key is stored encrypted.`;
      return;
    }
    if (cmd === "logout") {
      this.workbench.clearProvider();
      this.provider = await this.workbench.providerState();
      this.model = "";
      this.notice = "Provider disconnected. Saved profiles were removed.";
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
      this.workbench.cancel(this.sessionId);
      this.notice = "Cancelling. A dispatched tool may still complete.";
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
      const child = await this.workbench.branch(s.id, {
        seq,
        snapshotDocuments: true,
      });
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
    if (cmd === "connect") {
      // Local credential sources only: opencode or prime auth files, or an
      // explicit OPENCODE_ZEN_API_KEY in the environment. Nothing is typed
      // into the repo and no key travels in a command argument.
      this.provider = await importDesktopProvider(
        arg || "opencode:zen",
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
        "Third parties recheck exports with scripts/src/verify-ledger-standalone.mjs.";
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
      await this.workbench.addConnector(config);
      this.choose("tools");
      this.notice =
        "MCP connected. A new conversation will load the current catalog.";
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
            "Press i to type; Enter to send; Shift+Enter or Ctrl+J for a new line.",
            "Example: Create a plan and save it to plan.md.",
            "",
            "/connect imports OpenCode Zen from local auth or OPENCODE_ZEN_API_KEY.",
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
        `Provider: ${this.provider?.connected ? this.provider.providerId : "NOT CONNECTED"} | model: ${this.model || "-"}`,
        `Run: ${this.workbench.running() ? "running or settling" : "idle"}`,
        `Conversations: ${this.workbench.list().length} | Documents: ${this.workbench.documentsList().length} | Pending approvals: ${this.workbench.pending().length + this.proxy.holds.length}`,
        `Ledger: ${[...this.proofs.values()].reduce((n, p) => n + p.length, 0)} managed + ${[...this.proxy.entries.values()].reduce((n, p) => n + p.length, 0)} proxy entries`,
        `Proxy signatures: ${this.proxy.entries.size ? (this.proxy.signed ? "verified" : "NOT VERIFIED (integrity only)") : "no entries"} | Errors: ${this.proofErrors.size + this.proxy.errors.length}`,
        ...this.proofErrors.values(),
        "",
        `Completed runs: ${o.runs} | Failures: ${o.failed}`,
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
            ? "/connector-file file.json connects a real MCP server."
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
  ["/rewind", "Review a recoverable checkpoint"],
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
  ["/compact", "Summarize context, local fallback"],
  ["/todos", "Checklist from agent output"],
  ["/agents", "Conversations and connectors"],
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
  ["/mcp", "MCP connectors and policy"],
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
 * Command palette over the / menu.
 *
 * The candidates arrive already filtered and prefix ordered from
 * commandSuggestions, so the overlay cannot name a command the menu under it
 * would not offer, and the marked row is the one Enter runs. Scoring the
 * command list a second time here would only rank it differently from the menu
 * it claims to show.
 */
export function commandPaletteRows(
  palette: NonNullable<WorkspaceVisuals["palette"]>,
  columns: number,
  color: boolean,
  rows: number,
): string[] {
  const width = Math.min(78, Math.max(20, columns));
  // The frame paints the background and pads every row, so a palette row
  // carries the tone only. These mirror the frame tones in renderWorkspace:
  // the palette sits inside that frame, and a second mapping for the same
  // surface would read as a different one.
  const mutedTone = "38;5;245",
    selectedTone = "1;38;5;215";
  const ink = (value: string, tone: string): string =>
    color ? `\x1b[${tone}m${value}\x1b[0m` : value;
  // Half the rows the frame reserves for chrome, so opening the palette cannot
  // push the composer off a short terminal.
  const height = Math.max(1, Math.min(6, Math.floor((rows - 12) / 2)));
  if (!palette.candidates.length)
    return [ink(`No command matches /${palette.query}`, mutedTone)];
  // index -1 means nothing is selected yet: over a box that is not a / query
  // there is no command Enter could run.
  const selected = Math.min(palette.index, palette.candidates.length - 1);
  // Keep the marked row on screen when the list outgrows the overlay. Color
  // is not the only signal: [*] carries the selection in text.
  const first = Math.min(
    Math.max(0, selected - height + 1),
    Math.max(0, palette.candidates.length - height),
  );
  return palette.candidates
    .slice(first, first + height)
    .map(([name, description], offset) => {
      const index = first + offset;
      const line = `${index === selected ? "[*]" : "[ ]"} ${name} ${description}`;
      return ink(fit(line, width - 2), index === selected ? selectedTone : mutedTone);
    });
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
  palette?: {
    open: boolean;
    query: string;
    index: number;
    // commandSuggestions hands back the as const command tuples, so the
    // element is a readonly pair rather than a mutable one.
    candidates: readonly (readonly [string, string])[];
  };
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
    height - header.length - 5 - composerHeight - menu.length,
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
      ? "🔧 Calling tool"
      : lastEvent?.type === "message.delta"
        ? "✍️ Writing response"
        : "💭 Thinking";
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
  const model = ui.session()?.model || ui.model || "not connected";
  const ctx = ui.session() ? ui.contextNumbers() : null;
  const ctxText = ctx ? `${ctx.messages}/${ctx.limit}` : "no session";
  const ctxBar = ctx
    ? ` ${meter(ctx.messages, ctx.limit, width >= 120 ? 10 : 4)}`
    : "";
  const ctxBarVisual = ctx
    ? ` ${progressBar(ctx.messages, ctx.limit, width >= 120 ? 10 : 4)}`
    : "";
  const holdBadge =
    holds > 0 ? ` | ◉ ${holds} approval${holds === 1 ? "" : "s"}` : "";
  const queuedBadge = ui.queuedPrompt ? " | +1 queued" : "";
  // The tail (mode, tokens, compact) must survive narrow frames, so a long
  // model name shrinks first instead of truncating the status fields.
  let modelShown = fit(model, 20);
  // Cost stays visible when it fits; the full cost report lives in /cost.
  const costSeg = ` | cost: ${cost}`;
  let dropCost = false;
  const summaryTail = (): string =>
    ` | ${MODE_ICON[ui.mode]} mode: ${ui.mode} | ctx: ${ctxText}${ctxBarVisual} ${ctxBar} | ` +
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
    ? "⚠️  REVIEW / y accept / n reject / Esc cancel / PgDn preview"
    : running && (busy || ui.session()?.status === "running")
      ? `${spinner} ${ui.session()?.status === "running" ? (waiting ? "⏳ Waiting for approval" : `● ${phase}${dots}`) : `⏳ Finishing operation${dots}`}${elapsed} / Esc stop${historyStatus ? " / 📜 reading history" : ""}${todoBadge}`
      : (historyStatus ?? ui.notice);
  // Command palette over the / menu. It is a frame input like command or
  // suggestion, not state on the view, so the runner owns when it is open.
  const paletteRows = visuals.palette?.open
    ? commandPaletteRows(visuals.palette, width, visuals.color === true, height)
    : [];
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
    ...bodyRows,
    ink(text(summary), ice),
    ink(text(status), ui.confirmation ? `1;${amber}` : running ? amber : muted),
    // The palette replaces the menu rows it belongs to, so the frame never
    // shows two competing command lists.
    ...(paletteRows.length ? paletteRows : menuRows),
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
  success: "✅",
  error: "❌",
  warning: "⚠️",
  info: "ℹ️",
  pending: "⏳",
  running: "🔄",
  waiting: "⏳",
  approval: "🔐",
  document: "📄",
  ledger: "📜",
  tool: "🔧",
  model: "🤖",
  session: "💬",
  document_list: "📁",
  approval_list: "📋",
  settings: "⚙️",
  help: "❓",
  search: "🔍",
  filter: "🔎",
  undo: "↩️",
  redo: "↪️",
  save: "💾",
  export: "📤",
  import: "📥",
  connect: "🔗",
  disconnect: "🔌",
  theme: "🎨",
  keybindings: "⌨️",
  quit: "🚪",
  new: "➕",
  edit: "✏️",
  delete: "🗑️",
  copy: "📋",
  paste: "📥",
} as const;
const KEYBINDINGS = [
  "KEYBINDINGS, same action as the reference terminal where VOID has it",
  "",
  "Enter send | Shift+Enter, Alt+Enter, Ctrl+J or backslash+Enter newline",
  "Left/Right move cursor, or cycle panels outside editing",
  "Esc stop a run or close | Esc Esc clear input, or checkpoints when empty",
  "Shift+Tab or Alt+M cycle mode (normal / accept / plan)",
  "Tab panels, complete, accept suggestion | Up/Down or Ctrl+N history | Ctrl+P palette",
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
  "Up/Down or Ctrl+N browse your previous prompts; Ctrl+P opens the command palette.",
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
  "/status | /cost | /context | /compact | /rewind [operation-ID]",
  "/todos | /agents | /memory | /permissions | /mcp | /sessions",
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
  "/connector-file path.json | /test-connector ID",
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

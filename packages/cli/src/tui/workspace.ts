import { ProxyWorkspace } from "./workspace-proxy.ts";
import { connectTokenHarbor } from "../../../workbench/src/provider-setup.ts";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { promisify } from "node:util";
import { resolveConfig } from "../config.ts";
import {
  Workbench,
  DEFAULT_POLICY,
  type SessionEvent,
} from "../../../workbench/src/index.ts";
import { activity } from "../../../workbench/src/gui.ts";
import { canonicalJson } from "../../../ledger/src/canonical.ts";
import type { JsonlEntry } from "../../../ledger/src/store.ts";
import {
  importDesktopProvider,
  desktopSetup,
} from "../../../../apps/control-plane/api/desktop-setup.ts";
import { loadPolicy } from "../../../policy/src/rules.ts";
import { runDoctorCommand } from "../doctor.ts";
import { runInitCommand } from "../init.ts";
import {
  fit,
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

/** Reverse history search over sent prompts, most recent first. */
export function searchHistoryPrompts(
  prompts: readonly string[],
  query: string,
): string[] {
  const needle = query.toLocaleLowerCase();
  if (!needle) return [...prompts];
  return prompts.filter((item) =>
    item.toLocaleLowerCase().includes(needle),
  );
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
  sessionId?: string;
  documentPath?: string;
  model = "";
  filter = "";
  compactTools = true;
  mode: TuiMode = "normal";
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
      ...new Set(
        this.workbench.documentsList().map((item) => item.path),
      ),
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
    const expanded = prompt.replace(
      /@([^\s@][^\s]*)/g,
      (token, path: string) => {
        if (!paths.has(path)) {
          if (!missing.includes(path)) missing.push(path);
          return token;
        }
        const doc = this.workbench.document(sessionId, path);
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
            call: { tool: string };
            expiresAt: number;
          };
          return {
            id: h.holdId,
            label: `[${h.status}] ${h.call.tool} ${h.holdId.slice(0, 8)}`,
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
    if (cmd === "quit") return "quit";
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
        `Messages: ${ctx.messages} of ${ctx.limit}, then a new session is needed`,
        `Tokens reported: ${ctx.tokens ?? "unknown"}`,
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
              (item) => `${item.done ? "[x]" : "[ ]"} ${item.text} (#${item.seq})`,
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
      this.selected = recoverable;
      this.notice =
        "Latest recoverable operation selected. Press u for reviewed Undo.";
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
        arg || "opencode:tokenrouter",
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
      this.provider =
        arg === "tokenharbor"
          ? await connectTokenHarbor(this.workbench, this.env)
          : await importDesktopProvider(
              arg || "opencode:tokenrouter",
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
      this.notice =
        this.proofErrors.size || this.proxy.errors.length
          ? "VERIFICATION FAILED. See the overview."
          : `Verified ${[...this.proofs.values()].reduce((n, v) => n + v.length, 0)} signed entries.`;
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
            "Press i to type; Enter to send; Alt+Enter for a new line.",
            "Example: Create a plan and save it to plan.md.",
            "",
            "/connect imports TokenRouter from your local OpenCode configuration.",
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
  ["/status", "Workspace status"],
  ["/cost", "Token usage and cost"],
  ["/compact", "Summarize context, local fallback"],
  ["/todos", "Checklist from agent output"],
  ["/agents", "Conversations and connectors"],
  ["/config", "Resolved paths and flags"],
  ["/memory", "Retained local history"],
  ["/model", "Set model for new chats"],
  ["/export", "Save ledger, chat or document"],
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
  ["/connect tokenharbor", "Connect saved Token Harbor key"],
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
const VOID_LOGO = [
  String.raw` __      __  ____   _____  _____  `,
  String.raw` \ \    / / / __ \ |_   _||  __ \ `,
  String.raw`  \ \  / / | |  | |  | |  | |  | |`,
  String.raw`   \ \/ /  | |__| | _| |_ | |__| |`,
  String.raw`    \__/    \____/ |_____||_____/ `,
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
  const spinner = running ? ["·", "✢", "✳", "✶", "✳", "✢"][frame % 6] : "◆";
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
    const aside = [
      "VOID / local workspace",
      ui.session()?.model || ui.model || "Connect a model with /connect",
      running ? "Working / Esc to stop" : "Your work. Your control.",
      `${ui.workbench.list().length} conversations / ${holds} pending approvals`,
      "[/] commands   [Esc] navigation",
    ];
    VOID_LOGO.forEach((line, i) =>
      header.push(
        ink(
          line,
          `1;${(visuals.boot || running) && frame % 5 === i ? ice : amber}`,
        ) +
          (width >= 78
            ? ink(
                fit(
                  sanitizeText("   " + aside[i]),
                  width - visibleLength(line),
                ),
                i === 1 ? ice : muted,
              )
            : ""),
      ),
    );
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
        .map((t) =>
          ink(
            t === ui.tab ? ` [${t}] ` : ` ${t} `,
            t === ui.tab ? `1;${ice};48;5;24` : muted,
          ),
        )
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
  const composer = wrap(
    (
      input ||
      (editing
        ? "Ask anything or type / for commands"
        : "i type / Enter details")
    ).split("\n"),
    width - 2,
  );
  const composerHeight = Math.min(composer.length, height >= 18 ? 3 : 1);
  const cursorLine =
    visuals.cursor === undefined
      ? Math.max(
          0,
          composer.findIndex((line) => line.includes("_")),
        )
      : wrap(
          ([...input].slice(0, visuals.cursor).join("") + "_").split("\n"),
          width - 2,
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
      ? "Calling tool"
      : lastEvent?.type === "message.delta"
        ? "Writing response"
        : "Thinking";
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
  const summary =
    `model: ${fit(model, 20)} | mode: ${ui.mode} | ctx: ${ctxText} | ` +
    `tokens: ${tokens} | cost: ${cost} | ${ui.compactTools ? "compact" : "full"}`;
  const status = ui.confirmation
    ? "REVIEW / y accept / n reject / Esc cancel / PgDn preview"
    : running && (busy || ui.session()?.status === "running")
      ? `${spinner} ${ui.session()?.status === "running" ? (waiting ? "Waiting for approval" : phase) : "Finishing operation"}${elapsed} / Esc stop${historyStatus ? " / reading history" : ""}`
      : (historyStatus ?? ui.notice);
  const line = (label: string) => {
    const head = `-- ${label} `;
    const rail = Array.from(
      { length: Math.max(0, width - head.length) },
      () => "-",
    );
    if (running && visuals.motion !== false && rail.length)
      for (let tail = 0; tail < Math.min(5, rail.length); tail++)
        rail[(frame + tail) % rail.length] = ["·", "─", "━", "─", "·"][tail]!;
    return fit(head + rail.join(""), width);
  };
  const menuRows = menu.map(([name, description], i) =>
    ink(
      text(
        `${i + menuStart === selection ? " >" : "  "} ${name.padEnd(13)} ${description}`,
      ),
      i + menuStart === selection ? `1;${ice};48;5;24` : muted,
    ),
  );
  return [
    ...header,
    ...bodyRows,
    ink(text(summary), ice),
    ink(text(status), ui.confirmation ? `1;${amber}` : running ? amber : muted),
    ...menuRows,
    ink(
      line(editing ? "Write a prompt" : `${ui.tab} / navigation`),
      editing ? ice : muted,
    ),
    ...composer
      .slice(composerStart, composerStart + composerHeight)
      .map((value, i) =>
        ink(
          fit(`${i === 0 ? (editing ? "> " : ": ") : "  "}${value}`, width),
          editing ? "1;38;5;255;48;5;236" : muted,
        ),
      ),
    ink("-".repeat(width), editing ? ice : muted),
    ink(
      text(
        candidates.length
          ? "arrows select / Tab complete / Enter run / Esc close"
          : editing
            ? ui.mode === "plan"
              ? "PLAN mode / Enter sends a plan request / Shift+Tab mode / Esc navigate"
              : ui.mode === "accept"
                ? "ACCEPT mode / approvals stay explicit / Enter send / Shift+Tab mode"
                : "Enter send / Alt+Enter newline / Ctrl+R search / Ctrl+O output / Esc navigate"
            : "Tab panels / Shift+Tab mode / i type / u Undo / a approve / d deny / q quit",
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
const HELP = [
  "VOID TUI: real local data, no demo metrics",
  "",
  "Tab: panels; Shift+Tab: mode (normal / accept / plan); Enter: details.",
  "Chat: start typing. / opens commands; arrows select; Tab completes.",
  "@path mentions quote a managed document into the prompt on send.",
  "PgUp/PgDn: scroll; /bottom or Ctrl+End: follow latest; i: type.",
  "/find text searches the current conversation; Esc closes results.",
  "Esc stops a run, or closes details. Esc Esc lists checkpoints.",
  "A prompt sent during a run is queued and sends when the run stops.",
  "!command runs a gated local shell; output shows once, never persists.",
  "Up/down in a single-line input browse your previous prompts.",
  "VOID_TUI_COLOR=0 disables colors; VOID_TUI_MOTION=0 disables animation.",
  "Enter sends; Alt+Enter inserts a newline; Ctrl+U clears input.",
  "Ctrl+R searches your prompts, or conversation text from empty input.",
  "Ctrl+O toggles tool output; Ctrl+L redraws the terminal.",
  "Ctrl+D exits only from an empty input. Ctrl+C clears, cancels or exits.",
  "Confirmations show a unified diff; y accepts, n rejects, Esc cancels.",
  "Plan mode prefixes prompts so the model plans before acting.",
  "Accept mode shortens edit keys; tool approvals always stay explicit.",
  "Navigation: n new chat; u preview Undo; a/d approvals; q quit.",
  "",
  "/new [prompt] | /clear | /open number-or-ID | /resume [number-or-ID]",
  "/status | /cost | /context | /compact | /rewind [operation-ID]",
  "/todos | /agents | /memory | /permissions | /mcp | /sessions",
  "/stop | /branch [seq] | /retry | /rename title | /archive",
  "/models | /model exact-ID | /connect tokenharbor | /login | /logout",
  "/documents | /document path | /edit | /history | /undo [operation-ID]",
  "/ledger | /verify | /filter text | /export ledger|chat|document",
  "/approvals | /approve [hold-ID] [reason] | /deny [hold-ID] [reason]",
  "/tools [search] | Enter inspect tool | /expand compact/full tool output",
  "/config shows paths and flags without secrets; /sources lists providers.",
  "/hooks /vim /terminal-setup /output-style have no VOID equivalent.",
  "/connector-file path.json | /test-connector ID",
  "Multiline: Up/Down move cursor | Ctrl+W delete word | Ctrl+K delete to line end",
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

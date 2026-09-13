import { ProxyWorkspace } from "./workspace-proxy.ts";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
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
import { fit, pad, sanitizeText, visibleLength } from "./layout.ts";

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

/** Same persistent workbench as the web. Rendering never grants tool authority. */
export class WorkspaceTui {
  readonly workbench: Workbench;
  readonly proxy: ProxyWorkspace;
  readonly env: Readonly<NodeJS.ProcessEnv>;
  tab: WorkspaceTab = "overview";
  selected = 0;
  scroll = 0;
  sessionId?: string;
  documentPath?: string;
  model = "";
  filter = "";
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
    if (this.tab === "tools" || this.tab === "policy")
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
      lines: [
        "BEFORE",
        ...target.content.split("\n"),
        "",
        "AFTER",
        ...content.split("\n"),
      ],
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
        "BEFORE",
        ...(preview.before ?? "[does not exist]").split("\n"),
        "",
        "AFTER",
        ...(preview.after ?? "[does not exist]").split("\n"),
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
      if (this.sessionId)
        this.workbench.send(this.sessionId, raw, randomUUID());
      else
        this.useSession(
          (
            await this.workbench.start(
              raw,
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
      return;
    }
    if (cmd === "quit") return "quit";
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
      this.provider = await importDesktopProvider(
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
  ["/chat", "Return to chat"],
  ["/sessions", "Open conversation history"],
  ["/documents", "Documents and revisions"],
  ["/ledger", "Signed operations"],
  ["/approvals", "Pending decisions"],
  ["/models", "Available models"],
  ["/overview", "Workspace overview"],
  ["/verify", "Verify signatures"],
  ["/undo", "Preview Undo"],
  ["/edit", "Open document editor"],
  ["/history", "Document history"],
  ["/branch", "Create a branch"],
  ["/retry", "Retry with confirmation"],
  ["/tools", "MCP connectors"],
  ["/policy", "Tool policies"],
  ["/usage", "Model usage"],
  ["/stop", "Stop run"],
  ["/help", "All commands"],
  ["/quit", "Save and quit"],
] as const;
export function commandSuggestions(input: string) {
  return /^\/[^\s]*$/.test(input)
    ? TUI_COMMANDS.filter(([name]) => name.startsWith(input))
    : [];
}
export type WorkspaceVisuals = {
  color?: boolean;
  frame?: number;
  motion?: boolean;
  boot?: boolean;
  command?: string;
  suggestion?: number;
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
  const spinner = running
    ? ["[.   ]", "[ .  ]", "[  . ]", "[   .]", "[  . ]", "[ .  ]"][frame % 6]
    : "[ * ]";
  const holds = ui.workbench.pending().length + ui.proxy.holds.length;
  const header: string[] = [];
  if (height >= 22 && width >= 50 && !ui.confirmation) {
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
        text(` /V/  VOID  ${spinner} ${ui.tab}  |  ${holds} approvals`),
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
  const cursorLine = Math.max(
    0,
    composer.findIndex((line) => line.includes("_")),
  );
  const composerStart = Math.max(0, cursorLine - composerHeight + 1);
  const bodyHeight = Math.max(
    1,
    height - header.length - 4 - composerHeight - menu.length,
  );
  let content = ui.lines();
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
  const lines = wrap(content, width - 4);
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
  const body = lines.slice(offset, offset + bodyHeight);
  while (body.length < bodyHeight) body.push("");
  const frameColor = ui.confirmation ? amber : muted;
  const bodyRows = body.map((line) => {
    const tone = /^>/.test(line)
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
  const status = ui.confirmation
    ? "REVIEW / y confirm / Esc cancel / PgDn preview"
    : running
      ? `${spinner} ${ui.session()?.status === "running" ? "VOID is working" : "Finishing operation"}  /  Esc stop`
      : ui.notice;
  const line = (label: string) => {
    const head = `-- ${label} `;
    const rail = Array.from(
      { length: Math.max(0, width - head.length) },
      () => "-",
    );
    if (running && visuals.motion !== false && rail.length)
      rail[frame % rail.length] = "*";
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
            ? "Enter send / Alt+Enter newline / Esc navigate / Ctrl+C cancel"
            : "Tab panels / i type / u Undo / a approve / d deny / q quit",
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
  "VOID TUI — real local data, no demo metrics",
  "",
  "Tab / Shift+Tab: panels; j/k or arrows: select; Enter: details.",
  "Chat: start typing. / opens commands; arrows select; Tab completes.",
  "PgUp/PgDn: scroll; Esc: stop run / navigation; i: type.",
  "Up/down in a single-line input browse your previous prompts.",
  "VOID_TUI_COLOR=0 disables colors; VOID_TUI_MOTION=0 disables animation.",
  "Enter sends; Alt+Enter inserts a newline; Ctrl+U clears input.",
  "Navigation: n new chat; u preview Undo; a/d approvals; q quit.",
  "",
  "/new [prompt] | /open number-or-ID | /chat | /sessions",
  "/stop | /branch [seq] | /retry | /rename title | /archive",
  "/models | /model exact-ID | /connect [opencode:tokenrouter] | /sources",
  "/documents | /document path | /edit | /history | /undo [operation-ID]",
  "/ledger | /verify | /filter text | /export ledger|chat|document",
  "/approvals | /approve [hold-ID] [reason] | /deny [hold-ID] [reason]",
  "/tools | /connector-file path.json | /test-connector ID",
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

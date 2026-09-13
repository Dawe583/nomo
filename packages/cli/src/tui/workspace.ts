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
  notice = "Tab: sekce | i: psát | /help: příkazy";
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
          "CHYBA podpisu / integrity. Obnovu ani export nelze považovat za ověřené.",
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
    if (!this.workbench.get(id)) throw Error("Konverzace neexistuje.");
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
            lines: ["[OK] Hash chain a podpis ověřeny", ...json(e)],
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
                ? "[OK] Proxy podpisy a hash chain ověřeny"
                : "[!] Proxy: pouze hash integrita, podpis NEOVĚŘEN",
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
      this.notice = `Model pro novou konverzaci: ${row.id}. Existující konverzace si zachová původní model.`;
      return;
    }
    this.detail = row.lines;
    this.scroll = 0;
  }
  showDocument() {
    if (!this.sessionId || !this.documentPath)
      throw Error("Vyber dokument pomocí Enter nebo /document cesta.");
    const d = this.workbench.document(this.sessionId, this.documentPath);
    this.detail = [
      `DOKUMENT ${this.documentPath}`,
      `Revize: ${d.revision ?? "nový dokument"}`,
      "",
      ...(d.content ?? "").split("\n"),
      "",
      "/edit upravit | /history historie | /undo náhled obnovy | /export document",
    ];
    this.scroll = 0;
  }
  editTarget() {
    if (!this.sessionId || !this.documentPath)
      throw Error("Nejdřív vyber dokument.");
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
      this.notice = "Dokument beze změn.";
      return;
    }
    this.confirmation = {
      title: `ULOŽIT ${target.path}?`,
      lines: [
        "PŘED",
        ...target.content.split("\n"),
        "",
        "PO",
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
        this.notice = "Uloženo. Podepsaná změna a Undo jsou v ledgeru.";
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
    if (!this.sessionId) throw Error("Vyber konverzaci nebo ledger záznam.");
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
    if (!id) throw Error("Vyber dokument s nevrácenou změnou nebo /undo ID.");
    const operationId = id,
      preview = await this.workbench.undoPreview(sessionId, operationId);
    if (!preview.canApply) throw Error(preview.reason);
    this.confirmation = {
      title: `UNDO ${preview.path}?`,
      lines: [
        `Operace: ${operationId}`,
        "PŘED",
        ...(preview.before ?? "[neexistuje]").split("\n"),
        "",
        "PO",
        ...(preview.after ?? "[neexistuje]").split("\n"),
      ],
      apply: async () => {
        const current = await this.workbench.undoPreview(
          sessionId,
          operationId,
        );
        if (canonicalJson(current) !== canonicalJson(preview))
          throw Error("Náhled se změnil. Znovu vyžádej /undo.");
        await this.workbench.undo(sessionId, operationId, "tui-operator");
        this.detail = undefined;
        this.notice = "Undo dokončeno a podepsáno. Historie zůstává zachována.";
      },
    };
    this.scroll = 0;
  }
  prepareApproval(kind: "approved" | "denied", id?: string, reason = "") {
    id ??= this.items()[this.selected]?.id;
    if (id?.startsWith("proxy:")) {
      const hold = this.proxy.holds.find((h) => `proxy:${h.holdId}` === id);
      if (!hold) throw Error("Proxy hold není aktivní.");
      const { decisionToken, ...visible } = hold;
      this.confirmation = {
        title: `PROXY ${kind === "approved" ? "SCHVÁLIT" : "ODMÍTNOUT"}?`,
        lines: json(visible),
        apply: async () => {
          this.proxy.decide(hold.holdId, kind, reason);
          this.notice =
            "Rozhodnutí zařazeno pro proxy. Dokončení ještě není potvrzeno.";
        },
      };
      this.scroll = 0;
      return;
    }
    const hold = this.workbench.pending().find((h) => h.holdId === id);
    if (!hold) throw Error("Schválení už není aktivní. Obnov přehled.");
    this.confirmation = {
      title: `${kind === "approved" ? "SCHVÁLIT" : "ODMÍTNOUT"} NÁSTROJ?`,
      lines: [
        ...json(hold),
        "",
        `Důvod: ${reason || "(neuveden)"}`,
        "Externí efekt nemusí mít Undo.",
      ],
      apply: async () => {
        if (
          !this.workbench.decide(hold.holdId, {
            kind,
            by: "tui-operator",
            reason,
          })
        )
          throw Error("Schválení expirovalo nebo již bylo vyřešeno.");
        this.notice = "Rozhodnutí přijato. Dokončení nástroje ověř v ledgeru.";
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
      if (!s) throw Error("/open číslo nebo ID konverzace");
      this.useSession(s.id);
      this.choose("chat");
      return;
    }
    if (cmd === "stop") {
      if (!this.sessionId) throw Error("Vyber běžící konverzaci.");
      this.workbench.cancel(this.sessionId);
      this.notice = "Rušení. Již odeslaný nástroj může ještě doběhnout.";
      return;
    }
    if (cmd === "retry" || cmd === "branch") {
      const s = this.session();
      const seq = arg
        ? Number(arg)
        : [...(s?.events ?? [])].reverse().find((e) => e.kind === "user")?.seq;
      if (!s || !seq) throw Error("Vyber zprávu ke větvení.");
      if (this.workbench.running()) throw Error("Počkej na dokončení rušení.");
      const child = await this.workbench.branch(s.id, {
        seq,
        snapshotDocuments: true,
      });
      this.useSession(child.id);
      this.choose("chat");
      this.notice =
        "Větev vytvořena. Historické nástroje se nepřehrávají. Napiš další pokyn.";
      if (cmd === "retry") {
        const key = randomUUID();
        this.confirmation = {
          title: "ZNOVU ODPOVĚDĚT VE VĚTVI?",
          lines: [
            "Model znovu odpoví na předchozí pokyn.",
            "Aktuální dokumenty jsou zkopírované. Nové nástroje znovu procházejí VOID.",
            "Historické nástroje se nepřehrávají.",
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
        throw Error("Vyber ID z /models.");
      this.model = arg;
      this.notice = `Model pro nové konverzace: ${arg}`;
      return;
    }
    if (cmd === "connect") {
      this.provider = await importDesktopProvider(
        arg || "opencode:tokenrouter",
        this.env,
        this.workbench,
      );
      this.model = this.provider.defaultModel ?? "";
      this.notice = `Připojeno ${this.provider.providerId}. Klíč je uložen šifrovaně.`;
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
          ? "CHYBA OVĚŘENÍ. Viz přehled."
          : `Ověřeno ${[...this.proofs.values()].reduce((n, v) => n + v.length, 0)} podepsaných záznamů.`;
      return;
    }
    if (cmd === "document") {
      if (!this.sessionId) throw Error("Vyber konverzaci.");
      this.documentPath = arg;
      this.choose("documents");
      this.showDocument();
      return;
    }
    if (cmd === "edit") return "edit";
    if (cmd === "history") {
      if (!this.sessionId) throw Error("Vyber dokument.");
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
      if (!this.sessionId) throw Error("Vyber konverzaci.");
      this.workbench.patchSession(this.sessionId, { title: arg });
      return;
    }
    if (cmd === "archive") {
      if (!this.sessionId) throw Error("Vyber konverzaci.");
      this.workbench.patchSession(this.sessionId, { archived: true });
      this.choose("sessions");
      return;
    }
    if (cmd === "policy-file") {
      const space = arg.indexOf(" ");
      const id = arg.slice(0, space),
        path = arg.slice(space + 1);
      if (space < 1) throw Error("/policy-file connector-ID cesta-k-YAML");
      const policy = await readFile(resolve(path), "utf8");
      if (!loadPolicy(policy).ok) throw Error("Neplatná policy.");
      this.confirmation = {
        title: `ZMĚNIT POLICY ${id}?`,
        lines: [
          policy,
          "",
          "Platí pro nové konverzace; stávající mají snapshot pravidel.",
        ],
        apply: async () => {
          await this.workbench.updateConnector(id, { policy });
          this.notice = "Policy uložena. Založ novou konverzaci.";
        },
      };
      return;
    }
    if (cmd === "connector-file") {
      const config = JSON.parse(await readFile(resolve(arg), "utf8"));
      await this.workbench.addConnector(config);
      this.choose("tools");
      this.notice = "MCP připojeno. Nová konverzace načte aktuální katalog.";
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
    throw Error("Neznámý příkaz. /help zobrazí dostupné ovládání.");
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
        throw Error("Export odmítnut: některý ledger není ověřený.");
      content =
        [...this.proofs.values(), ...this.proxy.entries.values()]
          .flat()
          .map((e) => JSON.stringify(e))
          .join("\n") + "\n";
      suffix = ".jsonl";
    } else if (kind === "chat") {
      const session = this.session();
      if (!session) throw Error("Vyber konverzaci.");
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
            "NOVÁ KONVERZACE",
            "",
            `Model: ${this.model || "nepřipojen"}`,
            "i začne psaní; Enter odešle, Alt+Enter vloží řádek.",
            "Příklad: Vytvoř plán a ulož ho do plan.md.",
            "",
            "/connect načte TokenRouter z lokální konfigurace OpenCode.",
          ];
    if (this.tab === "overview") {
      const o = activity(this.workbench.allViews()).overview;
      return [
        "VOID / LOKÁLNÍ PRACOVNÍ PROSTOR",
        "",
        `Provider: ${this.provider?.connected ? this.provider.providerId : "NEPŘIPOJEN"} | model: ${this.model || "-"}`,
        `Běh: ${this.workbench.running() ? "probíhá nebo dobíhá" : "volno"}`,
        `Konverzace: ${this.workbench.list().length} | Dokumenty: ${this.workbench.documentsList().length} | Čekající schválení: ${this.workbench.pending().length + this.proxy.holds.length}`,
        `Ledger: ${[...this.proofs.values()].reduce((n, p) => n + p.length, 0)} managed + ${[...this.proxy.entries.values()].reduce((n, p) => n + p.length, 0)} proxy záznamů`,
        `Proxy podpisy: ${this.proxy.entries.size ? (this.proxy.signed ? "ověřeny" : "NEOVĚŘENY (pouze integrita)") : "žádné záznamy"} | Chyby: ${this.proofErrors.size + this.proxy.errors.length}`,
        ...this.proofErrors.values(),
        "",
        `Dokončené běhy: ${o.runs} | Selhání: ${o.failed}`,
        `Tokeny od providera: ${o.totalTokens ?? "neznámé"} | Cena: neznámá`,
        "",
        "ZAČNI: n nová konverzace, i pokyn, Enter odeslat.",
        "DOKUMENTY: Enter otevřít, /edit upravit, u náhled Undo.",
        "KONTROLA: ledger + approvals; /verify znovu ověří podpisy.",
        "",
        "Spravované dokumenty nejsou soubory na disku počítače.",
        "MCP nástroje vyžadují explicitní připojení a klasifikaci.",
        "Externí zápisy nemají automatické Undo.",
        `Proxy ledger: ${this.proxy.ledgerDir}`,
        `Proxy schválení: ${this.proxy.approvalDir}`,
        ...this.proxy.errors,
      ];
    }
    if (this.tab === "policy")
      return [
        "SPRAVOVANÉ DOKUMENTY",
        "Čtení R0; zápisy R1 s capture a ověřeným Undo.",
        "",
        "VÝCHOZÍ POLICY PRO EXTERNÍ MCP",
        ...DEFAULT_POLICY.split("\n"),
        "Neznámé nástroje jsou odmítnuty. Schválení po expiraci neplatí.",
        "Pravidla jsou snapshotována do nové konverzace.",
        "",
        "/policy-file ID cesta.yaml mění pravidla konkrétního konektoru.",
        "",
        ...this.items().flatMap((r) => [r.label, ...r.lines, ""]),
      ];
    const rows = this.items();
    return rows.length
      ? rows.map(
          (r, i) => `${i === this.selected ? ">" : " "} ${i + 1}. ${r.label}`,
        )
      : [
          "Zatím žádné záznamy.",
          this.tab === "tools"
            ? "/connector-file soubor.json připojí skutečný MCP server."
            : "",
        ];
  }
}

export function message(error: unknown) {
  return error instanceof Error ? error.message : "Operace selhala.";
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
      `[${e.at.slice(11, 19)}] ${e.kind === "user" ? "VY" : e.kind === "assistant" ? "VOID" : e.kind.toUpperCase()}`,
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
  ["/new", "Nová konverzace"],
  ["/chat", "Zpět do konverzace"],
  ["/sessions", "Otevřít historii"],
  ["/documents", "Dokumenty a revize"],
  ["/ledger", "Podepsané operace"],
  ["/approvals", "Čekající rozhodnutí"],
  ["/models", "Dostupné modely"],
  ["/overview", "Přehled workspace"],
  ["/verify", "Ověřit podpisy"],
  ["/undo", "Náhled vrácení změny"],
  ["/edit", "Otevřít editor dokumentu"],
  ["/history", "Historie dokumentu"],
  ["/branch", "Vytvořit větev"],
  ["/retry", "Nový pokus s potvrzením"],
  ["/tools", "MCP konektory"],
  ["/policy", "Pravidla nástrojů"],
  ["/usage", "Spotřeba modelu"],
  ["/stop", "Zastavit běh"],
  ["/help", "Všechny příkazy"],
  ["/quit", "Uložit a ukončit"],
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
    visuals.color ? `\x1b[${code}m${value}\x1b[0m` : value;
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
      ui.session()?.model || ui.model || "Připoj model přes /connect",
      running ? "Model pracuje / Esc zastavit" : "Tvoje práce. Tvoje kontrola.",
      `${ui.workbench.list().length} konverzací / ${holds} ke schválení`,
      "[/] příkazy   [Esc] navigace",
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
        text(` /V/  VOID  ${spinner} ${ui.tab}  |  ${holds} schválení`),
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
            t === ui.tab ? `1;${ice}` : muted,
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
      (editing ? "Zeptej se nebo napiš / pro příkazy" : "i psát / Enter detail")
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
      "  Vítej ve VOIDu.",
      "  Napiš, co chceš vytvořit. Zbytek sleduj tady.",
      "",
      "  > Vytvoř plán projektu a ulož ho do plan.md",
      "",
      "  + Dokumenty    Zachycené změny a potvrzené Undo",
      "  + Ledger       Podepsaná historie každé operace",
      "  + Schvalování  Rozhodnutí před externím nástrojem",
      "",
      "  / příkazy     Tab doplnit     Esc navigace",
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
      : /VY$/.test(line)
        ? `1;${violet}`
        : /VOID(?: \[stream\])?$/.test(line)
          ? `1;${amber}`
          : /^(Error|Neplatný|Selhání)/.test(line)
            ? "38;5;203"
            : "39";
    return (
      ink(ui.confirmation ? "! " : "  ", frameColor) +
      ink(pad(line, width - 4), tone) +
      (ui.confirmation ? ink(" !", frameColor) : "  ")
    );
  });
  const status = ui.confirmation
    ? "ROZHODNUTÍ / y potvrdit / Esc zrušit / PgDn náhled"
    : running
      ? `${spinner} ${ui.session()?.status === "running" ? "VOID pracuje" : "Dokončuji operaci"}  /  Esc zastavit`
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
      i + menuStart === selection ? `1;${ice}` : muted,
    ),
  );
  return [
    ...header,
    ...bodyRows,
    ink(text(status), ui.confirmation ? `1;${amber}` : running ? amber : muted),
    ...menuRows,
    ink(
      line(editing ? "Napiš pokyn" : `${ui.tab} / navigace`),
      editing ? ice : muted,
    ),
    ...composer
      .slice(composerStart, composerStart + composerHeight)
      .map((value, i) =>
        ink(
          fit(`${i === 0 ? (editing ? "> " : ": ") : "  "}${value}`, width),
          editing ? "1;39" : muted,
        ),
      ),
    ink("-".repeat(width), editing ? ice : muted),
    ink(
      text(
        candidates.length
          ? "šipky výběr / Tab doplnit / Enter spustit / Esc zavřít"
          : editing
            ? "Enter odeslat / Alt+Enter řádek / Esc navigace / Ctrl+C zrušit"
            : "Tab sekce / i psát / u Undo / a schválit / d odmítnout / q konec",
      ),
      muted,
    ),
  ]
    .slice(0, height)
    .join("\n");
}
const HELP = [
  "VOID TUI — skutečná lokální data, žádná demonstrační čísla",
  "",
  "Tab / Shift+Tab: sekce; j/k nebo šipky: výběr; Enter: detail.",
  "Chat: rovnou piš. / otevře nabídku; šipky vyberou, Tab doplní.",
  "PgUp/PgDn: posun textu; Esc: zastavit běh / navigace; i: psaní.",
  "Šipky v prázdném jednořádkovém vstupu procházejí tvoje pokyny.",
  "NO_COLOR vypne barvy; VOID_TUI_MOTION=0 vypne animace.",
  "Psaní: Enter odešle; Alt+Enter nový řádek; Ctrl+U smaže řádek.",
  "V navigaci: n nová konverzace; u náhled Undo; a/d schválení; q konec.",
  "",
  "/new [pokyn] | /open číslo-nebo-ID | /chat | /sessions",
  "/stop | /branch [seq] | /retry | /rename název | /archive",
  "/models | /model přesné-ID | /connect [opencode:tokenrouter] | /sources",
  "/documents | /document cesta | /edit | /history | /undo [operation-ID]",
  "/ledger | /verify | /filter text | /export ledger|chat|document",
  "/approvals | /approve [hold-ID] [důvod] | /deny [hold-ID] [důvod]",
  "/tools | /connector-file cesta.json | /test-connector ID",
  "/policy | /policy-file connector-ID cesta.yaml | /usage | /overview",
  "",
  'Editor: VOID_TUI_EDITOR jako JSON pole, např. ["code","--wait"].',
  "Jinak EDITOR jako cesta k programu, výchozí nano. Změnu potvrdíš v TUI.",
  "Konflikt revize nic nepřepíše. Undo i schválení vždy mají vlastní potvrzení.",
  "Větev kopíruje textový kontext a aktuální dokumenty, nepřehrává nástroje.",
  "Free model se nikdy automaticky nenahrazuje placeným.",
  "Exporty mají práva 0600 a nepřepisují existující soubory.",
  "Data jsou šifrovaná v VOID_DATA_DIR, standardně ~/.void/workbench.",
  "Lokální TUI nečte soukromé cloudové konverzace.",
];

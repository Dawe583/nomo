import { compactMessages } from "./context.ts";
import { recoveryRequest, runtimeSelection, recoveryOperationMap, recoveryPreview, recoveryResult, type RecoveryRequest, type RecoveryApply } from "./recovery-jobs.ts";
import { toolCatalog } from "./tool-catalog.ts";
import { managedDocumentAdapter } from "./managed-documents.ts";
import {
  recoveryRuntime,
  localOperationJournal,
  digest,
  type Json,
} from "../../runtime/src/index.ts";
import {
  DEFAULT_MODEL_ID,
  DEFAULT_MODEL_NAME,
  DEFAULT_PROVIDER_ID,
  NVIDIA_URL,
  TOKENROUTER_URL,
  PROVIDER_PRESETS,
} from "./provider-defaults.ts";
import {
  documentView,
  sessionPatch,
  preferencePatch,
  page,
  filterRows,
  providerFailure,
  connectorInput,
  publicConnector,
  providerStateFromFailure,
  activity,
  type ProviderStatus,
  type ViewName,
  type RunState,
} from "./gui.ts";
import {
  validateAgentProfile,
  validateHook,
  type AgentProfile,
  type Hook,
  type CompactionResult,
} from "./agents.ts";
import { LocalStorage } from "./storage.ts";
import {
  catalog as mcpCatalog,
  rpc,
  validateEndpoint,
  type McpTool,
  type McpConfig,
} from "./mcp.ts";
import {
  createWorkspace,
  workspaceTools,
  executeWorkspaceTool,
  previewWorkspaceUndo,
  applyWorkspaceUndo,
  workspaceToolClass,
  type WorkspaceState,
  type WorkspaceOperation,
} from "./workspace.ts";
import { devKeyProvider, sha256Hex } from "../../ledger/src/sign.ts";
import {
  canonicalJson,
  entryHash,
  GENESIS_PREV,
} from "../../ledger/src/canonical.ts";
import { signingPreimage } from "../../ledger/src/index.ts";
import { verifyChain, readLedgerEntries } from "../../ledger/src/verify.ts";
import type { JsonlEntry } from "../../ledger/src/store.ts";
import { classifyTool } from "../../registry/src/evaluate.ts";
import { loadPolicy } from "../../policy/src/rules.ts";
import { decide } from "../../policy/src/decide.ts";
import { setTimeout as delay } from "node:timers/promises";
import { randomUUID } from "node:crypto";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import {
  attestLedger,
  type AttestationDocument,
} from "../../ledger/src/attest.ts";
import { createVoidClient, type VoidClient } from "../../sdk/src/client.ts";
import {
  CompatibleProvider,
  ProviderRequestError,
  normalizeProviderConfig,
  type Model,
  type ModelMessage,
  type ProviderConfig,
} from "./provider.ts";
import type { JsonObject } from "../../proxy/src/rpc.ts";

export type SessionEvent = {
  readonly seq: number;
  readonly at: string;
  readonly kind: "user" | "assistant" | "tool" | "error" | "usage";
  readonly text: string;
  readonly id?: string;
  readonly sessionId?: string;
  readonly runId?: string;
  readonly type?: string;
  readonly payload?: Record<string, unknown>;
  readonly schemaVersion?: number;
};
export type SessionView = {
  readonly id: string;
  readonly workspace: string;
  readonly model: string;
  readonly title?: string;
  readonly createdAt?: string;
  readonly updatedAt?: string;
  readonly pinned?: boolean;
  readonly archived?: boolean;
  readonly project?: string;
  readonly agent?: string;
  readonly tags?: string[];
  readonly runId?: string;
  readonly provider?: string;
  readonly parentId?: string;
  readonly status: "running" | "queued" | "idle" | "cancelled" | "failed" | "unknown" | "paused";
  readonly events: readonly SessionEvent[];
};
export const DEFAULT_POLICY =
  "version: 1\nrules:\n  - match:\n      class: r0\n    decision: allow\n  - match: {}\n    decision: hold\n    seconds: 300\n    notify: [cli]\n";
export const AGENT_PRESETS = [
  {
    id: "default",
    name: "VOID default",
    description: "General-purpose accountable agent.",
    instruction: "",
  },
  {
    id: "planner",
    name: "Planner",
    description: "Break work into an explicit, reviewable plan.",
    instruction:
      "You are the VOID planner. Start with a concise plan, identify risks and dependencies, then execute only after the plan is clear.",
  },
  {
    id: "reviewer",
    name: "Reviewer",
    description: "Inspect changes for correctness, security and regressions.",
    instruction:
      "You are the VOID reviewer. Prioritize concrete defects, security risks and missing verification; do not invent praise or rewrite unrelated code.",
  },
  {
    id: "implementer",
    name: "Implementer",
    description: "Implement the requested change with focused verification.",
    instruction:
      "You are the VOID implementer. Make the smallest complete change, preserve existing contracts and verify the changed behavior before claiming success.",
  },
] as const;
// Standards rule 10: a denial names the rule id, the class and what approval
// would require. A generic error trains agents to retry with a reworded
// request, which turns a safety tool into an evasion trainer.
export function denialText(
  tool: string,
  klass: string,
  decision: { kind: string; ruleIndex?: number; rationale?: string },
): string {
  const decided =
    (decision.kind === "deny" || decision.kind === "hold") &&
    typeof decision.ruleIndex === "number";
  const basis = decided
    ? `policy rule ${decision.ruleIndex}`
    : "no matching policy rule";
  const why =
    decided && decision.rationale ? ` Reason: ${decision.rationale}.` : "";
  const remedy =
    decision.kind === "hold"
      ? "It needed operator approval before expiry."
      : "Change the connector policy or ask the operator to approve this class.";
  return `VOID denied ${tool} (${klass}) by ${basis}.${why} ${remedy} Do not retry with reworded arguments.`;
}
class UnknownToolOutcome extends Error {
  constructor() { super("Tool outcome is unknown. Stop and reconcile its evidence before continuing."); }
}
type Connector = McpConfig & { id: string; name: string; tools: McpTool[] };
type Session = {
  view: SessionView;
  messages: ModelMessage[];
  messageIds?: string[];
  queuedPrompt?: string;
  client?: VoidClient;
  tools?: McpTool[];
  connections?: Record<string, McpConfig & { sessionId?: string }>;
  config?: ProviderConfig;
  controller: AbortController;
  provider: CompatibleProvider;
};

/** Model tools always cross the existing VOID SDK. A provider has no shell or
 * filesystem authority; operators configure the MCP upstream on the runtime. */
export class Workbench {
  private readonly env: Readonly<NodeJS.ProcessEnv>;
  private provider: CompatibleProvider | undefined;
  private providerFailureState: { status: number; retryAt: string | null } | null = null;
  private readonly storage: LocalStorage;
  private hasState = false;
  private preferences: Record<string, string> = {
    defaultProvider: DEFAULT_PROVIDER_ID,
    defaultModel: DEFAULT_MODEL_ID,
    defaultAgentPreset: "default",
    locale: "cs",
    appearance: "system",
    sendBehavior: "enter",
  };
  private requests: Record<string, { digest: string; sessionId: string }> = {};
  private approvalHistory: unknown[] = [];
  private readonly keyStorage: string;
  private config: ProviderConfig | undefined;
  private profiles: Record<string, ProviderConfig> = {};
  private connectors: Connector[] = [];
  private documents: Record<string, WorkspaceState> = {};
  private evidence: Record<string, JsonlEntry[]> = {};
  private recoveryRequests: Record<string, RecoveryRequest> = {};
  private readonly holds = new Map<
    string,
    {
      holdId: string;
      call: {
        tool: string;
        workspace: string;
        klass: string;
        blastRadius: number | undefined;
        reason: string;
      };
      expiresAt: number;
      status: "pending" | "approved" | "denied";
      by?: string;
      reason?: string;
      notify: string[];
    }
  >();
  private ignoreEnvironment = false;
  private catalog: readonly Model[] = [];
  private readonly sessions = new Map<string, Session>();
  private readonly queued = new Set<string>();
  private readonly jobs = new Map<string, Promise<void>>();
  private closing = false;
  running() {
    return this.jobs.size > 0;
  }
  async settled() {
    await Promise.allSettled([...this.jobs.values()]);
  }
  async shutdown() {
    this.close();
    await this.settled();
  }
  private readonly projectList: Array<{
    id: string;
    name: string;
    root: string;
    updatedAt: string;
  }> = [];
  private readonly fetcher: typeof fetch;
  constructor(
    env: Readonly<NodeJS.ProcessEnv> = process.env,
    fetcher: typeof fetch = fetch,
  ) {
    this.keyStorage = env.VOID_WORKSPACE_KEY
      ? "os-keychain"
      : "encrypted-local";
    this.env = { ...env };
    delete (this.env as NodeJS.ProcessEnv).VOID_WORKSPACE_KEY;
    this.fetcher = fetcher;
    this.storage = new LocalStorage(
      env.VOID_DATA_DIR ??
        join(env.VOID_LEDGER_DIR ?? join(homedir(), ".void"), "workbench"),
      env.VOID_WORKSPACE_KEY,
    );
    const saved = this.storage.read<{
      preferences?: Record<string, string>;
      requests?: Record<string, { digest: string; sessionId: string }>;
      approvalHistory?: unknown[];
      config?: ProviderConfig;
      profiles?: Record<string, ProviderConfig>;
      catalog: readonly Model[];
      connectors: Connector[];
      documents: Record<string, WorkspaceState>;
      evidence: Record<string, JsonlEntry[]>;
      recoveryRequests?: Record<string, RecoveryRequest>;
      sessions: Array<{
        view: SessionView;
        messages: ModelMessage[];
        messageIds?: string[];
        config?: ProviderConfig;
        tools?: McpTool[];
        connections?: Session["connections"];
      }>;
      projects?: Array<{
        id: string;
        name: string;
        root: string;
        updatedAt: string;
      }>;
    }>();
    if (saved) {
      let migrated = false;
      const loadConfig = (value: ProviderConfig | undefined) => {
        if (!value) return undefined;
        const config = normalizeProviderConfig(value);
        if (value.kind !== config.kind) migrated = true;
        try {
          new CompatibleProvider(config, fetcher);
          return config;
        } catch {
          migrated = true;
          return undefined;
        }
      };
      const preferences = saved.preferences ?? {};
      const defaultAgentPreset = AGENT_PRESETS.some(
        (agent) => agent.id === preferences.defaultAgentPreset,
      )
        ? preferences.defaultAgentPreset
        : "default";
      const legacyDefaultModel = [
        "openai-fast",
        "muse-spark-1.3-contributor-free",
        "z-ai/glm-5.3-free",
      ].includes(preferences.defaultModel ?? "");
      this.preferences = {
        ...this.preferences,
        ...preferences,
        defaultAgentPreset,
        ...(legacyDefaultModel ? { defaultModel: DEFAULT_MODEL_ID } : {}),
      };
      if (
        legacyDefaultModel ||
        preferences.defaultAgentPreset !== defaultAgentPreset
      )
        migrated = true;
      this.requests = saved.requests ?? {};
      this.approvalHistory = (saved.approvalHistory ?? []).map((value) => {
        const hold = value as Record<string, unknown>;
        return hold.status === "pending"
          ? { ...hold, status: "interrupted" }
          : hold;
      });
      this.hasState =
        !!saved.config ||
        !!saved.sessions.length ||
        !!saved.connectors.length ||
        !!Object.keys(saved.profiles ?? {}).length;
      this.config = loadConfig(saved.config);
      this.profiles = {};
      for (const [baseUrl, value] of Object.entries(saved.profiles ?? {})) {
        const profile = loadConfig(value);
        if (profile) this.profiles[baseUrl] = profile;
      }
      this.catalog = saved.catalog;
      this.connectors = saved.connectors;
      this.documents = saved.documents;
      this.evidence = saved.evidence;
      this.recoveryRequests = saved.recoveryRequests ?? {};
      this.projectList = saved.projects ?? [];
      if (this.config)
        this.provider = new CompatibleProvider(this.config, fetcher);
      for (const item of saved.sessions) {
        const sessionConfig = item.config ? loadConfig(item.config) : undefined,
          config = sessionConfig ?? this.config;
        if (!config) {
          const fallback = { baseUrl: TOKENROUTER_URL, apiKey: "" };
          this.sessions.set(item.view.id, {
            ...item,
            config: sessionConfig,
            view: {
              ...item.view,
              status: item.view.status === "running" ? "unknown" : item.view.status === "queued" ? "paused" : item.view.status,
            },
            provider: new CompatibleProvider(fallback, fetcher),
            controller: new AbortController(),
          });
          continue;
        }
        this.sessions.set(item.view.id, {
          ...item,
          config: sessionConfig,
          view: {
            ...item.view,
            status: item.view.status === "running" ? "unknown" : item.view.status === "queued" ? "paused" : item.view.status,
          },
          provider: new CompatibleProvider(config, fetcher),
          controller: new AbortController(),
        });
      }
      if (migrated) this.persist();
    }
  }
  private persist(): void {
    if (
      !this.hasState &&
      !this.config &&
      !this.sessions.size &&
      !this.connectors.length
    )
      return;
    this.storage.save({
      preferences: this.preferences,
      requests: this.requests,
      approvalHistory: [...this.approvalHistory, ...this.holds.values()],
      config: this.config,
      profiles: this.profiles,
      catalog: this.catalog,
      connectors: this.connectors,
      documents: this.documents,
      evidence: this.evidence,
      recoveryRequests: this.recoveryRequests,
      projects: this.projectList,
      sessions: [...this.sessions.values()].map(
        ({ view, messages, messageIds, config, tools, connections }) => ({
          view,
          messages,
          messageIds,
          config,
          tools,
          connections,
        }),
      ),
    });
    this.hasState = true;
  }
  async configure(config: ProviderConfig): Promise<readonly Model[]> {
    config = normalizeProviderConfig({
      ...config,
      apiKey: config.apiKey || this.profiles[config.baseUrl]?.apiKey || "",
    });
    const provider = new CompatibleProvider(config, this.fetcher);
    const models = await provider.models();
    if (!models.length)
      throw new Error(
        "Provider returned no available models. Previous configuration was kept.",
      );
    const previous = {
      provider: this.provider,
      config: this.config,
      profiles: this.profiles,
      catalog: this.catalog,
      preferences: this.preferences,
    };
    const preferred =
      [this.preferences.defaultModel, DEFAULT_MODEL_ID].find((id) =>
        models.some((model) => model.id === id),
      ) ?? models[0]!.id;
    this.provider = provider;
    this.config = config;
    this.profiles = { ...this.profiles, [config.baseUrl]: config };
    this.catalog = models;
    this.preferences = {
      ...this.preferences,
      defaultModel: preferred,
      defaultProvider:
        PROVIDER_PRESETS.find((p) => p.baseUrl === config.baseUrl)?.id ??
        "custom",
    };
    try {
      this.persist();
    } catch (error) {
      Object.assign(this, previous);
      throw error;
    }
    this.providerFailureState = null;
    return models;
  }
  async providerState() {
    if (!this.provider && !this.ignoreEnvironment && this.env.NVIDIA_API_KEY && !this.providerFailureState) {
      try {
        await this.configure({ baseUrl: NVIDIA_URL, apiKey: this.env.NVIDIA_API_KEY });
      } catch (error) {
        this.recordProviderFailure(error);
      }
    }
    const hasCredential = Boolean(this.config?.apiKey || (!this.ignoreEnvironment && this.env.NVIDIA_API_KEY));
    const derived = providerStateFromFailure(this.provider !== undefined, this.providerFailureState, hasCredential);
    return {
      connected: this.provider !== undefined,
      setupRequired:
        derived.status === "setup-required",
      models: this.catalog,
      keyStorage: this.keyStorage,
      baseUrl: this.config?.baseUrl,
      kind: this.config?.kind,
      profiles: Object.keys(this.profiles),
      presets: PROVIDER_PRESETS,
      providerId:
        PROVIDER_PRESETS.find((p) => p.baseUrl === this.config?.baseUrl)?.id ??
        DEFAULT_PROVIDER_ID,
      defaultModel: this.preferences.defaultModel,
      upstreamConfigured: true,
      status: derived.status,
      detail: derived.detail,
      retryAt: derived.retryAt,
    };
  }
  agents() {
    return {
      supported: true,
      agents: AGENT_PRESETS.map(({ id, name, description }) => ({
        id,
        name,
        description,
      })),
    };
  }
  listProjects(): readonly {
    id: string;
    name: string;
    root: string;
    updatedAt: string;
  }[] {
    return this.projectList.map(project => ({ ...project })).sort((a, b) =>
      b.updatedAt.localeCompare(a.updatedAt),
    );
  }
  projects() { return this.listProjects(); }
  upsertProject(input: { id?: string; name: string; root: string }): {
    id: string;
    name: string;
    root: string;
    updatedAt: string;
  } {
    if (!input || typeof input.name !== "string" || !input.name.trim() || input.name.length > 160) throw new Error("Project name must contain 1..160 characters.");
    if (typeof input.root !== "string" || !input.root.trim() || input.root.length > 4096) throw new Error("Project root must contain 1..4096 characters.");
    if (input.id !== undefined && (typeof input.id !== "string" || !/^[A-Za-z0-9][\w-]{0,119}$/.test(input.id))) throw new Error("Invalid project id.");
    const name = input.name.trim(), root = input.root.trim();
    const existing = this.projectList.find((p) => input.id ? p.id === input.id : p.root === root);
    const now = new Date().toISOString();
    if (existing) {
      existing.name = name;
      existing.root = root;
      existing.updatedAt = now;
      this.hasState = true;
      this.persist();
      return { ...existing };
    }
    const id = input.id ?? randomUUID();
    const project = { id, name, root, updatedAt: now };
    this.projectList.push(project);
    this.hasState = true;
    this.persist();
    return { ...project };
  }
  runs(): readonly {
    id: string;
    runId: string;
    sessionId: string;
    model: string;
    provider?: string;
    status: string;
    state: RunState;
    progress: number | null;
    createdAt: string;
    updatedAt: string | undefined;
    durationMs: number | null;
    steps: number;
    legacy: boolean;
    reconcileRequired: boolean;
  }[] {
    const views = [...this.sessions.values()].map((s) => s.view);
    const activityResult = activity(views);
    return activityResult.runs;
  }
  stopRun(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error("Session not found.");
    if (session.view.status === "running" || session.view.status === "queued") {
      this.cancel(sessionId);
    }
  }
  clearProvider(): void {
    this.providerFailureState = null;
    this.ignoreEnvironment = true;
    this.provider = undefined;
    if (this.config) delete this.profiles[this.config.baseUrl];
    this.config = undefined;
    this.catalog = [];
    this.persist();
  }
  list(): readonly SessionView[] {
    return [...this.sessions.values()].map((session) => ({
      ...session.view,
      events: [],
    }));
  }
  availableTools(id?: string) {
    const session = id ? this.sessions.get(id) : undefined;
    if (id && !session) throw new Error("Session not found.");
    return {
      scope: id ? "session" : "configured",
      tools: toolCatalog(
        session
          ? (session.tools ?? [...workspaceTools])
          : [
              ...workspaceTools,
              ...this.connectors.flatMap((c) =>
                c.tools.map((tool) => ({ ...tool, connectorId: c.id })),
              ),
            ],
        [
          ...this.connectors.map((c) => c.token),
          ...Object.values(session?.connections ?? {}).map((c) => c.token),
        ],
      ),
    };
  }
  get(id: string): SessionView | undefined {
    return this.sessions.get(id)?.view;
  }
  async start(
    prompt: string,
    model = this.preferences.defaultModel ?? DEFAULT_MODEL_ID,
    key?: string,
    project?: string,
    agent?: string,
    background = false,
  ): Promise<SessionView> {
    return this.locked(async () => {
      const prior = this.request(key, [
        "start",
        prompt,
        model,
        project,
        agent,
        background,
      ]);
      if (prior) return this.get(prior)!;
      await this.providerState();
      const result = await this.startSession(
        prompt,
        model,
        project,
        agent,
        background,
      );
      this.remember(
        key,
        ["start", prompt, model, project, agent, background],
        result.id,
      );
      return result;
    });
  }
  private async startSession(
    prompt: string,
    model: string,
    project?: string,
    agent?: string,
    background = false,
  ): Promise<SessionView> {
    if (!this.provider)
      throw new Error("Connect and validate a provider first.");
    const selectedAgent = AGENT_PRESETS.find(
      (item) => item.id === (agent ?? this.preferences.defaultAgentPreset),
    );
    if (agent && !selectedAgent) throw new Error("Unknown agent preset.");
    const selectedProvider = this.provider,
      selectedConfig = this.config;
    if (!this.catalog.some((item) => item.id === model))
      throw new Error("Select a model from the validated catalog.");
    if (
      this.closing ||
      (!background &&
        (this.jobs.size ||
          [...this.sessions.values()].some(
            (session) => session.view.status === "running",
          )))
    )
      throw new Error(
        "Wait for the active session or cancel it before starting another.",
      );
    let command: unknown;
    try {
      command = JSON.parse(this.env.VOID_UPSTREAM_COMMAND ?? "null");
    } catch {
      throw new Error("VOID_UPSTREAM_COMMAND must be a JSON array.");
    }
    if (
      command !== null &&
      (!Array.isArray(command) ||
        !command.length ||
        !command.every((item) => typeof item === "string" && item.length > 0))
    )
      throw new Error(
        "Configure VOID_UPSTREAM_COMMAND on the runtime with the MCP server command as a JSON array.",
      );
    if (command && !this.env.VOID_POLICY_PATH)
      throw new Error("Configure VOID_POLICY_PATH before starting an agent.");
    if (!prompt.trim() || prompt.length > 32000)
      throw new Error("Enter a prompt between 1 and 32000 characters.");
    const id = randomUUID();
    const workspace = `agent-${id}`;
    const client = Array.isArray(command)
      ? createVoidClient({
          workspace,
          ledgerDir:
            this.env.VOID_LEDGER_DIR ?? join(homedir(), ".void", "ledger"),
          connect: { upstreamCommand: command },
          policyPath: this.env.VOID_POLICY_PATH!,
          factsPath: this.env.VOID_FACTS_PATH,
          posture: "fail-closed",
          requestTimeoutMs: 180000,
        })
      : undefined;
    const tools: McpTool[] = [...workspaceTools];
    const connections: NonNullable<Session["connections"]> = {};
    for (const connector of this.connectors) {
      const listed = await mcpCatalog(connector);
      connections[connector.id] = { ...connector, sessionId: listed.sessionId };
      tools.push(
        ...listed.tools.map((tool) => ({ ...tool, connectorId: connector.id })),
      );
    }
    if (client) {
      const listed = (await client.request("tools/list")) as {
        tools: McpTool[];
      };
      tools.push(
        ...listed.tools.map((tool) => ({ ...tool, connectorId: "stdio" })),
      );
    }
    if (
      this.closing ||
      (!background &&
        (this.jobs.size ||
          [...this.sessions.values()].some((s) => s.view.status === "running")))
    ) {
      client?.close();
      throw new Error(
        "Another session started while connecting tools. Retry after it stops.",
      );
    }
    const systemInstruction = `You are operating through VOID. Tool calls are classified, governed by policy, and recorded. Respect denied calls; do not retry them with reworded arguments. Wait for operator approval of held calls. Only claim completed actions when they are proven by tool results. You have a managed document workspace with list, read, write and delete tools. Changes in that workspace are captured and can be undone by the operator. These tools do not access the host filesystem. Use them when asked to create or edit documents.${selectedAgent?.instruction ? `\n\nActive agent preset (${selectedAgent.id}): ${selectedAgent.instruction}` : ""}`;
    const queued =
      background &&
      (this.jobs.size > 0 ||
        [...this.sessions.values()].some((s) => s.view.status === "running"));
    const session: Session = {
      view: {
        id,
        workspace,
        model,
        provider: selectedConfig?.baseUrl,
        project: project?.trim().slice(0, 160) || undefined,
        agent: selectedAgent?.id,
        createdAt: new Date().toISOString(),
        title: prompt.trim().slice(0, 80),
        status: queued ? "queued" : "idle",
        events: [],
      },
      messages: [{ role: "system", content: systemInstruction }],
      queuedPrompt: queued ? prompt : undefined,
      client,
      tools,
      connections,
      config: selectedConfig,
      controller: new AbortController(),
      provider: selectedProvider,
    };
    this.sessions.set(id, session);
    if (queued) {
      this.queued.add(id);
      this.persist();
    } else this.send(id, prompt);
    return session.view;
  }
  send(id: string, prompt: string, key?: string): void {
    if (this.request(key, [id, prompt])) return;
    const session = this.sessions.get(id);
    if (
      this.closing ||
      this.jobs.size ||
      !session ||
      session.view.status === "running" ||
      session.view.status === "queued"
    )
      throw new Error("The session is not ready for another message.");
    if (session.view.status === "unknown")
      throw new Error("Run outcome is unknown. Reconcile its evidence before continuing.");
    if (!prompt.trim() || prompt.length > 32000)
      throw new Error("Enter a prompt between 1 and 32000 characters.");
    if (
      [...this.sessions.values()].some(
        (other) => other !== session && other.view.status === "running",
      )
    )
      throw new Error("Wait for the active session or cancel it first.");
    const lastAssistant = [...session.messages]
      .reverse()
      .find((m) => m.role === "assistant");
    if (
      lastAssistant?.tool_calls?.some(
        (call) =>
          !session.messages
            .slice(session.messages.indexOf(lastAssistant) + 1)
            .some((m) => m.role === "tool" && m.tool_call_id === call.id),
      )
    )
      throw new Error(
        "Previous tool batch is incomplete. Create a branch before continuing; historical tools will not be replayed.",
      );
    if (session.messages.length >= 199)
      throw new Error("Session context limit reached. Start a new session.");
    session.controller = new AbortController();
    session.view = { ...session.view, runId: randomUUID() };
    session.messages.push({ role: "user", content: prompt });
    this.event(session, "user", prompt);
    session.view = { ...session.view, status: "running" };
    this.event(session, "tool", "Running", { status: "running" }, "run.status");
    this.persist();
    this.remember(key, [id, prompt], id);
    const job = this.run(session);
    this.jobs.set(id, job);
    void job
      .catch(() => {
        session.view = { ...session.view, status: "failed" };
      })
      .finally(() => {
        this.jobs.delete(id);
        this.drainQueued();
      });
  }
  compact(id: string): CompactionResult {
    const session = this.sessions.get(id);
    if (!session) throw new Error("Session not found.");
    if (this.jobs.size || session.view.status === "running" || session.view.status === "queued")
      throw new Error("Wait for the active run to settle before compacting.");
    const before = session.messages.length;
    const compacted = compactMessages(id, session.messages, session.messageIds);
    session.messages = compacted.messages;
    session.messageIds = compacted.messageIds;
    if (compacted.result.omittedMessageCount) this.event(session, "tool", "Context compacted.", {
      beforeMessages: before, afterMessages: session.messages.length,
      omittedMessages: compacted.result.omittedMessageCount,
    }, "context.compacted");
    this.persist();
    return compacted.result;
  }
  private drainQueued(): void {
    if (this.closing || this.jobs.size) return;
    const id = this.queued.values().next().value as string | undefined;
    if (!id) return;
    this.queued.delete(id);
    const session = this.sessions.get(id);
    if (!session || session.view.status !== "queued" || !session.queuedPrompt) {
      this.drainQueued();
      return;
    }
    const prompt = session.queuedPrompt;
    delete session.queuedPrompt;
    session.view = { ...session.view, status: "idle" };
    try {
      this.send(id, prompt);
    } catch (error) {
      session.view = { ...session.view, status: "failed" };
      this.event(
        session,
        "error",
        error instanceof Error ? error.message : "Queued run failed.",
      );
      this.persist();
    }
  }
  cancel(id: string): void {
    const session = this.sessions.get(id);
    if (!session) throw new Error("Session not found.");
    if (session.view.status === "queued") {
      this.queued.delete(id);
      session.view = { ...session.view, status: "cancelled" };
      this.persist();
      return;
    }
    session.controller.abort();
    session.client?.close();
    session.view = { ...session.view, status: "cancelled" };
    this.event(
      session,
      "tool",
      "Cancellation requested. An already dispatched tool may finish.",
      { status: "cancelled" },
      "run.status",
    );
    this.persist();
  }
  close(): void {
    this.closing = true;
    for (const session of this.sessions.values()) {
      session.controller.abort();
      session.client?.close();
      if (session.view.status === "running" || session.view.status === "queued")
        session.view = { ...session.view, status: "cancelled" };
    }
    this.queued.clear();
    this.persist();
  }
  pending() {
    return [...this.holds.values()]
      .filter(
        (h) =>
          h.status === "pending" &&
          h.expiresAt > Date.now() &&
          this.sessions.get(h.holdId.split(":")[0]!)?.view.status === "running",
      )
      .concat(
        [...this.sessions.values()].flatMap((session) =>
          session.view.status === "running"
            ? (session.client?.pendingHolds() ?? []).map((hold) => ({
                ...hold,
                holdId: `${session.view.id}:${hold.holdId}`,
              }))
            : [],
        ) as never[],
      );
  }
  decide(
    id: string,
    decision: { kind: "approved" | "denied"; by: string; reason?: string },
  ): boolean {
    const local = this.holds.get(id);
    if (
      local &&
      local.status === "pending" &&
      local.expiresAt > Date.now() &&
      this.sessions.get(id.split(":")[0]!)?.view.status === "running"
    ) {
      local.status = decision.kind;
      local.by = decision.by;
      local.reason = decision.reason;
      try {
        this.persist();
      } catch (error) {
        local.status = "pending";
        delete local.by;
        delete local.reason;
        throw error;
      }
      return true;
    }
    const [sessionId, holdId] = id.split(":");
    const session = sessionId ? this.sessions.get(sessionId) : undefined;
    if (session && holdId && session.view.status === "running")
      return session.client?.approvals.decide(holdId, decision) ?? false;
    return false;
  }
  private event(
    session: Session,
    kind: SessionEvent["kind"],
    text: string,
    payload: Record<string, unknown> = {},
    type?: string,
  ) {
    const seq = (session.view.events.at(-1)?.seq ?? 0) + 1,
      at = new Date().toISOString();
    let safeText = session.provider.redact(JSON.stringify(payload));
    for (const config of Object.values(session.connections ?? {}))
      if (config.token)
        safeText = safeText.split(config.token).join("[redacted]");
    const safe = JSON.parse(safeText) as Record<string, unknown>;
    session.view = {
      ...session.view,
      updatedAt: at,
      events: [
        ...session.view.events,
        {
          id: `${session.view.id}:${seq}`,
          sessionId: session.view.id,
          runId: session.view.runId,
          seq,
          at,
          kind,
          text: session.provider.redact(text).slice(0, 32000),
          type:
            type ??
            {
              user: "message.completed",
              assistant: "message.completed",
              tool: "tool.result",
              error: "run.error",
              usage: "usage.reported",
            }[kind],
          payload: safe,
          schemaVersion: 1,
        },
      ],
    };
  }
  getPreferences() {
    return { ...this.preferences };
  }
  patchPreferences(body: Record<string, unknown>) {
    this.preferences = { ...this.preferences, ...preferencePatch(body) };
    this.hasState = true;
    this.persist();
    return this.getPreferences();
  }
  patchSession(id: string, body: Record<string, unknown>) {
    const s = this.sessions.get(id);
    if (!s) throw new Error("Session not found.");
    s.view = {
      ...s.view,
      ...sessionPatch(body),
      updatedAt: new Date().toISOString(),
    };
    this.persist();
    return s.view;
  }
  sessionPage(query: URLSearchParams) {
    const all = filterRows(
      [...this.sessions.values()].map((s) => s.view),
      query,
    )
      .filter(
        (s) =>
          query.get("archived") === "all" ||
          !!s.archived === (query.get("archived") === "true"),
      )
      .sort(
        (a, b) =>
          Number(!!b.pinned) - Number(!!a.pinned) ||
          String(b.createdAt ?? b.id).localeCompare(
            String(a.createdAt ?? a.id),
          ),
      );
    const result = page(all, query);
    return {
      ...result,
      items: result.items.map((s) => ({
        ...s,
        events: [],
        messageCount: s.events.filter(
          (e) =>
            e.type === "message.completed" ||
            (!e.type && ["user", "assistant"].includes(e.kind)),
        ).length,
      })),
      sessions: result.items.map((s) => ({ ...s, events: [] })),
    };
  }
  allViews() {
    return [...this.sessions.values()].map((s) => s.view);
  }
  approvals() {
    return [
      ...this.approvalHistory,
      ...this.holds.values(),
      ...this.pending().filter((h) => !this.holds.has(h.holdId)),
    ].map((h) => {
      const hold = h as { status: string; expiresAt: number };
      return {
        ...hold,
        status:
          hold.status === "pending" && hold.expiresAt <= Date.now()
            ? "expired"
            : hold.status,
      };
    });
  }
  documentsList() {
    return [...this.sessions.values()].flatMap((s) =>
      Object.keys(this.workspace(s.view.id).files).map((path) => {
        const { content, ...item } = documentView(
          this.workspace(s.view.id),
          path,
          s.view.id,
        );
        return { ...item, workspace: s.view.workspace };
      }),
    );
  }
  document(id: string, path: string) {
    return documentView(this.workspace(id), path, id);
  }
  async editDocument(
    id: string,
    input: { path: string; content: string; expectedRevision: string | null },
    operator: "web-operator" | "tui-operator" = "web-operator",
  ) {
    return this.locked(async () => {
      const s = this.sessions.get(id);
      if (!s) throw new Error("Session not found.");
      if (this.jobs.size || s.view.status === "running")
        throw new Error("Wait for the agent to stop.");
      const state = this.workspace(id);
      if (
        documentView(state, input.path, id).revision !== input.expectedRevision
      )
        throw new Error("Document revision conflict. Refresh before saving.");
      const operationId = randomUUID();
      await this.mutateDocument(
        s,
        operationId,
        "void_workspace_write",
        { path: input.path, content: input.content },
        { by: operator },
      );
      this.event(
        s,
        "tool",
        `Updated ${input.path}.`,
        { path: input.path, operationId },
        "document.changed",
      );
      this.persist();
      return this.document(id, input.path);
    });
  }
  async branch(
    id: string,
    body: { seq: number; prompt?: string; snapshotDocuments?: boolean },
  ) {
    return this.locked(async () => {
      if (this.jobs.size)
        throw new Error("Wait for the active run to settle before branching.");
      const parent = this.sessions.get(id);
      if (
        !parent ||
        !Number.isSafeInteger(body.seq) ||
        !parent.view.events.some((e) => e.seq === body.seq)
      )
        throw new Error("Choose an existing message.");
      const messages = parent.view.events.filter(
        (e) =>
          e.seq <= body.seq &&
          ["user", "assistant"].includes(e.kind) &&
          (!e.type || e.type === "message.completed"),
      );
      if (body.prompt !== undefined) {
        if (
          !body.prompt.trim() ||
          body.prompt.length > 32000 ||
          messages.at(-1)?.kind !== "user"
        )
          throw new Error("Choose a user message to edit.");
        messages[messages.length - 1] = {
          ...messages.at(-1)!,
          text: body.prompt,
        };
      }
      const childId = randomUUID(),
        workspace = `agent-${childId}`;
      const child: Session = {
        ...parent,
        client: undefined,
        controller: new AbortController(),
        view: {
          ...parent.view,
          id: childId,
          workspace,
          parentId: id,
          title: `${parent.view.title ?? "Conversation"} (branch)`,
          status: "idle",
          pinned: false,
          archived: false,
          createdAt: new Date().toISOString(),
          events: [],
        },
        messages: [
          parent.messages[0]!,
          ...messages.map((e) => ({
            role: e.kind as "user" | "assistant",
            content: e.text,
          })),
        ],
      };
      this.sessions.set(childId, child);
      this.documents[workspace] = createWorkspace();
      if (body.snapshotDocuments)
        for (const [path, content] of Object.entries(
          this.workspace(id).files,
        )) {
          await this.mutateDocument(
            child,
            randomUUID(),
            "void_workspace_write",
            { path, content },
            { by: "web-operator" },
          );
        }
      for (const e of messages)
        this.event(child, e.kind, e.text, {
          importedFrom: id,
          originalSeq: e.seq,
        });
      this.persist();
      return child.view;
    });
  }
  private request(key: string | undefined, value: unknown) {
    if (!key) return;
    if (!/^[A-Za-z0-9_.:-]{1,160}$/.test(key))
      throw new Error("Invalid idempotency key.");
    const prior = this.requests[key];
    if (prior && prior.digest !== JSON.stringify(value))
      throw new Error("Idempotency key belongs to another request.");
    return prior?.sessionId;
  }
  private remember(key: string | undefined, value: unknown, sessionId: string) {
    if (key) {
      this.requests[key] = { digest: JSON.stringify(value), sessionId };
      this.persist();
    }
  }
  connectionState() {
    return {
      connectors: [
        {
          id: "workspace",
          name: "VOID documents",
          builtin: true,
          tools: workspaceTools.map((t) => t.name),
          toolDetails: workspaceTools,
          undo: true,
        },
        ...this.connectors.map(publicConnector),
      ],
    };
  }
  async addConnector(input: McpConfig & { name?: string }) {
    input = connectorInput(input);
    const url = validateEndpoint(input.url, true);
    const policy = input.policy || DEFAULT_POLICY;
    if (!loadPolicy(policy).ok) throw new Error("Invalid VOID policy.");
    if (this.connectors.length >= 12)
      throw new Error("Connector limit reached. Remove an unused connector.");
    const listed = await mcpCatalog({ ...input, url });
    const connector = {
      ...input,
      url,
      policy,
      id: randomUUID(),
      name: input.name?.trim().slice(0, 80) || new URL(url).hostname,
      tools: listed.tools,
    };
    this.connectors.push(connector);
    this.persist();
    return this.connectionState();
  }
  async updateConnector(id: string, body: Record<string, unknown>) {
    const previous = this.connectors.find((item) => item.id === id);
    if (!previous) throw new Error("Connector not found.");
    const input = connectorInput(body, previous),
      url = validateEndpoint(input.url, true),
      policy = input.policy || DEFAULT_POLICY;
    if (!loadPolicy(policy).ok) throw new Error("Invalid VOID policy.");
    const listed = await mcpCatalog({ ...input, url, policy });
    return this.locked(async () => {
      if (this.connectors.find((item) => item.id === id) !== previous)
        throw new Error(
          "Connector changed during validation. Refresh before saving.",
        );
      const replacement = {
        ...input,
        id,
        url,
        policy,
        name: input.name?.trim() || new URL(url).hostname,
        tools: listed.tools,
      };
      const before = this.connectors;
      this.connectors = before.map((item) =>
        item.id === id ? replacement : item,
      );
      try {
        this.persist();
      } catch (error) {
        this.connectors = before;
        throw error;
      }
      return publicConnector(replacement);
    });
  }
  async testConnector(id: string) {
    const config = this.connectors.find((item) => item.id === id);
    if (!config) throw new Error("Connector not found.");
    const listed = await mcpCatalog(config),
      safe = publicConnector({ ...config, tools: listed.tools });
    return {
      ok: true,
      checkedAt: new Date().toISOString(),
      tools: safe.tools,
      toolDetails: safe.toolDetails,
    };
  }
  removeConnector(id: string) {
    this.connectors = this.connectors.filter((c) => c.id !== id);
    this.persist();
  }
  workspace(id: string) {
    const s = this.sessions.get(id);
    if (!s) throw new Error("Session not found.");
    return this.documents[s.view.workspace] ?? createWorkspace();
  }
  private async documentRuntime(
    session: Session,
    approval?: { by?: string; reason?: string },
  ) {
    const workspace = session.view.workspace,
      key = await devKeyProvider({
        dir: join(this.storage.directory, "keys"),
        env: this.env,
      });
    const adapter = managedDocumentAdapter({
      read: async () => {
        await this.ledger(workspace);
        return this.workspace(session.view.id);
      },
      verify: async (operation) => {
        const proof = await this.ledger(workspace),
          captureDigest = await sha256Hex(canonicalJson(operation));
        return !!proof?.entries.some((entry) => {
          const body = entry.body as Record<string, unknown>;
          return (
            body.operationId === operation.id &&
            body.captureDigest === captureDigest &&
            body.decision === "execute:completed"
          );
        });
      },
      commit: async (change, input) => {
        await this.commitWorkspace(
          session,
          change.state,
          input.name,
          input.arguments,
          "execute:completed",
          change.operation,
          approval,
          {
            managedRuntimeOperationId: digest(
              input.name === "void_workspace_undo"
                ? String(input.arguments.operationId)
                : input.id,
            ),
          },
        );
      },
    });
    return recoveryRuntime({
      journal: localOperationJournal(
        join(this.storage.directory, "recovery", "journal"),
        key,
      ),
      vault: this.storage.recoveryVault(),
      adapters: [adapter],
      authorize: async () =>
        approval?.by === "web-operator" ||
        approval?.by === "tui-operator" ||
        !session.controller.signal.aborted,
    });
  }
  private async mutateDocument(
    session: Session,
    id: string,
    name: string,
    args: Record<string, unknown>,
    approval?: { by?: string; reason?: string },
  ) {
    const runtime = await this.documentRuntime(session, approval);
    const result = await runtime.execute({
      workspace: session.view.workspace,
      operationId: digest(id),
      agentId: approval?.by ?? "workbench-agent",
      runId: session.view.runId ?? session.view.id,
      adapterId: "managed-documents",
      arguments: {
        id,
        name,
        arguments: args,
        at: new Date().toISOString(),
      } as Json,
    });
    if (result.status === "unknown" || result.status === "dispatched") throw new UnknownToolOutcome();
    if (result.status !== "succeeded")
      throw new Error(
        `Managed document operation ${result.status}${result.reason ? ": " + result.reason : ""}. Reconcile its evidence before retrying.`,
      );
    return result.result;
  }
  private recoverySession(id: string) {
    const session = this.sessions.get(id);
    if (!session) throw new Error("Session not found.");
    if (this.closing || this.jobs.size || session.view.status === "running" || session.view.status === "queued")
      throw new Error("Wait for the agent to stop before recovery.");
    return session;
  }
  async planRecoveryJob(id: string, input: RecoveryRequest) {
    return this.locked(async () => {
      const request = recoveryRequest(input), session = this.recoverySession(id);
      const runtime = await this.documentRuntime(session);
      const plan = await runtime.planRecoveryJob({ workspace: session.view.workspace, jobId: request.jobId, selection: runtimeSelection(request.selection) });
      this.recoveryRequests[`${id}:${request.jobId}`] = request;
      this.persist();
      return recoveryPreview(plan, recoveryOperationMap(this.workspace(id).operations.map(op => op.id), request.selection));
    });
  }
  async recoveryJobStatus(id: string, jobId: string) {
    return this.locked(async () => {
      const session = this.sessions.get(id);
      if (!session) throw new Error("Session not found.");
      const request = this.recoveryRequests[`${id}:${jobId}`];
      if (!request) throw new Error("Recovery job not found.");
      const runtime = await this.documentRuntime(session);
      const status = await runtime.recoveryJobStatus(session.view.workspace, jobId);
      const ids = recoveryOperationMap(this.workspace(id).operations.map(op => op.id), request.selection);
      return "digest" in status ? recoveryPreview(status, ids) : recoveryResult(status, ids);
    });
  }
  async applyRecoveryJob(id: string, input: RecoveryApply, operator: "web-operator" | "tui-operator" = "web-operator") {
    return this.locked(async () => {
      const session = this.recoverySession(id);
      if (!input || input.approved !== true) throw new Error("Explicit operator approval is required.");
      const request = this.recoveryRequests[`${id}:${input.jobId}`];
      if (!request) throw new Error("Recovery job not found.");
      const runtime = await this.documentRuntime(session, { by: operator });
      // Reload the signed original plan even after a terminal result. A retry
      // cannot exchange its approval for another job or caller-supplied plan.
      const plan = await runtime.planRecoveryJob({ workspace: session.view.workspace, jobId: request.jobId, selection: runtimeSelection(request.selection) });
      if (plan.digest !== input.planDigest) throw new Error("Recovery job digest changed. Refresh the preview.");
      const status = await runtime.recoveryJobStatus(session.view.workspace, request.jobId);
      const result = "digest" in status ? await runtime.runRecoveryJob(session.view.workspace, request.jobId, async stored => stored.digest === input.planDigest) : status;
      return recoveryResult(result, recoveryOperationMap(this.workspace(id).operations.map(op => op.id), request.selection));
    });
  }
  async undoPreview(id: string, operationId: string) {
    const state = this.workspace(id),
      operation = state.operations.find((op) => op.id === operationId);
    const proof = await this.ledger(this.sessions.get(id)!.view.workspace);
    const captureDigest = operation
      ? await sha256Hex(canonicalJson(operation))
      : "";
    if (
      !operation ||
      !proof?.entries.some((e) => {
        const b = e.body as Record<string, unknown>;
        return (
          b.operationId === operationId &&
          b.decision === "execute:completed" &&
          b.captureDigest === captureDigest
        );
      })
    )
      throw new Error("Captured inverse does not match signed evidence.");
    const runtime = await this.documentRuntime(this.sessions.get(id)!);
    const status = await runtime.status(
      this.sessions.get(id)!.view.workspace,
      digest(operationId),
    );
    if (
      !status &&
      proof.entries.some(
        (e) =>
          (e.body as Record<string, unknown>).managedRuntimeOperationId ===
          digest(operationId),
      )
    )
      throw new Error(
        "Managed operation journal is missing. Restore its verified backup before Undo.",
      );
    if (status === "succeeded")
      await runtime.planRecovery(
        this.sessions.get(id)!.view.workspace,
        digest(operationId),
      );
    return previewWorkspaceUndo(state, operationId);
  }
  private serial: Promise<unknown> = Promise.resolve();
  private locked<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.serial.then(fn);
    this.serial = next.catch(() => {});
    return next;
  }
  async undo(
    id: string,
    operationId: string,
    operator: "web-operator" | "tui-operator" = "web-operator",
  ) {
    return this.locked(async () => {
      const session = this.sessions.get(id);
      if (
        this.closing ||
        this.jobs.size ||
        !session ||
        session.view.status === "running"
      )
        throw new Error(
          "Wait for the session to stop before undoing a change.",
        );
      const preview = await this.undoPreview(id, operationId);
      if (
        !preview.canApply &&
        !this.workspace(id).operations.some((op) => op.undoes === operationId)
      )
        throw new Error(preview.reason);
      const runtime = await this.documentRuntime(session, { by: operator }),
        runtimeId = digest(operationId);
      let status = await runtime.status(session.view.workspace, runtimeId);
      if (status) {
        if (status === "unknown" || status === "dispatched")
          status = (await runtime.reconcile(session.view.workspace, runtimeId))
            .status;
        const result =
          status === "succeeded"
            ? await runtime.recover(
                await runtime.planRecovery(session.view.workspace, runtimeId),
                async () => true,
              )
            : await runtime.reconcileRecovery(
                session.view.workspace,
                runtimeId,
              );
        if (result.status !== "restored")
          throw new Error(`Managed document recovery ${result.status}.`);
        this.event(session, "tool", `Undid ${operationId}.`);
        this.persist();
        return { ok: true, workspace: this.workspace(id) };
      }
      const prior = this.workspace(id);
      const transition = applyWorkspaceUndo(this.workspace(id), {
        id: `undo-${operationId}`,
        operationId,
      });
      if (transition.result.isError)
        throw new Error(transition.result.content[0]?.text ?? "Undo refused.");
      if (transition.state === prior) return { ok: true, workspace: prior };
      await this.commitWorkspace(
        session,
        transition.state,
        "void_workspace_undo",
        { operationId },
        "execute:completed",
        transition.operation,
      );
      this.event(
        session,
        "tool",
        `Undid ${transition.operation?.path ?? operationId}.`,
      );
      this.persist();
      return { ok: true, workspace: transition.state };
    });
  }
  /** Signed slice of one workspace for a third party. Verified in repo first. */
  async attest(id: string): Promise<AttestationDocument> {
    const session = this.sessions.get(id);
    if (!session) throw new Error("Session not found.");
    const workspace = session.view.workspace;
    await this.ledger(workspace);
    const dir = await mkdtemp(join(tmpdir(), "void-attest-"));
    try {
      await writeFile(
        join(dir, `${workspace}.jsonl`),
        `${(this.evidence[workspace] ?? []).map((e) => JSON.stringify(e)).join("\n")}\n`,
        { mode: 0o600 },
      );
      const key = await devKeyProvider({
        dir: join(this.storage.directory, "keys"),
        env: this.env,
      });
      return attestLedger(dir, workspace, key);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
  async ledger(workspace: string) {
    if (!Object.hasOwn(this.documents, workspace)) return undefined;
    const entries = this.evidence[workspace] ?? [],
      key = await devKeyProvider({
        dir: join(this.storage.directory, "keys"),
        env: this.env,
      });
    const result = await verifyChain(entries, {
      publicKey: (id) => key.publicKey(id),
    });
    if (!result.ok)
      throw new Error("Workspace ledger signature verification failed.");
    return { entries, result };
  }
  private async commitWorkspace(
    session: Session,
    state: WorkspaceState,
    tool: string,
    args: unknown,
    decision: string,
    operation?: WorkspaceOperation,
    approval?: { by?: string; reason?: string },
    metadata?: Record<string, unknown>,
  ) {
    const workspace = session.view.workspace;
    const current = this.evidence[workspace] ?? [];
    const key = await devKeyProvider({
      dir: join(this.storage.directory, "keys"),
      env: this.env,
    });
    const body = {
      ...(approval?.by ? { approvedBy: approval.by } : {}),
      ...(approval?.reason ? { approvalReason: approval.reason } : {}),
      workspace,
      at: new Date().toISOString(),
      tool,
      klass:
        workspaceToolClass(tool) ??
        (tool === "void_workspace_undo" ? "r1" : "r3"),
      decision,
      argsDigest: `sha256:${await sha256Hex(canonicalJson(args))}`,
      ...(operation
        ? {
            operationId: operation.id,
            captureDigest: await sha256Hex(canonicalJson(operation)),
          }
        : {}),
      ...metadata,
    };
    const previous = current.at(-1)?.hash ?? GENESIS_PREV,
      hash = await entryHash(body, previous, sha256Hex),
      keyId = await key.currentKeyId();
    const entry: JsonlEntry = {
      workspace,
      seq: current.length + 1,
      body,
      prev_hash: previous,
      hash,
      key_id: keyId,
      alg: key.alg,
      signature: `${key.alg}:${Buffer.from(await key.sign(signingPreimage(key.alg, keyId, hash))).toString("base64")}`,
    };
    const before = this.documents[workspace];
    this.documents[workspace] = state;
    this.evidence[workspace] = [...current, entry];
    try {
      this.persist();
    } catch (error) {
      this.documents[workspace] = before!;
      this.evidence[workspace] = current;
      throw error;
    }
  }
  private async syncStdio(session: Session) {
    return this.locked(async () => {
      const path = join(
        this.env.VOID_LEDGER_DIR ?? join(homedir(), ".void", "ledger"),
        `${session.view.workspace}.jsonl`,
      );
      let entries: JsonlEntry[];
      try {
        entries = await readLedgerEntries(path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
        throw error;
      }
      // The SDK uses this same signer. Preserve and link the original signed
      // authorization events instead of hiding them behind the document ledger.
      const key = await devKeyProvider();
      const verified = await verifyChain(entries, {
        publicKey: (id) => key.publicKey(id),
      });
      if (!verified.ok)
        throw new Error("The stdio proxy ledger failed verification.");
      for (const entry of entries) {
        if (
          this.evidence[session.view.workspace]?.some(
            (e) =>
              (e.body as Record<string, unknown>).sourceDigest === entry.hash,
          )
        )
          continue;
        const body = entry.body as Record<string, unknown>;
        await this.commitWorkspace(
          session,
          this.workspace(session.view.id),
          String(body.tool),
          {},
          String(body.decision),
          undefined,
          undefined,
          { ...body, source: "stdio-proxy", sourceDigest: entry.hash },
        );
      }
    });
  }
  private async execute(
    session: Session,
    tool: McpTool,
    args: JsonObject,
    id: string,
  ): Promise<unknown> {
    if (tool.connectorId === "stdio") {
      if (!session.client)
        throw new Error("This stdio connection ended. Start a new session.");
      try {
        return await session.client.request("tools/call", {
          name: tool.name,
          arguments: args,
        });
      } catch {
        throw new UnknownToolOutcome();
      } finally {
        await this.syncStdio(session);
      }
    }
    if (!tool.connectorId)
      return this.locked(async () => {
        await this.ledger(session.view.workspace);
        if (
          tool.name === "void_workspace_write" ||
          tool.name === "void_workspace_delete"
        )
          return this.mutateDocument(session, id, tool.name, args);
        const transition = executeWorkspaceTool(
          this.workspace(session.view.id),
          { id, name: tool.name, arguments: args },
        );
        await this.commitWorkspace(
          session,
          transition.state,
          tool.name,
          args,
          transition.result.isError ? "execute:failed" : "execute:completed",
          transition.operation,
        );
        return transition.result;
      });
    const config = session.connections?.[tool.connectorId];
    if (!config) throw new Error("Connector not available in this session.");
    const name = config.mapping?.[tool.name] ?? tool.name;
    const classification = classifyTool(name, {
      facts: config.facts ?? {},
      args,
    });
    // The hold keeps the classification evidence, not only its tone, so the
    // operator decides from the matched case rather than a bare class label.
    const callReason =
      classification.outcome === "classified"
        ? classification.reason
        : classification.outcome === "unknown-tool"
          ? "No registry entry covers this tool. Fail closed as R3."
          : `No registry case matched. Assumed ${classification.assumeTone ?? "r3"}${classification.missingFacts.length ? `; missing facts: ${classification.missingFacts.join(", ")}` : ""}.`;
    const call = {
      tool: name,
      workspace: session.view.workspace,
      klass:
        classification.outcome === "classified" ? classification.tone : "r3",
      connector: tool.connectorId,
      blastRadius: undefined,
      reason: callReason,
      arguments: args,
    };
    const policy = loadPolicy(config.policy ?? DEFAULT_POLICY);
    if (!policy.ok) throw new Error("Invalid policy.");
    const decision =
      classification.outcome === "classified"
        ? decide(policy, call)
        : { kind: "deny" as const };
    await this.locked(() =>
      this.commitWorkspace(
        session,
        this.workspace(session.view.id),
        name,
        args,
        decision.kind,
        undefined,
        undefined,
        { klass: call.klass },
      ),
    );
    let allowed = decision.kind === "allow";
    if (decision.kind === "hold") {
      const hold: {
        holdId: string;
        call: typeof call;
        expiresAt: number;
        status: "pending" | "approved" | "denied";
        notify: string[];
        by?: string;
        reason?: string;
      } = {
        holdId: `${session.view.id}:${randomUUID()}`,
        call,
        expiresAt: Date.now() + decision.seconds * 1000,
        status: "pending" as "pending" | "approved" | "denied",
        notify: [],
      };
      this.holds.set(hold.holdId, hold);
      this.event(session, "tool", `${name}: waiting for your approval.`);
      this.persist();
      while (
        hold.status === "pending" &&
        hold.expiresAt > Date.now() &&
        !session.controller.signal.aborted
      )
        await delay(100);
      allowed =
        hold.status === "approved" && !session.controller.signal.aborted;
      if (session.controller.signal.aborted && hold.status === "pending") {
        hold.status = "denied";
        hold.by = "runtime";
        hold.reason = "Session cancelled before approval.";
      }
      await this.locked(() =>
        this.commitWorkspace(
          session,
          this.workspace(session.view.id),
          name,
          args,
          allowed ? "hold:approved" : "hold:denied",
          undefined,
          hold,
          { klass: call.klass },
        ),
      );
      this.approvalHistory.push({ ...hold });
      this.holds.delete(hold.holdId);
    }
    if (!allowed)
      return {
        isError: true,
        content: [
          { type: "text", text: denialText(name, call.klass, decision) },
        ],
      };
    if (session.controller.signal.aborted)
      throw new Error("Session cancelled.");
    let result;
    try {
      result = await rpc(
        config,
        "tools/call",
        { name: tool.name, arguments: args },
        config.sessionId,
      );
    } catch (error) {
      await this.locked(() =>
        this.commitWorkspace(
          session,
          this.workspace(session.view.id),
          name,
          args,
          "execute:unknown",
          undefined,
          undefined,
          { klass: call.klass },
        ),
      );
      throw new UnknownToolOutcome();
    }
    await this.locked(() =>
      this.commitWorkspace(
        session,
        this.workspace(session.view.id),
        name,
        args,
        result.result?.isError ? "execute:failed" : "execute:completed",
        undefined,
        undefined,
        { klass: call.klass },
      ),
    );
    return config.token
      ? (JSON.parse(
          JSON.stringify(result.result).split(config.token).join("[redacted]"),
        ) as unknown)
      : result.result;
  }
  private recordProviderFailure(error: unknown) {
    this.providerFailureState = {
      status: error instanceof ProviderRequestError ? error.status : 503,
      retryAt: error instanceof ProviderRequestError && error.retryAfter !== undefined
        ? new Date(Date.now() + error.retryAfter * 1000).toISOString() : null,
    };
  }
  private async run(session: Session): Promise<void> {
    try {
      const listed = { tools: session.tools ?? [...workspaceTools] };
      const mapping = new Map(
        listed.tools.map((tool, index) => [`tool_${index}`, tool]),
      );
      const tools = listed.tools.map((tool, index) => ({
        type: "function",
        function: {
          name: `tool_${index}`,
          description: `${tool.name}: ${tool.description ?? ""}`,
          parameters: tool.inputSchema ?? { type: "object", properties: {} },
        },
      }));
      for (let turn = 0; turn < 20; turn++) {
        if (session.controller.signal.aborted) return;
        if (session.messages.length >= 200)
          throw new Error(
            "Session context limit reached. Start a new session.",
          );
        let delta = "";
        let flushed = Date.now();
        const reply = await session.provider.complete(
          session.view.model,
          session.messages,
          tools,
          session.controller.signal,
          (text) => {
            if (session.controller.signal.aborted) return;
            delta += text;
            if (Date.now() - flushed > 250 || delta.length > 512) {
              this.event(session, "assistant", delta, {}, "message.delta");
              delta = "";
              flushed = Date.now();
              this.persist();
            }
          },
        );
        if (session.controller.signal.aborted) return;
        if (delta) this.event(session, "assistant", delta, {}, "message.delta");
        session.messages.push(reply.message);
        if (reply.message.content)
          this.event(session, "assistant", reply.message.content);
        if (reply.usage)
          this.event(
            session,
            "usage",
            `${reply.usage.total_tokens ?? "Unknown"} tokens reported by provider`,
            {
              ...reply.usage,
              model: session.view.model,
              source: "provider",
              cost: null,
            },
          );
        if ((reply.message.tool_calls?.length ?? 0) > 32)
          throw new Error("Provider exceeded the 32-tool batch limit.");
        if (!reply.message.tool_calls?.length) {
          session.view = { ...session.view, status: "idle" };
          this.persist();
          return;
        }
        for (const [callIndex, call] of reply.message.tool_calls.entries()) {
          if (session.controller.signal.aborted) return;
          const tool = mapping.get(call.function.name);
          const name = tool?.name;
          if (!name)
            throw new Error(
              "Provider requested a tool outside the approved MCP catalog.",
            );
          let args: unknown;
          try {
            args = JSON.parse(call.function.arguments);
          } catch {
            throw new Error("Provider returned malformed tool arguments.");
          }
          if (!args || typeof args !== "object" || Array.isArray(args))
            throw new Error("Tool arguments must be an object.");
          this.event(
            session,
            "tool",
            `Requested ${name}. VOID will decide before execution.`,
            { tool: name, callId: call.id, arguments: args },
            "tool.started",
          );
          let result: unknown;
          try {
            result = await this.execute(
              session,
              tool!,
              args as JsonObject,
              `${session.view.runId}-${turn}-${callIndex}`,
            );
          } catch (error) {
            if (error instanceof UnknownToolOutcome) throw error;
            result = {
              isError: true,
              content: [
                {
                  type: "text",
                  text: "VOID refused or could not execute this call. Do not retry; ask the operator.",
                },
              ],
            };
          }
          if (session.controller.signal.aborted) return;
          this.event(
            session,
            "tool",
            `${name}: ${(result as { isError?: boolean })?.isError ? "refused or failed" : "result received"}`,
            { tool: name, callId: call.id, result },
          );
          session.messages.push({
            role: "tool",
            tool_call_id: call.id,
            content: session.provider
              .redact(JSON.stringify(result))
              .slice(0, 64000),
          });
        }
      }
      throw new Error(
        "Session reached the 20-turn limit. Review the ledger before continuing.",
      );
    } catch (error) {
      if (!session.controller.signal.aborted) {
        if (error instanceof ProviderRequestError && session.provider === this.provider) this.recordProviderFailure(error);
        const failure =
          error instanceof ProviderRequestError
            ? providerFailure(error)
            : undefined;
        this.event(
          session,
          "error",
          failure?.text ??
            (error instanceof Error ? error.message : "Session failed."),
          failure?.payload ?? {},
        );
        session.view = { ...session.view, status: error instanceof UnknownToolOutcome ? "unknown" : "failed" };
        session.client?.close();
      }
    } finally {
      this.event(
        session,
        "tool",
        session.view.status,
        { status: session.view.status },
        "run.status",
      );
      this.persist();
    }
  }
}

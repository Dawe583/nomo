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
  NVIDIA_URL,
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
  deriveRunState,
  MAX_QUEUED_RUNS,
  type ProviderStatus,
  type ViewName,
  type RunState,
  type PermissionMode,
  serverPermissionMode,
  DEFAULT_LOCAL_PERMISSION_MODE,
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
import { devKeyProvider, retainedKeyProvider, sha256Hex } from "../../ledger/src/sign.ts";
import {
  canonicalJson,
  entryHash,
  GENESIS_PREV,
} from "../../ledger/src/canonical.ts";
import { signingPreimage } from "../../ledger/src/index.ts";
import { resolveVerificationKey, type VerificationKey } from "../../ledger/src/verify-key.ts";
import type { KeyProvider } from "../../ledger/src/index.ts";
import { verifyChain, readLedgerEntries } from "../../ledger/src/verify.ts";
import type { JsonlEntry } from "../../ledger/src/store.ts";
import { classifyTool } from "../../registry/src/evaluate.ts";
import { loadPolicy, type ValidPolicy } from "../../policy/src/rules.ts";
import { decide, type PolicyDecision } from "../../policy/src/decide.ts";
import { policyDigest } from "../../policy/src/digest.ts";
import {
  buildAttribution,
  type LedgerAttribution,
} from "../../ledger/src/attribution.ts";
import { buildReversal, type LedgerReversal } from "../../ledger/src/reversal.ts";
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
import { HoldDeniedError } from "../../sdk/src/errors.ts";
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
  readonly compaction?: CompactionResult;
  readonly contextMessages?: number;
  readonly lastRecoveryJob?: { readonly jobId: string };
  readonly state?: RunState;
  readonly status: "running" | "queued" | "idle" | "cancelled" | "failed" | "unknown" | "paused";
  readonly events: readonly SessionEvent[];
};
/** Model ids VOID once shipped as its default. They are retired on sight: the
 * workspace picks from its own validated catalog or has no model at all. */
const RETIRED_MODEL_IDS = [
  "openai-fast",
  "muse-spark-1.3-contributor-free",
  "z-ai/glm-5.3-free",
];
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
/**
 * The forward record an undo inverts, located in the chain this workspace
 * already holds. The search is the same one the managed document adapter uses
 * to prove a receipt, because both are asking the same question: which signed
 * record says this operation completed. The latest match wins, because a
 * retried operation appends more than one completed record and the newest is
 * the one the undo is about.
 *
 * Failing here throws before the entry is hashed, so an undo whose target is
 * not in the chain leaves the workspace untouched rather than leaving a signed
 * claim about an inversion nobody can check.
 */
function reversalFor(
  entries: readonly JsonlEntry[],
  args: unknown,
): LedgerReversal {
  const operationId = (args as { readonly operationId?: unknown } | null)
    ?.operationId;
  if (typeof operationId !== "string" || operationId === "")
    throw new Error("Undo record carries no operation id to reverse.");
  const forward = entries
    .filter((entry) => {
      const body = entry.body as Record<string, unknown>;
      return (
        body.operationId === operationId && body.decision === "execute:completed"
      );
    })
    .at(-1);
  if (forward === undefined)
    throw new Error(
      `Undo cannot name a completed record for ${operationId} in this chain.`,
    );
  return buildReversal(forward.seq, forward.hash);
}
class UnknownToolOutcome extends Error {
  constructor() { super("Tool outcome is unknown. Stop and reconcile its evidence before continuing."); }
}
class ProviderSetupSuperseded extends Error {
  constructor() { super("Provider setup was superseded by a newer configuration."); }
}
type Connector = McpConfig & {
  id: string;
  name: string;
  tools: McpTool[];
  consentState: "staged" | "probed" | "confirmed";
};
type Session = {
  view: SessionView;
  messages: ModelMessage[];
  /**
   * Digest of the model request that is in flight for this turn. It lives
   * here rather than in the view because it describes one turn and is not
   * part of the session a reader sees, and a restored session correctly has
   * none: no request is in flight, so there is nothing to name.
   */
  requestDigest?: string;
  messageIds?: string[];
  agentProfile?: AgentProfile;
  queuedPrompt?: string;
  recoveryBlock?: { jobId: string; previousStatus: SessionView["status"] };
  client?: VoidClient;
  tools?: McpTool[];
  connections?: Record<string, McpConfig & { sessionId?: string }>;
  config?: Pick<ProviderConfig, "baseUrl" | "kind">;
  controller: AbortController;
  provider?: CompatibleProvider;
};

/** Model tools always cross the existing VOID SDK. A provider has no shell or
 * filesystem authority; operators configure the MCP upstream on the runtime. */
export class Workbench {
  private readonly env: Readonly<NodeJS.ProcessEnv>;
  private readonly permissionMode: PermissionMode;
  private provider: CompatibleProvider | undefined;
  private providerFailureState: { status: number; retryAt: string | null } | null = null;
  private readonly storage: LocalStorage;
  private hasState = false;
  /** VOID ships no default model and no default provider, so neither key is
   * present until a provider is configured or a preference is patched. */
  private preferences: Record<string, string | undefined> = {
    defaultAgentPreset: "default",
    locale: "cs",
    appearance: "system",
    sendBehavior: "enter",
  };
  private requests: Record<string, { digest: string; sessionId: string }> = {};
  private approvalHistory: unknown[] = [];
  private readonly keyStorage: string;
  private config: ProviderConfig | undefined;
  private providerGeneration = 0;
  private providerSetupCount = 0;
  private sessionSetupCount = 0;
  private profiles: Record<string, ProviderConfig> = {};
  private connectors: Connector[] = [];
  private documents: Record<string, WorkspaceState> = {};
  private evidence: Record<string, JsonlEntry[]> = {};
  private recoveryRequests: Record<string, RecoveryRequest> = {};
  private agentProfiles: AgentProfile[] = [];
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
    this.permissionMode = serverPermissionMode(env.VOID_PERMISSION_MODE ?? DEFAULT_LOCAL_PERMISSION_MODE);
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
      ignoreEnvironment?: boolean;
      profiles?: Record<string, ProviderConfig>;
      catalog: readonly Model[];
      connectors: Array<Omit<Connector, "consentState"> & { consentState?: Connector["consentState"] }>;
      documents: Record<string, WorkspaceState>;
      evidence: Record<string, JsonlEntry[]>;
      recoveryRequests?: Record<string, RecoveryRequest>;
      agentProfiles?: AgentProfile[];
      sessions: Array<{
        view: SessionView;
        messages: ModelMessage[];
        messageIds?: string[];
        agentProfile?: AgentProfile;
        recoveryBlock?: Session["recoveryBlock"];
        queuedPrompt?: string;
        config?: { baseUrl: string; kind?: string };
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
      const retiredModel = RETIRED_MODEL_IDS.includes(
        preferences.defaultModel ?? "",
      );
      this.preferences = {
        ...this.preferences,
        ...preferences,
        defaultAgentPreset,
      };
      if (retiredModel) {
        // The retired id leaves the preference instead of being rewritten to a
        // vendor's model. A workspace with a validated catalog re-picks from it;
        // one without has no model until a provider is configured.
        const replacement = saved.catalog?.find(
          (model) => !RETIRED_MODEL_IDS.includes(model.id),
        )?.id;
        if (replacement) this.preferences.defaultModel = replacement;
        else delete this.preferences.defaultModel;
        migrated = true;
      }
      if (preferences.defaultAgentPreset !== defaultAgentPreset)
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
        !!Object.keys(saved.profiles ?? {}).length ||
        saved.ignoreEnvironment === true;
      this.ignoreEnvironment = saved.ignoreEnvironment === true;
      this.config = loadConfig(saved.config);
      this.profiles = {};
      for (const [baseUrl, value] of Object.entries(saved.profiles ?? {})) {
        const profile = loadConfig(value);
        if (profile) this.profiles[baseUrl] = profile;
      }
      this.catalog = saved.catalog;
      // A snapshot written before the consent gate records no consent state.
      // It loads as staged with no catalog: the operator probes it explicitly.
      this.connectors = saved.connectors.map((item): Connector => {
        if (item.consentState) return { ...item, consentState: item.consentState };
        migrated = true;
        return { ...item, consentState: "staged", tools: [] };
      });
      this.documents = saved.documents;
      this.evidence = saved.evidence;
      this.recoveryRequests = saved.recoveryRequests ?? {};
      this.agentProfiles = (saved.agentProfiles ?? []).map(profile => validateAgentProfile(profile));
      this.projectList = saved.projects ?? [];
      if (this.config)
        this.provider = new CompatibleProvider(this.config, fetcher);
      for (const item of saved.sessions) {
        const sessionBaseUrl = typeof item.config?.baseUrl === "string"
          ? item.config.baseUrl
          : typeof item.view.provider === "string" ? item.view.provider : undefined;
        if (item.config && Object.hasOwn(item.config, "apiKey")) migrated = true;
        const sessionKind = item.config?.kind === "anthropic"
          ? "anthropic"
          : item.config?.kind === "compatible" || item.config?.kind === "openai"
            ? "compatible"
            : undefined;
        if (item.config && item.config.kind !== sessionKind) migrated = true;
        const savedProvider = sessionBaseUrl
          ? this.profiles[sessionBaseUrl] ?? (this.config?.baseUrl === sessionBaseUrl ? this.config : undefined)
          : undefined;
        const provider = sessionKind && savedProvider?.kind === sessionKind ? savedProvider : undefined;
        this.sessions.set(item.view.id, {
          ...item,
          config: sessionBaseUrl ? { baseUrl: sessionBaseUrl, kind: sessionKind } : undefined,
          view: {
            ...item.view,
            status: item.view.status === "running" ? "unknown" : item.view.status === "queued" ? "paused" : item.view.status,
          },
          provider: provider ? new CompatibleProvider(provider, fetcher) : undefined,
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
      !this.connectors.length &&
      !this.ignoreEnvironment
    )
      return;
    this.storage.save({
      preferences: this.preferences,
      requests: this.requests,
      approvalHistory: [...this.approvalHistory, ...this.holds.values()],
      config: this.config,
      ignoreEnvironment: this.ignoreEnvironment,
      profiles: this.profiles,
      catalog: this.catalog,
      connectors: this.connectors,
      documents: this.documents,
      evidence: this.evidence,
      recoveryRequests: this.recoveryRequests,
      agentProfiles: this.agentProfiles,
      projects: this.projectList,
      sessions: [...this.sessions.values()].map(
        ({ view, messages, messageIds, agentProfile, recoveryBlock, queuedPrompt, config, tools, connections }) => ({
          view,
          messages,
          messageIds,
          agentProfile,
          recoveryBlock,
          queuedPrompt,
          config: config ? { baseUrl: config.baseUrl, kind: config.kind } : undefined,
          tools,
          connections,
        }),
      ),
    });
    this.hasState = true;
  }
  async configure(config: ProviderConfig): Promise<readonly Model[]> {
    const generation = ++this.providerGeneration;
    this.providerSetupCount++;
    try {
      config = normalizeProviderConfig({
        ...config,
        apiKey: config.apiKey || this.profiles[config.baseUrl]?.apiKey || "",
      });
      const provider = new CompatibleProvider(config, this.fetcher);
      const models = await provider.models();
      if (generation !== this.providerGeneration)
        throw new ProviderSetupSuperseded();
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
      // The preference the operator already made is honoured when this provider
      // serves it; otherwise the first model of the validated catalog is used.
      // No vendor's model is inserted on the operator's behalf.
      const preferred =
        models.find((model) => model.id === this.preferences.defaultModel)?.id ??
        models[0]!.id;
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
    } finally {
      this.providerSetupCount--;
    }
  }
  async providerState(options: { reconnectEnvironment?: boolean } = {}) {
    if (options.reconnectEnvironment && this.ignoreEnvironment) {
      this.ignoreEnvironment = false;
      try {
        this.persist();
      } catch (error) {
        this.ignoreEnvironment = true;
        throw error;
      }
    }
    if (!this.provider && !this.ignoreEnvironment && this.env.NVIDIA_API_KEY && !this.providerFailureState) {
      try {
        await this.configure({ baseUrl: NVIDIA_URL, apiKey: this.env.NVIDIA_API_KEY });
      } catch (error) {
        if (!this.ignoreEnvironment && !(error instanceof ProviderSetupSuperseded))
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
      // A workspace with nothing configured has no provider, and says so
      // instead of naming one vendor.
      providerId: this.config
        ? (PROVIDER_PRESETS.find((p) => p.baseUrl === this.config?.baseUrl)?.id ??
          "custom")
        : null,
      defaultModel: this.preferences.defaultModel ?? null,
      upstreamConfigured: true,
      status: derived.status,
      detail: derived.detail,
      retryAt: derived.retryAt,
    };
  }
  agents() {
    return {
      supported: true,
      agents: [
        ...AGENT_PRESETS.map(({ id, name, description }) => ({ id, name, description })),
        ...this.agentProfiles.map(({ id, name }) => ({ id, name, description: "Custom profile with explicit tools and bounded execution." })),
      ],
      profiles: structuredClone(this.agentProfiles),
      policyProfiles: ["default"],
      hooks: [] as Hook[], hookCommands: [] as string[], hooksSupported: false,
    };
  }
  upsertAgent(input: unknown): AgentProfile {
    const profile = validateAgentProfile(input);
    if (AGENT_PRESETS.some(preset => preset.id === profile.id)) throw new Error("Agent id belongs to a built-in preset.");
    if (profile.policyProfile !== "default") throw new Error("Unknown policy profile. Select the existing default operator policy.");
    const available = new Set([...workspaceTools, ...this.connectors.flatMap(connector => connector.tools)].map(tool => tool.name));
    if (profile.allowedTools.some(name => !available.has(name))) throw new Error("Agent allowlist contains an unavailable tool.");
    const before = this.agentProfiles;
    this.agentProfiles = [...before.filter(candidate => candidate.id !== profile.id), profile];
    this.hasState = true;
    try { this.persist(); } catch (error) { this.agentProfiles = before; throw error; }
    return structuredClone(profile);
  }
  upsertHook(input: unknown): Hook {
    validateHook(input, []);
    throw new Error("Hook execution is unsupported on this host.");
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
    const activityResult = activity(this.allViews());
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
    if (this.jobs.size || this.queued.size)
      throw new Error("Stop active sessions before disconnecting the provider.");
    if (this.providerSetupCount || this.sessionSetupCount)
      throw new Error(
        "Wait for provider setup or session startup to finish before disconnecting the provider.",
      );
    const previous = {
      provider: this.provider,
      config: this.config,
      profiles: this.profiles,
      catalog: this.catalog,
      failure: this.providerFailureState,
      ignoreEnvironment: this.ignoreEnvironment,
      sessions: [...this.sessions.values()].map((session) => ({
        session,
        provider: session.provider,
      })),
    };
    this.providerGeneration++;
    this.providerFailureState = null;
    this.ignoreEnvironment = true;
    this.provider = undefined;
    this.config = undefined;
    this.profiles = {};
    this.catalog = [];
    for (const session of this.sessions.values()) session.provider = undefined;
    try {
      this.persist();
    } catch (error) {
      this.provider = previous.provider;
      this.config = previous.config;
      this.profiles = previous.profiles;
      this.catalog = previous.catalog;
      this.providerFailureState = previous.failure;
      this.ignoreEnvironment = previous.ignoreEnvironment;
      for (const item of previous.sessions) item.session.provider = item.provider;
      throw error;
    }
  }
  private view(session: Session): SessionView {
    const jobId = session.recoveryBlock?.jobId ?? session.view.lastRecoveryJob?.jobId;
    return {
      ...session.view,
      lastRecoveryJob: jobId ? { jobId } : undefined,
      contextMessages: session.messages.length,
      state: session.view.status === "cancelled" && this.jobs.has(session.view.id)
        ? "stopping" : deriveRunState(session.view.status, session.view.events),
    };
  }
  list(): readonly SessionView[] {
    return this.allViews().map(view => ({ ...view, events: [] }));
  }
  availableTools(id?: string) {
    const session = id ? this.sessions.get(id) : undefined;
    if (id && !session) throw new Error("Session not found.");
    const tools = (session
      ? (session.tools ?? [...workspaceTools])
      : [
          ...workspaceTools,
          ...this.connectors
            .filter(c => c.consentState === "confirmed")
            .flatMap((c) =>
              c.tools.map((tool) => ({ ...tool, connectorId: c.id })),
            ),
        ]
    ).filter((tool) => this.toolAllowedInMode(tool));
    return {
      scope: id ? "session" : "configured",
      tools: toolCatalog(
        tools,
        [
          ...this.connectors.map((c) => c.token),
          ...Object.values(session?.connections ?? {}).map((c) => c.token),
        ],
      ),
    };
  }
  get(id: string): SessionView | undefined {
    const session = this.sessions.get(id);
    return session && this.view(session);
  }
  async start(
    prompt: string,
    model?: string,
    key?: string,
    project?: string,
    agent?: string,
    background = false,
  ): Promise<SessionView> {
    return this.locked(async () => {
      const selected = model ?? this.preferences.defaultModel;
      const prior = selected
        ? this.request(key, [
            "start",
            prompt,
            selected,
            project,
            agent,
            background,
          ])
        : undefined;
      if (prior) return this.get(prior)!;
      await this.providerState();
      // There is no default model to fall back on. A provider configured from
      // the environment above may have set one; otherwise the operator picks.
      const selectedModel = selected ?? this.preferences.defaultModel;
      if (!selectedModel)
        throw new Error("Select a model from the validated catalog.");
      const result = await this.startSession(
        prompt,
        selectedModel,
        project,
        agent,
        background,
      );
      this.remember(
        key,
        ["start", prompt, selectedModel, project, agent, background],
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
    if (this.providerSetupCount)
      throw new Error("Wait for provider setup to finish before starting a session.");
    if (background && this.queued.size >= MAX_QUEUED_RUNS)
      throw new Error(`Background queue is full (${MAX_QUEUED_RUNS} queued runs). Stop a queued run before adding another.`);
    const selectedAgent = AGENT_PRESETS.find(
      (item) => item.id === (agent ?? this.preferences.defaultAgentPreset),
    );
    const selectedProfile = this.agentProfiles.find(profile => profile.id === agent);
    if (agent && !selectedAgent && !selectedProfile) throw new Error("Unknown agent preset or profile.");
    const selectedGeneration = this.providerGeneration,
      selectedProvider = this.provider,
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
    this.sessionSetupCount++;
    try {
      for (const connector of this.connectors) {
        if (connector.consentState !== "confirmed") continue;
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
    } catch (error) {
      client?.close();
      throw error;
    } finally {
      this.sessionSetupCount--;
    }
    if (this.providerGeneration !== selectedGeneration) {
      client?.close();
      throw new Error(
        "Provider changed while connecting tools. Retry after provider setup finishes.",
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
    const systemInstruction = `You are operating through VOID. Tool calls are classified, governed by policy, and recorded. Respect denied calls; do not retry them with reworded arguments. Wait for operator approval of held calls. Only claim completed actions when they are proven by tool results. You have a managed document workspace with list, read, write and delete tools. Changes in that workspace are captured and can be undone by the operator. These tools do not access the host filesystem. Use them when asked to create or edit documents.${selectedAgent?.instruction ? `\n\nActive agent preset (${selectedAgent.id}): ${selectedAgent.instruction}` : ""}${selectedProfile ? `\n\nActive agent profile (${selectedProfile.id}): ${selectedProfile.systemPrompt}` : ""}`;
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
        agent: selectedProfile?.id ?? selectedAgent?.id,
        createdAt: new Date().toISOString(),
        title: prompt.trim().slice(0, 80),
        status: queued ? "queued" : "idle",
        ...(queued ? { runId: randomUUID() } : {}),
        events: [],
      },
      messages: [{ role: "system", content: systemInstruction }],
      agentProfile: selectedProfile ? structuredClone(selectedProfile) : undefined,
      queuedPrompt: queued ? prompt : undefined,
      client,
      tools: (selectedProfile ? tools.filter(tool => selectedProfile.allowedTools.includes(tool.name)) : tools).filter(tool => this.toolAllowedInMode(tool)),
      connections,
      config: selectedConfig ? { baseUrl: selectedConfig.baseUrl, kind: selectedConfig.kind } : undefined,
      controller: new AbortController(),
      provider: selectedProvider,
    };
    this.sessions.set(id, session);
    if (queued) {
      this.queued.add(id);
      this.event(session, "user", prompt);
      this.event(session, "tool", "Queued", { status: "queued" }, "run.status");
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
    if (session.recoveryBlock)
      throw new Error("Recovery is unresolved. Resume the approved recovery job before continuing.");
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
    if (!session.provider) {
      const config = this.config;
      const identity = session.config;
      if (!identity?.kind)
        throw new Error(
          "This conversation has no saved provider protocol. Start a new conversation rather than switching providers.",
        );
      if (
        !this.provider ||
        !config ||
        identity.baseUrl !== config.baseUrl ||
        identity.kind !== config.kind
      )
        throw new Error("Reconnect the provider used by this conversation before continuing.");
      session.provider = this.provider;
    }
    session.controller = new AbortController();
    const queued = session.view.status === "idle" && session.queuedPrompt === prompt;
    if (!queued) session.view = { ...session.view, runId: randomUUID() };
    delete session.queuedPrompt;
    session.messages.push({ role: "user", content: prompt });
    if (!queued) this.event(session, "user", prompt);
    session.view = { ...session.view, status: "running" };
    this.event(session, "tool", "Running", { status: "running" }, "run.status");
    this.persist();
    this.remember(key, [id, prompt], id);
    const job = this.run(session);
    this.jobs.set(id, job);
    void job
      .catch(() => {
        if (session.view.status !== "unknown") session.view = { ...session.view, status: "failed" };
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
    session.view = { ...session.view, compaction: compacted.result, contextMessages: session.messages.length };
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
    if (session.view.status === "unknown" || session.recoveryBlock) return;
    if (session.view.status === "queued") {
      this.queued.delete(id);
      delete session.queuedPrompt;
      session.view = { ...session.view, status: "cancelled" };
      this.event(session, "tool", "Queued run stopped before dispatch.", { status: "cancelled" }, "run.status");
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
    let safeText = session.provider?.redact(JSON.stringify(payload)) ?? JSON.stringify(payload);
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
          text: (session.provider?.redact(text) ?? text).slice(0, 32000),
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
  permissionModeState() {
    return this.permissionMode;
  }
  private assertNormalMutation(action: string) {
    if (this.permissionMode !== "normal")
      throw new Error(`Server permission mode ${this.permissionMode} forbids ${action}.`);
  }
  private toolAllowedInMode(tool: McpTool) {
    return this.permissionMode === "normal" || (!tool.connectorId && (tool.name === "void_workspace_list" || tool.name === "void_workspace_read"));
  }
  patchSession(id: string, body: Record<string, unknown>) {
    const session = this.sessions.get(id);
    if (!session) throw new Error("Session not found.");
    const patch = sessionPatch(body);
    session.view = { ...session.view, ...patch, updatedAt: new Date().toISOString() };
    this.persist();
    return this.view(session);
  }
  sessionPage(query: URLSearchParams) {
    const all = filterRows(
      this.allViews(),
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
    return [...this.sessions.values()].map(session => this.view(session));
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
  private settledSession(id: string): Session {
    const session = this.sessions.get(id);
    if (!session) throw new Error("Session not found.");
    if (this.closing || this.jobs.size || session.recoveryBlock || !["idle", "cancelled", "failed"].includes(session.view.status))
      throw new Error("Wait for the session to stop and settle. Reconcile unresolved recovery before changing documents.");
    return session;
  }
  async editDocument(
    id: string,
    input: { path: string; content: string; expectedRevision: string | null },
    operator: "web-operator" | "tui-operator" = "web-operator",
  ) {
    this.assertNormalMutation("document editing");
    return this.locked(async () => {
      const s = this.settledSession(id);
      const state = this.workspace(id);
      if (documentView(state, input.path, id).revision !== input.expectedRevision)
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
    body: { seq: number; prompt?: string; snapshotDocuments?: boolean; idempotencyKey: string },
  ) {
    return this.locked(async () => {
      if (typeof body.idempotencyKey !== "string" || !/^[A-Za-z0-9_.:-]{1,160}$/.test(body.idempotencyKey))
        throw new Error("Invalid Idempotency key.");
      const idempotencyKey = body.idempotencyKey;
      const requestValue = [id, body.seq, body.prompt, body.snapshotDocuments === true];
      const prior = this.request(idempotencyKey, requestValue);
      if (prior) {
        const child = this.sessions.get(prior);
        if (!child) throw new Error("Idempotent branch result is unavailable.");
        return child.view;
      }
      if (this.jobs.size)
        throw new Error("Wait for the active run to settle before branching.");
      const parent = this.sessions.get(id);
      if (
        !parent ||
        !Number.isSafeInteger(body.seq) ||
        !parent.view.events.some((e) => e.seq === body.seq)
      )
        throw new Error("Choose an existing message.");
      const state = deriveRunState(parent.view.status, parent.view.events);
      if (
        state === "unknown" ||
        state === "stopping" ||
        (state === "paused" &&
          (!parent.recoveryBlock || parent.recoveryBlock.previousStatus === "unknown"))
      )
        throw new Error("Parent session outcome is unresolved. Reconcile or settle it before branching.");
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
        recoveryBlock: undefined,
        queuedPrompt: undefined,
        client: undefined,
        controller: new AbortController(),
        view: {
          ...parent.view,
          id: childId,
          workspace,
          parentId: id,
          compaction: undefined,
          lastRecoveryJob: undefined,
          runId: undefined,
          title: `${parent.view.title ?? "Conversation"} (branch)`,
          status: "idle",
          pinned: false,
          archived: false,
          createdAt: new Date().toISOString(),
          events: [],
        },
        messageIds: undefined,
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
      if (body.snapshotDocuments) {
        // Seeding the child workspace is a durable document write, so it obeys
        // the same server permission mode as every other managed-document
        // mutation. Branching itself only creates session state and therefore
        this.assertNormalMutation("branch document snapshot");
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
      }
      for (const e of messages)
        this.event(child, e.kind, e.text, {
          importedFrom: id,
          originalSeq: e.seq,
        });
      this.persist();
      this.remember(body.idempotencyKey, requestValue, childId);
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
          consentState: "confirmed" as const,
        },
        ...this.connectors.map(publicConnector),
      ],
    };
  }
  async addConnector(input: McpConfig & { name?: string }) {
    return this.locked(async () => {
      input = connectorInput(input);
      const url = validateEndpoint(input.url, true);
      const policy = input.policy || DEFAULT_POLICY;
      if (!loadPolicy(policy).ok) throw new Error("Invalid VOID policy.");
      if (this.connectors.length >= 12)
        throw new Error("Connector limit reached. Remove an unused connector.");
      const connector: Connector = {
        ...input,
        url,
        policy,
        id: randomUUID(),
        name: input.name?.trim().slice(0, 80) || new URL(url).hostname,
        tools: [],
        consentState: "staged",
      };
      this.connectors.push(connector);
      this.persist();
      return this.connectionState();
    });
  }
  /** Stage an edit. No network request: the URL and policy are validated, the
   * connector returns to staged, and the operator probes it again explicitly. */
  async updateConnector(id: string, body: Record<string, unknown>) {
    return this.locked(async () => {
      const previous = this.connectors.find((item) => item.id === id);
      if (!previous) throw new Error("Connector not found.");
      const input = connectorInput(body, previous),
        url = validateEndpoint(input.url, true),
        policy = input.policy || DEFAULT_POLICY;
      if (!loadPolicy(policy).ok) throw new Error("Invalid VOID policy.");
      const replacement: Connector = {
        ...previous,
        ...input,
        id,
        url,
        policy,
        name: input.name?.trim() || new URL(url).hostname,
        tools: [],
        consentState: "staged",
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
  /** The one outbound request an operator can make about a connector. It is
   * only ever reached from an explicit command, never from add, edit, load or
   * session start. A failed probe leaves the staged connector exactly as it
   * was: nothing is written and no catalog is kept. */
  async probeConnector(id: string) {
    const previous = this.connectors.find((item) => item.id === id);
    if (!previous) throw new Error("Connector not found.");
    const listed = await mcpCatalog(previous);
    const updated: Connector = {
      ...previous,
      tools: listed.tools,
      consentState: "probed",
    };
    await this.locked(async () => {
      const before = this.connectors;
      this.connectors = before.map((item) =>
        item.id === id ? updated : item,
      );
      try {
        this.persist();
      } catch (error) {
        this.connectors = before;
        throw error;
      }
    });
    return publicConnector(updated);
  }
  /** Operator confirmation. Only a probed catalog can be confirmed, so the
   * tools a conversation may use are the ones the operator has seen. */
  async confirmConnector(id: string) {
    return this.locked(async () => {
      const previous = this.connectors.find((item) => item.id === id);
      if (!previous) throw new Error("Connector not found.");
      if (previous.consentState !== "probed")
        throw new Error("Probe this connector before confirming it.");
      const updated: Connector = {
        ...previous,
        consentState: "confirmed",
      };
      const before = this.connectors;
      this.connectors = before.map((item) =>
        item.id === id ? updated : item,
      );
      try {
        this.persist();
      } catch (error) {
        this.connectors = before;
        throw error;
      }
      return publicConnector(updated);
    });
  }
  /** What this connector's policy would do to each tool it lists. It is a
   * preview and not a decision: no request leaves this process, nothing is
   * written, and a tool the registry cannot classify is shown as denied,
   * which is what the conversation will do with it. Blast radius stays
   * unknown here because only a measured probe can produce one. */
  policyPreview(id: string) {
    const connector = this.connectors.find((item) => item.id === id);
    if (!connector) throw new Error("Connector not found.");
    const policy = loadPolicy(connector.policy ?? DEFAULT_POLICY);
    if (!policy.ok) throw new Error("Invalid policy.");
    const tools = connector.tools.map((tool) => {
      const name = connector.mapping?.[tool.name] ?? tool.name;
      const classification = classifyTool(name, {
        facts: connector.facts ?? {},
        args: {},
      });
      const call = {
        tool: name,
        connector: connector.name,
        workspace: undefined,
        klass:
          classification.outcome === "classified"
            ? classification.tone
            : classification.outcome === "unclassified"
              ? (classification.assumeTone ?? "r3")
              : "r3",
        blastRadius: undefined,
        unclassified: classification.outcome !== "classified",
      };
      const decision =
        classification.outcome === "classified"
          ? decide(policy, call)
          : ({
              kind: "deny",
              ruleIndex: -1,
              rationale: "No registry entry covers this tool.",
            } as const);
      return {
        tool: tool.name,
        mapped: name,
        klass: call.klass,
        classification:
          classification.outcome === "classified"
            ? classification.reason
            : classification.outcome === "unknown-tool"
              ? "No registry entry covers this tool. Denied as r3."
              : `No case matched. Assumed ${call.klass}; missing facts: ${classification.missingFacts.join(", ")}.`,
        decision: decision.kind,
        rule:
          decision.kind === "allow"
            ? decision.rationale ?? "allowed by an allow rule"
            : decision.kind === "hold"
              ? decision.rationale ?? `held for ${decision.seconds}s`
              : decision.kind === "unmatched"
                ? "no rule matched; the policy file changed under this connector"
                : decision.rationale ?? "denied by rule",
        blastRadius: "unknown",
      };
    });
    return {
      id: connector.id,
      name: connector.name,
      consentState: connector.consentState,
      tools,
      counts: {
        allow: tools.filter((tool) => tool.decision === "allow").length,
        hold: tools.filter((tool) => tool.decision === "hold").length,
        deny: tools.filter((tool) => tool.decision === "deny").length,
      },
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
    this.assertNormalMutation("recovery planning");
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
    this.assertNormalMutation("recovery apply");
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
      this.recoverySession(id); // A synchronous send may have started while the signed plan loaded.
      const previousBlock = session.recoveryBlock;
      const block = previousBlock ?? { jobId: request.jobId, previousStatus: session.view.status };
      session.recoveryBlock = block;
      session.view = { ...session.view, lastRecoveryJob: { jobId: request.jobId }, status: block.previousStatus === "unknown" ? "unknown" : "paused" };
      this.persist(); // Persist the dispatch guard before any inverse can execute.
      try {
        const result = await runtime.runRecoveryJob(session.view.workspace, request.jobId, async stored => stored.digest === input.planDigest);
        if (result.status === "unknown" || result.status === "paused") {
          session.view = { ...session.view, status: block.previousStatus === "unknown" ? "unknown" : result.status };
        } else {
          session.view = { ...session.view, status: block.previousStatus };
          delete session.recoveryBlock;
        }
        this.persist();
        return recoveryResult(result, recoveryOperationMap(this.workspace(id).operations.map(op => op.id), request.selection));
      } catch (error) {
        // These runtime preflight refusals happen before the first inverse.
        // Every other thrown result remains uncertain until its job is reconciled.
        const refused = !previousBlock && error instanceof Error && [
          "Recovery job selection boundary is stale.",
          "Recovery job selection boundary is invalid.",
          "Another recovery job is active in this workspace.",
          "Recovery job was not authorized.",
        ].includes(error.message);
        if (refused) {
          session.view = { ...session.view, status: block.previousStatus };
          delete session.recoveryBlock;
        } else {
          session.recoveryBlock = block;
          session.view = { ...session.view, status: "unknown" };
        }
        this.persist();
        throw error;
      }
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
    this.assertNormalMutation("workspace undo");
    return this.locked(async () => {
      const session = this.settledSession(id);
      const preview = await this.undoPreview(id, operationId);
      if (!preview.canApply && !this.workspace(id).operations.some(op => op.undoes === operationId))
        throw new Error(preview.reason);
      const runtime = await this.documentRuntime(session, { by: operator }), runtimeId = digest(operationId);
      let status = await runtime.status(session.view.workspace, runtimeId);
      if (status === "unknown" || status === "dispatched")
        status = (await runtime.reconcile(session.view.workspace, runtimeId)).status;
      const plan = status === "succeeded" ? await runtime.planRecovery(session.view.workspace, runtimeId) : undefined;
      const prior = this.workspace(id);
      const transition = status ? undefined : applyWorkspaceUndo(prior, { id: `undo-${operationId}`, operationId });
      if (transition?.result.isError) throw new Error(transition.result.content[0]?.text ?? "Undo refused.");
      if (transition?.state === prior) return { ok: true, workspace: prior };
      this.settledSession(id); // send() may have run while the signed preview loaded.
      const previousStatus = session.view.status;
      // Before the inverse dispatches, a crash or lost receipt must leave a
      // durable unknown. Stop and unrelated recovery cannot release this state.
      session.view = { ...session.view, status: "unknown" };
      this.persist();
      let confirmed = false;
      try {
        if (status) {
          const result = plan
            ? await runtime.recover(plan, async () => true)
            : await runtime.reconcileRecovery(session.view.workspace, runtimeId);
          confirmed = result.status !== "unknown";
          if (result.status !== "restored") throw new Error(`Managed document recovery ${result.status}.`);
        } else {
          await this.commitWorkspace(session, transition!.state, "void_workspace_undo", { operationId }, "execute:completed", transition!.operation);
          confirmed = true;
        }
        this.event(session, "tool", `Undid ${operationId}.`);
        return { ok: true, workspace: this.workspace(id) };
      } finally {
        session.view = { ...session.view, status: confirmed ? previousStatus : "unknown" };
        this.persist();
      }
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
      return await attestLedger(dir, workspace, key);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
  async ledger(workspace: string) {
    if (!Object.hasOwn(this.documents, workspace)) return undefined;
    const entries = this.evidence[workspace] ?? [],
      key = await this.verificationKey(() => this.retainedSigner());
    const result = await verifyChain(entries, { publicKey: key.publicKey });
    if (!result.ok)
      throw new Error("Workspace ledger signature verification failed.");
    return { entries, result, verification: key };
  }
  /**
   * The signer this workbench would use, opened without creating one. A read
   * path that mints a key has created signing capability as a side effect of
   * being read, so every verification thunk goes through here.
   */
  private async retainedSigner(
    dir: string = join(this.storage.directory, "keys"),
  ): Promise<KeyProvider | undefined> {
    try {
      return await retainedKeyProvider({ dir, env: this.env });
    } catch (error) {
      // No key yet is a state, not a fault: a workbench that has not signed
      // anything has nothing to authenticate, and the refusal that follows
      // says so.
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }
  /**
   * The key this workbench checks its own evidence with. A key the operator
   * supplied out of band wins, so an operator who pinned one gets key
   * substitution detected here too. Without one the recorder verifies itself
   * with the key it signs with, and says so: the recorder, the signer and this
   * check are one OS principal, so that is not independence and nothing may
   * report it as authentication against the agent. The signer thunk returns
   * undefined rather than creating a key, so a read never grants signing
   * capability.
   */
  private async verificationKey(
    signer: () => Promise<KeyProvider | undefined>,
  ): Promise<VerificationKey> {
    const resolved = await resolveVerificationKey({
      env: this.env,
      allowDegraded: true,
      signingKey: signer,
    });
    if (resolved === undefined)
      throw new Error("No verification key is available for the workspace ledger.");
    return resolved;
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
    attribution?: LedgerAttribution,
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
      // The decision's own account of why it was allowed goes last: a record
      // the caller computed for the decision it just made is the truth about
      // that decision, and metadata is a bag other bodies travel in.
      ...(attribution === undefined ? {} : { attribution }),
      // An undo that cannot name the record it inverts is not a record of an
      // inversion, so it is refused here rather than written and believed.
      ...(tool === "void_workspace_undo"
        ? { reversal: reversalFor(current, args) }
        : {}),
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
      //
      // These entries were signed by the stdio proxy, which signs with
      // `devKeyProvider()` at its default `~/.void/keys` — *not* with the
      // workbench's own document key under the data directory. Resolving
      // against the wrong directory finds nothing, and the throw below turns
      // that into an unknown tool outcome for a tool that ran perfectly well.
      // The public key still comes from the shared resolution, so an operator's
      // out-of-band pin wins and the fallback is reported as degraded.
      const key = await this.verificationKey(() =>
        this.retainedSigner(join(homedir(), ".void", "keys")),
      );
      const verified = await verifyChain(entries, { publicKey: key.publicKey });
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
  private async authorizeTool(session: Session, call: { tool: string; workspace: string; connector: string; klass: string; blastRadius: number | undefined; reason: string; arguments: JsonObject }, decision: PolicyDecision | { kind: "deny" }, policy: ValidPolicy) {
    const name = call.tool, args = call.arguments;
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
        this.sessionAttribution(session, policy, decision),
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
          this.sessionAttribution(session, policy, decision),
        ),
      );
      this.approvalHistory.push({ ...hold });
      this.holds.delete(hold.holdId);
    }
    return allowed;
  }
  /**
   * What this workbench knows about the decision it is about to record: the
   * policy it was made under, the rule that fired, the model that asked, and
   * the request that asked. Both the model and the request are omitted rather
   * than filled in, because a record made outside a model turn has no model
   * turn to name and an empty string is a name nobody chose.
   */
  private sessionAttribution(
    session: Session,
    policy: ValidPolicy,
    decision: { kind: string; ruleIndex?: number; rationale?: string },
  ): LedgerAttribution {
    return buildAttribution(policyDigest(policy.policy), decision, {
      modelId: session.view.model || undefined,
      requestDigest: session.requestDigest,
    });
  }
  private async execute(
    session: Session,
    tool: McpTool,
    args: JsonObject,
    id: string,
  ): Promise<unknown> {
    if (!this.toolAllowedInMode(tool))
      return { isError: true, content: [{ type: "text", text: `Server permission mode ${this.permissionMode} forbids ${tool.name}.` }] };
    if (session.agentProfile) {
      if (session.agentProfile.policyProfile !== "default" || !session.agentProfile.allowedTools.includes(tool.name))
        throw new Error("Agent policy refused a tool outside its allowed scope.");
      if (!tool.connectorId) {
        const policy = loadPolicy(DEFAULT_POLICY);
        if (!policy.ok) throw new Error("Invalid default operator policy.");
        const call = { tool: tool.name, workspace: session.view.workspace, connector: "workspace", klass: workspaceToolClass(tool.name) ?? "r3", blastRadius: 1, reason: "Managed document policy.", arguments: args };
        const decision = decide(policy, call);
        if (!(await this.authorizeTool(session, call, decision, policy))) return { isError: true, content: [{ type: "text", text: denialText(tool.name, call.klass, decision) }] };
      }
    }
    if (tool.connectorId === "stdio") {
      if (!session.client)
        throw new Error("This stdio connection ended. Start a new session.");
      const before = this.evidence[session.view.workspace]?.length ?? 0;
      let outcome: { result: unknown } | { error: unknown };
      try {
        outcome = { result: await session.client.request("tools/call", { name: tool.name, arguments: args }) };
      } catch (error) {
        outcome = { error };
      }
      try { await this.syncStdio(session); } catch { throw new UnknownToolOutcome(); }
      if ("result" in outcome) return outcome.result;
      // A typed denial alone can be forged by an upstream. Require fresh,
      // verified proxy evidence for this exact tool and argument digest.
      const argsDigest = await sha256Hex(JSON.stringify(args));
      const receipt = this.evidence[session.view.workspace]?.slice(before)
        .map(entry => entry.body as Record<string, unknown>)
        .filter(body => body.source === "stdio-proxy" && body.tool === tool.name && body.argsDigest === argsDigest).at(-1);
      if (outcome.error instanceof HoldDeniedError && (receipt?.decision === "hold:denied" || receipt?.decision === "hold:expired")) {
        return { isError: true, content: [{ type: "text", text: outcome.error.message }] };
      }
      throw new UnknownToolOutcome();
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
    const allowed = await this.authorizeTool(session, call, decision, policy);
    if (!allowed)
      return {
        isError: true,
        content: [
          { type: "text", text: denialText(name, call.klass, decision) },
        ],
      };
    if (session.controller.signal.aborted)
      throw new Error("Session cancelled.");
    let result: Awaited<ReturnType<typeof rpc>>;
    try {
      result = await rpc(config, "tools/call", { name: tool.name, arguments: args }, config.sessionId);
      await this.locked(() => this.commitWorkspace(session, this.workspace(session.view.id), name, args,
        result.result?.isError ? "execute:failed" : "execute:completed", undefined, undefined,
        { klass: call.klass }, this.sessionAttribution(session, policy, decision)));
    } catch {
      try {
        await this.locked(() => this.commitWorkspace(session, this.workspace(session.view.id), name, args,
          "execute:unknown", undefined, undefined, { klass: call.klass },
          this.sessionAttribution(session, policy, decision)));
      } catch {
        // An unavailable ledger cannot turn an uncertain external effect into failure.
      }
      throw new UnknownToolOutcome();
    }
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
  private checkContextBudget(session: Session, tools: readonly unknown[], outputTokens = 4096) {
    if (!session.agentProfile) return;
    // UTF-8 bytes plus protocol overhead are a conservative token bound, not
    // a fabricated tokenizer measurement. Reserve the provider's fixed output
    // ceiling too; an oversized combined context never dispatches.
    const bound = Buffer.byteLength(JSON.stringify(session.messages)) + Buffer.byteLength(JSON.stringify(tools)) + 1024 + outputTokens;
    if (bound > session.agentProfile.maxContextTokens) throw new Error("Agent context budget reached. Increase the budget or compact before continuing.");
  }
  private async run(session: Session): Promise<void> {
    const provider = session.provider;
    try {
      if (!provider) throw new Error("Reconnect the provider used by this conversation before continuing.");
      if (session.agentProfile) {
        session.agentProfile = validateAgentProfile(session.agentProfile);
        if (session.agentProfile.policyProfile !== "default") throw new Error("Unknown agent policy profile.");
      }
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
      const maxTurns = session.agentProfile?.maxTurns ?? 20;
      // The prefix of the conversation that never changes. Hashing only the
      // messages added since the last turn turns a per-turn cost of O(session)
      // into O(turn), and the digest is identical either way: the prefix was
      // already inside the previous digest's input, so folding it forward
      // changes what the value means not at all. A session that reaches the
      // 200 message limit would otherwise serialise its whole history twenty
      // times, and canonicalJson is the expensive part, not the hash.
      let hashed = 0;
      for (let turn = 0; turn < maxTurns; turn++) {
        if (session.controller.signal.aborted) return;
        this.checkContextBudget(session, tools);
        // The record a tool call produces has to name what asked for it, and
        // the conversation is the only part of that which is not derivable
        // from the record itself. One digest for the turn, not one per tool
        // call: every record the turn produces names the same request, and a
        // per-call digest would hash the same growing conversation repeatedly.
        session.requestDigest = await sha256Hex(
          canonicalJson({
            model: session.view.model,
            messages: session.messages.slice(hashed),
            tools,
            // The count is inside the input, so two sessions with the same
            // tail and different histories do not produce the same digest.
            through: session.messages.length,
          }),
        );
        hashed = session.messages.length;
        if (session.messages.length >= 200)
          throw new Error(
            "Session context limit reached. Start a new session.",
          );
        let delta = "";
        let flushed = Date.now();
        const reply = await provider.complete(
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
        this.checkContextBudget(session, tools, 0);
        if (provider === this.provider) this.providerFailureState = null;
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
          const result = await this.execute(
            session, tool!, args as JsonObject, `${session.view.runId}-${turn}-${callIndex}`,
          );
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
            content: provider
              .redact(JSON.stringify(result))
              .slice(0, 64000),
          });
        }
      }
      throw new Error(
        `Session reached the ${maxTurns}-turn limit. Review the ledger before continuing.`,
      );
    } catch (error) {
      if (!session.controller.signal.aborted || error instanceof UnknownToolOutcome) {
        if (error instanceof ProviderRequestError && provider === this.provider) this.recordProviderFailure(error);
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
